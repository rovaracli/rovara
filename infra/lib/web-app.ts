import { Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_iam as iam, aws_lambda as lambda, aws_s3 as s3, aws_s3_deployment as deployment, type aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { resolve } from "node:path";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";
import type { CustomDomain } from "./custom-domain.js";
export interface ThrottledWebRoute { route: apigwv2.CfnRoute; burst: number; rate: number }
/** `cloudfront`: the files come from a CloudFront distribution over an S3 bucket (needs a BucketDeployment and its AWS CLI layer asset, so only a CDK-bootstrapped deploy can carry it). `cell`: the cell serves them itself. */
export type WebAssetHosting = "cloudfront" | "cell";
export interface WebAppProps { naming: AgentXNaming; api: apigwv2.CfnApi; assetHosting?: WebAssetHosting; realtimeHttpHost?: string; realtimeWsHost?: string; customDomain?: CustomDomain }
export class WebApp extends Construct {
 readonly routes: ThrottledWebRoute[] = [];
 readonly handlerFunction: lambdaNodejs.NodejsFunction;
 constructor(scope: Construct, id: string, props: WebAppProps) {
  super(scope, id);
  const stack = Stack.of(this), directory = resolve("packages/web/dist/app");
  let origin = "", upload: deployment.BucketDeployment | undefined;
  if ((props.assetHosting ?? "cloudfront") === "cloudfront") {
   const bucket = new s3.Bucket(this, "Assets", { bucketName: `${props.naming.resourcePrefix}-web-assets-${stack.account}-${stack.region}`, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: false, removalPolicy: RemovalPolicy.RETAIN });
   // CDK Bucket.isWebsite includes undefined, unlike IBucket under exactOptionalPropertyTypes (same compatibility cast as the existing pipeline).
   // Both names are explicit and carry the resource prefix (and the region, since CloudFront names are account-wide): CDK's generated names are the construct path with hyphens removed, which hides the environment name from a released template's placeholder replacement.
   const headers = new cloudfront.ResponseHeadersPolicy(this, "AssetHeaders", { responseHeadersPolicyName: `${props.naming.resourcePrefix}-web-assets-headers-${stack.region}`, corsBehavior: { accessControlAllowOrigins: props.customDomain === undefined ? [props.api.attrApiEndpoint] : props.customDomain.extraOrigins(), accessControlAllowMethods: ["GET", "HEAD"], accessControlAllowHeaders: ["*"], accessControlAllowCredentials: false, originOverride: true }, securityHeadersBehavior: { contentTypeOptions: { override: true }, strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true } } });
   const distribution = new cloudfront.Distribution(this, "Distribution", { defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket as s3.IBucket, { originAccessControl: new cloudfront.S3OriginAccessControl(this, "AssetAccess", { originAccessControlName: `${props.naming.resourcePrefix}-web-assets-${stack.region}`, signing: cloudfront.Signing.SIGV4_ALWAYS }) }), allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, compress: true, responseHeadersPolicy: headers }, priceClass: cloudfront.PriceClass.PRICE_CLASS_100 });
   origin = `https://${distribution.distributionDomainName}`;
   upload = new deployment.BucketDeployment(this, "Upload", { sources: [deployment.Source.asset(resolve(directory, "assets"))], destinationBucket: bucket as s3.IBucket, destinationKeyPrefix: "app/assets/", prune: false, retainOnDelete: true, cacheControl: [deployment.CacheControl.setPublic(), deployment.CacheControl.maxAge(Duration.days(365)), deployment.CacheControl.immutable()] });
  }
  // RULING Q12: this public file server needs logs only; existing factory callers retain active tracing.
  const fn = this.handlerFunction = packagedFunction(this, "Function", "packages/web/src/server/handler.ts", { ASSET_ORIGIN: origin, ...(props.customDomain === undefined ? {} : { CANONICAL_ORIGIN: props.customDomain.canonicalOrigin() }), REALTIME_HTTP_HOST: props.realtimeHttpHost ?? "", REALTIME_WS_HOST: props.realtimeWsHost ?? "" }, Duration.seconds(10), [], 256, [[directory, "app"]], lambda.Tracing.DISABLED);
  (fn.node.defaultChild as lambda.CfnFunction).functionName = `${props.naming.resourcePrefix}-web`;
  if (upload !== undefined) fn.node.addDependency(upload);
  const integration = new apigwv2.CfnIntegration(this, "Integration", { apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0" });
  // No `GET /app/` route: an HTTP API refuses a route key with an empty path segment (the 0.4.8 staging deploy rolled back on it). A request to `/app/` has no matching web route (`/app/{proxy+}` needs at least one character after the slash), so the app's own links always use `/app`.
  // UX1: `GET /join` is the invite link's page on the app's own origin (the web handler forwards it to the sign-in server's invite page on the same origin).
  for (const [name, path] of [["App", "/app"], ["AppPath", "/app/{proxy+}"], ["Session", "/s/{sessionId}"], ["Join", "/join"]] as const) {
   const route = new apigwv2.CfnRoute(this, name + "Route", { apiId: props.api.ref, routeKey: "GET " + path, target: `integrations/${integration.ref}`, authorizationType: "NONE" });
   this.routes.push({ route, burst: 200, rate: 100 });
   fn.addPermission(name + "Invoke", { principal: new iam.ServicePrincipal("apigateway.amazonaws.com"), sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/GET${path.replace(/\{[^}]+\}/g, "*")}` });
  }
 }
}
