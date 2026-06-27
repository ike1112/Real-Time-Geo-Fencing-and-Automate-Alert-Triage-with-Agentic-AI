import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

/**
 * Telemetry ingestion.
 *
 * Currently provisions the durable Kinesis stream that vehicle telemetry lands
 * on. The IoT rule role and the IoT topic rule that publishes into it land in
 * follow-on changes.
 */
export class IngestionStack extends cdk.Stack {
  /** The per-vehicle-ordered telemetry log later increments read from. */
  public readonly telemetryStream: kinesis.Stream;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // On-demand so capacity tracks the fleet automatically and there is no
    // provisioned-shard cost. The IoT topic rule sets the partition key to
    // ${vehicleId} to preserve per-vehicle ordering for the processor.
    this.telemetryStream = new kinesis.Stream(this, 'VehicleTelemetry', {
      streamName: 'vehicle-telemetry',
      streamMode: kinesis.StreamMode.ON_DEMAND,
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
