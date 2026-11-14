// The core engine switch's deployment half (0.5.19, DEFERRED S0-CC-INFRA-UNWIRED, A4-SWITCH-ON-PRECONDITIONS M2, S3-ENTRY-NEEDS 3 and 4). Named environments only: the legacy template has none of it.
//
// What is here:
//   - the core dispatch queue and its dead-letter queue, with a redrive limit above the core's own retry budget (CORE_DISPATCH_MAX_RECEIVES >= 21). Fixed names (derived-names.ts), so the broker builds both URLs and
//     is passed nothing. The broker may send to, receive from, delete from and change the visibility of the queue (the core's `queue` point runs inside the broker's entry) and the dead letters (receive and delete,
//     for a redrive or a purge). The dispatcher is the queue's consumer (S3-10, `connectDispatcher`): an event source mapping of its own, ENABLED only while `cc` is not
//     `off`, so a core message never reaches Cloud's own dispatch code;
//   - a schedule per scheduled row of the core's job table (CORE_JOB_SCHEDULES), in a group of their own, that invokes the broker with `{ source: "agentx.core-job", job: <name> }` through a role of its own. The role is
//     created under the environment's path with a generated name (no fixed-name role, so no new line in either boundary), trusts only the scheduler for THIS group, and can invoke the broker function and nothing else.
//     The schedules always exist and are ENABLED only while the `cc` parameter is not `off`: switching on or off changes a state, never creates or deletes a resource. A disabled schedule costs nothing;
//   - an alarm on the dead-letter queue.
//
// None of this runs a core job or moves a task: the broker answers a scheduled core job `{ skipped: "off" }` while `cc` is off, and the dispatch queue stays empty until a task starts on the core.
import { CfnCondition, Duration, Fn, Stack, Token, aws_cloudwatch as cloudwatch, aws_iam as iam, aws_lambda as lambda, aws_scheduler as scheduler, aws_sqs as sqs, type CfnParameter, type aws_cloudwatch_actions as cloudwatchActions } from "aws-cdk-lib";
import { Construct } from "constructs";
import { BROKER_SETTINGS, CORE_DISPATCH_MAX_RECEIVES, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, coreDispatchDeadLetterName, coreDispatchQueueName, type CoreJobSchedule } from "@agentx/cloud-contracts";
import { BrokerSettings } from "./broker-names.js";
import type { AgentXNaming } from "./naming.js";

/** What the dispatcher may do on the core dispatch queue: the event source mapping's reads, and the core's own visibility extension of a message it will try again. */
export const CORE_DISPATCHER_QUEUE_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"] as const;


export interface CoreEngineProps {
  readonly naming: AgentXNaming;
  /** The environment's name (a named environment only). */
  readonly env: string;
  /** The broker function: the schedules' target, and the principal that uses the queues. */
  readonly broker: lambda.Function;
  /** The `cc` stack parameter (CoreEngine). */
  readonly coreEngine: CfnParameter;
  readonly notifyOperator: cloudwatchActions.SnsAction;
}

/** The queue's visibility timeout. Like Cloud's DispatchQueue; the core extends it per message while a step starts (changeVisibility). */
export const CORE_DISPATCH_VISIBILITY_TIMEOUT = Duration.minutes(2);

export class CoreEngine extends Construct {
  readonly queue: sqs.Queue;
  readonly deadLetters: sqs.Queue;
  readonly scheduleGroup: scheduler.CfnScheduleGroup;
  readonly invokeRole: iam.Role;
  readonly schedules: scheduler.CfnSchedule[] = [];
  readonly isOn: CfnCondition;
  private readonly brokerFunctionArn: string;
  private readonly coreEngine: CfnParameter;

  constructor(scope: Construct, id: string, props: CoreEngineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env, broker } = props;
    this.brokerFunctionArn = broker.functionArn;
    this.coreEngine = props.coreEngine;
    if (new Set(CORE_JOB_SCHEDULES.map((entry) => entry.job)).size !== CORE_JOB_SCHEDULES.length) throw new Error("core engine: a job is scheduled once");
    if (CORE_DISPATCH_MAX_RECEIVES < 21) throw new Error("core engine: the dispatch queue's redrive limit must be above the core's retry budget (at least 21)");

