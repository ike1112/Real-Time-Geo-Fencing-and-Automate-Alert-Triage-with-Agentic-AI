# Verify 002 — Geofence Processing (runbook)

Concrete, runnable steps proving telemetry on `vehicle-telemetry` is evaluated
against live-editable zones, factual breaches land on `geofence-alerts`, a rule
edit takes effect in under 60 s (H2), and an in-zone vehicle produces no breaches.
This is the acceptance script for T9.

## Prerequisites

- `001` + `002` deployed (`cdk deploy`). Streams `vehicle-telemetry`,
  `geofence-rules`, `geofence-alerts`; table `geo-fences` (Streams ON); the Flink
  app reached RUNNING.
- The `001` simulator is runnable. Tools: AWS CLI v2, `jq`, Node, Python (pytest).

```bash
REGION=us-east-1
TABLE=geo-fences
ALERTS=geofence-alerts
APP=geofence-processor      # the Managed Flink application name
```

## Step 1 — processor running, infra wired

```bash
aws kinesisanalyticsv2 describe-application --application-name "$APP" --region "$REGION" \
  --query 'ApplicationDetail.ApplicationStatus'
```
Expected: `"RUNNING"`.
```bash
aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" \
  --query 'Table.{Stream:StreamSpecification.StreamEnabled,Status:TableStatus}'
```
Expected: `{ "Stream": true, "Status": "ACTIVE" }`.

## Step 2 — zones seeded

```bash
aws dynamodb scan --table-name "$TABLE" --region "$REGION" --query 'Count'
aws dynamodb scan --table-name "$TABLE" --region "$REGION" \
  --query 'Items[].{id:id.S,active:active.BOOL,type:properties.M.type.S}'
```
Expected: `Count = 4`; ids `zone-downtown-restricted`, `zone-depot-foothills`,
`zone-airport-yyc`, `zone-jobsite-north`, all `active: true`, with their types.

## Step 3 — a breach produces a FACTUAL event (AC1)

Drive a violator entering the airport exclusion zone:
```bash
npm run sim -- --vehicles 10 --scenario airport-intrusion
```
Read `geofence-alerts` and assert the breach is correct AND factual-only:
```bash
ITER=$(aws kinesis get-shard-iterator --stream-name "$ALERTS" \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST \
  --region "$REGION" --query ShardIterator --output text)
# wait ~5s, then:
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[0].Data' --output text | base64 -d | jq -e '
    .vehicleId and .zoneId=="zone-airport-yyc" and .breachType=="entry" and
    (.location | has("latitude") and has("longitude") and has("accuracy")) and
    has("distanceOutsideM") and has("durationInStateS") and (.vehicle | has("speed")) and
    ((has("severity") or has("violation_name") or has("violation_id")) | not)
  ' >/dev/null && echo "BREACH: PASS (correct + factual-only)" || echo "BREACH: FAIL"
```
Expected: `BREACH: PASS` — correct zone/type, factual fields present, and **no**
severity/reason field (that judgment belongs to 003).

## Step 4 — point-in-polygon correctness (AC3, local)

```bash
pytest tests/test_geometry.py -q
```
Expected: all pass — inside / outside / on-edge / near-edge against the concave
test polygon, and entry/exit edge detection from an in/out sequence.

## Step 5 — LIVE RULE UPDATE < 60 s (AC2 / H2 — the lead number)

Add a new exclusion zone over a road a vehicle is currently driving, timestamped:
```bash
T0=$(date +%s)
aws dynamodb put-item --table-name "$TABLE" --region "$REGION" \
  --item file://eval/zone-live-test.json     # active=true exclusion over the vehicle's road
```
Watch `geofence-alerts` for the first breach carrying the new zone, record its
arrival epoch as T1 (the reader `tools/verify/rule_latency.ts` automates this:
put-item, watch, print the delta):
```bash
# T1 = arrival epoch of the first breach with zoneId == "zone-live-test"
echo "rule-update latency = $((T1 - T0)) s"
```
Expected: `< 60`. Then remove the test zone:
```bash
aws dynamodb delete-item --table-name "$TABLE" --region "$REGION" \
  --key '{"id":{"S":"zone-live-test"}}'
```

## Step 6 — in-zone vehicle, no false breaches (AC4)

```bash
npm run sim -- --vehicles 1 --scenario inside-only --duration 120
```
Expected: the reader counts **0** breach events for that vehicleId over the
window (jitter at the configured accuracy does not trip a breach).

## Result block (paste in the handoff)

```
PROCESSING VERIFY (deploy YYYY-MM-DD, region us-east-1)
  flink app:           RUNNING; sources vehicle-telemetry + geofence-rules connected
  zones seeded:        4 active
  breach correctness:  PASS (zone-airport-yyc / entry / factual-only)   (AC1)
  point-in-polygon:    pytest PASS                                      (AC3)
  rule-update latency: 38 s    (AC2/H2 < 60 s: PASS)
  in-zone false breaches: 0    (AC4: PASS)
```
Numbers are illustrative of a passing run; the real run records its own. The
verifier re-runs Steps 1, 3, 5, 6 itself and rejects if any bound is missed.
