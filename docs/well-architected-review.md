# AWS Well-Architected Review — Geofence Alert-Triage Pipeline

Date: 2026-06-26
Scope: specs/designs/tasks for increments 001 (ingestion), 002 (processing), 003 (agentic alerting)
Region assumed: us-east-1
Method: reviewed against the six AWS Well-Architected pillars; pricing fetched live from the AWS Price List API (aws-pricing MCP); best practices and capability facts from AWS documentation (aws-knowledge MCP). Pillar definitions: https://docs.aws.amazon.com/wellarchitected/latest/migration-lens/well-architected-framework-pillars.html

---

## 1. Executive summary

The architecture has strong instincts: on-demand/serverless throughout, per-vehicle partition-key ordering, native IaC for AgentCore, least-privilege stream-scoped IAM, a maker-checker verification loop, and a suppression gate that keeps the expensive AI layer off low-value events. Two areas need work before build:

- **Cost reality vs the spec claim.** The specs say "idle cost near zero." The real always-on floor is **~$253/month** with zero traffic — Managed Flink (~$166) plus three on-demand Kinesis streams (~$88). At pilot volume the variable cost is dominated by **Bedrock** (≈$270/mo Haiku-only, ≈$1,350/mo Opus-everything). This must be corrected in the PRD/spec cost language and drives the cost-to-serve metric.
- **Reliability is under-specified.** The Lambda bridges, Flink job, SQS/SNS, and the end-to-end "exactly one delivery" claim need explicit error handling: partial-batch responses, DLQs/on-failure destinations, Flink checkpointing/snapshots, and idempotency. These are the largest gaps.

### Pillar scorecard (0–10, reviewer judgment)

| Pillar | Score | One-line |
|---|---|---|
| Operational Excellence | 7 | Strong loop + IaC + agent OTEL; runtime monitoring/alarms across 001/002 thin |
| Security | 6 | Least-privilege emphasis good; missing NetworkConfiguration, encryption posture, prod device-auth note |
| Reliability | 5 | Ordering correct; error handling, DLQs, checkpointing, idempotency under-specified — top gap |
| Performance Efficiency | 7 | On-demand scales for pilot; address Bedrock throttling/latency + model latency |
| Cost Optimization | 5 | Suppression gate + on-demand good; "idle ~zero" inaccurate; ~$253 floor; Bedrock dominant |
| Sustainability | 6 | Serverless default good; always-on Flink is the main idle waste |

---

## 2. Cost analysis (pilot scale, real unit prices)

Pilot workload: 10 vehicles × 1 msg/5s ≈ 5.2M telemetry msgs/mo; ~50,000 breach events/mo; analyzer ~50k calls, publisher ~10k calls/mo.

| Service | Basis | Unit price (us-east-1, fetched) | Est. $/mo |
|---|---|---|---|
| AWS IoT Core | msgs + rules + actions + conn | $1.00/M msgs; $0.15/M rules; $0.15/M actions | ~$6.80 |
| Kinesis Data Streams (on-demand) | stream-hrs + ingest + retrieval | $0.04/stream-hr; $0.08/GB in; $0.04/GB out | ~$88.25 |
| Managed Service for Apache Flink | KPU-hrs + storage | $0.11/KPU-hr; $0.10/GB-mo | ~$165.60 |
| DynamoDB (on-demand) | WRU/RRU/storage/streams | $0.625/M WRU; $0.125/M RRU; streams $0.20/M | ~$0.15 |
| Lambda | requests + GB-s | $0.20/M req; $0.0000166667/GB-s | ~$0.31 |
| SQS | requests | $0.40/M | ~$0.06 |
| SNS | requests + email | $0.50/M; email $2.00/100k | ~$0.20 |
| AgentCore Runtime | vCPU-hr + GB-hr (wall-clock) | $0.0895/vCPU-hr; $0.00945/GB-hr | ~$9.00 |
| ECR | storage | $0.10/GB-mo | ~$0.20 |
| **Infra subtotal (non-Bedrock)** | | | **~$270/mo** |
| Bedrock inference | input/output tokens | Haiku 4.5 $1/$5 per MTok; Opus 4.8 $5/$25 per MTok* | $270 (Haiku) / $1,350 (Opus) |
| **Grand total** | | | **~$540 (Haiku) / ~$1,620 (Opus)** |

\* Bedrock Haiku 4.5 / Opus 4.8 token prices are **published list prices, not from the pricing API** — the Price List API exposes no entry for these current models (only legacy Claude 2/3). Confirm against the live Bedrock pricing page before quoting externally. All other unit prices are live from the Price List API.

