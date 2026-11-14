// S3-9 review H1c / M1 / M2: the CoreTierChecks function in the real control plane (named environment): its own entry and handler export, 15 minutes, reserved concurrency 1, no async retries, a schedule of its
// own (rate 5 minutes, no retries) that is DISABLED by default, a role that holds only what the tier pass touches, and TIER_REVIEW_ENABLED (packed `tq`) only where the model access function makes long calls.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CORE_TIER_CHECKS_GRANTS, CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS } from "../../infra/lib/core-tier-checks.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const PLAIN = { agentxEnv: "staging", agentxCloud: true } as const;
/** The Team record on: the model access function makes long calls, so the reviewer and its tier pass exist. */
const PUBLIC = { ...PLAIN, agentxTeamRecord: "enabled" } as const;
type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
const cache = new Map<string, Record<string, Resource>>();
const resources = (context: Record<string, unknown>): Record<string, Resource> => {
  const key = JSON.stringify(context);
  if (!cache.has(key)) {
    const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    cache.set(key, Template.fromStack(stack).toJSON().Resources as Record<string, Resource>);
  }
  return cache.get(key)!;
};
const conditionsOf = (context: Record<string, unknown>): Record<string, unknown> => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  return (Template.fromStack(stack).toJSON() as { Conditions: Record<string, unknown> }).Conditions;
};
const one = (all: Record<string, Resource>, type: string, idPattern: RegExp): [string, Resource] => {
  const found = Object.entries(all).filter(([id, resource]) => resource.Type === type && idPattern.test(id));
  expect(found.map(([id]) => id), `${type} ${String(idPattern)}`).toHaveLength(1);
  return found[0]!;
};
const variables = (resource: Resource): Record<string, unknown> => (resource.Properties.Environment as { Variables: Record<string, unknown> }).Variables;

