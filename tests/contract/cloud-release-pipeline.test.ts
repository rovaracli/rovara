import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CLOUD_PIPELINE_GITHUB_ACCOUNT, CLOUD_PIPELINE_PLACEHOLDER_CHANNEL, CLOUD_SETUP_TIMEOUT, CloudReleasePipelineStack, cloudImageRepositoryName } from "../../infra/lib/cloud-release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const synth = (environmentName: string) => Template.fromStack(new CloudReleasePipelineStack(new App(), "RovaraCloudPipeline", { environmentName, env: { region: "us-east-1" } }));

describe("Rovara Cloud release pipeline", () => {
  const template = synth("production");
  const pipeline = () => Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0]!.Properties as Record<string, unknown>;
  const project = (name: string) => Object.values(template.findResources("AWS::CodeBuild::Project")).find((each) => (each.Properties as { Name: string }).Name === name)!;
  const setupApi = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"))[0]!;
  /** A job's buildspec, its tokens written as <setup page> (the setup API's address) or <token>; its commands as one text. */
  const buildSpec = (name: string) => {
    const source = (project(name).Properties as { Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).Source.BuildSpec;
    const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part
      : JSON.stringify(part) === JSON.stringify({ "Fn::GetAtt": [setupApi, "ApiEndpoint"] }) ? "<setup page>" : "<token>")).join("");
    const parsed = JSON.parse(text) as { env: { variables: Record<string, string> }; phases: Record<string, { commands: string[] }> };
    return { variables: parsed.env.variables, commands: Object.values(parsed.phases).flatMap((phase) => phase.commands).join("\n") };
  };

  it("runs on vX.Y.Z release tags of Rovara-cloud only, never on a branch push or a prerelease tag", () => {
    const properties = pipeline();
    expect(properties.Triggers).toEqual([{ ProviderType: "CodeStarSourceConnection", GitConfiguration: { SourceActionName: "GitHub", Push: [{ Tags: { Includes: ["v*.*.*"], Excludes: ["v*-*"] } }] } }]);
    const stages = properties.Stages as Array<{ Name: string; Actions: Array<{ ActionTypeId: { Provider: string }; Configuration?: Record<string, unknown> }> }>;
    expect(stages[0]!.Actions[0]!.Configuration).toMatchObject({ FullRepositoryId: "PrepLabsAI/Rovara-cloud", DetectChanges: false });
  });

  it("builds the images, then waits for a person, then deploys, then finishes the setup", () => {
    const stages = pipeline().Stages as Array<{ Name: string; Actions: Array<{ ActionTypeId: { Provider: string } }> }>;
    expect(stages.map((stage) => `${stage.Name}:${stage.Actions.map((action) => action.ActionTypeId.Provider).join(",")}`))
      .toEqual(["Source:CodeStarSourceConnection", "Images:CodeBuild", "Approve:Manual", "Deploy:CodeBuild", "Setup:CodeBuild"]);
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", { Name: "rovara-cloud-production-release", PipelineType: "V2", ExecutionMode: "QUEUED" });
    const setupStage = stages.find((stage) => stage.Name === "Setup")!.Actions[0] as unknown as { Configuration: { ProjectName: unknown } };
    expect(setupStage.Configuration.ProjectName).toEqual({ Ref: Object.entries(template.findResources("AWS::CodeBuild::Project")).find(([, each]) => (each.Properties as { Name: string }).Name === "rovara-cloud-production-setup")![0] });
  });

  it("asks only for the GitHub connection and the setup email: the GitHub owner is fixed and the rest is asked on the setup page", () => {
    const parameters = template.toJSON().Parameters as Record<string, { AllowedPattern?: string }>;
    expect(Object.keys(parameters).filter((name) => !name.startsWith("BootstrapVersion")).sort()).toEqual(["GitHubConnectionArn", "SetupEmail"]);
    expect(CLOUD_PIPELINE_GITHUB_ACCOUNT).toBe("PrepLabsAI");
    for (const gone of ["ADMIN_EMAIL", "ALERT_EMAIL", "SLACK_CHANNEL"]) expect(JSON.stringify(template.toJSON())).not.toContain(gone);
  });

  it("hosts the setup page: its encrypted table, its function behind an HTTP API, and its address as an output", () => {
    template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
    template.hasResourceProperties("AWS::DynamoDB::Table", { TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true }, SSESpecification: Match.objectLike({ SSEType: "KMS" }) });
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { Name: "rovara-cloud-production-setup", ProtocolType: "HTTP" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
    template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: Match.objectLike({ INSTALL_NAME: "production", SETUP_TABLE: Match.anyValue(), SETUP_KEY_ID: Match.anyValue() }) } });
    template.hasOutput("SetupPageUrl", { Value: { "Fn::GetAtt": [setupApi, "ApiEndpoint"] } });
  });

  it("gives AdministratorAccess to the deploy and setup jobs only", () => {
    const roles = template.findResources("AWS::IAM::Role");
    const admins = Object.entries(roles).filter(([, role]) => JSON.stringify(role).includes("policy/AdministratorAccess")).map(([id]) => id).sort();
    expect(admins).toHaveLength(2);
    for (const id of admins) expect(JSON.stringify(roles[id])).toContain("codebuild.amazonaws.com");
    const roleOf = (name: string) => ((project(name).Properties as { ServiceRole: { "Fn::GetAtt": [string, string] } }).ServiceRole["Fn::GetAtt"][0]);
    expect([roleOf("rovara-cloud-production-deploy"), roleOf("rovara-cloud-production-setup")].sort()).toEqual(admins);
  });

  it("keeps the environment's image repositories, named under rovara-cloud", () => {
    for (const image of ["worker", "slack"] as const) {
      expect(cloudImageRepositoryName("production", image)).toBe(`rovara-cloud-production/${image}`);
      template.hasResource("AWS::ECR::Repository", { Properties: Match.objectLike({ RepositoryName: `rovara-cloud-production/${image}` }), DeletionPolicy: "Retain" });
    }
  });

  it("installs the first time with every stack and no questions, the identity stack knowing the setup page, and upgrades after", () => {
    const { variables, commands } = buildSpec("rovara-cloud-production-deploy");
    expect(variables).toMatchObject({
      SETTINGS_PARAMETER: "/rovara-cloud/production/settings", SETUP_EMAIL: "<token>", SETUP_URL: "<setup page>",
      GITHUB_ACCOUNT: CLOUD_PIPELINE_GITHUB_ACCOUNT, PLACEHOLDER_CHANNEL: CLOUD_PIPELINE_PLACEHOLDER_CHANNEL,
    });
    expect(JSON.stringify(project("rovara-cloud-production-deploy").Properties)).toContain('{"Ref":"SetupEmail"}');
    expect(commands).toContain('cli upgrade --region "$AWS_REGION"');
    expect(commands).toContain("--rovara-cloud --yes --no-browser --no-ui");
    expect(commands).toContain("--stop-after slack-service");
    // The setup email is the first admin (stored; the setup page's sign-in); the channel is a placeholder the run never reaches.
    expect(commands).toContain('--admin-email "$SETUP_EMAIL"');
    expect(commands).toContain('--github-account "$GITHUB_ACCOUNT" --github-account-type organization');
    expect(commands).toContain('--channel "$PLACEHOLDER_CHANNEL"');
    expect(commands).not.toContain("--alert-email");
    // The identity stack allows the setup page's sign-in callback from the first deploy; this job asks nothing there.
    expect(commands).toContain('--setup-page-url "$SETUP_URL"');
    expect(commands).not.toContain("--setup-table");
    // A newer release never upgrades over an unfinished setup.
    expect(commands).toContain('state="$(setup_state)" || exit 1\n  if [ "$state" != finished ]; then');
  });

  it("finishes the setup on the setup page, and does nothing once the CLI's install progress says it is finished", () => {
    const { variables, commands } = buildSpec("rovara-cloud-production-setup");
    expect((project("rovara-cloud-production-setup").Properties as { TimeoutInMinutes: number }).TimeoutInMinutes).toBe(CLOUD_SETUP_TIMEOUT.toMinutes());
    expect(CLOUD_SETUP_TIMEOUT.toHours()).toBe(8);
    expect(variables).toMatchObject({ PROGRESS_PARAMETER: "/rovara-cloud/production/install/progress", SETUP_TABLE: "<token>", SETUP_URL: "<setup page>" });
    expect(commands).toContain('steps.e2e && steps.e2e.status === "done" ? "finished" : "unfinished"');
    expect(commands).toContain("*ParameterNotFound*) echo unfinished");
    // Finished: no build and no init.
    expect(commands).toContain('if [ "$state" = finished ]; then\n  echo "$ROVARA_ENV is set up: nothing to do"\nelse\n  npm ci');
    expect(commands).toContain('init --region "$AWS_REGION" --engine cdk --source "$PWD" --rovara-cloud --resume');
    expect(commands).toContain('--setup-table "$SETUP_TABLE" --setup-url "$SETUP_URL" --connectors none');
    expect(commands).not.toContain("--yes");
  });

  it("refuses an environment name the environment rules refuse", () => {
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
  });
});
