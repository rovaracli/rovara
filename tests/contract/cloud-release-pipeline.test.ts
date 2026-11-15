import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER, CLOUD_PIPELINE_NODE_OPTIONS, CloudReleasePipelineStack } from "../../infra/lib/cloud-release-pipeline.js";
import { CLOUD_APP_CONTEXT_KEY, CloudAppStack } from "../../infra/lib/cloud-app.js";
import { CloudWebStack } from "../../infra/lib/cloud-web.js";
import { Code } from "aws-cdk-lib/aws-lambda";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const synth = (environmentName: string) => Template.fromStack(new CloudReleasePipelineStack(new App(), "RovaraCloudPipeline", { environmentName, env: { region: "us-east-1" } }));

describe("Rovara Cloud release pipeline", () => {
  const template = synth("production");
  const pipeline = () => Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0]!.Properties as Record<string, unknown>;
  const projects = () => Object.values(template.findResources("AWS::CodeBuild::Project")).map((each) => each.Properties as { Name: string; Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } });
  const deploySpec = () => {
    const source = projects().find((each) => each.Name === "rovara-cloud-production-deploy")!.Source.BuildSpec;
    const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
    const spec = JSON.parse(text) as { env: { variables: Record<string, unknown> }; phases: Record<string, { commands: string[] }> };
    return { variables: spec.env.variables, phases: spec.phases, commands: Object.values(spec.phases).flatMap((phase) => phase.commands).join("\n") };
  };

  it("runs on vX.Y.Z release tags of Rovara-cloud only, never on a branch push or a prerelease tag", () => {
    const properties = pipeline();
    expect(properties.Triggers).toEqual([{ ProviderType: "CodeStarSourceConnection", GitConfiguration: { SourceActionName: "GitHub", Push: [{ Tags: { Includes: ["v*.*.*"], Excludes: ["v*-*"] } }] } }]);
    const stages = properties.Stages as Array<{ Actions: Array<{ Configuration?: Record<string, unknown> }> }>;
    expect(stages[0]!.Actions[0]!.Configuration).toMatchObject({ FullRepositoryId: "PrepLabsAI/Rovara-cloud", DetectChanges: false });
  });

  it("waits for a person, then deploys: no image, setup or Code stage of its own", () => {
    const stages = pipeline().Stages as Array<{ Name: string; Actions: Array<{ ActionTypeId: { Provider: string } }> }>;
    expect(stages.map((stage) => `${stage.Name}:${stage.Actions.map((action) => action.ActionTypeId.Provider).join(",")}`))
      .toEqual(["Source:CodeStarSourceConnection", "Approve:Manual", "Deploy:CodeBuild"]);
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", { Name: "rovara-cloud-production-release", PipelineType: "V2", ExecutionMode: "QUEUED" });
    expect(projects().map((each) => each.Name)).toEqual(["rovara-cloud-production-deploy"]);
    template.resourceCountIs("AWS::ECR::Repository", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    // CodePipeline refuses a variable namespace named like an output artifact.
    const source = stages[0]!.Actions[0] as unknown as { Namespace: string; OutputArtifacts: Array<{ Name: string }> };
    expect(source.OutputArtifacts.map((artifact) => artifact.Name)).not.toContain(source.Namespace);
  });

  it("asks only for the GitHub connection and the Rovara Code install's address", () => {
    const parameters = template.toJSON().Parameters as Record<string, { AllowedPattern?: string }>;
    expect(Object.keys(parameters).filter((name) => !name.startsWith("BootstrapVersion")).sort()).toEqual(["CodeUrl", "GitHubConnectionArn"]);
    const codeUrl = new RegExp(parameters.CodeUrl!.AllowedPattern!);
    expect(codeUrl.test("https://3m38w35kz2.execute-api.us-east-1.amazonaws.com")).toBe(true);
    for (const refused of ["http://abc.example.com", "https://abc.example.com/v1", ""]) expect(codeUrl.test(refused)).toBe(false);
  });

  it("deploys the Cloud stack alone with cdk, from the release tag, given Code's address", () => {
    const { variables, phases, commands } = deploySpec();
    expect(variables).toMatchObject({ ROVARA_ENV: "production", STACK_PREFIX: "rovara-cloud-production", CODE_URL: "<token>", NODE_OPTIONS: CLOUD_PIPELINE_NODE_OPTIONS });
    expect(commands).toContain('RELEASE_TAG="$(git tag --points-at HEAD');
    // The web build comes first: cloud-web.ts uploads the app's files and puts the page shell in the function.
    expect(phases.pre_build!.commands.slice(-3)).toEqual(["npm ci", "npx tsc -b infra", "npm run build:web"]);
    // One command: the release check's poller runs around the deploy in the same shell (tests/contract/cloud-release-check.test.ts runs it).
    expect(phases.build!.commands).toHaveLength(1);
    expect(phases.build!.commands[0]).toContain(
      `npx cdk deploy RovaraCloudApp RovaraCloudWeb --app "node infra/dist/bin/agentx.js" -c ${CLOUD_APP_CONTEXT_KEY}="$ROVARA_ENV" -c agentxRegion="$AWS_REGION" --parameters CodeUrl="$CODE_URL" --require-approval never --progress events`,
    );
    // Nothing of Code's: no rovara init or upgrade.
    expect(commands).not.toMatch(/\binit\b|\bupgrade\b/);
  });

  it("gives the deploy job no administrator access: only the account's CDK bootstrap roles and the GitHub connection", () => {
    expect(JSON.stringify(template.findResources("AWS::IAM::Role"))).not.toContain("AdministratorAccess");
    const deployRole = (Object.values(template.findResources("AWS::CodeBuild::Project"))[0]!.Properties as { ServiceRole: { "Fn::GetAtt": [string, string] } }).ServiceRole["Fn::GetAtt"][0];
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).map((policy) => policy.Properties as { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } });
    const statements = policies.filter((policy) => policy.Roles.some((role) => role.Ref === deployRole)).flatMap((policy) => policy.PolicyDocument.Statement);
    const assume = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("sts:")));
    expect(assume).toHaveLength(1);
    expect(JSON.stringify(assume[0]!.Resource)).toContain(`:role/cdk-${CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER}-*-`);
    // The release check reads the web stack's outputs, and no other stack's.
    const describe = statements.filter((statement) => [statement.Action].flat().includes("cloudformation:DescribeStacks"));
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]!.Resource)).toContain(":stack/rovara-cloud-production-web/*");
    // Nothing else beyond its logs, the artifacts, reports and the connection: no wildcard actions.
    expect(statements.flatMap((statement) => [statement.Action].flat()).filter((action) => action === "*" || action.endsWith(":*"))).toEqual([]);
  });

  it("refuses an environment name the environment rules refuse", () => {
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
  });
});

