# Streaming Architecture Review + Latency Observability Design

Date: 2026-06-30
Scope: the end-to-end streaming pipeline across increments 001 (ingestion), 002
(processing), 003 (agentic alerting), reviewed through a **streaming** lens —
Scalability, Reliability, Availability, Low latency — plus a concrete
**per-hop latency-accumulation monitor**.
Region assumed: us-east-1.
Relationship to the general review: `docs/well-architected-review.md` scored all
six pillars and is the authority on cost and IAM. This document goes deeper on the
four streaming qualities, adds a **per-hop streaming-characteristics matrix**, and
answers finding **O1** (runtime observability is thin) with a buildable design.
Method: streaming characteristics and CloudWatch metric names verified against AWS
documentation (aws-knowledge MCP); URLs cited inline.

> Status: **design and review only. Nothing here is deployed.** The dashboard,
> alarms, and probe described in Part B become CDK constructs and a small consumer
> script in a future monitoring task — proposed at the end, not built in this pass.

---

## 0. The pipeline as a sequence of streaming hops

Every place a record changes custody is a hop with its own throughput limit,
ordering guarantee, buffering behavior, failure mode, and latency contribution.
The whole point of a streaming review is to look at *each* hop, not the services in
isolation.

```
        DATA PLANE (telemetry, high volume)                         CONTROL PLANE (rules, low volume)
 t0  producer (simulator / vehicle)                          operator edits a zone
  │   eventTime = payload.timestamp                                  │
  ▼                                                                  ▼
 H1  AWS IoT Core  (MQTT broker, topic iot_data)             DynamoDB geo-fences (item write)
  │                                                                  │  DynamoDB Streams (ordered per item, exactly-once)
  ▼                                                                  ▼
 H2  IoT Rules Engine  (SQL SELECT, Kinesis action)          rules-bridge Lambda (DDB-Streams ESM)
  │   partitionKey = ${vehicleId}                                    │  emits compact rule-change record
  ▼                                                                  ▼
 H3  Kinesis vehicle-telemetry  (durable log, on-demand)     Kinesis geofence-rules (on-demand)
  │   ordered per vehicleId                                          │
  └───────────────┐                                  ┌───────────────┘ (broadcast)
                  ▼                                  ▼
 H4/H5  PyFlink on Managed Service for Apache Flink
        source read → KeyedBroadcastProcessFunction (point-in-polygon vs all active zones,
        per-vehicle keyed edge state) → sink
                  │
                  ▼
 H6  Kinesis geofence-alerts  (durable log, on-demand, key vehicleId)
                  │
                  ▼  (003)
 H7  analyzer bridge Lambda → AgentCore alert-analyzer (Bedrock) → SQS → publisher → SNS email
```

Hop labels (H1…H7) are used throughout this document and by the monitor in Part B.

---

# Part A — Streaming Well-Architected Review

## A1. Per-hop streaming-characteristics matrix

The single most important table in this review: for every hop, the streaming
properties that must be reasoned about, and where each is handled (✓) or is a gap
(△ = finding raised below).

