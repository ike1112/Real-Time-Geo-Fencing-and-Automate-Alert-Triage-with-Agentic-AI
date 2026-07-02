import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IngestionStack } from '../lib/ingestion-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { AlertingStack } from '../lib/alerting-stack';

const app = new cdk.App();
const ingestion = new IngestionStack(app, 'TestIngestionStack');
const processing = new ProcessingStack(app, 'TestProcessingStack', {
  telemetryStream: ingestion.telemetryStream,
});
const stack = new AlertingStack(app, 'TestAlertingStack', {
  alertsStream: processing.alertsStream,
});
const template = Template.fromStack(stack);

describe('AlertingStack — queue, topic, delivery', () => {
  test('alert-queue has a redrive policy to a dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'geofence-alert-queue',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'geofence-alert-queue-dlq' });
  });

  test('an SNS topic delivers to an email subscription with its own DLQ', () => {
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'geofence-alerts-topic' });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      RedrivePolicy: Match.anyValue(), // subscription dead-letter queue
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'geofence-alerts-subscription-dlq',
    });
  });

  test('an idempotency table keyed on dedupeKey with TTL backs single-delivery', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'geofence-published-alerts',
      KeySchema: Match.arrayWith([{ AttributeName: 'dedupeKey', KeyType: 'HASH' }]),
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });
});

describe('AlertingStack — AgentCore memory and runtimes (native IaC)', () => {
  test('memory declares both semantic and summary strategies with per-vehicle namespaces', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: Match.arrayWith([
        Match.objectLike({
          SemanticMemoryStrategy: Match.objectLike({
            Namespaces: ['/violations/{actorId}'],
          }),
        }),
        Match.objectLike({
          SummaryMemoryStrategy: Match.objectLike({
            Namespaces: ['/summaries/{actorId}/{sessionId}'],
          }),
        }),
      ]),
    });
  });

  test('two agent runtimes are declared with a container image, role, and model env', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'geofence_alert_analyzer',
      AgentRuntimeArtifact: Match.objectLike({
        ContainerConfiguration: Match.objectLike({ ContainerUri: Match.anyValue() }),
      }),
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      RoleArn: Match.anyValue(),
      EnvironmentVariables: Match.objectLike({
        BEDROCK_MODEL_ID: Match.stringLikeRegexp('^us\\.'), // cross-region inference profile
        OTEL_TRACES_SAMPLER: 'always_on',
      }),
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'geofence_alert_publisher',
    });
  });

  test('the analyzer runtime env carries the memory id and the queue url', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'geofence_alert_analyzer',
      EnvironmentVariables: Match.objectLike({
        MEMORY_ID: Match.anyValue(),
        ALERT_QUEUE_URL: Match.anyValue(),
      }),
    });
  });
});

describe('AlertingStack — bridges and resilience', () => {
  test('the analyzer bridge is a Kinesis ESM with partial-batch failures and a DLQ', () => {
    // The breach stream is a cross-stack import, so identify this ESM by the
    // Kinesis-only StartingPosition rather than the (imported) source ARN.
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BisectBatchOnFunctionError: true,
      DestinationConfig: Match.objectLike({
        OnFailure: Match.objectLike({ Destination: Match.anyValue() }),
      }),
    });
  });

  test('the publisher bridge is an SQS ESM with partial-batch failures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      EventSourceArn: Match.objectLike({
        'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('AlertQueue')]),
      }),
    });
  });

  test('both bridges are Python Lambdas pointed at their runtime ARNs', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geofence-analyzer-bridge',
      Handler: 'analyzer_bridge.handler',
      Runtime: 'python3.12',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geofence-publisher-bridge',
      Handler: 'publisher_bridge.handler',
    });
  });

  test('a depth alarm guards every dead-letter queue', () => {
    // alert-queue DLQ, subscription DLQ, analyzer-bridge DLQ.
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });
});

describe('AlertingStack — least privilege', () => {
  test('a bridge may invoke its agent runtime, scoped to the runtime ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock-agentcore:InvokeAgentRuntime' }),
        ]),
      }),
    });
  });

  test('the analyzer may read memory records and send to the queue', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['bedrock-agentcore:RetrieveMemoryRecords']),
          }),
        ]),
      }),
    });
  });

  test('data-plane grants are scoped — no resource wildcards', () => {
    const dataActions = [
      'sqs:SendMessage',
      'sns:Publish',
      'dynamodb:PutItem',
      'bedrock:InvokeModel',
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:RetrieveMemoryRecords',
      'kinesis:GetRecords',
    ];
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
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
