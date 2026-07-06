# Real-Time Geo-Fencing & Agentic Alert Triage

A connected-vehicle fleet pipeline that turns raw telemetry into a small number of
trustworthy, human-readable alerts. Vehicles stream telemetry; a stream processor
detects geofence breaches against live-editable zones; an AI triage layer suppresses
false alarms, keeps genuine incidents, and delivers context-rich alerts; and a
two-layer observability stack measures the health and latency of every hop.

```
 vehicles ──MQTT──▶ IoT rule ──▶ vehicle-telemetry (Kinesis) ─┐
                                                              ▼
 geo-fences (DynamoDB) ─Streams─▶ rules bridge ─▶ geofence-rules ─▶ Flink breach detector
                                                              │  (point-in-polygon vs all
                                                              ▼   active zones, per-vehicle
                                            geofence-alerts (Kinesis)   entry/exit state)
                                                              │
        analyzer bridge ─▶ Alert Analyzer (AgentCore + Memory): triage + gate ─┐
                                                              │  HIGH/CRITICAL   │ suppress
                                                              ▼                  ▼
                                            alert-queue (SQS) ──▶ publisher bridge   (dropped,
                                                              ▼                       logged)
                          Alert Publisher (AgentCore): 4-section msg, exactly-once ─▶ SNS ─▶ email

 Observability: in-band latency stamps + EMF ─▶ CloudWatch dashboard + alarm fleet
```

The system is built as four AWS CDK (TypeScript) stacks, with the stream job and the
agents in Python. See `docs/architecture-geofence-workshop.png` for the full diagram.

| Stack | Increment | What it owns |
|-------|-----------|--------------|
| `IngestionStack` | 001 | IoT topic rule → `vehicle-telemetry` Kinesis stream (per-vehicle keyed) |
| `ProcessingStack` | 002 | `geo-fences` DynamoDB (+Streams), rules bridge, Managed Flink breach detector, `geofence-alerts` |
| `AlertingStack` | 003 | Two Bedrock AgentCore runtimes (analyzer + publisher), Memory, SQS/SNS, idempotency table, bridges |
| `ObservabilityStack` | 004 | CloudWatch dashboard (per-hop rows + stacked latency) + streaming-tripwire alarms |

---

## Repository layout

```
bin/            CDK app entry (wires the four stacks)
lib/            the four stacks (*-stack.ts)
processor/geofence/   PyFlink breach detector: pure core (detector, geometry, edges,
                      latency) + thin Flink adapter (job.py)
agents/         analyzer/ and publisher/ AgentCore runtimes (pure cores + Strands app.py + Dockerfile)
lambda/         rules_bridge, analyzer_bridge, publisher_bridge (Kinesis/SQS → invoke)
eval/           H1 evaluation harness: metrics, tuned baseline, labeled fixtures
observability/  triage EMF document builder
tools/simulator/      telemetry simulator (Calgary routes)
tools/verify/         stream readers: reader.ts (telemetry), latency-probe.ts (alerts)
specs/00N-*/          spec.md, design.md, tasks.md, verify.md per increment
docs/           architecture diagrams, Well-Architected + streaming reviews
```

---

## Prerequisites

**For local testing (no AWS):**
- Node.js + repo deps: `npm install`
- Python 3.12 + `pytest` (`pip install pytest`)

**For deploy + the live end-to-end run, additionally:**
- AWS credentials for a **dev/sandbox** account and a region (`export AWS_REGION=us-east-1`)
- `npx cdk bootstrap` once per account/region
- **Docker with ARM64 build** (`docker buildx`) — the two AgentCore agent images are `linux/arm64`
- **Bedrock model access** in-region for the configured inference-profile ids
- The **Flink Kinesis connector jar** at `processor/lib/flink-sql-connector-kinesis.jar`, and the
  job's `main()` connector wiring completed (see `specs/002-processing/verify.md` — the decision
  logic is done and tested; the source/sink construction is the documented deploy step)

---

## Quick start — local, no AWS (the Tier-1 gate)

Everything below runs with no cloud and is the gate every change must pass:

```bash
npm run build                 # TypeScript typecheck (tsc --noEmit)
npm test                      # CDK construct assertions (jest) — 52 tests, 4 stacks
python -m pytest -q           # Python logic — 91 tests (detector, agents, bridges, eval, EMF)
npx cdk synth                 # synthesize all four CloudFormation templates
npm run sim -- --validate     # simulator: schema-check messages, parse zones/routes
python eval/harness.py        # H1 eval report: reference triager vs the tuned baseline
```