| Hop | Throughput limit / scaling unit | Ordering | Partitioning & skew | Buffering / backpressure | Failure mode & durability | Latency contribution | Observed by |
|---|---|---|---|---|---|---|---|
| **H1 IoT Core** | Account-level connect/publish TPS quotas; 128 KB max message. Our payload ~1–2 KB, ~2 msg/s. ✓ | None across devices (per-connection only) | n/a (routing key applied at H2) | Broker buffers transiently; no consumer backpressure | Malformed JSON dropped silently — no error action yet △ (O2) | publish round-trip, sub-100 ms typ. | `TopicMatch`, `ParseError` |
| **H2 Rules engine** | Auto-scales; throttles under abuse | Preserves message order into the action | `partitionKey=${vehicleId}` substituted from body ✓ | None (synchronous action) | Action failure → record lost unless error action set △ | rule eval + `PutRecord`, sub-second | `RulesExecuted`, `RuleExecutionThrottled`, action `Success`/`Failure` |
| **H3 vehicle-telemetry (Kinesis)** | On-demand: 4 MB/s & 4 000 rec/s start → 2× trailing-30-day peak; **per partition key bounded by one shard: 1 MB/s & 1 000 rec/s** △ (SC1) | **Ordered per partition key** = per vehicle ✓ (load-bearing) | One vehicle → one shard; a high-frequency vehicle hot-spots its shard △ (SC1) | Durable 24 h log; consumer pull-paced; slow consumer → iterator age grows | At-least-once delivery; record loss only if unread > retention | buffer/queue wait until consumer reads | `IncomingRecords`, `WriteProvisionedThroughputExceeded`, **`GetRecords.IteratorAgeMilliseconds`** |
| **H4 Flink source read** | Source parallelism ≤ shard count; on-demand shard count is managed/opaque △ (SC2) | Per-shard order preserved into keyed stream | Re-keys by `vehicleId` for edge state; zones via **broadcast** | Source backpressures upstream poll if job is busy | Checkpoint replays from last offset on restart | shared `GetRecords` poll cadence (~200 ms+) vs EFO (~70 ms) △ (L1) | `millisBehindLatest`, `records_lag_max` |
| **H5 Flink process** | KPU/parallelism; MSF autoscaling on CPU; +1 orchestration KPU billed | Per-key (vehicle) order; broadcast applied consistently | Broadcast state = every zone on every subtask; grows with #zones △ (SC3) | Network buffers (buffer-timeout ~100 ms △ L2); checkpoint barriers stall briefly △ (L3) | Checkpointing/snapshots → exactly-once *state*; bootstrap race △ (R2) | point-in-polygon µs; latency dominated by buffering/checkpoints | `busyTimeMsPerSecond`, `backPressuredTimeMsPerSecond`, `lastCheckpointDuration`, `numberOfFailedCheckpoints`, `downtime` |
| **H6 geofence-alerts (Kinesis)** | On-demand; key `vehicleId` | Ordered per vehicle | Same as H3; alert volume far lower | Durable 24 h buffer for 003 | Flink Kinesis sink is **at-least-once** → 003 must dedupe △ (R4) | sink `PutRecord` + queue wait | `IncomingRecords`, `GetRecords.IteratorAgeMilliseconds` |
| **H7 triage (003)** | Lambda concurrency = shard count × parallelization; Bedrock RPM/TPM quotas △ (R5) | Per-shard; SQS standard not ordered | `vehicleId` key; SQS visibility | **SQS is the real queue** — `ApproximateAgeOfOldestMessage`; Bedrock throttle backpressure | DLQs needed on SQS + SNS subscription △ (R3); idempotent publish △ (R4) | **model inference seconds — dominant** △ (L4) | Lambda `IteratorAge`/`Duration`, Bedrock `InvocationLatency`, SQS age, SNS delivered/failed |
| **Control plane** | DDB on-demand; DDB Streams ≤ 2 consumers/shard, Lambda polls ~4×/s | DDB Streams ordered per item, exactly-once ✓ | rules keyed by `id`; trivial volume | Lambda ESM batching | DDB Streams exactly-once + bridge DLQ needed △ (R1) | sub-second per stage; well inside 60 s (AC2) | Lambda `IteratorAge`, geofence-rules iterator age |

