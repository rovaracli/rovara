// L1b: the single release pipeline's private actions stack (infra/lib/cloud-release-actions.ts): the CodeBuild projects that run the stage CLI, their roles, the
// boundary of those roles and the names the public pipeline imports. No AWS and no real account: the templates are synthesized, the roles' grants are held to
// the boundary by the same check every other Cloud role passes (infra/lib/cloud-boundary-check.ts), and the buildspec's shell is run against a fake `node`.
import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { RELEASE_ACTIONS_PART, RequireCloudBoundary, applyCloudBoundary, cloudBoundaryStatements, releaseActionsParameterStatements, CLOUD_STACK_PARTS } from "../../infra/lib/cloud-boundary.js";
import { boundaryViolations, globMatch, resolvedBoundaries, roleCases, type CfnTemplate, type StackTemplate } from "../../infra/lib/cloud-boundary-check.js";
import {
  CLOUD_RELEASE_ACTIONS_CONTEXT_KEY, CLOUD_RELEASE_ACTIONS_OUTPUTS, CLOUD_RELEASE_ACTIONS_STACK_NAME, CLOUD_RELEASE_BUILD_ROLE_NAMES, CLOUD_RELEASE_EXPORTED_VARIABLES,
  CLOUD_RELEASE_PROJECT_NAMES, CLOUD_RELEASE_STEPS, CloudReleaseActionsStack, RELEASE_ACTION_TOOL_COMMANDS, RELEASE_ACTION_TOOL_VARIABLES, betaGatewayPullPolicy, releaseActionBuildCommands, releaseActionInstallCommands,
  type ReleaseActionEnvironment,
} from "../../infra/lib/cloud-release-actions.js";
import { renderExports } from "../../ops/pipeline/lib/summary.ts";
import type { Manifest } from "../../ops/pipeline/types.ts";

const REGION = "us-east-1";
const ENV = "production";
const ACCOUNT = "123456789012";
const scope = { env: ENV, partition: "aws", region: REGION, account: ACCOUNT };
type Resource = { Type: string; Properties: Record<string, unknown> };

