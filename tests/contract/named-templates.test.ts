import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { brokerSettingsIn, takeBrokerSettings } from "../support/broker-names-template.js";
import { withoutModelProxy } from "../support/model-proxy-template.js";
import { withoutAuditLedger } from "../support/audit-ledger-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[] };
type Statement = { Sid?: string };

/**
 * Issue 46 adds one resource to a named control plane, and nothing else: the dispatch
 * dead-letter alarm. It is checked here to be exactly this, then taken out, so the rest of the
 * template must still match the recorded snapshot.
 */
function withoutDispatchDeadLettersAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const alarms = Object.keys(resources).filter((id) => id.startsWith("DispatchDeadLettersAlarm"));
  expect(alarms).toHaveLength(1);
  const queueId = Object.keys(resources).find((id) => id.startsWith("DispatchDeadLetterQueue") && resources[id]!.Type === "AWS::SQS::Queue");
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(queueId).toBeDefined();
  expect(topicId).toBeDefined();
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "A worker dispatch job exhausted its receives and is in the dispatch dead-letter queue. Check the dispatcher logs for its operation ID, then redrive or purge the queue.",
      AlarmName: "agentx-staging-DispatchDeadLetters",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      EvaluationPeriods: 1,
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      Period: 300,
      Statistic: "Maximum",
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Plan 4 Task 19 adds the public event-hook route to a named control plane, and nothing else: one route with no authorizer, to the broker's own integration (every
 * delivery is verified by the broker over its own bytes). It is checked strictly to be exactly this, then taken out, so the rest of the template must still match the
 * recorded snapshot.
 */
function withoutEventHookRoute(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const routes = Object.keys(resources).filter((id) => id.startsWith("EventHookRoute"));
  expect(routes).toHaveLength(1);
  const github = resources["GithubWebhookRoute"]!;
  expect(resources[routes[0]!]).toStrictEqual({
    Type: "AWS::ApiGatewayV2::Route",
    Properties: { ApiId: github.Properties["ApiId"], AuthorizationType: "NONE", RouteKey: "POST /v1/hooks/{source}/{hookId}", Target: github.Properties["Target"] },
  });
  // Its own throttle bucket and the stage's wait for the route: exactly these, taken out too.
  const [, stage] = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Stage")!;
  const settings = stage.Properties["RouteSettings"] as Record<string, unknown>;
  expect(settings["POST /v1/hooks/{source}/{hookId}"]).toStrictEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 });
  delete settings["POST /v1/hooks/{source}/{hookId}"];
  const depends = [stage.DependsOn].flat() as string[];
  expect(depends).toContain(routes[0]!);
  stage.DependsOn = depends.filter((id) => id !== routes[0]!);
  delete resources[routes[0]!];
  return template;
}

/**
 * Issue 173 adds the reconciler backstop to a named control plane, and nothing else: three
 * environment variables, two statements and one alarm. Each is checked strictly to be exactly
 * this, then taken out, so the rest of the template must still match the recorded snapshot.
 */
