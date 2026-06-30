# Loop State

Durable memory for loop runs in this repository.

Last run: none yet

## Operating Mode

- Mode: L1 watch loop (scheduled) + L2 work loop (in-session, on demand)
- Front stage: architect turns PRD.md into specs for human approval (skills/loop-architect)
- L2 entry gate: one human-approved scoped task in an isolated worktree
- L2 exit gate: verifier pass plus relevant checks pass (build + test + synth)
- Attempt cap: 2 maker-checker cycles per approved task, then escalate
- Recurrence cap: escalate any unchanged high-priority item after 3 consecutive runs

## Approved Tasks (Work Queue)

The work loop takes the top queued task. Only a human adds tasks here, by
approving a spec produced by the architect stage.

<!-- Format:
- [ ] short title
  spec: path to spec folder (e.g. specs/001-ingestion), or one-line acceptance criteria
  approved: YYYY-MM-DD
  status: queued | in-progress (worktree name) | awaiting-human-verify (branch name) | escalated
  rejections: 0 (verifier rejections so far; 2 = stop and escalate)
-->

- [x] Implement increment 001 — telemetry ingestion
  spec: specs/001-ingestion
  approved: 2026-06-26
  status: done — T1-T8 complete, each checker-approved; AC1/AC3/AC5 verified (T6 live: 90 records, max 0.97s, 0 out-of-order); AC2 soak + AC4 removalPolicy deferred (see Watch List)
  rejections: 1

- [ ] Implement increment 002 — geofence processing
  spec: specs/002-processing
  approved: 2026-06-30
  status: in-progress (Tier-1 only, no deploy per standing directive) — T1 done (stateful
    resources); T3 done (rules bridge: DDB-Streams->Lambda->geofence-rules, merged 773d263);
    T11 done (partial-batch + bisect + DLQ on the bridge, merged b22c634); T4 done (point-in-
    polygon + edge detection lib in processor/geofence, merged 6e48235), each independently
    checker-APPROVED. Python suite runs from root (importlib pytest.ini + conftest). Remaining:
    T2 seed, T5 PyFlink job (consumes processor/geofence), T6 Flink CDK, T7 construct tests,
    T8 verify.md, T9 live (deferred — needs deploy), T10 follow-ups, T12-T14 hardening.
    T2 not yet built (independent of T3/T4).
  rejections: 0

## High Priority

<!-- Format:
- [ ] ID - one-line description
  Loop action: what the loop did last
  acting_on: none | worktree/task identifier
  Human decision: pending | approved | deferred
-->

## Watch List

<!-- Items to monitor but not act on yet -->

Deferred follow-ups (proposals, not yet approved into the queue):
- Rule-change records (rules bridge) omit the zone `name`, so the processor's breach
  events fall back to `zoneName = zoneId`. Either propagate `name` on the rule-change
  record, or have the triage layer look it up. Surfaced building the Flink job.
- IoT topic rule has no error/dead-letter action — a malformed message is dropped
  silently. Add a republish error action before increment 3.
- Kinesis stream defaults to DeletionPolicy=Retain, so `cdk destroy` leaves it
  (orphaned cost; clean teardown / AC4 not fully met). Set removalPolicy=DESTROY
  for dev so teardown is clean.
- AC2 (5-minute soak: exactly-once / no-drop) was not run during 001 live
  verification — run it before calling 001 fully closed.
- AWS Well-Architected review (docs/well-architected-review.md) recorded further
  hardening for 002/003 (Lambda DLQs, Flink checkpointing, blended model posture,
  Bedrock retry/backoff) — apply each when its increment builds.
- Streaming review (docs/streaming-architecture-review.md) findings are now turned
  into tasks (research-backed, with references):
  - Resilience hardening folded into the owning increment: 002/tasks.md T11–T14
    (rules-bridge partial-batch+DLQ+idempotency R1; Flink checkpoint/snapshot R2;
    broadcast bootstrap-as-tested-AC R2; poison-telemetry handling R1) and
    003/tasks.md T13–T16 (idempotent publish keyed on dedupeKey R4; SQS+SNS DLQs R3;
    bridge ReportBatchItemFailures R1; Bedrock backoff + inference profile R5).
  - Monitoring system specced as its own increment: specs/004-observability/
    {spec,design,tasks}.md — two-layer (component health + in-band-timestamp latency
    accumulation), EMF, CfnDashboard + alarms; on-demand-appropriate metric set
    (shard-level/utilization deferred to scale-time per SC1). Closes general-review O1.
  - Still documentation-only (not yet tasked): SC1 per-vehicle one-shard bound note in
    001/design.md; SC3 broadcast ceiling; single-region/no-DR explicit non-goal;
    L4 split detection-vs-triage SLOs in 003/spec.md.
- None of 002 T11–14, 003 T13–16, or 004 built/deployed yet — all DRAFT awaiting the
  same loop gate; each is Tier-1 verifiable before any deploy.
- Over-engineering audit (2026-06-30): user asked to right-size the new tasks; chose
  **portfolio-grade** scope for the production observability/resilience layer (full
  CloudWatch dashboard + alarm fleet + DLQs kept deliberately as a competence showcase,
  exceeding the ~2-msg/s operational need — labeled as intentional in 004/spec.md
  "Scope posture" and via [correctness]/[breadth] tags on 002 T11–14 and 003 T13–16).
  One genuine cut applied regardless of lens: removed idempotency from 002 T11
  (rule-changes are state-replace + DynamoDB Streams is exactly-once per item, so
  dedupe is dead weight; contrast 003 T13 where it is load-bearing). Operational-minimum
  (probe-only, defer dashboard/alarms) remains a documented one-line fallback.

## Recent Noise

<!-- Brief list - helps tune triage skill -->

## Latest Run

- Run ID: none yet
- Date: none yet
- Summary: no run recorded yet
- Health: unknown
- Escalations: none yet
- Next Action: implement specs/001-ingestion T1 (vehicle-telemetry on-demand stream)

## Run History

- Initialize with the first triage report.

---
Run log: none yet
