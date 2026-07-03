# Live deploy findings (dev account, 2026-07-03)

First real end-to-end deploy of all four stacks to a dev AWS account (us-east-1).
Everything had been Tier-1 verified (build / jest / pytest / synth) but never deployed;
this run exercised the managed-service integrations for the first time and surfaced a
series of real issues, each fixed in code. Recorded here so the next deploy is smooth.

## What was verified working

- **001 IngestionStack** — end-to-end PASS: simulator → IoT topic rule → `vehicle-telemetry`
  Kinesis stream. 70 records, max 0.97 s produce→stream latency, 0 out-of-order.
- **002 ProcessingStack data plane** — zone seed (4 zones in `geo-fences`) and the rules
  bridge (a live `put-item` propagated to `geofence-rules` with the correct mapping).
- **002 breach detector logic** — **proven correct** on a local PyFlink 1.20 MiniCluster:
  the `GeofenceBroadcastFunction` emits the expected entry breach for an outside→inside
  crossing. (Set up a local JDK 17 + a Python 3.10 venv with `apache-flink==1.20` to run it.)
- **004 ObservabilityStack** — dashboard + alarm fleet deployed.
- **003 AlertingStack** — all 30 resources deploy; both AgentCore runtimes reach READY,
  Memory ACTIVE; the analyzer code runs end-to-end up to the model call.

## Bugs found and fixed (all committed)

1. **Managed Flink S3-read race** — the `CfnApplication` was created before its execution
   role's S3-read policy attached, so create-time code validation failed. Fix: explicit
   `flinkApp.node.addDependency(processorRole)`.
2. **Missing Kinesis connector jar** — MSF validates the `jarfile` in run-options exists in
   the zip at create time. Fix: bundle `flink-sql-connector-kinesis-5.1.0-1.20.jar` under
   `processor/lib/` (git-ignored; re-download from Maven Central).
3. **No Flink CloudWatch logging** — the app failed silently back to READY. Fix: add a
   `CfnApplicationCloudWatchLoggingOption` + log group.
4. **`FlinkKinesisProducer` removed in PyFlink 1.20** — the deferred `job.main()` used it and
   `ImportError`'d. Fix: implement `main()` with `FlinkKinesisConsumer` sources + the new
   `KinesisStreamsSink`, reading stream names/region from the `geofence.streams` property group.
5. **PyFlink callback gauge unsupported** — the operator's `open()` registered a metric gauge
   with a Python callable, which PyFlink cannot do over the process boundary → crash loop.
   Fix: drop the gauge (trace stamping + the offline probe still cover Layer-2 latency).
6. **AgentCore runtime role missing ECR pull** — AgentCore validates image pull at create;
   the roles had Bedrock/memory/SQS/SNS but no ECR. Fix: `image.repository.grantPull(role)`
   + CloudWatch Logs / X-Ray perms.
7. **AgentCore runtime→role ordering race** — same class as #1: the `CfnRuntime` referenced
   the role ARN but not its policy. Fix: `runtime.node.addDependency(role)`.
8. **Analyzer Memory `ParamValidationError`** — the retrieve used `searchQuery` instead of the
   required `searchCriteria`, 500-ing every invoke before the model call. Fix: make Memory
   best-effort (try/except) with the SDK's `retrieve_memories`/`create_event`.
9. **Analyzer output handling** — `str(AgentResult)` isn't clean JSON. Fix: extract the message
   text and make `parse_decision` recover JSON wrapped in prose / a ```json fence.

## The two remaining blockers (not code defects)

- **002 Managed Flink Kinesis source under-reads.** The job reaches RUNNING and is stable, but
  the telemetry FlinkKinesisConsumer read only 8 of 96 published records across restarts, so no
  breach reached `geofence-alerts`. The detector logic is proven correct locally, so this is a
  managed-service source/connector integration matter (starting position on restart, shard
  discovery on the on-demand stream). MSF does not deliver the task-level logs needed to pin it
  at INFO/DEBUG — needs a dedicated session, ideally reproducing the connector locally.

- **003 Bedrock model access not enabled for the account.** With everything else fixed, the
  analyzer's model call fails: `AccessDeniedException … aws-marketplace:ViewSubscriptions/Subscribe
  … Model access is denied`. **Action required:** in the Bedrock console (this account), open
  **Model access** and enable the Anthropic models (Claude Haiku 4.5 for dev, Opus for demo).
  The runtime roles now carry the `aws-marketplace` perms; account-level model access is the
  remaining, human, one-time step. Once enabled, re-run the 003 end-to-end test (inject a breach
  into `geofence-alerts` → analyzer → gate → publisher → SNS email).

## How to re-run the 003 end-to-end test (after enabling model access)

```bash
# genuine critical breach + a benign nick, straight onto geofence-alerts:
node <inject two breach events into geofence-alerts>   # see the session's inject_breach.js
# then confirm: geofence-published-alerts has the genuine dedupeKey (1 delivery),
# the benign one is suppressed, and SNS NumberOfMessagesPublished == 1.
```