function withoutUnwaitedTaskBackstop(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const reconcilerEntry = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function");
  expect(reconcilerEntry).toBeDefined();
  const reconciler = reconcilerEntry![1];
  const variables = (reconciler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const threadsId = Object.keys(resources).find((id) => id.startsWith("SlackThreads") && resources[id]!.Type === "AWS::DynamoDB::Table")!;
  const slackSecretId = Object.keys(resources).find((id) => id.startsWith("SlackSecret") && resources[id]!.Type === "AWS::SecretsManager::Secret")!;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(threadsId).toBeDefined();
  expect(slackSecretId).toBeDefined();
  expect(topicId).toBeDefined();
  // 0.5.15 signing-key lane: the callback signing key is no longer a variable (the reconciler reads its secret; its ReadCallbackSigningKey grant is in the snapshot).
  expect(variables).not.toHaveProperty("CALLBACK_SIGNING_KEY");
  const added = { SLACK_THREADS_TABLE_NAME: { Ref: threadsId }, SLACK_SECRET_ARN: { Ref: slackSecretId } };
  expect(Object.fromEntries(Object.keys(added).map((name) => [name, variables[name]]))).toStrictEqual(added);
  for (const name of Object.keys(added)) delete variables[name];
  const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const policies = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy"
    && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId));
  const sids = new Set(["ReadThreadWaiters", "PostUnwaitedTaskNote"]);
  const removed: Statement[] = [];
  for (const policy of policies) {
    const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
    removed.push(...document.Statement.filter((statement) => sids.has(statement.Sid ?? "")));
    document.Statement = document.Statement.filter((statement) => !sids.has(statement.Sid ?? ""));
  }
  expect(removed).toStrictEqual([
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "activeTurn"] },
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        Null: { "dynamodb:Attributes": "false" },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [threadsId, "Arn"] },
      Sid: "ReadThreadWaiters",
    },
    { Action: "secretsmanager:GetSecretValue", Effect: "Allow", Resource: { Ref: slackSecretId }, Sid: "PostUnwaitedTaskNote" },
  ]);
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsUnwaitedTaskFailuresAlarm"));
  expect(alarms).toHaveLength(1);
  const failures = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 600, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler could not check or cancel Slack tasks idle over 24 hours with nobody waiting, on two runs in a row. Check the reconciler's logs for unwaited_task.cancel_failed, unwaited_task.read_failed and reconciler.unwaited_task_sweep_failed.",
      AlarmName: "agentx-staging-UnwaitedTaskFailures",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 2,
      Metrics: [
        { Expression: "FILL(cancels, 0) + FILL(reads, 0)", Id: "expr_1", Label: "Unwaited task cancel and read failures", ReturnData: true },
        failures("cancels", "ReconcilerUnwaitedTaskFailures"),
        failures("reads", "ReconcilerUnwaitedTaskReadFailures"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Issue 195 adds the StuckCancels alarm to a named control plane, and nothing else: its retry runs in
 * the reconciler's own process with #173's signing key, so no grant and no environment variable. The
 * alarm is checked here to be exactly this, then taken out, so the rest of the template must still
 * match the recorded snapshot.
 */
function withoutStuckCancelAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(topicId).toBeDefined();
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsStuckCancelsAlarm"));
  expect(alarms).toHaveLength(1);
  const stat = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 900, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler found a task whose cancel never reached its worker, and queued the cancel again or ended the task (or failed to). Check the reconciler's logs for stuck_cancel events: a retried cancel that finishes, or an ended task, needs no action; repeated ones point at a dispatch or worker fault.",
      AlarmName: "agentx-staging-StuckCancels",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      Metrics: [
        { Expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0) + FILL(unretried, 0)", Id: "expr_1", Label: "Stuck cancels retried, ended, failed or unretried", ReturnData: true },
        stat("retries", "ReconcilerStuckCancelRetries"),
        stat("ended", "ReconcilerStuckCancelsEnded"),
        stat("interrupted", "ReconcilerStuckCancelsInterrupted"),
        stat("failures", "ReconcilerStuckCancelFailures"),
        stat("unretried", "ReconcilerStuckCancelsUnretried"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Task People adds three false-default controls and passes their exact references to the Broker
 * and DeveloperTaskNotifier. Verify those additions in full, remove only them, and keep the rest
 * of the named-environment snapshot comparison strict.
 */
function withoutTaskPeopleControls(template: unknown): unknown {
  const synthesized = template as {
    Parameters: Record<string, unknown>;
    Resources: Record<string, Resource>;
  };
  const parameters = synthesized.Parameters;
  const expectedParameters = {
    TaskPeopleChangesEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people role changes are enabled in this environment",
      Type: "String",
    },
    TaskPeoplePublicInvitationsEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people may invite members to public channels in this environment",
      Type: "String",
    },
    TaskPeoplePrivateInvitationsEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people may invite members to private channels in this environment",
      Type: "String",
    },
  };
  for (const [name, expected] of Object.entries(expectedParameters)) {
    expect(parameters[name]).toStrictEqual(expected);
    delete parameters[name];
  }

  const functions = Object.entries(synthesized.Resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
  const variablesFor = (resource: Resource): Record<string, unknown> =>
    (resource.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const brokerFunctions = functions.filter(([id]) => id.startsWith("Broker"));
  expect(brokerFunctions).toHaveLength(1);
  // The broker has the three flags in its settings (AGENTX_SETTINGS, ENV-ROOM), not as variables of their own: taken out of them here.
  const brokerVariables = variablesFor(brokerFunctions[0]![1]);
  for (const name of ["AGENTX_TASK_PEOPLE_CHANGES_ENABLED", "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED", "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED"]) expect(brokerVariables).not.toHaveProperty(name);
  const flags = brokerSettingsIn(brokerVariables);
  expect({ taskPeopleChanges: flags.taskPeopleChanges, taskPeoplePublicInvitations: flags.taskPeoplePublicInvitations, taskPeoplePrivateInvitations: flags.taskPeoplePrivateInvitations }).toStrictEqual({
    taskPeopleChanges: { Ref: "TaskPeopleChangesEnabled" },
    taskPeoplePublicInvitations: { Ref: "TaskPeoplePublicInvitationsEnabled" },
    taskPeoplePrivateInvitations: { Ref: "TaskPeoplePrivateInvitationsEnabled" },
  });
  takeBrokerSettings(brokerVariables, ["taskPeopleChanges", "taskPeoplePublicInvitations", "taskPeoplePrivateInvitations"]);

  const notifierFunctions = functions.filter(([id]) => id.startsWith("DeveloperTaskNotifier"));
  expect(notifierFunctions).toHaveLength(1);
  const notifierVariables = variablesFor(notifierFunctions[0]![1]);
  expect(notifierVariables.AGENTX_TASK_PEOPLE_CHANGES_ENABLED).toStrictEqual({ Ref: "TaskPeopleChangesEnabled" });
  delete notifierVariables.AGENTX_TASK_PEOPLE_CHANGES_ENABLED;
  // p1-slack-decide-card: the notifier is told the decision cards switch (it has no packed broker settings), so a plan decided on its card shows no Approve in Slack. Taken out here like the flag above.
  expect(notifierVariables.DECISION_CARDS_ENABLED).toStrictEqual({ Ref: "DecisionCardsEnabled" });
  delete notifierVariables.DECISION_CARDS_ENABLED;
  return template;
}

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 4a605fd (re-recorded there when mainline merged in), so a named environment's templates must stay
// as they were, apart from issue 46's dispatch dead-letter alarm, issue 173's reconciler backstop,
// issue 195's stuck-cancel alarm, the false-default Task People controls and the Audit Ledger's
// storage, each checked and taken out above. The snapshot was retaken for TS19 (test services image catalog): nine ECR repositories and one KMS key in the control plane, UNCONDITIONAL (fixed names, retained: a
// condition on TestServicesEnabled would break turning it on, off and on again; service-catalog-images-infrastructure.test.ts checks them), and nothing else.
// 2026-11-03 (fix/ecr-template-slr): the agentx-staging-access snapshot was re-recorded for one added statement in the CloudFormation service role, EcrTemplateServiceLinkedRole
// (iam:CreateServiceLinkedRole for exactly AWSServiceRoleForECRTemplate, condition iam:AWSServiceName = ecr.amazonaws.com). The 0.5.1 staging upgrade rolled back without it.
// No other snapshot moved.
// 2026-11-03 (fix/boundary-tighten): the agentx-staging-access snapshot was re-recorded again, for the DEFAULT BOUNDARY only (the managed policy), which was cut by about 460 characters to make room without allowing anything new:
// sts:GetCallerIdentity and servicequotas:GetServiceQuota moved into the Services statement, iam:PassRole into IamRoles (the service role's own PassRole stays a statement), the two Denies on "*" became one,
// iam:SetDefaultPolicyVersion left DenyPolicyManagement (iam:*PolicyVersion* matches it), and the instance profile actions became iam:*InstanceProfile. tests/contract/default-boundary-equivalence.test.ts proves the same
// (action, resource) pairs are permitted and refused as v0.5.2's boundary did. The service role's policy and every other stack's snapshot are unchanged.
// 2026-11-11 (feat/0515-signing-key-secret): the agentx-staging-control-plane snapshot was re-recorded for the signing-key move only: CALLBACK_SIGNING_KEY left the broker's and the
// eval batch tick's variables (the tick gained AGENTX_ENV, to build the secret's name), and three GetSecretValue grants were added on the two key secrets by name (the broker: both;
// the tick and the reconciler: ReadCallbackSigningKey, the callback signing key alone). The CallbackSigningKey parameter stayed declared (NoEcho, unused) for that one release.
// 2026-11-12 (chore/0515-drop-callback-key-param, decision 123 folds the next release into 0.5.15): the CallbackSigningKey parameter is dropped from the named control-plane snapshot (nothing else
// moved), and the CLI stops passing it (tests/contract/callback-key-param-upgrade.test.ts). The legacy install's snapshot is not touched: its frozen template keeps the parameter and its variable.
// No other snapshot moved.
// 2026-11-12 (fix/0517-tls-boundary, MODEL-PROXY-TLS-BOUNDARY-BLOCKER, review M-1): the agentx-staging-access snapshot was re-recorded for one added managed policy, DeployRolePermissionsBoundary
// (agentx-staging-deploy-boundary), and the deploy role's PermissionsBoundary else branch now naming it. The default boundary itself did not move.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutEventHookRoute(withoutAuditLedger(withoutTaskPeopleControls(withoutStuckCancelAlarm(withoutUnwaitedTaskBackstop(withoutDispatchDeadLettersAlarm(withoutModelProxy(template))))))) : template).toMatchSnapshot();
    }, 120_000);
  }

  // Final review I3: the reconciler's sweep of project setup checks closes a stalled check's workspace, which starts the deleter for its session.
  it("lets the staging reconciler start the deleter, on its exact state machine and nothing wider", () => {
    const stack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
    const resources = (normalizedTemplate(stack) as { Resources: Record<string, Resource> }).Resources;
    const reconciler = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function")![1];
    const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const statements = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId))
      .flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Array<{ Action?: string | string[]; Resource?: unknown }> }).Statement);
    const starts = statements.filter((statement) => [statement.Action].flat().includes("states:StartExecution"));
    const deleterId = Object.keys(resources).find((id) => id.startsWith("SessionsDeleter") && resources[id]!.Type === "AWS::StepFunctions::StateMachine")!;
    expect(starts.map((statement) => statement.Resource)).toContainEqual({ Ref: deleterId });
    expect(starts.every((statement) => typeof statement.Resource === "object" && statement.Resource !== null && "Ref" in statement.Resource)).toBe(true);
  }, 120_000);
});

