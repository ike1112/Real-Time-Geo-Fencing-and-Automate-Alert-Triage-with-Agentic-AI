# Verify 003 — Agentic Alert Triage & Delivery (runbook)

Concrete, runnable steps proving the AI layer suppresses false positives while
retaining genuine incidents and beats a tuned baseline (H1/AC1), the gate delivers
only high/critical (AC3), a delivered alert carries the four-part content (AC4),
memory informs a repeat event (AC2), and a genuine breach is delivered exactly once
(AC5). This is the acceptance script for the deferred deploy task.

> Local checks (Step 1) run today with no AWS. The deploy + live steps (2–6) run
> when the deploy hold is lifted, and have the prerequisites below. Runtime/memory
> names use underscores (`geofence_alert_analyzer`, `geofence_alert_publisher`,
> `geofence_vehicle_memory`) — AgentCore rejects hyphens in these names.

## Prerequisites for the live run

1. **Docker with ARM64 build support** (`docker buildx`) — the two AgentCore runtime
   images (`agents/analyzer`, `agents/publisher`) are `linux/arm64`; CDK builds them
   from the `agents/` context at deploy.
2. **Bedrock model access** in the deploy region for the configured inference-profile
   ids. Defaults are cross-region `us.` profiles (finding R5); confirm the exact ids
   and region availability, then pass them as context if they differ:
   `-c analyzerModelId=... -c publisherModelId=...`.
3. **A confirmable email** for delivery: `-c alertEmail=you@example.com`. AWS sends a
   one-time subscription confirmation; confirm it before Step 4 (AC5 is also checkable
   without the inbox via the idempotency table — see Step 6).
4. Tools: AWS CLI v2, `jq`, Docker, Node, Python (pytest). AWS creds for a dev account.

```bash
REGION=us-east-1
ALERTS=geofence-alerts
```

## Step 1 — logic + eval machinery (local, no AWS): the H1 harness on fixtures

```bash
python -m pytest agents/ eval/ lambda/ -q     # gate, formatter, idempotency, backoff, bridges, metrics
python eval/harness.py                          # the H1 report vs the tuned baseline
```
Expected: all pass. The harness prints a metrics table where the reference triager
(the offline stand-in for the deployed analyzer, see `eval/reference.py`) strictly
beats the tuned static baseline on precision and retention — proving the eval
machinery, the baseline, and label-hiding. The **live** H1 number (Step 3) replaces
the stand-in with the real agent. On the current fixture set:
```
baseline (static rule)        suppress=86%  retain=80%  P=0.80  R=0.80  F1=0.80
reference (offline stand-in)  suppress=100% retain=100% P=1.00  R=1.00  F1=1.00
delta  suppress +14%  retain +20%  P +0.20  R +0.20  F1 +0.20
```

## Deploy

```bash
npx cdk deploy AlertingStack \
  -c alertEmail=you@example.com \
  -c analyzerModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  -c publisherModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0
# Confirm the SNS subscription email before Step 4.
```
Both `AWS::BedrockAgentCore::Runtime` resources reach `READY`; `AWS::BedrockAgentCore::Memory`
is `ACTIVE`. AC6 (native IaC) is satisfied by the deploy itself — no CLI/console step.

## Step 2 — runtimes and memory are live (AC6)

```bash
ANALYZER_ARN=$(aws cloudformation describe-stacks --stack-name AlertingStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AnalyzerRuntimeArn'].OutputValue" --output text)
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-arn "$ANALYZER_ARN" --region "$REGION" \
  --query 'status'
```
Expected: `READY` (repeat for `PublisherRuntimeArn`).

## Step 3 — H1: suppression vs retention against the labeled set, vs baseline (AC1, the lead bet)

Run the eval harness with the **deployed analyzer** as the triager: a small adapter
calls `InvokeAgentRuntime` per fixture breach (label withheld) and maps the returned
decision to `{alert, severity}`. The harness scores it and prints the same table as
Step 1, now with the real model.
```bash
python eval/run_live.py --analyzer-arn "$ANALYZER_ARN" --region "$REGION"
```
Expected (measured; thresholds per OQ-1): false-positive suppression and genuine
high/critical retention reported, and both precision and recall **at or above** the
tuned baseline row. Record the numbers and the per-event cost.

