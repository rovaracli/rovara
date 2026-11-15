// Rovara Cloud's first address (#11, PR 4): the Fargate app is gone; the same HTTP API answers every request with a 308 to the same
// path and query at Cloud's address (cloud-web.ts), from a small function.
import { runInNewContext } from "node:vm";
import { App, Lazy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CloudAppStack, REDIRECT_SOURCE, cloudAppStackName } from "../../infra/lib/cloud-app.js";

const MOVED_TO = "https://d5hwoqksa23xv.cloudfront.net";
const synth = (environmentName: string, movedTo = MOVED_TO) =>
  Template.fromStack(new CloudAppStack(new App(), "RovaraCloudApp", { environmentName, env: { region: "us-east-1" }, movedTo }));

/** The inline redirect, run as Lambda would run it. */
async function redirect(rawPath: string, rawQueryString = ""): Promise<{ statusCode: number; headers: Record<string, string> }> {
  const sandbox = { exports: {} as { handler?: (event: unknown) => Promise<{ statusCode: number; headers: Record<string, string> }> }, process: { env: { MOVED_TO } } };
  runInNewContext(REDIRECT_SOURCE, sandbox);
  return sandbox.exports.handler!({ rawPath, rawQueryString, requestContext: { http: { method: "POST" } } });
}

describe("Rovara Cloud's first address, now only a redirect", () => {
  const template = synth("production");
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;

  it("has no servers: no VPC, load balancer, Fargate, EFS, sign-ins table or key", () => {
    for (const type of ["AWS::EC2::VPC", "AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ECS::Service", "AWS::ECS::Cluster", "AWS::EFS::FileSystem", "AWS::DynamoDB::Table", "AWS::KMS::Key", "AWS::ApiGatewayV2::VpcLink"]) {
      template.resourceCountIs(type, 0);
    }
    const parameters = (template.toJSON() as { Parameters?: Record<string, unknown> }).Parameters ?? {};
    expect(Object.keys(parameters).filter((name) => !name.startsWith("BootstrapVersion"))).toEqual([]);
  });

  it("still makes Cloud's client secret, unchanged, so production keeps it and a new environment gets one", () => {
    // The same logical id and settings as the Fargate app had: CloudFormation leaves the secret (and its value) alone.
    expect(Object.entries(resources).filter(([, each]) => each.Type === "AWS::SecretsManager::Secret").map(([id]) => id)).toEqual([expect.stringMatching(/^CodeClientSecret[0-9A-F]{8}$/u)]);
    template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Retain", Properties: { Name: "rovara-cloud/production/code-client-secret", GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true } } });
  });

  it("keeps the same HTTP API, so the first address stays the same, in front of the redirect function", () => {
    // The logical id is the one the Fargate app's API had: CloudFormation keeps the API (and its address) instead of replacing it.
    expect(Object.entries(resources).filter(([, each]) => each.Type === "AWS::ApiGatewayV2::Api").map(([id]) => id)).toEqual(["ApiF70053CD"]);
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { Name: "rovara-cloud-production-app", ProtocolType: "HTTP" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
    template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 128, Environment: { Variables: { MOVED_TO } } });
  });

  it("sends every request, any method, to the same path and query at Cloud's address", async () => {
    expect(await redirect("/app/projects/demo", "tab=work")).toEqual({ statusCode: 308, headers: { location: `${MOVED_TO}/app/projects/demo?tab=work`, "cache-control": "no-store" }, body: "" });
    expect((await redirect("/")).headers.location).toBe(`${MOVED_TO}/`);
    expect((await redirect("/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/messages")).headers.location).toBe(`${MOVED_TO}/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/messages`);
  });

  it("prints both addresses", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual(["CloudUrl", "FirstUrl"]);
    expect(outputs.CloudUrl!.Value).toBe(`${MOVED_TO}/app`);
  });

  it("is named under rovara-cloud, refuses a name the environment rules refuse, and an address that isn't https or has a path", () => {
    expect(cloudAppStackName("production")).toBe("rovara-cloud-production-app");
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
    for (const bad of ["http://d5hwoqksa23xv.cloudfront.net", "https://d5hwoqksa23xv.cloudfront.net/app"]) expect(() => synth("production", bad)).toThrow(/https address with no path/);
    // Deployed, the address is CloudFront's, known only then.
    const later = `https://${Lazy.string({ produce: () => "d5hwoqksa23xv.cloudfront.net" })}`;
    expect(() => new CloudAppStack(new App(), "RovaraCloudApp", { environmentName: "production", env: { region: "us-east-1" }, movedTo: later })).not.toThrow();
  });
});
