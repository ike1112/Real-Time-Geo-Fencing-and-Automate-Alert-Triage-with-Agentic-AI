# PRD: Geofence alert fatigue — operators miss real incidents under a flood of false alarms

Date: 2026-06-25
Status: DRAFT

---

## Problem

Organizations that track vehicles or high-value assets against geographic
boundaries depend on geofence alerts to know when something crosses where it
shouldn't. But "crossed a boundary" is a noisy signal. GPS drift, brief authorized
detours, sensor jitter, and routine operational movement trip the same alarm as
genuine theft, unauthorized entry, or route deviation.

The result is alert fatigue. Operators receive so many low-value alerts that they
do one of two damaging things: loosen or mute the alerts (and miss real incidents),
or spend hours triaging noise by hand. Either way the high-value signal — the small
number of alerts that actually need action — is buried in false positives.

Evidence: alert fatigue is a well-documented failure mode in monitoring and security
operations, and naive boundary checks are known to generate false positives from GPS
inaccuracy and short legitimate excursions. This pain is asserted here from domain
knowledge and **must be validated with real operators before heavy build** (see Open
Questions).

## Why Now

Two capabilities matured at once. Real-time stream processing makes evaluating every
position event cheap at fleet scale. And reasoning AI agents can now weigh a single
alert against historical patterns and surrounding context to judge its severity, at a
low cost per decision. Triage that used to require a human analyst can run inline, in
seconds, on every event.

## Users

- **On-call responder** (security / operations). Receives alerts and must act fast.
  Needs to trust that an alert is real and to know what to do about it. Today: drowns
  in false positives and starts ignoring the channel.
- **Operations / fleet manager**. Owns the monitored assets and the boundary rules.
  Needs to adjust zones quickly as operations change and trust that coverage holds.
  Today: tunes rules manually and conservatively, lagging real-world changes.

## Differentiation — what they do today, and why this beats it

- **Static threshold / radius geofences with raw alert floods.** Responders self-filter
  and miss real incidents. This beats it by removing the noise before it reaches them.
- **Manually tuned rules and dead-bands.** Brittle, lag real-world change, still noisy.
  This beats it by reasoning per-alert instead of relying on one global rule.
- **A human triage desk.** Accurate but expensive and slow, and it doesn't scale. This
  beats it by triaging at machine cost and speed while keeping a human in the loop only
  for the alerts that matter.

The switch is worth it when the system measurably cuts false alarms without dropping
genuine high-severity events — buying back responder trust the current tools have lost.

## Hypotheses

**H1 — AI triage cuts false alarms without losing real ones (Value, lead bet).**
> We believe triaging each geofence alert with an AI layer that consults historical
> pattern memory will cause responders to receive far fewer false-positive alerts
> while still catching genuine high-severity events, resulting in restored trust and
> faster action on the alerts that matter.
> We'll know we're right if, on a labeled alert set, the system suppresses a clear
> majority of false positives while retaining nearly all genuine HIGH/CRITICAL events,
> measured by an eval harness against a tuned static-rule baseline.
> We'll know we're wrong if its precision/recall is no better than the static-rule
> baseline — then the AI layer adds cost and latency without value.

**H2 — Boundary rules update live (Feasibility / Usability).**
> We believe boundary rules can be edited and take effect in near-real-time without
> downtime, so managers can adjust zones on the fly.
> We'll know we're right if a rule edit changes detection behavior within ~60 seconds,
> with no restart or downtime.
> We'll know we're wrong if a rule change requires downtime or takes longer than ~2
> minutes — then "live rule management" is not actually delivered.

**H3 — Context-rich alerts drive action (Value / Trust).**
> We believe delivering only high/critical events as human-readable, context-rich
> messages (what happened, why it matters, what to do) instead of raw coordinates will
> increase the rate at which responders act on an alert directly.
> We'll know we're right if, in a responder test, the majority of delivered alerts are
> acted on without needing to investigate elsewhere first.
> We'll know we're wrong if responders still have to look up context in another system
> before acting — then the message format isn't earning its place.

## MVP Slice — the thinnest end-to-end that tests the bets

