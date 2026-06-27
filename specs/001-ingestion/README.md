# Running the telemetry ingestion slice

End-to-end: a simulator publishes connected-vehicle telemetry to the `iot_data`
MQTT topic; an AWS IoT topic rule routes it onto the `vehicle-telemetry` Kinesis
stream, partitioned per vehicle. This guide deploys it, runs it, and observes
records, using only what is in this repo.

## Prerequisites

- Node.js + this repo's dependencies: `npm install`
- AWS credentials for a **dev/sandbox** account in your shell, and a region:
  `export AWS_REGION=us-east-1`
- The credentials need permission to deploy the stack (CloudFormation, Kinesis,
  IAM, IoT) and, for the simulator, to publish to the topic (below).

## 1. Validate offline (no AWS)

```bash
npm run build              # typecheck
npm run sim -- --validate  # schema-checks composed messages, parses zones/routes
```
Expect `VALIDATE: PASS`.

## 2. Deploy

```bash
npx cdk bootstrap            # one-time per account/region
npx cdk deploy               # creates the stream, the IoT rule, and the rule role
```
Outputs include `TelemetryStreamName = vehicle-telemetry`.

## 3. Minimal IAM the simulator needs

The simulator calls the IoT Data Plane `Publish` API. The principal running it
needs only:

```json
{
  "Effect": "Allow",
  "Action": "iot:Publish",
  "Resource": "arn:aws:iot:us-east-1:<account-id>:topic/iot_data"
}
```

## 4. Run the simulator

```bash
npm run sim -- --vehicles 10 --duration 120
```
Drives 10 vehicles along Calgary routes, publishing every ~5s.

## 5. Observe records on the stream

```bash
npx ts-node tools/verify/reader.ts 60
```
Reads every shard for 60s and prints record count, max produce->stream latency
(target < 5s), and per-vehicle out-of-order count (target 0). A measured run:
`90 records, 10 vehicles, max latency 0.97s, 0 out-of-order, RESULT: PASS`.

## 6. Tear down

```bash
npx cdk destroy
# The Kinesis stream defaults to DeletionPolicy=Retain, so destroy skips it.
# Until the dev removalPolicy follow-up lands, delete it manually:
aws kinesis delete-stream --stream-name vehicle-telemetry --enforce-consumer-deletion
```
