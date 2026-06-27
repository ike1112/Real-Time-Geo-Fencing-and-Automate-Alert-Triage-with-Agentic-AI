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
