// Owner decision 2026-11-17: every IAM role Rovara Cloud makes carries a permissions boundary, matching Rovara Code's pattern, before any
// real customer install. Here: every stack shape Cloud synthesizes (web with and without product AI, the first address, the pipeline,
// the gateway's images, the gateway alone and with product AI, Rovara's AI and bring-your-own Bedrock) has no role without the
// boundary; the boundary is the environment's; it breaks nothing a role's own policy grants; and adding it replaces no deployed role.
import { App, Aspects, CfnResource, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { Code } from "aws-cdk-lib/aws-lambda";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CloudAppStack } from "../../infra/lib/cloud-app.js";
import { CDK_BOOTSTRAP_QUALIFIER, RequireCloudBoundary, applyCloudBoundary, cloudBoundaryName, cloudBoundaryStatements, cloudRolePath } from "../../infra/lib/cloud-boundary.js";
import { boundaryViolations, globMatch, resolvedBoundaries, roleCases, type CfnTemplate, type StackTemplate } from "../../infra/lib/cloud-boundary-check.js";
import { CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER, CloudReleasePipelineStack } from "../../infra/lib/cloud-release-pipeline.js";
import { CloudWebStack } from "../../infra/lib/cloud-web.js";
import { BEDROCK_BYO_CUSTOMER_ROLE_PREFIX, MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY, MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, bedrockBrokerRoleName } from "../../infra/lib/model-gateway.js";

const ENV = "staging";
const REGION = "us-west-2";
const scope = { env: ENV, partition: "aws", region: REGION, account: "123456789012" };
type Resource = { Type: string; Properties: Record<string, unknown> };

const built = (() => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-boundary-app-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "export {};");
  return dir;
})();

const toTemplate = (stack: Stack): StackTemplate => ({ stackName: stack.stackName, template: Template.fromStack(stack).toJSON() as CfnTemplate });

