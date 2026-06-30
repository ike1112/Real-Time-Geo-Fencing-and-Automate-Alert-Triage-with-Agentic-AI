import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ProcessingStack } from '../lib/processing-stack';

describe('ProcessingStack — rules bridge', () => {
  const app = new cdk.App();
  const stack = new ProcessingStack(app, 'TestProcessingStack');
  const template = Template.fromStack(stack);

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
});
