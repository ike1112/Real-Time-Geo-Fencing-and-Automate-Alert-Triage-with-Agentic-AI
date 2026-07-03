# Deployment & Testing Guide

End-to-end guide to deploy the four stacks to an AWS account, test each one, and tear
everything down. This reflects a **real dev-account deploy** (2026-07-03) and folds in
every fix and gotcha found there — see `docs/live-deploy-findings.md` for the raw log.

All nine code bugs found during that deploy are fixed in this repo, so a redeploy will
**not** hit them again. Three things are still on *you*, not the code:

1. **Fetch the Flink connector jar** — git-ignored (64 MB). Run `npm run fetch:connector`.
2. **Enable Bedrock model access** for the account (console) — the analyzer needs it.
3. The **Managed Flink Kinesis source under-read** is a known open issue (see §7).

---

## 1. Prerequisites

| Need | For | Notes |
|------|-----|-------|
| AWS credentials (dev/sandbox) + region | all | `aws sts get-caller-identity`; `export AWS_REGION=us-east-1` |
| `npm install` | all | Node 18+ |
| `npx cdk bootstrap` | all | once per account/region |
| **Docker Desktop running, ARM64 buildx** | 003 | the two AgentCore agent images are `linux/arm64` |
| **Flink connector jar** | 002 | `npm run fetch:connector` (downloads to `processor/lib/`) |
| **Bedrock model access enabled** | 003 | see §2 — without it the analyzer returns AccessDenied |
| Python 3.12 + `pytest` | tests | Tier-1 test suite |

---

## 2. One-time account setup: enable Bedrock model access

**Required for 003.** The analyzer/publisher call Claude via Bedrock; a fresh account has
no model access and the runtime returns
`AccessDeniedException … aws-marketplace:ViewSubscriptions/Subscribe … Model access is denied`.

1. AWS console → **Amazon Bedrock** → **Model access** (in the deploy region).
2. Enable the **Anthropic** models you configured:
   - dev/CI: **Claude Haiku 4.5** (`us.anthropic.claude-haiku-4-5-20251001-v1:0`)
   - demo: **Claude Opus** (whatever id you pass as `publisherModelId`/`analyzerModelId`)
3. Wait until status is **Access granted** (usually instant for Anthropic).

The runtime roles already carry the `aws-marketplace` perms; this console grant is the
account-level half.

---

## 3. Deploy

Deploy in dependency order. The stacks cross-reference by CloudFormation export
(Processing→Ingestion, Alerting→Processing), so order matters.

```bash
# 0. one-time
npm ci
npm run fetch:connector          # Flink connector jar -> processor/lib/
npx cdk bootstrap                # once per account/region

# 1. ingestion + processing (streams, table+seed, rules bridge, Flink app)
npx cdk deploy IngestionStack ProcessingStack --require-approval never
aws kinesisanalyticsv2 start-application --application-name geofence-processor

# 2. observability (dashboard + alarms)
npx cdk deploy ObservabilityStack --require-approval never

# 3. alerting (AgentCore runtimes + memory, bridges, SQS/SNS) — needs Docker + model access
npx cdk deploy AlertingStack --require-approval never \
  -c alertEmail=you@example.com \
  -c analyzerModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  -c publisherModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0
# Confirm the SNS subscription email that AWS sends before testing delivery.
```

**Expected end state:** all four stacks `CREATE_COMPLETE`; the Flink app reaches `RUNNING`
(≈2–3 min after `start-application`); both AgentCore runtimes `READY`; Memory `ACTIVE`.

### Deploy gotchas already handled in code (context, not action items)
- Managed Flink is created *after* its role's S3-read policy (ordering race — fixed).
- The connector jar is validated inside the code zip at create time (why §1 fetches it).
- AgentCore runtimes are created *after* their role's ECR-pull policy (ordering race — fixed).
- Flink logs are delivered to `/aws/kinesis-analytics/geofence-processor` (logging option added).

---

## 4. Test each stack end-to-end

> Kinesis reads use `npm run read-stream` (a jq-free reader — Git Bash on Windows has no jq).

### 001 Ingestion — telemetry → stream
```bash
npm run sim -- --vehicles 10 --duration 120 &         # publish to iot_data
STREAM=vehicle-telemetry npx ts-node tools/verify/reader.ts 60
```
Expect: `RESULT: PASS` — records > 0, max latency < 5 s, 0 out-of-order.

### 002 Processing — zone seed + rules bridge (data plane)
```bash
aws dynamodb scan --table-name geo-fences --query 'Count'            # -> 4
# edit a zone, confirm it propagates to geofence-rules:
aws dynamodb update-item --table-name geo-fences \
  --key '{"id":{"S":"zone-downtown-restricted"}}' \
  --update-expression 'SET updatedAt = :t' \
  --expression-attribute-values "{\":t\":{\"N\":\"$(date +%s)000\"}}"
npm run read-stream geofence-rules trim                              # -> the MODIFY record
```

### 002 Processing — breach detection (Flink)
> The detector logic is **proven correct** (see §6 local test). On Managed Flink the
> Kinesis source currently under-reads (§7). To try it live:
```bash
# the 4 seed zones must be ON geofence-rules (they predate the bridge ESM at deploy):
for Z in zone-downtown-restricted zone-airport-yyc zone-depot-foothills zone-jobsite-north; do
  aws dynamodb update-item --table-name geo-fences --key "{\"id\":{\"S\":\"$Z\"}}" \
    --update-expression 'SET updatedAt = :t' \
    --expression-attribute-values "{\":t\":{\"N\":\"$(date +%s)000\"}}"; done
# with the app RUNNING and warmed, inject a guaranteed crossing:
node tools/verify/inject-crossing.js
sleep 25 && npm run read-stream geofence-alerts trim                 # -> one entry breach
```

