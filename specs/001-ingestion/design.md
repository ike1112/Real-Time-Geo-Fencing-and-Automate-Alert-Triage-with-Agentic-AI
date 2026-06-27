# Design 001 — Telemetry Ingestion

Status: DRAFT (awaiting human approval)
Implements: spec.md (001-ingestion)
Stack: `IngestionStack` (new), composed into the app alongside the existing root stack.

---

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Ingress | AWS IoT Core (MQTT), single topic `iot_data` | Built for many concurrent device-style producers; pay-per-message, zero idle cost; native rule routing to a stream with no glue code in the hot path. |
| Durable stream | Amazon Kinesis Data Stream `vehicle-telemetry`, on-demand mode | Per-partition-key ordering (satisfies FR4); durable replayable log for increment 2; on-demand avoids provisioned-shard cost (a small per-stream-hour charge remains). |
| Producer -> stream | IoT Topic Rule with a Kinesis action | Declarative routing; partition key taken from the message body so per-vehicle ordering holds; no Lambda between IoT and Kinesis. |
| Per-vehicle ordering | Kinesis partition key = `${vehicleId}` | Hash of the key pins each vehicle to one shard, preserving produce order for that vehicle (see "Partition key & ordering"). |
| Simulator | Standalone TypeScript script calling the IoT Data Plane `Publish` API (`iot-data:Publish`) with local AWS credentials | Matches how a real producer publishes; no device certificates to manage; runs from a dev machine or CI. |
| IaC | AWS CDK (TypeScript), L1 `CfnTopicRule` + L2 `Stream`/`Role` | IoT topic rules have no stable L2 yet; everything else is stable L2. |

## Partition key & ordering (the load-bearing decision)

A Kinesis stream is a set of shards; each shard is an independently ordered log
with its own throughput. On every write the producer supplies a partition key,
which Kinesis hashes (MD5 -> 128-bit) to choose a shard. Two consequences we
depend on:

- **Per-vehicle order:** keying by `vehicleId` lands all of a vehicle's messages
  on the same shard, so a consumer reads them in produce order. Increment 2's
  per-vehicle crossing detection requires this — out-of-order positions would
  produce phantom crossings.
- **Parallelism:** distinct vehicleIds spread across shards, so shards are
  consumed in parallel (parallelism is bounded by shard count). A single shard
  carries many vehicleIds; we rely only on "same vehicle -> same shard", and the
  processor keys its own state by `vehicleId` regardless of shard placement.

On-demand mode means Kinesis manages shard count automatically; we do not size
shards, we rely on the partition-key contract for ordering.

## Components

### 1. Kinesis telemetry stream
- `aws-cdk-lib/aws-kinesis` `Stream`, name `vehicle-telemetry`,
  `streamMode: StreamMode.ON_DEMAND`.
- Export stream name + ARN for increment 2.
- Retention: default 24h (sufficient for development replay; revisit if
  increment 2 needs longer).
- Follow-up (not this increment): production spike absorption via account-level
  on-demand billing optimization + per-stream warm throughput. Largely an
  account/operational setting; CloudFormation/CDK support for warm throughput must
  be verified before claiming it as IaC.

### 2. IoT ingress + routing
- Single MQTT topic: `iot_data` (all vehicles publish here).
- `CfnTopicRule` with SQL `SELECT * FROM 'iot_data'`.
- Rule action: `kinesis` with
  - `streamName` = `vehicle-telemetry`,
  - `partitionKey` = `${vehicleId}` (substitution from the message body),
  - `roleArn` = the rule role below.
- Error action is deferred (increment hardening) — recorded as a follow-up task,
  not silently skipped.

### 3. IAM role for the rule
- `aws-cdk-lib/aws-iam` `Role`, assumed by `iot.amazonaws.com`.
- Granted `kinesis:PutRecord` / `PutRecords` on the `vehicle-telemetry` ARN only
  (least privilege via the stream grant helper).

### 4. Telemetry simulator (`tools/simulator/`)
- TypeScript script, not infrastructure. Publishes with
  `@aws-sdk/client-iot-data-plane` `PublishCommand` to topic `iot_data` using
  local AWS credentials (IAM), so no certificates are managed.
- Inputs: a route file per vehicle (ordered `[lat, lon]` waypoints) and a cadence.
- Per tick, for each vehicle the simulator: advances position along the current
  route segment (interpolated by elapsed time x speed); derives `heading` from
  the bearing to the next waypoint and `speed` from the segment; rolls the full
  signal set (engine/fuel/temperature/etc.) within realistic ranges; applies the
  scenario overlay; composes the payload below; and publishes it.
- Scenario overlay (resolves RQ-B): a configurable fraction of "violator"
  vehicles whose routes breach a zone, plus bounded Gaussian GPS jitter sized by
  `accuracy`, so the stream carries a reproducible, labelled mix of genuine
  breaches and borderline false positives.

#### Cadence (configurable, state-varying)
Cadence is configurable and varies by vehicle state for realism — moving
vehicles report faster (~1-2 s), idling/parked slower (~30 s+), with a default of
~5 s. The 5 s default balances crossing-detection precision and alert latency
against message volume and per-alert triage cost; it is a tunable, not a fixed
requirement, and the production value is pinned once the cost envelope is known.

### Geography & zones (pilot): Calgary, Alberta
Geography is data, not code: route files and zone polygons live beside the
simulator, so the pilot region and zone set change without touching the pipeline.