**Always-on floor (zero traffic): ~$253/month** — Kinesis 3 streams (~$88) + Flink min 2 effective KPU (~$166, see below) + state storage (~$5). DynamoDB on-demand and AgentCore Runtime have no idle charge.

**Top cost drivers:** (1) Bedrock inference, (2) Flink always-on, (3) Kinesis stream-hours.

### Cost findings

- **C1 [High] — "idle cost near zero" is inaccurate.** `001/002` specs and the PRD imply near-zero idle. The real floor is ~$253/mo. *Fix:* correct the cost language; state the floor explicitly under the cost-to-serve metric (PRD Open Question 4 / metric 5).
- **C2 [High] — Bedrock is the dominant lever; Opus-everything is 5×.** *Fix:* blended posture — Haiku 4.5 for the high-volume analyzer, reserve Opus only for the ~10k high/critical publisher subset (≈$465/mo Bedrock vs $1,350). Already partly enabled by `FR6` (model via env var); make the blend the documented default.
- **C3 [Med] — Flink hidden orchestration KPU.** Managed Flink bills an extra orchestration KPU per app, so a 1-KPU app bills **2 KPU**. *Fix:* note this in `002` cost; right-size parallelism; for a 2 msg/s pilot, evaluate whether geofencing can run as a Lambda/KCL consumer instead of an always-on Flink app (removes the single largest fixed cost). See R-findings on the reliability tradeoff of that swap.
- **C4 [Med] — three on-demand streams cost ~$88 just to exist.** *Fix:* consider collapsing `geofence-rules` (a few records/day) — e.g. propagate rules via DynamoDB Streams→Lambda directly into the processor's control path without a dedicated stream, or fold into one stream. Avoid extended/long-term retention unless needed.
- **C5 [Low] — AgentCore Runtime bills wall-clock including Bedrock wait.** Long Opus latencies inflate it. Minor at pilot (~$9); watch if session counts grow. Avoid unnecessary short-term-memory events ($0.00025 each).
- **C6 [Low] — token volume per call.** Tighten the analyzer to a structured/enum verdict (not prose), prompt-cache the shared system prompt, and consider batching breaches per call to amortize fixed input overhead.

---

## 3. Operational Excellence — score 7