describe("the parameters the deploy passes (v0.10.1)", () => {
  it("are declared by every stack it deploys: CloudFormation refuses one a template doesn't declare", () => {
    const template = synth("production");
    const source = (Object.values(template.findResources("AWS::CodeBuild::Project"))[0]!.Properties as { Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).Source.BuildSpec;
    const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
    const deploy = (JSON.parse(text) as { phases: { build: { commands: string[] } } }).phases.build.commands[0]!;
    const passed = [...deploy.matchAll(/--parameters ([A-Za-z0-9]+)=/gu)].map((match) => match[1]!);
    expect(passed).toEqual(["CodeUrl"]);
    const shell = mkdtempSync(join(tmpdir(), "cloud-web-app-"));
    mkdirSync(join(shell, "assets"));
    writeFileSync(join(shell, "index.html"), "<!doctype html>");
    const stacks = {
      RovaraCloudApp: new CloudAppStack(new App(), "RovaraCloudApp", { environmentName: "production", env: { region: "us-east-1" }, movedTo: "https://d5hwoqksa23xv.cloudfront.net" }),
      RovaraCloudWeb: new CloudWebStack(new App(), "RovaraCloudWeb", { environmentName: "production", env: { region: "us-east-1" }, appDirectory: shell, code: Code.fromInline("export const handler = async () => ({});") }),
    };
    expect(deploy).toContain(`npx cdk deploy ${Object.keys(stacks).join(" ")} `);
    for (const [name, stack] of Object.entries(stacks)) {
      const declared = Object.keys((Template.fromStack(stack).toJSON() as { Parameters?: Record<string, unknown> }).Parameters ?? {});
      for (const parameter of passed) expect(declared, `${name} declares ${parameter}`).toContain(parameter);
    }
  });
});
