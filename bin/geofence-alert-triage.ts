#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IngestionStack } from '../lib/ingestion-stack';

const app = new cdk.App();

new IngestionStack(app, 'IngestionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