Multiple zones of mixed type are defined so the pipeline exercises real
situations (the per-zone *detection semantics* — entry vs exit vs dwell — are
specified in increment 2; this increment just drives vehicles against them and
tags each message with the vehicle's assigned zone):

| Zone id | Area (approx) | Type | Real situation it creates |
|---|---|---|---|
| `zone-downtown-restricted` | Downtown core (~51.045 N, -114.072 W) | Exclusion (alert on entry) | Restricted-access core; jitter on vehicles skirting the edge makes the false positives H1 must suppress. |
| `zone-depot-foothills` | Foothills Industrial SE (~51.02 N, -114.00 W) | Containment (alert on exit) | A vehicle leaving the yard after hours = possible theft (genuine HIGH). |
| `zone-airport-yyc` | YYC airside (~51.13 N, -114.01 W) | Exclusion (alert on entry) | No-go area; an entry is a genuine high-severity breach. |
| `zone-jobsite-north` | North job site (~51.16 N, -114.07 W) | Dwell (arrival/departure) | Expected arrivals/departures = mostly benign, tests over-alerting. |

Routes trace real Calgary roads — Deerfoot Trail (Hwy 2), Crowchild Trail,
Glenmore Trail, Stoney Trail (ring road), Memorial Drive, 16 Ave N
(Trans-Canada Hwy 1), and surface streets in Downtown/Beltline, Kensington, and
Inglewood — so vehicles pass near and through these zones naturally.

## Event payload (resolves RQ-A)

Full realistic connected-vehicle payload; the `vehicle.*` keys follow the COVESA
Vehicle Signal Specification (VSS). Example localized to Calgary:

```jsonc
{
  "vehicleId": "veh-014",            // REQUIRED — stable id, also the partition key
  "geoFenceId": "zone-downtown-restricted", // assigned/expected zone (context; see note)
  "timestamp": 1782458400000,        // REQUIRED — epoch milliseconds, event time
  "location": {
    "latitude": 51.0447,             // REQUIRED
    "longitude": -114.0719,          // REQUIRED
    "altitude": 1045.0,              // Calgary elevation ~1045 m
    "heading": 270.5,                // direction of travel
    "speed": 65.3,
    "accuracy": 3.2                  // GPS accuracy; central to the false-positive story
  },
  "vss": {
    "vehicle.speed": 65.3,
    "vehicle.ignition": true,
    "vehicle.fuel.level": 0.75,
    "vehicle.odometer": 34567.8,
    "vehicle.transmission.gear": "drive",
    "vehicle.chassis.axle.row1.wheel.left.brake.fluidLevel": 0.85,
    "vehicle.cabin.door.row1.left.isOpen": false,
    "vehicle.powertrain.engine.temperature": 92.3
  },
  "telemetry": {
    "engineRpm": 2500,
    "batteryVoltage": 12.7,
    "outsideTemperature": -8.5,      // Calgary winter
    "accelerometerData": { "x": 0.02, "y": -0.01, "z": 0.98 }
  },
  "deviceInfo": { "deviceId": "tracker-7823fa", "firmwareVersion": "2.3.5", "signalStrength": 87 },
  "routeInfo": { "routeType": "highway", "routeName": "Deerfoot Trail" }
}
```

Contract note: only the REQUIRED fields are what ingestion routes and orders on.
`geoFenceId` is the vehicle's assigned/expected zone, carried as context —
increment 2 decides whether detection looks up this declared zone or tests the
reported position against all managed zones (the realistic, multi-zone direction
is the latter). The `vss` / `telemetry` / `deviceInfo` / `routeInfo` blocks are
the full realistic signal set; the simulator emits them so increment 3's triage
has genuine context (speed, ignition, door state, accelerometer, signal strength)
to judge severity.

## Data flow

```
simulator (iot-data:Publish, local IAM creds)
   -> AWS IoT Core   topic: iot_data
   -> IoT Topic Rule (SELECT * FROM 'iot_data', partitionKey = ${vehicleId})
   -> Kinesis Data Stream "vehicle-telemetry" (on-demand, ordered per vehicleId)
   -> [increment 2 consumer]
```

## Testing approach

- Construct tests (`aws-cdk-lib/assertions` `Template`): stream is on-demand;
  exactly one `AWS::IoT::TopicRule` whose Kinesis action targets
  `vehicle-telemetry` with `PartitionKey` = `${vehicleId}`; the rule role's policy
  is scoped to the stream ARN and the IoT service principal.
- Integration check (manual for the slice, scripted later): run the simulator for
  one vehicle, tail the stream with a small consumer, confirm AC1/AC3.

## Targets (from spec non-functionals)

- ~2 messages/s aggregate at the 5 s baseline (more under faster cadence) — a
  single on-demand stream absorbs this with large headroom.
- Ingestion latency budget < 5s; the IoT-rule-to-Kinesis path is typically
  sub-second, leaving margin.

## Risks / follow-ups (record, don't skip)

- No rule error action in the first pass — a malformed message is dropped
  silently. Follow-up task to add a dead-letter/error action before increment 3.
- Simulator depends on local IAM credentials with `iot-data:Publish` on the
  `iot_data` topic; document the minimal policy needed.
- Warm-throughput / on-demand billing optimization CFN support is unverified;
  treat as an operational follow-up, not part of this increment's IaC.
- Multi-zone detection model (declared-zone lookup vs all-zone test) is an
  increment-2 decision; this increment only tags messages and drives vehicles
  against the zone set.
