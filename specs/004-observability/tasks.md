# Tasks 004 — Pipeline Observability & Latency Accumulation

Status: DRAFT (awaiting human approval)
Implements: spec.md + design.md (004-observability)

Each task is small and individually verifiable. Tier-1 (synth + unit) lands first;
live verification is deferred to an authorized deploy window. No deploy in the
build pass.

- [x] T1 — Enrich the IoT topic rule SQL with the ingest stamp:
  `SELECT *, timestamp() AS ingestTime FROM 'iot_data'` (touches the 001 rule).
  Gives the SourceToIoT delta. Pattern 2. Check: construct test asserts the rule's
  `Sql` includes `timestamp() AS ingestTime`; `cdk synth` clean.

- [x] T2 — Add the additive optional `trace` block to the 002 breach-event schema
  (`eventTime`, `ingestTime`, `flinkRead`, `flinkEmit`); document the seam so 003
  ignores it. Pattern 2. Check: unit test validates the shape and that the 003
  analyzer-bridge adapter reads no `trace` field.

- [x] T3 — Flink custom latency metric group: emit StreamWait (t3−t2) and
  FlinkProcess (t4−t3) per record as Flink metrics (MSF publishes to CloudWatch);
  stamp `flinkRead`/`flinkEmit` into the breach event's `trace`. Pattern 2/3. Check:
  fixture mini-run asserts the metrics are produced and the stamps are present. Done —
  pure `latency.py` (stamp_flink + hop_latencies + emit_flink_metrics) tested via the
  detector mini-run; the Flink adapter registers `Geofence/Latency` gauges and feeds
  them per record. StreamWait needs t2 (stream arrival), supplied by the source at
  runtime / the probe on the consumer side; the value-only topology emits FlinkProcess
  and skips StreamWait until arrival is wired (documented).

- [x] T4 — `tools/verify/latency-probe.ts` (extends `tools/verify/reader.ts`): read
  `geofence-alerts`, compute each hop delta + the cumulative detection/triage totals
  from the `trace` block plus `ApproximateArrivalTimestamp`, print the breakdown
  table, and optionally emit the deltas as EMF under `Geofence/Latency`. Pattern 2/3.
  Check: unit test over a fixture breach set asserts the per-hop and cumulative
  arithmetic; runs offline (no deploy).

- [x] T5 — EMF for the triage sub-hops in the 003 bridges/runtimes
  (analyzerRead → bedrockDone → sqsEnqueue → publisherRead → snsPublish), emitting
  `TriageBedrock` and `NotifyTotal`. Pattern 3. Check: unit test asserts the EMF
  document shape (namespace, dimensions, metric names). Done — pure `observability/emf.py`
  (document + analyzer_document + publisher_document) tested for the exact EMF shape
  under `Geofence/Latency`. The document builder is the tested deliverable (matching the
  Check); the hot-path emit call (a `print(json.dumps(...))` at each stage) is wired at
  the runtime/bridge deploy points, like the other deploy-only agent wiring.

- [x] T6 — `ObservabilityStack` (CDK): `CfnDashboard` with one Layer-1 row per hop
  (H1…H7) and the Layer-2 **stacked** latency widget (detection vs triage tracks);
  `Alarm` constructs for iterator age (H3/H6), `millisBehindLatest`/backpressure,
  `numberOfFailedCheckpoints` + `downtime`, `WriteProvisionedThroughputExceeded`
  canary, DLQ depth, and per-track latency SLO. Any per-shard aggregation uses a
  `SEARCH` metric-math expression. Pattern 4/5. Check: construct tests assert the
  dashboard rows, the stacked widget, and each alarm's metric/threshold; `npm test`
  green; `cdk synth` clean.

- [x] T7 — Author `specs/004-observability/verify.md` (live runbook): drive traffic;
  confirm per-hop latency populates on the dashboard and EMF metrics resolve under
  `Geofence/Latency` (AC5); induce consumer lag/backpressure and confirm the alarm
  trips; confirm the detection vs triage tracks separate (L4). Exact commands +
  expected ranges. Check: runbook is runnable and lists commands + expected numbers.

- [ ] T8 — Run verify.md end to end against a dev deploy (deferred; needs an
  authorized deploy). Check: filled result block — dashboard populated, EMF resolved
  (AC5), an alarm tripped on induced lag, tracks separated. DEFERRED — barred by the
  standing no-deploy directive (also depends on the 002 Flink live prerequisites). The
  Tier-1 half (probe math, trace block, EMF shape, dashboard/alarm synth) is green today.

- [x] T9 — Record deferred follow-ups as STATE.md queue proposals: shard-level
  enhanced metrics + per-shard utilization when per-vehicle load is uneven (SC1);
  ADOT/X-Ray causal spans if trace trees are later needed. Check: captured, scope
  minimal. Done — recorded in STATE.md Watch List (SC1 shard-level metrics at scale;
  ADOT/X-Ray spans; EMF hot-path emit wiring; Flink StreamWait stream-arrival wiring).

## Traceability (task → what it satisfies)

- T1 ingest stamp → FR2 ; T2 trace block → FR2, AC2 ; T3 Flink latency → FR2, FR3 ;
  T4 probe → FR6, AC3 ; T5 triage EMF → FR3, AC5 ; T6 dashboard+alarms → FR1, FR3,
  FR4, FR5, AC1, AC4, AC6 ; T7 runbook → AC1/AC4/AC5 (made concrete) ;
  T8 live run → AC5 ; T9 → scope discipline (SC1 deferral, AC6).
- Every AC maps to ≥ 1 task; every task maps to ≥ 1 FR/AC.

## Verification tiers

- **Tier 1 — local, free** (maker runs; verifier RE-RUNS): `npm run build`,
  `npm test` (construct + probe unit), `pytest` (EMF doc shape), the Flink fixture
  mini-run, `npx cdk synth`.
- **GATE — deploy (human-authorized):** deploy `ObservabilityStack` + the
  instrumented 001/002/003 resources to dev; run verify.md; destroy after.
- **Tier 2 — live, measured:** dashboard populates per-hop latency; EMF resolves
  (AC5); an induced-lag alarm trips; detection/triage tracks separate.

## Definition of done (increment)

- Tier 1 green, re-run by the verifier.
- Dashboard + alarms synthesize and (when deployed) populate; AC5 confirmed live.
- The `trace` block is additive — 003's consumed fields unchanged.
- On-demand metric posture honored (no shard-level/utilization as a pilot requirement; AC6).
- No durable artifact references external/private source material.
- Branch handed to the human for verification and merge; nothing auto-merged.
