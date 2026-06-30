# Tasks 003 — Agentic Alert Triage & Delivery

Status: DRAFT (awaiting human approval)
Implements: spec.md + design.md (003-agentic-alerting)

Each task is small and individually verifiable. Maker top-to-bottom; verifier
grades each Check before the next.

- [ ] T1 — Add `AlertingStack` skeleton: SQS `alert-queue`, SNS
  `geofence-alerts-topic` + an email subscription (address as a context param),
  exports. Check: synth shows the queue, topic, and subscription.

- [ ] T2 — AgentCore Memory via `CfnMemory`: semantic + summary strategies,
  per-vehicle namespaces, `EventExpiryDuration` (param, default 90d), execution
  role with memory actions. Check: synth shows `AWS::BedrockAgentCore::Memory` with
  both strategies and the scoped role.

- [ ] T3 — Alert Analyzer agent (Python/Strands): system-prompt rubric (act/suppress
  + severity), Memory retrieve+write, structured output, and the suppression gate
  (only HIGH/CRITICAL -> SQS). Containerize. Check: unit tests — gate passes only
  high/critical; structured-output schema validates; `BEDROCK_MODEL_ID` honored.

- [ ] T4 — Declare the Analyzer `CfnRuntime`: `DockerImageAsset` -> ECR, role
  (`InvokeModel`, memory actions, `SQS:SendMessage`), env (`BEDROCK_MODEL_ID`,
  memory id, queue url, `OTEL_TRACES_SAMPLER`). Check: synth shows
  `AWS::BedrockAgentCore::Runtime` with the image + role + env.

- [ ] T5 — Analyzer bridge (Python Lambda): Kinesis ESM on `geofence-alerts`
  (batch 10 / 5s) -> `InvokeAgentRuntime`. Check: synth shows the ESM; unit test
  adapts a breach record to the invoke payload.

- [ ] T6 — Alert Publisher agent (Python/Strands, memory disabled): four-section
  formatter (status/why/impact/actions) + severity-tagged subject + dedupe key ->
  `SNS:Publish`. Containerize + `CfnRuntime` + role (`InvokeModel`, `SNS:Publish`).
  Check: unit test asserts the four sections, subject format, dedupe key; synth
  shows the second runtime.

- [ ] T7 — Publisher bridge (Python Lambda): SQS ESM on `alert-queue` ->
  `InvokeAgentRuntime`. Check: synth shows the ESM; unit test adapts an SQS message
  to the invoke payload.

- [ ] T8 — Eval harness (the H1 proof): replay the labeled breach set (001
  scenarios via 002 or fixtures, label joined by vehicleId+time, hidden from the
  agent) through the analyzer; report false-positive suppression, genuine
  high/critical retention, precision/recall, delta vs a tuned static-rule baseline
  (OQ-2), and cost per triaged event. Check: harness runs and prints the metrics
  table; baseline implemented.

- [ ] T9 — Construct tests (CDK assertions): both `CfnRuntime`, `CfnMemory`, both
  ESMs, SQS, SNS+subscription, least-privilege IAM. Check: `npm test` green.

- [ ] T10 — Author `specs/003-agentic-alerting/verify.md` (live runbook): the H1
  eval run (AC1); a high/critical event delivered with four-part content (AC4); a
  medium/low event NOT delivered (AC3); the memory effect on a repeat event (AC2);
  end-to-end single delivery via trace (AC5). Exact commands + expected numbers.
  Check: runbook runnable.

- [ ] T11 — Run verify.md end to end against a dev deploy (maker agent if creds +
  Docker present; else human). Check: filled result block in the handoff — H1
  suppression/retention + baseline delta (AC1), gate (AC3), four-part delivery
  (AC4), memory effect (AC2), single delivery (AC5) — all met or numbers reported
  against OQ-1 thresholds.

- [ ] T12 — Record deferred follow-ups (on-call routing, dedup hardening,
  threshold tuning from OQ-1) as STATE.md queue proposals. Check: captured.

## Resilience hardening (streaming data characteristics)

Posture (right-sizing is explicit — see the tags): **[correctness]** items are wrong
to omit at any scale; **[breadth]** items exceed the pilot's operational need and are
kept deliberately to demonstrate production streaming patterns (portfolio-grade scope).
The end-to-end pipeline is at-least-once, so delivery correctness lives here at the
consumer. Each cites the finding + a reference.

