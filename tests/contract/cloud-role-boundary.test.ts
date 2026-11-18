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
import { BOUNDARY_LOGICAL_ID, CDK_BOOTSTRAP_QUALIFIER, CLOUD_STACK_PARTS, GATEWAY_PROVIDER_SECRET_LOGICAL_IDS, RequireCloudBoundary, applyCloudBoundary, cloudBoundaryStatements, cloudPartRolePath, type CloudStackPart } from "../../infra/lib/cloud-boundary.js";
import { boundaryViolations, globMatch, overlaps, resolvedBoundaries, roleCases, type CfnTemplate, type StackTemplate } from "../../infra/lib/cloud-boundary-check.js";
import { CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER, CloudReleasePipelineStack } from "../../infra/lib/cloud-release-pipeline.js";
import { CloudWebStack } from "../../infra/lib/cloud-web.js";
import { BEDROCK_BYO_CUSTOMER_ROLE_PREFIX, MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY, MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, MODEL_GATEWAY_PROVIDERS, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, bedrockBrokerRoleName } from "../../infra/lib/model-gateway.js";

const ENV = "staging";
/** The longest environment name the rules allow (14 characters): generated names get shortened past their limits. */
const LONG_ENV = "abcdefghijklmn";
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
function cloudApp(productAi: boolean, ENV = "staging"): StackTemplate[] {
  const app = new App();
  Aspects.of(app).add(new RequireCloudBoundary());
  const web = new CloudWebStack(app, "RovaraCloudWeb", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-web`, env: { region: REGION }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi ? { productAi: true } : {}) });
  const first = new CloudAppStack(app, "RovaraCloudApp", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-app`, env: { region: REGION }, movedTo: web.origin });
  return [toTemplate(web), toTemplate(first)];
}
function pipeline(ENV = "staging"): StackTemplate[] {
  const app = new App();
  Aspects.of(app).add(new RequireCloudBoundary());
  return [toTemplate(new CloudReleasePipelineStack(app, "RovaraCloudPipeline", { environmentName: ENV, stackName: `rovara-cloud-${ENV}-pipeline`, env: { region: REGION } }))];
}
function gateway(context: Record<string, string>, ENV = "staging"): StackTemplate[] {
  const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: ENV, agentxRegion: REGION, ...context });
  return ["RovaraModelGatewayImages", "RovaraModelGateway"].map((id) => toTemplate(app.node.findChild(id) as Stack));
}
const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };
const SHAPES: Record<string, () => StackTemplate[]> = {
  "web + first address": () => cloudApp(false),
  "web with product AI + first address": () => cloudApp(true),
  pipeline: () => pipeline(),
  "gateway (images + gateway)": () => gateway({}),
  // The provider secrets' two namings (model-gateway.ts MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY): generated (the default, above) and fixed.
  "gateway with fixed provider secret names": () => gateway({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" }),
  "gateway, everything on, fixed provider secret names": () => gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "org_00000000000000000000", [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on", [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" }),
  "gateway with product AI": () => gateway(productOn),
  "gateway with Rovara's AI": () => gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "org_00000000000000000000" }),
  "gateway with BYO Bedrock": () => gateway({ ...productOn, [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" }),
  "gateway, everything on (staging)": () => gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "org_00000000000000000000", [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" }),
};
const synthesized = Object.fromEntries(Object.entries(SHAPES).map(([name, make]) => [name, make()]));
const byType = (t: StackTemplate, type: string) => Object.entries(t.template.Resources as Record<string, Resource>).filter(([, r]) => r.Type === type);
const part = (t: StackTemplate) => t.stackName.slice(`rovara-cloud-${ENV}-`.length) as CloudStackPart;

describe("every role Rovara Cloud makes carries the environment's permissions boundary", () => {
  it.each(Object.keys(SHAPES))("%s: no AWS::IAM::Role without PermissionsBoundary, and it is this stack's boundary policy", (shape) => {
    let roles = 0;
    for (const stack of synthesized[shape]!) {
      const policies = byType(stack, "AWS::IAM::ManagedPolicy").filter(([, r]) => r.Properties.Roles === undefined);
      expect(policies.map(([id]) => id), stack.stackName).toEqual([BOUNDARY_LOGICAL_ID]);
      const [policyId, policy] = policies[0]!;
      // CloudFormation names it (no name collision across Regions or a retained copy), under the environment's path.
      expect(policy.Properties.ManagedPolicyName).toBeUndefined();
      expect(policy.Properties.Path).toBe(`/rovara-cloud/${ENV}/`);
      // The gateway's is retained with its retained Bedrock broker role (a policy in use as a boundary can't be deleted).
      const retained = (stack.template.Resources as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>)[policyId]!;
      expect([retained.DeletionPolicy, retained.UpdateReplacePolicy]).toEqual(part(stack) === "gateway" ? ["Retain", "Retain"] : [undefined, undefined]);
      // The boundary bounds; it is attached to nothing.
      expect(policy.Properties.Roles ?? policy.Properties.Users ?? policy.Properties.Groups).toBeUndefined();
      for (const [id, role] of byType(stack, "AWS::IAM::Role")) {
        roles += 1;
        expect(role.Properties.PermissionsBoundary, `${stack.stackName}/${id}`).toEqual({ Ref: policyId });
      }
    }
    expect(roles).toBeGreaterThan(0);
  });

  it("each stack's boundary is its part's, the same in every shape (no switch changes it)", () => {
    for (const stack of Object.values(synthesized).flat()) {
      expect(resolvedBoundaries([stack], scope)[stack.stackName]!.Statement, stack.stackName).toEqual(cloudBoundaryStatements(scope, part(stack)));
    }
  });

  it("a role CDK makes for its own custom resources (BucketDeployment) carries it too", () => {
    const [web] = synthesized["web + first address"]!;
    const custom = byType(web!, "AWS::IAM::Role").filter(([id]) => id.startsWith("CustomCDKBucketDeployment"));
    expect(custom).toHaveLength(1);
    expect(custom[0]![1].Properties.PermissionsBoundary).toBeDefined();
    // Its function logs to a group named from the stack (its default /aws/lambda/<name> would be a shortened, unmatchable name).
    const fn = byType(web!, "AWS::Lambda::Function").find(([id]) => id.startsWith("CustomCDKBucketDeployment"))![1];
    expect((fn.Properties.LoggingConfig as { LogGroup: { Ref: string } }).LogGroup.Ref).toMatch(/^AppFilesLogs/u);
  });

  it("a plain CfnResource role (CDK's custom-resource providers) gets it by override; an existing boundary is refused, never overwritten", () => {
    const stack = new Stack(new App(), "S", { env: { region: REGION } });
    applyCloudBoundary(stack, ENV, "gateway");
    new CfnResource(stack, "Raw", { type: "AWS::IAM::Role", properties: { AssumeRolePolicyDocument: {} } });
    const t = Template.fromStack(stack).toJSON() as CfnTemplate;
    expect(t.Resources.Raw!.Properties!.PermissionsBoundary).toEqual({ Ref: "RoleBoundary" });
    expect(t.Resources.Raw!.Properties!.Path).toBe(`/rovara-cloud/${ENV}/gateway/`);

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

  it("pipeline (not deployed): roles under /rovara-cloud/<env>/pipeline/, except the CodeBuild service roles", () => {
    const roles = byType(synthesized.pipeline![0]!, "AWS::IAM::Role");
    expect(roles.filter(([, r]) => r.Properties.Path === undefined).map(([id]) => id).sort()).toEqual(["CheckRole8E91A0E7", "DeployRoleFF7E9D15"]);
    expect(roles.filter(([, r]) => r.Properties.Path === cloudPartRolePath(ENV, "pipeline"))).toHaveLength(roles.length - 2);
    // Exactly the roles the projects name, by Ref.
    const named = byType(synthesized.pipeline![0]!, "AWS::CodeBuild::Project").map(([, p]) => p.Properties.ServiceRole);
    expect(named).toEqual(expect.arrayContaining([{ "Fn::GetAtt": ["DeployRoleFF7E9D15", "Arn"] }, { "Fn::GetAtt": ["CheckRole8E91A0E7", "Arn"] }]));
  });

  it("gateway (no live roles): every role under /rovara-cloud/<env>/, except the broker's fixed name customers trust", () => {
    for (const shape of ["gateway, everything on (staging)"]) {
      for (const stack of synthesized[shape]!) {
        for (const [id, role] of byType(stack, "AWS::IAM::Role")) {
          if (role.Properties.RoleName === bedrockBrokerRoleName(ENV)) expect(role.Properties.Path, id).toBeUndefined();
          else expect(role.Properties.Path, id).toBe(cloudPartRolePath(ENV, "gateway"));
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
    // The serving role reads its provider key secrets under both namings: generated (`<logical id>-<random>`) and fixed.
    expect(has("secretsmanager:GetSecretValue", /:secret:ProviderKeyanthropic-a1b2c3d4e5f6-AbCdEf$/u)).toBe(true);
    const fixedCases = roleCases(synthesized["gateway, everything on, fixed provider secret names"]!, scope);
    expect(fixedCases.some((c) => c.action === "secretsmanager:GetSecretValue" && /:secret:rovara-cloud\/staging\/model-gateway\/provider\/anthropic-AbCdEf$/u.test(c.resource))).toBe(true);
  });

  it("names the gateway's provider secrets by their logical ids, in both namings, and only in the gateway's boundary", () => {
    expect(GATEWAY_PROVIDER_SECRET_LOGICAL_IDS).toEqual(MODEL_GATEWAY_PROVIDERS.map((provider) => `ProviderKey${provider}`));
    for (const shape of ["gateway (images + gateway)", "gateway with fixed provider secret names"]) {
      expect(byType(synthesized[shape]![1]!, "AWS::SecretsManager::Secret").map(([id]) => id), shape).toEqual([...GATEWAY_PROVIDER_SECRET_LOGICAL_IDS]);
    }
    const ownSecrets = (p: CloudStackPart) => cloudBoundaryStatements(scope, p).find((s) => s.Sid === "OwnSecrets")?.Resource;
    expect(ownSecrets("gateway")).toEqual(["arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/*", "arn:aws:secretsmanager:us-west-2:123456789012:secret:ProviderKeyanthropic-*"]);
    expect(ownSecrets("web")).toEqual(["arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/*"]);
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
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::123456789012:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-123456789012-us-west-2` }), scope)).toMatchObject([{ reason: "not allowed by the boundary" }]);
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "s3:PutObject", Resource: `arn:aws:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-123456789012-us-west-2/x.zip` }), scope)).toHaveLength(1);
    expect(boundaryViolations(widen({ Effect: "Allow", Action: "iam:*", Resource: "*" }), scope)).toHaveLength(1);
    const unbounded = structuredClone(web!.template) as CfnTemplate & { Resources: Record<string, Resource> };
    delete unbounded.Resources.ServerServiceRole3DA1B1D6!.Properties.PermissionsBoundary;
    expect(() => boundaryViolations([{ stackName: web!.stackName, template: unbounded }], scope)).toThrow(/has no permissions boundary/);
    // An unknown parameter or intrinsic is an error, never a guess.
    expect(() => boundaryViolations(widen({ Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Select": [0, ["x"]] } }), scope)).toThrow(/no rule for Fn::Select/);
  });

  it("the Deny statements win over any Allow a later change might add to the boundary", () => {
    for (const p of CLOUD_STACK_PARTS) {
      expect(cloudBoundaryStatements(scope, p).filter((s) => s.Effect === "Deny").map((s) => s.Sid)).toEqual(["DenyIamChanges", "DenyAccountChanges", "DenyKeyManagement", "DenyAdminRoles"]);
    }
    const [web, first] = cloudApp(false);
    const t = structuredClone(web!.template) as CfnTemplate & { Resources: Record<string, Resource> };
    const boundary = t.Resources.RoleBoundary!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    boundary.Statement.unshift({ Sid: "Wide", Effect: "Allow", Action: ["*"], Resource: ["*"] });
    const policy = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes("ServerServiceRole"))!;
    (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push(
      { Effect: "Allow", Action: "iam:CreateRole", Resource: "*" },
      { Effect: "Allow", Action: "kms:PutKeyPolicy", Resource: "*" },
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-us-west-2" },
      // A wildcard that only partly overlaps a Deny pattern still counts as denied.
      { Effect: "Allow", Action: "iam:*Role", Resource: "*" },
    );
    expect(boundaryViolations([{ stackName: web!.stackName, template: t }, first!], scope).map((v) => v.reason)).toEqual([
      "denied by the boundary's DenyIamChanges", "denied by the boundary's DenyKeyManagement", "denied by the boundary's DenyAdminRoles", "denied by the boundary's DenyIamChanges",
    ]);
  });

  it("each part gets only what its roles use: bootstrap roles for the pipeline only, Bedrock for the gateway only, the asset bucket read-only", () => {
    const allowsOf = (p: CloudStackPart) => cloudBoundaryStatements(scope, p).filter((s) => s.Effect === "Allow");
    const sids = Object.fromEntries(CLOUD_STACK_PARTS.map((p) => [p, allowsOf(p).map((s) => s.Sid)]));
    expect(sids).toEqual({
      web: ["Logs", "TableItems", "OwnSecrets", "OwnSettings", "KeyUse", "OwnBuckets", "ReadDeployAssets"],
      app: ["Logs"],
      pipeline: ["Logs", "OwnBuckets", "PipelineBuilds", "PipelineSource", "ReleaseCheckReadsWebStack", "AssumeDeployRoles"],
      "gateway-images": [],
      gateway: ["Logs", "TableItems", "OwnSecrets", "KeyUse", "ModelCalls", "ImageToken", "ImagePull", "PriceFetchTask", "PassOwnRoles", "AssumeGatewayRoles", "AssumeCustomerBedrockRoles"],
    });
    const statement = (p: CloudStackPart, sid: string) => allowsOf(p).find((s) => s.Sid === sid)!;
    expect(statement("web", "KeyUse").Action).toEqual(["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateMac"]);
    expect(statement("gateway", "KeyUse").Action).toEqual(["kms:Decrypt", "kms:GenerateMac", "kms:VerifyMac"]);
    expect(statement("web", "ReadDeployAssets").Action).toEqual(["s3:GetObject*", "s3:GetBucket*", "s3:List*"]);
    expect(statement("pipeline", "AssumeDeployRoles").Resource).toEqual([
      "arn:aws:iam::123456789012:role/rovara-cloud/staging/pipeline/*",
      ...["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"].map((r) => `arn:aws:iam::123456789012:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${r}-123456789012-us-west-2`),
    ]);
    expect(statement("gateway", "AssumeGatewayRoles").Resource).toEqual([
      "arn:aws:iam::123456789012:role/rovara-cloud/staging/gateway/*", "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging",
    ]);
    expect(statement("gateway", "AssumeGatewayRoles").Condition).toBeUndefined();
    expect(statement("gateway", "AssumeCustomerBedrockRoles").Resource).toEqual([`arn:aws:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`]);
    for (const p of CLOUD_STACK_PARTS) {
      const allows = allowsOf(p);
      const actions = allows.flatMap((s) => s.Action);
      expect(actions.filter((a) => a.startsWith("iam:")), p).toEqual(p === "gateway" ? ["iam:PassRole"] : []);
      expect(actions.filter((a) => a === "*" || a.endsWith(":*")), p).toEqual([]);
      if (p !== "pipeline" && p !== "gateway") expect(actions.filter((a) => a.startsWith("sts:")), p).toEqual([]);
      if (p !== "gateway") expect(actions.filter((a) => a.startsWith("bedrock:")), p).toEqual([]);
      // Every resource is this account's, except exactly these (each explained in cloud-boundary.ts); none is another environment's.
      const elsewhere = new Set(["*", "arn:aws:bedrock:*::foundation-model/*", `arn:aws:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`, "arn:aws:ecs:us-west-2:*:task/rovara-cloud-staging-gateway-*", "arn:aws:s3:::rovara-cloud-staging-web-*", "arn:aws:s3:::rovara-cloud-staging-pipeline-*"]);
      for (const resource of allows.flatMap((s) => s.Resource)) {
        expect(elsewhere.has(resource) || /:123456789012:|-123456789012-/u.test(resource), `${p} ${resource}`).toBe(true);
        expect(resource, resource).not.toMatch(/rovara-cloud-staging\*/u);
      }
      expect(allows.filter((s) => s.Resource.includes("*")).map((s) => s.Sid), p).toEqual(p === "gateway" ? ["ImageToken"] : []);
    }
    expect(CDK_BOOTSTRAP_QUALIFIER).toBe(CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER);
  });

  it("every part's boundary, exactly (any widening of a resource or action fails here)", () => {
    expect(Object.fromEntries(CLOUD_STACK_PARTS.map((p) => [p, cloudBoundaryStatements(scope, p)]))).toMatchInlineSnapshot(`
      {
        "app": [
          {
            "Action": [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:logs:us-west-2:123456789012:log-group:rovara-cloud-staging-app-*",
            ],
            "Sid": "Logs",
          },
          {
            "Action": [
              "iam:Create*",
              "iam:Delete*",
              "iam:Put*",
              "iam:Attach*",
              "iam:Detach*",
              "iam:Update*",
              "iam:Add*",
              "iam:Remove*",
              "iam:Set*",
              "iam:Tag*",
              "iam:Untag*",
              "iam:Upload*",
              "iam:Change*",
              "iam:Reset*",
              "iam:Enable*",
              "iam:Deactivate*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyIamChanges",
          },
          {
            "Action": [
              "organizations:*",
              "account:*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyAccountChanges",
          },
          {
            "Action": [
              "kms:PutKeyPolicy",
              "kms:CreateGrant",
              "kms:ScheduleKeyDeletion",
              "kms:DisableKey",
              "kms:Delete*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyKeyManagement",
          },
          {
            "Action": [
              "sts:AssumeRole",
              "iam:PassRole",
            ],
            "Effect": "Deny",
            "Resource": [
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-*",
            ],
            "Sid": "DenyAdminRoles",
          },
        ],
        "gateway": [
          {
            "Action": [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:logs:us-west-2:123456789012:log-group:rovara-cloud-staging-gateway-*",
            ],
            "Sid": "Logs",
          },
          {
            "Action": [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:ConditionCheckItem",
              "dynamodb:Query",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:dynamodb:us-west-2:123456789012:table/rovara-cloud-staging-gateway-*",
              "arn:aws:dynamodb:us-west-2:123456789012:table/rovara-cloud-staging-web-*",
            ],
            "Sid": "TableItems",
          },
          {
            "Action": [
              "secretsmanager:GetSecretValue",
              "secretsmanager:DescribeSecret",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/*",
              "arn:aws:secretsmanager:us-west-2:123456789012:secret:ProviderKeyanthropic-*",
            ],
            "Sid": "OwnSecrets",
          },
          {
            "Action": [
              "kms:Decrypt",
              "kms:GenerateMac",
              "kms:VerifyMac",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:kms:us-west-2:123456789012:key/*",
            ],
            "Sid": "KeyUse",
          },
          {
            "Action": [
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:bedrock:*::foundation-model/*",
              "arn:aws:bedrock:us-west-2:123456789012:inference-profile/*",
            ],
            "Sid": "ModelCalls",
          },
          {
            "Action": [
              "ecr:GetAuthorizationToken",
            ],
            "Effect": "Allow",
            "Resource": [
              "*",
            ],
            "Sid": "ImageToken",
          },
          {
            "Action": [
              "ecr:BatchCheckLayerAvailability",
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:ecr:us-west-2:123456789012:repository/rovara-cloud-staging-gateway-images-*",
            ],
            "Sid": "ImagePull",
          },
          {
            "Action": [
              "ecs:RunTask",
              "ecs:TagResource",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:ecs:us-west-2:123456789012:task-definition/*",
              "arn:aws:ecs:us-west-2:*:task/rovara-cloud-staging-gateway-*",
            ],
            "Sid": "PriceFetchTask",
          },
          {
            "Action": [
              "iam:PassRole",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:iam::123456789012:role/rovara-cloud/staging/gateway/*",
            ],
            "Sid": "PassOwnRoles",
          },
          {
            "Action": [
              "sts:AssumeRole",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:iam::123456789012:role/rovara-cloud/staging/gateway/*",
              "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging",
            ],
            "Sid": "AssumeGatewayRoles",
          },
          {
            "Action": [
              "sts:AssumeRole",
            ],
            "Condition": {
              "StringLike": {
                "sts:ExternalId": "rvb-*",
                "sts:RoleSessionName": "org_*",
              },
              "StringNotEquals": {
                "aws:ResourceAccount": "123456789012",
              },
            },
            "Effect": "Allow",
            "Resource": [
              "arn:aws:iam::*:role/RovaraBedrockInvoke-*",
            ],
            "Sid": "AssumeCustomerBedrockRoles",
          },
          {
            "Action": [
              "iam:Create*",
              "iam:Delete*",
              "iam:Put*",
              "iam:Attach*",
              "iam:Detach*",
              "iam:Update*",
              "iam:Add*",
              "iam:Remove*",
              "iam:Set*",
              "iam:Tag*",
              "iam:Untag*",
              "iam:Upload*",
              "iam:Change*",
              "iam:Reset*",
              "iam:Enable*",
              "iam:Deactivate*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyIamChanges",
          },
          {
            "Action": [
              "organizations:*",
              "account:*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyAccountChanges",
          },
          {
            "Action": [
              "kms:PutKeyPolicy",
              "kms:CreateGrant",
              "kms:ScheduleKeyDeletion",
              "kms:DisableKey",
              "kms:Delete*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyKeyManagement",
          },
          {
            "Action": [
              "sts:AssumeRole",
              "iam:PassRole",
            ],
            "Effect": "Deny",
            "Resource": [
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-*",
            ],
            "Sid": "DenyAdminRoles",
          },
        ],
        "gateway-images": [
          {
            "Action": [
              "iam:Create*",
              "iam:Delete*",
              "iam:Put*",
              "iam:Attach*",
              "iam:Detach*",
              "iam:Update*",
              "iam:Add*",
              "iam:Remove*",
              "iam:Set*",
              "iam:Tag*",
              "iam:Untag*",
              "iam:Upload*",
              "iam:Change*",
              "iam:Reset*",
              "iam:Enable*",
              "iam:Deactivate*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyIamChanges",
          },
          {
            "Action": [
              "organizations:*",
              "account:*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyAccountChanges",
          },
          {
            "Action": [
              "kms:PutKeyPolicy",
              "kms:CreateGrant",
              "kms:ScheduleKeyDeletion",
              "kms:DisableKey",
              "kms:Delete*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyKeyManagement",
          },
          {
            "Action": [
              "sts:AssumeRole",
              "iam:PassRole",
            ],
            "Effect": "Deny",
            "Resource": [
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-*",
            ],
            "Sid": "DenyAdminRoles",
          },
        ],
        "pipeline": [
          {
            "Action": [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:logs:us-west-2:123456789012:log-group:rovara-cloud-staging-pipeline-*",
              "arn:aws:logs:us-west-2:123456789012:log-group:/aws/codebuild/rovara-cloud-staging-deploy*",
              "arn:aws:logs:us-west-2:123456789012:log-group:/aws/codebuild/rovara-cloud-staging-check*",
            ],
            "Sid": "Logs",
          },
          {
            "Action": [
              "s3:GetObject*",
              "s3:GetBucket*",
              "s3:List*",
              "s3:DeleteObject*",
              "s3:PutObject*",
              "s3:Abort*",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:s3:::rovara-cloud-staging-pipeline-*",
            ],
            "Sid": "OwnBuckets",
          },
          {
            "Action": [
              "codebuild:BatchGetBuilds",
              "codebuild:StartBuild",
              "codebuild:StopBuild",
              "codebuild:CreateReport*",
              "codebuild:UpdateReport",
              "codebuild:BatchPut*",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:codebuild:us-west-2:123456789012:project/rovara-cloud-staging-deploy",
              "arn:aws:codebuild:us-west-2:123456789012:project/rovara-cloud-staging-check",
              "arn:aws:codebuild:us-west-2:123456789012:report-group/rovara-cloud-staging-deploy-*",
              "arn:aws:codebuild:us-west-2:123456789012:report-group/rovara-cloud-staging-check-*",
            ],
            "Sid": "PipelineBuilds",
          },
          {
            "Action": [
              "codeconnections:UseConnection",
              "codeconnections:GetConnectionToken",
              "codestar-connections:UseConnection",
              "codestar-connections:GetConnectionToken",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:codeconnections:*:123456789012:connection/*",
              "arn:aws:codestar-connections:*:123456789012:connection/*",
            ],
            "Sid": "PipelineSource",
          },
          {
            "Action": [
              "cloudformation:DescribeStacks",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:cloudformation:us-west-2:123456789012:stack/rovara-cloud-staging-web/*",
            ],
            "Sid": "ReleaseCheckReadsWebStack",
          },
          {
            "Action": [
              "sts:AssumeRole",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:iam::123456789012:role/rovara-cloud/staging/pipeline/*",
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-west-2",
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-file-publishing-role-123456789012-us-west-2",
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-image-publishing-role-123456789012-us-west-2",
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-lookup-role-123456789012-us-west-2",
            ],
            "Sid": "AssumeDeployRoles",
          },
          {
            "Action": [
              "iam:Create*",
              "iam:Delete*",
              "iam:Put*",
              "iam:Attach*",
              "iam:Detach*",
              "iam:Update*",
              "iam:Add*",
              "iam:Remove*",
              "iam:Set*",
              "iam:Tag*",
              "iam:Untag*",
              "iam:Upload*",
              "iam:Change*",
              "iam:Reset*",
              "iam:Enable*",
              "iam:Deactivate*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyIamChanges",
          },
          {
            "Action": [
              "organizations:*",
              "account:*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyAccountChanges",
          },
          {
            "Action": [
              "kms:PutKeyPolicy",
              "kms:CreateGrant",
              "kms:ScheduleKeyDeletion",
              "kms:DisableKey",
              "kms:Delete*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyKeyManagement",
          },
          {
            "Action": [
              "sts:AssumeRole",
              "iam:PassRole",
            ],
            "Effect": "Deny",
            "Resource": [
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-*",
            ],
            "Sid": "DenyAdminRoles",
          },
        ],
        "web": [
          {
            "Action": [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:logs:us-west-2:123456789012:log-group:rovara-cloud-staging-web-*",
            ],
            "Sid": "Logs",
          },
          {
            "Action": [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:ConditionCheckItem",
              "dynamodb:Query",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:dynamodb:us-west-2:123456789012:table/rovara-cloud-staging-web-*",
              "arn:aws:dynamodb:us-west-2:123456789012:table/rovara-cloud-staging-gateway-*",
            ],
            "Sid": "TableItems",
          },
          {
            "Action": [
              "secretsmanager:GetSecretValue",
              "secretsmanager:DescribeSecret",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/*",
            ],
            "Sid": "OwnSecrets",
          },
          {
            "Action": [
              "ssm:GetParameter",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:ssm:us-west-2:123456789012:parameter/rovara-cloud/staging/*",
            ],
            "Sid": "OwnSettings",
          },
          {
            "Action": [
              "kms:Decrypt",
              "kms:GenerateDataKey",
              "kms:GenerateMac",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:kms:us-west-2:123456789012:key/*",
            ],
            "Sid": "KeyUse",
          },
          {
            "Action": [
              "s3:GetObject*",
              "s3:GetBucket*",
              "s3:List*",
              "s3:DeleteObject*",
              "s3:PutObject*",
              "s3:Abort*",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:s3:::rovara-cloud-staging-web-*",
            ],
            "Sid": "OwnBuckets",
          },
          {
            "Action": [
              "s3:GetObject*",
              "s3:GetBucket*",
              "s3:List*",
            ],
            "Effect": "Allow",
            "Resource": [
              "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-us-west-2",
              "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-us-west-2/*",
            ],
            "Sid": "ReadDeployAssets",
          },
          {
            "Action": [
              "iam:Create*",
              "iam:Delete*",
              "iam:Put*",
              "iam:Attach*",
              "iam:Detach*",
              "iam:Update*",
              "iam:Add*",
              "iam:Remove*",
              "iam:Set*",
              "iam:Tag*",
              "iam:Untag*",
              "iam:Upload*",
              "iam:Change*",
              "iam:Reset*",
              "iam:Enable*",
              "iam:Deactivate*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyIamChanges",
          },
          {
            "Action": [
              "organizations:*",
              "account:*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyAccountChanges",
          },
          {
            "Action": [
              "kms:PutKeyPolicy",
              "kms:CreateGrant",
              "kms:ScheduleKeyDeletion",
              "kms:DisableKey",
              "kms:Delete*",
            ],
            "Effect": "Deny",
            "Resource": [
              "*",
            ],
            "Sid": "DenyKeyManagement",
          },
          {
            "Action": [
              "sts:AssumeRole",
              "iam:PassRole",
            ],
            "Effect": "Deny",
            "Resource": [
              "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-*",
            ],
            "Sid": "DenyAdminRoles",
          },
        ],
      }
    `);
  });

  it("fits in a managed policy (6,144 characters without whitespace), with room, for the longest environment name, Region and partition", () => {
    for (const longest of [{ ...scope, env: LONG_ENV, region: "ap-southeast-3" }, { env: LONG_ENV, partition: "aws-us-gov", region: "us-gov-west-1", account: "123456789012" }]) {
      for (const p of CLOUD_STACK_PARTS) expect(JSON.stringify({ Version: "2012-10-17", Statement: cloudBoundaryStatements(longest, p) }).length).toBeLessThan(6144 - 1000);
    }
  });

  it("the longest environment name (CloudFormation shortens long generated role and function names): still nothing breaks", () => {
    const long = { ...scope, env: LONG_ENV };
    for (const stacks of [cloudApp(true, LONG_ENV), pipeline(LONG_ENV), gateway({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on", [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" }, LONG_ENV)]) {
      expect(boundaryViolations(stacks, long).map((v) => `${v.role} ${v.action} ${v.resource} ${v.reason}`)).toEqual([]);
    }
    // The checker models the shortening: a boundary that named roles by the stack-name prefix (as the first version did) fails.
    const [p] = pipeline(LONG_ENV);
    const t = structuredClone(p!.template) as CfnTemplate & { Resources: Record<string, Resource> };
    for (const r of Object.values(t.Resources)) if (r.Type === "AWS::IAM::Role") delete r.Properties.Path;
    const boundary = t.Resources.RoleBoundary!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    boundary.Statement.unshift({ Sid: "ByPrefix", Effect: "Allow", Action: ["sts:AssumeRole"], Resource: [`arn:aws:iam::123456789012:role/rovara-cloud-${LONG_ENV}-pipeline-*`] });
    const assumes = boundaryViolations([{ stackName: p!.stackName, template: t }], long).filter((v) => v.action === "sts:AssumeRole");
    // The action roles' names (stack name + long logical ids) pass 64 characters: shortened, so no stack-name prefix matches them.
    expect(assumes.length).toBeGreaterThan(0);
  });

  it("matches IAM wildcards: * spans, ? is one character, a pattern's own * is only covered by a * ", () => {
    expect(globMatch("arn:aws:s3:::a-*", "arn:aws:s3:::a-b/c")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "abbc")).toBe(false);
    expect(globMatch("cdk-x-deploy-role", "cdk-x-*")).toBe(false);
    expect(globMatch("log-group:*", "log-group:a:*")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
    // Overlap: is there a string both patterns match.
    expect(overlaps("iam:*Role", "iam:Put*", true)).toBe(true);
    expect(overlaps("arn:aws:iam::*:role/RovaraBedrockInvoke-*", "arn:aws:iam::1:role/cdk-x-*", false)).toBe(false);
    expect(overlaps("arn:aws:iam::*:role/X-*", "arn:aws:iam::1:role/X-a", false)).toBe(true);
    expect(overlaps("a?c", "abd", false)).toBe(false);
    // A wildcard before the resource part may span a colon: compared as whole strings.
    expect(overlaps("arn:aws:iam::123456789012:role/cdk-x-cfn-exec-role-*", "arn:aws:iam::*cfn-exec-role-*", false)).toBe(true);
    expect(overlaps("arn:aws:iam::12*:role/a", "arn:aws:iam::123:role/a", false)).toBe(true);
  });
});
