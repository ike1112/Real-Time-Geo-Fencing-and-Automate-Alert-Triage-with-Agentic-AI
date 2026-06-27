# Spec 002 — Geofence Processing

Status: DRAFT (awaiting human approval)
Increment: 2 of 3 (ingestion -> processing -> agentic alerting)
Depends on: 001 (reads the `vehicle-telemetry` stream)
Traces to: PRD H2 (live rule updates — lead bet for this increment), and produces the breach events H1 triages; PRD success metric 2 (rule latency)

---

## Outcome

A streaming processor reads vehicle telemetry, evaluates each position against a
set of geographic zones, and emits a factual breach event whenever a vehicle
violates a zone. Zone definitions live in a store that can be edited at runtime,
and edits take effect in the processor in near-real-time without a restart. This
increment makes no severity judgment and sends no alerts — it produces clean,
factual breach events for the triage layer (increment 3) to reason over.

## In scope

- A store of zone definitions (polygon boundaries + per-zone semantics) editable
  at runtime.
- Near-real-time propagation of zone edits into the running processor.
- A stream processor that tests each telemetry position against all active zones
  (point-in-polygon) and emits one factual breach event per violated zone.
- An output stream carrying breach events.

## Out of scope (this increment)

- Severity classification, false-positive suppression, alerting, delivery (increment 3).
- A management UI for zones (edits are made directly against the store / by seed).
- Assigning a "reason" or severity to a breach — the processor reports facts only.

## Actors

- **Stream processor**: consumes telemetry, holds the active zone set, detects breaches.
- **Operations / fleet manager** (PRD user): edits zone definitions and expects
  the change to take effect quickly without downtime.
- **Triage layer** (future increment 3): consumes the breach event stream. Named
  to fix the output contract.

## Zone model

A zone is a named polygon with semantics that decide what counts as a breach:

- **exclusion** (no-go): a vehicle *inside* the polygon is a breach (e.g. a
  restricted core, an airport airside).
- **containment** (keep-in): a vehicle *outside* the polygon is a breach (e.g. a
  depot/yard a vehicle should not leave after hours).
- **dwell**: arrival/departure across the boundary is reported (e.g. a job site).

Each zone has an `active` flag, a polygon (closed ring of `[lat, lon]`), and
properties (alert level hint, optional max speed, kind).

## Functional requirements

- FR1 — Each telemetry position is tested against all active zones; a breach
  against any zone emits a breach event for that (vehicle, zone) pair.
- FR2 — Breach detection is geometric point-in-polygon (containment), correct for
  concave polygons and boundary cases.
- FR3 — Zone definitions are stored durably and can be added, edited, deactivated,
  or removed at runtime.
- FR4 — A zone edit takes effect in the running processor without a restart and
  without downtime.
- FR5 — Per-vehicle telemetry is processed in order (relies on 001's per-vehicle
  stream ordering) so entry/exit transitions are detected correctly.
- FR6 — Emitted breach events are factual (which zone, breach type, where, how far
  outside, position accuracy, vehicle diagnostics passthrough) and carry no
  severity or reason judgment.

## Acceptance criteria

- AC1 — A simulated vehicle crossing into an exclusion zone (or out of a
  containment zone) produces exactly one breach event for that zone, with the
  correct `breachType`, on the output stream.
- AC2 — **Live rule update (lead, H2):** deactivating or editing a zone in the
  store changes detection behavior within **60 seconds**, measured as the time
  from the store edit to the first breach event that reflects the new rule (or the
  first suppressed event for a deactivated zone), with no processor restart.
- AC3 — Point-in-polygon correctness: a fixed set of inside/outside/boundary test
  positions against a concave test polygon classify correctly (unit-tested).
- AC4 — A vehicle staying within its allowed area produces no breach events
  (no false breaches from ordering or jitter at the configured accuracy).
- AC5 — The infrastructure synthesizes, deploys from the 001 baseline, and the
  processor reaches a running state with both inputs connected.

## Non-functional targets

- Rule-update latency: median < 60 s store-edit-to-effect (PRD metric 2).
- Detection latency: a breach is emitted within a few seconds of the breaching
  position arriving on the telemetry stream.
- Pilot scale: ~10 vehicles, a handful of zones; design must not foreclose more.
- Cost posture: idle cost contained; the processor is the one always-on component,
  so its sizing is the main cost lever (note for the cost-to-serve metric).

## Verification contract (how we know it stayed on-spec)

- Traceability both directions (every task -> FR/AC; every AC -> a task).
- Drift signals (any one is a reject): detection uses a per-message zone id instead
  of testing all active zones; a zone edit requires a restart to take effect; the
  processor emits severity/reason judgments; breach geometry is wrong on the
  concave test polygon; any artifact references external/private source material.
- Assumptions the implementer must surface: polygon winding/closed-ring handling,
  boundary-inclusive vs exclusive, dwell debounce window, distance-outside metric
  units, rule-refresh mechanism tuning.
- No self-certified done: AC2/AC1 proven by a live run with measured numbers
  (see the increment's verify.md), re-run by the verifier.

## Open questions blocking approval

- OQ-1 — Dwell semantics: report both arrival and departure, or only one? And is a
  debounce needed to avoid flapping at the boundary under jitter?
- OQ-2 — Should `maxSpeed` per zone be evaluated here (emit a speed breach) or left
  entirely to increment 3's reasoning? (Proposed: emit the facts — position + speed
  — and let increment 3 judge; the processor does geometry only.)
