---
name: loop-implementer
description: Implement one scoped L2 task in an isolated worktree, then produce a concise change summary and test evidence for verifier review.
---

# Loop Implementer Skill

Purpose: Make a focused code or infrastructure change from an approved task while
minimizing scope and risk.

## Inputs

- One approved task from the Approved Tasks queue (backed by a spec under specs/)
- Target files and acceptance criteria
- Worktree path for isolated changes

## Procedure

1. Read LOOP.md and STATE.md.
2. Confirm the task is in L2 scope and human-approved.
3. Work only in the assigned worktree.
4. Implement the minimal changes needed for the acceptance criteria.
5. Run relevant checks for the changed scope:
   - npm run build  (TypeScript typecheck)
   - npm test       (unit / construct tests)
   - npx cdk synth  (infrastructure synthesizes cleanly)
6. For acceptance criteria that require live behavior, and when the task is
   approved and dev AWS credentials are available: deploy to a dev/sandbox
   account, run the spec's verification runbook, capture the measured numbers,
   then tear down (`cdk destroy`). Never deploy to production; never deploy from
   an unattended run. If no creds are available, hand this step to the human.
7. Produce handoff summary for verifier:
   - files changed
   - checks run and results (commands + actual output, not claims)
   - traceability: each change mapped to the task / acceptance criterion it
     satisfies. A change that maps to nothing is scope creep — remove it or
     justify it explicitly.
   - Assumptions & Decisions: every choice the spec did NOT pin (a default value,
     a field name, a library, an edge-case behavior). State the choice and why.
     Anything you decided silently belongs here.
   - known risks or open questions

## Output Format

- Change Summary
- Traceability (each change -> task / acceptance criterion)
- Assumptions & Decisions (every choice the spec did not pin)
- Validation Results (commands + actual output)
- Residual Risks
- Ready for verifier: yes/no

## Safety Rules

- Never reference the private source material in code, comments, or commits.
- Never auto-merge or auto-push.
- Never widen scope beyond the approved task.
- Never bypass failed checks without explicit human approval.
