# Design 004 — Pipeline Observability & Latency Accumulation

Status: DRAFT (awaiting human approval)
Implements: spec.md (004-observability)
Stack: `ObservabilityStack` (new) — a `CfnDashboard` + alarms over 001/002/003
resources, plus light in-band instrumentation in those increments.

This design is research-led: each pattern states the problem, the chosen
pattern/architecture, **why**, and a reference. It builds on the analysis in
`docs/streaming-architecture-review.md` (Part B) and turns it into buildable shape.

---

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Observability shape | **Two layers**: component-health metrics (Layer 1) + end-to-end latency breakdown (Layer 2) | They answer different questions — "which hop is unhealthy" vs "where did the time go". Neither alone is sufficient for a latency SLO. |
| Cross-hop latency | **In-band timestamps** carried in the record, deltas computed at each hop | Kinesis/Flink do **not** auto-propagate trace context; carrying event-time in the payload is the standard streaming pattern and is near-zero cost. |
| Custom metric transport | **CloudWatch Embedded Metric Format (EMF)** | Structured log lines CloudWatch auto-extracts into metrics — no `PutMetricData` call or throttling in the hot path; works from Lambda and Flink. |
| Dashboard + alarms | **CDK as code** (`CfnDashboard`, `Alarm`), `SEARCH` expressions for any dynamic dimensions | Reproducible, deploys/tears down with the pipeline; SEARCH survives on-demand shard churn. |
| Metric set | **On-demand-appropriate**: consumer-lag + backpressure core; throughput/utilization deferred | On-demand manages capacity, so utilization-for-resharding is AWS's job, not ours (§B2.1). |
| Trace propagation across Kinesis | **In-band timestamps now; ADOT/X-Ray spans deferred** | Full span propagation through Kinesis needs manual context carriage and adds cost/complexity the pilot's latency question doesn't require. |

## Pattern 1 — Two-layer observability (health + latency)

**Problem.** A single metric type can't tell you both *that* a hop is unhealthy and
*how much latency* each hop contributes.

**Pattern.** Layer 1 is a per-hop health dashboard from emitted CloudWatch metrics
(a USE/RED-style view: utilization/saturation/errors per component). Layer 2 is an
end-to-end latency breakdown from in-band timestamps. The two cross-check: Layer 2's
"stream wait" should track Layer 1's `GetRecords.IteratorAgeMilliseconds`.

