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

- [x] Implement increment 002 — geofence processing
  spec: specs/002-processing
  approved: 2026-06-30
  status: DONE (Tier-1, no deploy per standing directive). All buildable tasks complete;
    T13 broadcast-state bootstrap hold-and-replay + T14 poison-telemetry drop/count added
    (10d05c8), each with pure-core tests + Flink-adapter mirrors. Only T9 (live run)
    remains, deferred — needs deploy AND the job's main() connector wiring + jar, per
    verify.md. Tier-1 green.
  rejections: 1 (T5: a task label in a comment; fixed + re-approved)

- [x] Implement increment 003 — agentic alert triage & delivery
  spec: specs/003-agentic-alerting
  approved: 2026-07-02 (user directive "finish all parts")
  status: DONE buildable scope (Tier-1, no deploy). AlertingStack + two AgentCore
    runtimes (native IaC), per-vehicle memory, suppression gate, idempotent single
    delivery, two bridges, eval harness with tuned baseline (8587aa4). Pure decision
    cores unit-tested; Strands/AgentCore app.py + Dockerfiles synth/deploy-only.
    Remaining: T11 live run (deferred — ARM64 Docker build + Bedrock access + email),
    T12 follow-ups (recorded below). Tier-1 green.
  rejections: 0

- [x] Implement increment 004 — pipeline observability & latency accumulation
  spec: specs/004-observability
  approved: 2026-07-02 (user directive "finish all parts")
  status: DONE buildable scope (Tier-1, no deploy). IoT ingestTime stamp, additive
    breach `trace` block + Flink latency gauges, offline latency probe, triage EMF
    docs, ObservabilityStack (CfnDashboard + alarm fleet) (dc3cafb). Remaining: T8 live
    run (deferred), T9 follow-ups (recorded below). Tier-1 green.
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
- Deferred follow-ups recorded from the completed increments (002 T10, 003 T12, 004 T9):
  - 002: dwell debounce at the boundary under GPS jitter (OQ-1); bounded bootstrap-hold
    replay is in place, revisit the cap if a real deploy shows a longer bootstrap window.
  - 003: on-call routing / escalation policy; dedup hardening beyond the dedupeKey claim;
    H1 threshold tuning once OQ-1 fixes the pass/fail numbers; the analyzer/publisher
    app.py + Dockerfiles are synth/deploy-only (exercised at the live run).
  - 004: shard-level enhanced metrics + per-shard utilization at scale (SC1, on-demand
    defers it); ADOT/X-Ray causal spans if trace trees are later needed; wire the EMF
    hot-path emit at the runtime/bridge deploy points; supply Kinesis stream-arrival to
    the Flink StreamWait metric (source metadata) at the live run.
- All four increments' buildable (Tier-1) scope is complete and committed. The only
  open work is the deploy-gated live runs (002 T9, 003 T11, 004 T8), barred by the
  standing no-deploy directive.
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

- Run ID: finish-all-parts
- Date: 2026-07-02
- Summary: completed the buildable scope of all remaining increments — 002 T13/T14,
  the full 003 agentic-alerting increment, and the full 004 observability increment.
  Tier-1 green across the app: build, jest 52, pytest 91, cdk synth (4 stacks).
- Health: green (Tier-1); live/deploy verification deferred by the no-deploy directive.
- Escalations: none
- Next Action: human verification + merge of the three increment commits; then the
  deploy-gated live runs (002 T9, 003 T11, 004 T8) when a deploy window is authorized.

## Run History

- Initialize with the first triage report.

---
Run log: none yet