Expected: build clean; `52 passed` (jest); `91 passed` (pytest); synth writes four
templates; `VALIDATE: PASS`; and the eval prints a table where the reference triager
beats the baseline (`P/R 0.80 → 1.00`, delta `+0.20`).

---

## Deploy (end to end)

> **For a full, battle-tested deploy + testing + teardown walkthrough, see
> [`DEPLOYMENT.md`](DEPLOYMENT.md)** — it captures every fix and gotcha from a real
> dev-account deploy (connector-jar fetch, Bedrock model-access enablement, ordering
> races, teardown quirks) plus `docs/live-deploy-findings.md`. The summary below is the
> quick version.

Two prerequisites a fresh clone needs before the commands below: `npm run fetch:connector`
(downloads the git-ignored Flink jar) and enabling **Bedrock model access** for the account
(see DEPLOYMENT.md §2). Then deploy the stacks in dependency order — `AlertingStack` takes
context parameters:

```bash
npx cdk bootstrap                                   # once per account/region
npx cdk deploy IngestionStack ProcessingStack       # streams, table+seed, rules bridge, Flink app
aws kinesisanalyticsv2 start-application --application-name geofence-processor   # READY → RUNNING

npx cdk deploy AlertingStack \
  -c alertEmail=you@example.com \
  -c analyzerModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  -c publisherModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0
# Confirm the SNS subscription email once (AWS sends a confirmation link).

npx cdk deploy ObservabilityStack                   # dashboard + alarms
```

After deploy: the Flink app reaches `RUNNING` with both sources connected; both
AgentCore runtimes reach `READY`; Memory is `ACTIVE`; the four zones are seeded.

> **Model + region:** the default model ids are cross-region `us.` inference profiles
> (for throttling headroom). Confirm they're available in your region, or override with
> the `-c ...ModelId=` flags. Model choice is env-only — no code change (FR6).

---

## Run it end to end

```bash
# 1. Drive the fleet: 10 vehicles along Calgary routes, publishing every ~5s.
npm run sim -- --vehicles 10 --duration 180
```

Then watch each stage:

```bash
# 2. Telemetry landed on the stream (produce→stream latency, ordering):
STREAM=vehicle-telemetry npx ts-node tools/verify/reader.ts 60

# 3. Breach events with the per-hop latency breakdown:
ALERTS_STREAM=geofence-alerts npx ts-node tools/verify/latency-probe.ts 90 --emf

# 4. Delivery: a HIGH/CRITICAL breach arrives as a 4-section email; benign ones don't.
#    (Confirm the SNS email subscription first.)

# 5. Dashboard + alarms:
aws cloudwatch get-dashboard --dashboard-name geofence-pipeline \
  --query 'DashboardBody' --output text | jq '[.widgets[].properties.title]'
```

The Memorial Drive route ends inside the downtown exclusion zone and Deerfoot Trail
passes through the airport exclusion zone, so natural breaches appear without any
special flag. Full step-by-step runbooks with exact assertions live in each
increment's `verify.md`.

---

## Test cases