### 003 Alerting — triage → gate → delivery (the H1 headline)
> Requires §2 model access. Tests the whole AI chain without needing Flink, by injecting
> breach events straight onto `geofence-alerts`.
```bash
node tools/verify/inject-breach.js       # one genuine critical + one benign nick
sleep 60
# the genuine one was delivered exactly once (idempotency claim); the benign one suppressed:
aws dynamodb scan --table-name geofence-published-alerts --query 'Items[].dedupeKey.S'
aws cloudwatch get-metric-statistics --namespace AWS/SNS \
  --metric-name NumberOfMessagesPublished \
  --dimensions Name=TopicName,Value=geofence-alerts-topic \
  --start-time "$(date -u -d '5 min ago' +%FT%T)" --end-time "$(date -u +%FT%T)" \
  --period 300 --statistics Sum --query 'Datapoints[].Sum'           # -> 1
```
Expect: `geofence-published-alerts` has the genuine `veh-014|...` key (delivered once),
the benign `veh-055` breach is **not** present (gate suppressed it), and the confirmed
email arrives with a `[CRITICAL]` subject + four sections (status / why / impact / actions).

If the analyzer 500s, read the runtime log (the entrypoint logs the full traceback):
```bash
MSYS_NO_PATHCONV=1 aws logs tail \
  /aws/bedrock-agentcore/runtimes/<analyzer-runtime-id>-DEFAULT --since 5m
```

### 004 Observability — dashboard + latency probe
```bash
aws cloudwatch get-dashboard --dashboard-name geofence-pipeline \
  --query 'DashboardBody' --output text | grep -o '"title":"[^"]*"'
ALERTS_STREAM=geofence-alerts npx ts-node tools/verify/latency-probe.ts 90 --emf
```

---

## 5. Local Tier-1 tests (no AWS)
```bash
npm run build        # tsc
npm test             # jest construct tests (4 stacks)
python -m pytest -q  # detector, agents, bridges, eval, EMF
python eval/harness.py   # H1 eval: reference triager vs tuned baseline
```

---

## 6. Prove the Flink detector locally (no AWS, real logs)

How the 002 detection code was proven correct without Managed Flink. Useful for the §7
open issue.

```bash
# JDK 17 (PyFlink 1.20 needs Java 11/17):
curl -L -o corretto17.zip https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip
# extract to a SHORT path (Windows 260-char limit), e.g. C:/j17
export JAVA_HOME=C:/j17/<jdk-dir>

# Python 3.10 venv with pyflink at a SHORT path (long paths break pyflink imports):
uv venv C:/fl --python 3.10
uv pip install --python C:/fl/Scripts/python.exe apache-flink==1.20.0 "setuptools<81"

# run a MiniCluster over the real GeofenceBroadcastFunction with in-memory sources;
# the venv's python must be first on PATH (it launches the Python UDF workers):
export PATH="C:/fl/Scripts:$JAVA_HOME/bin:$PATH"
C:/fl/Scripts/python.exe <a harness that feeds rules + an outside->inside telemetry pair
                          through job.build_pipeline and prints the output>
# Result observed: one {"breachType":"entry","zoneId":"zone-downtown-restricted",...}
```

---

## 7. Known open issue: Managed Flink Kinesis source under-read

The breach-detection **code is correct** (proven in §6), but on Managed Flink the
telemetry `FlinkKinesisConsumer` read only a fraction of published records and the job
restarted, so no breach reached `geofence-alerts`. The rules source worked; the detector
logic works locally. This is a managed-runtime source/connector matter (starting position
on restart, on-demand shard discovery). Managed Flink does not deliver the task-level logs
needed to pin it at INFO/DEBUG.

Next steps when revisiting: reproduce the Kinesis source locally against the real streams
in a Flink container to get logs; consider the new FLIP-27 `KinesisStreamsSource` (also in
the bundled jar) instead of the legacy `FlinkKinesisConsumer`; verify the source starting
position and shard-assignment behaviour on the on-demand stream.

---

## 8. Teardown

```bash
npx cdk destroy --all --force -c alertEmail=you@example.com
```

Two things to know (both hit during the real teardown):
- **AgentCore runtime deletion can time out** (`NotStabilized`) — the delete continues
  async. Re-run `aws cloudformation delete-stack --stack-name AlertingStack` until it's gone,
  then destroy the rest.
- **`vehicle-telemetry` has `DeletionPolicy=Retain`** (a documented follow-up), so `destroy`
  leaves it. Remove it manually:
  ```bash
  aws kinesis delete-stream --stream-name vehicle-telemetry --enforce-consumer-deletion
  ```
Verify nothing of ours remains: `aws cloudformation list-stacks` (no geofence stacks),
`aws bedrock-agentcore-control list-agent-runtimes` (no `geofence_*`).

---

## 9. Cost notes

Managed Flink (KPU-hours) and Bedrock inference are the meaningful costs; Kinesis
(on-demand), DynamoDB (on-demand), Lambda, SQS/SNS, and the dashboard are cents at pilot
volume. **Stop the Flink app when idle** (`aws kinesisanalyticsv2 stop-application
--application-name geofence-processor --force`) — it bills while `RUNNING`. Tear down when
done (§8).
