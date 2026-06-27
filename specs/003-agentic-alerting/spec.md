# Spec 003 — Agentic Alert Triage & Delivery

Status: DRAFT (awaiting human approval)
Increment: 3 of 3 (ingestion -> processing -> agentic alerting)
Depends on: 002 (reads the `geofence-alerts` breach stream)
Traces to: PRD H1 (false-positive suppression — the lead bet), H3 (context-rich actionable alerts); success metrics 1, 3, 4, 5

---

## Outcome

Each factual breach event is triaged by an AI layer that judges whether it is
worth a human's attention and how severe it is, consulting per-vehicle history so
repeat context informs the call. Only genuinely high-severity events pass through;
the rest are suppressed. Surviving events are delivered as context-rich,
human-readable alerts (what happened, why it matters, what to do) to a responder.
This is where the PRD's core bet — cutting false alarms without dropping real
incidents — is proven.

## In scope

- A triage agent that classifies each breach: act vs suppress, and severity.
- Per-vehicle memory so history (repeat offenses, prior context) informs triage.
- A suppression gate: only high/critical events continue to delivery.
- A delivery agent that turns a surviving event into a human-readable, actionable
  message and sends it to a responder channel.
- An evaluation harness that scores suppression/retention against a labeled set
  and a tuned static-rule baseline (the H1 measurement).

## Out of scope

- A responder UI/console; the channel is a simple notification (email).
- Multi-tenant accounts, auth, on-call routing/escalation policies.
- Retraining or fine-tuning models.

## Actors

- **On-call responder** (PRD user): receives only the alerts that matter, each
  one trustworthy and actionable.
- **Triage agent**: judges severity + suppresses noise, with memory.
- **Delivery agent**: composes and sends the human-readable alert.

## Functional requirements

- FR1 — Every breach event is triaged to a decision (act / suppress) and a
  severity (low / medium / high / critical).
- FR2 — Triage consults per-vehicle history and writes the event back to history,
  so repeated/related events are judged in context.
- FR3 — Only high/critical events continue past the suppression gate; lower
  severities are recorded but not delivered.
- FR4 — A surviving event is delivered as a human-readable message stating what
  happened, why it matters, and the recommended action — no raw coordinates only.
- FR5 — A genuine high-severity event results in exactly one delivered alert (no
  duplicates, no drops) end to end.
- FR6 — Model choice is configurable (a cost-efficient model for development/CI; a
  premium model for demonstration) without code changes.

## Acceptance criteria

- AC1 — **Suppression vs retention (lead, H1):** over the labeled breach set
  produced by the 001 simulator scenarios (genuine breaches vs jitter/benign false
  positives), the triage layer suppresses a clear majority of false positives while
  retaining nearly all genuine high/critical events — and beats a tuned static-rule
  baseline on precision/recall. Measured by the eval harness, numbers reported.
- AC2 — Memory effect: a second, related breach for the same vehicle is triaged
  with the prior event visible in its context (demonstrated in a trace/log).
- AC3 — Gate: a medium/low decision does not produce a delivered alert; a
  high/critical one does.
- AC4 — Delivery (H3): a delivered alert contains the four-part human-readable
  content (status / why / impact / actions) and a severity-tagged subject.
- AC5 — End-to-end single delivery (metric 4): one genuine high-severity breach
  yields exactly one delivered alert, shown by an end-to-end trace.
- AC6 — Infra synthesizes and deploys from the 002 baseline as native IaC (the
  agent runtimes and memory are declared in the stack, not created by hand), and
  tears down cleanly.

## Non-functional targets

- Triage latency: a per-event decision within a few seconds (tunable; ties to PRD
  open question on triage latency/budget).
- Cost to serve (metric 5): per-event triage cost tracked; cost-efficient model in
  dev/CI; premium reserved for demo. The eval harness reports cost per triaged event.
- Delivery reliability (metric 4): no duplicate or dropped alerts for genuine events.

## Verification contract (how we know it stayed on-spec)

- Traceability both directions (task -> FR/AC; AC -> task).
- Drift signals (any one a reject): low/medium events get delivered; the agent
  runtimes or memory are created out-of-band (CLI/console) instead of in the stack;
  triage ignores history; delivered alerts are raw coordinates without the
  four-part content; model id is hard-coded; any artifact references private source
  material.
- Assumptions to surface: severity rubric and thresholds, suppression policy
  (which severities pass), memory retention window + namespaces, baseline
  definition for H1, model ids per environment, email subject/format specifics.
- No self-certified done: AC1 (H1) is a measured eval result vs a baseline; AC5 a
  traced end-to-end run — both re-run by the verifier (see verify.md).

## Open questions blocking approval

- OQ-1 — H1 thresholds (PRD Open Question 2): what suppression/retention numbers
  count as "right"? Until set, the eval reports raw precision/recall and the
  baseline delta without a pass/fail line.
- OQ-2 — Static-rule baseline definition: e.g. "alert on every breach" vs "alert
  unless gps_accuracy beyond a tuned threshold." (Proposed: a tuned accuracy/dwell
  heuristic, so the AI has a real bar to beat, not a strawman.)
- OQ-3 — Memory retention window (event expiry) and whether the summary strategy is
  needed for the pilot or semantic-only suffices.
