import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';

/**
 * Telemetry ingestion.
 *
 * An IoT topic rule routes vehicle messages onto a durable Kinesis stream,
 * partitioned per vehicle, using a least-privilege role scoped to that stream.
 */
export class IngestionStack extends cdk.Stack {
  /** The per-vehicle-ordered telemetry log later increments read from. */
  public readonly telemetryStream: kinesis.Stream;

  /** Role the IoT topic rule assumes to write telemetry into the stream. */
  public readonly ruleRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // On-demand so capacity tracks the fleet automatically and there is no
    // provisioned-shard cost. The IoT topic rule sets the partition key to
    // ${vehicleId} to preserve per-vehicle ordering for the processor.
    this.telemetryStream = new kinesis.Stream(this, 'VehicleTelemetry', {
      streamName: 'vehicle-telemetry',
      streamMode: kinesis.StreamMode.ON_DEMAND,
    });

    // The IoT topic rule assumes this role to put records on the stream.
    // grantWrite scopes the policy to this stream's ARN (and its KMS key) only —
    // no resource wildcards.
    this.ruleRole = new iam.Role(this, 'TelemetryRuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Lets the telemetry topic rule write to the telemetry stream',
    });
    this.telemetryStream.grantWrite(this.ruleRole);

    // Route every vehicle message published to the iot_data topic onto the
    // stream, keyed by ${vehicleId} so each vehicle's records stay ordered on
    // one shard.
    new iot.CfnTopicRule(this, 'TelemetryToKinesis', {
      ruleName: 'VehicleTelemetryToKinesis',
      topicRulePayload: {
        sql: "SELECT * FROM 'iot_data'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            kinesis: {
              streamName: this.telemetryStream.streamName,
              partitionKey: '${vehicleId}',
              roleArn: this.ruleRole.roleArn,
            },
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'TelemetryStreamName', {
      value: this.telemetryStream.streamName,
      exportName: 'VehicleTelemetryStreamName',
    });
    new cdk.CfnOutput(this, 'TelemetryStreamArn', {
      value: this.telemetryStream.streamArn,
      exportName: 'VehicleTelemetryStreamArn',
    });
  }
}