> `eval/run_live.py` is the thin live adapter (built at the live run): it reuses
> `eval.harness.run` with an `InvokeAgentRuntime`-backed triager. The offline harness
> already proves the scoring; the live run only swaps the triager for the real agent.

## Step 4 — gate + four-part delivery (AC3, AC4)

Send one genuine critical breach and one benign breach to `geofence-alerts`; confirm
exactly the genuine one is delivered, with four sections.
```bash
# genuine (depot containment exit, sustained, good fix, door open) -> expect delivery
aws kinesis put-record --stream-name "$ALERTS" --partition-key veh-001 --region "$REGION" \
  --data "$(jq -nc '{vehicleId:"veh-001",zoneId:"zone-depot-foothills",zoneName:"Foothills Depot Yard",zoneKind:"containment",breachType:"exit",timestamp:1782458400000,location:{latitude:51.02,longitude:-114.0,accuracy:3},distanceOutsideM:300,durationInStateS:120,vehicle:{speed:50,ignition:true,doorOpen:true}}' | base64)"
# benign (poor-fix nick) -> expect suppression, no delivery
aws kinesis put-record --stream-name "$ALERTS" --partition-key veh-005 --region "$REGION" \
  --data "$(jq -nc '{vehicleId:"veh-005",zoneId:"zone-downtown-restricted",zoneName:"Downtown Restricted Core",zoneKind:"exclusion",breachType:"entry",timestamp:1782458400000,location:{latitude:51.045,longitude:-114.07,accuracy:25},distanceOutsideM:5,durationInStateS:5,vehicle:{speed:40,ignition:true,doorOpen:false}}' | base64)"
```
Inspect the delivered email (or the publisher trace). Expected: the `veh-001` alert
arrives with subject `[CRITICAL] Vehicle veh-001: Foothills Depot Yard exit` and a body
containing all four sections — `CURRENT STATUS`, `WHY THIS ALERT`, `IMPACT`,
`RECOMMENDED ACTIONS`. The `veh-005` breach produces **no** delivery (gate suppressed it).

## Step 5 — memory effect on a repeat (AC2)

Send a second breach for `veh-001` at the same zone; in the analyzer trace confirm the
prior event was retrieved from Memory (`RetrieveMemoryRecords`) and referenced in the
decision's `historicalPattern` (e.g. "repeat exit"). Expected: the second decision's
context shows the first event; severity holds or escalates.

## Step 6 — single delivery end to end (AC5)

Re-send the identical `veh-001` genuine breach (same `vehicleId|zoneId|breachType|timestamp`).
Expected: **still exactly one** delivered alert. The publisher's idempotency claim on the
dedupe key rejects the duplicate:
```bash
aws dynamodb scan --table-name geofence-published-alerts --region "$REGION" \
  --filter-expression "dedupeKey = :k" \
  --expression-attribute-values '{":k":{"S":"veh-001|zone-depot-foothills|exit|1782458400000"}}' \
  --query 'Count'
```
Expected: `1` (a single claim). Cross-check with SNS `NumberOfMessagesPublished = 1`
over the window, and confirm the DLQ depth alarms stayed OK.

## Teardown

```bash
npx cdk destroy AlertingStack
```

## Result block (paste in the handoff)

```
ALERTING VERIFY (deploy YYYY-MM-DD, region us-east-1)
  runtimes/memory:        analyzer READY, publisher READY, memory ACTIVE          (AC6)
  H1 suppression:         __%   retention __%   P __ R __   vs baseline P __ R __  (AC1)
  per-event cost:         $__
  gate:                   genuine delivered, benign suppressed                    (AC3)
  four-part delivery:     PASS (subject + 4 sections)                             (AC4)
  memory effect:          prior event referenced on repeat                        (AC2)
  single delivery:        1 claim for a re-sent breach                            (AC5)
```
Numbers are recorded from the real run. The verifier re-runs Step 1 today (incl. the
eval on fixtures) and Steps 2–6 once deployed, and rejects if any bound is missed or
if H1 does not beat the baseline.
