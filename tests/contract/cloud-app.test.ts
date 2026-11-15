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
      CLOUD_ENVIRONMENT: "production",
      CLOUD_WORK_SESSIONS_FILE: "/data/work-sessions.json",
      CLOUD_LEGACY_SESSIONS_FILE: "/data/sessions.json",
      CLOUD_SESSIONS_TABLE: { Ref: idOf("AWS::DynamoDB::Table") },
      CLOUD_SESSIONS_KEY_ID: { "Fn::GetAtt": [idOf("AWS::KMS::Key"), "Arn"] },
      ROVARA_CLIENT_SECRET_ID: { Ref: idOf("AWS::SecretsManager::Secret") },
    });
    // Sign-ins are no longer a file: the server keeps them in the table.
    expect(environment.CLOUD_SESSIONS_FILE).toBeUndefined();
    // Cloud's own address is the HTTP API's, so Code's redirect is that address's /callback.
    expect(environment.CLOUD_ORIGIN).toEqual({ "Fn::GetAtt": [idOf("AWS::ApiGatewayV2::Api"), "ApiEndpoint"] });
    expect(CLOUD_APP_CALLBACK_PATH).toBe("/callback");
    // The client secret comes from Secrets Manager at run time: never the template, and not the task's environment.
    expect(container().Secrets).toBeUndefined();
    expect(environment.ROVARA_CLIENT_SECRET).toBeUndefined();
    template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "rovara-cloud/production/code-client-secret" });
    template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Retain" });
  });

  it("keeps sign-ins in a DynamoDB table with expiry, sealed with a KMS key only the task's role may use", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], BillingMode: "PAY_PER_REQUEST", TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    template.hasResource("AWS::KMS::Key", { Properties: Match.objectLike({ EnableKeyRotation: true }), DeletionPolicy: "Retain" });
    const taskRole = (Object.values(template.findResources("AWS::ECS::TaskDefinition"))[0]!.Properties as { TaskRoleArn: { "Fn::GetAtt": [string, string] } }).TaskRoleArn["Fn::GetAtt"][0];
    const keyPolicy = (Object.values(template.findResources("AWS::KMS::Key"))[0]!.Properties as { KeyPolicy: { Statement: Array<{ Principal: unknown; Action: string | string[]; Condition?: unknown }> } }).KeyPolicy.Statement;
    const uses = (statement: { Action: string | string[] }) => [statement.Action].flat().some((action) => ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt", "kms:*", "kms:ReEncrypt*", "kms:GenerateDataKey*"].includes(action));
    // No statement lets the account grant itself use: no CreateGrant, no Create* wildcard.
    expect(keyPolicy.flatMap((statement) => [statement.Action].flat()).filter((action) => ["kms:CreateGrant", "kms:Create*", "kms:*"].includes(action))).toEqual([]);
    // Only the task's role may make or open data keys, and only for sign-ins.
    expect(keyPolicy.filter(uses)).toEqual([{
      Sid: "OnlyCloudsServerSeals", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [taskRole, "Arn"] } }, Action: ["kms:GenerateDataKey", "kms:Decrypt"], Resource: "*",
      Condition: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-cloud-session" } },
    }]);
    // The task's own policy: one item at a time on the table (no scan, no query), the key for sign-ins, and the secret.
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify((policy.Properties as { Roles: unknown }).Roles).includes(taskRole))
      .flatMap((policy) => (policy.Properties as { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }).PolicyDocument.Statement);
    const byAction = (action: string) => statements.filter((statement) => [statement.Action].flat().includes(action));
    expect(byAction("dynamodb:GetItem")).toEqual([expect.objectContaining({ Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: { "Fn::GetAtt": [idOf("AWS::DynamoDB::Table"), "Arn"] } })]);
    expect(statements.flatMap((statement) => [statement.Action].flat()).filter((action) => /^dynamodb:(Scan|Query|\*)/u.test(action))).toEqual([]);
    expect(byAction("kms:Decrypt")).toEqual([expect.objectContaining({ Resource: { "Fn::GetAtt": [idOf("AWS::KMS::Key"), "Arn"] }, Condition: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-cloud-session" } } })]);
    expect(byAction("secretsmanager:GetSecretValue")).toEqual([expect.objectContaining({ Resource: { Ref: idOf("AWS::SecretsManager::Secret") } })]);
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
