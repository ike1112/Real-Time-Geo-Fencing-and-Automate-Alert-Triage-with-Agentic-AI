import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/**
 * Pipeline observability — two layers over the 001/002/003 resources.
 *
 * Layer 1 (component health): a CloudWatch dashboard with one row per hop (H1 IoT →
 * H7 triage), from metrics the services already emit. Layer 2 (latency accumulation):
 * a stacked widget of the detection vs triage tracks, fed by the in-band `trace`
 * stamps (probe/Flink) and the triage EMF. Alarms cover the on-demand streaming
 * tripwires. Metrics are referenced by namespace/dimension (not construct refs) so
 * this stack stays decoupled and deploys/tears down on its own.
 */
export interface ObservabilityStackProps extends cdk.StackProps {
  readonly telemetryStreamName?: string;
  readonly alertsStreamName?: string;
  readonly flinkAppName?: string;
  /** DLQ this stack owns the depth alarm for (002's; 003's DLQs alarm in AlertingStack). */
  readonly rulesBridgeDlqName?: string;
  /** Detection-track SLO (t0->alerts) in ms; alarms when p99 exceeds it. */
  readonly detectionSloMs?: number;
}

const LATENCY_NAMESPACE = 'Geofence/Latency';

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps = {}) {
    super(scope, id, props);

    const telemetryStream = props.telemetryStreamName ?? 'vehicle-telemetry';
    const alertsStream = props.alertsStreamName ?? 'geofence-alerts';
    const flinkApp = props.flinkAppName ?? 'geofence-processor';
    const rulesBridgeDlq = props.rulesBridgeDlqName ?? 'geofence-rules-bridge-dlq';
    const detectionSloMs = props.detectionSloMs ?? 5000;

    const period = cdk.Duration.minutes(1);
    const kinesis = (metricName: string, stream: string, statistic = 'Maximum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/Kinesis', metricName, statistic, period,
        dimensionsMap: { StreamName: stream },
      });
    const flink = (metricName: string, statistic = 'Maximum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/KinesisAnalytics', metricName, statistic, period,
        dimensionsMap: { Application: flinkApp },
      });
    const latency = (metricName: string, stage: string, statistic = 'p99') =>
      new cloudwatch.Metric({
        namespace: LATENCY_NAMESPACE, metricName, statistic, period,
        dimensionsMap: { stage },
      });

    // --- Alarms (AC4): the on-demand streaming tripwires. ---
    const alarms: Array<[string, cloudwatch.IMetric, number, cloudwatch.ComparisonOperator]> = [
      // Consumer lag on each stream (iterator age).
      ['TelemetryIteratorAge', kinesis('GetRecords.IteratorAgeMilliseconds', telemetryStream), 60000,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
      ['AlertsIteratorAge', kinesis('GetRecords.IteratorAgeMilliseconds', alertsStream), 60000,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
      // Flink falling behind / backpressured / failing checkpoints / down.
      ['FlinkMillisBehindLatest', flink('millisBehindLatest'), 60000,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
      ['FlinkBackpressure', flink('backPressuredTimeMsPerSecond'), 500,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
      ['FlinkFailedCheckpoints', flink('numberOfFailedCheckpoints', 'Sum'), 1,
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD],
      ['FlinkDowntime', flink('downtime'), 0,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
      // On-demand canary: still fires on burst-beyond-2x-peak or a hot key.
      ['WriteThroughputExceededCanary', kinesis('WriteProvisionedThroughputExceeded', telemetryStream, 'Sum'), 1,
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD],
      // DLQ depth for the rules bridge (003's DLQs alarm in AlertingStack).
      ['RulesBridgeDlqDepth', new cloudwatch.Metric({
        namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible',
        statistic: 'Maximum', period, dimensionsMap: { QueueName: rulesBridgeDlq },
      }), 1, cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD],
      // Per-track latency SLO breach (detection track).
      ['DetectionLatencySlo', latency('DetectionTotal', 'detection'), detectionSloMs,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD],
    ];
    for (const [name, metric, threshold, comparisonOperator] of alarms) {
      new cloudwatch.Alarm(this, name, {
        alarmName: `geofence-${name}`,
        metric,
        threshold,
        comparisonOperator,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // --- Dashboard (AC1): one Layer-1 row per hop + the Layer-2 stacked widget. ---
    // Per-shard iterator age uses a SEARCH expression so it survives on-demand shard
    // churn (no pinned shard ids).
    const iteratorAgeSearch =
      `SEARCH('{AWS/Kinesis,StreamName} MetricName="GetRecords.IteratorAgeMilliseconds" StreamName="${telemetryStream}"', 'Maximum', 60)`;

    const metricWidget = (title: string, metrics: unknown[], y: number, stacked = false) => ({
      type: 'metric', x: 0, y, width: 24, height: 4,
      properties: { title, region: this.region, view: 'timeSeries', stacked, metrics },
    });

    const widgets = [
      // Layer 1 — health, one row per hop.
      metricWidget('H1 IoT — rules executed / errors', [
        ['AWS/IoT', 'RuleMessageThrottled', 'RuleName', 'VehicleTelemetryToKinesis'],
        ['AWS/IoT', 'TopicMatch', 'RuleName', 'VehicleTelemetryToKinesis'],
      ], 0),
      metricWidget('H3 telemetry stream — iterator age (MAX across shards)', [
        [{ expression: iteratorAgeSearch, label: 'IteratorAge/shard', id: 'e1' }],
      ], 4),
      metricWidget('H4/H5 Flink — behind / backpressure / checkpoints', [
        ['AWS/KinesisAnalytics', 'millisBehindLatest', 'Application', flinkApp],
        ['AWS/KinesisAnalytics', 'backPressuredTimeMsPerSecond', 'Application', flinkApp],
        ['AWS/KinesisAnalytics', 'numberOfFailedCheckpoints', 'Application', flinkApp],
      ], 8),
      metricWidget('H6 alerts stream — iterator age', [
        ['AWS/Kinesis', 'GetRecords.IteratorAgeMilliseconds', 'StreamName', alertsStream],
      ], 12),
      metricWidget('H7 triage — SQS age / DLQ depth / SNS', [
        ['AWS/SQS', 'ApproximateAgeOfOldestMessage', 'QueueName', 'geofence-alert-queue'],
        ['AWS/SQS', 'ApproximateNumberOfMessagesVisible', 'QueueName', 'geofence-alert-queue-dlq'],
      ], 16),
      // Layer 2 — stacked latency accumulation: detection vs triage tracks.
      metricWidget('Latency accumulation (stacked) — detection vs triage', [
        [LATENCY_NAMESPACE, 'FlinkProcess', 'stage', 'detection'],
        [LATENCY_NAMESPACE, 'DetectionTotal', 'stage', 'detection'],
        [LATENCY_NAMESPACE, 'TriageBedrock', 'stage', 'analyzer'],
        [LATENCY_NAMESPACE, 'NotifyTotal', 'stage', 'publisher'],
      ], 20, true),
    ];

    new cloudwatch.CfnDashboard(this, 'PipelineDashboard', {
      dashboardName: 'geofence-pipeline',
      dashboardBody: JSON.stringify({ widgets }),
    });
  }
}
