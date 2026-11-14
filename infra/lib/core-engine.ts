// The core engine switch's deployment half (0.5.19, DEFERRED S0-CC-INFRA-UNWIRED, A4-SWITCH-ON-PRECONDITIONS M2, S3-ENTRY-NEEDS 3 and 4). Named environments only: the legacy template has none of it.
//
// What is here:
//   - the core dispatch queue and its dead-letter queue, with a redrive limit above the core's own retry budget (CORE_DISPATCH_MAX_RECEIVES >= 21). Fixed names (derived-names.ts), so the broker builds both URLs and
//     is passed nothing. The broker may send to, receive from, delete from and change the visibility of the queue (the core's `queue` point runs inside the broker's entry) and the dead letters (receive and delete,
//     for a redrive or a purge). Nothing else gets a grant: the dispatcher does not read this queue (the core's dispatch host is not in the dispatcher's entry yet, so an event source mapping would hand a core
//     message to Cloud's own dispatch code; it is added with the host, see A4-SWITCH-ON-DISPATCHER-IAM);
//   - a schedule per scheduled row of the core's job table (CORE_JOB_SCHEDULES), in a group of their own, that invokes the broker with `{ source: "agentx.core-job", job: <name> }` through a role of its own. The role is
//     created under the environment's path with a generated name (no fixed-name role, so no new line in either boundary), trusts only the scheduler for THIS group, and can invoke the broker function and nothing else.
//     The schedules always exist and are ENABLED only while the `cc` parameter is not `off`: switching on or off changes a state, never creates or deletes a resource. A disabled schedule costs nothing;
//   - an alarm on the dead-letter queue.
//
// None of this runs a core job or moves a task: the broker answers a scheduled core job `{ skipped: "off" }` while `cc` is off, and the dispatch queue stays empty until a task starts on the core.
import { CfnCondition, Duration, Fn, Stack, Token, aws_cloudwatch as cloudwatch, aws_iam as iam, aws_scheduler as scheduler, aws_sqs as sqs, type CfnParameter, type aws_cloudwatch_actions as cloudwatchActions, type aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CORE_DISPATCH_MAX_RECEIVES, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, coreDispatchDeadLetterName, coreDispatchQueueName, type CoreJobSchedule } from "@agentx/cloud-contracts";
import type { AgentXNaming } from "./naming.js";

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

  constructor(scope: Construct, id: string, props: CoreEngineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env, broker } = props;
    this.brokerFunctionArn = broker.functionArn;
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