/** Cloud's web and first-address stacks, as -c rovaraCloudApp=<env> makes them (with stand-ins for the bundled function). */
function cloudApp(productAi: boolean): StackTemplate[] {
  const app = new App();
  Aspects.of(app).add(new RequireCloudBoundary());
  const web = new CloudWebStack(app, "RovaraCloudWeb", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-web`, env: { region: REGION }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi ? { productAi: true } : {}) });
  const first = new CloudAppStack(app, "RovaraCloudApp", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-app`, env: { region: REGION }, movedTo: web.origin });
  return [toTemplate(web), toTemplate(first)];
}
function pipeline(): StackTemplate[] {
  const app = new App();
  Aspects.of(app).add(new RequireCloudBoundary());
  return [toTemplate(new CloudReleasePipelineStack(app, "RovaraCloudPipeline", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-pipeline`, env: { region: REGION } }))];
}
function gateway(context: Record<string, string>): StackTemplate[] {
  const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: ENV, agentxRegion: REGION, ...context });
  return ["RovaraModelGatewayImages", "RovaraModelGateway"].map((id) => toTemplate(app.node.findChild(id) as Stack));
}
const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };
const SHAPES: Record<string, () => StackTemplate[]> = {
  "web + first address": () => cloudApp(false),
  "web with product AI + first address": () => cloudApp(true),
  pipeline,
  "gateway (images + gateway)": () => gateway({}),
  "gateway with product AI": () => gateway(productOn),
  "gateway with Rovara's AI": () => gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "org_00000000000000000000" }),
  "gateway with BYO Bedrock": () => gateway({ ...productOn, [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" }),
  "gateway, everything on (staging)": () => gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "org_00000000000000000000", [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" }),
};
const synthesized = Object.fromEntries(Object.entries(SHAPES).map(([name, make]) => [name, make()]));
const byType = (t: StackTemplate, type: string) => Object.entries(t.template.Resources as Record<string, Resource>).filter(([, r]) => r.Type === type);
const part = (t: StackTemplate) => t.stackName.slice(`rovara-cloud-${ENV}-`.length);

describe("every role Rovara Cloud makes carries the environment's permissions boundary", () => {
  it.each(Object.keys(SHAPES))("%s: no AWS::IAM::Role without PermissionsBoundary, and it is this stack's boundary policy", (shape) => {
    let roles = 0;
    for (const stack of synthesized[shape]!) {
      const policies = byType(stack, "AWS::IAM::ManagedPolicy").filter(([, r]) => String(r.Properties.ManagedPolicyName).endsWith("-boundary"));
      expect(policies, stack.stackName).toHaveLength(1);
      const [policyId, policy] = policies[0]!;
      expect(policy.Properties.ManagedPolicyName).toBe(cloudBoundaryName(ENV, part(stack) as Parameters<typeof cloudBoundaryName>[1]));
      expect(policy.Properties.Path).toBe(`/rovara-cloud/${ENV}/`);
      // The boundary bounds; it is attached to nothing.
      expect(policy.Properties.Roles ?? policy.Properties.Users ?? policy.Properties.Groups).toBeUndefined();
      for (const [id, role] of byType(stack, "AWS::IAM::Role")) {
        roles += 1;
        expect(role.Properties.PermissionsBoundary, `${stack.stackName}/${id}`).toEqual({ Ref: policyId });
      }
    }
    expect(roles).toBeGreaterThan(0);
  });

  it("the boundary is the environment's: the same statements in every stack and every shape (no switch changes it)", () => {
    const docs = Object.values(synthesized).flat().map((stack) => JSON.stringify(resolvedBoundaries([stack], scope)[stack.stackName]));
    expect(new Set(docs).size).toBe(1);
    expect((JSON.parse(docs[0]!) as { Statement: unknown }).Statement).toEqual(cloudBoundaryStatements(scope));
  });

  it("a role CDK makes for its own custom resources (BucketDeployment) carries it too", () => {
    const [web] = synthesized["web + first address"]!;
    const custom = byType(web!, "AWS::IAM::Role").filter(([id]) => id.startsWith("CustomCDKBucketDeployment"));
    expect(custom).toHaveLength(1);
    expect(custom[0]![1].Properties.PermissionsBoundary).toBeDefined();
  });

  it("a plain CfnResource role (CDK's custom-resource providers) gets it by override; an existing boundary is refused, never overwritten", () => {
    const stack = new Stack(new App(), "S", { env: { region: REGION } });
    applyCloudBoundary(stack, ENV, "gateway");
    new CfnResource(stack, "Raw", { type: "AWS::IAM::Role", properties: { AssumeRolePolicyDocument: {} } });
    const t = Template.fromStack(stack).toJSON() as CfnTemplate;
    expect(t.Resources.Raw!.Properties!.PermissionsBoundary).toEqual({ Ref: "RoleBoundary" });
    expect(t.Resources.Raw!.Properties!.Path).toBe(`/rovara-cloud/${ENV}/`);

    const typed = new Stack(new App(), "T", { env: { region: REGION } });
    applyCloudBoundary(typed, ENV, "web");
    new iam.Role(typed, "Has", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyName(typed, "Else", "else") });
    expect(() => Template.fromStack(typed)).toThrow(/already has a permissions boundary/);
    const plain = new Stack(new App(), "P", { env: { region: REGION } });
    applyCloudBoundary(plain, ENV, "web");
    new CfnResource(plain, "Raw", { type: "AWS::IAM::Role", properties: { AssumeRolePolicyDocument: {}, PermissionsBoundary: "arn:aws:iam::123456789012:policy/else" } });
    expect(() => Template.fromStack(plain)).toThrow(/already has a permissions boundary/);
    expect(() => applyCloudBoundary(plain, ENV, "web")).toThrow(/already has its boundary/);
  });

  it("a role in a stack that never applied the boundary fails the synth (the app-wide guard)", () => {
    const app = new App();
    Aspects.of(app).add(new RequireCloudBoundary());
    const stack = new Stack(app, "Forgot", { env: { region: REGION } });
    new iam.Role(stack, "R", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
    expect(() => app.synth()).toThrow(/no Rovara Cloud boundary/);
  });
});

describe("role paths: no deployed role is replaced", () => {
  /** The roles live on staging (web and app stacks): logical ids as deployed, and at "/" (a new Path would replace them). */
  const DEPLOYED = { web: ["ServerServiceRole3DA1B1D6", "CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C512MiBServiceRoleBA21DBC1"], app: ["RedirectServiceRole39B6C513"] };

  it("web and app: the deployed roles keep their logical ids and get no Path, only the boundary (an in-place update)", () => {
    for (const shape of ["web + first address", "web with product AI + first address"]) {
      const [web, first] = synthesized[shape]!;
      for (const [stack, ids] of [[web!, DEPLOYED.web], [first!, DEPLOYED.app]] as const) {
        const roles = Object.fromEntries(byType(stack, "AWS::IAM::Role"));
        expect(Object.keys(roles).sort()).toEqual([...ids].sort());
        for (const id of ids) {
          expect(roles[id]!.Properties.Path).toBeUndefined();
          expect(roles[id]!.Properties.RoleName).toBeUndefined();
        }
      }
    }
  });

  it("pipeline: roles at \"/\" (CodeBuild names its service role by name, which only works at \"/\")", () => {
    for (const [id, role] of byType(synthesized.pipeline![0]!, "AWS::IAM::Role")) expect(role.Properties.Path, id).toBeUndefined();
  });

  it("gateway (no live roles): every role under /rovara-cloud/<env>/, except the broker's fixed name customers trust", () => {
    for (const shape of ["gateway, everything on (staging)"]) {
      for (const stack of synthesized[shape]!) {
        for (const [id, role] of byType(stack, "AWS::IAM::Role")) {
          if (role.Properties.RoleName === bedrockBrokerRoleName(ENV)) expect(role.Properties.Path, id).toBeUndefined();
          else expect(role.Properties.Path, id).toBe(cloudRolePath(ENV));
        }
      }
    }
    const broker = byType(synthesized["gateway, everything on (staging)"]![1]!, "AWS::IAM::Role").filter(([, r]) => r.Properties.RoleName !== undefined);
    expect(broker.map(([, r]) => r.Properties.RoleName)).toEqual(["RovaraBedrockBroker-staging"]);
  });
});

describe("the boundary breaks nothing a Cloud role's own policy grants", () => {
  it.each(Object.keys(SHAPES))("%s: every (action, resource) of every role is inside its boundary", (shape) => {
    const stacks = synthesized[shape]!;
    expect(roleCases(stacks, scope).length).toBeGreaterThan(0);
    expect(boundaryViolations(stacks, scope).map((v) => `${v.role} ${v.action} ${v.resource} ${v.reason}`)).toEqual([]);
  });

  it("covers the grants that matter: the server's table, secret, key and setting; the gateway's Bedrock, broker and customer roles", () => {
    const cases = [...roleCases(synthesized["web with product AI + first address"]!, scope), ...roleCases(synthesized["gateway, everything on (staging)"]!, scope)];
    const has = (action: string, resource: RegExp) => cases.some((c) => c.action === action && resource.test(c.resource));
    expect(has("dynamodb:PutItem", /:table\/rovara-cloud-staging-web-State/u)).toBe(true);
    expect(has("dynamodb:GetItem", /:table\/rovara-cloud-staging-gateway-ProductKeys/u)).toBe(true);
    expect(has("secretsmanager:GetSecretValue", /:secret:rovara-cloud\/staging\/code-client-secret/u)).toBe(true);
    expect(has("ssm:GetParameter", /:parameter\/rovara-cloud\/staging\/web\/origin$/u)).toBe(true);
    expect(has("logs:PutLogEvents", /:log-group:rovara-cloud-staging-web-Logs/u)).toBe(true);
    expect(has("bedrock:InvokeModel", /:foundation-model\//u)).toBe(true);
    expect(has("sts:AssumeRole", /:role\/RovaraBedrockBroker-staging$/u)).toBe(true);
    expect(has("sts:AssumeRole", new RegExp(`:iam::\\*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}\\*$`, "u"))).toBe(true);
    expect(has("ecr:BatchGetImage", /:repository\/rovara-cloud-staging-gateway-images-/u)).toBe(true);
  });

  it("reports a grant outside the boundary, one a Deny touches, and a role with no boundary (the check can fail)", () => {
    const [web, first] = cloudApp(false);
    const widen = (statement: Record<string, unknown>): StackTemplate[] => {
      const t = structuredClone(web!.template) as CfnTemplate & { Resources: Record<string, Resource> };
      const policy = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes("ServerServiceRole"))!;
      (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push(statement);
      return [{ stackName: web!.stackName, template: t }, first!];
    };
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::someone-elses-bucket/*" }), scope)).toMatchObject([{ action: "s3:GetObject", reason: "not allowed by the boundary" }]);
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "dynamodb:Scan", Resource: { "Fn::GetAtt": ["State1C20CC9A", "Arn"] } }), scope)).toMatchObject([{ action: "dynamodb:Scan" }]);
    // Another environment's table is outside (staging's boundary never matches staging-eu's names).
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "dynamodb:GetItem", Resource: "arn:aws:dynamodb:us-west-2:123456789012:table/rovara-cloud-staging-eu-web-State-X" }), scope)).toHaveLength(1);
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::123456789012:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-123456789012-us-west-2` }), scope)).toMatchObject([{ reason: "not allowed by the boundary" }]);
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "iam:*", Resource: "*" }), scope)).toHaveLength(1);
    const unbounded = structuredClone(web!.template) as CfnTemplate & { Resources: Record<string, Resource> };
    delete unbounded.Resources.ServerServiceRole3DA1B1D6!.Properties.PermissionsBoundary;
    expect(() => boundaryViolations([{ stackName: web!.stackName, template: unbounded }], scope)).toThrow(/has no permissions boundary/);
    // An unknown parameter or intrinsic is an error, never a guess.
    expect(() => boundaryViolations(widen({ Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Select": [0, ["x"]] } }), scope)).toThrow(/no rule for Fn::Select/);
  });

  it("the Deny statements win over any Allow a later change might add to the boundary", () => {
    const statements = cloudBoundaryStatements(scope);
    const denies = statements.filter((s) => s.Effect === "Deny").map((s) => s.Sid);
    expect(denies).toEqual(["DenyIamChanges", "DenyAccountChanges", "DenyKeyManagement", "DenyDeployExecutionRole"]);
    const [web, first] = cloudApp(false);
    const t = structuredClone(web!.template) as CfnTemplate & { Resources: Record<string, Resource> };
    const boundary = t.Resources.RoleBoundary!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    boundary.Statement.unshift({ Sid: "Wide", Effect: "Allow", Action: ["*"], Resource: ["*"] });
    const policy = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes("ServerServiceRole"))!;
    (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", Action: "iam:CreateRole", Resource: "*" }, { Effect: "Allow", Action: "kms:PutKeyPolicy", Resource: "*" });
    expect(boundaryViolations([{ stackName: web!.stackName, template: t }, first!], scope).map((v) => v.reason)).toEqual(["denied by the boundary's DenyIamChanges", "denied by the boundary's DenyKeyManagement"]);
  });

  it("the boundary names no role, user, group or policy management, and only this environment's names", () => {
    const allows = cloudBoundaryStatements(scope).filter((s) => s.Effect === "Allow");
    const actions = allows.flatMap((s) => s.Action);
    expect(actions.filter((a) => a.startsWith("iam:"))).toEqual(["iam:PassRole"]);
    expect(actions.filter((a) => a === "*" || a.endsWith(":*"))).toEqual([]);
    expect(actions.filter((a) => a.startsWith("sts:"))).toEqual(["sts:AssumeRole"]);
    // Every resource is this account's (or, for Bedrock models and customers' Bedrock roles, the one documented exception), and none is
    // another environment's: no `rovara-cloud-staging*` without the stack part. (CDK grants the events role ecs:TagResource on tasks with
    // the account as `*`; the cluster's name, generated from the stack name, holds it to this environment's gateway.)
    for (const resource of allows.flatMap((s) => s.Resource)) {
      if (resource === "*") continue;
      expect(resource.includes(":123456789012:") || resource.includes("::123456789012:") || resource.includes("-123456789012-") || /^arn:aws:(s3|bedrock):/u.test(resource) || resource.includes(`role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}`) || resource === "arn:aws:ecs:us-west-2:*:task/rovara-cloud-staging-gateway-*", resource).toBe(true);
      expect(resource, resource).not.toMatch(/rovara-cloud-staging\*/u);
    }
    expect(allows.filter((s) => s.Resource.includes("*")).map((s) => s.Sid)).toEqual(["ImageToken"]);
    expect(CDK_BOOTSTRAP_QUALIFIER).toBe(CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER);
  });

  it("fits in a managed policy (6,144 characters without whitespace), with room, for the longest environment name, Region and partition", () => {
    for (const longest of [{ ...scope, env: "abcdefghijklmn", region: "ap-southeast-3" }, { env: "abcdefghijklmn", partition: "aws-us-gov", region: "us-gov-west-1", account: "123456789012" }]) {
      expect(JSON.stringify({ Version: "2012-10-17", Statement: cloudBoundaryStatements(longest) }).length).toBeLessThan(6144 - 250);
    }
  });

  it("matches IAM wildcards: * spans, ? is one character, a pattern's own * is only covered by a * ", () => {
    expect(globMatch("arn:aws:s3:::a-*", "arn:aws:s3:::a-b/c")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "abbc")).toBe(false);
    expect(globMatch("cdk-x-deploy-role", "cdk-x-*")).toBe(false);
    expect(globMatch("log-group:*", "log-group:a:*")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
  });
});
