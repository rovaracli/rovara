import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { join, resolve } from "node:path";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";
import { CLOUD_APP_CALLBACK_PATH, CLOUD_APP_CLIENT_ID, CLOUD_APP_SCOPES, signInKey } from "./cloud-app.js";

/**
 * Rovara Cloud with no gap on a release (PrepLabsAI/Rovara-cloud#11): the same server as cloud-app.ts, on Lambda, with its state in
 * DynamoDB, so any number of copies serve at once and a release swaps them without stopping anything. The app's built files come
 * from S3; a release only adds files, so a page opened before it still finds its older script chunks.
 *
 *   browser -> CloudFront -> /app/assets/*  -> S3 (the built app, kept across releases)
 *                         -> everything else -> function URL -> Lambda (scripts/cloud-lambda.ts) -> Code's API
 *                                                                  |
 *                                                                  DynamoDB: sign-ins, Cloud's sessions and comments, who is viewing
 *
 * It is deployed beside cloud-app.ts (the single Fargate task) until people move to its address; then that one is removed.
 * Its address is CloudFront's, which the function reads from an SSM parameter (it can't name the distribution that points at it).
 */
export function cloudWebStackName(env: string): string {
  return `${RESOURCE_PREFIX}-${env}-web`;
}

/** The page shell's folder inside the function's bundle (CLOUD_APP_DIRECTORY). */
export const CLOUD_WEB_SHELL_DIRECTORY = "app";

export interface CloudWebProps extends StackProps {
  /** The named cloud environment, for example "production" (at most 14 characters, the environment rules). */
  readonly environmentName: string;
  /** Where the built app is (packages/web/dist/app); tests pass a stand-in. */
  readonly appDirectory?: string;
  /** The function's code; by default scripts/cloud-lambda.ts bundled at deploy. Tests pass a stand-in. */
  readonly code?: lambda.Code;
}

export class CloudWebStack extends Stack {
  /** Its state: where the Fargate app copies Cloud's sessions when it moves here (#11). */
  readonly table: dynamodb.ITableV2;
  /** Its https address (CloudFront's), where the Fargate app sends people once it has moved. */
  readonly origin: string;

