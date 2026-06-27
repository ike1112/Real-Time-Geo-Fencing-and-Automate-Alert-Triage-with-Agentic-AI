# Tasks 001 — Telemetry Ingestion

Status: DRAFT (awaiting human approval)
Implements: spec.md + design.md (001-ingestion)

Each task is small and individually verifiable. The work loop takes them top to
bottom; the verifier grades each against its check before the next begins.

- [x] T1 — Add `IngestionStack` with an on-demand Kinesis stream
  `vehicle-telemetry`, composed into the app entry. Export stream name + ARN for
  later increments. Check: `cdk synth` shows one `AWS::Kinesis::Stream` named
  `vehicle-telemetry` with `StreamModeDetails: ON_DEMAND`.

- [x] T2 — Add the IAM role assumed by `iot.amazonaws.com`, granted
  `kinesis:PutRecord`/`PutRecords` scoped to the `vehicle-telemetry` ARN only.
  Check: synth shows the role with the IoT trust principal and a stream-scoped
  policy; no wildcards on the resource.

- [x] T3 — Add the `CfnTopicRule`: SQL `SELECT * FROM 'iot_data'`, Kinesis action
  with `partitionKey = ${vehicleId}` and the T2 role. Check: synth shows exactly
  one `AWS::IoT::TopicRule` whose Kinesis action references `vehicle-telemetry`
  and partition key `${vehicleId}`.

- [x] T4 — Construct tests (`aws-cdk-lib/assertions`): stream is on-demand;
  exactly one topic rule with partition key `${vehicleId}` targeting the stream;
  rule role policy scoped to the stream ARN. Check: `npm test` green.

- [x] T5 — Build the telemetry simulator under `tools/simulator/`: publishes via
  `@aws-sdk/client-iot-data-plane` `PublishCommand` to topic `iot_data` with local
  IAM credentials, driving N vehicles along scripted Calgary route files, emitting
  the full design.md payload (required contract + full VSS/telemetry/device/route
  signal set). Cadence is configurable and state-varying (default ~5 s). Ship the
  zone polygon set (downtown-restricted, depot-foothills, airport-yyc,
  jobsite-north) and the scenario overlay: configurable violator fraction +
  bounded GPS jitter, producing genuine breaches and borderline false positives
  across the zones. Check (automated): a `--validate` dry-run mode asserts each
  composed message passes a JSON Schema for the contract + signal set, and that
  every zone polygon and route file parses (closed ring, >= 3 vertices); exits
  non-zero on any failure.

- [x] T6 — Build the verification reader `tools/verify/reader.ts` (reads all
  shards, computes per-record produce->stream latency and per-vehicleId ordering,
  counts published vs received) and run the acceptance runbook in `verify.md`
  end to end. Exact commands and expected numbers live in `verify.md`; it proves
  Step 1 (on-demand/active), Step 3 (all fields present), Step 4 (max latency
  < 5s), Step 5 (0 out-of-order), Step 6 (0 drop / 0 dup over 5 min). Check: the
  filled result block from `verify.md` is pasted in the handoff with every bound
  met. The maker agent runs this against a dev-account deploy (needs AWS creds in
  its shell); the verifier re-runs the read-side steps; the human authorizes the
  deploy/spend and reviews the numbers.

- [ ] T7 — Document running the ingestion slice in a `specs/001-ingestion/`
  README note or repo doc: deploy, the minimal IAM policy the simulator needs
  (`iot-data:Publish` on `iot_data`), how to run it, how to observe records. No
  reference to external source material. Check (HUMAN): a reader can run the slice
  from the doc alone.

- [ ] T8 — Record the deferred follow-up (rule error/dead-letter action) as a
  proposal in STATE.md's queue, not implemented here. Check: follow-up captured,
  scope of this increment stayed minimal.

## Traceability (task -> what it satisfies)

- T1 stream -> FR3, AC4
- T2 role -> FR3 (secure write path), AC4
- T3 rule -> FR3, FR4, AC1, AC3
- T4 tests -> AC5
- T5 simulator -> FR1, FR2, FR5, FR6
- T6 integration -> AC1, AC2, AC3
- T7 docs -> AC4 (reproducible from docs)
- T8 follow-up -> scope discipline (deferred work captured, not silently dropped)

Every AC maps to >= 1 task; every task maps to >= 1 FR/AC. A change tracing to no
task is drift and is rejected.

## Verification tiers (how "done" is proven)

Local checks prove the code and template are correct; only a live deploy proves
the pipeline actually ingests. Tier 1 passing is NOT proof it works in AWS.

- **Tier 1 — local, automated, free.** Maker runs; verifier RE-RUNS (does not
  trust reported results): `npm run build` (typecheck), `npm test` (T4 construct
  assertions — assert the synthesized template's shape; they never call AWS),
  `npx cdk synth` (well-formed), simulator `--validate` (T5). Catches code/infra
  defects before any spend.
- **GATE — deploy (in-session, human-authorized).** The maker agent runs
  `cdk deploy` to a dev/sandbox account once the human has approved the task and
  the spend (cheap: on-demand Kinesis + an IoT rule, pennies for a short run), and
  runs `cdk destroy` after. Only unattended/scheduled runs are barred from
  deploying, and production deploys need explicit approval (docs/safety.md). The
  deploy itself proves AC4 (deploys from an empty account, no manual steps; clean
  destroy).
- **Tier 2 — live, measured, agent-run.** The only proof the pipeline works, and
  the maker agent runs it (needs dev AWS creds in its shell): the `verify.md`
  reader prints max produce->stream latency (< 5s) and 0 out-of-order per vehicle
  (AC1/AC3); a sustained multi-vehicle run shows exactly-once, no drops over 5 min
  (AC2). If no creds are available to the agent, this step falls back to the human.

The verifier independently RE-RUNS Tier 1 and the Tier-2 read-side steps, and
signs off only when every bound is met with the measured numbers in the handoff.
"All checks pass" without Tier-2 evidence is not done.

## Definition of done (increment)

- Tier 1 green (build + test + synth + simulator `--validate`), re-run by the verifier.
- Dev deploy succeeds (maker agent in the approved session, or human if no creds);
  AC4 confirmed (clean deploy + destroy).
- Tier 2 measured numbers meet AC1/AC2/AC3, agent-run, and pasted in the handoff.
- No durable artifact references any external/private source material.
- Branch handed to the human for verification and merge; nothing auto-merged.
