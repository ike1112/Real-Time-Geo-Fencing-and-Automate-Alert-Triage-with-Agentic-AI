# Design 003 — Agentic Alert Triage & Delivery

Status: DRAFT (awaiting human approval)
Implements: spec.md (003-agentic-alerting)
Stack: `AlertingStack` (new), reads the `geofence-alerts` stream exported by `ProcessingStack`.

---

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Agent runtime | Amazon Bedrock AgentCore Runtime, **declared as native IaC** (`CfnRuntime`) | The runtimes deploy and tear down with the stack — no CLI/console step. (CDK 2.258+; see project memory on AgentCore CFN.) |
| Agent memory | Amazon Bedrock AgentCore **Memory** (`CfnMemory`), per-vehicle namespaces | Durable per-vehicle history so repeat context dampens alert fatigue (FR2). |
| Agent code | Python (Strands + bedrock-agentcore SDK), containerized via CDK `DockerImageAsset` -> ECR | The runtime artifact is a container image; CDK builds and supplies it to `CfnRuntime`. |
| Triage -> delivery buffer | Amazon SQS queue | Decouples the two agents; smooths bursts; standard event-source-mapping to the publisher bridge. |
| Stream -> agent / queue -> agent | Two small Python Lambda **bridges** with event-source-mappings (Kinesis batch 10 / 5 s; SQS batch 10 / 5 s) | AgentCore runtimes are invoked, not event-source-mapped directly; the bridges adapt Kinesis/SQS to `InvokeAgentRuntime`. |
| Delivery channel | Amazon SNS topic + email subscription | Simple, no UI; matches the PRD non-goal (no console). |
| Model selection | `BEDROCK_MODEL_ID` env var per runtime | Cost-efficient model in dev/CI, premium for demo, no code change (FR6). |
| Observability | OpenTelemetry traces from the runtimes -> CloudWatch | End-to-end trace proves single delivery (AC5) and shows memory ops. |

## Pipeline

```
geofence-alerts (Kinesis, from 002)
  -> analyzer-bridge (Lambda, Kinesis ESM batch 10 / 5s) -> InvokeAgentRuntime
  -> Alert Analyzer (AgentCore Runtime + Memory): decide act/suppress + severity,
       consult & update per-vehicle history; forward ONLY high/critical
  -> alert-queue (SQS)
  -> publisher-bridge (Lambda, SQS ESM batch 10 / 5s) -> InvokeAgentRuntime
  -> Alert Publisher (AgentCore Runtime, no memory): compose 4-part message
  -> alerts-topic (SNS) -> email
```

## Components

### 1. Analyzer bridge (Lambda, Python)
- Kinesis event-source-mapping on `geofence-alerts` (batch 10, window 5 s, latest).
- Per record: `bedrock-agentcore:InvokeAgentRuntime` with the breach event as
  payload; the analyzer runtime ARN comes from an env var set by the stack.

### 2. Alert Analyzer (AgentCore Runtime + Memory)
- Strands agent; decision logic in the system prompt, not branchy code.
- Output (structured): `{ decision: ALERT|NO_ALERT, severity: LOW|MEDIUM|HIGH|CRITICAL,
  reason, confidence, recommendedAction, vehicleId, location, historicalPattern }`.
- Rubric (tunable, OQ-1/OQ-2) reasons over the FACTUAL breach fields 002 emits
  (no reason code is supplied — the agent infers):
  - Likely false positive -> suppress: poor GPS accuracy (high `accuracy` metres)
    with small `distanceOutsideM` and short `durationInStateS`; brief boundary
    dwell at an expected (dwell) site.
  - Likely genuine -> high/critical: sustained containment exit (e.g. depot) or
    exclusion entry (e.g. airport airside), large distance outside, sustained
    duration; corroborating telemetry (implausible speed, engine temp, fuel,
    door open with ignition).
  - **Historical pattern** from Memory: repeat offenses or an escalating trend
    raise severity; a known-benign recurring pattern lowers it.