function synthesize(env = ENV): { stack: Stack; stackTemplate: StackTemplate; template: CfnTemplate } {
  const app = new App();
  Aspects.of(app).add(new RequireCloudBoundary());
  const stack = new CloudReleaseActionsStack(app, "RovaraCloudReleaseActions", { environmentName: env, stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, env: { region: REGION } });
  const template = Template.fromStack(stack).toJSON() as CfnTemplate;
  return { stack, stackTemplate: { stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, template }, template };
}
const built = synthesize();
const resources = (template: CfnTemplate = built.template) => template.Resources as Record<string, Resource>;
const byType = (type: string) => Object.entries(resources()).filter(([, r]) => r.Type === type);
const roleId = (environment: ReleaseActionEnvironment) => byType("AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === CLOUD_RELEASE_BUILD_ROLE_NAMES[environment])![0];
const project = (environment: ReleaseActionEnvironment) => byType("AWS::CodeBuild::Project").find(([, r]) => r.Properties.Name === CLOUD_RELEASE_PROJECT_NAMES[environment])![1].Properties;
const casesOf = (environment: ReleaseActionEnvironment) => roleCases([built.stackTemplate], scope).filter((c) => c.role === roleId(environment));
const actionsOf = (environment: ReleaseActionEnvironment) => [...new Set(casesOf(environment).map((c) => c.action))].sort();

describe("the names the public pipeline imports", () => {
  it("are release- projects (its parameter pattern), equal to the defaults it ships with, and the fixed build role names the beta release role trusts", () => {
    expect(CLOUD_RELEASE_PROJECT_NAMES).toEqual({ beta: "release-cloud-beta", production: "release-cloud-production" });
    for (const name of Object.values(CLOUD_RELEASE_PROJECT_NAMES)) expect(name).toMatch(/^release-[A-Za-z0-9_-]{1,120}$/u);
    expect(CLOUD_RELEASE_BUILD_ROLE_NAMES).toEqual({ beta: "rovara-cloud-release-beta-build", production: "rovara-cloud-release-production-build" });
    expect(CLOUD_RELEASE_ACTIONS_STACK_NAME).toBe("rovara-cloud-release-actions");
    expect(CLOUD_RELEASE_ACTIONS_CONTEXT_KEY).toBe("rovaraCloudReleaseActions");
  });

  it("are the template's own: two projects, two roles, outputs by name, and the parameters the hand deploy passes (nothing else moves)", () => {
    expect(Object.fromEntries(Object.entries(resources()).map(([id, r]) => [id.replace(/[0-9A-F]{8}$/u, ""), r.Type]))).toEqual({
      BuildLogs: "AWS::Logs::LogGroup",
      BetaBuildRole: "AWS::IAM::Role", BetaBuildRoleDefaultPolicy: "AWS::IAM::Policy",
      ProductionBuildRole: "AWS::IAM::Role", ProductionBuildRoleDefaultPolicy: "AWS::IAM::Policy",
      BetaProject: "AWS::CodeBuild::Project", ProductionProject: "AWS::CodeBuild::Project",
      RoleBoundary: "AWS::IAM::ManagedPolicy",
    });
    expect(Object.keys(built.template.Parameters ?? {}).filter((name) => name !== "BootstrapVersion")).toEqual([
      "GitHubConnectionArn", "CloudConnectionArn", "ArtifactBucketName", "BetaAccountId", "ProductionPriceFetchTaskRoleArn", "ProductionPriceFetchExecutionRoleArn",
    ]);
    expect(Object.keys(built.template.Outputs ?? {})).toEqual(Object.values(CLOUD_RELEASE_ACTIONS_OUTPUTS));
    expect(Object.values(CLOUD_RELEASE_ACTIONS_OUTPUTS)).toEqual(["BetaProjectName", "ProductionProjectName", "BetaBuildRoleArn", "ProductionBuildRoleArn"]);
    expect(built.template.Outputs!.BetaProjectName!.Value).toEqual({ Ref: expect.stringMatching(/^BetaProject/u) as unknown });
    // Never exported: a cross-stack export would lock the names; the public pipeline takes them as parameters.
    for (const output of Object.values(built.template.Outputs ?? {})) expect(output.Export).toBeUndefined();
  });

  it("the public pipeline starts these as pipeline projects: source CODEPIPELINE, one per environment", () => {
    for (const environment of ["beta", "production"] as const) {
      expect(project(environment).Source).toMatchObject({ Type: "CODEPIPELINE" });
      expect(project(environment).Artifacts).toEqual({ Type: "CODEPIPELINE" });
    }
  });
});

describe("every role is bounded, named and trusted narrowly", () => {
  it("both roles carry this stack's boundary, have a fixed name and no path", () => {
    const roles = byType("AWS::IAM::Role");
    expect(roles).toHaveLength(2);
    for (const [id, role] of roles) {
      expect(role.Properties.PermissionsBoundary, id).toEqual({ Ref: "RoleBoundary" });
      expect(role.Properties.Path, id).toBeUndefined();
      expect(role.Properties.ManagedPolicyArns, id).toBeUndefined();
      expect(Object.values(CLOUD_RELEASE_BUILD_ROLE_NAMES)).toContain(role.Properties.RoleName);
    }
    const [boundary] = byType("AWS::IAM::ManagedPolicy");
    expect(boundary![0]).toBe("RoleBoundary");
    expect(boundary![1].Properties.Roles).toBeUndefined();
    expect(boundary![1].Properties.Path).toBe("/rovara-cloud/production/");
  });

  it("trusts CodeBuild only, for exactly its own project in this account, and each project uses its own role", () => {
    for (const environment of ["beta", "production"] as const) {
      const [id, role] = byType("AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === CLOUD_RELEASE_BUILD_ROLE_NAMES[environment])!;
      const statements = (role.Properties.AssumeRolePolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
      expect(statements).toHaveLength(1);
      expect(statements[0]).toEqual({
        Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" },
        Condition: { StringEquals: {
          "aws:SourceAccount": { Ref: "AWS::AccountId" },
          "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:codebuild:${REGION}:`, { Ref: "AWS::AccountId" }, `:project/${CLOUD_RELEASE_PROJECT_NAMES[environment]}`]] },
        } },
      });
      expect(project(environment).ServiceRole).toEqual({ "Fn::GetAtt": [id, "Arn"] });
    }
    // The role does not wait for its project (a circular reference): the trust names the fixed project ARN as text.
    expect(JSON.stringify(built.template)).not.toMatch(/"aws:SourceArn":\{"Fn::Join":\[[^\]]*"Ref":"(Beta|Production)Project/u);
  });

  it("the boundary's own check: nothing either role's policy grants is outside it or touched by an unconditional Deny", () => {
    expect(casesOf("beta").length).toBeGreaterThan(0);
    expect(casesOf("production").length).toBeGreaterThan(casesOf("beta").length);
    expect(boundaryViolations([built.stackTemplate], scope).map((v) => `${v.role} ${v.action} ${v.resource} ${v.reason}`)).toEqual([]);
  });

  it("fails the check when a grant is widened: another bucket, a CloudFormation write, the execution role, another account's role, a wider PassRole", () => {
    const widen = (statement: Record<string, unknown>): StackTemplate => {
      const t = structuredClone(built.template) as CfnTemplate & { Resources: Record<string, Resource> };
      const policy = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes("ProductionBuildRole"))!;
      (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push(statement);
      return { stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, template: t };
    };
    for (const statement of [
      { Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::someone-elses-bucket/*" },
      { Effect: "Allow", Action: "cloudformation:ExecuteChangeSet", Resource: "*" },
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-${REGION}` },
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::210987654321:role/OrganizationAccountAccessRole" },
      { Effect: "Allow", Action: "iam:PassRole", Resource: `arn:aws:iam::${ACCOUNT}:role/rovara-cloud/production/gateway/x`, Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } } },
      { Effect: "Allow", Action: "iam:PassRole", Resource: `arn:aws:iam::${ACCOUNT}:role/rovara-cloud/production/gateway/x` },
      { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" },
      { Effect: "Allow", Action: "ssm:PutParameter", Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-cloud/production/web/origin` },
      { Effect: "Allow", Action: "ecs:RunTask", Resource: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/RovaraModelGatewayServeTask*:*` },
      { Effect: "Allow", Action: "ecs:RunTask", Resource: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/RovaraModelGatewayPriceFetchTask*:*` },
    ]) expect(boundaryViolations([widen(statement)], scope), JSON.stringify(statement)).toHaveLength(1);
  });

  it("the boundary check understands the Bool deny it ignores, and refuses a conditional Deny it cannot read", () => {
    const [boundary] = byType("AWS::IAM::ManagedPolicy");
    const statements = (boundary![1].Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements.find((s) => s.Sid === "DenyExecIntoTasks")).toEqual({ Sid: "DenyExecIntoTasks", Effect: "Deny", Action: ["ecs:RunTask"], Resource: ["*"], Condition: { Bool: { "ecs:enable-execute-command": "true" } } });
    const t = structuredClone(built.template) as CfnTemplate & { Resources: Record<string, Resource> };
    const doc = t.Resources.RoleBoundary!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    doc.Statement.push({ Sid: "Odd", Effect: "Deny", Action: "s3:*", Resource: "*", Condition: { StringLike: { "aws:username": "a*" } } });
    // Any other conditional Deny is counted as applying: the grants it could touch are reported (never silently passed).
    expect(boundaryViolations([{ stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, template: t }], scope).map((v) => v.reason)).toEqual(expect.arrayContaining(["denied by the boundary's Odd (conditional: counted as applying)"]));
  });

  it("M1: artifact transfers through S3 with the aws/s3 key are not denied, a direct key use still is", () => {
    for (const environment of ["beta", "production"] as const) expect(project(environment).EncryptionKey).toBe("alias/aws/s3");
    const [boundary] = byType("AWS::IAM::ManagedPolicy");
    const denies = (boundary![1].Properties.PolicyDocument as { Statement: Array<{ Sid: string; Effect: string; Action: string[]; Resource: string[]; Condition?: unknown }> }).Statement.filter((s) => s.Effect === "Deny" && s.Action.some((a) => a === "kms:Decrypt"));
    expect(denies).toEqual([{ Sid: "DenyKeyUseOutsideS3", Effect: "Deny", Action: ["kms:Decrypt", "kms:GenerateDataKey*"], Resource: ["*"], Condition: { StringNotLike: { "kms:ViaService": "s3.*.amazonaws.com" } } }]);
    // Evaluated as IAM does: StringNotLike on the ViaService value. S3 on the role's behalf (any Region) is outside the Deny; a direct call has no ViaService (the key is absent: the Deny applies); another service is denied.
    const applies = (via: string | undefined) => via === undefined || !globMatch("s3.*.amazonaws.com", via);
    expect(applies("s3.us-east-1.amazonaws.com")).toBe(false);
    expect(applies("s3.ap-southeast-3.amazonaws.com")).toBe(false);
    expect(applies(undefined)).toBe(true);
    expect(applies("ssm.us-east-1.amazonaws.com")).toBe(true);
    expect(applies("s3.us-east-1.amazonaws.com.evil.example")).toBe(true);
    // Neither role is granted any key action, and the boundary allows none: the artifact path relies on the aws/s3 key policy alone.
    for (const environment of ["beta", "production"] as const) expect(actionsOf(environment).filter((a) => a.startsWith("kms:"))).toEqual([]);
    const allowed = (boundary![1].Properties.PolicyDocument as { Statement: Array<{ Effect: string; Action: string[] }> }).Statement.filter((s) => s.Effect === "Allow").flatMap((s) => s.Action);
    expect(allowed.filter((a) => a.startsWith("kms:"))).toEqual([]);
  });

  it("S4: nothing may stop a task (the serving tasks share the cluster), and the ECS reads are the four the gates use", () => {
    expect(actionsOf("production").filter((a) => a === "ecs:StopTask")).toEqual([]);
    expect(actionsOf("production").filter((a) => a.startsWith("ecs:")).sort()).toEqual(["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListServices", "ecs:ListTasks", "ecs:RunTask"]);
    expect(cloudBoundaryStatements(scope, RELEASE_ACTIONS_PART).flatMap((s) => s.Action)).not.toContain("ecs:StopTask");
  });

  it("the boundary is exactly the part's statements plus the three that name the stack's parameters, and fits in a managed policy", () => {
    const resolved = resolvedBoundaries([built.stackTemplate], scope)[CLOUD_RELEASE_ACTIONS_STACK_NAME]!;
    expect(resolved.Statement.slice(0, -3).length).toBe(cloudBoundaryStatements(scope, RELEASE_ACTIONS_PART).length);
    expect(resolved.Statement.slice(0, cloudBoundaryStatements(scope, RELEASE_ACTIONS_PART).length)).toEqual(cloudBoundaryStatements(scope, RELEASE_ACTIONS_PART));
    expect(resolved.Statement.slice(-3)).toEqual([
      { Sid: "PipelineArtifacts", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:GetBucketAcl", "s3:GetBucketLocation"], Resource: ["arn:aws:s3:::sample-release-pipeline-artifacts-bucket", "arn:aws:s3:::sample-release-pipeline-artifacts-bucket/*"] },
      { Sid: "AssumeBetaReleaseRole", Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["arn:aws:iam::210987654321:role/rovara-cloud-beta-release"] },
      { Sid: "PullBetaImage", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"], Resource: [`arn:aws:ecr:${REGION}:210987654321:repository/rovara-cloud-beta-gateway-images-*`] },
    ]);
    expect(resolved.Statement.filter((s) => s.Effect === "Deny").map((s) => s.Sid)).toEqual([
      "DenyIamChanges", "DenyAccountChanges", "DenyKeyManagement", "DenyAdminRoles", "DenyOrganizationAdminRole", "DenySecretValues", "DenyKeyUseOutsideS3", "DenyExecIntoTasks",
    ]);
    // The largest part (the limit is 6,144 characters without whitespace): room for a 63-character bucket name and the longest environment name and Region.
    expect(JSON.stringify(resolved).length).toBeLessThan(6144 - 450);
    expect(JSON.stringify({ Version: "2012-10-17", Statement: [...cloudBoundaryStatements({ ...scope, env: "abcdefghijklmn", region: "ap-southeast-3" }, RELEASE_ACTIONS_PART), ...releaseActionsParameterStatements("aws", "ap-southeast-3", { artifactBucketName: "b".repeat(63), betaAccountId: "210987654321" })] }).length).toBeLessThan(6144 - 100);
  });

  it("is not one of the per-environment parts (its stack name has no environment) and only it takes its two inputs", () => {
    expect(CLOUD_STACK_PARTS).not.toContain(RELEASE_ACTIONS_PART);
    const stack = new Stack(new App(), "X", { env: { region: REGION } });
    expect(() => applyCloudBoundary(stack, ENV, RELEASE_ACTIONS_PART)).toThrow(/need both/u);
    expect(() => applyCloudBoundary(stack, ENV, "web", undefined, undefined, { artifactBucketName: "b", betaAccountId: "c" })).toThrow(/need both/u);
  });
});

describe("what each role may do", () => {
  it("beta: assume the beta release role and nothing else (every beta write is made as that role)", () => {
    expect(actionsOf("beta")).toEqual([
      "codeconnections:GetConnectionToken", "codeconnections:UseConnection", "codestar-connections:GetConnectionToken", "codestar-connections:UseConnection",
      "codebuild:BatchPutCodeCoverages", "codebuild:BatchPutTestCases", "codebuild:CreateReport", "codebuild:CreateReportGroup", "codebuild:UpdateReport",
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
      "s3:GetBucketAcl", "s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject",
      "sts:AssumeRole",
    ].sort());
    const assumes = casesOf("beta").filter((c) => c.action === "sts:AssumeRole");
    expect(assumes.map((c) => c.resource)).toEqual(["arn:aws:iam::210987654321:role/rovara-cloud-beta-release"]);
    for (const prefix of ["ecr:", "ecs:", "ssm:", "cloudformation:", "iam:", "kms:", "secretsmanager:", "events:", "acm:"]) expect(actionsOf("beta").filter((a) => a.startsWith(prefix)), prefix).toEqual([]);
  });

  it("production: the account's four bootstrap roles (never the execution role), a read-only pull of beta's repository (no role in beta), its own repository, price fetch, release records", () => {
    const resourcesOf = (action: string) => casesOf("production").filter((c) => c.action === action).map((c) => c.resource);
    expect(resourcesOf("sts:AssumeRole")).toEqual([
      ...["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"].map((r) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-${r}-${ACCOUNT}-${REGION}`),
    ]);
    // Beta: pull and describe, with its own credentials, on beta's gateway repository only; never a push, and no beta role assumed.
    const beta = `arn:aws:ecr:${REGION}:210987654321:repository/rovara-cloud-beta-gateway-images-*`;
    expect(casesOf("production").filter((c) => c.resource === beta).map((c) => c.action).sort()).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"]);
    expect(casesOf("production").filter((c) => c.resource.includes("210987654321")).every((c) => c.resource === beta)).toBe(true);
    expect(resourcesOf("ecr:PutImage")).toEqual([`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-cloud-production-gateway-images-*`]);
    expect(resourcesOf("ecs:RunTask")).toEqual([`arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/RovaraModelGatewayPriceFetchTask*:*`]);
    expect(casesOf("production").find((c) => c.action === "ecs:RunTask")!.condition).toEqual({ StringLike: { "ecs:cluster": [`arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/rovara-cloud-production-gateway-*`] } });
    // Exactly two roles may be passed, to ECS only: RunTask can override a task's role.
    expect(casesOf("production").filter((c) => c.action === "iam:PassRole").map((c) => c.resource)).toHaveLength(2);
    expect(casesOf("production").find((c) => c.action === "iam:PassRole")!.condition).toEqual({ StringEquals: { "iam:PassedToService": ["ecs-tasks.amazonaws.com"] } });
    expect(JSON.stringify(built.template)).toContain('"iam:PassRole"');
    // SSM: write only under release/, read the backfill record, nothing else.
    expect(resourcesOf("ssm:PutParameter")).toEqual([`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-cloud/production/release/*`]);
    expect(resourcesOf("ssm:GetParameter")).toEqual([`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-cloud/production/release/*`, `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-cloud/production/release-checks/*`]);
    // CloudFormation, IAM writes, secrets and keys are never granted: change sets go through the deploy role.
    for (const prefix of ["cloudformation:", "secretsmanager:", "kms:", "lambda:", "dynamodb:", "s3:Delete", "ecr:Delete", "ecr:Put", "ecr:SetRepositoryPolicy", "ecr:BatchDelete"]) {
      expect(actionsOf("production").filter((a) => a.startsWith(prefix) && a !== "ecr:PutImage"), prefix).toEqual([]);
    }
    expect(actionsOf("production").filter((a) => a.startsWith("iam:"))).toEqual(["iam:PassRole"]);
    expect(actionsOf("production").filter((a) => a === "*" || a.endsWith(":*"))).toEqual([]);
  });

  it("the repository policy beta needs names the production build role and grants the same four read-only actions, with no account in it", () => {
    const policy = betaGatewayPullPolicy("arn:aws:iam::<release account>:role/rovara-cloud-release-production-build");
    expect(policy).toEqual({
      Version: "2012-10-17",
      Statement: [{ Sid: "ProductionReleasePull", Effect: "Allow", Principal: { AWS: "arn:aws:iam::<release account>:role/rovara-cloud-release-production-build" }, Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"] }],
    });
    expect(JSON.stringify(policy)).not.toMatch(/[0-9]{12}/u);
    // The same actions the role's own policy grants on beta's repository (both sides of a cross-account grant must allow).
    expect(casesOf("production").filter((c) => c.resource.endsWith("rovara-cloud-beta-gateway-images-*")).map((c) => c.action).sort()).toEqual([...policy.Statement[0]!.Action as string[]].sort());
  });

  it("both carry the explicit denies (the organization's Administrator path; production also the interactive shell)", () => {
    const denies = (environment: ReleaseActionEnvironment) => {
      const [, policy] = byType("AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(roleId(environment)))!;
      return (policy.Properties.PolicyDocument as { Statement: Array<{ Effect: string; Sid: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> }).Statement.filter((s) => s.Effect === "Deny");
    };
    expect(denies("beta")).toEqual([{ Sid: "DenyOrganizationAdminRole", Effect: "Deny", Action: "sts:AssumeRole", Resource: "arn:aws:iam::*:role/OrganizationAccountAccessRole" }]);
    expect(denies("production").map((s) => s.Sid)).toEqual(["DenyOrganizationAdminRole", "DenyExecIntoTasks"]);
    expect(denies("production")[1]).toMatchObject({ Action: "ecs:RunTask", Condition: { Bool: { "ecs:enable-execute-command": "true" } } });
  });

  it("the grants that name other accounts take them from parameters: no account is written in the template", () => {
    const text = JSON.stringify(built.template);
    expect(text).toContain('{"Ref":"BetaAccountId"}');
    expect(text.match(/(?<![0-9])[0-9]{12}(?![0-9])/gu)).toBeNull();
    // A real id never reaches a default: no parameter has one.
    for (const parameter of Object.values(built.template.Parameters as Record<string, { Default?: unknown }>)) if (parameter.Default !== undefined) expect(JSON.stringify(parameter.Default)).not.toMatch(/[0-9]{12}/u);
  });
});

describe("the projects", () => {
  const envVars = (environment: ReleaseActionEnvironment) => Object.fromEntries(((project(environment).Environment as { EnvironmentVariables: Array<{ Name: string; Value: unknown; Type: string }> }).EnvironmentVariables).map((v) => [v.Name, v.Value]));

  it("build on arm64 with Docker (privileged), one build at a time, with logs in this stack's group", () => {
    for (const environment of ["beta", "production"] as const) {
      const p = project(environment) as { Environment: Record<string, unknown>; ConcurrentBuildLimit: number; TimeoutInMinutes: number; LogsConfig: { CloudWatchLogs: { GroupName: unknown; StreamName: string } } };
      expect(p.Environment).toMatchObject({ Type: "ARM_CONTAINER", ComputeType: "BUILD_GENERAL1_LARGE", PrivilegedMode: true });
      expect(p.ConcurrentBuildLimit).toBe(1);
      expect(p.TimeoutInMinutes).toBe(90);
      expect(p.LogsConfig.CloudWatchLogs.StreamName).toBe(environment);
      expect(p.LogsConfig.CloudWatchLogs.GroupName).toEqual({ Ref: expect.stringMatching(/^BuildLogs/u) as unknown });
    }
  });

  it("tell the stage CLI which account to expect from outside git: beta's parameter, production's own account; only beta has the pipeline profile", () => {
    expect(envVars("beta").ROVARA_EXPECTED_DEPLOY_ACCOUNT).toEqual({ Ref: "BetaAccountId" });
    expect(envVars("production").ROVARA_EXPECTED_DEPLOY_ACCOUNT).toEqual({ Ref: "AWS::AccountId" });
    expect(envVars("beta").ROVARA_PIPELINE_PROFILE).toBe("rovara-cloud-beta");
    expect(envVars("production").ROVARA_PIPELINE_PROFILE).toBeUndefined();
    expect(envVars("beta").STAGE_ENV).toBe("beta");
    expect(envVars("production").STAGE_ENV).toBe("production");
    expect(envVars("beta").BETA_RELEASE_ROLE_ARN).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "BetaAccountId" }, ":role/rovara-cloud-beta-release"]] });
    // Production assumes nothing in beta: no profile, no role address; it is told the beta account only to name beta's registry.
    expect(envVars("production").BETA_RELEASE_ROLE_ARN).toBeUndefined();
    expect(envVars("production").BETA_ACCOUNT_ID).toEqual({ Ref: "BetaAccountId" });
  });

  const spec = (environment: ReleaseActionEnvironment) => JSON.parse(project(environment).Source !== undefined ? (project(environment).Source as { BuildSpec: string }).BuildSpec : "{}") as {
    env: { variables: Record<string, string>; "exported-variables": string[] }; phases: { install: { commands: string[] }; build: { commands: string[] } }; artifacts: { "base-directory": string; files: string[] };
  };

  it("export exactly what the stage CLI's preflight writes (minus the digest, which is an input of later steps) and publish out/ as the state", () => {
    const manifest = { cloud: { tag: "v1.2.3", sha: "a".repeat(40) }, mode: "release", code: { release: "run", pinnedSha: { beta: null, production: null } }, gateway: { digest: null } } as unknown as Manifest;
    const written = renderExports(manifest, "beta").split("\n").filter((l) => l !== "").map((l) => l.replace(/^export ([A-Z_]+)=.*$/u, "$1"));
    expect([...CLOUD_RELEASE_EXPORTED_VARIABLES].sort()).toEqual(written.filter((n) => n !== "GATEWAY_DIGEST").sort());
    for (const environment of ["beta", "production"] as const) {
      expect(spec(environment).env["exported-variables"]).toEqual([...CLOUD_RELEASE_EXPORTED_VARIABLES]);
      expect(spec(environment).artifacts).toEqual({ files: ["**/*"], "base-directory": "out" });
      // The public Code actions read this one; a missing export must fail them, so it is on the list.
      expect(spec(environment).env["exported-variables"]).toContain("CODE_RELEASE_EFFECTIVE");
    }
  });

  it("installs pinned tools with checksums, and writes the beta release role's profile in the beta project only", () => {
    const commands = spec("beta").phases.install.commands;
    expect(commands).toEqual(releaseActionInstallCommands("beta"));
    expect(spec("production").phases.install.commands).toEqual([...RELEASE_ACTION_TOOL_COMMANDS]);
    expect(spec("beta").env.variables).toEqual({ ...RELEASE_ACTION_TOOL_VARIABLES });
    const text = commands.join("\n");
    for (const check of ['sha256sum -c -)', '"${AWS_CLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c -', '"${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -', '"${CRANE_SHA256}  /tmp/crane.tar.gz" | sha256sum -c -']) expect(text).toContain(check);
    expect(RELEASE_ACTION_TOOL_VARIABLES.AWS_CLI_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    // The hash is checked BEFORE the archive is unpacked or installed.
    expect(text.indexOf("AWS_CLI_SHA256}  /tmp/awscliv2.zip")).toBeLessThan(text.indexOf("unzip -q /tmp/awscliv2.zip"));
    expect(RELEASE_ACTION_TOOL_VARIABLES.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(RELEASE_ACTION_TOOL_VARIABLES.CRANE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(text).toContain("role_session_name = rovara-cloud-beta-release");
    expect(text).toContain("credential_source = EcsContainer");
    expect(text).toContain("[profile rovara-cloud-beta]");
    // Both install the same tools: production needs crane (image promotion), beta needs Docker. Only beta has the profile.
    expect(spec("production").phases.install.commands.join("\n")).not.toContain("profile");
    expect(commands.join("\n")).toContain("crane version");
    expect(commands.join("\n")).toContain("docker buildx version");
    for (const environment of ["beta", "production"] as const) expect(spec(environment).phases.build.commands).toEqual(releaseActionBuildCommands(environment));
    const syntax = spawnSync("bash", ["-n", "-c", commands.join("\n")]);
    expect(syntax.status, syntax.stderr.toString()).toBe(0);
  });

  /** Runs the build commands in bash -e (CodeBuild stops at the first failing command) against a fake `node`, in a scratch directory. */
  function runBuild(environment: ReleaseActionEnvironment, env: Record<string, string>, options: { exports?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "release-actions-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "ops/pipeline"), { recursive: true });
    const exportsLine = options.exports === false ? ":" : `mkdir -p out; printf "export CODE_RELEASE_EFFECTIVE='skip'\\nexport CLOUD_TAG='v1.2.3'\\n" > out/exports.env`;
    writeFileSync(join(dir, "bin/node"), `#!/bin/bash\necho "NODE $* manifest=\${PIPELINE_MANIFEST:-none} adopt=\${PIPELINE_ADOPT:-} mode=\${PIPELINE_MODE:-} account=\${ROVARA_EXPECTED_DEPLOY_ACCOUNT:-}"\nif [ "$3" = preflight ]; then ${exportsLine}; fi\n`);
    chmodSync(join(dir, "bin/node"), 0o755);
    const script = [...releaseActionBuildCommands(environment), 'echo "RELEASE=$CODE_RELEASE_EFFECTIVE TAG=$CLOUD_TAG MODE=[$CLOUD_MODE]"'].join("\n");
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
    return { dir, status: result.status, out: result.stdout, err: result.stderr };
  }

  it("runs the stage CLI for its own environment and step, with the previous state's manifest, and sources the preflight's exports", () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    writeFileSync(join(state, "manifest.json"), "{}");
    const first = runBuild("beta", { STAGE_ENV: "beta", STAGE_STEP: "preflight" });
    expect(first.err).toBe("");
    expect(first.out).toContain("NODE ops/pipeline/stage.ts beta preflight manifest=none");
    expect(first.out).toContain("RELEASE=skip TAG=v1.2.3 MODE=[]");
    const next = runBuild("beta", { STAGE_ENV: "beta", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "BetaPreflightState", CODEBUILD_SRC_DIR_BetaPreflightState: state });
    expect(next.out).toContain(`NODE ops/pipeline/stage.ts beta image manifest=${state}/manifest.json`);
    expect(next.out).toContain("RELEASE= TAG= MODE=[]");
    for (const step of CLOUD_RELEASE_STEPS) expect(runBuild("production", { STAGE_ENV: "production", STAGE_STEP: step, PIPELINE_STATE_ARTIFACT: "BetaCloudProofState", CODEBUILD_SRC_DIR_BetaCloudProofState: state }).status, step).toBe(0);
  });

  it("never uses eval on the state name (indirect expansion after the check)", () => {
    for (const environment of ["beta", "production"] as const) expect(releaseActionBuildCommands(environment).join("\n")).not.toMatch(/\beval\b/u);
  });

  it("passes the action's own variables through to the CLI untouched: the mode, adoption and the expected account the pipeline sets", () => {
    const run = runBuild("beta", { STAGE_ENV: "beta", STAGE_STEP: "gateway-check", PIPELINE_ADOPT: "1", PIPELINE_MODE: "adoption", ROVARA_EXPECTED_DEPLOY_ACCOUNT: "123456789012" });
    expect(run.out).toContain("adopt=1 mode=adoption account=123456789012");
  });

  it("grants no CodePipeline right at all: nothing in this stack can reopen the promotion gate (only the public Preflight closes it)", () => {
    for (const environment of ["beta", "production"] as const) expect(actionsOf(environment).filter((a) => a.startsWith("codepipeline:"))).toEqual([]);
    expect(JSON.stringify(built.template)).not.toContain("codepipeline:");
  });

  it("the Production Preflight first prints beta's promotion summary from the beta state, then runs its own preflight", () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    writeFileSync(join(state, "manifest.json"), "{}");
    const run = runBuild("production", { STAGE_ENV: "production", STAGE_STEP: "preflight", PIPELINE_STATE_ARTIFACT: "BetaCloudProofState", CODEBUILD_SRC_DIR_BetaCloudProofState: state });
    const lines = run.out.split("\n").filter((l) => l.startsWith("NODE"));
    expect(lines.map((l) => l.replace(/ adopt=.*$/u, ""))).toEqual([`NODE ops/pipeline/stage.ts beta summary manifest=${state}/manifest.json`, `NODE ops/pipeline/stage.ts production preflight manifest=${state}/manifest.json`]);
    // Beta's own preflight prints no summary first, and no other step does.
    expect(runBuild("beta", { STAGE_ENV: "beta", STAGE_STEP: "preflight" }).out.split("\n").filter((l) => l.startsWith("NODE"))).toHaveLength(1);
  });

  it("refuses a step for another environment, an unknown step, a missing or hostile state name, and a preflight with no exports", () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    writeFileSync(join(state, "manifest.json"), "{}");
    const cases: Array<[ReleaseActionEnvironment, Record<string, string>, RegExp, { exports?: boolean }?]> = [
      ["beta", { STAGE_ENV: "production", STAGE_STEP: "preflight" }, /runs beta steps only/u],
      ["production", { STAGE_ENV: "beta", STAGE_STEP: "preflight" }, /runs production steps only/u],
      ["beta", { STAGE_ENV: "beta" }, /STAGE_STEP is not set/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "last-good" }, /unknown STAGE_STEP/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "Missing" }, /no manifest.json in the previous action output/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "X; touch pwned", CODEBUILD_SRC_DIR_X: state }, /not an artifact name/u],
      ["production", { STAGE_ENV: "production", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "x;rm -rf /", CODEBUILD_SRC_DIR_x: state }, /not an artifact name/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "$(touch pwned)" }, /not an artifact name/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "image", PIPELINE_STATE_ARTIFACT: "" }, /^$/u],
      ["beta", { STAGE_ENV: "beta", STAGE_STEP: "preflight" }, /wrote no out\/exports.env/u, { exports: false }],
    ];
    for (const [environment, env, message, options] of cases) {
      const run = runBuild(environment, env, options);
      if (env.PIPELINE_STATE_ARTIFACT === "") { expect(run.status).toBe(0); continue; }
      expect(run.status, JSON.stringify(env)).not.toBe(0);
      expect(run.err).toMatch(message);
      // Refused before anything ran: the CLI was never started.
      if (/not an artifact name/u.test(message.source)) expect(run.out).not.toContain("NODE");
      expect(existsSync(join(run.dir, "pwned"))).toBe(false);
    }
  });
});

describe("the stack in the app", () => {
  it("-c rovaraCloudReleaseActions=<environment> makes this one stack and nothing else, named as the public pipeline expects", () => {
    const assembly = buildAgentXApp({ [CLOUD_RELEASE_ACTIONS_CONTEXT_KEY]: ENV }).synth();
    expect(assembly.stacks.map((s) => s.stackName)).toEqual(["rovara-cloud-release-actions"]);
    expect(assembly.stacks[0]!.environment.region).toBe(REGION);
  });

  it("refuses an empty or malformed environment", () => {
    expect(() => buildAgentXApp({ [CLOUD_RELEASE_ACTIONS_CONTEXT_KEY]: "" })).toThrow(/must name the environment/u);
    expect(() => buildAgentXApp({ [CLOUD_RELEASE_ACTIONS_CONTEXT_KEY]: 3 })).toThrow(/must name the environment/u);
    expect(() => synthesize("Not Valid")).toThrow();
  });
});