// Plan 4 Task 9: the chain sweep. Every 5 minutes the broker looks at the chain runs that are due (timeouts, lost callbacks, a decision not yet applied). Like the spend
// settlement it is for named environments only, and it runs through the same role as the other recovery schedules, so it needs no new grant.
describe("the chain sweep schedule", () => {
  type Schedule = { Type: string; Properties: { ScheduleExpression: string; State: string; FlexibleTimeWindow: unknown; Target: { Arn: unknown; RoleArn: unknown; Input: string; RetryPolicy: unknown } } };
  const schedules = (context: Record<string, unknown>): Array<[string, Schedule]> => {
    const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
    return Object.entries(Template.fromStack(stack!).toJSON().Resources as Record<string, Schedule>).filter(([, resource]) => resource.Type === "AWS::Scheduler::Schedule");
  };

  it("runs every 5 minutes in a named environment, through the recovery schedules' role, with the event the broker answers", () => {
    const found = schedules({ agentxEnv: "staging" });
    const sweep = found.filter(([id]) => id.startsWith("ChainSweepSchedule"));
    expect(sweep).toHaveLength(1);
    const [, schedule] = sweep[0]!;
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: "rate(5 minutes)", State: "ENABLED", FlexibleTimeWindow: { Mode: "OFF" } });
    expect(JSON.parse(schedule.Properties.Target.Input)).toStrictEqual({ source: "agentx.chain-sweep" });
    expect(schedule.Properties.Target.RetryPolicy).toStrictEqual({ MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 });
    const recovery = found.find(([id]) => id.startsWith("WorkflowMergeRecoverySchedule"))![1];
    expect(schedule.Properties.Target.Arn).toStrictEqual(recovery.Properties.Target.Arn);
    expect(schedule.Properties.Target.RoleArn).toStrictEqual(recovery.Properties.Target.RoleArn);
  });

  it("is not in the legacy template", () => {
    expect(schedules({}).map(([id]) => id).filter((id) => id.startsWith("ChainSweep"))).toStrictEqual([]);
  });
});

