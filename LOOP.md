# Loop Engineering for the Geofence Alert-Triage Pipeline

This repository is built with a cautious, human-gated engineering loop. Product
intent lives in `PRD.md`; the loop turns that intent into reviewed specs, then
into verified increments of AWS CDK (TypeScript) infrastructure and code.

## Levels

- Level L1 (watch loop): Discover and summarize work on a schedule. No auto-editing.
- Level L2 (work loop): Implement human-approved tasks end to end, in-session, with maker-checker verification.
- Level L3 (unattended): Not enabled.

## Lifecycle (PRD to merge)

The loop runs front to back, with a human gate between every stage and the next:

1. **Architect** (`skills/loop-architect`): read `PRD.md` and produce
   `specs/<NNN>-<name>/{spec.md, design.md, tasks.md}` for one build increment.
   Spec-only; writes no code; reveals nothing about private source context.
2. **Human review**: you read, edit, and approve the spec. Approval means adding
   a task to the Approved Tasks queue in `STATE.md`. Nothing reaches the queue
   without you.
3. **Maker** (`skills/loop-implementer`): implement the top approved task in an
   isolated worktree until its acceptance criteria and checks pass.
4. **Checker** (`skills/loop-verifier` / `.codex/agents/verifier.toml`): grade
   the result independently. Default stance REJECT. A rejection is recorded with
   `scripts/loop-task.ps1 -Action reject`.
5. **Human merge**: you verify the finished branch and merge it. The loop never
   auto-merges.

## Maker-Checker Authority

- The maker may propose a change, but never decides that work is complete.
- The checker is the authority on "done" for any L2 task.
- Any failed or inconclusive verifier result escalates to the human gate.

## Work Loop (L2, in-session)

The work loop runs on demand inside a coding-agent session ("run the work loop").
There is no standalone runner: this is a procedure the agent follows.

1. Read the Approved Tasks queue in STATE.md. Take the top queued task. If the
   queue is empty, stop and say so (run the architect first, then approve a spec).
2. Create an isolated worktree for the task.
3. Maker implements until the task's acceptance criteria and relevant checks
   pass. New ideas found along the way go to the queue as proposals, not into
   the current change.
4. Checker grades the result. A rejection goes back to the maker as its next
   instruction and is recorded with `scripts/loop-task.ps1 -Action reject`, which
   increments the task's `rejections:` count and marks the task escalated at 2.
5. Exit conditions, fixed before the run starts:
   - Checker passes: update STATE.md, hand the human the branch and a summary.
     Never auto-merge.
   - Checker rejects twice: stop, mark the task escalated, ask the human.
6. The human holds three gates: approving a spec into the queue, and verifying
   the finished branch before merge.

## Safety Boundary

The loop MUST NOT:

- Commit or push application or infrastructure code automatically.
- Run destructive commands.
- Change cloud infrastructure or security settings unattended.
- Reveal or reference the private source context in any durable artifact.

Allowed automation scope:

- Commit and push loop artifacts only: STATE.md, .loop/triage/*,
  .loop/attempt-ledger.json, and .loop/run-log.jsonl.
- The attempt ledger and run log must be committed so recurrence counting
  survives across scheduled runs.

See `docs/safety.md` for the full safety policy.

## Human Gate

A human must approve before any code edits beyond documentation updates. A task
may only enter the Approved Tasks queue with explicit human approval, and only a
human merges the resulting branch.

## Exit Conditions

- L1 exit: write the triage report, update STATE.md, and stop.
- L2 exit: stop only when the verifier passes, relevant checks pass, and scope remains minimal.
- L2 hard cap: at most 2 maker-checker cycles for one task before escalation.
- Recurring triage cap: escalate any unchanged high-priority item after 3 consecutive runs.

## Cadence

- Scheduled automation: `.github/workflows/loop-triage.yml`
- Suggested cadence: 1 run per day on weekdays.
- Optional extra run after major merges.

## Commands

Run from the repository root:

- npm run loop:triage:dry
- npm run loop:triage
- npm run loop:triage:checks
- npm run loop:worktree:new -- -Name my-task-name
- npm run loop:worktree:list
- npm run loop:worktree:remove -- -Name my-task-name
- GitHub Actions manual run: Actions -> Loop Triage -> Run workflow

## Artifacts

- Product intent: PRD.md
- Specs: specs/<NNN>-<name>/{spec.md, design.md, tasks.md}
- Triage reports: .loop/triage/
- Durable state: STATE.md
- Architect skill: skills/loop-architect/SKILL.md
- Triage skill: skills/loop-triage/SKILL.md
- Maker skill: skills/loop-implementer/SKILL.md
- Checker skill: skills/loop-verifier/SKILL.md

## Worktree Isolation

- Any L2 change task should run in .worktrees/<task-name>.
- Use scripts/loop-worktree.ps1 helpers to create/list/remove worktrees.
- Keep each worktree branch scoped to one approved task.