  constructor(scope: Construct, id: string, props: CloudWebProps) {
    super(scope, id, props);
    const env = props.environmentName;
    const settings = environmentSettingsPrefix(env);
    const appDirectory = props.appDirectory ?? resolve(process.cwd(), "packages/web/dist/app");

    const codeUrl = new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "The Rovara Code install Cloud signs people in through and calls, for example https://abc.execute-api.us-east-1.amazonaws.com",
    });

    // Sign-ins, Cloud's sessions with their comments, and who is viewing (packages/cloud-server/src/dynamo-stores.ts, CLOUD_TABLE).
    const table = new dynamodb.TableV2(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      globalSecondaryIndexes: [{
        indexName: "startedBy",
        partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      }],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The same secret as cloud-app.ts: Cloud is one sign-in client of Code, whichever stack serves it.
    const clientSecret = secretsmanager.Secret.fromSecretNameV2(this, "CodeClientSecret", `${RESOURCE_PREFIX}/${env}/code-client-secret`);

    // aws-cdk-lib types Bucket.isWebsite as `boolean | undefined`, which exactOptionalPropertyTypes rejects for IBucket.
    const assets = new s3.Bucket(this, "Assets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Every release's files stay (the deployment never deletes), so a page loaded before a release still finds its chunks.
      removalPolicy: RemovalPolicy.RETAIN,
    }) as s3.IBucket;

    const originParameter = `${settings}web/origin`;
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const environment = {
      ROVARA_CODE_URL: codeUrl.valueAsString,
      ROVARA_CLIENT_ID: CLOUD_APP_CLIENT_ID,
      ROVARA_SCOPES: CLOUD_APP_SCOPES.join(" "),
      CLOUD_TABLE: table.tableName,
      CLOUD_ORIGIN_PARAMETER: originParameter,
      CLOUD_CLIENT_SECRET_ID: clientSecret.secretName,
      CLOUD_APP_DIRECTORY: `/var/task/${CLOUD_WEB_SHELL_DIRECTORY}`,
      NODE_OPTIONS: "--enable-source-maps",
    };
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      logGroup,
      environment,
      description: `Rovara Cloud ${env}: the web app's pages and Cloud's server`,
    };
    const server = props.code !== undefined
      ? new lambda.Function(this, "Server", { ...common, handler: "index.handler", code: props.code })
      : new nodejs.NodejsFunction(this, "Server", {
        ...common,
        entry: resolve(process.cwd(), "scripts/cloud-lambda.ts"),
        handler: "handler",
        projectRoot: process.cwd(),
        depsLockFilePath: resolve(process.cwd(), "package-lock.json"),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: "node22",
          sourceMap: true,
          banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          // The page shell goes with the function: it carries a fresh nonce on each request. The assets are in S3.
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (_input: string, output: string) => [`mkdir -p ${output}/${CLOUD_WEB_SHELL_DIRECTORY}`, `cp ${join(appDirectory, "index.html")} ${output}/${CLOUD_WEB_SHELL_DIRECTORY}/index.html`],
          },
        },
      });
    table.grantReadWriteData(server);
    clientSecret.grantRead(server);
    // Sign-ins are sealed with this stack's own key, which only the function's role may use (migration plan v3.2, 7.2 change 4).
    const sessionKey = signInKey(this, `Rovara Cloud ${env} (web): seals people's sign-ins (Code tokens) in the State table`, server.role!);
    server.addEnvironment("CLOUD_SESSIONS_KEY_ID", sessionKey.keyArn);
    const url = server.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(assets);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `Rovara Cloud ${env}`,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(url, { readTimeout: Duration.seconds(30) }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Cookies, query and headers reach the function; the Host header is the function URL's own.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
      additionalBehaviors: {
        "/app/assets/*": {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          compress: true,
        },
      },
    });

    // A release adds this build's files and deletes nothing (prune: false).
    new s3deploy.BucketDeployment(this, "AppFiles", {
      sources: [s3deploy.Source.asset(join(appDirectory, "assets"), { exclude: ["*.br", "*.gz"] })],
      destinationBucket: assets,
      destinationKeyPrefix: "app/assets/",
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
      memoryLimit: 512,
    });

    const origin = `https://${distribution.distributionDomainName}`;
    // aws-cdk-lib types TableV2.tableId as `string | undefined`, which exactOptionalPropertyTypes rejects for ITableV2.
    this.table = table as dynamodb.ITableV2;
    this.origin = origin;
    new ssm.StringParameter(this, "Origin", {
      parameterName: originParameter,
      stringValue: origin,
      description: `Rovara Cloud ${env}: its https address, which the server reads (it can't name the distribution that points at it)`,
    });
    // By name, not by the parameter: the function's role must not wait for the distribution that waits for the function.
    server.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${originParameter}`],
    }));

    const callbackUrl = `${origin}${CLOUD_APP_CALLBACK_PATH}`;
    new CfnOutput(this, "CloudUrl", { value: `${origin}/app`, description: "Rovara Cloud's web app" });
    new CfnOutput(this, "CallbackUrl", { value: callbackUrl, description: "The redirect Code's sign-in client rovara-cloud must allow" });
    new CfnOutput(this, "RegisterWithCode", {
      description: "A new environment: run once, as a Rovara Code administrator, then put the secret file's contents into ClientSecretName",
      value: `npx @preplabsai/rovara-code admin sign-in-client add ${CLOUD_APP_CLIENT_ID} --name "Rovara Cloud" --audience ${CLOUD_APP_CLIENT_ID} --redirect ${callbackUrl} --confidential --full-access --scope ${CLOUD_APP_SCOPES.join(",")} --secret-file rovara-cloud-secret.txt`,
    });
    new CfnOutput(this, "ClientSecretName", { value: clientSecret.secretName, description: "Where Cloud reads its client secret (made by the first-address stack); read again within five minutes of a change" });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