describe("CoreTierChecks", () => {
  it("is its own function: its own handler export, 15 minutes, reserved concurrency 1, no async retries; the broker's timeout is unchanged", () => {
    const all = resources(PUBLIC);
    const [id, fn] = one(all, "AWS::Lambda::Function", /^CoreTierChecks[0-9A-F]{8}$/);
    expect(fn.Properties).toMatchObject({ Handler: "index.coreTierChecksHandler", Timeout: 900, ReservedConcurrentExecutions: 1 });
    const [, invokeConfig] = one(all, "AWS::Lambda::EventInvokeConfig", /^CoreTierChecks/);
    expect(invokeConfig.Properties).toMatchObject({ FunctionName: { Ref: id }, MaximumRetryAttempts: 0 });
    const [, broker] = one(all, "AWS::Lambda::Function", /^Broker[0-9A-F]{8}$/);
    expect(broker.Properties.Timeout ?? 30).toBe(30);
    // An explicit environment: no callback signing key, no OIDC settings.
    expect(Object.keys(variables(fn)).sort()).toEqual(expect.arrayContaining(["AGENTX_ENV", "AGENTX_ACCOUNT_ID", "GITHUB_APP_PRIVATE_KEY_SECRET_ARN"]));
    expect(JSON.stringify(variables(fn))).not.toMatch(/CALLBACK_SIGNING|OIDC|LEARNING_COMPLETION_ENABLED/u);
  }, 180_000);

  it("an account that cannot reserve concurrency (agentxReservedConcurrency=false) gets none; the per-task call row is then the only single-flight guard", () => {
    const [, fn] = one(resources({ ...PUBLIC, agentxReservedConcurrency: false }), "AWS::Lambda::Function", /^CoreTierChecks[0-9A-F]{8}$/);
    expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
  }, 180_000);

  it("its schedule: rate(5 minutes), no retries, the tier-checks event, through a role that may invoke only this function; DISABLED by default (no CoreEngine parameter on this branch)", () => {
    const all = resources(PUBLIC);
    const [fnId] = one(all, "AWS::Lambda::Function", /^CoreTierChecks[0-9A-F]{8}$/);
    const [, schedule] = one(all, "AWS::Scheduler::Schedule", /^CoreTierChecksSchedule$/);
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: "rate(5 minutes)", State: { "Fn::If": ["CoreTierChecksIsOn", "ENABLED", "DISABLED"] } });
    const target = schedule.Properties.Target as { Arn: unknown; Input: string; RetryPolicy: { MaximumRetryAttempts: number } };
    expect(target.Arn).toEqual({ "Fn::GetAtt": [fnId, "Arn"] });
    expect(JSON.parse(target.Input)).toEqual({ source: "agentx.core-job", job: "tier-checks" });
    expect(target.RetryPolicy.MaximumRetryAttempts).toBe(0);
    // The condition is always false until the core engine's parameter is wired to it.
    expect(conditionsOf(PUBLIC)["CoreTierChecksIsOn"]).toEqual({ "Fn::Equals": ["off", "on"] });
    const [, role] = one(all, "AWS::IAM::Role", /^CoreTierChecksSchedulerRole/);
    const statements = (role.Properties.Policies as Array<{ PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } }>).flatMap((policy) => policy.PolicyDocument.Statement);
    expect(statements).toEqual([expect.objectContaining({ Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [fnId, "Arn"] } })]);
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain("schedule-group/default");
  }, 180_000);

  it("its role holds exactly the listed grants (least privilege): State reads, State writes under the listed key prefixes only, artifacts read, the model access function, the GitHub App key", () => {
    const all = resources(PUBLIC);
    const [, fn] = one(all, "AWS::Lambda::Function", /^CoreTierChecks[0-9A-F]{8}$/);
    const roleId = ((fn.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    const statements = Object.values(all).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleId))
      .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Condition?: unknown }> }).Statement);
    const own = statements.filter((statement) => statement.Sid?.startsWith("CoreTierChecks"));
    expect(Object.fromEntries(own.map((statement) => [statement.Sid, [statement.Action].flat()]))).toEqual(Object.fromEntries(Object.entries(CORE_TIER_CHECKS_GRANTS).map(([sid, actions]) => [sid, [...actions].length === 1 ? [actions[0]] : [...actions]])));
    // Nothing but the X-Ray tracing statement besides its own.
    const others = statements.filter((statement) => !statement.Sid?.startsWith("CoreTierChecks")).flatMap((statement) => [statement.Action].flat());
    expect(others.every((action) => action.startsWith("xray:")), others.join(",")).toBe(true);
    const writes = own.find((statement) => statement.Sid === "CoreTierChecksStateWrites")!;
    expect(writes.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS] }, Null: { "dynamodb:LeadingKeys": "false" } });
    expect(CORE_TIER_CHECKS_STATE_WRITE_KEY_PATTERNS).toContain("ORG#*#TIER_REVIEW_CALL#*");
    expect(JSON.stringify(own)).not.toMatch(/sqs:|scheduler:|ec2:|bedrock:|iam:/u);
  }, 180_000);

  it("M2: TIER_REVIEW_ENABLED=1 (packed `tq`) on the broker and on CoreTierChecks only with the Team record (the model access function's long timeout); without it neither the setting nor the function", () => {
    const settingOf = (context: Record<string, unknown>, pattern: RegExp): string | undefined => {
      const [, fn] = one(resources(context), "AWS::Lambda::Function", pattern);
      return (brokerSettingsIn(variables(fn)) as Record<string, string | undefined>)["tierReview"];
    };
    // Without the Team record: no tier pass function at all, and the broker gets no reviewer setting.
    expect(Object.entries(resources(PLAIN)).filter(([id]) => /^CoreTierChecks/.test(id))).toEqual([]);
    expect(settingOf(PLAIN, /^Broker[0-9A-F]{8}$/)).toBeUndefined();
    const record = PUBLIC;
    expect(settingOf(record, /^CoreTierChecks[0-9A-F]{8}$/)).toBe("1");
    expect(settingOf(record, /^Broker[0-9A-F]{8}$/)).toBe("1");
    const [, modelAccess] = one(resources(record), "AWS::Lambda::Function", /^ModelAccessFunction[0-9A-F]{8}$/);
    expect(variables(modelAccess)["LEARNING_COMPLETION_ENABLED"]).toBe("1");
  }, 180_000);
});
