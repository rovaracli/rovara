// S3-9 review H1c and M1: the CoreTierChecks function, the lighter flow's tier pass on a function of its own (packages/broker/src/aws/broker/core-tier-checks.ts). Named environments with the model proxy AND the
// Team record only (the reviewer needs the model access function's long calls, which come with the record; without them the lighter flow is off and no tier pass is owed).
//
// Why its own function: the tier pass makes customer-paid reviewer calls of up to 130 s (Code waits 120 s; the in-VPC function's long calls run 120 s). On the broker (30 s) a call cut off by the timeout
// leaves the provider's bill paid and no outcome recorded, and the next tick buys it again. Here:
//   - timeout 15 minutes (the pass's own budget is 14 minutes and the meter starts no call with less than 140 s left);
//   - reserved concurrency 1: one pass at a time for the whole install, so two passes never bill the same review twice (single flight; the durable per-task call row is the second guard);
//   - asynchronous invokes are not retried (retryAttempts 0) and the schedule has no retries (maximumRetryAttempts 0): the next tick is the retry, and a retry of a pass that died mid-call is exactly
//     what bought the call twice;
//   - its own EventBridge Scheduler schedule, rate(5 minutes), in the default group, through a role of its own that may invoke THIS function and nothing else. The schedule is ENABLED only while the core
//     engine is on (`isOn`): the CoreEngine parameter's condition (CoreEngineIsOn, infra/lib/core-engine.ts on feat/0519-infra-slot) where the stack has it, else a condition that is always false, so the
//     schedule exists DISABLED by default (DEFERRED S3-9-TIER-CHECKS-SCHEDULE-RECONCILE: point it at CoreEngineIsOn when both reach integ/0519).
//
// Its role holds only what the tier pass touches (least privilege, `CORE_TIER_CHECKS_GRANTS` lists them): the State table (reads; writes only under the key prefixes of
// `CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS`), the artifacts bucket (read: the plan documents), `lambda:InvokeFunction` on the model access function and nothing else on Lambda, and the GitHub App's key secret (read:
// the pass reads the pull request's current head from the code host and updates its banner). No queue, no scheduler, no EC2, no Bedrock, no other secret, no self-invoke.
// No alarm of its own yet (an alarm name must be one the Health page reads, HEALTH_ALARM_SUFFIXES): DEFERRED S3-9-TIER-CHECKS-ALARM.
import { Aws, CfnCondition, Duration, Fn, Token, aws_iam as iam, aws_scheduler as scheduler, type CfnParameter, type Stack } from "aws-cdk-lib";
import type { aws_dynamodb as dynamodb, aws_lambda as lambda, aws_s3 as s3 } from "aws-cdk-lib";
import { aws_lambda as lambdaValues } from "aws-cdk-lib";
import { packagedFunction } from "./control-plane.js";
import { BrokerNames, BrokerSettings } from "./broker-names.js";

/** The function's timeout. */
export const CORE_TIER_CHECKS_TIMEOUT = Duration.minutes(15);
/** One pass at a time for the whole install. */
export const CORE_TIER_CHECKS_RESERVED_CONCURRENCY = 1;
/** How often the pass runs (Code runs it on its own timer beside the sweep). */
export const CORE_TIER_CHECKS_RATE = "rate(5 minutes)";
/** The event the schedule sends: the core job event of the `tier-checks` row (packages/broker/src/cloud/app/jobs.ts). */
export const CORE_TIER_CHECKS_EVENT = { source: "agentx.core-job", job: "tier-checks" } as const;

/**
 * The key prefixes (the table's partition key) the function may WRITE in the State table, and why:
 *   - DEVTASK#*            the task's own record (the flow's tier, quick checks, reviews; the scope question);
 *   - WORKSPACE#*          a pull request's record (its banner text);
 *   - TIER_CHECKS_DUE      the pass's own queue of tasks (Code's merge tracking);
 *   - WORKFLOW_MERGE_SWEEP the code host's cooldown the pass remembers;
 *   - ORG#*#AGENT_SESSION#*      the person's session line ("the change grew ...");
 *   - ORG#*#TIER_REVIEW_CALL#*   the durable row of each reviewer call (claimed before a key is minted, review H1b);
 *   - the spend ledger, for the keys the reviewer calls mint (as the LessonsWorker): ORG#*#SPEND#*, ORG#*#MODEL_KEY#*, OPEN_MODEL_KEYS; and pending audit items (AUDIT_PENDING#*: the broker's drain sends them).
 */
export const CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS = [
  "DEVTASK#*", "WORKSPACE#*", "TIER_CHECKS_DUE", "WORKFLOW_MERGE_SWEEP", "ORG#*#AGENT_SESSION#*", "ORG#*#TIER_REVIEW_CALL#*",
  "ORG#*#SPEND#*", "ORG#*#MODEL_KEY#*", "OPEN_MODEL_KEYS", "AUDIT_PENDING#*",
] as const;

/** Every right the function's role holds, by statement id (the template test holds the role to exactly these). */
export const CORE_TIER_CHECKS_GRANTS = {
  CoreTierChecksStateReads: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
  CoreTierChecksStateWrites: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"],
  CoreTierChecksArtifactsRead: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
  CoreTierChecksInvokeModelAccess: ["lambda:InvokeFunction"],
  CoreTierChecksGithubAppKey: ["secretsmanager:GetSecretValue"],
} as const;

