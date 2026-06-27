# Verify 003 — Agentic Alert Triage & Delivery (runbook)

Concrete, runnable steps proving the AI layer suppresses false positives and
retains genuine high/critical events (H1), only high/critical are delivered,
alerts are four-part and human-readable, memory informs repeat events, and a
genuine breach yields exactly one delivery. This is the acceptance script for T11.

## Prerequisites

- `001` + `002` + `003` deployed. Both AgentCore runtimes READY, Memory ACTIVE,
  SQS `alert-queue`, SNS topic with a **confirmed** email subscription, both
  event-source-mappings. Docker available (agent image build), Bedrock model
  access in-region, `BEDROCK_MODEL_ID` set (dev default: Claude Haiku 4.5).
- A labeled breach set (from `001` scenarios via `002`, or fixtures) at
  `eval/data/labeled_breaches.jsonl`, ground-truth labels hidden from the agent.

```bash
REGION=us-east-1
TOPIC_ARN=<arn of geofence-alerts-topic>
QUEUE_URL=<url of alert-queue>
```

## Step 1 — runtimes + memory + wiring healthy

```bash
aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?contains(agentRuntimeName,'alert')].{name:agentRuntimeName,status:status}"
aws bedrock-agentcore-control list-memories --region "$REGION" \
  --query "memories[?contains(name,'violation')].{name:name,status:status}"
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
  --query 'Subscriptions[].SubscriptionArn'
```
Expected: `alert-analyzer` READY, `alert-publisher` READY; memory `ACTIVE`; the
subscription ARN is a real ARN (not `"PendingConfirmation"`).

## Step 2 — H1: suppression vs retention vs baseline (AC1 — the lead bet)

Run the eval harness on the labeled set (label hidden from the agent):
```bash
python eval/run.py --set eval/data/labeled_breaches.jsonl --baseline tuned --region "$REGION"
```
Expected metrics table (illustrative):
```
events:                        400   (250 false-positive, 150 genuine)
false-positive suppression:    86%   (215/250)
genuine HIGH/CRITICAL retain:  97%   (146/150)
precision / recall:            0.91 / 0.97
baseline (tuned static) F1:    0.74
agent F1:                      0.94   -> beats baseline (+0.20)
cost per triaged event:        $0.0008   (model: claude-haiku-4-5)
```
Pass when false positives are suppressed by a clear majority AND genuine
high/critical retention is near-total AND the agent beats the baseline. (Exact
thresholds are OQ-1 / PRD Open Question 2.)

## Step 3 — suppression gate (AC3)

```bash
python eval/invoke_one.py --file eval/data/sample_medium.json   # expect NO_ALERT or severity <= MEDIUM
python eval/invoke_one.py --file eval/data/sample_high.json     # expect ALERT + HIGH/CRITICAL
aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```
Expected: the medium event enqueues **0** to SQS; the high event enqueues **1**.

## Step 4 — four-part, human-readable delivery (AC4)

Inspect the publisher output for the high event (capture via a test SQS
subscription on the topic, or the publisher runtime return):
```bash
... | jq -e '
  (.Subject | test("^\\[(HIGH|CRITICAL)\\]")) and
  (.Message | test("CURRENT VEHICLE STATUS") and test("WHY") and test("IMPACT") and test("ACTIONS"))
' >/dev/null && echo "DELIVERY: PASS" || echo "DELIVERY: FAIL"
```
Expected: `DELIVERY: PASS` — severity-tagged subject and the four sections present.

## Step 5 — memory effect on a repeat event (AC2)

```bash
python eval/invoke_one.py --file eval/data/veh-014_first.json
python eval/invoke_one.py --file eval/data/veh-014_second.json
```
Inspect the analyzer runtime's trace/log (CloudWatch GenAI dashboard or its log
group) for the second invocation. Expected: a `RetrieveMemoryRecords` call
returns the first event, and the second decision's reasoning references the prior
history (visible in the trace).

## Step 6 — single delivery (AC5)

Send one genuine high breach end to end and count SNS publishes for the window:
```bash
aws cloudwatch get-metric-statistics --namespace AWS/SNS \
  --metric-name NumberOfMessagesPublished \
  --dimensions Name=TopicName,Value=geofence-alerts-topic \
  --start-time <T-5min> --end-time <now> --period 300 --statistics Sum --region "$REGION"
```
Expected: `Sum = 1` for the single genuine event (the publisher's `dedupeKey`
prevents duplicates).

## Result block (paste in the handoff)

```
ALERTING VERIFY (deploy YYYY-MM-DD, region us-east-1, model claude-haiku-4-5)
  runtimes:        analyzer READY, publisher READY; memory ACTIVE; sub CONFIRMED
  H1 suppression:  86% FP suppressed / 97% genuine retained            (AC1)
  H1 vs baseline:  agent F1 0.94 vs tuned 0.74 (+0.20)                 (AC1)
  gate:            medium -> 0 enqueued, high -> 1 enqueued            (AC3)
  delivery:        subject [HIGH], 4 sections present                  (AC4)
  memory effect:   2nd event used prior history (trace)                (AC2)
  single delivery: NumberOfMessagesPublished = 1                       (AC5)
  cost/event:      $0.0008
```
Numbers are illustrative of a passing run; the real run records its own. The
verifier re-runs Steps 2, 3, 4, 6 (and the eval on fixtures in Tier 1) and rejects
if any bound is missed.