// Plan 4 Task 19: the endpoint vendors post events to is in a named environment's API with no authorizer, and not in the legacy template (which stays as it was).
describe("the event hook route", () => {
  const routes = (context: Record<string, unknown>): Array<[string, { Properties: Record<string, unknown> }]> => {
    const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
    return Object.entries(Template.fromStack(stack!).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>).filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route");
  };

  it("is a POST route with no authorizer, to the broker's integration, in a named environment", () => {
    const found = routes({ agentxEnv: "staging" }).filter(([, route]) => String(route.Properties["RouteKey"]).includes("/v1/hooks/"));
    expect(found).toHaveLength(1);
    const github = routes({ agentxEnv: "staging" }).find(([id]) => id === "GithubWebhookRoute")![1];
    expect(found[0]![1].Properties).toStrictEqual({ ApiId: github.Properties["ApiId"], AuthorizationType: "NONE", RouteKey: "POST /v1/hooks/{source}/{hookId}", Target: github.Properties["Target"] });
  });

  it("is not in the legacy template", () => {
    expect(routes({}).filter(([, route]) => String(route.Properties["RouteKey"]).includes("/v1/hooks/"))).toStrictEqual([]);
  });

  it("never exists without its throttle: where the stage has a bucket for it the route is there, and where the route is absent the stage has none", () => {
    const key = "POST /v1/hooks/{source}/{hookId}";
    for (const context of [{ agentxEnv: "staging" }, {}]) {
      const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
      const resources = Template.fromStack(stack!).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
      const route = Object.values(resources).some((resource) => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties["RouteKey"] === key);
      const stage = Object.values(resources).find((resource) => resource.Type === "AWS::ApiGatewayV2::Stage")!;
      const throttled = Object.hasOwn(stage.Properties["RouteSettings"] ?? {}, key);
      expect(route, JSON.stringify(context)).toBe(throttled);
    }
  });
});