- [ ] T13 **[correctness]** — Idempotent publish (extends T6/T7). The `dedupeKey`
  (`vehicleId|zoneId|breachType|eventTime`) must be **authoritative**: the publisher
  records it in a DynamoDB persistence layer (conditional write / Powertools
  idempotency) so a redelivered breach does not send a second email. Handles finding
  **R4** and is the mechanism behind the single-delivery claim (AC5). Why: partial-batch
  + at-least-once streams lower but do not eliminate reprocessing.
  Ref: https://docs.aws.amazon.com/powertools/python/latest/utilities/idempotency/ .
  Check: unit test sends the same `dedupeKey` twice and asserts one `SNS:Publish`.

- [ ] T14 **[breadth]** — DLQs + alarms (extends T1). `alert-queue` redrive policy with a
  `maxReceiveCount` → an SQS DLQ; a **DLQ on the SNS subscription**; a CloudWatch alarm
  on each DLQ's depth. Handles finding **R3**. Why: a poison alert or failed delivery
  must land somewhere observable, not vanish or loop.
  Ref: https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html .
  Check: construct test asserts the SQS redrive policy + DLQ, the SNS-subscription DLQ,
  and the depth alarms.

- [ ] T15 **[breadth]** — Bridge error handling (extends T5/T7). `ReportBatchItemFailures` on the
  Kinesis (analyzer) and SQS (publisher) ESMs, max-retry / max-record-age, and an
  on-failure destination. Handles finding **R1** at the triage bridges. Why: same
  poison-record-blocks-the-batch failure mode as the rules bridge.
  Ref: https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html .
  Check: construct test asserts `FunctionResponseTypes=[ReportBatchItemFailures]` + the
  on-failure destination on both ESMs.

- [ ] T16 **[correctness]** — Bedrock throttling resilience (extends T3/T6). Retry-with-exponential-backoff
  on `ThrottlingException` for `InvokeModel`, and use a **cross-region inference profile**
  (`us.` model ids) for headroom. Handles finding **R5**. Why: on-demand inference is
  governed by per-model RPM/TPM quotas and throttles at peak.
  Ref: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html .
  Check: unit test asserts backoff-retry on a simulated throttle; the runtime env uses
  an inference-profile id (recorded as a deploy-time assumption).

## Traceability (task -> what it satisfies)

- T1 queue/topic -> FR3/FR4, AC6 ; T2 memory -> FR2, AC2 ;
  T3 analyzer+gate -> FR1, FR3, AC1, AC3 ; T4 analyzer runtime -> FR6, AC6 ;
  T5 analyzer bridge -> FR1 ; T6 publisher -> FR4, AC4 ; T7 publisher bridge -> FR4 ;
  T8 eval harness -> FR1, AC1 (H1) ; T9 construct tests -> AC6 ;
  T10 runbook -> AC1..AC5 (made concrete) ; T11 live run -> AC1,AC2,AC3,AC4,AC5 ;
  T12 -> scope discipline.
- T13 idempotent publish -> review R4 + AC5 (single delivery) ; T14 DLQs+alarms ->
  review R3 ; T15 bridge error handling -> review R1 ; T16 Bedrock backoff ->
  review R5 (resilience hardening; see docs/well-architected-review.md and
  docs/streaming-architecture-review.md §A3).
- Every AC maps to >= 1 task; every task to >= 1 FR/AC.

## Verification tiers (how "done" is proven)

- **Tier 1 — local, free** (maker runs; verifier RE-RUNS): `npm run build`,
  `npm test` (CDK assertions), `pytest` (gate, bridges, formatter), the eval
  harness on fixtures, `npx cdk synth`. Proves logic + template, not live agents.
- **GATE — deploy (in-session, human-authorized):** maker agent `cdk deploy` to a
  dev account (AgentCore runtimes + memory + Lambdas + SQS/SNS; needs Docker for the
  image build, Bedrock model access, and confirmed region), runs verify.md,
  `cdk destroy` after. Production/unattended deploys barred.
- **Tier 2 — live, measured, agent-run:** the **H1 numbers** (AC1, the lead bet),
  gate (AC3), four-part delivery (AC4), memory effect (AC2), single delivery (AC5).

The verifier RE-RUNS Tier 1 (incl. the eval on fixtures) and the Tier-2 read-side
checks; done requires the measured numbers in the handoff.

## Definition of done (increment)

- Tier 1 green (build + CDK tests + pytest + eval-on-fixtures + synth), re-run by verifier.
- Dev deploy succeeds; both runtimes reach READY; AC6 confirmed (clean deploy + destroy).
- Tier 2 numbers reported: H1 suppression/retention + baseline delta (AC1), AC2–AC5 met.
- No durable artifact references external/private source material.
- Branch handed to the human for verification and merge; nothing auto-merged.
