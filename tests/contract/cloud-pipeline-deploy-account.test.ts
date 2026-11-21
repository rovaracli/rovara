// Rovara-cloud#269: beta Cloud lives in the beta account, but its release pipeline runs in the account that holds the GitHub
// connection (as Rovara Code's beta release does) and deploys into beta through beta's CDK bootstrap roles. Every other environment
// deploys into the pipeline's own account, exactly as before.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CDK_BOOTSTRAP_ASSUMED_ROLES, CDK_BOOTSTRAP_QUALIFIER, applyCloudBoundary, cloudBoundaryStatements } from "../../infra/lib/cloud-boundary.js";
import { CLOUD_PIPELINE_DEPLOY_ACCOUNTS, CloudReleasePipelineStack, DEPLOY_ACCOUNT_CONTEXT_KEY, pipelineDeployAccount } from "../../infra/lib/cloud-release-pipeline.js";

const BETA = "233082642592";
const OWN = "111111111111";

const buildCommands = (environmentName: string) => {
  const template = Template.fromStack(new CloudReleasePipelineStack(new App(), "RovaraCloudPipeline", { environmentName, env: { region: "us-east-1", account: OWN } }));
  const project = Object.values(template.findResources("AWS::CodeBuild::Project")).map((each) => each.Properties as { Name: string; Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).find((each) => each.Name === `rovara-cloud-${environmentName}-deploy`)!;
  const source = project.Source.BuildSpec;
  const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
  const spec = JSON.parse(text) as { env: { variables: Record<string, string> }; phases: { build: { commands: string[] } } };
  return { template, variables: spec.env.variables, script: spec.phases.build.commands[0]! };
};
const bootstrapRoles = (account: string) => CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:aws:iam::${account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${account}-us-east-1`);

describe("Cloud release pipeline: the account it deploys into", () => {
  it("names beta's account and no other", () => {
    expect(CLOUD_PIPELINE_DEPLOY_ACCOUNTS).toEqual({ beta: BETA });
    expect(pipelineDeployAccount("beta")).toBe(BETA);
    for (const env of ["production", "staging"]) expect(pipelineDeployAccount(env)).toBeUndefined();
    expect(() => pipelineDeployAccount("beta", { beta: "12" })).toThrow(/12 digits/u);
  });

  it("beta's deploy goes into beta's account and reads the live address through beta's lookup role", () => {
    const { script } = buildCommands("beta");
    expect(script.split("\n").find((line) => line.startsWith("npx cdk deploy"))).toContain(`-c ${DEPLOY_ACCOUNT_CONTEXT_KEY}=${BETA}`);
    expect(script).toContain(`arn:aws:iam::${BETA}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-lookup-role-${BETA}-$AWS_REGION`);
  });

  it.each([["beta", BETA], ["production", OWN], ["staging", OWN]])("M-1: %s requires the own-key preflight through the deploy account lookup role before any deploy", (environment, account) => {
    const { script, variables } = buildCommands(environment);
    expect(variables.C1_LOOKUP_ROLE).toBe(`arn:<token>:iam::${account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-lookup-role-${account}-us-east-1`);
    const preflight = script.split("\n")[0]!;
    expect(preflight).toContain('agent-own-key-backfill.mjs --check --release-stack "${STACK_PREFIX}-web" --lookup-role "$C1_LOOKUP_ROLE"');
    expect(preflight).toContain("|| exit 1");
    expect(script).not.toContain("--apply");
  });

  it("production's deploy is as before: its own account, no deploy account, the web stack read directly", () => {
    const { script, template } = buildCommands("production");
    expect(script).not.toContain(DEPLOY_ACCOUNT_CONTEXT_KEY);
    expect(script).not.toContain("assume-role");
    expect(JSON.stringify(template.toJSON())).toContain("cloudformation:DescribeStacks");
  });

  it("the beta deploy role may assume only beta's bootstrap roles, and reads no stack of its own account", () => {
    const { template } = buildCommands("beta");
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap((each) => (each.Properties as { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } }).PolicyDocument.Statement);
    const assume = statements.filter((s) => s.Action === "sts:AssumeRole" && JSON.stringify(s.Resource).includes("cdk-"));
    expect(assume).toHaveLength(1);
    expect(JSON.stringify(assume[0]!.Resource)).toContain(`iam::${BETA}:role/cdk-`);
    expect(JSON.stringify(assume[0]!.Resource)).not.toContain(`iam::${OWN}:role/cdk-`);
    expect(statements.some((s) => JSON.stringify(s.Action).includes("cloudformation:DescribeStacks"))).toBe(false);
  });
});

describe("the pipeline's boundary with a deploy account", () => {
  const scope = { env: "beta", partition: "aws", region: "us-east-1", account: OWN };
  it("lets it assume the deploy account's bootstrap roles, not its own account's", () => {
    const assume = cloudBoundaryStatements({ ...scope, deployAccount: BETA }, "pipeline").find((s) => s.Sid === "AssumeDeployRoles")!;
    expect(assume.Resource).toEqual([`arn:aws:iam::${OWN}:role/rovara-cloud/beta/pipeline/*`, ...bootstrapRoles(BETA)]);
  });

  it("drops the direct web stack read, and is unchanged without one", () => {
    expect(cloudBoundaryStatements({ ...scope, deployAccount: BETA }, "pipeline").some((s) => s.Sid === "ReleaseCheckReadsWebStack")).toBe(false);
    expect(cloudBoundaryStatements(scope, "pipeline")).toEqual(cloudBoundaryStatements({ ...scope, deployAccount: OWN }, "pipeline"));
    expect(cloudBoundaryStatements(scope, "pipeline").find((s) => s.Sid === "AssumeDeployRoles")!.Resource).toEqual([`arn:aws:iam::${OWN}:role/rovara-cloud/beta/pipeline/*`, ...bootstrapRoles(OWN)]);
  });

  it("only the pipeline may name one", () => {
    expect(() => applyCloudBoundary(new Stack(new App(), "Web"), "beta", "web", undefined, BETA)).toThrow(/only the pipeline/u);
  });
});

describe(`the Cloud stacks' -c ${DEPLOY_ACCOUNT_CONTEXT_KEY}`, () => {
  it("puts the named account on the web and app stacks", () => {
    const app = buildAgentXApp({ rovaraCloudApp: "beta", [DEPLOY_ACCOUNT_CONTEXT_KEY]: BETA });
    for (const id of ["RovaraCloudWeb", "RovaraCloudApp"]) expect((app.node.findChild(id) as Stack).account).toBe(BETA);
  });

  it("leaves them account-agnostic without it, and refuses anything but 12 digits", () => {
    const app = buildAgentXApp({ rovaraCloudApp: "beta" });
    expect(Stack.of(app.node.findChild("RovaraCloudWeb")).environment).toBe("aws://unknown-account/us-east-1");
    expect(() => buildAgentXApp({ rovaraCloudApp: "beta", [DEPLOY_ACCOUNT_CONTEXT_KEY]: "beta" })).toThrow(/12-digit/u);
  });
});