export interface CoreTierChecksProps {
  readonly env: string;
  readonly state: dynamodb.Table;
  readonly artifacts: s3.Bucket;
  readonly modelAccessFunction: lambda.IFunction;
  readonly githubAppPrivateKeySecretArn: string;
  readonly githubAppCredentialRef: string;
  readonly githubAppId: string;
  /** The CoreEngine stack parameter (0.5.19 `cc`), where the stack has it: the schedule is ENABLED only while it is not `off`. Absent: the schedule is DISABLED (its own always-false condition). */
  readonly coreEngine?: CfnParameter;
  /** Whether the function reserves Lambda concurrency (default true; the `agentxReservedConcurrency` context). */
  readonly reservedConcurrency?: boolean;
}

export function attachCoreTierChecks(stack: Stack, props: CoreTierChecksProps): { fn: lambda.Function; schedule: scheduler.CfnSchedule; isOn: CfnCondition; role: iam.Role } {
  // An explicit environment, as the LessonsWorker's: nothing is copied from the broker (no callback signing key, no OIDC settings, no queue).
  const fn = packagedFunction(stack, "CoreTierChecks", "packages/broker/src/aws/core-tier-checks-entry.ts", {
    AGENTX_ENV: props.env, AGENTX_ACCOUNT_ID: stack.account, GITHUB_APP_PRIVATE_KEY_SECRET_ARN: props.githubAppPrivateKeySecretArn,
  }, CORE_TIER_CHECKS_TIMEOUT, [], 512, [], lambdaValues.Tracing.ACTIVE, "coreTierChecksHandler");
  const names = BrokerNames.of(fn);
  names.add("stateTable", props.state.tableName);
  names.add("artifactBucket", props.artifacts.bucketName);
  names.add("modelAccessFunction", props.modelAccessFunction.functionName);
  const settings = BrokerSettings.of(fn);
  settings.add("githubAppCredentialRef", props.githubAppCredentialRef);
  settings.add("githubAppId", props.githubAppId);
  // M2: the reviewer may run (TIER_REVIEW_ENABLED=1). This function exists only where the model access function makes long calls (with the Team record, as LEARNING_COMPLETION_ENABLED=1 there).
  settings.add("tierReview", "1");
  // Single flight for the whole install, and no async retries. An account that cannot reserve concurrency (the `agentxReservedConcurrency=false` context, as for the audit ledger's functions and the LessonsWorker)
  // gets none: two passes may then overlap, and the durable per-task call row (claimed before any key is minted) still refuses the second call of the same review.
  if (props.reservedConcurrency !== false) (fn.node.defaultChild as lambdaValues.CfnFunction).reservedConcurrentExecutions = CORE_TIER_CHECKS_RESERVED_CONCURRENCY;
  fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(5) });

  fn.addToRolePolicy(new iam.PolicyStatement({ sid: "CoreTierChecksStateReads", actions: [...CORE_TIER_CHECKS_GRANTS.CoreTierChecksStateReads], resources: [props.state.tableArn, `${props.state.tableArn}/index/*`] }));
  fn.addToRolePolicy(new iam.PolicyStatement({
    sid: "CoreTierChecksStateWrites", actions: [...CORE_TIER_CHECKS_GRANTS.CoreTierChecksStateWrites], resources: [props.state.tableArn],
    // ForAllValues passes when the key is absent, so the Null test requires it (as the LessonsWorker's writes).
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  fn.addToRolePolicy(new iam.PolicyStatement({ sid: "CoreTierChecksArtifactsRead", actions: [...CORE_TIER_CHECKS_GRANTS.CoreTierChecksArtifactsRead], resources: [props.artifacts.bucketArn, props.artifacts.arnForObjects("private/*")] }));
  fn.addToRolePolicy(new iam.PolicyStatement({ sid: "CoreTierChecksInvokeModelAccess", actions: [...CORE_TIER_CHECKS_GRANTS.CoreTierChecksInvokeModelAccess], resources: [props.modelAccessFunction.functionArn, `${props.modelAccessFunction.functionArn}:*`] }));
  fn.addToRolePolicy(new iam.PolicyStatement({ sid: "CoreTierChecksGithubAppKey", actions: [...CORE_TIER_CHECKS_GRANTS.CoreTierChecksGithubAppKey], resources: [props.githubAppPrivateKeySecretArn] }));

  // ENABLED only while the core engine is on; DISABLED by default.
  const isOn = new CfnCondition(stack, "CoreTierChecksIsOn", {
    expression: props.coreEngine === undefined ? Fn.conditionEquals("off", "on") : Fn.conditionNot(Fn.conditionEquals(props.coreEngine.valueAsString, "off")),
  });
  // The scheduler may assume the role only for this account's schedules in the default group (confused-deputy guard, as the audit drain's), and may invoke this function and nothing else.
  const role = new iam.Role(stack, "CoreTierChecksSchedulerRole", {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
      conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID, "aws:SourceArn": `arn:${Aws.PARTITION}:scheduler:${Aws.REGION}:${Aws.ACCOUNT_ID}:schedule-group/default` } },
    }),
    description: "Lets the EventBridge scheduler invoke the core engine's tier pass function",
    inlinePolicies: { InvokeCoreTierChecks: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ sid: "InvokeCoreTierChecks", actions: ["lambda:InvokeFunction"], resources: [fn.functionArn] })] }) },
  });
  const schedule = new scheduler.CfnSchedule(stack, "CoreTierChecksSchedule", {
    description: "Core engine job tier-checks: the lighter flow's tier pass (reviewer calls), on its own function",
    flexibleTimeWindow: { mode: "OFF" },
    scheduleExpression: CORE_TIER_CHECKS_RATE,
    state: Token.asString(Fn.conditionIf(isOn.logicalId, "ENABLED", "DISABLED")),
    target: {
      arn: fn.functionArn, roleArn: role.roleArn, input: JSON.stringify(CORE_TIER_CHECKS_EVENT),
      // No retries: a pass that failed is run again at the next tick, never twice for one.
      retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 300 },
    },
  });

  return { fn, schedule, isOn, role };
}
