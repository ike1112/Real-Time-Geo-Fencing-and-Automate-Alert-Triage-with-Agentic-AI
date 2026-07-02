import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ObservabilityStack } from '../lib/observability-stack';

const app = new cdk.App();
// A concrete region resolves this.region to a literal, so DashboardBody is a plain
// JSON string (not an Fn::Join over {Ref: AWS::Region}) and is assertable by content.
const stack = new ObservabilityStack(app, 'TestObservabilityStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

describe('ObservabilityStack — dashboard', () => {
  test('one dashboard carries a labeled row per hop and the stacked latency widget', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    const body = Object.values(dashboards)[0].Properties.DashboardBody as string;
    for (const hop of ['H1 IoT', 'H3 telemetry', 'H4/H5 Flink', 'H6 alerts', 'H7 triage']) {
      expect(body).toContain(hop);
    }
    expect(body).toContain('"stacked":true');          // the Layer-2 accumulation widget
    expect(body).toContain('Geofence/Latency');
  });

  test('per-shard iterator age uses a SEARCH expression (survives shard churn)', () => {
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    const body = Object.values(dashboards)[0].Properties.DashboardBody as string;
    expect(body).toContain('SEARCH(');
    expect(body).toContain('GetRecords.IteratorAgeMilliseconds');
  });
});

describe('ObservabilityStack — alarms (AC4)', () => {
  test('iterator-age alarms exist for both streams', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'GetRecords.IteratorAgeMilliseconds',
      Namespace: 'AWS/Kinesis',
      Threshold: 60000,
    });
  });

  test('Flink alarms: behind-latest, backpressure, failed checkpoints, downtime', () => {
    for (const metricName of [
      'millisBehindLatest', 'backPressuredTimeMsPerSecond', 'numberOfFailedCheckpoints', 'downtime',
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: metricName,
        Namespace: 'AWS/KinesisAnalytics',
      });
    }
  });

  test('write-throughput-exceeded canary alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'WriteProvisionedThroughputExceeded',
      Namespace: 'AWS/Kinesis',
    });
  });

  test('DLQ depth alarm for the rules bridge', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: 'QueueName', Value: 'geofence-rules-bridge-dlq' }),
      ]),
    });
  });

  test('per-track latency SLO alarm on the detection total (p99)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'DetectionTotal',
      Namespace: 'Geofence/Latency',
      ExtendedStatistic: 'p99',
      Threshold: 5000,
    });
  });

  test('the alarm fleet is present', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 9);
  });
});
