# Loop Safety

This document defines the safety boundaries for loop-engineering workflows in
this repository.

## Allowed Automation

- Generate triage reports in `.loop/triage/`
- Update `STATE.md`
- Update `.loop/attempt-ledger.json`
- Update `.loop/run-log.jsonl`
- Commit and push only those loop artifacts (`STATE.md`, `.loop/triage/`, `.loop/attempt-ledger.json`, `.loop/run-log.jsonl`)
- Use read-only or explicitly approved MCP lookups for documentation, pricing, architecture, and analysis

## Disallowed Automation

- Auto-commit or auto-push application or infrastructure code
- Auto-merge pull requests
- Destructive filesystem or git history operations
- Unattended cloud infrastructure mutations
- Security-sensitive edits without a human gate
- Referencing the private source context in any durable artifact

## Human Gates

Human approval is required before:

- any application or infrastructure code edit beyond documentation-only changes
- approving a spec into the Approved Tasks queue
- production or shared-environment infrastructure changes
- security configuration changes
- widening scope beyond one approved loop task
- continuing an L2 task after 2 failed maker/checker cycles

## Verification deploys (attended L2)

Running the verification for an approved L2 task is attended, so the maker agent
MAY `cdk deploy` to a dev/sandbox account and `cdk destroy` afterwards to prove
acceptance criteria that need live behavior. This is not an "unattended
infrastructure mutation": the human approved the task and authorized the spend.
Still barred: deploying from scheduled/unattended runs (the L1 triage loop never
deploys), deploying to production without explicit approval, and auto-committing
or auto-merging the change. If the agent has no dev credentials, the live
verification falls back to the human.

## Denylist

Treat these areas as human-review-required by default:

- authentication and authorization logic
- IAM roles, policies, and trust relationships
- secrets and credentials
- production deployment configuration
- billing and cost-control configuration

## MCP Scope Guidance

- Prefer read-only knowledge, documentation, and pricing lookups by default.
- Add write-capable connectors only after the loop has proven stable at L1 and L2.
- If a remote MCP server can mutate external systems, keep it disabled until a concrete approval policy exists.