**Why.** Health metrics catch *component* failure; the latency breakdown catches
*SLO* regression and localizes it. AWS's streaming-monitoring guidance frames exactly
these questions ("is the app keeping up or falling behind?", "is the sink receiving
data?") — Layer 1 answers them per hop.

**Reference.** Managed Flink monitoring guidance
(https://docs.aws.amazon.com/managed-flink/latest/java/monitoring.html); CloudWatch
recommended alarms
(https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html).

## Pattern 2 — Latency via in-band timestamps (not trace propagation)

**Problem.** To measure per-hop latency you need the same record's timestamp at each
hop. But **Kinesis and Flink do not automatically propagate trace context** the way
HTTP services do — X-Ray/OpenTelemetry rely on headers that streams don't carry.

**Pattern.** Stamp the event at each hop and carry the stamps **in the record**:
- `t0 eventTime` — producer (already in the telemetry payload as `timestamp`).
- `t1 ingestTime` — set in the **IoT rule SQL** via the `timestamp()` function
  (`SELECT *, timestamp() AS ingestTime FROM 'iot_data'`).
- `t2 streamArrival` / `t5 alertsArrival` — Kinesis record `ApproximateArrivalTimestamp`
  (read consumer-side; no payload change).
- `t3 flinkRead`, `t4 flinkEmit` — Flink processing-time, written into the breach
  event's additive `trace` block.
- `t6…t10` — 003 triage sub-hops via EMF.

Per-hop latency = consecutive deltas; cumulative = `tN − t0`.

**Why.** In-band event-time is the canonical way to measure latency in streaming
systems where there is no synchronous call chain to propagate a header through. It is
near-zero cost (integers in an existing payload), and `ApproximateArrivalTimestamp` is
free metadata Kinesis already attaches. Full OTel spans across Kinesis would require
manually serializing trace context into each record and a collector — more cost and
moving parts than the latency question needs.

**Reference.** Trace-context propagation uses headers across services (X-Ray/OTel) —
which streams don't provide, hence in-band carriage:
https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-migration.html . Kinesis
`ApproximateArrivalTimestamp` semantics (iterator-age is current-time minus this):
https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html .

## Pattern 3 — Custom metrics via EMF

**Problem.** Publishing per-hop latency from Lambda/Flink with `PutMetricData` adds a
synchronous API call (latency + throttling risk) to the hot path.

**Pattern.** Emit a structured EMF log line; CloudWatch extracts the metric
asynchronously from logs. Namespace `Geofence/Latency`, one metric per hop
(`SourceToIoT`, `IoTToStream`, `StreamWait`, `FlinkProcess`, `FlinkToAlerts`,
`DetectionTotal`, `TriageBedrock`, `NotifyTotal`), dimensioned by stage.

**Why.** EMF decouples metric emission from the request path, avoids `PutMetricData`
TPS limits, and is the AWS-recommended way to get high-cardinality custom metrics out
of Lambda.

**Reference.**
https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html

## Pattern 4 — Dashboard & alarms as code

**Problem.** Console-built dashboards drift and aren't reproducible; on-demand shard
IDs churn so any per-shard widget can't pin IDs.

**Pattern.** `CfnDashboard` with the Layer-1 rows + the Layer-2 stacked widget, and
`Alarm` constructs for the tripwires (Pattern 5). Any per-dimension aggregation uses a
CloudWatch metric-math `SEARCH` expression (e.g. MAX across shards) rather than
hard-coded dimensions.

**Why.** Deploys/destroys with the pipeline (matches the project's clean-teardown
posture); SEARCH expressions survive on-demand shard splits/merges.

**Reference.** Recommended alarms + thresholds
(https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html).

## Pattern 5 — On-demand-appropriate metric & alarm selection

Core signals (these matter regardless of capacity mode — on-demand doesn't help with
any of them): `GetRecords.IteratorAgeMilliseconds` (H3/H6), Flink `millisBehindLatest`
/ `records_lag_max` / `backPressuredTimeMsPerSecond`, `numberOfFailedCheckpoints`,
`downtime`, Lambda `IteratorAge`, SQS `ApproximateAgeOfOldestMessage`, DLQ depth,
Bedrock throttle count, and per-track latency SLO.

Kept canary: `WriteProvisionedThroughputExceeded` — still fires on on-demand (burst
beyond 2× trailing peak during the ~15-min scale, or a hot key).

Deferred (scale-time, not pilot): shard-level enhanced metrics + per-shard utilization,
re-introduced only when per-vehicle load is uneven (finding SC1).

**Why.** On-demand makes throughput/utilization a capacity-planning concern AWS owns;
spending dashboard/alarm budget there at pilot is noise. See
`docs/streaming-architecture-review.md` §B2.1 for the full reasoning.

## Hop → metric → stamp map

| Hop | Layer-1 health metric | Layer-2 stamp / delta |
|---|---|---|
| H1 IoT | `TopicMatch`, `RulesExecuted`, `RuleExecutionThrottled`, `ParseError` | t0→t1 SourceToIoT (`ingestTime` via `timestamp()`) |
| H3 telemetry stream | `GetRecords.IteratorAgeMilliseconds`, `WriteProvisionedThroughputExceeded` | t1→t2 IoTToStream (`ApproximateArrivalTimestamp`) |
| H4/H5 Flink | `millisBehindLatest`, `backPressuredTimeMsPerSecond`, `lastCheckpointDuration`, `numberOfFailedCheckpoints`, `downtime` | t2→t3 StreamWait, t3→t4 FlinkProcess |
| H6 alerts stream | iterator age (as H3) | t4→t5 FlinkToAlerts |
| H7 triage | Lambda `IteratorAge`/`Duration`, Bedrock `InvocationLatency`/throttle, SQS age, SNS delivered/failed, DLQ depth | t6…t10 triage sub-hops (EMF) |

## Data-contract change (additive)

The 002 breach event gains an **optional** `trace` block; 003 ignores it:

```jsonc
{ "vehicleId": "veh-014", "zoneId": "...", "breachType": "entry", "timestamp": 1782458400000,
  "...": "existing factual fields unchanged",
  "trace": { "eventTime": 1782458400000, "ingestTime": 1782458400180,
             "flinkRead": 1782458400520, "flinkEmit": 1782458400523 } }
```

## Testing approach

- Unit: latency-probe delta/cumulative arithmetic against a fixture breach set; the
  `trace` block shape; that the 003 adapter ignores `trace`.
- Construct tests (CDK assertions): dashboard present with a row per hop + the stacked
  widget; each alarm present with the right metric/threshold; SEARCH expression used
  for any per-shard aggregation.
- Live (verify.md): drive traffic; confirm the dashboard populates per-hop latency,
  EMF metrics resolve under `Geofence/Latency` (AC5), and an induced lag/backpressure
  trips its alarm.

## Risks / follow-ups

- MSF sets checkpoint/parallelism at the **application config level, not in app code**
  (see 002 resilience tasks); the Flink custom metric group is app code and is allowed.
- If causal trace trees (not just latency) are later needed, add ADOT spans with
  in-record context propagation — recorded as a follow-up, not built here.
- Shard-level enhanced metrics + utilization re-introduced at scale (SC1).
