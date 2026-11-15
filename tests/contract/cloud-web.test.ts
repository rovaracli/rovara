import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_TABLE } from "../../packages/cloud-server/src/index.js";
import { CloudWebStack, cloudWebStackName } from "../../infra/lib/cloud-web.js";
import { CLOUD_APP_CLIENT_ID } from "../../infra/lib/cloud-app.js";
import { buildAgentXApp } from "../../infra/lib/app.js";

// A built app with one page shell and one asset, as packages/web/dist/app has.
const built = (() => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-web-app-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "export {};");
  return dir;
})();
const synth = (environmentName: string) => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"),
}));

describe("Rovara Cloud on CloudFront, Lambda and DynamoDB (Rovara-cloud#11)", () => {
  const template = synth("production");
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }>;
  const idOf = (type: string, where: (properties: Record<string, unknown>) => boolean = () => true) => Object.entries(resources).find(([, each]) => each.Type === type && where(each.Properties))![0];
  const server = () => Object.values(resources).find((each) => each.Type === "AWS::Lambda::Function" && JSON.stringify(each.Properties).includes("CLOUD_TABLE"))!.Properties;

  it("sends the app's files to S3 and everything else to the function, caching only the files", () => {
    const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!.Properties as { DistributionConfig: Record<string, unknown> };
    const config = distribution.DistributionConfig as { DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Array<Record<string, unknown>>; Origins: Array<Record<string, unknown>> };
    // The managed policies: CachingDisabled and AllViewerExceptHostHeader for the function, CachingOptimized for the files.
    expect(config.DefaultCacheBehavior).toMatchObject({ CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac", ViewerProtocolPolicy: "redirect-to-https" });
    expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(expect.arrayContaining(["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]));
    expect(config.CacheBehaviors).toHaveLength(1);
    expect(config.CacheBehaviors[0]).toMatchObject({ PathPattern: "/app/assets/*", CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", ViewerProtocolPolicy: "redirect-to-https" });
    // The function's own address is not one people use: CloudFront reaches it, and the files bucket only through its access control.
    expect(JSON.stringify(config.Origins)).toContain(idOf("AWS::Lambda::Url"));
    expect(config.Origins.some((origin) => "OriginAccessControlId" in origin)).toBe(true);
    template.hasResourceProperties("AWS::S3::Bucket", { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
  });

  it("adds each release's files and deletes none, so a page opened before a release still finds its chunks", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", { Prune: false, DestinationBucketKeyPrefix: "app/assets/", SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" } });
  });

  it("keeps its state in one table shaped as the stores read it, kept and recoverable", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [{ AttributeName: CLOUD_TABLE.partitionKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.sortKey, KeyType: "RANGE" }],
      TimeToLiveSpecification: { AttributeName: CLOUD_TABLE.ttlAttribute, Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: CLOUD_TABLE.startedByIndex, KeySchema: [{ AttributeName: CLOUD_TABLE.startedByKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.startedBySort, KeyType: "RANGE" }] })],
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    template.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain" });
  });

  it("runs the server on Lambda with the settings it reads, and the same client secret as the Fargate app", () => {
    expect(server()).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 1024, Timeout: 30 });
    const variables = (server().Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({
      ROVARA_CODE_URL: { Ref: "CodeUrl" }, ROVARA_CLIENT_ID: CLOUD_APP_CLIENT_ID, CLOUD_TABLE: { Ref: idOf("AWS::DynamoDB::GlobalTable") },
      CLOUD_ORIGIN_PARAMETER: "/rovara-cloud/production/web/origin", CLOUD_CLIENT_SECRET_ID: "rovara-cloud/production/code-client-secret", CLOUD_APP_DIRECTORY: "/var/task/app",
    });
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/rovara-cloud/production/web/origin", Value: Match.objectLike({ "Fn::Join": ["", ["https://", Match.anyValue()]] }) });
  });

  it("lets the function read its address by name, so its role doesn't wait for the distribution that waits for it", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain(":parameter/rovara-cloud/production/web/origin");
    expect(policies).not.toContain(idOf("AWS::SSM::Parameter"));
  });

  it("prints the redirect to add on Code before people move to its address", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual(["AddRedirectOnCode", "CallbackUrl", "CloudUrl", "TableName"]);
    expect(JSON.stringify(outputs.AddRedirectOnCode!.Value)).toContain(`admin sign-in-client update ${CLOUD_APP_CLIENT_ID} --redirect <the old CallbackUrl> --redirect `);
  });

  it("is named under rovara-cloud, refuses a name the environment rules refuse, and comes with the Fargate app under -c rovaraCloudApp", () => {
    expect(cloudWebStackName("production")).toBe("rovara-cloud-production-web");
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
    const app = buildAgentXApp({ rovaraCloudApp: "production", agentxRegion: "us-east-1" });
    const stacks = app.node.children.filter((each) => "stackName" in each) as Array<{ stackName: string }>;
    expect(stacks.map((each) => each.stackName)).toEqual(["rovara-cloud-production-app", "rovara-cloud-production-web"]);
  });
});
