import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Geofence processing.
 *
 * Holds the zone store and the breach-event stream. Zones live in a DynamoDB
 * table with change streams enabled so edits can be propagated to the processor
 * in near-real-time; breach events land on a durable stream the triage layer
 * reads. The processor itself (stream job + rule-change bridge) is added next.
 */
export class ProcessingStack extends cdk.Stack {
  /** Runtime-editable zone definitions; change streams drive live updates. */
  public readonly geoFencesTable: dynamodb.Table;

  /** Factual breach events the triage layer consumes. */
  public readonly alertsStream: kinesis.Stream;

  /** Zone edits, captured from the table's change stream, for the processor. */
  public readonly rulesStream: kinesis.Stream;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.geoFencesTable = new dynamodb.Table(this, 'GeoFences', {
      tableName: 'geo-fences',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // Dev: tear down cleanly. Production would retain the zone store.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.alertsStream = new kinesis.Stream(this, 'GeofenceAlerts', {
      streamName: 'geofence-alerts',
      streamMode: kinesis.StreamMode.ON_DEMAND,
    });
    this.alertsStream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Zone edits flow table -> change stream -> this bridge -> rules stream, so the
    // processor can update its active zone set live. Partition key is the zone id.
    this.rulesStream = new kinesis.Stream(this, 'GeofenceRules', {
      streamName: 'geofence-rules',
      streamMode: kinesis.StreamMode.ON_DEMAND,
    });
    this.rulesStream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const rulesBridge = new lambda.Function(this, 'RulesBridge', {
      functionName: 'geofence-rules-bridge',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      // Ship only the handler — keep tests and caches out of the deployed package.
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'rules_bridge'), {
        exclude: ['test_*.py', '__pycache__', '*.pyc'],
      }),
      timeout: cdk.Duration.seconds(30),
      environment: { RULES_STREAM_NAME: this.rulesStream.streamName },
    });
    this.rulesStream.grantWrite(rulesBridge);

    // A poison rule-change that exhausts retries lands here instead of blocking
    // the shard or vanishing.
    const rulesBridgeDlq = new sqs.Queue(this, 'RulesBridgeDlq', {
      queueName: 'geofence-rules-bridge-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Read the zone-store change stream from the latest position; the broadcast
    // bootstrap (replaying current rules on processor start) is handled later.
    // Partial-batch reporting + bisect isolate a bad record so one poison change
    // doesn't replay the whole batch to expiry; the DLQ catches what still fails.
    rulesBridge.addEventSource(
      new DynamoEventSource(this.geoFencesTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        maxRecordAge: cdk.Duration.hours(1),
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(rulesBridgeDlq),
      }),
    );

    new cdk.CfnOutput(this, 'GeoFencesTableName', {
      value: this.geoFencesTable.tableName,
      exportName: 'GeoFencesTableName',
    });
    new cdk.CfnOutput(this, 'GeofenceAlertsStreamName', {
      value: this.alertsStream.streamName,
      exportName: 'GeofenceAlertsStreamName',
    });
    new cdk.CfnOutput(this, 'GeofenceAlertsStreamArn', {
      value: this.alertsStream.streamArn,
      exportName: 'GeofenceAlertsStreamArn',
    });
    new cdk.CfnOutput(this, 'GeofenceRulesStreamName', {
      value: this.rulesStream.streamName,
      exportName: 'GeofenceRulesStreamName',
    });
  }
}
