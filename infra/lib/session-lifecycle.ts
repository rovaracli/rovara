import { resolve } from "node:path";
import { grantSigningKeySecrets } from "./signing-key-secrets.js";
import {
  Aws,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  type aws_cloudwatch_actions as cloudwatchActions,
  type aws_dynamodb as dynamodb,
  aws_iam as iam,
  type aws_kms as kms,
  type aws_lambda as lambda,
  aws_logs as logs,
  type aws_secretsmanager as secretsmanager,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_stepfunctions as sfn,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { BOOT_STAGE2_SHA256_PARAMETER, MODEL_PROXY_URL_PARAMETER, WORKER_SETTING_PARAMETERS } from "@rovara-code/contracts";
import { BrokerNames } from "./broker-names.js";
import { packagedFunction } from "./control-plane.js";
import { EC2_WORKER_AMI_PARAMETER } from "./ec2-workers.js";
import type { AgentXNaming } from "./naming.js";
import { deleterDefinition, provisionerDefinition } from "./session-state-machines.js";

export interface SessionLifecycleProps {
  naming: AgentXNaming;
  state: dynamodb.Table;
  invokeSigningKey: kms.IKey;
  notifyOperator: cloudwatchActions.SnsAction;
}

/**
 * The EC2 session lifecycle (issue #83, design in #76): the provisioner and deleter state machines
 * and the step Lambda they call. The foundation's EC2 values arrive as stack parameters (the release
 * and `agentx deploy` pass them from the foundation's outputs), so the control plane takes no
 * cross-stack export on the manually deployed foundation.
 */
export class SessionLifecycle extends Construct {
  readonly instanceRoleName: string;
  readonly provisioner: sfn.StateMachine;
  readonly deleter: sfn.StateMachine;
  readonly steps: lambda.Function;
  readonly reaper: lambda.Function;
  readonly reconciler: lambda.Function;
  private readonly naming: AgentXNaming;
  private readonly dispatcherSecurityGroupId: CfnParameter;
  readonly privateSubnetIds: CfnParameter;
  /** The EC2 workers' launch template, which a cloud org's projects are bound to. */
  readonly launchTemplateId: CfnParameter;
  private readonly invokeSigningKey: kms.IKey;
  private readonly notifyOperator: cloudwatchActions.SnsAction;

  constructor(scope: Construct, id: string, props: SessionLifecycleProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { naming } = props;
    this.naming = naming;
    this.invokeSigningKey = props.invokeSigningKey;
    this.notifyOperator = props.notifyOperator;
    // Parameter ids match the foundation outputs they are filled from.
    const parameter = (name: string, description: string, allowedPattern?: string) => new CfnParameter(stack, name, { type: "String", description, ...(allowedPattern === undefined ? {} : { allowedPattern }) });
    const privateSubnetIds = parameter("PrivateSubnetIds", "Comma-separated private subnet IDs of the foundation VPC");
    const sessionManagerSecurityGroupId = parameter("SessionManagerSecurityGroupId", "The foundation's session manager security group");
    this.dispatcherSecurityGroupId = parameter("DispatcherSecurityGroupId", "The foundation's dispatcher security group");
    this.privateSubnetIds = privateSubnetIds;
    const workspaceKmsKeyArn = parameter("WorkspaceKmsKeyArn", "The foundation's workspace volume KMS key");
    const instanceRoleArn = parameter("Ec2WorkerInstanceRoleArn", "The EC2 workers' instance role");
    // Foundation roles use / for legacy deployments and /agentx/<env>/ for named environments.
    // IAM inline-policy attachments require the name, without the role's path.
    this.instanceRoleName = Fn.select(naming.env === undefined ? 1 : 3, Fn.split("/", instanceRoleArn.valueAsString));
    const launchTemplateId = parameter("Ec2WorkerLaunchTemplateId", "The EC2 workers' launch template",
      // Named environments pack it into the broker's AGENTX_NAMES JSON unescaped (BrokerNames), so it carries the pattern of the id AWS gives; the legacy template is left as it was.
      naming.env === undefined ? undefined : "^lt-[0-9a-f]{17}$");
    this.launchTemplateId = launchTemplateId;

    // Named environments (Task 14): workers hold no provider keys or Bedrock access and call models through the
    // proxy, whose URL is one more setting. Launching a worker without it fails; the legacy function is unchanged.
    // The stage 2 boot hash (Task 10) is one more named-environment setting, beside the worker image it checks; the legacy function never reads it.
    const settingNames: string[] = [...Object.values(WORKER_SETTING_PARAMETERS), ...(naming.env === undefined ? [] : [MODEL_PROXY_URL_PARAMETER, BOOT_STAGE2_SHA256_PARAMETER])];
    // AUTOREQUALIFY AR-4: written by the requalifier (never by this construct's principals); read by
    // the provisioner (to launch from it) and the reconciler (to recycle workers on another AMI).
    const workerAmiParameterName = `${naming.ec2.workerSettingsPrefix}worker-qualified-ami`;
    const workerAmiParameterArn = `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${workerAmiParameterName}`;
    const settingParameterArns = settingNames.map((name) =>
      `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${naming.ec2.workerSettingsPrefix}${name}`);
    this.steps = packagedFunction(this, "Steps", "packages/broker/src/aws/session-steps.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      WORKER_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
      INVOKE_SIGNING_KEY_ARN: props.invokeSigningKey.keyArn,
      WORKER_LOG_GROUP_NAME: naming.ec2.workerLogGroupName,
      ...(naming.env === undefined ? {} : { MODEL_PROXY_REQUIRED: "true" }),
    }, Duration.seconds(30), [
      [resolve(process.cwd(), "packages/worker/ec2/boot.sh"), "boot.sh"],
      // The legacy deployment's single-file boot (ruling R58), rendered when no model proxy is required.
      [resolve(process.cwd(), "packages/worker/ec2/boot-legacy.sh"), "boot-legacy.sh"],
    ]);
    // The org of a workspace whose record names none: the machine time its compute used is counted against it.
    if (naming.env !== undefined) this.steps.addEnvironment("AGENTX_ENV", naming.env);
    // In the private subnets with the session manager's group: the only way to reach a worker's /ping.
    const inVpc = (fn: lambda.Function) => {
      (fn.node.defaultChild as lambda.CfnFunction).vpcConfig = {
        subnetIds: Fn.split(",", privateSubnetIds.valueAsString),
        securityGroupIds: [sessionManagerSecurityGroupId.valueAsString],
      };
      fn.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    };
    inVpc(this.steps);
    props.state.grantReadWriteData(this.steps);
    this.steps.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: settingParameterArns }));
    // Owner decision 123, review L4: the operator's kill switch for every company's internal address list (session-steps.ts PRIVATE_ADDRESSES_OFF_PARAMETER). Read only, one exact parameter; the operator creates it when needed.
    // Named environments only: the legacy deployment never carries a list, and its template stays as it was.
    if (naming.env !== undefined) {
      this.steps.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${naming.ec2.workerSettingsPrefix}private-addresses-off`],
      }));
    }
    this.steps.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:GetPublicKey"], resources: [props.invokeSigningKey.keyArn] }));

    const definitionProps = {
      stepsFunctionArn: this.steps.functionArn,
      workspaceKeyArn: workspaceKmsKeyArn.valueAsString,
      environmentTag: naming.environmentTagValue,
      ...(naming.env === undefined ? {} : { env: naming.env }),
      resourcePrefix: naming.resourcePrefix,
      workerAmiParameterName,
    };
    const ec2Arn = (resource: string) => `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;
    // Only instances and volumes this environment's session lifecycle created.
    const ownResources = { StringEquals: { "aws:ResourceTag/DeploymentMode": "ec2-ebs", "aws:ResourceTag/Environment": naming.environmentTagValue } };

    this.provisioner = this.stateMachine("Provisioner", provisionerDefinition(definitionProps), Duration.minutes(45), props.notifyOperator, [
      new iam.PolicyStatement({
        sid: "CreateWorkspaceVolume",
        actions: ["ec2:CreateVolume"],
        resources: [ec2Arn("volume/*")],
        conditions: { StringEquals: { "aws:RequestTag/DeploymentMode": "ec2-ebs", "aws:RequestTag/Environment": naming.environmentTagValue } },
      }),
      new iam.PolicyStatement({
        sid: "TagOnCreate",
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("volume/*"), ec2Arn("instance/*")],
        conditions: { StringEquals: { "ec2:CreateAction": ["CreateVolume", "RunInstances"] } },
      }),
      new iam.PolicyStatement({
        sid: "LaunchFromTemplate",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance/*")],
        conditions: { ArnEquals: { "ec2:LaunchTemplate": ec2Arn(`launch-template/${launchTemplateId.valueAsString}`) } },
      }),
      new iam.PolicyStatement({
        sid: "LaunchResources",
        actions: ["ec2:RunInstances"],
        resources: [
          ec2Arn(`launch-template/${launchTemplateId.valueAsString}`),
          ec2Arn("subnet/*"), ec2Arn("security-group/*"), ec2Arn("network-interface/*"), ec2Arn("volume/*"),
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "ResolveWorkerAmi",
        actions: ["ssm:GetParameters", "ssm:GetParameter"],
        resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}::parameter${EC2_WORKER_AMI_PARAMETER}`],
      }),
      new iam.PolicyStatement({
        sid: "ReadQualifiedWorkerAmi",
        actions: ["ssm:GetParameter"],
        resources: [workerAmiParameterArn],
      }),
      new iam.PolicyStatement({
        sid: "PassInstanceRole",
        actions: ["iam:PassRole"],
        resources: [instanceRoleArn.valueAsString],
        conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({
        sid: "AttachAndTerminateOwn",
        actions: ["ec2:AttachVolume", "ec2:TerminateInstances"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
        conditions: ownResources,
      }),
      // EBS encrypts the root and workspace volumes with the foundation's key on the caller's behalf.
      new iam.PolicyStatement({
        sid: "EncryptVolumes",
        actions: ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*"],
        resources: [workspaceKmsKeyArn.valueAsString],
      }),
    ]);
    this.deleter = this.stateMachine("Deleter", deleterDefinition(definitionProps), Duration.minutes(30), props.notifyOperator, [
      new iam.PolicyStatement({
        sid: "DeleteOwn",
        actions: ["ec2:TerminateInstances", "ec2:DeleteVolume"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
        conditions: ownResources,
      }),
    ]);

    // The idle reaper (#85): every minute, stops sessions idle over five minutes or older than 14
    // days, and finishes stopping ones whose instance is gone.
    this.reaper = packagedFunction(this, "Reaper", "packages/broker/src/aws/session-reaper.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      PROVISIONER_ARN: this.provisioner.stateMachineArn,
      DELETER_ARN: this.deleter.stateMachineArn,
      AGENTX_METRICS_NAMESPACE: naming.metricsNamespace,
    }, Duration.seconds(50));
    if (naming.env !== undefined) this.reaper.addEnvironment("AGENTX_ENV", naming.env);
    inVpc(this.reaper);
    // No reserved concurrency: an account whose concurrency limit is Lambda's minimum unreserved pool
    // (10) cannot reserve any. Overlapping runs are safe, because every transition is conditional, and
    // rare, because a run times out before the next one-minute tick.
    props.state.grantReadWriteData(this.reaper);
    this.provisioner.grantStartExecution(this.reaper);
    this.reaper.addToRolePolicy(new iam.PolicyStatement({ sid: "Describe", actions: ["ec2:DescribeInstances", "ec2:DescribeVolumes"], resources: ["*"] }));
    this.reaper.addToRolePolicy(new iam.PolicyStatement({
      sid: "TerminateOwn",
      actions: ["ec2:TerminateInstances"],
      resources: [ec2Arn("instance/*")],
      conditions: ownResources,
    }));
    new scheduler.Schedule(this, "ReaperSchedule", {
      description: "Runs the AgentX EC2 session idle reaper",
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(this.reaper, {}),
    });
    // Named environments: the same alarm also counts the reaper's own report (SessionsPrivateAddressRecycleErrors, review L4) of workers it could not check against a removed internal address (a company or launch record it could not
    // read): a failure on every run for 15 minutes either way. The legacy deployment's alarm stays as it was.
    const reaperErrors = this.reaper.metricErrors({ period: Duration.minutes(5), statistic: "Sum" });
    const reaperAlarmMetric = naming.env === undefined ? reaperErrors : new cloudwatch.MathExpression({
      expression: "FILL(errors, 0) + FILL(unchecked, 0)",
      usingMetrics: { errors: reaperErrors, unchecked: new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName: "SessionsPrivateAddressRecycleErrors", statistic: "Sum", period: Duration.minutes(5) }) },
      period: Duration.minutes(5),
    });
    new cloudwatch.Alarm(this, "ReaperErrorsAlarm", {
      alarmName: naming.alarmName("SessionReaperErrors"),
      alarmDescription: naming.env === undefined
        ? "The EC2 session idle reaper failed on every run for 15 minutes; idle workers are not being stopped. Check the reaper's logs."
        : "The EC2 session idle reaper failed on every run for 15 minutes, or could not check workers against a removed internal address; idle workers are not being stopped, or a removed address may still be open. Check the reaper's logs.",
      metric: reaperAlarmMetric,
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);

    // The reconciler (#86): every 10 minutes, repairs drift between this environment's ec2-ebs
    // instances and volumes and their SESSION items. It never deletes a volume it cannot tie to a
    // closed workspace; unclaimed ones are only tagged and alarmed (#22).
    this.reconciler = packagedFunction(this, "Reconciler", "packages/broker/src/aws/session-reconciler.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      PROVISIONER_ARN: this.provisioner.stateMachineArn,
      DELETER_ARN: this.deleter.stateMachineArn,
      ENVIRONMENT_TAG: naming.environmentTagValue,
      AGENTX_METRICS_NAMESPACE: naming.metricsNamespace,
      WORKER_QUALIFIED_AMI_PARAMETER: workerAmiParameterName,
    }, Duration.minutes(4));
    if (naming.env !== undefined) this.reconciler.addEnvironment("AGENTX_ENV", naming.env);
    inVpc(this.reconciler);
    props.state.grantReadWriteData(this.reconciler);
    this.provisioner.grantStartExecution(this.reconciler);
    this.provisioner.grantRead(this.reconciler);
    this.deleter.grantRead(this.reconciler);
    // Final review I3, named environments only (setup checks exist only there; the legacy templates stay as they were): the sweep of project setup
    // checks closes a stalled check's workspace, which starts the deleter for its session.
    if (naming.env !== undefined) this.deleter.grantStartExecution(this.reconciler);
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({ sid: "Describe", actions: ["ec2:DescribeInstances", "ec2:DescribeVolumes"], resources: ["*"] }));
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadQualifiedWorkerAmi", actions: ["ssm:GetParameter"], resources: [workerAmiParameterArn] }));
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: "RepairOwn",
      actions: ["ec2:TerminateInstances", "ec2:DeleteVolume"],
      resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
      conditions: ownResources,
    }));
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: "QuarantineOwnVolumes",
      actions: ["ec2:CreateTags"],
      resources: [ec2Arn("volume/*")],
      conditions: { ...ownResources, "ForAllValues:StringEquals": { "aws:TagKeys": ["agentx:quarantined"] } },
    }));
    new scheduler.Schedule(this, "ReconcilerSchedule", {
      description: "Runs the AgentX EC2 session reconciler",
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(10)),
      target: new schedulerTargets.LambdaInvoke(this.reconciler, {}),
    });
    const findingAlarm = (id: string, metricName: string, description: string) => new cloudwatch.Alarm(this, id, {
      alarmName: naming.alarmName(metricName),
      alarmDescription: description,
      metric: new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Maximum", period: Duration.minutes(15) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
    findingAlarm("QuarantinedVolumesAlarm", "ReconcilerQuarantinedVolumes",
      "An ec2-ebs workspace volume no session claims was tagged agentx:quarantined. It is never deleted automatically: find its workspace from its agentx:workspace tag and decide.");
    findingAlarm("LostInstancesAlarm", "ReconcilerLostInstances",
      "A READY EC2 worker's instance disappeared; its session was stopped and its running operation failed. Check the reconciler's logs and the instance's EC2 history.");
    findingAlarm("StuckProvisioningAlarm", "ReconcilerStuckProvisioning",
      "An EC2 session provisioning ended without finishing and was marked failed by the reconciler. Open the provisioner execution named in the reconciler's logs.");
    // AR-4 review M3: the pin could not be read (denied, throttled, malformed), so no stale worker is recycled and the next renewal's pin is not applied. Task machines still launch from today's image.
    findingAlarm("QualifiedAmiReadFailuresAlarm", "ReconcilerQualifiedAmiReadFailures",
      "The reconciler could not read the qualified worker AMI setting, so workers on an older image are not being recycled. Check the setting's value and the reconciler's logs (reconciler.qualified_ami_unreadable).");
    new cloudwatch.Alarm(this, "ReconcilerErrorsAlarm", {
      alarmName: naming.alarmName("SessionReconcilerErrors"),
      alarmDescription: "The EC2 session reconciler failed twice in a row; drift is not being repaired. Check the reconciler's logs.",
      metric: this.reconciler.metricErrors({ period: Duration.minutes(10), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);

    // Follow-up N4, named environments only (setup checks exist only there; the legacy templates stay as they were): a check the sweep cannot close
    // keeps its watch and its workspace slot. Two runs in a row (20 minutes) rules out a close that is just slow.
    if (naming.env !== undefined) {
      new cloudwatch.Alarm(this, "StuckSetupChecksAlarm", {
        alarmName: naming.alarmName("StuckSetupChecks"),
        alarmDescription: "The reconciler could not close a project setup check that is over 50 minutes old, on two runs in a row; the check still holds a workspace slot. Check the reconciler's logs for stuck_setup_check.close_failed and stuck_setup_check.kept events.",
        metric: new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName: "ReconcilerStuckSetupChecksKept", statistic: "Maximum", period: Duration.minutes(10) }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(props.notifyOperator);
    }

    new CfnOutput(stack, "SessionProvisionerArn", { value: this.provisioner.stateMachineArn });
    new CfnOutput(stack, "SessionDeleterArn", { value: this.deleter.stateMachineArn });
  }

  /**
   * The dispatcher delivers ec2-ebs work (#84): it runs in the private subnets with the foundation's
   * dispatcher security group, the only other group a worker's port admits, and starts provisioning.
   */
  connectDispatcher(dispatcher: lambda.Function): void {
    (dispatcher.node.defaultChild as lambda.CfnFunction).vpcConfig = {
      subnetIds: Fn.split(",", this.privateSubnetIds.valueAsString),
      securityGroupIds: [this.dispatcherSecurityGroupId.valueAsString],
    };
    dispatcher.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    this.connectExecutions(dispatcher);
    dispatcher.addEnvironment("INVOKE_SIGNING_KEY_ARN", this.invokeSigningKey.keyArn);
    this.provisioner.grantStartExecution(dispatcher);
  }

  /**
   * Issue 195, named environments only: the reconciler queues a stuck cancel again, once, in its own
   * process through the shared cancel code, signed with the key connectUnwaitedTaskBackstop gives it,
   * so it needs no grant. The alarm reports every stuck cancel retried or ended, and any failure.
   */
  connectStuckCancelAlarm(): void {
    const counted = (metricName: string) => new cloudwatch.Metric({ namespace: this.naming.metricsNamespace, metricName, statistic: "Maximum", period: Duration.minutes(15) });
    new cloudwatch.Alarm(this, "StuckCancelsAlarm", {
      alarmName: this.naming.alarmName("StuckCancels"),
      alarmDescription: "The reconciler found a task whose cancel never reached its worker, and queued the cancel again or ended the task (or failed to). Check the reconciler's logs for stuck_cancel events: a retried cancel that finishes, or an ended task, needs no action; repeated ones point at a dispatch or worker fault.",
      metric: new cloudwatch.MathExpression({
        // unretried stays 0 where the reconciler holds the signing key; it alarms if a named
        // environment ever loses it, so live workers' stuck cancels are never left unseen.
        expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0) + FILL(unretried, 0)",
        usingMetrics: {
          retries: counted("ReconcilerStuckCancelRetries"),
          ended: counted("ReconcilerStuckCancelsEnded"),
          interrupted: counted("ReconcilerStuckCancelsInterrupted"),
          failures: counted("ReconcilerStuckCancelFailures"),
          unretried: counted("ReconcilerStuckCancelsUnretried"),
        },
        period: Duration.minutes(15),
        label: "Stuck cancels retried, ended, failed or unretried",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(this.notifyOperator);
  }

  /**
   * Issue 173, named environments only: the reconciler stops a Slack thread's task idle over 24
   * hours with nobody waiting. It cancels through the shared cancel code, which writes the State
   * table (already granted; the outbox publisher dispatches the cancel) and signs the cancel's worker
   * callbacks with the callback signing key, as the broker does. It reads the thread's activeTurn by
   * key (THREAD# items only) and posts the thread's note with the bot token (the Slack secret alone).
   */
  connectUnwaitedTaskBackstop(slackThreads: dynamodb.Table, slackSecret: secretsmanager.Secret, env: string): void {
    this.reconciler.addEnvironment("SLACK_THREADS_TABLE_NAME", slackThreads.tableName);
    this.reconciler.addEnvironment("SLACK_SECRET_ARN", slackSecret.secretArn);
    // 0.5.15: the callback signing key is read from its secret (the reconciler builds the name from AGENTX_ENV), never passed as a variable. It signs cancels only (kind a).
    grantSigningKeySecrets(this.reconciler, this, env, ["callback"], "ReadCallbackSigningKey");
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadThreadWaiters",
      actions: ["dynamodb:GetItem"],
      resources: [slackThreads.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        // The activeTurn alone, never the thread's other fields. ForAllValues passes when
        // dynamodb:Attributes is absent, and GetItem has no Select, so a read without a
        // ProjectionExpression (which returns every attribute) is refused outright.
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "activeTurn"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        Null: { "dynamodb:Attributes": "false" },
      },
    }));
    this.reconciler.addToRolePolicy(new iam.PolicyStatement({ sid: "PostUnwaitedTaskNote", actions: ["secretsmanager:GetSecretValue"], resources: [slackSecret.secretArn] }));
    // A failed cancel or read is retried on the next run; failures on two runs in a row mean it is not recovering.
    const failures = (metricName: string) => new cloudwatch.Metric({ namespace: this.naming.metricsNamespace, metricName, statistic: "Maximum", period: Duration.minutes(10) });
    new cloudwatch.Alarm(this, "UnwaitedTaskFailuresAlarm", {
      alarmName: this.naming.alarmName("UnwaitedTaskFailures"),
      alarmDescription: "The reconciler could not check or cancel Slack tasks idle over 24 hours with nobody waiting, on two runs in a row. Check the reconciler's logs for unwaited_task.cancel_failed, unwaited_task.read_failed and reconciler.unwaited_task_sweep_failed.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(cancels, 0) + FILL(reads, 0)",
        usingMetrics: { cancels: failures("ReconcilerUnwaitedTaskFailures"), reads: failures("ReconcilerUnwaitedTaskReadFailures") },
        period: Duration.minutes(10),
        label: "Unwaited task cancel and read failures",
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(this.notifyOperator);
  }

  /** The broker starts the deleter when an ec2-ebs workspace closes (#84). */
  connectBroker(broker: lambda.Function): void {
    // A named environment's broker is given the state machines' names (BrokerNames), not their ARNs: its variables are held to Lambda's 4 KB,
    // and it builds the ARNs from the region and the account. The legacy install's broker keeps the ARNs.
    if (this.naming.env === undefined) {
      this.connectExecutions(broker);
    } else {
      const names = BrokerNames.of(broker);
      names.add("provisionerStateMachine", this.provisioner.stateMachineName);
      names.add("deleterStateMachine", this.deleter.stateMachineName);
    }
    this.deleter.grantStartExecution(broker);
  }

  private connectExecutions(fn: lambda.Function): void {
    fn.addEnvironment("PROVISIONER_ARN", this.provisioner.stateMachineArn);
    fn.addEnvironment("DELETER_ARN", this.deleter.stateMachineArn);
  }

  private stateMachine(
    id: string,
    definition: object,
    timeout: Duration,
    notifyOperator: cloudwatchActions.SnsAction,
    statements: iam.PolicyStatement[],
  ): sfn.StateMachine {
    const stack = Stack.of(this);
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
      description: `AgentX EC2 session ${id.toLowerCase()}`,
    });
    for (const statement of statements) role.addToPolicy(statement);
    role.addToPolicy(new iam.PolicyStatement({ sid: "Describe", actions: ["ec2:DescribeVolumes", "ec2:DescribeInstances"], resources: ["*"] }));
    this.steps.grantInvoke(role);
    const machine = new sfn.StateMachine(this, id, {
      definitionBody: sfn.DefinitionBody.fromString(stack.toJsonString(definition)),
      role,
      timeout,
      logs: {
        destination: new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    // Failed provisioning also marks the session FAILED, but the operator should know; a failed
    // deletion leaves a session DELETING and possibly a volume behind.
    new cloudwatch.Alarm(this, `${id}FailuresAlarm`, {
      alarmName: this.naming.alarmName(`Session${id}Failures`),
      alarmDescription: `An EC2 session ${id.toLowerCase()} execution failed or timed out. Open its execution in Step Functions for the failing step.`,
      metric: new cloudwatch.MathExpression({
        expression: "FILL(failed, 0) + FILL(timedOut, 0)",
        usingMetrics: { failed: machine.metricFailed({ period: Duration.minutes(5) }), timedOut: machine.metricTimedOut({ period: Duration.minutes(5) }) },
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    return machine;
  }
}