A catalog of what to exercise and the expected result. **Local** cases run today with
no AWS; **Deploy** cases need the stacks up (they're scripted in the `verify.md` files).

### Detection (002)

| # | Scenario | How to trigger | Expected | Where |
|---|----------|----------------|----------|-------|
| D1 | Genuine exclusion entry | vehicle crosses into downtown/airport zone | one `entry` breach, factual-only (no severity/reason) | Local: `pytest processor/geofence`; Deploy: `verify.md` Step 3 |
| D2 | Containment exit (depot) | vehicle leaves the depot yard | one `exit` breach with `distanceOutsideM > 0` | Local (mini-run) / Deploy |
| D3 | Dwell arrival + departure | vehicle enters then leaves a dwell site | both an `entry` and an `exit` breach | Local |
| D4 | Stay in allowed area | vehicle never crosses a boundary | **zero** breaches (no false trip from jitter) | Local / Deploy Step 6 |
| D5 | Live rule update < 60s | `put-item` a new zone while traffic runs | first breach reflecting it in **< 60s** (H2) | Deploy `verify.md` Step 5 |
| D6 | Bootstrap race | telemetry before the first zone loads | held, then replayed — the first crossing is **not** missed | Local: `test_detector` |
| D7 | Poison telemetry | malformed record on the stream | dropped + counted (`poisonTelemetryDropped`), shard keeps moving | Local: `test_detector` |

### Triage & delivery (003)

| # | Scenario | How to trigger | Expected | Where |
|---|----------|----------------|----------|-------|
| T1 | Suppression gate | send a LOW/MEDIUM vs a HIGH/CRITICAL breach | only HIGH/CRITICAL reaches SQS/delivery (AC3) | Local: `test_triage`; Deploy `verify.md` Step 4 |
| T2 | Four-section delivery | send a genuine critical breach | email: `[CRITICAL] …` subject + STATUS/WHY/IMPACT/ACTIONS (AC4) | Local: `test_compose`; Deploy |
| T3 | Single delivery | re-send an identical breach | **exactly one** email; the dedupe key rejects the duplicate (AC5) | Local: `test_idempotency`; Deploy Step 6 |
| T4 | Memory effect | send a second breach for the same vehicle | prior event retrieved from Memory, referenced in the decision (AC2) | Deploy Step 5 |
| T5 | H1 suppression vs baseline | run the eval over the labeled set | FP suppression + genuine retention **beat** the tuned baseline (AC1) | Local: `python eval/harness.py`; Deploy: live H1 |
| T6 | Bedrock throttle | simulate `ThrottlingException` | exponential-backoff retry, then succeed | Local: `test_retry` |
| T7 | Bridge poison record | a bad record in a batch | only that record reported failed, rest processed; DLQ catches exhausted | Local: `test_analyzer_bridge` / `test_publisher_bridge` |

### Observability (004)

| # | Scenario | How to trigger | Expected | Where |
|---|----------|----------------|----------|-------|
| O1 | Trace block | a 002 breach event | carries `trace` (eventTime, ingestTime, flinkRead, flinkEmit); 003 ignores it (AC2) | Local: `test_latency` |
| O2 | Latency breakdown | run the probe over the alerts stream | per-hop deltas + cumulative detection total printed (AC3) | Local: `jest test/latency-probe`; Deploy Step 3 |
| O3 | EMF metrics | drive traffic | `Geofence/Latency` resolves FlinkProcess/DetectionTotal/TriageBedrock/NotifyTotal (AC5) | Local: `test_emf`; Deploy Step 4 |
| O4 | Alarm trips | stop the Flink app / pause a consumer under load | iterator-age / `millisBehindLatest` alarm goes `ALARM`, recovers to OK (AC4) | Deploy `verify.md` Step 5 |
| O5 | Dashboard | after deploy | one dashboard, rows H1…H7 + the stacked detection-vs-triage widget (AC1) | Deploy Step 2 |

---

## Local test suites (what each covers)

```bash
npm test                                   # all four stacks' construct assertions + IAM least-privilege guards
python -m pytest processor/geofence -q     # geometry, edge detection, breach mini-run, bootstrap, poison, latency
python -m pytest agents -q                 # triage gate/parse/dedupe, publisher 4-section format, idempotency, backoff
python -m pytest lambda -q                 # the three bridge adapters (decode + partial-batch failures)
python -m pytest eval observability -q     # H1 metrics/baseline/label-hiding, triage EMF shape
npx jest test/latency-probe.test.ts        # latency arithmetic (per-hop + cumulative)
```

---

## Teardown

```bash
npx cdk destroy ObservabilityStack AlertingStack ProcessingStack IngestionStack
# The telemetry Kinesis stream defaults to DeletionPolicy=Retain (see the follow-up in
# STATE.md); until that lands, delete it manually if you want a clean teardown:
aws kinesis delete-stream --stream-name vehicle-telemetry --enforce-consumer-deletion
```

---

## Where to look next

- **Per-increment runbooks** (exact deploy + live assertions): `specs/00N-*/verify.md`
- **Specs, designs, task ledgers:** `specs/00N-*/{spec,design,tasks}.md`
- **Project state + deferred follow-ups:** `STATE.md`
- **Engineering-loop process** (how work is gated): `LOOP.md`, `docs/safety.md`
- **Apache Flink wiring (topology, state, diagrams):** [`docs/flink-architecture.md`](docs/flink-architecture.md)
- **Architecture reviews:** `docs/well-architected-review.md`, `docs/streaming-architecture-review.md`

> **Status note.** All four increments' local (Tier-1) scope is implemented and green.
> The live end-to-end runs (each increment's final `verify.md` step) are deploy-gated
> and pending an authorized deploy window; a few deploy-time glue pieces (Flink
> connector wiring/jar, the EMF hot-path emit call sites, the live H1 eval adapter) are
> completed at that step, as noted in the runbooks and `STATE.md`.
