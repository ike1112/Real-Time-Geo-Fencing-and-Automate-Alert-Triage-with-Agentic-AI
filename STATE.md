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

- [ ] Implement increment 001 — telemetry ingestion
  spec: specs/001-ingestion
  approved: 2026-06-26
  status: in-progress (T1 checker-approved after 1 reject — forbidden-label comments fixed; T2 next)
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
