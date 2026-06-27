# Spec 001 — Telemetry Ingestion

Status: DRAFT (awaiting human approval)
Increment: 1 of 3 (ingestion -> processing -> agentic alerting)
Traces to: PRD hypotheses H1/H2 (the data substrate they depend on), PRD success metric 4 (reliable single delivery)

---

## Outcome

Position telemetry from a fleet of monitored vehicles enters the system
continuously and lands on a durable, ordered event stream, partitioned per
vehicle, ready for boundary evaluation downstream. This increment carries no
boundary logic and makes no alerting decisions; it is the substrate every later
increment reads from.

This spec states *what* the increment must deliver; the companion `design.md`
chooses the mechanisms.

## In scope

- A simulator that produces realistic vehicle telemetry for development and
  testing, since the pilot has no live hardware (PRD non-goal: no vendor
  hardware integration).
- An ingress that accepts telemetry from many vehicles concurrently.
- Routing of each message onto a single durable stream, ordered per vehicle.

## Out of scope (this increment)

- Boundary/geofence rules and crossing detection (increment 2).
- Any triage, severity judgment, suppression, or alert delivery (increment 3).
- The downstream alerts stream that the processor writes (created in increment 2,
  where it is first written).
- Real telematics-vendor integration, device provisioning at fleet scale,
  authentication of third-party producers.

## Actors

- **Monitored vehicle** (simulated): emits position telemetry at a steady
  cadence while driving scripted routes.
- **Downstream processor** (future increment 2): consumes the per-vehicle-ordered
  stream. Named here only to fix the contract this increment must satisfy.

## The event contract

Downstream increments depend on a minimal **required** subset of each message;
the rest is realistic payload that rides along for later context (e.g. the AI
triage in increment 3 reasons over speed, heading, and GPS accuracy).

- **Required fields** (ingestion routes and orders on these):
  - `vehicleId` — stable per-vehicle identifier; also the stream partition key.
  - `timestamp` — epoch milliseconds, producer event time.
  - `location.latitude`, `location.longitude` — WGS84 position (the ground truth
    for crossing detection).
- **Carried context + full realistic payload** (passed through opaquely by ingestion):
  - `geoFenceId` — the vehicle's assigned/expected zone. Increment 2 decides
    whether detection looks up this declared zone or tests the position against
    all managed zones; the realistic, multi-zone direction is the latter.
  - the full connected-vehicle signal set: motion (`altitude`, `heading`,
    `speed`, `accuracy`), VSS signals, telemetry, device, and route detail.
    `accuracy` in particular is what later increments use to reason about
    GPS-jitter false positives (PRD H1).

## Functional requirements

- FR1 — A vehicle can emit a telemetry message carrying the required contract
  fields above, plus the full realistic connected-vehicle signal set (VSS
  signals, telemetry, device, route detail).
- FR2 — Messages from many vehicles are accepted concurrently; the producer does
  not need to know about downstream consumers.
- FR3 — Every accepted message is placed on one durable stream.
- FR4 — Stream ordering is preserved *per vehicle*: two messages from the same
  vehicle are delivered to a consumer in produce order. (Increment 2's stateful,
  per-vehicle crossing detection depends on this.)
- FR5 — The simulator can drive N vehicles along scripted routes over a real
  metropolitan road network (Calgary, Alberta for the pilot) against multiple
  defined zones of mixed type (containment, exclusion, dwell), with a controllable
  overlay that makes a configurable fraction of vehicles breach a zone and injects
  bounded GPS jitter, so the stream contains a reproducible, labelled mix of
  genuine breaches and borderline false-positive cases.
- FR6 — Message cadence is configurable per vehicle and may vary by vehicle state
  (faster while moving, slower while idle), mirroring real telematics. It is a
  tunable, not a fixed value.

## Acceptance criteria

- AC1 — Starting the simulator for one vehicle results in that vehicle's messages
  appearing on the stream, observable by a stream consumer, within 5 seconds of
  production.
- AC2 — With the simulator driving the pilot fleet (~10 vehicles), every produced
  message appears on the stream exactly once; no drops, no duplicates, over a
  sustained 5-minute run. (Foundation for PRD metric 4.)
- AC3 — A consumer reading the stream observes each vehicle's messages in produce
  order, under concurrent multi-vehicle load.
- AC4 — The infrastructure synthesizes and deploys from an empty account with no
  manual console steps, and tears down cleanly.
- AC5 — Construct/unit tests assert the stream's ordering mechanism and the
  routing rule are configured as specified, and they pass in CI.

## Non-functional targets

- Pilot scale: ~10 vehicles at a default ~5 s cadence (~2 messages/s aggregate;
  more under faster cadence). No need to design for fleet scale this increment,
  but the chosen stream must not foreclose it.
- Ingestion latency (production to on-stream): < 5 seconds at pilot volume.
- Cost posture: pay-per-use ingress and on-demand stream over provisioned
  capacity. This increment's idle cost is low, but the full pipeline carries a
  fixed always-on floor once the processor (002) is added (see
  docs/well-architected-review.md). Serves the PRD cost-to-serve metric.

## Verification contract (how we know it stayed on-spec)

- **Traceability (both directions):** every task in `tasks.md` satisfies a stated
  FR/AC, and every AC has at least one implementing task. A change that maps to no
  task is drift; an AC with no task is a gap. The verifier checks both.
- **Drift signals (wrong-conditions — any one is a reject):**
  - partition key is anything other than `${vehicleId}`;
  - the ingress topic is not `iot_data`, or a Lambda sits between IoT and Kinesis;
  - the stream is not on-demand, or is renamed away from `vehicle-telemetry`;
  - resources appear in synth that are not in `design.md`;
  - any artifact references external/private source material.
- **Assumptions the implementer must surface:** wherever this spec is silent —
  field names beyond the required contract, default cadence value, jitter
  magnitude, zone polygon coordinates, stream retention, log levels — the
  implementer records the choice in an Assumptions & Decisions list in its
  handoff. An undisclosed decision found in the diff is a reject; a disclosed one
  that contradicts this spec is a reject.
- **No self-certified done:** each task's Check is either an automated assertion
  the verifier re-runs itself, or an explicitly human-judged gate (marked HUMAN).

## Resolved questions (proposed; confirm or override)

- RQ-A (was OQ-A) — **Schema: realistic nested payload, minimal required
  contract.** The simulator emits realistic connected-vehicle telemetry; only the
  required-contract subset above is depended on by ingestion. Rationale: realism
  exercises the pipeline honestly, `geoFenceId`/`accuracy` are load-bearing for
  later increments, and shipping the rich schema now avoids a later migration.
- RQ-B (was OQ-B) — **Paths: scripted routes + controlled violator/jitter
  overlay**, not random walks. Rationale: H1's eval needs a reproducible, labeled
  mix of genuine crossings and jitter-induced false positives; only scripted
  scenarios with a controlled overlay produce that.
