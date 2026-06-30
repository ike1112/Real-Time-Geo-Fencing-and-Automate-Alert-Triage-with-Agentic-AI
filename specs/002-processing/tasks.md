# Tasks 002 — Geofence Processing

Status: DRAFT (awaiting human approval)
Implements: spec.md + design.md (002-processing)

Each task is small and individually verifiable. Maker top-to-bottom; verifier
grades each Check before the next.

- [x] T1 — Add `ProcessingStack`: DynamoDB table `geo-fences` (PK `id`, DynamoDB
  Streams ON, new+old images) and the on-demand Kinesis `geofence-alerts` stream;
  export both for increment 3. Check: synth shows the table with
  `StreamSpecification` and `geofence-alerts` as `ON_DEMAND`.

- [x] T2 — Seed the four Calgary zones into `geo-fences` (downtown-restricted
  exclusion, depot-foothills containment, airport-yyc exclusion, jobsite-north
  dwell) via a deploy-time custom resource or a seed script. Check: after deploy,
  `aws dynamodb scan --table-name geo-fences` returns 4 active items with valid
  closed-ring polygons. Done — deploy-time AwsCustomResource (batchWriteItem) seeds
  items built from the simulator's canonical zones (single source of truth); pure
  deterministic builder + marshaller, unit + construct tested. Verifier APPROVED via
  template inspection (4 valid closed rings, scoped IAM). Live scan deferred to deploy.

- [x] T3 — Add the rules bridge: a Python Lambda with a DynamoDB-Streams
  event-source-mapping on `geo-fences`, emitting compact rule-change records to a
  new Kinesis `geofence-rules` stream (partition key `id`). Check: synth shows the
  ESM + stream; unit test maps a sample INSERT/MODIFY/REMOVE image to the expected
  rule-change record. Done — independent verifier APPROVED (build + jest 8 + pytest 4
  + synth; mapping boto3-free; scope clean). Note: T2 (zone seed) intentionally not
  built first — independent of T3.

- [x] T4 — Point-in-polygon + edge-detection library (Python) with unit tests
  against a concave test polygon (inside/outside/on-edge/near-edge) and an
  in/out-sequence edge detector. Check: `pytest` green; AC3 cases pass. Done —
  independent verifier APPROVED (full suite 25 passed; ran its own concave probe incl.
  the near-reflex point a bbox impl would misclassify; std-lib only). Added importlib
  pytest config + root conftest so the whole Python suite runs from root.

- [x] T5 — PyFlink job: source `vehicle-telemetry` (keyed by `vehicleId`) +
  broadcast `geofence-rules`; `KeyedBroadcastProcessFunction` updates the active
  zone set on rule changes and, per telemetry position, tests all active zones and
  emits a factual breach event per violated zone to `geofence-alerts`. Package as
  the Managed Flink app artifact. Check: job builds/packages; a local mini-run over
  a fixture telemetry+rules sequence emits the expected breach events. Done — pure
  detector core (processor/geofence/detector.py) + thin Flink adapter (job.py
  delegating to it); 9 mini-run tests (AC1/AC4, per-vehicle isolation). Independent
  verifier rejected once (a `T6` label in a comment — fixed), then APPROVED (34 tests,
  own breach probe). Connector wiring + live run deferred to the Flink-app task / deploy.

- [x] T6 — Wire the Managed Service for Apache Flink application in CDK pointing at
  the artifact, both stream sources, and the output stream, with runtime config.
  Check: synth shows the Flink app + IAM (read telemetry/rules, write alerts, read
  table); app reaches RUNNING on deploy with both sources connected. Done (with T12)
  — independent verifier APPROVED via direct template inspection: FLINK-1_20, ZIPFILE
  asset, run-options python entry + stream wiring, least-privilege role. Deviation:
  no geo-fences table grant — the processor reads zone edits via the geofence-rules
  stream, not the table, so table-read would be unused privilege. "Reaches RUNNING"
  deferred to the live run (needs deploy); connector jar added to the artifact at build.

- [ ] T7 — Construct tests (CDK assertions): table Streams enabled; rules-bridge
  ESM present; Flink app + sources/sink wired; `geofence-alerts` on-demand; IAM
  least-privilege. Check: `npm test` green.

- [ ] T8 — Author `specs/002-processing/verify.md` (live runbook, 001-style):
  drive a violator and confirm one correctly-typed breach event; edit/deactivate a
  zone and measure store-edit-to-effect latency (< 60 s, AC2/H2); confirm an
  in-zone vehicle produces no breaches. Check: runbook is runnable and lists exact
  commands + expected numbers.

- [ ] T9 — Run verify.md end to end against a dev deploy (maker agent if creds
  present; else human). Check: filled result block pasted in the handoff — breach
  correctness (AC1), 60 s rule latency (AC2), no false breaches (AC4) — all met.

- [ ] T10 — Record deferred follow-ups (dwell debounce per OQ-1; broadcast
  bootstrap hardening) as STATE.md queue proposals. Check: captured, scope minimal.

## Resilience hardening (streaming data characteristics)

Posture (right-sizing is explicit — see the tags): **[correctness]** items are wrong
to omit at any scale; **[breadth]** items exceed the pilot's ~2-msg/s operational need
and are kept deliberately to demonstrate production streaming patterns (portfolio-grade
scope, chosen over operational-minimum). Each cites the finding and a reference.

