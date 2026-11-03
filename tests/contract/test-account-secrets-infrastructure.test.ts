// Test services TS26: the TestAccountSecretsRole and the broker's permission to assume it. The policy text is the one the control plane synthesizes; the Secrets Manager fake evaluates it, so isolation between
// orgs, between purposes (store never reads, resolve never writes) and from the connector path is proved by what the role refuses.
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, UntagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { testAccountSecretsPolicyStatements, testAccountSecretsTrustPolicy } from "../../infra/lib/test-account-secrets-policy.js";
import { defaultBoundaryStatements, fixedNameEnvironmentRoleNames, testAccountSecretsRoleName } from "../../packages/contracts/src/access-policies.js";
import { testAccountSecretName, testAccountSecretTags } from "../../packages/contracts/src/test-account.js";
import { FAKE_BROKER_ROLE_ARN, FakeOrgSecrets, type FakeSecretsClient } from "../support/fake-org-secrets.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ORG_A = `org_${"a".repeat(20)}`;
const ORG_B = `org_${"b".repeat(20)}`;
const ROLE_ARN = "arn:aws:iam::111122223333:role/test-account-secrets-role";
const ARN_PREFIX = "arn:aws:secretsmanager:us-west-2:111122223333:secret:";
const secretValue = () => JSON.stringify({ apiKey: ["fake", "value", "123"].join("-") });

function fake(now?: () => number): FakeOrgSecrets {
  return new FakeOrgSecrets({
    env: "staging", roleArn: ROLE_ARN, ...(now === undefined ? {} : { now }),
    policy: testAccountSecretsPolicyStatements({ secretArnPrefix: ARN_PREFIX, env: "staging" }),
    trust: testAccountSecretsTrustPolicy(FAKE_BROKER_ROLE_ARN).Statement,
  });
}

async function session(secrets: FakeOrgSecrets, tags: Record<string, string>, policy?: unknown): Promise<FakeSecretsClient> {
  const response = await secrets.sts.send(new AssumeRoleCommand({
    RoleArn: ROLE_ARN, RoleSessionName: "test", DurationSeconds: 900, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })), ...(policy === undefined ? {} : { Policy: JSON.stringify(policy) }),
  }));
  const credentials = response.Credentials!;
  return secrets.secretsFor({ accessKeyId: credentials.AccessKeyId!, secretAccessKey: credentials.SecretAccessKey!, sessionToken: credentials.SessionToken!, expiration: credentials.Expiration! });
}
const tagsOf = (org: string, purpose: string) => ({ "rovara:org": org, "rovara:purpose": purpose });
const allowed = async (call: Promise<unknown>) => { await call; return true; };
const refused = (call: Promise<unknown>) => call.then(() => false, (error: unknown) => (error as Error).name === "AccessDeniedException");
const create = (org: string, id: string, tags = testAccountSecretTags(org)) => new CreateSecretCommand({ Name: testAccountSecretName("staging", org, id), SecretString: secretValue(), Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });

