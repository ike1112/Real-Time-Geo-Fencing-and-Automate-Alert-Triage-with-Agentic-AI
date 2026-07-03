import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { CfnMemory, CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { KinesisEventSource, SqsEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Agentic alert triage and delivery.
 *
 * Reads the factual breach stream from the processing stack and turns it into
 * human-worthy alerts: an Analyzer agent (with per-vehicle memory) decides
 * act/suppress + severity and forwards only HIGH/CRITICAL; a Publisher agent
 * composes a four-section message and delivers it, exactly once per breach. Both
 * agents are Amazon Bedrock AgentCore runtimes declared as native IaC, so they
 * deploy and tear down with the stack — no CLI/console step.
 */
export interface AlertingStackProps extends cdk.StackProps {
  /** Factual breach events from the processing stack (geofence-alerts). */
  readonly alertsStream: kinesis.IStream;
}

export class AlertingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlertingStackProps) {
    super(scope, id, props);

    // --- Deploy-time configuration (no code changes to retarget model or recipient). ---
    // Cross-region inference-profile ids ("us." prefix) give throttling headroom
    // (finding R5); confirm the exact ids and Bedrock region availability at deploy.
    const analyzerModelId = this.node.tryGetContext('analyzerModelId')
      ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const publisherModelId = this.node.tryGetContext('publisherModelId')
      ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const alertEmail = this.node.tryGetContext('alertEmail') ?? 'alerts@example.com';
    const memoryExpiryDays = Number(this.node.tryGetContext('memoryExpiryDays') ?? 90);

    // --- Delivery buffer: SQS with a dead-letter queue (findings R3). ---
    const alertDlq = new sqs.Queue(this, 'AlertQueueDlq', {
      queueName: 'geofence-alert-queue-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });
    const alertQueue = new sqs.Queue(this, 'AlertQueue', {
      queueName: 'geofence-alert-queue',
      visibilityTimeout: cdk.Duration.seconds(120),
      // A message the publisher cannot deliver after a few tries lands in the DLQ
      // instead of looping forever.
      deadLetterQueue: { queue: alertDlq, maxReceiveCount: 5 },
    });

    // --- Responder channel: SNS topic + email, with a subscription DLQ (R3). ---
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'geofence-alerts-topic',
      displayName: 'Geofence alerts',
    });
    const subscriptionDlq = new sqs.Queue(this, 'SubscriptionDlq', {
      queueName: 'geofence-alerts-subscription-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });
    alertsTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail, {
      deadLetterQueue: subscriptionDlq,
    }));

    // --- Single-delivery ledger: dedupe keys claimed with a conditional write (R4/AC5). ---
    const idempotencyTable = new dynamodb.Table(this, 'PublishedAlerts', {
      tableName: 'geofence-published-alerts',
      partitionKey: { name: 'dedupeKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Per-vehicle memory (AgentCore Memory, native IaC). ---
    // The execution role lets AgentCore run the semantic-extraction model for the
    // memory strategies.
    const memoryRole = new iam.Role(this, 'MemoryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Lets AgentCore Memory run extraction for the geofence strategies',
    });
    memoryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:*::foundation-model/*`],
    }));
    const memory = new CfnMemory(this, 'VehicleMemory', {
      name: 'geofence_vehicle_memory',
      eventExpiryDuration: memoryExpiryDays,
      memoryExecutionRoleArn: memoryRole.roleArn,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: 'ViolationPatterns',
            namespaces: ['/violations/{actorId}'],
          },
        },
        {
          summaryMemoryStrategy: {
            name: 'SessionSummary',
            namespaces: ['/summaries/{actorId}/{sessionId}'],
          },
        },
      ],
    });

    // Cross-region inference: allow invoking foundation models and the inference
    // profiles that route to them. Scoped to Bedrock ARNs, never Resource "*". A
    // fresh statement per role (statements are not shared across policies).
    const invokeModel = () => new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/*`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    });

    // An AgentCore runtime's execution role must write its own logs and (with OTEL
    // tracing on) export X-Ray segments. ECR pull is granted per-image below.
    const runtimeObservability = () => new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams',
        'xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets',
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
    });

    // --- Alert Analyzer runtime (memory + gate + SQS forward). ---
    const analyzerImage = new DockerImageAsset(this, 'AnalyzerImage', {
      directory: path.join(__dirname, '..', 'agents'),
      file: path.join('analyzer', 'Dockerfile'),
      platform: Platform.LINUX_ARM64,
    });
    const analyzerRole = new iam.Role(this, 'AnalyzerRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Analyzer runtime: invoke model, read/write memory, forward to the queue',
    });
    analyzerRole.addToPolicy(invokeModel());
    analyzerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:ListMemoryRecords',
      ],
      resources: [memory.attrMemoryArn, `${memory.attrMemoryArn}/*`],
    }));
    alertQueue.grantSendMessages(analyzerRole);
    analyzerImage.repository.grantPull(analyzerRole);   // AgentCore validates image pull at create
    analyzerRole.addToPolicy(runtimeObservability());

    const analyzerRuntime = new CfnRuntime(this, 'AnalyzerRuntime', {
      agentRuntimeName: 'geofence_alert_analyzer',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: analyzerImage.imageUri },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      roleArn: analyzerRole.roleArn,
      environmentVariables: {
        BEDROCK_MODEL_ID: analyzerModelId,
        MEMORY_ID: memory.attrMemoryId,
        ALERT_QUEUE_URL: alertQueue.queueUrl,
        OTEL_TRACES_SAMPLER: 'always_on',
      },
    });
    // AgentCore validates the role can pull the image at create time, so the runtime
    // must be created only AFTER the role's ECR-pull policy is attached (the roleArn
    // reference alone does not order against the role's inline policy).
    analyzerRuntime.node.addDependency(analyzerRole);

    // --- Alert Publisher runtime (compose + idempotent SNS publish, no memory). ---
    const publisherImage = new DockerImageAsset(this, 'PublisherImage', {
      directory: path.join(__dirname, '..', 'agents'),
      file: path.join('publisher', 'Dockerfile'),
      platform: Platform.LINUX_ARM64,
    });
    const publisherRole = new iam.Role(this, 'PublisherRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Publisher runtime: invoke model, claim dedupe key, publish to SNS',
    });
    publisherRole.addToPolicy(invokeModel());
    alertsTopic.grantPublish(publisherRole);
    idempotencyTable.grantWriteData(publisherRole);
    publisherImage.repository.grantPull(publisherRole);   // AgentCore validates image pull at create
    publisherRole.addToPolicy(runtimeObservability());

    const publisherRuntime = new CfnRuntime(this, 'PublisherRuntime', {
      agentRuntimeName: 'geofence_alert_publisher',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: publisherImage.imageUri },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      roleArn: publisherRole.roleArn,
      environmentVariables: {
        BEDROCK_MODEL_ID: publisherModelId,
        ALERTS_TOPIC_ARN: alertsTopic.topicArn,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        OTEL_TRACES_SAMPLER: 'always_on',
      },
    });
    publisherRuntime.node.addDependency(publisherRole);   // create after ECR-pull policy attaches

    // --- Analyzer bridge: geofence-alerts (Kinesis) -> InvokeAgentRuntime. ---
    const analyzerBridge = new lambda.Function(this, 'AnalyzerBridge', {
      functionName: 'geofence-analyzer-bridge',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'analyzer_bridge.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'analyzer_bridge'), {
        exclude: ['test_*.py', '__pycache__', '*.pyc'],
      }),
      timeout: cdk.Duration.seconds(60),
      environment: { ANALYZER_RUNTIME_ARN: analyzerRuntime.attrAgentRuntimeArn },
    });
    analyzerBridge.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [analyzerRuntime.attrAgentRuntimeArn, `${analyzerRuntime.attrAgentRuntimeArn}/*`],
    }));
    // Partial-batch reporting + on-failure DLQ so one poison breach doesn't replay
    // the whole batch to expiry (finding R1).
    const analyzerBridgeDlq = new sqs.Queue(this, 'AnalyzerBridgeDlq', {
      queueName: 'geofence-analyzer-bridge-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });
    analyzerBridge.addEventSource(new KinesisEventSource(props.alertsStream, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 3,
      bisectBatchOnError: true,
      reportBatchItemFailures: true,
      onFailure: new SqsDlq(analyzerBridgeDlq),
    }));

    // --- Publisher bridge: alert-queue (SQS) -> InvokeAgentRuntime. ---
    const publisherBridge = new lambda.Function(this, 'PublisherBridge', {
      functionName: 'geofence-publisher-bridge',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'publisher_bridge.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'publisher_bridge'), {
        exclude: ['test_*.py', '__pycache__', '*.pyc'],
      }),
      timeout: cdk.Duration.seconds(60),
      environment: { PUBLISHER_RUNTIME_ARN: publisherRuntime.attrAgentRuntimeArn },
    });
    publisherBridge.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [publisherRuntime.attrAgentRuntimeArn, `${publisherRuntime.attrAgentRuntimeArn}/*`],
    }));
    publisherBridge.addEventSource(new SqsEventSource(alertQueue, {
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      reportBatchItemFailures: true,
    }));

    // --- Alarms on every dead-letter queue so a failure is observable (R3). ---
    for (const [name, queue] of [
      ['AlertQueueDlqAlarm', alertDlq],
      ['SubscriptionDlqAlarm', subscriptionDlq],
      ['AnalyzerBridgeDlqAlarm', analyzerBridgeDlq],
    ] as const) {
      new cloudwatch.Alarm(this, name, {
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `Messages present in ${queue.queueName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    new cdk.CfnOutput(this, 'AlertQueueUrl', { value: alertQueue.queueUrl });
    new cdk.CfnOutput(this, 'AlertsTopicArn', { value: alertsTopic.topicArn });
    new cdk.CfnOutput(this, 'AnalyzerRuntimeArn', { value: analyzerRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'PublisherRuntimeArn', { value: publisherRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'VehicleMemoryId', { value: memory.attrMemoryId });
  }
}