**Strengths**
- Maker-checker loop, traceability, verification tiers, and an executable verify.md per increment (strong "operate/evolve").
- Native IaC for the whole stack including AgentCore — reproducible deploy and clean teardown.
- `003` mandates OTEL traces → CloudWatch (AgentCore Observability is OTEL-compatible: traces, sessions, latency, token usage, error rate — https://aws.amazon.com/bedrock/agentcore/faqs/).

**Findings**
- **O1 [Med] — runtime observability is thin for 001/002.** Only `003` states telemetry. *Fix:* add a monitoring task to each increment — CloudWatch dashboards + alarms on: Kinesis `MillisBehindLatest`/iterator age, Flink `BackPressuredTimeMsPerSecond` / `LastCheckpointDuration` / `MillisBehindLatest`, Lambda errors/iterator age, DLQ depth, Bedrock throttle/error rate. (Flink metrics: https://docs.aws.amazon.com/managed-flink/latest/java/how-scaling-auto.html)
- **O2 [Low] — IoT rule has no error action.** Already captured as a deferred follow-up in `001`; AWS recommends a `republish` error action to an error topic + CloudWatch Logs (https://docs.aws.amazon.com/iot/latest/developerguide/rule-error-handling.html). Keep it scheduled, not dropped.

---

## 4. Security — score 6

**Strengths**
- Least-privilege, stream-scoped IAM is explicitly required (IoT rule role → only `PutRecord` on the one stream); no resource wildcards (a drift signal).
- Bedrock does not share inputs/outputs with providers and does not train base models on them; encrypted in transit/at rest; CMK + PrivateLink supported (https://aws.amazon.com/documentation-overview/bedrock/).
- AgentCore separates the runtime execution role from the memory execution role (`MemoryExecutionRoleArn`) — supports splitting invoke vs memory permissions.

**Findings**
- **S1 [Med] — AgentCore `CfnRuntime` requires `NetworkConfiguration`** (a required property), not mentioned in `003` design. *Fix:* specify the network mode in the design + a construct-test assertion. Runtime name must match `[a-zA-Z][a-zA-Z0-9_]{0,47}` and protocol is `HTTP` (https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html).
- **S2 [Med] — production device auth.** The simulator publishing via `iot-data:Publish` with IAM is fine for dev/pilot, but AWS guidance is X.509 certificates + TLS for real vehicles ("only use IAM-user credentials during research and development" — https://docs.aws.amazon.com/whitepapers/latest/designing-next-generation-vehicle-communication-aws-iot/connected-vehicle-security.html). *Fix:* add a one-line non-goal/assumption in `001` that real-device cert auth is out of pilot scope.
- **S3 [Low] — encryption posture not stated.** Streams, DynamoDB, SQS, and AgentCore Memory default to AWS-managed keys; Memory supports a customer-managed `EncryptionKeyArn`. *Fix:* state the encryption-at-rest posture (AWS-managed for pilot; CMK if data sensitivity warrants) as an explicit assumption.
- **S4 [Low] — least-privilege for `InvokeAgentRuntime` + memory actions** is asserted but the exact action set isn't pinned (AWS docs don't publish a canonical policy beyond role separation). *Fix:* enumerate the intended actions in `003` design so the verifier can check scoping.

---

## 5. Reliability — score 5 (top gap area)

**Strengths**
- Per-vehicle partition-key ordering is correct and load-bearing; Kinesis records are ordered per partition key (https://aws.amazon.com/kinesis/data-streams/pricing/).
- DynamoDB Streams is exactly-once, ordered per item, deduplicated — a sound basis for the `002` rule-propagation seam (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/streamsmain.html).
- On-demand Kinesis auto-scales to 2× the trailing 30-day peak — ample headroom for pilot (https://aws.amazon.com/blogs/aws/amazon-kinesis-data-streams-on-demand-stream-data-at-scale-without-managing-capacity/).

**Findings**
- **R1 [High] — Lambda bridges lack error-handling spec.** With Kinesis/SQS event-source mappings, a single poison record retries the whole batch until expiry by default. *Fix (002 + 003):* require `ReportBatchItemFailures` (partial batch response), bisect-on-error, max-retry, max-record-age, and an **on-failure destination** (SQS/SNS); process **idempotently**. (https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html , https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html)
- **R2 [High] — Flink reliability config unspecified.** `002` doesn't state checkpointing or snapshots. Managed Flink uses checkpointing for fault recovery and snapshots for exactly-once across updates/scaling (https://docs.aws.amazon.com/managed-flink/latest/java/how-fault.html). *Fix:* specify checkpoint interval, snapshot-on-update, and the broadcast-state bootstrap (the design already flags the bootstrap race — make it a tested acceptance criterion).
- **R3 [Med] — no DLQs on SQS/SNS.** `003` needs a DLQ on `alert-queue` (redrive policy with `maxReceiveCount`) and a DLQ on the SNS **subscription** (DLQ attaches at subscription level, same queue type) — plus an alarm on DLQ depth (https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html , https://aws.amazon.com/sqs/faqs/).
- **R4 [Med] — "exactly one delivery" (AC5/metric 4) needs explicit idempotency.** Partial-batch reporting "lowers the chance of processing more than once; it does not guarantee it." The `dedupeKey` is the right mechanism — make it authoritative (idempotent publish keyed on it), and consider SNS/SQS FIFO if strict de-dup is required (https://docs.aws.amazon.com/sns/latest/dg/fifo-message-durability.html).
- **R5 [Med] — Bedrock throttling not handled.** On-demand inference is governed by per-model RPM/TPM quotas and can throttle at volume/peak. *Fix:* require retry-with-backoff on `ThrottlingException` and use a cross-region inference profile (the `us.` model ids) for up to 2× throughput at +double-digit-ms latency (https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).
- **R6 [Low] — DynamoDB Streams consumer limit.** Max 2 Lambda consumers per stream and Lambda polls 4×/s; our single rules-bridge consumer is within limits and the latency supports the <60s H2 target (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html).

> Cost↔Reliability tradeoff: swapping always-on Flink for a Lambda/KCL geofence consumer (cost lever C3) trades Flink's managed checkpointed exactly-once state for hand-rolled state/idempotency. For the pilot's 2 msg/s and simple per-vehicle edge state this is viable and cheaper, but it must carry its own R1/R4 handling. Decide explicitly; don't drift into it.

---

## 6. Performance Efficiency — score 7

**Strengths**
- On-demand Kinesis (starts 4 MB/s, scales to 200 MB/s) and on-demand DynamoDB right-size automatically — pilot volume is comfortably within limits.
- PyFlink is supported on Managed Service for Apache Flink (https://aws.amazon.com/managed-service-apache-flink/faqs/); broadcast state is standard Apache Flink (no MSF-specific guidance found, so validate empirically).
- Suppression gate keeps the expensive model off low-value events — a performance *and* cost win.

**Findings**
- **P1 [Med] — model + agent latency budget.** AgentCore bills wall-clock and triage latency ties to PRD's open latency question. *Fix:* set a per-event latency target in `003`, prefer Haiku for the hot path, and use cross-region inference profiles to absorb bursts.
- **P2 [Low] — Flink parallelism/KPU sizing.** 1 KPU = 1 vCPU/4 GB/50 GB state; default max 32 KPU; tune `ParallelismPerKPU`. For pilot, 1 app KPU is plenty; document the sizing so it isn't over-provisioned (https://aws.amazon.com/managed-service-apache-flink/faqs/).
- **P3 [Low] — EFO not needed at pilot.** Shared `GetRecords` is fine for one consumer per stream; revisit enhanced fan-out only if multiple low-latency consumers appear.

---

## 7. Cost Optimization — score 5

Covered quantitatively in §2. Key actions: correct the idle-cost claim (C1), adopt the blended Bedrock posture (C2), right-size/avoid always-on Flink for pilot (C3), consolidate streams (C4), tighten tokens (C6). Strengths: on-demand everywhere, suppression gate, model-via-env. The architecture is cost-*aware* but the specs currently understate the fixed floor.

---

## 8. Sustainability — score 6

**Strengths**
- Managed/serverless + on-demand is the AWS-recommended sustainability default — shared, right-sized, minimal idle (https://aws.amazon.com/solutions/guidance/optimizing-data-architecture-for-sustainability-on-aws/).

**Findings**
- **SU1 [Med] — always-on Flink is the main idle waste.** Same root as C3. For pilot, a Lambda-based consumer (event-driven, scales to zero) is more sustainable; consider Graviton (arm64) Lambda for further efficiency.
- **SU2 [Low] — align retention/HA to need.** Keep Kinesis at 24h retention for pilot; don't enable extended retention or multi-Region DR unless required.

---

## 9. Prioritized recommendations

1. **[High] Correct the idle-cost claim** in PRD/`001`/`002` and record the ~$253/mo floor under the cost-to-serve metric. (C1)
2. **[High] Specify Lambda-bridge error handling** (partial batch, DLQ/on-failure destination, max-retry, idempotency) in `002` + `003`. (R1, R4)
3. **[High] Specify Flink reliability** (checkpointing, snapshots, bootstrap test) in `002`. (R2)
4. **[High] Adopt the blended Bedrock posture** (Haiku analyzer / Opus high-critical only) as the documented default; tighten analyzer output + prompt-cache. (C2, C6)
5. **[Med] Add `NetworkConfiguration` + encryption posture + IAM action scoping** to `003` AgentCore design. (S1, S3, S4)
6. **[Med] Add DLQs + alarms** (SQS redrive, SNS-subscription DLQ, DLQ-depth alarm). (R3)
7. **[Med] Handle Bedrock throttling** (retry/backoff + cross-region inference profile). (R5)
8. **[Med] Add a monitoring/alarms task** per increment (Kinesis lag, Flink backpressure/checkpoint, Lambda errors, Bedrock errors). (O1)
9. **[Med] Evaluate Lambda-vs-Flink for pilot** geofencing — decide explicitly given the cost/reliability tradeoff. (C3, SU1)
10. **[Low] Consolidate the `geofence-rules` stream**; add the IoT rule error action; note prod device-cert auth as out of pilot scope. (C4, O2, S2)

---

## 10. Implied spec/design/task changes

- `PRD.md` / `001` / `002`: replace "idle cost near zero" with the measured floor; cost-to-serve metric references the floor + per-event Bedrock cost.
- `002/design.md` + `tasks.md`: Flink checkpoint/snapshot config + test; rules-bridge and (003) bridges error-handling + DLQ + idempotency; optional Lambda-consumer alternative as an OQ.
- `003/design.md` + `tasks.md`: `NetworkConfiguration`; encryption posture; IAM action list; SQS/SNS DLQs; Bedrock retry/backoff + inference profile; blended model posture as default; monitoring task.
- Each increment: a monitoring/alarms task and the relevant CloudWatch alarms.

---

## 11. Method & sources

- Pricing: AWS Price List API via aws-pricing MCP (us-east-1; publication dates Aug 2025–Jun 2026). Bedrock current-model token prices are published list prices (not in the Price List API — flagged in §2).
- Best practices/capabilities: AWS documentation via aws-knowledge MCP; URLs cited inline. AgentCore `Runtime`/`Memory` native CFN confirmed available in us-east-1.
- Not confirmed in docs (validate during build): MSF broadcast-state guidance; SNS email delivery-rate limits; canonical least-privilege IAM for AgentCore actions; exact Bedrock retry/backoff algorithm.
