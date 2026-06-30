# Verify 002 — Geofence Processing (runbook)

Concrete, runnable steps proving telemetry on `vehicle-telemetry` is evaluated
against live-editable zones, factual breaches land on `geofence-alerts`, a rule
edit takes effect in under 60 s (H2), and an in-zone vehicle produces no breaches.
This is the acceptance script for the live run (the deferred deploy task).

> Local checks (Step 4) run today with no AWS. The deploy + live steps (1–3, 5–6)
> run when the deploy hold is lifted, and have the two prerequisites below.

## Prerequisites for the live run

1. **Complete the job's connector wiring.** `processor/geofence/job.py` `main()` is a
   documented stub (`NotImplementedError`) — the Kinesis source/sink construction is
   deferred. Before a live run it must create the `vehicle-telemetry` + `geofence-rules`
   sources and the `geofence-alerts` sink and call `build_pipeline(...)` then
   `env.execute(...)`. (The decision logic it feeds — `evaluate_position` — is already
   complete and tested.)
2. **Bundle the connector jar.** Place the Flink Kinesis connector jar at
   `processor/lib/flink-sql-connector-kinesis.jar` so the CDK asset zips it in
   (the app's `kinesis.analytics.flink.run.options` already points `jarfile` there).
3. Tools: AWS CLI v2, `jq`, `base64`, Node, Python (pytest). AWS creds for a dev
   account in the shell.

```bash
REGION=us-east-1
TABLE=geo-fences
ALERTS=geofence-alerts
APP=geofence-processor          # the Managed Flink application name
```

## Deploy and start

```bash
npx cdk deploy IngestionStack ProcessingStack   # creates streams, table+seed, bridge, Flink app
aws kinesisanalyticsv2 start-application --application-name "$APP" --region "$REGION"
```
The seed custom resource populates the four zones on deploy; the app is created in
`READY` and must be started (above) to reach `RUNNING`.

## Step 1 — processor running, infra wired

```bash
aws kinesisanalyticsv2 describe-application --application-name "$APP" --region "$REGION" \
  --query 'ApplicationDetail.ApplicationStatus' --output text
```
Expected: `RUNNING`.
```bash
aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" \
  --query 'Table.{Stream:StreamSpecification.StreamEnabled,Status:TableStatus}'
```
Expected: `{ "Stream": true, "Status": "ACTIVE" }`.

## Step 2 — zones seeded (the seed custom resource)

```bash
aws dynamodb scan --table-name "$TABLE" --region "$REGION" --query 'Count'
aws dynamodb scan --table-name "$TABLE" --region "$REGION" \
  --query 'Items[].{id:id.S,active:active.BOOL,type:properties.M.type.S}'
```
Expected: `Count = 4`; ids `zone-downtown-restricted`, `zone-depot-foothills`,
`zone-airport-yyc`, `zone-jobsite-north`, all `active: true`, types
`exclusion / containment / exclusion / dwell`.

## Step 3 — a breach produces a FACTUAL event (AC1)

Drive the fleet. No scenario flag is needed: vehicles round-robin onto the Calgary
routes, and Memorial Drive ends inside the downtown exclusion zone while Deerfoot
Trail passes through the airport exclusion zone — both yield natural entry breaches.
```bash
npm run sim -- --vehicles 10 --duration 120 &      # publishes to iot_data every ~5s
```
Read `geofence-alerts` and assert a breach is correct AND factual-only:
```bash
ITER=$(aws kinesis get-shard-iterator --stream-name "$ALERTS" \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST \
  --region "$REGION" --query ShardIterator --output text)
sleep 20
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[].Data' --output text | tr '\t' '\n' | while read -r d; do
    echo "$d" | base64 -d
  done | jq -e -s '
    map(select(.zoneKind=="exclusion" and .breachType=="entry"
               and (.location | has("latitude") and has("longitude") and has("accuracy"))
               and has("distanceOutsideM") and has("durationInStateS")
               and (.vehicle | has("speed"))
               and ((has("severity") or has("reason") or has("violation_name")) | not)))
    | length >= 1
  ' >/dev/null && echo "BREACH: PASS (exclusion/entry, factual-only)" || echo "BREACH: FAIL"
```
Expected: `BREACH: PASS` — correct kind/type, factual fields present, and **no**
severity/reason field (that judgment belongs to the triage layer).

## Step 4 — point-in-polygon + detection correctness (AC3, local, no AWS)

```bash
python -m pytest processor/geofence/ -q
```
Expected: all pass — point-in-polygon (inside / outside / on-edge / near-edge against
the concave test polygon), entry/exit edge detection, and the detector mini-run
(one correctly-typed breach per crossing; no false breach when staying put).

## Step 5 — LIVE RULE UPDATE < 60 s (AC2 / H2 — the lead number)

Add a new exclusion zone over Glenmore Trail (lat 51.000), which currently has no
zone but carries simulator vehicles, and time the first breach that reflects it.
```bash
T0=$(date +%s)
aws dynamodb put-item --table-name "$TABLE" --region "$REGION" --item '{
  "id": {"S": "zone-live-test"}, "active": {"BOOL": true},
  "name": {"S": "Live Update Test"}, "description": {"S": "temporary"},
  "polygon": {"L": [
    {"L": [{"N": "51.002"}, {"N": "-114.060"}]}, {"L": [{"N": "51.002"}, {"N": "-114.040"}]},
    {"L": [{"N": "50.998"}, {"N": "-114.040"}]}, {"L": [{"N": "50.998"}, {"N": "-114.060"}]},
    {"L": [{"N": "51.002"}, {"N": "-114.060"}]} ]},
  "properties": {"M": {"type": {"S": "exclusion"}, "alertLevel": {"S": "high"}}},
  "createdAt": {"N": "1782000000000"}, "updatedAt": {"N": "1782000000000"}
}'
# Poll geofence-alerts for the first breach carrying zone-live-test; record its epoch as T1.
ITER=$(aws kinesis get-shard-iterator --stream-name "$ALERTS" --shard-id shardId-000000000000 \
  --shard-iterator-type LATEST --region "$REGION" --query ShardIterator --output text)
while :; do
  OUT=$(aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" --query '{d:Records[].Data,n:NextShardIterator}' --output json)
  ITER=$(echo "$OUT" | jq -r '.n')
  if echo "$OUT" | jq -r '.d[]?' | while read -r d; do echo "$d" | base64 -d; done | jq -e 'select(.zoneId=="zone-live-test")' >/dev/null 2>&1; then
    T1=$(date +%s); break
  fi
  sleep 2
done
echo "rule-update latency = $((T1 - T0)) s"
```
Expected: `< 60`. Then remove the test zone:
```bash
aws dynamodb delete-item --table-name "$TABLE" --region "$REGION" --key '{"id":{"S":"zone-live-test"}}'
```

## Step 6 — in-zone vehicle, no false breaches (AC4)

Read `geofence-alerts` over a 120 s window while the fleet runs and confirm a vehicle
that stays in its allowed area (e.g. a Glenmore-only vehicle, no active zone there
after Step 5's cleanup) produces zero breaches — GPS jitter at the configured accuracy
does not trip one.
```bash
# Count breach events per vehicleId over the window; the in-allowed-area vehicle = 0.
aws kinesis get-records --shard-iterator "$ITER" --region "$REGION" \
  --query 'Records[].Data' --output text | tr '\t' '\n' | while read -r d; do echo "$d" | base64 -d; done \
  | jq -r '.vehicleId' | sort | uniq -c
```
Expected: the Glenmore-only vehicleId does not appear (0 breaches).

## Result block (paste in the handoff)

```
PROCESSING VERIFY (deploy YYYY-MM-DD, region us-east-1)
  flink app:              RUNNING; sources vehicle-telemetry + geofence-rules connected
  zones seeded:           4 active
  breach correctness:     PASS (exclusion / entry / factual-only)         (AC1)
  point-in-polygon:       pytest PASS                                     (AC3)
  rule-update latency:    __ s   (AC2/H2 < 60 s: PASS/FAIL)
  in-zone false breaches: __     (AC4: 0 expected)
```
Numbers are recorded from the real run. The verifier re-runs Step 4 today and Steps
1–3, 5–6 once deployed, and rejects if any bound is missed.
