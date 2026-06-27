---
name: loop-triage
description: Run a report-only repository triage loop for the geofence alert-triage project and update STATE.md with findings and next actions.
---

# Loop Triage Skill

Purpose: Execute a cautious triage loop that gathers signals, summarizes risk,
and proposes next actions without making code changes.

## Inputs

- Repository root
- Current git state
- Existing STATE.md
- Specs and task lists under specs/

## Procedure

1. Read LOOP.md and STATE.md.
2. Collect signals:
   - git status
   - changed files
   - TODO/FIXME markers
   - spec/plan progress and resume point
3. Optional checks if requested:
   - npm run build  (TypeScript typecheck)
   - npx cdk synth  (infrastructure synthesizes cleanly)
4. Produce triage report in .loop/triage/triage-YYYYMMDD-HHMMSS.md.
5. Update STATE.md Latest Run and append one line to Run History.

## Output Format

- Health Summary (green, yellow, red)
- Findings (ordered by severity)
- Recommended Next Actions (3 max)
- Human Gate Decision Required (yes/no + reason)

## Safety Rules

- Report-only by default.
- Never auto-commit, auto-push, or auto-merge.
- Never run destructive commands.
- Escalate ambiguous findings to a human.
