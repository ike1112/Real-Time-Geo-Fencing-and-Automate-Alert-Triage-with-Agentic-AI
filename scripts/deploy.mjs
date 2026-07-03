#!/usr/bin/env node
// Step-by-step deployment orchestrator for the geofence pipeline.
//
//   node scripts/deploy.mjs --check                 # prerequisites only, no changes
//   node scripts/deploy.mjs --install               # + npm ci, fetch jar, cdk bootstrap
//   node scripts/deploy.mjs --deploy --email you@x  # + deploy all four stacks
//   node scripts/deploy.mjs --deploy --skip-alerting # deploy 001/002/004 (no Docker/Bedrock)
//
// Flags: --region <r> (default $AWS_REGION or us-east-1), --analyzer-model <id>,
//        --publisher-model <id>, --yes (skip the cost confirmation), --skip-alerting.
// Every run writes a timestamped log to logs/deploy-<timestamp>.log.
//
// Deploy is off by default: with no action flag it prints help. Nothing is created
// unless you pass --deploy.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

// ---------- args ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DO_CHECK = has('--check') || has('--install') || has('--deploy');
const DO_INSTALL = has('--install') || has('--deploy');
const DO_DEPLOY = has('--deploy');
const SKIP_ALERTING = has('--skip-alerting');
const ASSUME_YES = has('--yes');
const REGION = val('--region', process.env.AWS_REGION || 'us-east-1');
const EMAIL = val('--email', process.env.ALERT_EMAIL || '');
const ANALYZER_MODEL = val('--analyzer-model', 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
const PUBLISHER_MODEL = val('--publisher-model', 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
const APP_NAME = 'geofence-processor';

// ---------- logging ----------
mkdirSync('logs', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = `logs/deploy-${stamp}.log`;
const logFile = createWriteStream(logPath, { flags: 'a' });
const write = (s) => { process.stdout.write(s + '\n'); logFile.write(s + '\n'); };
const ts = () => new Date().toISOString();
const log = (msg = '', level = 'INFO') => write(`[${ts()}] [${level}] ${msg}`);
const banner = (t) => { const b = '='.repeat(70); log(''); log(b); log(t); log(b); };
let WARNINGS = 0;

// ---------- command runners ----------
// Quick capture for checks (buffered).
function capture(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { code: r.status ?? 1, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
// Streaming runner for long steps (deploys). Streams every line to console + log.
function stream(cmd) {
  return new Promise((resolve) => {
    log(`$ ${cmd}`, 'CMD');
    const p = spawn(cmd, { shell: true });
    const onData = (buf) => buf.toString().split('\n').forEach((l) => { if (l.trim()) write('    ' + l.replace(/\s+$/, '')); });
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => { log(`(exit ${code})`, code === 0 ? 'INFO' : 'ERROR'); resolve(code ?? 1); });
  });
}
async function step(title, cmd) {
  banner(title);
  const code = await stream(cmd);
  if (code !== 0) { log(`STEP FAILED: ${title}`, 'ERROR'); log(`See the log: ${logPath}`, 'ERROR'); process.exit(1); }
}

function confirm(question) {
  if (ASSUME_YES) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question + ' [y/N] ', (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

// ---------- prerequisite checks ----------
function checkPrereqs() {
  banner('PREREQUISITE CHECKS');
  let hardFail = false;
  const pass = (m) => log(`PASS  ${m}`);
  const warn = (m) => { log(`WARN  ${m}`, 'WARN'); WARNINGS++; };
  const fail = (m) => { log(`FAIL  ${m}`, 'ERROR'); hardFail = true; };

  // AWS credentials + region
  const id = capture('aws sts get-caller-identity --query Account --output text');
  if (id.code === 0 && /^\d{12}$/.test(id.out)) pass(`AWS credentials (account ${id.out}, region ${REGION})`);
  else fail('AWS credentials — run `aws configure` / set env creds. ' + id.out);

  // Node + npm
  const node = capture('node --version');
  node.code === 0 ? pass(`Node ${node.out}`) : fail('Node.js not found');
  const npm = capture('npm --version');
  npm.code === 0 ? pass(`npm ${npm.out}`) : fail('npm not found');

  // CDK
  const cdk = capture('npx --no-install cdk --version');
  cdk.code === 0 ? pass(`AWS CDK ${cdk.out}`) : warn('cdk not resolvable via npx (run --install to `npm ci`)');

  // CDK bootstrap
  const boot = capture(`aws cloudformation describe-stacks --stack-name CDKToolkit --region ${REGION} --query "Stacks[0].StackStatus" --output text`);
  if (boot.code === 0 && /COMPLETE/.test(boot.out)) pass('CDK bootstrap (CDKToolkit present)');
  else warn('CDK not bootstrapped in this region — run --install (does `cdk bootstrap`)');

  // Connector jar (required for 002)
  const jar = 'processor/lib/flink-sql-connector-kinesis.jar';
  if (existsSync(jar) && statSync(jar).size > 1_000_000) pass(`Flink connector jar (${Math.round(statSync(jar).size / 1e6)} MB)`);
  else warn('Flink connector jar missing — run --install (does `npm run fetch:connector`)');

  // Python (for the Tier-1 tests; not required to deploy)
  const py = capture('python --version');
  py.code === 0 ? pass(`Python ${py.out.replace('Python ', '')}`) : warn('Python not found (only needed for pytest)');

  // Alerting-only prerequisites
  if (!SKIP_ALERTING) {
    const docker = capture('docker version --format "{{.Server.Version}}"');
    if (docker.code === 0 && docker.out && !/error|cannot/i.test(docker.out)) pass(`Docker daemon (server ${docker.out.split('\n')[0]})`);
    else fail('Docker daemon not reachable — start Docker Desktop, or deploy with --skip-alerting');

    if (EMAIL) pass(`Alert email: ${EMAIL}`);
    else if (DO_DEPLOY) fail('Alerting deploy needs --email <address> for the SNS subscription');
    else warn('No --email set (needed for AlertingStack)');

    // Bedrock inference profile presence (model ACCESS still needs the console — cannot verify here).
    const prof = capture(`aws bedrock list-inference-profiles --region ${REGION} --query "inferenceProfileSummaries[?inferenceProfileId=='${ANALYZER_MODEL}'].inferenceProfileId" --output text`);
    if (prof.code === 0 && prof.out.trim()) pass(`Bedrock inference profile exists: ${ANALYZER_MODEL}`);
    else warn(`Inference profile ${ANALYZER_MODEL} not listed in ${REGION} — check the id/region`);
    warn('Bedrock MODEL ACCESS cannot be verified from here — enable it in the Bedrock console (Model access -> Anthropic) or the analyzer will 500 (AccessDenied). See DEPLOYMENT.md §2.');
  }

  log('');
  log(`Checks complete: ${hardFail ? 'HARD FAILURES present' : 'all required checks passed'}, ${WARNINGS} warning(s).`);
  if (hardFail) { log('Resolve the FAIL items above before deploying.', 'ERROR'); process.exit(1); }
}

// ---------- install ----------
async function install() {
  await step('INSTALL: npm dependencies', 'npm ci || npm install');
  await step('INSTALL: Flink connector jar', 'npm run fetch:connector');
  const boot = capture(`aws cloudformation describe-stacks --stack-name CDKToolkit --region ${REGION} --query "Stacks[0].StackStatus" --output text`);
  if (!(boot.code === 0 && /COMPLETE/.test(boot.out))) await step('INSTALL: CDK bootstrap', `npx cdk bootstrap --region ${REGION}`);
  else log('CDK already bootstrapped — skipping.');
}

// ---------- verify helpers ----------
function stackStatus(name) {
  return capture(`aws cloudformation describe-stacks --stack-name ${name} --region ${REGION} --query "Stacks[0].StackStatus" --output text`).out;
}
async function waitFor(label, checkFn, target, tries = 20, delayMs = 20000) {
  log(`waiting for ${label} to reach ${target} ...`);
  for (let i = 1; i <= tries; i++) {
    const s = checkFn();
    log(`  [${i}/${tries}] ${label} = ${s}`);
    if (s === target) return true;
    if (/FAILED|ROLLBACK/.test(s)) { log(`${label} entered ${s}`, 'ERROR'); return false; }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// ---------- deploy ----------
async function deploy() {
  banner('DEPLOY PLAN');
  log(`region=${REGION}  skipAlerting=${SKIP_ALERTING}  email=${EMAIL || '(none)'}`);
  log(`analyzerModel=${ANALYZER_MODEL}`);
  log(`publisherModel=${PUBLISHER_MODEL}`);
  log('COST NOTE: Managed Flink bills ~$0.22/hr while RUNNING (the dominant cost).');
  if (!(await confirm('Proceed with deploy (creates billable AWS resources)?'))) { log('Aborted by user.'); process.exit(0); }

  await step('DEPLOY 1/4: IngestionStack + ProcessingStack', 'npx cdk deploy IngestionStack ProcessingStack --require-approval never');
  await step('DEPLOY 2/4: start the Flink application', `aws kinesisanalyticsv2 start-application --application-name ${APP_NAME} --region ${REGION}`);
  await step('DEPLOY 3/4: ObservabilityStack', 'npx cdk deploy ObservabilityStack --require-approval never');

  if (!SKIP_ALERTING) {
    await step('DEPLOY 4/4: AlertingStack (AgentCore runtimes + memory)',
      `npx cdk deploy AlertingStack --require-approval never -c alertEmail=${EMAIL} -c analyzerModelId=${ANALYZER_MODEL} -c publisherModelId=${PUBLISHER_MODEL}`);
  } else {
    log('Skipping AlertingStack (--skip-alerting).');
  }

  banner('VERIFY');
  for (const s of ['IngestionStack', 'ProcessingStack', 'ObservabilityStack', ...(SKIP_ALERTING ? [] : ['AlertingStack'])]) {
    const st = stackStatus(s);
    log(`${/COMPLETE/.test(st) ? 'OK  ' : 'BAD '} ${s}: ${st}`, /COMPLETE/.test(st) ? 'INFO' : 'ERROR');
  }
  await waitFor('Flink app', () => capture(`aws kinesisanalyticsv2 describe-application --application-name ${APP_NAME} --region ${REGION} --query "ApplicationDetail.ApplicationStatus" --output text`).out, 'RUNNING', 12, 20000);

  banner('DONE');
  log('Deploy finished. Next: enable Bedrock model access if you have not (DEPLOYMENT.md §2),');
  log('then run the tests in DEPLOYMENT.md §4 (npm run inject:breach, etc.).');
  log('Remember to stop Flink / tear down when idle to avoid cost.');
}

// ---------- main ----------
function help() {
  write([
    'Geofence pipeline deployment orchestrator',
    '',
    '  node scripts/deploy.mjs --check                    prerequisites only (no changes)',
    '  node scripts/deploy.mjs --install                  + npm ci, fetch jar, cdk bootstrap',
    '  node scripts/deploy.mjs --deploy --email you@x.com + deploy all four stacks',
    '  node scripts/deploy.mjs --deploy --skip-alerting   deploy 001/002/004 only (no Docker/Bedrock)',
    '',
    'Options: --region <r> --analyzer-model <id> --publisher-model <id> --yes',
    'Every run logs to logs/deploy-<timestamp>.log',
  ].join('\n'));
}

(async () => {
  if (!DO_CHECK) { help(); process.exit(0); }
  banner(`GEOFENCE DEPLOY  (${DO_DEPLOY ? 'deploy' : DO_INSTALL ? 'install' : 'check'} mode)`);
  log(`log file: ${logPath}`);
  checkPrereqs();
  if (DO_INSTALL) await install();
  if (DO_DEPLOY) await deploy();
  log('');
  log(`Complete. Full log: ${logPath}`);
  logFile.end();
})();
