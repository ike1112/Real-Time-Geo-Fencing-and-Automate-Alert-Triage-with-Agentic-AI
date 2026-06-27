# Tasks 002 — Geofence Processing

Status: DRAFT (awaiting human approval)
Implements: spec.md + design.md (002-processing)

Each task is small and individually verifiable. Maker top-to-bottom; verifier
grades each Check before the next.

- [ ] T1 — Add `ProcessingStack`: DynamoDB table `geo-fences` (PK `id`, DynamoDB
  Streams ON, new+old images) and the on-demand Kinesis `geofence-alerts` stream;
  export both for increment 3. Check: synth shows the table with
  `StreamSpecification` and `geofence-alerts` as `ON_DEMAND`.

- [ ] T2 — Seed the four Calgary zones into `geo-fences` (downtown-restricted
  exclusion, depot-foothills containment, airport-yyc exclusion, jobsite-north
  dwell) via a deploy-time custom resource or a seed script. Check: after deploy,
  `aws dynamodb scan --table-name geo-fences` returns 4 active items with valid
  closed-ring polygons.

- [ ] T3 — Add the rules bridge: a Python Lambda with a DynamoDB-Streams
  event-source-mapping on `geo-fences`, emitting compact rule-change records to a
  new Kinesis `geofence-rules` stream (partition key `id`). Check: synth shows the
  ESM + stream; unit test maps a sample INSERT/MODIFY/REMOVE image to the expected
  rule-change record.

- [ ] T4 — Point-in-polygon + edge-detection library (Python) with unit tests
  against a concave test polygon (inside/outside/on-edge/near-edge) and an
  in/out-sequence edge detector. Check: `pytest` green; AC3 cases pass.

- [ ] T5 — PyFlink job: source `vehicle-telemetry` (keyed by `vehicleId`) +
  broadcast `geofence-rules`; `KeyedBroadcastProcessFunction` updates the active
  zone set on rule changes and, per telemetry position, tests all active zones and
  emits a factual breach event per violated zone to `geofence-alerts`. Package as
  the Managed Flink app artifact. Check: job builds/packages; a local mini-run over
  a fixture telemetry+rules sequence emits the expected breach events.

- [ ] T6 — Wire the Managed Service for Apache Flink application in CDK pointing at
  the artifact, both stream sources, and the output stream, with runtime config.
  Check: synth shows the Flink app + IAM (read telemetry/rules, write alerts, read
  table); app reaches RUNNING on deploy with both sources connected.

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

## Traceability (task -> what it satisfies)

- T1 store+output -> FR3, AC5 ; T2 seed -> FR3 ; T3 rules bridge -> FR4, AC2 ;
  T4 geometry -> FR2, FR5, AC3 ; T5 PyFlink job -> FR1, FR4, FR5, FR6, AC1, AC4 ;
  T6 Flink infra -> AC5 ; T7 construct tests -> AC3/AC5 (template shape) ;
  T8 runbook -> AC1/AC2/AC4 (made concrete) ; T9 live run -> AC1, AC2, AC4 ;
  T10 -> scope discipline.
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
