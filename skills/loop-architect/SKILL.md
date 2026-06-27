---
name: loop-architect
description: Turn the product PRD into reviewable engineering specs (spec + design + tasks) for one build increment, then stop for human approval before any code is written.
---

# Loop Architect Skill

Purpose: The front stage of the loop. It converts product intent (PRD.md) into
engineering specs a human can review and approve, without writing any
application or infrastructure code. It is the bridge from "what and why" to
"how", and it always stops at a human gate.

This stage exists because the work loop (implementer + verifier) only acts on a
human-approved, scoped task. The architect produces the spec that a human reads,
edits, and approves into the Approved Tasks queue. Nothing it writes is
self-approving.

## Inputs

- `PRD.md` — the product intent (problem, hypotheses, MVP slice, non-goals,
  success metrics, open questions). This is the source of truth for *what* and
  *why*.
- `STATE.md` — the loop's durable memory, including which increments already
  have approved or completed specs.
- Existing specs under `specs/` — to avoid duplicating or contradicting an
  increment that is already specced.
- Private background context in `docs/` (diagrams and reference material). Treat
  this as confidential prior art only. See "Origin confidentiality" below.

## Origin confidentiality (hard rule)

The reference material in `docs/` is private context. It must NEVER be named,
cited, quoted, or alluded to in any generated artifact. No spec, design, task,
code comment, or commit message may reference a workshop, lab, tutorial, course,
PDF, or "the diagram". Every artifact must read as the team's own product
engineering, justified from the PRD's outcomes alone. If a design decision can
only be explained by pointing at the source material, re-derive it from the PRD
requirement it serves, or raise it as an open question instead.

## Engineering posture (defaults the design honors unless the PRD says otherwise)

These are spec-level decisions already settled for this project. Record and
justify them in `design.md` against the PRD outcomes; do not re-litigate them
without a reason:

- AWS CDK in TypeScript, built increment by increment from an initially empty
  stack. No starting infrastructure is assumed.
- Real-time stream processing for position events, with point-in-polygon
  boundary evaluation. Boundary polygons are distributed to the processor as
  broadcast state, not keyed state.
- Live boundary-rule updates propagate to the processor in near-real time via a
  change-capture path (rule store change stream -> small bridge function ->
  rules stream), so a rule edit takes effect without a restart. This serves PRD
  hypothesis H2.
- Agentic triage is delivered with Bedrock AgentCore Runtime + Memory, declared
  as native infrastructure-as-code (not CLI-only, not a hand-rolled custom
  resource). Only genuinely high/critical events pass through to delivery.
- Cost-aware model posture: cheaper models for routine development and CI; a
  premium model reserved for demonstration. This serves the PRD's cost-to-serve
  metric.

If any of these conflicts with a PRD outcome, stop and raise it — do not silently
override the PRD.

## Build increments

The product is built and proven one vertical increment at a time. The default
ordering (each one a separate spec folder):

1. `001-ingestion` — asset telemetry enters the system and lands on a stream,
   reliably and partitioned per asset.
2. `002-processing` — boundary detection over the stream, with live boundary
   rules, emitting crossing events.
3. `003-agentic-alerting` — triage of crossing events, suppression of false
   positives, and delivery of context-rich alerts for genuine high/critical
   events.

Pick the lowest-numbered increment that does not yet have an approved spec,
unless the human names a different one.

## Procedure

1. Read `PRD.md`, `STATE.md`, and any existing `specs/`.
2. Confirm which increment to spec (default: the next un-specced one).
3. Create `specs/<NNN>-<name>/` and write three files:
   - `spec.md` — solution-neutral requirements and acceptance criteria for this
     increment, traceable to the PRD hypotheses and metrics. No vendor or
     library choices here beyond what the increment's outcome requires.
   - `design.md` — the engineering decisions: CDK stacks/constructs, AWS
     services, data flow, the posture decisions above as they apply, and the
     latency/throughput/retention targets this increment must meet. This is
     where "how" lives.
   - `tasks.md` — an ordered checklist of small, individually verifiable tasks
     the implementer will execute, each with its own acceptance check. Use
     `- [ ]` items so the triage loop can read progress.
4. Write a one-screen summary for the human: what this increment delivers, the
   key design choices and their justification, and any open questions that block
   approval.
5. STOP. Do not write to `lib/`, `bin/`, or `lambda/`. Do not add anything to the
   Approved Tasks queue in STATE.md — only the human does that.

## Output Format

- Increment summary (what + why, one screen)
- Files written (paths)
- Key design decisions with PRD justification
- Open questions blocking approval (if any)
- Explicit line: "Human review required before this enters the Approved Tasks
  queue."

## Safety Rules

- Spec-only. Never write application or infrastructure code.
- Never auto-approve, never auto-queue, never commit.
- Never reveal or reference the private source material (see Origin
  confidentiality).
- If the PRD is ambiguous on something the spec needs, raise it as an open
  question instead of guessing.
