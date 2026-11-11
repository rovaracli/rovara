// Test services, slice 3 (s3-fakes-store), infrastructure: the answer sets (fakes) are objects under private/<company>/fixtures/ in the artifacts bucket, written with their own KMS key. The broker alone may use the key, to generate a
// data key and to decrypt, and is told its id in its names. Named environments only; the released (legacy) template gains nothing. The service role's inline policy and the default permissions boundary are NOT touched by this lane: the
// numbers are pinned here so a later change to either shows as a change of this test.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, defaultBoundaryStatements, fixtureKeyAlias, serviceRoleStatements, withoutSids, type PolicyScope } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Role: { "Fn::GetAtt": [string, string] }; Environment?: { Variables?: Record<string, unknown> } } };

const named = Template.fromStack(new ControlPlaneStack(new App(), "FixtureControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "FixtureLegacyControlPlane"));
const brokerOf = (template: Template) => Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>).find(([id]) => id.startsWith("Broker"))!;
const policies = (template: Template) => [...Object.values(template.findResources("AWS::IAM::Policy")), ...Object.values(template.findResources("AWS::IAM::ManagedPolicy"))] as Policy[];
const actionsOf = (statement: Statement) => [statement.Action].flat();
const keys = (template: Template) => Object.entries(template.findResources("AWS::KMS::Key")).filter(([id]) => id.startsWith("FixtureKey"));

describe("the fixture key", () => {
  it("is one customer key with rotation on, retained like the bucket whose objects it protects", () => {
    const found = keys(named);
    expect(found).toHaveLength(1);
    const [, key] = found[0]!;
    expect(key).toMatchObject({ UpdateReplacePolicy: "Retain", Properties: { EnableKeyRotation: true } });
    // Retained (CDK writes RetainExceptOnCreate where its stack-wide flag is on), never destroyed with the stack.
    expect((key as { DeletionPolicy: string }).DeletionPolicy).toMatch(/^Retain/u);
    expect(JSON.stringify((key as { Properties: { Description: string } }).Properties.Description)).toContain("answer sets");
  });
  it("lets the broker generate a data key and decrypt with it, on this key alone, and nothing else may use it", () => {
    const [keyId] = keys(named)[0]!;
    const broker = brokerOf(named);
    const brokerRole = broker[1].Properties.Role["Fn::GetAtt"][0];
    const grants = policies(named).flatMap((policy) => policy.Properties.PolicyDocument.Statement.filter((statement) => JSON.stringify(statement.Resource).includes(keyId)).map((statement) => ({ policy, statement })));
    expect(grants.length).toBeGreaterThan(0);
    for (const { policy, statement } of grants) {
      expect(statement.Effect).toBe("Allow");
      expect(actionsOf(statement).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
      expect(policy.Properties.Roles).toEqual([{ Ref: brokerRole }]);
      expect(JSON.stringify(statement.Resource)).toBe(JSON.stringify({ "Fn::GetAtt": [keyId, "Arn"] }));
      // LOW: only through S3 in the stack's region.
      expect(JSON.stringify(statement.Condition)).toBe(JSON.stringify({ StringEquals: { "kms:ViaService": { "Fn::Join": ["", ["s3.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } } }));
    }
  });
  it("gives the key the fixed alias the broker builds its ARN from (S3 accepts an alias for SSE-KMS)", () => {
    const aliases = Object.values(named.findResources("AWS::KMS::Alias")) as Array<{ Properties: { AliasName: string; TargetKeyId: unknown } }>;
    const mine = aliases.filter((alias) => alias.Properties.AliasName === fixtureKeyAlias("staging"));
    expect(mine).toHaveLength(1);
    expect(fixtureKeyAlias("staging")).toBe("alias/agentx/staging/fixtures");
    expect(JSON.stringify(Object.values(legacy.findResources("AWS::KMS::Alias")))).not.toContain("fixtures");
  });
  it("passes the broker nothing for the key (M4): no name, no variable; the broker builds the alias ARN from AGENTX_ENV", () => {
    expect(BROKER_NAMES).not.toHaveProperty("fixtureKey");
    expect(Object.values(BROKER_NAMES).some((spec) => (spec.code as string) === "fk" || (spec.variable as string) === "FIXTURE_KEY_ARN")).toBe(false);
    const variables = brokerOf(named)[1].Properties.Environment?.Variables;
    expect(variables).not.toHaveProperty("FIXTURE_KEY_ARN");
    expect(JSON.stringify(brokerNamesIn(variables))).not.toContain("fk");
    const env: MutableEnvironment = { [BROKER_NAMES_VARIABLE]: "{}", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "944937319445", AGENTX_ENV: "staging" };
    hydrateBrokerEnvironment(env);
    expect(env["FIXTURE_KEY_ARN"]).toBe("arn:aws:kms:us-west-2:944937319445:alias/agentx/staging/fixtures");
    const bare: MutableEnvironment = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "944937319445" };
    hydrateBrokerEnvironment(bare);
    expect(bare["FIXTURE_KEY_ARN"]).toBeUndefined();
  });
  it("adds nothing to the released (legacy) template", () => {
    expect(keys(legacy)).toEqual([]);
    expect(JSON.stringify(legacy.toJSON())).not.toContain("FIXTURE_KEY_ARN");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("FixtureKey");
  });
});

describe("the bucket", () => {
  it("is still private: every public access is blocked and the objects are not given another way in", () => {
    for (const template of [named, legacy]) {
      const buckets = Object.entries(template.findResources("AWS::S3::Bucket")).filter(([id]) => id.startsWith("Artifacts"));
      expect(buckets).toHaveLength(1);
      expect(buckets[0]![1]).toMatchObject({ Properties: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } } });
    }
  });
  it("keeps its evidence lifecycle rules to tagged objects, so an answer set (which has no tag) is never expired by them", () => {
    const [, bucket] = Object.entries(named.findResources("AWS::S3::Bucket")).find(([id]) => id.startsWith("Artifacts"))!;
    const rules = (bucket as { Properties: { LifecycleConfiguration: { Rules: Array<{ Id: string; TagFilters?: unknown[]; Prefix?: string }> } } }).Properties.LifecycleConfiguration.Rules;
    for (const rule of rules.filter((candidate) => candidate.Id !== "ExpireNightlyMaps")) expect(rule.TagFilters, rule.Id).toBeDefined();
    expect(rules.find((rule) => rule.Id === "ExpireNightlyMaps")?.Prefix).toBe("nightly-maps/");
  });
});

describe("the service role and the default boundary are untouched", () => {
  const size = (statements: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements }).replace(/\s/g, "").length;
  const scope = (env: string): PolicyScope => ({
    env, partition: "aws", region: "ap-southeast-2", account: "944937319445", cloudFormationRoleName: `agentx-${env}-cloudformation`, artifactBucketArn: `arn:aws:s3:::agentx-${env}-access-artifactbucket-abcdefghijkl`, rovaraOrganizationId: `o-${"a".repeat(32)}`,
  } as PolicyScope);
  it("the service role's inline policy is 9,002 of 10,240 in the worst case (9,198 before fix/0512-small folded PassRoles into IamRoles; 7,864 before TR-SWITCH-B1/B2 added the Team record's storage grants, 1,334) (the service role already allows s3, kms and dynamodb on the stack)", () => {
    const longest = scope("a".repeat(20));
    expect(size(serviceRoleStatements(longest))).toBe(9002);
    const statements = serviceRoleStatements(longest);
    expect(JSON.stringify(statements)).not.toContain("fixtures");
    const services = statements.find((statement) => statement.Sid === "Services")!.Action;
    expect(services).toEqual(expect.arrayContaining(["s3:*", "kms:*", "dynamodb:*"]));
  });
  it("the default boundary is 6,014 of 6,144 in the worst case (integ/054 tightened it from 6,048 to 5,585; TR-SWITCH-B1/B2 added 429 for the Team record's three services, Glue reads, GetDataAccess, the vector role and the sharing Deny)", () => {
    expect(size(withoutSids(defaultBoundaryStatements(scope("a".repeat(20)))))).toBe(6014);
  });
});
