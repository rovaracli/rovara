import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CloudReleasePipelineStack, cloudImageRepositoryName } from "../../infra/lib/cloud-release-pipeline.js";

const synth = (environmentName: string) => Template.fromStack(new CloudReleasePipelineStack(new App(), "RovaraCloudPipeline", { environmentName, env: { region: "us-east-1" } }));

describe("Rovara Cloud release pipeline", () => {
  const template = synth("production");
  const pipeline = () => Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0]!.Properties as Record<string, unknown>;

  it("runs on vX.Y.Z release tags of Rovara-cloud only, never on a branch push or a prerelease tag", () => {
    const properties = pipeline();
    expect(properties.Triggers).toEqual([{ ProviderType: "CodeStarSourceConnection", GitConfiguration: { SourceActionName: "GitHub", Push: [{ Tags: { Includes: ["v*.*.*"], Excludes: ["v*-*"] } }] } }]);
    const stages = properties.Stages as Array<{ Name: string; Actions: Array<{ ActionTypeId: { Provider: string }; Configuration?: Record<string, unknown> }> }>;
    expect(stages[0]!.Actions[0]!.Configuration).toMatchObject({ FullRepositoryId: "PrepLabsAI/Rovara-cloud", DetectChanges: false });
  });

  it("builds the images, then waits for a person, then deploys", () => {
    const stages = pipeline().Stages as Array<{ Name: string; Actions: Array<{ ActionTypeId: { Provider: string } }> }>;
    expect(stages.map((stage) => `${stage.Name}:${stage.Actions.map((action) => action.ActionTypeId.Provider).join(",")}`))
      .toEqual(["Source:CodeStarSourceConnection", "Images:CodeBuild", "Approve:Manual", "Deploy:CodeBuild"]);
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", { Name: "rovara-cloud-production-release", PipelineType: "V2", ExecutionMode: "QUEUED" });
  });

  it("gives AdministratorAccess to the deploy job only", () => {
    const withManaged = Object.values(template.findResources("AWS::IAM::Role")).filter((role) => (role.Properties as { ManagedPolicyArns?: unknown }).ManagedPolicyArns !== undefined);
    expect(withManaged).toHaveLength(1);
    expect(JSON.stringify(withManaged[0])).toContain("policy/AdministratorAccess");
    const deployProject = Object.values(template.findResources("AWS::CodeBuild::Project")).find((project) => (project.Properties as { Name: string }).Name === "rovara-cloud-production-deploy")!;
    expect(JSON.stringify(withManaged[0])).toContain("codebuild.amazonaws.com");
    expect(JSON.stringify(deployProject.Properties)).toContain((Object.entries(template.findResources("AWS::IAM::Role")).find(([, role]) => role === withManaged[0])![0]));
  });

  it("keeps the environment's image repositories, named under rovara-cloud", () => {
    for (const image of ["worker", "slack"] as const) {
      expect(cloudImageRepositoryName("production", image)).toBe(`rovara-cloud-production/${image}`);
      template.hasResource("AWS::ECR::Repository", { Properties: Match.objectLike({ RepositoryName: `rovara-cloud-production/${image}` }), DeletionPolicy: "Retain" });
    }
  });

  it("installs the first time with every stack and nothing that needs a browser, and upgrades after", () => {
    const deployProject = Object.values(template.findResources("AWS::CodeBuild::Project")).find((project) => (project.Properties as { Name: string }).Name === "rovara-cloud-production-deploy")!;
    const buildSpec = JSON.stringify(deployProject.Properties);
    expect(buildSpec).toContain("/rovara-cloud/production/settings");
    expect(buildSpec).toContain("cli upgrade --region");
    expect(buildSpec).toContain("--rovara-cloud --yes --no-browser --no-ui");
    expect(buildSpec).toContain("--stop-after slack-service");
  });

  it("refuses an environment name the environment rules refuse", () => {
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
  });
});
