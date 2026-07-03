import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesisanalyticsv2 from 'aws-cdk-lib/aws-kinesisanalyticsv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import { buildZoneItems, toDynamoItem } from '../tools/seed-zones';

/**
 * Geofence processing.
 *
 * Holds the zone store and the breach-event stream. Zones live in a DynamoDB
 * table with change streams enabled so edits can be propagated to the processor
 * in near-real-time; breach events land on a durable stream the triage layer
 * reads. The processor itself (stream job + rule-change bridge) is added next.
 */
export interface ProcessingStackProps extends cdk.StackProps {
  /** Telemetry stream from the ingestion stack that the processor reads. */
  readonly telemetryStream: kinesis.IStream;
}

export class ProcessingStack extends cdk.Stack {
  /** Runtime-editable zone definitions; change streams drive live updates. */
  public readonly geoFencesTable: dynamodb.Table;

  /** Factual breach events the triage layer consumes. */
  public readonly alertsStream: kinesis.Stream;

  /** Zone edits, captured from the table's change stream, for the processor. */
  public readonly rulesStream: kinesis.Stream;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    const geoFencesTableName = 'geo-fences';
    this.geoFencesTable = new dynamodb.Table(this, 'GeoFences', {
      tableName: geoFencesTableName,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // Dev: tear down cleanly. Production would retain the zone store.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Seed the four canonical zones on deploy so the store is populated without a
    // manual step. batchWriteItem uses PutRequest, so re-deploys refresh the items
    // idempotently. Zone geometry comes from the simulator's canonical definitions.
    const seedRequest = {
      RequestItems: {
        [geoFencesTableName]: buildZoneItems().map((item) => ({
          PutRequest: { Item: toDynamoItem(item) },
        })),
      },
    };
    new cr.AwsCustomResource(this, 'SeedZones', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: seedRequest,
        physicalResourceId: cr.PhysicalResourceId.of('geo-fences-zone-seed'),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: seedRequest,
        physicalResourceId: cr.PhysicalResourceId.of('geo-fences-zone-seed'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.geoFencesTable.tableArn],
      }),
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

    // Package the PyFlink job + its pure libraries as the application artifact.
    // Tests/caches are excluded; the Kinesis connector jar is added to the zip at
    // build time for deployment.
    const processorCode = new Asset(this, 'ProcessorCode', {
      path: path.join(__dirname, '..', 'processor'),
      exclude: ['**/test_*.py', '**/__pycache__', '**/*.pyc'],
    });

    // The processor reads both input streams and writes the alert stream. Least
    // privilege: it consumes zone edits via the geofence-rules stream, not the
    // table, so it gets no table permission.
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('kinesisanalytics.amazonaws.com'),
      description: 'Lets the geofence Flink app read telemetry/rules and write alerts',
    });
    props.telemetryStream.grantRead(processorRole);
    this.rulesStream.grantRead(processorRole);
    this.alertsStream.grantWrite(processorRole);
    processorCode.grantRead(processorRole);

    const flinkApp = new kinesisanalyticsv2.CfnApplication(this, 'GeofenceProcessor', {
      applicationName: 'geofence-processor',
      runtimeEnvironment: 'FLINK-1_20',
      serviceExecutionRole: processorRole.roleArn,
      applicationConfiguration: {
        applicationCodeConfiguration: {
          codeContentType: 'ZIPFILE',
          codeContent: {
            s3ContentLocation: {
              bucketArn: processorCode.bucket.bucketArn,
              fileKey: processorCode.s3ObjectKey,
            },
          },
        },
        environmentProperties: {
          propertyGroups: [
            {
              propertyGroupId: 'kinesis.analytics.flink.run.options',
              propertyMap: {
                python: 'geofence/job.py',
                // Kinesis connector jar, added to the artifact at build time.
                jarfile: 'lib/flink-sql-connector-kinesis.jar',
              },
            },
            {
              propertyGroupId: 'geofence.streams',
              propertyMap: {
                region: this.region,
                telemetryStream: props.telemetryStream.streamName,
                rulesStream: this.rulesStream.streamName,
                alertsStream: this.alertsStream.streamName,
              },
            },
          ],
        },
        flinkApplicationConfiguration: {
          // Checkpointing for fault recovery; snapshots for exactly-once across
          // updates and scaling. Set here at the app-config level — MSF does not
          // allow checkpoint/parallelism config in the job code.
          checkpointConfiguration: {
            configurationType: 'CUSTOM',
            checkpointingEnabled: true,
            checkpointInterval: 60000,
            minPauseBetweenCheckpoints: 5000,
          },
          monitoringConfiguration: {
            configurationType: 'CUSTOM',
            logLevel: 'INFO',
            metricsLevel: 'APPLICATION',
          },
          parallelismConfiguration: {
            configurationType: 'CUSTOM',
            parallelism: 1,
            parallelismPerKpu: 1,
            autoScalingEnabled: false,
          },
        },
        applicationSnapshotConfiguration: {
          snapshotsEnabled: true,
        },
      },
    });

    // Managed Flink validates it can read the code zip with the execution role at
    // create time, so the app must be created only AFTER the role's S3-read policy is
    // attached. The roleArn reference alone does not order against the role's inline
    // policy, so make the dependency explicit to avoid an asset-read race on deploy.
    flinkApp.node.addDependency(processorRole);

    // Deliver the Flink job's logs to CloudWatch so startup/runtime errors are
    // visible (without this the app fails silently back to READY). The service role
    // writes the log events.
    const processorLogGroup = new logs.LogGroup(this, 'ProcessorLogs', {
      logGroupName: '/aws/kinesis-analytics/geofence-processor',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const processorLogStream = new logs.LogStream(this, 'ProcessorLogStream', {
      logGroup: processorLogGroup,
      logStreamName: 'flink-job',
    });
    processorLogGroup.grantWrite(processorRole);
    new kinesisanalyticsv2.CfnApplicationCloudWatchLoggingOption(this, 'ProcessorLogging', {
      applicationName: flinkApp.ref,
      cloudWatchLoggingOption: {
        logStreamArn: this.formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: `${processorLogGroup.logGroupName}:log-stream:${processorLogStream.logStreamName}`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      },
    });

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