- **Suppression gate (the H1 mechanism):** only `HIGH`/`CRITICAL` are written to
  SQS; `LOW`/`MEDIUM` are logged and dropped. The gate lives in one place so the
  policy is auditable and changeable.
- Memory: on each event, retrieve prior records for `vehicleId` (fed into the
  prompt as historical context), then write the event/summary back. Namespaces
  `/violations/{vehicleId}` (semantic) and `/summaries/{vehicleId}/{sessionId}`.

### 3. AgentCore Memory (`CfnMemory`)
- Strategies: `SemanticMemoryStrategy` (ViolationPatterns, `/violations/{actorId}`)
  and `SummaryMemoryStrategy` (SessionSummary, `/summaries/{actorId}/{sessionId}`);
  `{actorId}` = `vehicleId` at runtime.
- `EventExpiryDuration`: default 90 days (OQ-3, tunable). Execution role granted
  `RetrieveMemoryRecords` / `BatchCreateMemoryRecords`.

### 4. SQS `alert-queue`
- Written by the analyzer (high/critical only); read by the publisher bridge.

### 5. Publisher bridge (Lambda, Python)
- SQS event-source-mapping; invokes the publisher runtime per message.

### 6. Alert Publisher (AgentCore Runtime, memory disabled)
- Transforms the structured alert into a strict message: severity-tagged subject
  (`[HIGH] Vehicle veh-014: ...`) and a plain-text body with four sections —
  **current vehicle status / why the alert is raised / impact / recommended
  actions** — then `SNS:Publish`. Carries a `dedupeKey` for single-delivery.

### 7. SNS + email
- Topic `geofence-alerts-topic`; an email subscription (recipient must confirm the
  subscription once — note in verify.md). Delivered message is the four-section text.

### 8. Observability
- Both runtimes export OTEL traces (`OTEL_TRACES_SAMPLER=always_on`) to CloudWatch;
  the trace tree shows invoke -> model call(s) -> memory ops -> SNS publish.

## Evaluation harness (where H1 is proven)

- Input: the labeled breach set — replay the 001 simulator scenarios through 002
  (or fixtures) so each breach has a ground-truth label (genuine vs false positive)
  from the simulator metadata, joined by `(vehicleId, time)`. The analyzer never
  sees the label.
- Run each through the analyzer; record decision + severity.
- Metrics: false-positive suppression rate, genuine-high/critical retention rate,
  precision/recall, and the delta vs a tuned static-rule baseline (OQ-2). Plus cost
  per triaged event (metric 5) from token usage.
- Output: a report (numbers per the verify.md result block).

## Model posture

- `BEDROCK_MODEL_ID` per runtime. Dev/CI default: a cost-efficient current model
  (e.g. Claude Haiku 4.5). Demo: a premium current model (e.g. Claude Opus 4.8).
  Cross-region inference profile ids and Bedrock region availability are confirmed
  at deploy (record the chosen ids as an assumption).

## Testing approach

- Unit (Python): the suppression gate (only high/critical pass); the payload
  adapters in both bridges; the publisher's four-section formatter + dedupe key.
- Construct tests (CDK assertions): `CfnRuntime` x2 and `CfnMemory` present with
  the expected roles/env; both ESMs; SQS; SNS + subscription; least-privilege IAM
  (`InvokeAgentRuntime`, memory actions, `SNS:Publish`).
- Eval harness: the H1 run on the labeled set (AC1).
- Live (verify.md): end-to-end single delivery (AC5), memory effect (AC2), gate
  (AC3), four-part message (AC4).

## Risks / follow-ups

- AgentCore container build (ARM64) via `DockerImageAsset` needs a working Docker
  build context; confirm the build path before relying on it in CI.
- Bedrock model + AgentCore regional availability must be checked at deploy.
- Email subscription confirmation is a one-time manual step; the eval/AC5 trace can
  be verified without waiting on the inbox by asserting `SNS:Publish` succeeded.
- H1 numbers depend on the labeled-set quality (001 simulator) and the baseline
  (OQ-2) — a weak baseline would flatter the AI; pick a tuned one.
