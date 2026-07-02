import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IngestionStack } from '../lib/ingestion-stack';

describe('IngestionStack', () => {
  const app = new cdk.App();
  const stack = new IngestionStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  test('telemetry stream is on-demand and named vehicle-telemetry', () => {
    template.resourceCountIs('AWS::Kinesis::Stream', 1);
    template.hasResourceProperties('AWS::Kinesis::Stream', {
      Name: 'vehicle-telemetry',
      StreamModeDetails: { StreamMode: 'ON_DEMAND' },
    });
  });

  test('exactly one IoT topic rule routes iot_data, keyed by vehicleId, stamping ingestTime', () => {
    template.resourceCountIs('AWS::IoT::TopicRule', 1);
    template.hasResourceProperties('AWS::IoT::TopicRule', {
      TopicRulePayload: Match.objectLike({
        // ingestTime stamp added for the source->ingest latency hop (004).
        Sql: "SELECT *, timestamp() AS ingestTime FROM 'iot_data'",
        Actions: [
          Match.objectLike({
            Kinesis: Match.objectLike({ PartitionKey: '${vehicleId}' }),
          }),
        ],
      }),
    });
  });

  test('rule role trusts IoT Core', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'iot.amazonaws.com' } }),
        ]),
      }),
    });
  });

  test('rule policy is scoped to the stream ARN, not a wildcard', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kinesis:PutRecord', 'kinesis:PutRecords']),
            Resource: { 'Fn::GetAtt': Match.anyValue() },
          }),
        ]),
      }),
    });
  });
});
