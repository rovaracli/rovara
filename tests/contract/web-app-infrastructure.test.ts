import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_ROLE_SERVICES, BOUNDARY_SERVICES } from "../../infra/lib/access-policies.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
skipLambdaBundling();
type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] | string };
type TemplateJson = { Resources: Record<string, Resource>; Conditions?: Record<string, unknown> };
type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: unknown };
const record = (value: unknown): Record<string, unknown> => { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected template object");return value as Record<string, unknown>; };
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, value]) => value.Type === type);
const statements = (value: unknown) => record(value).Statement as Statement[];
function build(mode: "cloudfront" | "cell"): TemplateJson {
 const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, agentxWebAssetHosting: mode });
 const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane");if (stack === undefined) throw new Error("Missing control-plane fixture");return Template.fromStack(stack).toJSON() as TemplateJson;
}
function stackOf(context: Record<string, unknown>): TemplateJson {
 const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, ...context });
 const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane");if (stack === undefined) throw new Error("Missing control-plane fixture");return Template.fromStack(stack).toJSON() as TemplateJson;
}
let hosted: TemplateJson, cell: TemplateJson, defaulted: TemplateJson, released: TemplateJson;
beforeAll(() => { hosted = build("cloudfront");cell = build("cell");defaulted = stackOf({});released = stackOf({ agentxSynthesizer: "legacy" }); }, 600_000);
const webFunction = (template: TemplateJson) => ofType(template, "AWS::Lambda::Function").find(([, resource]) => resource.Properties.FunctionName === "agentx-staging-web")!;
const webBucket = () => ofType(hosted, "AWS::S3::Bucket").find(([, resource]) => JSON.stringify(resource.Properties.BucketName ?? "").includes("web-assets"))!;
describe("named web hosting and isolated throttle budgets", () => {
 it("names and locks the asset bucket and grants object reads only to its OAC distribution", () => {
  const [bucketId, bucket] = webBucket();expect(bucketId).toBeTruthy();
  expect(evaluate(bucket.Properties.BucketName, { parameters: {}, conditions: {}, pseudo: { "AWS::AccountId": "123456789012", "AWS::Region": "us-west-2" } })).toBe("agentx-staging-web-assets-123456789012-us-west-2");
  expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
  const policy = ofType(hosted, "AWS::S3::BucketPolicy").find(([, resource]) => JSON.stringify(resource.Properties.Bucket).includes(bucketId))![1];
  const entries = statements(policy.Properties.PolicyDocument);const allows = entries.filter(statement => statement.Effect === "Allow");
  expect(allows.length).toBeGreaterThan(0);
  for (const statement of allows) { expect(statement.Principal).toEqual({ Service: "cloudfront.amazonaws.com" });expect(JSON.stringify(statement.Condition)).toContain("AWS:SourceArn");expect(JSON.stringify(statement.Condition)).toContain(ofType(hosted, "AWS::CloudFront::Distribution")[0]![0]);expect([statement.Action].flat().every(action => typeof action === "string" && action.startsWith("s3:GetObject"))).toBe(true); }
  expect(entries.some(statement => statement.Effect === "Deny" && JSON.stringify(statement.Condition).includes('"aws:SecureTransport":"false"'))).toBe(true);
  expect(ofType(hosted, "AWS::CloudFront::OriginAccessControl")).toHaveLength(1);expect(record(ofType(hosted, "AWS::CloudFront::OriginAccessControl")[0]![1].Properties.OriginAccessControlConfig)).toMatchObject({ OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
 });
 it("keeps old hashed assets and waits for their upload before changing the web function", () => {
  const [deploymentId, deployment] = ofType(hosted, "Custom::CDKBucketDeployment").find(([, resource]) => JSON.stringify(resource.Properties.DestinationBucketName).includes(webBucket()[0]))!;
  expect(deployment.Properties.Prune).toBe(false);expect(deployment.Properties.DestinationBucketKeyPrefix).toBe("app/assets/");expect(record(deployment.Properties.SystemMetadata)["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect([webFunction(hosted)[1].DependsOn].flat()).toContain(deploymentId);
 });
 it("lets only the BucketDeployment handler role write the web bucket", () => {
  const bucketId = webBucket()[0];const deployment = ofType(hosted, "Custom::CDKBucketDeployment").find(([, resource]) => JSON.stringify(resource.Properties.DestinationBucketName).includes(bucketId))![1];
  const handlerId = (record(deployment.Properties.ServiceToken)["Fn::GetAtt"] as string[])[0]!;const handler = hosted.Resources[handlerId]!;const writerRole = (record(handler.Properties.Role)["Fn::GetAtt"] as string[])[0]!;
  let writes = 0;
  const check = (roles: unknown, document: unknown) => {
   for (const statement of statements(document)) {
    if (statement.Effect !== "Allow" || ![statement.Action].flat().some(action => typeof action === "string" && /^(s3:(PutObject|DeleteObject)|s3:\*)/.test(action))) continue;
    const resources = JSON.stringify(statement.Resource);if (!resources.includes(bucketId) && resources !== '"*"') continue;
    expect(roles).toEqual([{ Ref: writerRole }]);writes += 1;
   }
  };
  for (const [, policy] of [...ofType(hosted, "AWS::IAM::Policy"), ...ofType(hosted, "AWS::IAM::ManagedPolicy")]) check(policy.Properties.Roles, policy.Properties.PolicyDocument);
  for (const [roleId, role] of ofType(hosted, "AWS::IAM::Role")) for (const policy of (role.Properties.Policies ?? []) as Array<Record<string, unknown>>) check([{ Ref: roleId }], policy.PolicyDocument);
  expect(writes).toBeGreaterThan(0);
 });
 it("uses compressed HTTPS-only read caching and the cell's exact CORS origin", () => {
  const distribution = record(ofType(hosted, "AWS::CloudFront::Distribution")[0]![1].Properties.DistributionConfig), behavior = record(distribution.DefaultCacheBehavior);
  expect(behavior.Compress).toBe(true);expect(behavior.ViewerProtocolPolicy).toBe("https-only");expect(behavior.AllowedMethods).toEqual(["GET", "HEAD"]);expect(behavior.CachePolicyId).toBe("658327ea-f89d-4fab-a63d-7e88639e58f6");expect(distribution.PriceClass).toBe("PriceClass_100");
  const origins = distribution.Origins as Array<Record<string, unknown>>;expect(origins[0]!.OriginAccessControlId).toBeTruthy();
  const headers = record(ofType(hosted, "AWS::CloudFront::ResponseHeadersPolicy")[0]![1].Properties.ResponseHeadersPolicyConfig), cors = record(headers.CorsConfig), security = record(headers.SecurityHeadersConfig);
  expect(record(cors.AccessControlAllowOrigins).Items).toEqual([{ "Fn::GetAtt": [ofType(hosted, "AWS::ApiGatewayV2::Api")[0]![0], "ApiEndpoint"] }]);expect(record(security.ContentTypeOptions).Override).toBe(true);expect(record(security.StrictTransportSecurity).AccessControlMaxAgeSec).toBeGreaterThan(0);
 });
 it("gives the 256 MB, ten-second web function only log permissions", () => {
  const [, fn] = webFunction(hosted);expect(fn.Properties.Runtime).toBe("nodejs22.x");expect(fn.Properties.MemorySize).toBe(256);expect(fn.Properties.Timeout).toBe(10);expect(fn.Properties.TracingConfig).toBeUndefined();
  const environment = record(record(fn.Properties.Environment).Variables);expect(environment.ASSET_ORIGIN).toBeTruthy();expect(Object.keys(environment).sort()).toEqual(["ASSET_ORIGIN", "REALTIME_HTTP_HOST", "REALTIME_WS_HOST", "ROVARA_EDITION"]);
  const roleId = (record(fn.Properties.Role)["Fn::GetAtt"] as string[])[0]!;const role = hosted.Resources[roleId]!;
  const policies = ofType(hosted, "AWS::IAM::Policy").filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(roleId));
  for (const [, policy] of policies) for (const statement of statements(policy.Properties.PolicyDocument)) expect([statement.Action].flat().every(action => typeof action === "string" && action.startsWith("logs:"))).toBe(true);
  expect(role.Properties.ManagedPolicyArns).toHaveLength(1);const managed = JSON.stringify(role.Properties.ManagedPolicyArns);expect(managed).toContain("AWSLambdaBasicExecutionRole");expect(managed).not.toContain("XRay");
 });
 it("gives each page and the cookie API its exact public route and independent throttle budget", () => {
  const routes = ofType(hosted, "AWS::ApiGatewayV2::Route"), stage = ofType(hosted, "AWS::ApiGatewayV2::Stage")[0]![1], settings = record(stage.Properties.RouteSettings);
  const pages = ["GET /app", "GET /app/{proxy+}", "GET /s/{sessionId}"];
  expect(routes.map(([, resource]) => resource.Properties.RouteKey)).not.toContain("GET /app/");
  for (const key of [...pages, "ANY /v1/web/{proxy+}"]) {
   const [id, route] = routes.find(([, resource]) => resource.Properties.RouteKey === key)!;expect(route.Properties.AuthorizationType).toBe("NONE");expect(route.Properties.AuthorizerId).toBeUndefined();expect([stage.DependsOn].flat()).toContain(id);
   expect(settings[key]).toEqual({ ThrottlingBurstLimit: key.startsWith("ANY") ? 400 : 200, ThrottlingRateLimit: key.startsWith("ANY") ? 200 : 100 });
  }
  for (const key of ["ANY /v1/app/{proxy+}", "ANY /v1/dev/{proxy+}", "ANY /v1/auth/{proxy+}", "ANY /review/{proxy+}", "GET /v1/github/install/callback", "POST /v1/github/install/confirm"]) expect(settings[key]).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
  expect(ofType(hosted, "AWS::Lambda::Permission").some(([, resource]) => JSON.stringify(resource.Properties.SourceArn).includes("/v1/web/*"))).toBe(true);
 });
 it("hosts all files from the cell without a bucket or distribution when selected", () => {
  expect(ofType(cell, "AWS::CloudFront::Distribution")).toHaveLength(0);expect(ofType(cell, "AWS::S3::Bucket").some(([, resource]) => JSON.stringify(resource.Properties.BucketName ?? "").includes("web-assets"))).toBe(false);expect(record(record(webFunction(cell)[1].Properties.Environment).Variables).ASSET_ORIGIN).toBe("");
 });
 it("includes the hosting service actions in the existing deployment boundary", () => { for (const service of ["s3", "lambda", "logs"]) { expect(SERVICE_ROLE_SERVICES).toContain(service);expect(BOUNDARY_SERVICES).toContain(service); } expect(SERVICE_ROLE_SERVICES).not.toContain("cloudfront");expect(BOUNDARY_SERVICES).not.toContain("cloudfront"); });
});

describe("which hosting each way of synthesizing gets", () => {
 it("hosts the files on CloudFront in a named environment deployed with the CDK engine, when nothing is chosen", () => {
  expect(ofType(defaulted, "AWS::CloudFront::Distribution")).toHaveLength(1);expect(ofType(defaulted, "Custom::CDKBucketDeployment")).toHaveLength(1);
 });
 it("hosts the files from the cell in a released template (bootstrap-free), with no CloudFront, bucket, BucketDeployment or AWS CLI layer", () => {
  for (const type of ["AWS::CloudFront::Distribution", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::ResponseHeadersPolicy", "Custom::CDKBucketDeployment", "AWS::Lambda::LayerVersion"]) expect(ofType(released, type), type).toHaveLength(0);
  expect(ofType(released, "AWS::S3::Bucket").some(([, resource]) => JSON.stringify(resource.Properties.BucketName ?? "").includes("web-assets"))).toBe(false);
  expect(record(record(webFunction(released)[1].Properties.Environment).Variables).ASSET_ORIGIN).toBe("");
  expect(JSON.stringify(released)).not.toContain("AwsCliLayer");
 });
 it("refuses CloudFront hosting for a bootstrap-free template, which could not be released", () => {
  expect(() => buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, agentxSynthesizer: "legacy", agentxWebAssetHosting: "cloudfront" })).toThrow(/CloudFront.*bootstrap-free|bootstrap-free.*CloudFront/);
 });
 it("keeps the environment name in the CloudFront names, so a rendered template names them for its own environment", () => {
  const [, headers] = ofType(hosted, "AWS::CloudFront::ResponseHeadersPolicy")[0]!, [, control] = ofType(hosted, "AWS::CloudFront::OriginAccessControl")[0]!;
  const named = (value: unknown) => evaluate(value, { parameters: {}, conditions: {}, pseudo: { "AWS::AccountId": "123456789012", "AWS::Region": "us-west-2" } });
  expect(named(record(headers.Properties.ResponseHeadersPolicyConfig).Name)).toBe("agentx-staging-web-assets-headers-us-west-2");
  expect(named(record(control.Properties.OriginAccessControlConfig).Name)).toBe("agentx-staging-web-assets-us-west-2");
 });
});

it("threads the real realtime DNS hosts into both web hosting modes", () => {
 for (const template of [hosted, cell]) {
 const apis = ofType(template, "AWS::AppSync::Api");expect(apis).toHaveLength(1);
 const environment = record(record(webFunction(template)[1].Properties.Environment).Variables);
 expect(environment.REALTIME_HTTP_HOST).toEqual({ "Fn::GetAtt": [apis[0]![0], "Dns.Http"] });
 expect(environment.REALTIME_WS_HOST).toEqual({ "Fn::GetAtt": [apis[0]![0], "Dns.Realtime"] });
 }
});