Sources: Kinesis on-demand scaling and per-shard limits
(https://aws.amazon.com/blogs/aws/amazon-kinesis-data-streams-on-demand-stream-data-at-scale-without-managing-capacity/);
iterator-age semantics
(https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html);
Flink metrics
(https://docs.aws.amazon.com/managed-flink/latest/java/monitoring.html,
https://docs.aws.amazon.com/managed-flink/latest/java/metrics-dimensions.html);
IoT rule metrics
(https://docs.aws.amazon.com/iot/latest/developerguide/metrics_dimensions.html);
DynamoDB Streams + Lambda limits
(https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html).

## A2. Scalability

**Strengths.** On-demand Kinesis and DynamoDB, autoscaling Managed Flink, and
per-connection IoT all right-size without manual capacity. Pilot volume (~2 msg/s)
sits far below every limit.

**Findings.**

- **SC1 [High for scale, Low for pilot] — per-vehicle throughput ceiling is one
  shard.** A Kinesis partition key maps to exactly one shard, so a *single*
  vehicle's telemetry is capped at **1 MB/s and 1 000 records/s** no matter how far
  on-demand scales the stream overall. The per-vehicle ordering guarantee
  (the load-bearing decision in 001) and unbounded per-vehicle throughput are in
  direct tension — you cannot have both. At sub-second cadence with the full VSS
  payload this is still ~2 KB × a few/s ≪ 1 MB/s, so the pilot is safe.
  *Action:* document this as the explicit per-vehicle scaling bound in `001/design.md`
  ("Partition key & ordering"); if a future use case needs higher per-entity
  throughput, it must give up strict per-vehicle ordering (composite key
  `vehicleId#bucket` + reorder downstream), not paper over it.
  **On-demand note:** on-demand auto-splits shards on *aggregate* load but cannot
  relieve a single hot partition key (the key still hashes to one child shard), so
  on-demand does **not** fix SC1. This is the one residual reason to watch per-shard
  utilization (see B2) — and the only one, since on-demand removes the
  capacity-planning rationale for throughput/utilization metrics entirely.

- **SC2 [Med] — Flink source parallelism is bounded by shard count, which
  on-demand manages opaquely.** You cannot deterministically pin source parallelism
  to shards when the shard count floats. *Action:* rely on MSF autoscaling (CPU-based,
  on by default) and the `records_lag_max`/`millisBehindLatest` lag signal for
  reactive scale; document that source parallelism is not hand-tuned. At pilot, one
  app KPU is ample (general review P2).

- **SC3 [Med, design ceiling] — broadcast state replicates every zone to every
  subtask.** Memory cost ≈ (#zones × polygon size × parallelism). Perfect for a
  handful of zones; it does **not** scale to thousands of zones. *Action:* record the
  ceiling. Beyond ~hundreds of zones, switch from broadcast to spatial partitioning
  (grid/geohash key, or an R-tree broadcast index) — a different design, to be chosen
  explicitly rather than drifted into.

- **SC4 [Low] — IoT single topic `iot_data`.** Fine: the rules engine fans out and
  the partition key does the sharding. No per-topic throughput concern at pilot.

## A3. Reliability

The general review's R1–R6 stand. The streaming-specific framing:

- **End-to-end delivery semantics is *at-least-once*, not exactly-once.** H1→H3 can
  duplicate (rule retries), the Flink Kinesis sink (H6) is at-least-once, and SQS
  standard (H7) is at-least-once. Flink checkpointing gives exactly-once **state**
  inside the job, but that does not extend through a non-transactional sink.
  **Consequence:** correctness depends on **idempotent consumption at 003**, keyed on
  a stable `dedupeKey` (`vehicleId|zoneId|breachType|eventTime`). This is finding
  **R4** and it is the linchpin of the "exactly one delivery" metric — make the
  dedupe authoritative. DynamoDB Streams (control plane) is the one exactly-once,
  ordered hop and needs no dedupe.

- **R2 (Flink reliability) — restated as streaming config.** Enable checkpointing
  (interval ≈ 60 s), snapshot-on-update/scale for exactly-once across deploys, and
  make the **broadcast-state bootstrap race a tested acceptance criterion**:
  telemetry must not be evaluated before the initial rule set is loaded, or early
  breaches are missed. Monitor `numberOfFailedCheckpoints`, `lastCheckpointDuration`,
  `downtime` (https://docs.aws.amazon.com/managed-flink/latest/java/monitoring.html).

- **Backpressure is the early-warning signal of the whole data plane.** If H5 can't
  keep up, backpressure propagates to the H4 source, `millisBehindLatest` climbs, and
  H3 `IteratorAgeMilliseconds` rises toward the 24 h retention wall — past which
  records are lost. The chain of metrics (`backPressuredTimeMsPerSecond` →
  `millisBehindLatest` → `IteratorAgeMilliseconds`) is the reliability tripwire and is
  alarmed in Part B.

- **Poison records block a shard.** One undeserializable telemetry record can stall a
  shard in Flink or a batch in a Lambda bridge. *Action:* deserialization-failure
  handling in the Flink source (drop + count a metric), and `ReportBatchItemFailures`
  + bisect + on-failure DLQ on the Lambda bridges (R1).

- **Replay is the recovery tool.** Kinesis 24 h retention means any consumer down
  < 24 h recovers with no loss by replaying from its checkpoint/iterator. Keep 24 h
  for pilot; do not enable extended retention (cost, SU2).

## A4. Availability

- **Managed hops are multi-AZ by default** (IoT Core, Kinesis, DynamoDB, Lambda,
  SQS, SNS). No action; this is why serverless was the right instinct.

- **The Flink application is the only long-running stateful component — the
  pipeline's single most availability-sensitive hop.** It runs multi-AZ, but
  **scaling and updates restart the job** (seconds–minutes of `downtime > 0`).
  Checkpoints + snapshots make those restarts lossless, but they are *brief
  unavailability*. *Action:* alarm on `downtime > 0`; schedule scaling/deploys
  off-peak; accept short restart windows for pilot.

- **RPO/RTO (pilot).** RPO ≈ checkpoint interval (≤ ~60 s of state) bounded by 24 h
  stream retention for replay; RTO ≈ Flink restart time. Single-region, no
  multi-region DR. *Action:* state "single-region, no DR" as an explicit pilot
  non-goal (matches SU2) rather than leaving it implied.

- **No SPOF other than the Flink app** at pilot scale; the streams and stores are
  inherently redundant.

## A5. Low latency

Latency is the lead quality and the reason for Part B. Budget per hop (typical,
pilot):

| Hop | Typical latency | Dominated by | Tunable |
|---|---|---|---|
| H1 producer→IoT | < 100 ms | network/TLS publish | client cadence |
| H2 rule→stream | sub-second (001 measured **0.97 s** source→stream total) | rule eval + `PutRecord` | — |
| H3 stream queue wait | tens–hundreds ms | consumer poll cadence | EFO vs shared (L1) |
| H4 source read | poll-bound | shared `GetRecords` ~200 ms+ vs EFO ~70 ms | L1 |
| H5 Flink process | µs compute + buffering | network buffer-timeout ~100 ms (L2), checkpoint barriers (L3) | buffer-timeout, unaligned checkpoints |
| H6 sink→alerts | sub-second | `PutRecord` + queue wait | — |
| **Detection total (H1→H6)** | **a few seconds** (spec target) ✓ | the sum above | — |
| H7 triage+notify | **seconds–tens of seconds** | **Bedrock inference (L4)** | model choice, suppression gate |
| Rule update (control plane, AC2) | well under **60 s** | Lambda poll + Flink broadcast read | init position |

**Findings.**

- **L1 [Med] — shared-throughput vs Enhanced Fan-Out (EFO).** Shared `GetRecords`
  polling adds poll-interval latency; EFO is push-based (~70 ms) but costs more per
  consumer-shard-hour. At pilot there is **one** consumer per stream, so shared is
  the right call. *Action:* document the EFO tradeoff; revisit only if a second
  low-latency consumer appears (matches general review P3).

- **L2 [Low] — Flink network buffer-timeout** (~100 ms default) trades latency for
  throughput. For a low-latency pilot it can be lowered. *Action:* note as a tunable;
  don't change blindly — measure first via Part B.

- **L3 [Low] — checkpoint barriers** momentarily stall processing; **aligned**
  checkpoints add latency under backpressure, **unaligned** reduce it at a state-size
  cost. *Action:* note; default aligned is fine at pilot.

- **L4 [High, by design] — separate two latency SLOs.** "Breach **detection**
  latency" (H1→H6, target sub-5 s) and "triage + **notify** latency" (H7,
  model-bound, tens of seconds) are different budgets. Collapsing them hides where
  time goes. The suppression gate (003) keeps Bedrock off low-value events, which is
  what keeps the *detection* path fast. *Action:* state both SLOs explicitly in
  `003/spec.md`; the monitor (Part B) reports them as separate cumulative tracks.

## A6. Streaming scorecard (this lens)

| Quality | Score (0–10) | One-line |
|---|---|---|
| Scalability | 7 | On-demand everywhere; per-vehicle one-shard ceiling (SC1) and broadcast-state ceiling (SC3) are design bounds to document, not pilot blockers |
| Reliability | 5 | Ordering correct; at-least-once end-to-end ⇒ idempotency (R4), checkpointing + bootstrap test (R2), poison-record handling are the gaps |
| Availability | 7 | Managed multi-AZ default; Flink restart windows the only real exposure; DR a stated non-goal |
| Low latency | 7 | Detection path sub-5 s is realistic; split detection vs triage SLOs (L4); EFO/buffer-timeout are levers not yet needed |

---

# Part B — Latency-Accumulation Monitor

**Goal (verbatim from the request):** display how latency accumulates at each
place — source → IoT Core → Kinesis stream → stream queue wait → process → output,
and on into triage. Two complementary layers, because they answer different
questions.

## B1. Two layers, two questions

| Layer | Question it answers | Mechanism | Per-record? |
|---|---|---|---|
| **Layer 1 — component health** | *Which hop is the bottleneck right now?* | CloudWatch metrics each service already emits | No (aggregate) |
| **Layer 2 — end-to-end breakdown** | *Of a record's total latency, how many ms did each hop add?* | Timestamps carried in the record + custom metrics via EMF | Yes (per record, aggregated to p50/p99) |

Layer 1 is free and immediate. Layer 2 is the actual "accumulation" view and needs
light instrumentation. Build both; they cross-check each other (e.g. Layer 2's
"stream wait" should track Layer 1's `IteratorAgeMilliseconds`).

## B2. Layer 1 — component-health dashboard (per hop)

One dashboard, one row per hop, sourced entirely from emitted CloudWatch metrics
(no code change):

- **H1 IoT Core:** `TopicMatch`, `RulesExecuted`, `RuleExecutionThrottled`,
  `ParseError`, and the Kinesis-action `Success`/`Failure` count
  (https://docs.aws.amazon.com/iot/latest/developerguide/metrics_dimensions.html).
- **H3 vehicle-telemetry:** the consumer-lag headline
  **`GetRecords.IteratorAgeMilliseconds`** (the "stream queue wait"; zero = caught
  up) and the wall-canary **`WriteProvisionedThroughputExceeded`** (see the
  on-demand note below)
  (https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html).
- **H4/H5 Flink:** `millisBehindLatest`, `records_lag_max`,
  `busyTimeMsPerSecond`, `backPressuredTimeMsPerSecond`, `cpuUtilization`,
  `heapMemoryUtilization`, `lastCheckpointDuration`, `numberOfFailedCheckpoints`,
  `downtime` (https://docs.aws.amazon.com/managed-flink/latest/java/monitoring.html).
- **H6 geofence-alerts:** same Kinesis set as H3.
- **Control plane:** rules-bridge Lambda `IteratorAge`/`Duration`/`Errors`,
  `geofence-rules` iterator age, DLQ depth.
- **H7 triage:** analyzer/publisher Lambda `IteratorAge`/`Duration`/`Errors`,
  Bedrock `InvocationLatency`/throttle count, **SQS `ApproximateAgeOfOldestMessage`**
  (the real queue age), SNS `NumberOfNotificationsDelivered`/`Failed`, DLQ depths.

### B2.1 Throughput / shard-utilization metrics — provisioned-mode concern, optional on on-demand

Throughput and utilization metrics exist mainly for **capacity planning** — knowing
when to reshard a *provisioned* stream. **This pipeline uses on-demand mode, where
AWS manages shard count, so that rationale does not apply** and these are **not**
part of the pilot's required monitoring set:

| Metric | Real Kinesis metric | Capacity-planning value on-demand | Keep at pilot? |
|---|---|---|---|
| incoming records/sec | `IncomingRecords` (`Sum` ÷ period) | gone | optional — cheap **liveness** check (producer dead / runaway) |
| incoming bytes/sec | `IncomingBytes` (`Sum` ÷ period) | gone | optional — loose **cost** proxy (Cost Explorer is better) |
| shard utilization | none — derive `max(bytes/s ÷ 1 MB/s, records/s ÷ 1000/s)` **per shard** | gone for planning | defer — see residual use below |

What on-demand does **not** rescue you from, and therefore still matters:

- **Hot partition key (SC1).** On-demand splits shards on aggregate load but cannot
  relieve a single hot key. **Per-shard** write utilization pinned near 100% on one
  key *is* the SC1 signal, and it must be **shard-level** to be truthful — a
  stream-level average masks the hot shard. At the pilot (~2 msg/s, even load) SC1 is
  a non-issue; re-introduce per-shard utilization only if per-vehicle load becomes
  uneven and high-frequency.
- **`WriteProvisionedThroughputExceeded`** still fires on on-demand — on a burst
  beyond 2× the trailing-30-day peak (the auto-scale doubling takes up to ~15 min) or
  on a hot key. It is the lagging canary that on-demand's autoscaling *didn't* save
  you; cheap to alarm on, rare at pilot. This is the one throughput-side signal worth
  keeping by default.

Bottom line: on on-demand the core monitor is the **Layer 2 latency breakdown** plus
**iterator-age / backpressure** (B4) and the throttle canary. Throughput and
utilization are optional, and full per-shard utilization is a scale-time addition,
not a pilot requirement.

## B3. Layer 2 — end-to-end latency breakdown (the accumulation view)

### B3.1 Timestamps captured at each hop

Each record accumulates a `trace` block; deltas between consecutive stamps are the
per-hop latencies.

| Stamp | Where set | How | Delta it enables |
|---|---|---|---|
| `t0 eventTime` | producer | already in payload as `timestamp` (epoch ms) | baseline |
| `t1 ingestTime` | H2 IoT rule | enrich SQL: `SELECT *, timestamp() AS ingestTime FROM 'iot_data'` (IoT SQL `timestamp()` = epoch ms at rule eval) | **source→IoT** = t1−t0 |
| `t2 streamArrival` | H3 | Kinesis record `ApproximateArrivalTimestamp` (consumer-side, **no payload change**) | **IoT→stream** = t2−t1; source→stream = t2−t0 (001's reader already prints this) |
| `t3 flinkRead` | H4 | Flink stamps processing-time at source read | **stream queue wait** = t3−t2 (cross-checks `IteratorAgeMilliseconds`) |
| `t4 flinkEmit` | H5 | Flink stamps when the breach event is produced; written into the breach event's `trace` | **Flink process** = t4−t3 |
| `t5 alertsArrival` | H6 | `ApproximateArrivalTimestamp` on geofence-alerts | **sink+queue** = t5−t4 |
| `t6 analyzerRead` … `t10 snsPublish` | H7 | EMF from the 003 Lambdas / AgentCore | triage sub-hops incl. `bedrockLatency` |

`t0,t1` ride inside the telemetry payload; `t2,t5` are read from Kinesis metadata
(no payload change); `t3,t4` are added to the **breach event** as an additive,
optional `trace` block:

```jsonc
// geofence-alerts breach event — ADDITIVE, optional. 003 ignores it.
{
  "vehicleId": "veh-014", "zoneId": "zone-downtown-restricted", "breachType": "entry",
  "timestamp": 1782458400000,           // = t0 eventTime
  "...": "existing factual fields unchanged",
  "trace": { "eventTime": 1782458400000, "ingestTime": 1782458400180,
             "flinkRead": 1782458400520, "flinkEmit": 1782458400523 }
}
```

This keeps observability out of the data contract: it is an optional block 003 does
not read (consistent with "document the seam so 003 doesn't depend on it" in
`002/design.md`).

### B3.2 Where deltas are computed and emitted

- **Continuous (production):** the Flink job emits H3–H6 per-hop latencies as Flink
  custom metrics (a `latency` metric group) → MSF publishes them to CloudWatch. The
  003 Lambdas emit the triage sub-hops via **EMF** (Embedded Metric Format —
  structured log lines CloudWatch auto-extracts into metrics, no `PutMetricData`
  throttling, works from Lambda and Flink:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html).
- **On-demand (verify runs / local):** a small **latency-probe consumer** reads
  `geofence-alerts`, computes each hop delta + cumulative from the `trace` block plus
  `ApproximateArrivalTimestamp`, prints a breakdown table, and optionally emits the
  same EMF metrics. It extends the existing `tools/verify/reader.ts` (which already
  reads all shards and computes `ApproximateArrivalTimestamp − payload.timestamp`).

Metric namespace `Geofence/Latency`, one metric per hop
(`SourceToIoT`, `IoTToStream`, `StreamWait`, `FlinkProcess`, `FlinkToAlerts`,
`DetectionTotal`, `TriageBedrock`, `NotifyTotal`), dimensioned by stage; chart p50
and p99.

### B3.3 The accumulation widget

The headline widget is a **stacked** view (stacked area over time, or a stacked bar
of current p50/p99) where each band is one hop's contribution and the full height is
end-to-end latency — so the eye sees *where the time goes*:

```
 p99 latency (ms), stacked by hop
 │                                   ┌─ TriageBedrock (H7)  ← usually dominates
 │                              ╔═════╡
 │                         ╔════╣     │
 │              ┌──────────╢    ║─────┤─ FlinkToAlerts (H6)
 │     ┌────────┤ StreamWait(H3)║     │  FlinkProcess (H5)
 │ ┌───┤ IoTToStream (H2)       ║     │  IoTToStream (H2)
 │ ┤Src│                        ║     │  SourceToIoT (H1)
 └─┴───┴────────────────────────╨─────┴──────────────────▶ time
   └─── detection track (sub-5 s SLO) ───┘└ triage track (tens of s SLO) ┘
```

Two cumulative tracks, matching finding **L4**: a **detection** track (H1→H6, SLO
sub-5 s) and a **triage** track (H7, model-bound). Reading the bands tells you
immediately whether a latency regression is in the stream path (StreamWait climbing
⇒ backpressure, cross-check `millisBehindLatest`) or the model path (TriageBedrock
climbing ⇒ throttle/backoff).

## B4. Alarms (the streaming tripwires)

| Alarm | Metric | Why |
|---|---|---|
| Stream backing up | `GetRecords.IteratorAgeMilliseconds` (H3, H6) > threshold | approaching retention wall ⇒ data-loss risk (A3) |
| Write wall hit | `WriteProvisionedThroughputExceeded` > 0 (H3) | fires even on on-demand — burst past 2× peak or a hot key (SC1); the kept throughput signal |
| Flink falling behind | `millisBehindLatest` / `records_lag_max` rising | reactive scale signal (SC2) |
| Flink backpressured | `backPressuredTimeMsPerSecond` > 0 sustained | upstream of iterator-age growth (A3) |
| Checkpoint trouble | `numberOfFailedCheckpoints` > 0 / `lastCheckpointDuration` rising | exactly-once state at risk (R2) |
| Flink down | `downtime` > 0 | availability (A4) |
| IoT throttled / parse errors | `RuleExecutionThrottled`, `ParseError` > 0 | ingest loss (H1) |
| Queue/triage aging | SQS `ApproximateAgeOfOldestMessage` high; DLQ depth > 0 | triage stuck / poison (R1, R3) |
| Bedrock throttling | throttle count > 0 | needs backoff + inference profile (R5) |
| SLO breach | `Geofence/Latency` p99 (detection / triage) over budget | the latency promise itself |
| Hot-shard skew *(scale-time, not pilot)* | per-shard utilization (MAX over shards via `SEARCH`) > ~70% | leads `WriteProvisionedThroughputExceeded`; needs shard-level enhanced metrics; add only when per-vehicle load is uneven (SC1, B2.1) |

## B5. How this gets built (proposed tasks — NOT in this pass, no deploy)

Recorded for the work queue; each is Tier-1 verifiable (synth + unit) before any
deploy, consistent with the current hold:

1. **Enrich H2 rule SQL** with `timestamp() AS ingestTime` (small change to the 001
   IoT rule; gives source→IoT). Construct-test asserts the SELECT.
2. **Add the optional `trace` block** to the 002 breach-event schema (additive;
   document the seam). Unit-test the shape.
3. **Flink latency metrics** — emit H3–H6 deltas as a Flink custom metric group;
   fixture mini-run asserts metrics are produced.
4. **`tools/verify/latency-probe.ts`** — extend `reader.ts` to print the per-hop +
   cumulative breakdown and optionally emit EMF. Local, no deploy.
5. **CDK monitoring construct** — `CfnDashboard` (Layer 1 rows + the Layer 2 stacked
   widget) and the Part B4 alarms as `Alarm` constructs. Synth + assertion tests;
   deploy deferred to the authorized deploy window.
6. **003 EMF** for the triage sub-hops (analyzer/publisher Lambdas, AgentCore
   `bedrockLatency`).

These also close general-review finding **O1** (thin runtime observability) and give
AC2's "< 60 s rule latency" and the detection-latency target a continuously measured
home rather than a one-shot verify number.

---

## Appendix — sources

- Kinesis iterator-age semantics & recommended alarms:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html
- Kinesis on-demand scaling / per-shard limits:
  https://aws.amazon.com/blogs/aws/amazon-kinesis-data-streams-on-demand-stream-data-at-scale-without-managing-capacity/
- Managed Flink monitoring & metrics:
  https://docs.aws.amazon.com/managed-flink/latest/java/monitoring.html ,
  https://docs.aws.amazon.com/managed-flink/latest/java/metrics-dimensions.html
- IoT rule metrics & SQL:
  https://docs.aws.amazon.com/iot/latest/developerguide/metrics_dimensions.html ,
  https://docs.aws.amazon.com/iot/latest/developerguide/iot-rule-sql-version.html
- DynamoDB Streams + Lambda limits:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html
- CloudWatch Embedded Metric Format:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