- [x] T11 **[breadth]** — Rules-bridge error handling (extends T3). Turn on
  `ReportBatchItemFailures` (partial-batch response) on the DynamoDB-Streams ESM, set a
  max-retry / max-record-age, and an **on-failure destination** (SQS DLQ). Done —
  independent verifier APPROVED (build + jest 10 + pytest 8 + synth; template inspected;
  failure contract proven by exact-value tests; idempotency confirmed absent). Handles
  finding **R1**. Why: with stream ESMs a poison record otherwise retries the whole
  batch to expiry. **Idempotency intentionally omitted here:** DynamoDB Streams is
  exactly-once and ordered per item, and a rule write is a state-replace (re-applying is
  harmless), so dedupe would be dead weight — contrast `003` T13, where it is
  load-bearing. (This judgment is the point, not an oversight.)
  Refs: https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html ,
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html .
  Check: construct test asserts `FunctionResponseTypes=[ReportBatchItemFailures]` +
  the DLQ/on-failure destination; unit test returns a partial-failure for a bad record.

- [x] T12 **[correctness]** — Done (built with T6; verifier confirmed CheckpointingEnabled
  + 60s interval + SnapshotsEnabled in the synthesized app, set at app-config level not
  in job code). Flink reliability config (extends T6). Enable **checkpointing** (interval
  ~60 s) for fault recovery and **snapshots** (`ApplicationSnapshotConfiguration` +
  `ApplicationRestoreConfiguration`) for exactly-once across updates/scaling. Set this
  at the **MSF application config level, not in app code** (MSF rejects in-code
  checkpoint/parallelism config). Handles finding **R2**. Why: without it a restart
  loses state and re-processes or drops in-flight records.
  Refs: https://docs.aws.amazon.com/managed-flink/latest/java/how-fault.html ,
  https://docs.aws.amazon.com/managed-flink/latest/java/how-snapshots.html ,
  https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-kinesisanalyticsv2-application-applicationsnapshotconfiguration.html .
  Check: construct test asserts `CheckpointConfiguration` enabled + snapshots enabled
  on the `AWS::KinesisAnalyticsV2::Application`.

- [ ] T13 **[correctness]** — Broadcast-state bootstrap as a tested acceptance criterion (extends T5).
  The job must not evaluate telemetry before the initial rule set is loaded (else early
  breaches are missed); replay `geofence-rules` from an early position and/or hold
  telemetry until first rule load. Handles finding **R2** (bootstrap race) + design
  risk already flagged. Check: the fixture mini-run asserts a telemetry event arriving
  before any rule produces **no** breach, and the same event after the rule load
  produces the expected breach.

- [ ] T14 **[breadth]** — Poison-telemetry handling in the Flink source (extends T5). A
  non-deserializable telemetry record must be dropped and counted (a metric), not stall
  the shard. Handles finding **R1** (stream-side). Note: the controlled simulator can't
  emit malformed records today, so this guards a case that can't occur at pilot — kept
  as a deliberate resilience demonstration, not an operational need. Check: fixture
  mini-run feeds a malformed record and asserts the job continues + increments the drop counter.

## Traceability (task -> what it satisfies)

- T1 store+output -> FR3, AC5 ; T2 seed -> FR3 ; T3 rules bridge -> FR4, AC2 ;
  T4 geometry -> FR2, FR5, AC3 ; T5 PyFlink job -> FR1, FR4, FR5, FR6, AC1, AC4 ;
  T6 Flink infra -> AC5 ; T7 construct tests -> AC3/AC5 (template shape) ;
  T8 runbook -> AC1/AC2/AC4 (made concrete) ; T9 live run -> AC1, AC2, AC4 ;
  T10 -> scope discipline.
- T11 rules-bridge errors -> review R1 ; T12 Flink checkpoint/snapshot -> review R2 ;
  T13 bootstrap-as-AC -> review R2 + AC2/AC4 (correctness under live updates) ;
  T14 poison-telemetry -> review R1 (resilience hardening; see
  docs/well-architected-review.md and docs/streaming-architecture-review.md §A3).
- Every AC maps to >= 1 task; every task maps to >= 1 FR/AC.

## Verification tiers (how "done" is proven)

- **Tier 1 — local, free** (maker runs; verifier RE-RUNS): `npm run build`,
  `npm test` (CDK assertions), `pytest` (geometry + bridge mapping + job mini-run),
  `npx cdk synth`. Proves code/template correct, not live behavior.
- **GATE — deploy (in-session, human-authorized):** maker agent `cdk deploy` to a
  dev account (Managed Flink + DynamoDB + Lambda + two streams — small but not
  free), runs verify.md, `cdk destroy` after. Production/unattended deploys barred.
- **Tier 2 — live, measured, agent-run:** breach correctness (AC1), the **60 s
  rule-update latency** (AC2/H2, the lead number), and no false breaches (AC4),
  from verify.md.

The verifier RE-RUNS Tier 1 and the Tier-2 read-side steps; done requires the
measured numbers in the handoff.

## Definition of done (increment)

- Tier 1 green, re-run by the verifier.
- Dev deploy succeeds; Flink app RUNNING with both sources (AC5).
- Tier 2 numbers meet AC1/AC2/AC4 and are pasted in the handoff.
- No durable artifact references external/private source material.
- Branch handed to the human for verification and merge; nothing auto-merged.
