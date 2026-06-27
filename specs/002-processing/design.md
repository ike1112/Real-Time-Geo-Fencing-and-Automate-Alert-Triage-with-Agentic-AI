# Design 002 — Geofence Processing

Status: DRAFT (awaiting human approval)
Implements: spec.md (002-processing)
Stack: `ProcessingStack` (new), reads the `vehicle-telemetry` stream exported by `IngestionStack`.

---

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Processor | Amazon Managed Service for Apache Flink, **PyFlink (Python)** | Managed, scales, keeps exactly-once stream state; Python keeps the agentic codebase one language family and avoids a JVM build toolchain. |
| Zone store | Amazon DynamoDB table `geo-fences`, **DynamoDB Streams enabled** | Durable, low-latency rule store; the stream is the change-capture source for live updates. |
| Live rule propagation | **DynamoDB Streams -> Lambda bridge -> Kinesis `geofence-rules` stream**, consumed by Flink as a second source | PyFlink has no first-party DynamoDB-Streams connector (that connector is JVM-only); the bridge turns rule changes into a stream PyFlink can read. Serves H2. |
| Zone distribution in Flink | **Broadcast state** (`KeyedBroadcastProcessFunction`) | Detection tests every vehicle against every active zone, so all parallel subtasks need all polygons — that is exactly broadcast state, not keyed state. |
| Detection | Point-in-polygon (ray casting) against all active zones | Geometric containment; correct for concave polygons; no per-message zone lookup. |
| Output | Kinesis `geofence-alerts` stream, on-demand | Durable buffer the triage layer (003) reads; on-demand keeps idle cost low. |
| IaC | AWS CDK (TypeScript); Flink app code in Python | Managed Flink app + DynamoDB + Lambda + streams are stable CDK; the job artifact is a PyFlink zip. |

## Why this differs from the obvious single-zone design

- Detection tests **all active zones** per position (not a zone id carried on the
  message). That is the realistic model — a vehicle does not know which zones it is
  near; the processor decides. (This is why `001` carries `geoFenceId` only as
  context.)
- Zones are distributed as **broadcast state** so every parallel subtask can test
  any vehicle against any zone. Telemetry is keyed by `vehicleId` for per-vehicle
  transition state (entry/exit edge detection).
- The processor emits **factual** breach events and assigns **no reason code or
  severity** — that judgment is the AI layer's job (003). Ground-truth labels for
  the H1 eval come from the simulator's scenario metadata (001), joined in the eval
  harness, never from the processor.

## Components

### 1. Zone store — DynamoDB `geo-fences`
- Partition key `id` (string). DynamoDB Streams ON (new+old images).
- Record schema:
```jsonc
{
  "id": "zone-downtown-restricted",
  "active": true,
  "name": "Downtown Restricted Core",
  "description": "Restricted-access core",
  "polygon": [[51.050,-114.085],[51.050,-114.060],[51.040,-114.060],[51.040,-114.085],[51.050,-114.085]],
  "properties": { "type": "exclusion", "alertLevel": "high", "maxSpeed": 50 }, // type: exclusion | containment | dwell
  "createdAt": 1782000000000,
  "updatedAt": 1782000000000
}
```
- Seeded with the four Calgary zones from `001` (downtown-restricted exclusion,
  depot-foothills containment, airport-yyc exclusion, jobsite-north dwell).

### 2. Rule-change bridge — DynamoDB Streams -> Lambda -> Kinesis `geofence-rules`
- Lambda (Python) with a DynamoDB-Streams event-source-mapping on `geo-fences`.
- On INSERT/MODIFY/REMOVE it emits a compact rule-change record
  (`{op, id, active, kind, polygon, properties, updatedAt}`) to the
  `geofence-rules` Kinesis stream, partition key `id`.
- This is the seam that makes live updates possible without a JVM connector.

### 3. Stream processor — PyFlink on Managed Service for Apache Flink
- Source A: `vehicle-telemetry` (Kinesis), keyed by `vehicleId`.
- Source B: `geofence-rules` (Kinesis) -> a **broadcast** stream of the active
  polygon set.
- `KeyedBroadcastProcessFunction`:
  - on a rule-change element: update broadcast state (add/replace/remove the zone);
  - on a telemetry element: for each active zone, run point-in-polygon; compare to
    the vehicle's previous in/out state (keyed state) to detect an entry/exit edge;
    emit a breach event per zone whose semantics are violated.
- Bootstrap: on start, the bridge can replay current rules (the job reads
  `geofence-rules` from an early position) so the broadcast state is populated
  before processing; document the chosen init position.

### 4. Output — Kinesis `geofence-alerts`
- On-demand stream; partition key `vehicleId`. Breach event (factual):
```jsonc
{
  "vehicleId": "veh-014",
  "zoneId": "zone-downtown-restricted",
  "zoneName": "Downtown Restricted Core",
  "zoneKind": "exclusion",
  "breachType": "entry",               // entry | exit | dwell
  "timestamp": 1782458400000,
  "location": { "latitude": 51.0461, "longitude": -114.071, "accuracy": 3.2 },
  "distanceOutsideM": 142.0,           // 0 for exclusion entry; >0 for containment exit
  "durationInStateS": 35,
  "vehicle": { "speed": 46.5, "ignition": true, "fuelLevel": 0.75, "gear": "drive",
               "engineTemperature": 92.3, "brakeFluidLevel": 0.85, "doorOpen": false }
}
```
No severity, no reason code — facts only.

## Data flow

```
vehicle-telemetry (Kinesis, from 001) --keyed by vehicleId-->
geo-fences (DynamoDB) --Streams--> rules-bridge (Lambda) --> geofence-rules (Kinesis) --broadcast-->
PyFlink KeyedBroadcastProcessFunction (point-in-polygon vs all active zones, per-vehicle edge state)
   --> geofence-alerts (Kinesis) --> [increment 3 triage]
```

## Testing approach

- Unit (Python): point-in-polygon against a concave test polygon — inside,
  outside, on-edge, and near-edge-with-accuracy cases (AC3).
- Unit: entry/exit edge detection from a sequence of in/out states per vehicle.
- Construct tests (CDK assertions): `geo-fences` table has Streams enabled; the
  rules-bridge Lambda has the DynamoDB-Streams ESM; the Flink app + both stream
  sources exist; `geofence-alerts` is on-demand.
- Live (verify.md): drive a violator -> one breach event with correct type;
  edit/deactivate a zone -> behavior changes within 60 s (AC2/H2).

## Risks / follow-ups

- Broadcast-state bootstrap race: telemetry processed before rules load would miss
  breaches. Mitigation: replay rules from an early stream position and/or hold
  telemetry until first rule load; verify in the live run.
- Dwell flapping at the boundary under jitter (OQ-1) — may need a debounce.
- `geofence-rules` is an internal seam; document it so 003 does not depend on it.
