# Spec 004 — Pipeline Observability & Latency Accumulation

Status: DRAFT (awaiting human approval)
Increment: 4 (cross-cutting; instruments 001 ingestion, 002 processing, 003 triage)
Depends on: 001, 002, 003 resources existing (reads their metrics; adds light instrumentation)
Traces to: general review O1 (thin runtime observability); streaming review Part B;
PRD success metric 2 (rule-update latency) and the detection-latency target — turns
both from one-shot verify numbers into continuously measured signals.

---

## Outcome

An operator can answer two questions at a glance: **(1) is each hop of the pipeline
healthy right now, and (2) of a record's total latency, how much did each hop add?**
The rule-update SLO (< 60 s) and the detection-latency target (sub-5 s) are measured
continuously, and the streaming failure modes (consumer falling behind, backpressure,
checkpoint failure, throttling, dead-letter accumulation) raise alarms before they
become incidents.

## Scope posture (right-sizing)

This increment is deliberately **portfolio-grade**, not operational-minimum. At the
pilot's ~2 msg/s, the thin slice that satisfies the request ("show where latency
accumulates") is just the in-band stamps + the offline probe (T1/T2/T4). The full
component-health dashboard, the alarm fleet, the Flink-native continuous metrics, and
the triage EMF (T3/T5/T6) **exceed that operational need** and are kept on purpose to
demonstrate production observability patterns. This is a chosen trade-off, recorded so
the breadth reads as intentional rather than as a failure to right-size. The
operational-minimum alternative (probe-only, defer the rest) remains a one-line cut if
the posture changes.

## In scope

- **Layer 1 — component health:** one CloudWatch dashboard, one row per hop (H1 IoT →
  H7 triage), from metrics the services already emit.
- **Layer 2 — end-to-end latency breakdown:** per-hop timestamps carried through the
  pipeline + custom latency metrics, rendered as a **stacked accumulation view** with
  two cumulative tracks (detection H1→H6, triage H7).
- **Alarms:** the streaming tripwires (iterator age, `millisBehindLatest`,
  backpressure, checkpoint failures, Flink downtime, write-throughput-exceeded canary,
  DLQ depth, per-track latency SLO breach).
- **Offline probe:** a local consumer that prints the per-hop + cumulative latency
  breakdown from the breach stream, for verify runs without a dashboard.

## Out of scope (this increment)

- **Shard-level enhanced metrics / per-shard utilization** — a *provisioned-mode /
  scale-time* concern; on-demand removes the capacity-planning rationale (see
  `docs/streaming-architecture-review.md` §B2.1). Deferred until per-vehicle load is
  uneven (finding SC1).
- Full distributed-trace spans across Kinesis via ADOT/X-Ray — Kinesis does not
  auto-propagate trace context; in-band timestamps cover the latency need at far lower
  cost. Spans remain a documented follow-up if causal trace trees are later required.
- Multi-region monitoring, log analytics beyond what alarms need, third-party APM.

## Functional requirements

- FR1 — Each pipeline hop reports health on a single dashboard from emitted metrics
  (no per-record cost).
- FR2 — A telemetry record accumulates a per-hop timestamp set; the resulting breach
  event carries an **additive, optional** `trace` block that downstream consumers
  (003) may ignore.
- FR3 — Per-hop and cumulative latency are computed and published as custom metrics
  (p50/p99), and visualized as a stacked accumulation widget split into a **detection**
  track and a **triage** track.
- FR4 — Alarms fire on the streaming tripwires listed in scope.
- FR5 — The metric set is **on-demand-appropriate**: consumer-lag/backpressure are the
  core signals; throughput/utilization are not required at pilot.
- FR6 — An offline probe computes and prints the per-hop + cumulative breakdown from a
  fixture or a live stream read, without requiring the dashboard.

## Acceptance criteria

- AC1 — The monitoring stack synthesizes with one dashboard carrying a labeled row per
  hop (H1…H7) and the stacked latency widget.
- AC2 — A breach event produced by 002 carries the `trace` block (eventTime, ingestTime,
  flinkRead, flinkEmit); a unit test validates the shape and that 003's consumer path
  ignores it.
- AC3 — The latency-probe, run over a fixture breach set, prints each hop's delta and
  the cumulative detection/triage totals (unit-tested arithmetic).
- AC4 — Alarms exist for: iterator age (H3/H6), `millisBehindLatest`/backpressure
  (Flink), `numberOfFailedCheckpoints` + `downtime` (Flink), `WriteProvisionedThroughputExceeded`
  (canary), DLQ depth, and per-track latency SLO breach.
- AC5 — Custom latency metrics are emitted via EMF and resolve under the
  `Geofence/Latency` namespace with per-hop dimensions (verified live).
- AC6 — No shard-level/utilization metric is required for the pilot; the deferral is
  documented with the condition that re-introduces it (SC1).

## Non-functional targets

- Instrumentation overhead negligible: timestamps are integers in existing payloads;
  metrics via EMF (log-embedded, no `PutMetricData` call in the hot path).
- The `trace` block is purely additive — it must not change any field 003 reads
  (preserves the 002→003 contract).
- Dashboard/alarms are code (CDK), deploy/destroy cleanly with the pipeline.

## Verification contract

- Traceability both directions (every task → FR/AC; every AC → a task).
- Drift signals (any one is a reject): adding shard-level/utilization metrics as a
  *pilot requirement* (contradicts FR5/AC6 and the on-demand decision); the `trace`
  block changing a field 003 consumes; latency computed from wall-clock at one point
  instead of per-hop deltas; any artifact referencing external/private source material.
- No self-certified done: AC5 (live EMF) and the dashboard populating under real
  traffic are proven in verify.md, re-run by the verifier.

## Open questions

- OQ-1 — Emit Layer-2 latencies from the Flink job as a custom metric group, from the
  offline probe, or both? (Proposed: probe first for verify; Flink metric group for
  continuous production — both, probe is the Tier-1 deliverable.)
- OQ-2 — Latency-probe sampling: every breach event, or a sampled fraction at high
  volume? (Proposed: all events at pilot; sample if volume grows.)