describe("the TestAccountSecretsRole, as the policy text says", () => {
  it("lets the store session create, update, describe and schedule deletion of its own org's test-account secrets, and never read a value", async () => {
    const secrets = fake();
    const store = await session(secrets, tagsOf(ORG_A, "store"));
    expect(await allowed(store.send(create(ORG_A, "payments-test")))).toBe(true);
    const name = testAccountSecretName("staging", ORG_A, "payments-test");
    expect(await allowed(store.send(new PutSecretValueCommand({ SecretId: name, SecretString: secretValue() })))).toBe(true);
    expect(await allowed(store.send(new DescribeSecretCommand({ SecretId: name })))).toBe(true);
    expect(await refused(store.send(new GetSecretValueCommand({ SecretId: name })))).toBe(true);
    expect(await allowed(store.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 })))).toBe(true);
    expect(await refused(store.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })))).toBe(true);
    expect(await refused(store.send(new UntagResourceCommand({ SecretId: name, TagKeys: ["rovara:use"] })))).toBe(true);
  });

  it("lets the resolve session read exactly one value and do nothing else", async () => {
    const secrets = fake();
    const store = await session(secrets, tagsOf(ORG_A, "store"));
    await store.send(create(ORG_A, "payments-test"));
    await store.send(create(ORG_A, "other-test"));
    const name = testAccountSecretName("staging", ORG_A, "payments-test");
    const other = testAccountSecretName("staging", ORG_A, "other-test");
    const resolve = await session(secrets, tagsOf(ORG_A, "resolve"));
    expect(await allowed(resolve.send(new GetSecretValueCommand({ SecretId: name })))).toBe(true);
    for (const command of [
      new PutSecretValueCommand({ SecretId: name, SecretString: "x" }), new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 }), create(ORG_A, "third"),
      new TagResourceCommand({ SecretId: name, Tags: [{ Key: "rovara:org", Value: ORG_A }] }), new DescribeSecretCommand({ SecretId: name }),
    ]) expect(await refused(resolve.send(command)), command.constructor.name).toBe(true);
    // The session policy the broker passes narrows a resolve session to one secret.
    const narrowed = await session(secrets, tagsOf(ORG_A, "resolve"), { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: `${ARN_PREFIX}${name}-??????` }] });
    expect(await allowed(narrowed.send(new GetSecretValueCommand({ SecretId: name })))).toBe(true);
    expect(await refused(narrowed.send(new GetSecretValueCommand({ SecretId: other })))).toBe(true);
  });

  it("never reaches another org's secret, in either purpose", async () => {
    const secrets = fake();
    await (await session(secrets, tagsOf(ORG_B, "store"))).send(create(ORG_B, "theirs"));
    const theirs = testAccountSecretName("staging", ORG_B, "theirs");
    const store = await session(secrets, tagsOf(ORG_A, "store"));
    const resolve = await session(secrets, tagsOf(ORG_A, "resolve"));
    expect(await refused(resolve.send(new GetSecretValueCommand({ SecretId: theirs })))).toBe(true);
    expect(await refused(store.send(new PutSecretValueCommand({ SecretId: theirs, SecretString: "x" })))).toBe(true);
    expect(await refused(store.send(new DeleteSecretCommand({ SecretId: theirs, RecoveryWindowInDays: 7 })))).toBe(true);
    // Creating under another org's path is refused too, even with that org's tag.
    expect(await refused(store.send(create(ORG_B, "planted", testAccountSecretTags(ORG_B))))).toBe(true);
    expect(await refused(store.send(create(ORG_A, "mislabelled", testAccountSecretTags(ORG_B))))).toBe(true);
  });

  it("refuses a create with any tag but the org and the use, with the wrong use, and a secret made without the use tag is unreadable", async () => {
    const secrets = fake();
    const store = await session(secrets, tagsOf(ORG_A, "store"));
    expect(await refused(store.send(create(ORG_A, "extra", { ...testAccountSecretTags(ORG_A), extra: "1" })))).toBe(true);
    expect(await refused(store.send(create(ORG_A, "wrong-use", { ...testAccountSecretTags(ORG_A), "rovara:use": "connector" })))).toBe(true);
    expect(await refused(store.send(create(ORG_A, "no-use", { "rovara:org": ORG_A })))).toBe(true);
    secrets.seed(testAccountSecretName("staging", ORG_A, "seeded-without-use"), secretValue(), { "rovara:org": ORG_A });
    expect(await refused((await session(secrets, tagsOf(ORG_A, "resolve"))).send(new GetSecretValueCommand({ SecretId: testAccountSecretName("staging", ORG_A, "seeded-without-use") })))).toBe(true);
  });

  it("does not read a secret that sits in this org's path but carries another org's tag", async () => {
    const secrets = fake();
    secrets.seed(testAccountSecretName("staging", ORG_A, "mislabelled"), secretValue(), { "rovara:org": ORG_B, "rovara:use": "test-account" });
    const resolve = await session(secrets, tagsOf(ORG_A, "resolve"));
    expect(await refused(resolve.send(new GetSecretValueCommand({ SecretId: testAccountSecretName("staging", ORG_A, "mislabelled") })))).toBe(true);
  });

  it("is a different path from the connector role's: neither role reaches the other's secrets", async () => {
    const secrets = fake();
    secrets.seed(`agentx/staging/org-connectors/${ORG_A}/conn-1`, secretValue(), { "rovara:org": ORG_A, "rovara:use": "test-account" });
    const resolve = await session(secrets, tagsOf(ORG_A, "resolve"));
    expect(await refused(resolve.send(new GetSecretValueCommand({ SecretId: `agentx/staging/org-connectors/${ORG_A}/conn-1` })))).toBe(true);
    expect(testAccountSecretName("staging", ORG_A, "payments-test")).not.toContain("org-connectors");
  });

  it("trusts the broker for a well-formed org id and one of the two purposes, and for nothing else", async () => {
    const secrets = fake();
    const refusedAssume = (tags: Record<string, string> | undefined) => session(secrets, tags ?? {}).then(() => false, (error: unknown) => (error as Error).name === "AccessDenied");
    expect(await refusedAssume({ "rovara:org": ORG_A })).toBe(true);
    expect(await refusedAssume({ "rovara:purpose": "store" })).toBe(true);
    expect(await refusedAssume(tagsOf(ORG_A, "admin"))).toBe(true);
    expect(await refusedAssume(tagsOf("org_short", "store"))).toBe(true);
    expect(await refusedAssume({ ...tagsOf(ORG_A, "store"), extra: "x" })).toBe(true);
    expect(await refusedAssume(undefined)).toBe(true);
    await expect(session(secrets, tagsOf(ORG_A, "store"))).resolves.toBeDefined();
    await expect(session(secrets, tagsOf(ORG_A, "resolve"))).resolves.toBeDefined();
  });

  it("has the trust policy and permissions as plain JSON with the exact Sids", () => {
    expect(testAccountSecretsPolicyStatements({ secretArnPrefix: ARN_PREFIX, env: "staging" }).map((statement) => statement.Sid)).toEqual([
      "StoreOwnOrgSecrets", "ResolveOwnOrgSecret", "CreateOwnOrgSecrets", "TagOnlyWithCreate", "NeverUntag", "NeverDeleteWithoutRecovery", "OnlyResolveReads", "OnlyStoreWrites",
    ]);
    expect(JSON.stringify(testAccountSecretsPolicyStatements({ secretArnPrefix: ARN_PREFIX, env: "staging" }))).not.toMatch(/org-connectors|org-hooks/u);
  });
});

