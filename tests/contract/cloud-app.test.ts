import { App } from "aws-cdk-lib";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CLOUD_APP_CALLBACK_PATH, CLOUD_APP_CLIENT_ID, CLOUD_APP_PORT, CLOUD_APP_SCOPES, CloudAppStack, cloudAppStackName } from "../../infra/lib/cloud-app.js";

const synth = (environmentName: string) =>
  Template.fromStack(new CloudAppStack(new App(), "RovaraCloudApp", { environmentName, env: { region: "us-east-1" }, image: ContainerImage.fromRegistry("example.com/rovara-cloud:test") }));

describe("Rovara Cloud stack", () => {
  const template = synth("production");
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  const idOf = (type: string) => Object.entries(resources).find(([, each]) => each.Type === type)![0];
  const container = () => (Object.values(template.findResources("AWS::ECS::TaskDefinition"))[0]!.Properties as { ContainerDefinitions: Array<Record<string, unknown>> }).ContainerDefinitions[0]!;

  it("has nothing of Rovara Code's: no user pool, no workers, no Slack service", () => {
    for (const type of ["AWS::Cognito::UserPool", "AWS::EC2::LaunchTemplate", "AWS::AutoScaling::AutoScalingGroup", "AWS::SQS::Queue", "AWS::Lambda::Function"]) {
      expect(Object.values(resources).filter((each) => each.Type === type && !JSON.stringify(each).includes("CustomVpcRestrictDefaultSG")).map(() => type)).toEqual([]);
    }
    template.resourceCountIs("AWS::ECS::Service", 1);
  });

  it("signs people in through the Rovara Code install given as CodeUrl, as its sign-in client rovara-cloud", () => {
    const parameters = template.toJSON().Parameters as Record<string, { AllowedPattern?: string }>;
    expect(Object.keys(parameters).filter((name) => !name.startsWith("BootstrapVersion"))).toEqual(["CodeUrl"]);
    const environment = Object.fromEntries((container().Environment as Array<{ Name: string; Value: unknown }>).map((each) => [each.Name, each.Value]));
    expect(environment).toMatchObject({
      ROVARA_CODE_URL: { Ref: "CodeUrl" },
      ROVARA_CLIENT_ID: CLOUD_APP_CLIENT_ID,
      ROVARA_SCOPES: CLOUD_APP_SCOPES.join(" "),
      HOST: "0.0.0.0",
      PORT: String(CLOUD_APP_PORT),
      CLOUD_SESSIONS_FILE: "/data/sessions.json",
      CLOUD_WORK_SESSIONS_FILE: "/data/work-sessions.json",
    });
    // Cloud's own address is the HTTP API's, so Code's redirect is that address's /callback.
    expect(environment.CLOUD_ORIGIN).toEqual({ "Fn::GetAtt": [idOf("AWS::ApiGatewayV2::Api"), "ApiEndpoint"] });
    expect(CLOUD_APP_CALLBACK_PATH).toBe("/callback");
    // The client secret comes from Secrets Manager, never the template.
    expect(container().Secrets).toEqual([{ Name: "ROVARA_CLIENT_SECRET", ValueFrom: { Ref: idOf("AWS::SecretsManager::Secret") } }]);
    template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "rovara-cloud/production/code-client-secret" });
    template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Retain" });
  });

  it("runs one task at a time, so two never write the session files, and keeps those files on encrypted EFS", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100, DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
      LaunchType: "FARGATE",
    });
    template.hasResource("AWS::EFS::FileSystem", { Properties: Match.objectLike({ Encrypted: true }), DeletionPolicy: "Retain" });
    template.hasResourceProperties("AWS::EFS::AccessPoint", { PosixUser: { Uid: "1000", Gid: "1000" }, RootDirectory: { Path: "/cloud", CreationInfo: { OwnerUid: "1000", OwnerGid: "1000", Permissions: "700" } } });
    expect(container().MountPoints).toEqual([{ ContainerPath: "/data", SourceVolume: "data", ReadOnly: false }]);
    expect(container().ReadonlyRootFilesystem).toBe(true);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", { RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" } });
  });

  it("is reached only over HTTPS: the HTTP API, a VPC link and an internal load balancer that only the link may call", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { Name: "rovara-cloud-production-app", ProtocolType: "HTTP" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", { ConnectionType: "VPC_LINK", IntegrationType: "HTTP_PROXY" });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internal" });
    const groups = Object.values(template.findResources("AWS::EC2::SecurityGroup")).map((each) => JSON.stringify(each.Properties));
    // No security group lets the internet in.
    for (const group of groups) expect(group).not.toContain("0.0.0.0/0\",\"Description\":\"Allow from");
    expect(JSON.stringify(template.findResources("AWS::EC2::SecurityGroupIngress"))).not.toContain("0.0.0.0/0");
  });

  it("prints the one-time registration with Code and the restart that picks up its secret", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual(["CallbackUrl", "ClientSecretName", "CloudUrl", "RegisterWithCode", "RestartCommand"]);
    const register = JSON.stringify(outputs.RegisterWithCode!.Value);
    expect(register).toContain(`admin sign-in-client add ${CLOUD_APP_CLIENT_ID} --name \\"Rovara Cloud\\" --audience ${CLOUD_APP_CLIENT_ID} --redirect `);
    expect(register).toContain(`--confidential --full-access --scope ${CLOUD_APP_SCOPES.join(",")} --secret-file rovara-cloud-secret.txt`);
  });

  it("is named under rovara-cloud and refuses an environment name the environment rules refuse", () => {
    expect(cloudAppStackName("production")).toBe("rovara-cloud-production-app");
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
  });

});
