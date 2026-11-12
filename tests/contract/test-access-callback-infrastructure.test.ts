import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_ACCESS_DEFAULT_REGIONS, snsServicePrincipal, testAccessTopicName } from "@agentx/cloud-contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { TestAccessCallbackStack, parseTestAccessContext, testAccessHandlerFunctionName, testAccessStackName } from "../../infra/lib/test-access-callback.js";
import { namingFromContext } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Principal?: unknown; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Synth = { Resources: Record<string, Resource>; Outputs: Record<string, unknown> };

const CLOUD = { agentxEnv: "ta1", agentxCloud: true } as const;
const GUARD = [join(homedir(), ".local/share/rovara-tools/cfn-guard-3.2.1/cfn-guard"), "cfn-guard"].find((path) => existsSync(path) || spawnSync(path, ["--version"]).status === 0);

describe("the customer test account's callback topics (lane TA1)", () => {
  let home: Synth;
  let other: Synth;
  let regions: string[];

  const synth = (stack: Stack): Synth => Template.fromStack(stack).toJSON() as Synth;
  let naming: ReturnType<typeof namingFromContext>;
  beforeAll(() => {
    // The two stacks on their own (the whole app needs the web app built; the wiring test below builds it).
    const app = new App({ context: { agentxEnv: "ta1", agentxCloud: true } });
    naming = namingFromContext(app);
    const settings = parseTestAccessContext({ get: (key) => ({ agentxTestAccess: "enabled", agentxTestAccessRegions: "us-east-1,eu-west-1,ap-east-1" })[key as "agentxTestAccess"], homeRegion: "us-west-2", cloud: true })!;
    const stacks = settings.regions.map((region) => new TestAccessCallbackStack(app, `AgentXTestAccess-${region}`, { naming, settings, region, stackName: testAccessStackName(naming, region) }));
    regions = stacks.map((stack) => stack.region).sort();
    home = synth(stacks.find((stack) => stack.region === "us-west-2")!);
    other = synth(stacks.find((stack) => stack.region === "us-east-1")!);
  }, 240_000);

  const statements = (template: Synth, type: string): Statement[] => Object.values(template.Resources).filter((resource) => resource.Type === type).flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

  it("makes one stack per Region, the home Region included", () => {
    expect(regions).toEqual(["ap-east-1", "eu-west-1", "us-east-1", "us-west-2"]);
  });

  it("is wired into the app only when asked for", () => {
    const names = (app: ReturnType<typeof buildAgentXApp>) => app.node.children.filter((child): child is Stack => Stack.isStack(child)).map((stack) => stack.stackName);
    expect(names(buildAgentXApp({ ...CLOUD }))).not.toEqual(expect.arrayContaining([expect.stringContaining("test-access")]));
    expect(names(buildAgentXApp({ ...CLOUD, agentxRegion: "us-west-2", agentxTestAccess: "enabled", agentxTestAccessRegions: "us-east-1" }))).toEqual(expect.arrayContaining(["agentx-ta1-test-access-us-east-1", "agentx-ta1-test-access-us-west-2"]));
  }, 240_000);

  it("refuses the switch outside the hosted cloud, and a bad value or Region", () => {
    const get = (values: Record<string, unknown>) => (key: string) => values[key];
    expect(parseTestAccessContext({ get: get({}), homeRegion: "us-east-1", cloud: false })).toBeUndefined();
    expect(parseTestAccessContext({ get: get({ agentxTestAccess: "disabled" }), homeRegion: "us-east-1", cloud: true })).toBeUndefined();
    expect(() => parseTestAccessContext({ get: get({ agentxTestAccess: "enabled" }), homeRegion: "us-east-1", cloud: false })).toThrow(/hosted/u);
    expect(() => parseTestAccessContext({ get: get({ agentxTestAccess: "yes" }), homeRegion: "us-east-1", cloud: true })).toThrow(/unsupported/u);
    expect(() => parseTestAccessContext({ get: get({ agentxTestAccess: "enabled", agentxTestAccessRegions: "mars-1" }), homeRegion: "us-east-1", cloud: true })).toThrow();
    expect(() => parseTestAccessContext({ get: get({ agentxTestAccess: "enabled", agentxTestAccessRegions: 5 }), homeRegion: "us-east-1", cloud: true })).toThrow(/comma/u);
    expect(parseTestAccessContext({ get: get({ agentxTestAccess: "enabled" }), homeRegion: "us-east-1", cloud: true })?.regions).toEqual([...TEST_ACCESS_DEFAULT_REGIONS].sort());
    expect(testAccessStackName(naming, "us-east-1")).toBe("agentx-ta1-test-access-us-east-1");
  });

  it("has one topic with the shared name that any account may publish to, over TLS, and nothing more", () => {
    const [topic] = Object.values(other.Resources).filter((resource) => resource.Type === "AWS::SNS::Topic");
    expect(topic?.Properties.TopicName).toBe(testAccessTopicName("agentx-ta1"));
    const policy = statements(other, "AWS::SNS::TopicPolicy");
    const open = policy.filter((statement) => statement.Effect === "Allow");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ Principal: { AWS: "*" }, Action: "sns:Publish", Condition: { Bool: { "aws:SecureTransport": "true" } } });
    expect(policy.find((statement) => statement.Effect === "Deny")).toMatchObject({ Action: "sns:Publish", Condition: { Bool: { "aws:SecureTransport": "false" } } });
    // no other action is open to anyone: no subscribe, no delete
    expect(JSON.stringify(policy)).not.toMatch(/sns:(Subscribe|Delete|SetTopicAttributes|AddPermission)/u);
  });

  it("delivers to the handler in the home Region, with a dead-letter queue, and the handler's permission is in the home stack only", () => {
    const handler = `:lambda:us-west-2:`;
    for (const template of [home, other]) {
      const [subscription] = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::SNS::Subscription");
      expect(subscription?.Properties.Protocol).toBe("lambda");
      expect(JSON.stringify(subscription?.Properties.Endpoint)).toContain(handler);
      expect(JSON.stringify(subscription?.Properties.Endpoint)).toContain(testAccessHandlerFunctionName(naming));
      expect(subscription?.Properties.RedrivePolicy).toBeDefined();
      const [queue] = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::SQS::Queue");
      expect(queue?.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 24 * 3600 });
    }
    const permissions = Object.values(home.Resources).filter((resource) => resource.Type === "AWS::Lambda::Permission");
    expect(permissions).toHaveLength(regions.length);
    const principals = permissions.map((permission) => permission.Properties.Principal).sort();
    expect(principals).toEqual(regions.map(snsServicePrincipal).sort());
    expect(principals).toContain("sns.ap-east-1.amazonaws.com");
    expect(Object.values(other.Resources).filter((resource) => resource.Type === "AWS::Lambda::Permission")).toEqual([]);
  }, 240_000);

  it("passes the topic rules (cfn-guard), and the rules fail on a policy that is open to more", () => {
    if (GUARD === undefined) return;
    const dir = mkdtempSync(join(tmpdir(), "test-access-topic-"));
    const run = (template: unknown, name: string) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(template));
      return spawnSync(GUARD, ["validate", "--rules", "environments/test-access/rules/rovara-callback-topic.guard", "--data", path, "--show-summary", "fail"], { encoding: "utf8" });
    };
    expect(run(other, "ok").status).toBe(0);
    const widened = JSON.parse(JSON.stringify(other)) as Synth;
    const policy = Object.values(widened.Resources).find((resource) => resource.Type === "AWS::SNS::TopicPolicy")!;
    ((policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.find((statement) => statement.Effect === "Allow")!).Action = ["sns:Publish", "sns:Subscribe"];
    expect(run(widened, "widened").status).not.toBe(0);
    const plain = JSON.parse(JSON.stringify(other)) as Synth;
    const plainPolicy = Object.values(plain.Resources).find((resource) => resource.Type === "AWS::SNS::TopicPolicy")!;
    delete ((plainPolicy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.find((statement) => statement.Effect === "Allow")!).Condition;
    expect(run(plain, "plain").status).not.toBe(0);
  });
});