type Json = Record<string, unknown>;
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties: Json & { Roles?: Array<{ Ref?: string }>; Policies?: Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }>; AssumeRolePolicyDocument?: { Statement: Statement[] }; PolicyDocument?: { Statement: Statement[] } } };
type Resources = Record<string, Resource>;
const asList = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  return Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!);
}

describe("TestAccountSecretsRole (named environments)", () => {
  let resources: Resources;
  let roleId: string;
  let role: Resource;
  let brokerRoleId: string;
  beforeAll(() => {
    resources = controlPlane({ agentxEnv: "staging" }).toJSON().Resources as Resources;
    const roles = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.startsWith("TestAccountSecretsRole"));
    expect(roles.map(([id]) => id)).toHaveLength(1);
    [roleId, role] = roles[0]!;
    brokerRoleId = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.startsWith("BrokerServiceRole"))![0];
  }, 240_000);

  it("has a fixed name on the environment role path, and the connector role's name as its prefix", () => {
    expect(role.Properties.RoleName).toBe("agentx-staging-connector-secrets-test-accounts");
    expect(role.Properties.RoleName).toBe(testAccountSecretsRoleName("staging"));
    expect(role.Properties.Path).toBe("/agentx/staging/");
    expect(fixedNameEnvironmentRoleNames("staging")).toContain(testAccountSecretsRoleName("staging"));
  });

  it("carries exactly the trust policy and permissions the fake evaluated, with the broker role as its only trusted principal", () => {
    const trust = role.Properties.AssumeRolePolicyDocument!.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } });
    expect(trust[0]!.Condition).toEqual(testAccountSecretsTrustPolicy("x").Statement[0]!.Condition);
    const policies = role.Properties.Policies!;
    expect(policies.map((policy) => policy.PolicyName)).toEqual(["OrgTestAccountSecrets"]);
    const statements = policies[0]!.PolicyDocument.Statement;
    const expected = testAccountSecretsPolicyStatements({ secretArnPrefix: "PREFIX:", env: "staging" });
    expect(statements.map((statement) => statement.Sid)).toEqual(expected.map((statement) => statement.Sid));
    for (const statement of statements.filter((entry) => entry.Effect === "Allow")) {
      expect(JSON.stringify(statement.Resource)).toContain("agentx/staging/org-test-accounts/${aws:PrincipalTag/rovara:org}/*");
    }
  });

  it("lets the broker assume the role with session tags, and gives the broker no Secrets Manager permission on the org-test-accounts path", () => {
    const statements = Object.values(resources)
      .filter((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && (resource.Properties.Roles ?? []).some((entry) => entry.Ref === brokerRoleId))
      .flatMap((resource) => resource.Properties.PolicyDocument!.Statement);
    const assume = statements.filter((statement) => statement.Sid === "AssumeTestAccountSecretsRole");
    expect(assume).toHaveLength(1);
    expect(asList(assume[0]!.Action).sort()).toEqual(["sts:AssumeRole", "sts:TagSession"]);
    expect(assume[0]).toMatchObject({ Effect: "Allow", Resource: { "Fn::GetAtt": [roleId, "Arn"] } });
    expect(assume[0]!.Condition).toBeUndefined();
    const secretsGrants = statements.filter((statement) => asList(statement.Action).some((action) => action.startsWith("secretsmanager:") || action === "*"));
    expect(JSON.stringify(secretsGrants)).not.toContain("org-test-accounts");
  });

  it("is derived by the broker, not passed to it", () => {
    const broker = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("Broker") && !id.startsWith("BrokerLogs"))!;
    const variables = (broker[1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
    expect(variables.TEST_ACCOUNT_SECRETS_ROLE_ARN).toBeUndefined();
  });

  it("is covered by the default boundary's one connector-secrets* ARN, which stays the only sts:AssumeRole grant of this account's roles besides the saved environment's", () => {
    const boundary = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "x" });
    const statement = boundary.find((entry) => entry.Sid === "ConnectorSecretsRole")!;
    expect(statement.Resource).toEqual(["arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets*", "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-img-*"]);
    expect("arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets-test-accounts").toMatch(new RegExp(`^${(statement.Resource as string[])[0]!.replace(/\*/gu, ".*")}$`, "u"));
  });

  it("uses no em dash in a name or description", () => {
    expect(JSON.stringify(role.Properties)).not.toMatch(/[—–]/u);
  });

  it("does not exist in the legacy deployment", () => {
    const legacy = controlPlane({}).toJSON().Resources as Resources;
    expect(Object.keys(legacy).filter((id) => id.startsWith("TestAccountSecretsRole"))).toEqual([]);
    expect(JSON.stringify(legacy)).not.toContain("org-test-accounts");
  });
});
