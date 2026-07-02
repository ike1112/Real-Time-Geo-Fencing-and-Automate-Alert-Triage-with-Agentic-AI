# Verify 004 — Pipeline Observability & Latency Accumulation (runbook)

Concrete, runnable steps proving each hop reports health on one dashboard (AC1), a
breach carries the additive `trace` block (AC2), the offline probe prints the per-hop
+ cumulative latency (AC3), the streaming tripwire alarms exist and fire (AC4), and
the custom latency metrics resolve under `Geofence/Latency` (AC5).

> Local checks (Step 1) run today with no AWS. The deploy + live steps (2–5) run when
> the deploy hold is lifted.

## Prerequisites for the live run

- 001 + 002 + 003 deployed and running, plus `ObservabilityStack`. The `002` live run
  prerequisites (Flink connector wiring + jar) apply, since the `trace` stamps and the
  Flink latency metrics are produced by the running job.
- Tools: AWS CLI v2, `jq`, Node (`ts-node`), Python. AWS creds for a dev account.

```bash
REGION=us-east-1
ALERTS=geofence-alerts
```

## Step 1 — latency arithmetic, trace block, EMF shape, Flink stamps (local, no AWS)

```bash
npx jest test/latency-probe.test.ts test/observability-stack.test.ts   # probe math + dashboard/alarms
python -m pytest processor/geofence/test_latency.py observability/ -q   # Flink stamps + triage EMF shape
```
Expected: all pass — per-hop deltas are consecutive-stamp differences, the breach
`trace` block carries `eventTime`/`ingestTime` (Flink adds `flinkRead`/`flinkEmit`),
the dashboard has a row per hop + the stacked widget with a SEARCH iterator-age, every
alarm is present, and the EMF document resolves the `Geofence/Latency` namespace.

## Deploy

```bash
npx cdk deploy ObservabilityStack        # dashboard + alarms (references the other stacks' metrics)
```

## Step 2 — the dashboard exists with a row per hop + the stacked widget (AC1)

```bash
aws cloudwatch get-dashboard --dashboard-name geofence-pipeline --region "$REGION" \
  --query 'DashboardBody' --output text | jq '[.widgets[].properties.title]'
```
Expected: titles for H1 IoT, H3 telemetry stream, H4/H5 Flink, H6 alerts stream,
H7 triage, and the stacked "Latency accumulation" widget.

## Step 3 — drive traffic; the offline probe prints the breakdown (AC3, live read)

```bash
npm run sim -- --vehicles 10 --duration 120 &
ALERTS_STREAM=$ALERTS npx ts-node tools/verify/latency-probe.ts 90 --emf
```
Expected: a per-hop mean latency table (`SourceToIoT`, `IngestToFlink`, `FlinkProcess`,
`FlinkToAlerts`) and the detection-track total (t0→alerts). With `--emf`, EMF lines are
printed under `Geofence/Latency`.

## Step 4 — custom latency metrics resolve under Geofence/Latency (AC5)

```bash
aws cloudwatch list-metrics --namespace Geofence/Latency --region "$REGION" \
  --query 'Metrics[].{name:MetricName,dims:Dimensions[0].Value}'
```
Expected: `FlinkProcess`/`DetectionTotal` (detection) from the Flink job's metric group,
and `TriageBedrock`/`NotifyTotal` (analyzer/publisher) from the triage EMF.

## Step 5 — an induced lag/backpressure trips its alarm (AC4)

Stop the Flink app (or pause the analyzer bridge) while the simulator runs, so the
consumer falls behind, and confirm the iterator-age / `millisBehindLatest` alarm goes
`ALARM`:
```bash
aws cloudwatch describe-alarms --alarm-name-prefix geofence- --region "$REGION" \
  --query 'MetricAlarms[?StateValue==`ALARM`].AlarmName'
```
Expected: `geofence-AlertsIteratorAge` (or `geofence-FlinkMillisBehindLatest`) is in
ALARM. Restart the consumer; confirm it returns to OK. Confirm the detection and triage
tracks appear as separate series on the stacked widget (L4).

## Teardown

```bash
npx cdk destroy ObservabilityStack
```

## Result block (paste in the handoff)

```
OBSERVABILITY VERIFY (deploy YYYY-MM-DD, region us-east-1)
  dashboard:        1 dashboard, rows H1..H7 + stacked latency widget            (AC1)
  trace block:      breach carries eventTime/ingestTime/flinkRead/flinkEmit      (AC2)
  probe breakdown:  per-hop means + detection total printed                      (AC3)
  latency metrics:  Geofence/Latency resolves FlinkProcess/DetectionTotal/...    (AC5)
  alarms:           induced lag -> ALARM, recovers to OK                         (AC4)
  tracks separated: detection vs triage distinct on the stacked widget           (L4)
```
Numbers are recorded from the real run. The verifier re-runs Step 1 today and Steps
2–5 once deployed, and rejects if any bound is missed.