    this.deadLetters = new sqs.Queue(this, "DeadLetterQueue", { queueName: coreDispatchDeadLetterName(env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: coreDispatchQueueName(env),
      deadLetterQueue: { queue: this.deadLetters, maxReceiveCount: CORE_DISPATCH_MAX_RECEIVES },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: CORE_DISPATCH_VISIBILITY_TIMEOUT,
    });
    // The broker runs the core's queue point (send, receive, ack, extend a message's visibility) and, for a redrive or a purge, reads and clears the dead letters. Exactly these two queues.
    broker.addToRolePolicy(new iam.PolicyStatement({
      sid: "UseCoreDispatchQueue",
      actions: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
      resources: [this.queue.queueArn, this.deadLetters.queueArn],
    }));
    new cloudwatch.Alarm(this, "DeadLettersAlarm", {
      alarmName: props.naming.alarmName("CoreDispatchDeadLetters"),
      alarmDescription: "A core engine dispatch message exhausted its receives and is in the core dispatch dead-letter queue, so its task may hold its workspace. Check the broker logs for the operation ID, then redrive or purge the queue.",
      metric: this.deadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);

    // The schedules run only while the combined switch is not off. A condition, so the resources stay and only their state changes.
    this.isOn = new CfnCondition(this, "CoreEngineIsOn", { expression: Fn.conditionNot(Fn.conditionEquals(props.coreEngine.valueAsString, "off")) });
    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, "ScheduleGroup");
    // EventBridge Scheduler sets aws:SourceArn to the schedule GROUP's ARN (as for the chain schedules in control-plane.ts), so that is what the trust names.
    this.invokeRole = new iam.Role(this, "InvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account, "aws:SourceArn": this.scheduleGroup.attrArn } } }),
      description: "EventBridge Scheduler invokes the broker for the core engine's scheduled jobs",
    });
    this.invokeRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] }));
    const state = Token.asString(Fn.conditionIf(this.isOn.logicalId, "ENABLED", "DISABLED"));
    for (const entry of CORE_JOB_SCHEDULES) this.schedules.push(this.schedule(entry, state));
  }

  /**
   * S3-10 (0519-INFRA-CORE-DISPATCH-CONSUMER, A4-SWITCH-ON-DISPATCHER-IAM): the dispatcher is the core's dispatch consumer. It reads this queue through an event source mapping of its own (apart from Cloud's
   * DispatchQueue, so a core message never reaches Cloud's dispatch code), ENABLED only while `cc` is not `off`; it may receive, delete and extend the visibility of a message on this queue (not send, and not
   * touch the dead letters); it starts the deleter (the core ends a closed workspace's machine) and ends a session's instance (own-tagged only, as the idle reaper does); and it reads the callback signing key
   * (the core builds a worker's job on the dispatcher, so the capability and the repository grant it signs are the ones the broker verifies). It already starts the provisioner and signs with the invoke key.
   */
  connectDispatcher(dispatcher: lambda.Function, props: { startDeleter: (fn: lambda.Function) => void; terminateOwnInstances: iam.PolicyStatement; readCallbackKey: (fn: lambda.Function) => void }): lambda.CfnEventSourceMapping {
    dispatcher.addEnvironment("CORE_DISPATCH_QUEUE_URL", this.queue.queueUrl);
    dispatcher.addEnvironment("CORE_DISPATCH_DEAD_LETTER_URL", this.deadLetters.queueUrl);
    dispatcher.addEnvironment("CORE_DISPATCH_QUEUE_ARN", this.queue.queueArn);
    // The dispatcher does not unpack the broker's settings: the switch is a plain variable (as on the Slack ingress), read per batch.
    dispatcher.addEnvironment(BROKER_SETTINGS.coreEngine.variable, this.coreEngine.valueAsString);
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      sid: "ConsumeCoreDispatchQueue",
      actions: [...CORE_DISPATCHER_QUEUE_ACTIONS],
      resources: [this.queue.queueArn],
    }));
    props.startDeleter(dispatcher);
    dispatcher.addToRolePolicy(props.terminateOwnInstances);
    props.readCallbackKey(dispatcher);
    const mapping = new lambda.CfnEventSourceMapping(this, "DispatcherMapping", {
      functionName: dispatcher.functionName,
      eventSourceArn: this.queue.queueArn,
      batchSize: 10,
      functionResponseTypes: ["ReportBatchItemFailures"],
      enabled: Fn.conditionIf(this.isOn.logicalId, true, false),
    });
    // The mapping is created after the grant that lets it read the queue.
    const policy = dispatcher.role?.node.tryFindChild("DefaultPolicy");
    if (policy !== undefined) mapping.node.addDependency(policy);
    return mapping;
  }

  /**
   * S3-10: CoreTierChecks is told the switch (its root is built only while `cc` is on). It gets NO grant on this queue: its State writes are held to the tier review's own rows (CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS),
   * so it can stage no outbox row and has nothing to send; the queue point its root registers is never used there.
   */
  connectTierChecks(fn: lambda.Function): void {
    BrokerSettings.of(fn).add("coreEngine", this.coreEngine.valueAsString);
  }

  private schedule(entry: CoreJobSchedule, state: string): scheduler.CfnSchedule {
    const logical = entry.job.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
    return new scheduler.CfnSchedule(this, `Job${logical}`, {
      description: `Core engine job ${entry.job}`,
      groupName: this.scheduleGroup.ref,
      scheduleExpression: entry.rate,
      flexibleTimeWindow: { mode: "OFF" },
      state,
      target: {
        arn: this.brokerFunctionArn,
        roleArn: this.invokeRole.roleArn,
        input: JSON.stringify({ source: CORE_JOB_EVENT_SOURCE, job: entry.job }),
        // Async invoke: the scheduler sees only a failed Invoke call. A job runs again on the next tick, so a late retry has no value.
        retryPolicy: { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 120 },
      },
    });
  }
}
