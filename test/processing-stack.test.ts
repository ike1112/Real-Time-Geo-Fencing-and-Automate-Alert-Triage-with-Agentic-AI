import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IngestionStack } from '../lib/ingestion-stack';
import { ProcessingStack } from '../lib/processing-stack';

const app = new cdk.App();
const ingestion = new IngestionStack(app, 'TestIngestionStack');
const stack = new ProcessingStack(app, 'TestProcessingStack', {
  telemetryStream: ingestion.telemetryStream,
});
const template = Template.fromStack(stack);

describe('ProcessingStack — rules bridge', () => {
  test('geofence-rules is an on-demand stream', () => {
    template.hasResourceProperties('AWS::Kinesis::Stream', {
      Name: 'geofence-rules',
      StreamModeDetails: { StreamMode: 'ON_DEMAND' },
    });
  });

  test('rules bridge is a Python Lambda wired to the rules stream', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geofence-rules-bridge',
      Runtime: 'python3.12',
      Handler: 'handler.handler',
      Environment: {
        Variables: {
          // env var references the geofence-rules stream by Ref, not a literal
          RULES_STREAM_NAME: { Ref: Match.stringLikeRegexp('GeofenceRules') },
        },
      },
    });
  });

  test('a DynamoDB-Streams event source mapping feeds the bridge', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      EventSourceArn: Match.objectLike({
        'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('GeoFences')]),
      }),
    });
  });

  test('the bridge may write to the rules stream', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kinesis:PutRecord', 'kinesis:PutRecords']),
          }),
        ]),
      }),
    });
  });

  test('the event source reports partial-batch failures, bisects, and ages out', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BisectBatchOnFunctionError: true,
      MaximumRecordAgeInSeconds: 3600,
      DestinationConfig: Match.objectLike({
        OnFailure: Match.objectLike({ Destination: Match.anyValue() }),
      }),
    });
  });

  test('a dead-letter queue catches exhausted rule-change records', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'geofence-rules-bridge-dlq',
    });
  });
});

describe('ProcessingStack — zone seed', () => {
  test('a deploy-time custom resource seeds the zone store', () => {
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('the seed may batch-write to the geo-fences table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'dynamodb:BatchWriteItem' }),
        ]),
      }),
    });
  });
});

describe('ProcessingStack — Flink processor', () => {
  test('declares a Managed Flink application with the zipped job artifact', () => {
    template.hasResourceProperties('AWS::KinesisAnalyticsV2::Application', {
      RuntimeEnvironment: Match.stringLikeRegexp('^FLINK-'),
      ApplicationConfiguration: Match.objectLike({
        ApplicationCodeConfiguration: Match.objectLike({ CodeContentType: 'ZIPFILE' }),
      }),
    });
  });

  test('checkpointing and snapshots are enabled for fault tolerance', () => {
    template.hasResourceProperties('AWS::KinesisAnalyticsV2::Application', {
      ApplicationConfiguration: Match.objectLike({
        FlinkApplicationConfiguration: Match.objectLike({
          CheckpointConfiguration: Match.objectLike({
            CheckpointingEnabled: true,
            CheckpointInterval: 60000,
          }),
        }),
        ApplicationSnapshotConfiguration: { SnapshotsEnabled: true },
      }),
    });
  });

  test('runtime properties set the python entry and carry the stream wiring', () => {
    template.hasResourceProperties('AWS::KinesisAnalyticsV2::Application', {
      ApplicationConfiguration: Match.objectLike({
        EnvironmentProperties: Match.objectLike({
          PropertyGroups: Match.arrayWith([
            Match.objectLike({
              PropertyGroupId: 'kinesis.analytics.flink.run.options',
              PropertyMap: Match.objectLike({ python: 'geofence/job.py' }),
            }),
            Match.objectLike({ PropertyGroupId: 'geofence.streams' }),
          ]),
        }),
      }),
    });
  });

  test('the processor role trusts Kinesis Analytics and can write alerts', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'kinesisanalytics.amazonaws.com' },
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kinesis:PutRecord', 'kinesis:PutRecords']),
          }),
        ]),
      }),
    });
  });
});

describe('ProcessingStack — stateful store and least privilege', () => {
  test('geo-fences table has change streams (new and old images), keyed by id', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'geo-fences',
      KeySchema: Match.arrayWith([{ AttributeName: 'id', KeyType: 'HASH' }]),
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  test('geofence-alerts is an on-demand stream', () => {
    template.hasResourceProperties('AWS::Kinesis::Stream', {
      Name: 'geofence-alerts',
      StreamModeDetails: { StreamMode: 'ON_DEMAND' },
    });
  });

  test('the processor role can read both input streams (sources wired)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kinesis:GetRecords', 'kinesis:GetShardIterator']),
          }),
        ]),
      }),
    });
  });

  test('data-plane grants are scoped — no resource wildcards', () => {
    const dataActions = [
      'kinesis:PutRecord',
      'kinesis:PutRecords',
      'kinesis:GetRecords',
      'dynamodb:BatchWriteItem',
    ];
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        if (actions.some((a) => dataActions.includes(a))) {
          expect(statement.Resource).not.toBe('*');
          if (Array.isArray(statement.Resource)) {
            expect(statement.Resource).not.toContain('*');
          }
        }
      }
    }
  });
});
