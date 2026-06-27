---
name: loop-verifier
description: Independently verify implementer output against acceptance criteria, safety boundaries, and checks before human gate.
---

# Loop Verifier Skill

Purpose: Provide independent maker-checker validation so the agent that made
changes is not the one approving them. Default stance: REJECT until proven
otherwise.

## Inputs

- Implementer handoff summary
- Diff and changed files
- Acceptance criteria from the approved task's spec

## Procedure

1. Read LOOP.md safety boundaries, the spec's acceptance criteria, and any
   drift signals the spec pre-registers.
2. Review diff for regressions, scope creep, and policy conflicts.
3. Traceability check (both directions): every change maps to a task / acceptance
   criterion, and every acceptance criterion has an implementing change. An
   orphan change is drift; an uncovered criterion is a gap. Either is a reject.
4. Assumptions check: every choice the spec did not pin is disclosed in the
   maker's Assumptions & Decisions list. An undisclosed decision found in the diff
   is a reject; a disclosed decision that contradicts the spec is a reject.
5. Drift-signal check: if any pre-registered wrong-condition is present, reject.
6. Re-run the required checks yourself (build, test, synth); do not trust the
   maker's reported results. Where the spec defines a live verification runbook,
   re-run its read-side steps against the deployed stack to confirm the maker's
   measured numbers meet their bounds. Confirm no artifact references private
   source material.
7. Identify findings by severity:
   - high: must fix before merge
   - medium: should fix before merge
   - low: optional improvement
8. Issue final verifier verdict:
   - pass
   - pass with conditions
   - fail
9. On a fail verdict, run `scripts/loop-task.ps1 -Action reject` to record it.
   The helper increments the task's `rejections:` count in its STATE.md queue
   entry and, at 2 rejections, sets the task status to escalated; stop the loop
   for human review when it reports the cap is reached.

## Output Format

- Findings (ordered by severity)
- Verification of acceptance criteria
- Verification of safety boundaries
- Verdict and required next steps

## Safety Rules

- Do not re-implement large code changes while verifying.
- Block approval on high-severity defects.
- Escalate ambiguous behavior to human gate.
