# Verify 001 — Telemetry Ingestion (runbook)

Concrete, runnable steps that prove messages flow
`simulator -> iot_data -> vehicle-telemetry`, with every field, within 5 s, in
per-vehicle order, with no drops. Each step states the command and the expected
result. This is the acceptance script for T6.

## Prerequisites

- `cdk deploy` has run (stream + topic rule + role are live).
- AWS credentials with: `iot-data:Publish` on `iot_data` (simulator),
  `kinesis:DescribeStreamSummary` / `ListShards` / `GetShardIterator` /
  `GetRecords` on `vehicle-telemetry` (reader), `iot:ListTopicRules`.
- Tools on PATH: AWS CLI v2, `jq`, Node.

```bash
REGION=us-east-1          # adjust to the deploy region
STREAM=vehicle-telemetry
```

## Step 1 — infra exists and is on-demand

```bash
aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" \
  --query 'StreamDescriptionSummary.{Mode:StreamModeDetails.StreamMode,Status:StreamStatus,Shards:OpenShardCount}'
```
Expected:
```json
{ "Mode": "ON_DEMAND", "Status": "ACTIVE", "Shards": 4 }
```
And the rule is enabled and targets the stream:
```bash
aws iot list-topic-rules --region "$REGION" \
  --query "rules[?contains(ruleName, 'VehicleTelemetry')].{name:ruleName,disabled:ruleDisabled}"
```
Expected: one rule, `disabled: false`.

## Step 2 — data is actually published to the topic `iot_data`

In the IoT console -> **MQTT test client** -> Subscribe to `iot_data`. Then start
the simulator:
```bash
npm run sim -- --vehicles 10
```
Expected in the test client: JSON messages arriving at roughly **2 per second**
(10 vehicles x 1 per 5 s), each beginning
`{"vehicleId":"veh-...","geoFenceId":"zone-...", ...}`. Seeing them here proves
publish -> topic; the rule forwards them to Kinesis next.

## Step 3 — records land in Kinesis with EVERY field present

Grab a fresh record and look at it:
```bash
ITER=$(aws kinesis get-shard-iterator --stream-name "$STREAM" \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST \
  --region "$REGION" --query ShardIterator --output text)

# wait ~5s for new records, then read and decode one:
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[0].Data' --output text | base64 -d | jq .
```
Then assert the full field set (uses `has()` so legitimately `false`/`0` values
still count as present):
```bash
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[0].Data' --output text | base64 -d | jq -e '
    has("vehicleId") and has("geoFenceId") and has("timestamp") and
    (.location   | has("latitude") and has("longitude") and has("accuracy")) and
    (.vss        | has("vehicle.speed") and has("vehicle.ignition") and has("vehicle.transmission.gear")) and
    (.telemetry  | has("engineRpm") and (.accelerometerData | has("x"))) and
    (.deviceInfo | has("deviceId")) and
    (.routeInfo  | has("routeName"))
  ' >/dev/null && echo "FIELDS: PASS" || echo "FIELDS: FAIL"
```
Expected: `FIELDS: PASS`.

## Step 4 — latency under 5 s (the "in 5 s")

Per record, produce->stream latency =
`ApproximateArrivalTimestamp - (payload.timestamp / 1000)`
(`ApproximateArrivalTimestamp` = when Kinesis received it; `payload.timestamp` =
epoch ms when the simulator produced it).

The reader (`tools/verify/reader.ts`) reads **all shards** for 60 s and prints:
```
records:        120
max latency s:  1.8     <- AC1 requires < 5.0
p50 latency s:  0.9
```
Expected: `max latency s` < 5.0.

By-hand spot check on one record:
```bash
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[0].{arr:ApproximateArrivalTimestamp,data:Data}' --output json \
| jq -r '"\(.arr) \(.data)"' \
| { read arr data; ts=$(echo "$data" | base64 -d | jq .timestamp); \
    echo "latency_s = $arr - $ts/1000"; }
```

## Step 5 — per-vehicle ordering (0 out-of-order)

The reader groups records by `vehicleId` and checks `payload.timestamp` is
non-decreasing in read order (across all shards). Prints:
```
vehicles:           10
out-of-order events: 0    <- AC3 requires 0
```
Expected: `0`.

## Step 6 — no drops / no duplicates over 5 minutes (AC2)

Run the simulator 5 minutes; it stamps a per-vehicle monotonic `seq` in the
payload (or report counts from its own publish log). The reader counts received
records per `vehicleId` and compares to published:
```
window:      300 s
published:   600   (10 vehicles x 60)
received:    600
duplicates:  0
drops:       0
```
Expected: `received == published`, `duplicates: 0`, `drops: 0`.

## Result block to paste in the verifier handoff

```
INGESTION VERIFY (deploy YYYY-MM-DD, region us-east-1)
  stream:        ON_DEMAND / ACTIVE / 4 shards
  topic:         iot_data messages observed ~2/s
  fields:        PASS (schema-complete: contract + vss + telemetry + device + route)
  max latency:   1.8 s    (AC1 < 5 s: PASS)
  out-of-order:  0         (AC3: PASS)
  5-min soak:    600 published / 600 received / 0 dup / 0 drop  (AC2: PASS)
  AC4:           cdk deploy + cdk destroy clean: PASS
```

The numbers above are illustrative of a passing run; the real run pastes its own
measured values. The verifier re-runs Steps 1, 3, 4, 5 itself and rejects if any
number misses its bound or any field is absent.
