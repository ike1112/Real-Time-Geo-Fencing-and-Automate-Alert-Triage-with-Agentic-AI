#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IngestionStack } from '../lib/ingestion-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { AlertingStack } from '../lib/alerting-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const ingestion = new IngestionStack(app, 'IngestionStack', { env });
const processing = new ProcessingStack(app, 'ProcessingStack', {
  env,
  telemetryStream: ingestion.telemetryStream,
});
new AlertingStack(app, 'AlertingStack', {
  env,
  alertsStream: processing.alertsStream,
});