Not the whole system behind a flag. The thinnest vertical:

- Simulated asset telemetry → one active boundary → detect a crossing → AI triage that
  suppresses obvious false positives and classifies severity → deliver one
  human-readable alert for a genuine high-severity event.
- A small hand-labeled alert set to score suppression (tests H1).
- One live rule-edit, timed (tests H2).
- A responder readout on the delivered alert to gauge actionability (tests H3).

Holds → write the full spec and build out. Doesn't → throw away a slice, not the
project: drop or rescope whichever bet failed.

## Non-Goals

- A management UI or console.
- Multi-tenant SaaS, billing, or accounts.
- Mobile apps.
- Production authn/authz and org-level access control.
- Scale beyond pilot volume (a handful of simulated assets).
- Integrations with specific telematics or hardware vendors.

## Success Metrics (outcome-shaped)

Lead metrics are 1 and 2 — the triage quality and the live-rule behavior are the
heart of the value.

1. **False-positive suppression (lead):** a clear majority of false positives
   suppressed while nearly all genuine HIGH/CRITICAL events are retained, on the
   labeled set, vs a tuned static-rule baseline. Instrument: eval harness.
2. **Real-time rule latency (lead):** median time from a rule edit to changed
   detection behavior under ~60 seconds. Instrument: timestamp diff in logs.
3. **Alert actionability:** the majority of delivered alerts can be acted on without
   an external lookup. Instrument: responder readout on the labeled set.
4. **Delivery reliability:** a genuine high-severity event reliably produces exactly
   one delivered alert (no duplicates, no drops). Instrument: end-to-end trace.
5. **Cost to serve:** the per-alert triage cost and baseline infrastructure cost stay
   low enough that the value of suppressed false alarms clearly outweighs them.
   Instrument: cloud cost reporting, tracked as cost per triaged alert.

(Numeric thresholds in 1 depend on Open Question 2, the eval definition.)

## Risks (Cagan's four)

- **Value:** operators may prefer to keep tuning their own rules, or may distrust an
  AI severity judgment more than a transparent threshold. Mitigation: H1 measures
  against a real baseline; the human stays in the loop for high/critical.
- **Usability:** if delivered alerts aren't trustworthy and clear, they get ignored
  exactly like the old flood. Mitigation: H3 tests actionability directly.
- **Feasibility:** low-latency inline AI triage plus near-real-time rule propagation
  on a streaming pipeline. Mitigation: the MVP slice proves both before build-out.
- **Viability:** per-alert model cost and always-on streaming infrastructure must be
  justified by the value of fewer false alarms. Mitigation: cost envelope metric +
  idle-stop automation; cheaper models acceptable where quality holds.

## PRD vs Spec Boundary — decisions this PRD deliberately does NOT make

These belong to the companion spec:

- The stream-processing engine and how boundary-rule changes propagate into it.
- The AI agent framework, the model(s), and the historical-pattern memory store.
- The store for boundary rules.
- The alert-delivery channel.
- The cloud platform, the services used, and the infrastructure-as-code approach.
- Latency, throughput, and retention targets derived from architecture.
- Project structure.

The PRD states outcomes (near-real-time rule updates, false-positive suppression,
human-readable actionable alerts, reliable single delivery, contained cost); the spec
chooses the mechanisms.

## Open Questions

1. **[GATES SPEC] Demand validation.** Confirm the pain with real operators (fleet,
   security, or asset-tracking): is false-positive alert fatigue genuinely their top
   problem, and would they trust AI-judged severity? Until validated, H1's value is an
   assumption, not a fact.
2. **[GATES SPEC] Eval definition.** Size of the labeled alert set and the
   suppression / retention thresholds that count as "right" for H1.
3. **Pilot context.** Which user/segment to pilot with, and in what environment.
4. **Cost-to-serve target.** What per-alert triage cost and baseline infrastructure
   cost are acceptable relative to the value of fewer false alarms? Drives the model
   and infrastructure choices in the spec.
5. **Triage latency + model budget.** The acceptable per-alert decision latency and
   the cost/quality target that picks the model in the spec.
