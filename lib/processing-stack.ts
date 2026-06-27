import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

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
  }
}
