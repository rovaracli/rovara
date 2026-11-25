import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Token,
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
import { PRODUCTION_SOURCE_KINDS_REFUSAL, RESOURCE_PREFIX, environmentSettingsPrefix, productionSourceKindsAllowed } from "@agentx/contracts";
import { applyCloudBoundary } from "./cloud-boundary.js";
import { addDeployedCloudSha } from "./deployed-cloud-sha.js";
import { CLOUD_APP_CALLBACK_PATH, CLOUD_APP_CLIENT_ID, CLOUD_APP_SCOPES, signInKey } from "./cloud-app.js";

/**
 * Rovara Cloud with no gap on a release (PrepLabsAI/Rovara-cloud#11): the same server as cloud-app.ts, on Lambda, with its state in
 * DynamoDB, so any number of copies serve at once and a release swaps them without stopping anything. The app's built files come
 * from S3; a release only adds files, so a page opened before it still finds its older script chunks.
 *
 *   browser -> CloudFront -> /app/assets/*  -> S3 (the built app, kept across releases)
 *                         -> everything else -> function URL (IAM, CloudFront-signed only) -> Lambda (scripts/cloud-lambda.ts) -> Code's API
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
  /**
   * The project product AI settings (B7, `-c rovaraModelGatewayProductAi=on`): the server writes the gateway's product key table
   * and seals keys with its KMS key (GenerateDataKey and GenerateMac only, never Decrypt). Production too
   * (Rovara-cloud#247); absent, the template is what it was (tests/contract/cloud-web-product-ai.test.ts).
   */
  readonly productAi?: boolean;
  /**
   * DEC 254t: the company AI source kinds the owner switched on (`-c rovaraAiSourceKinds`, checked in app.ts), set as
   * CLOUD_AI_SOURCE_KINDS. Absent: the variable is not set (none switched on; the template is what it was). Never for "production".
   */
  readonly aiSourceKinds?: string;
  /**
   * DEC 254zzz3(1): the operator's exempt (pilot) companies, the SAME ids as the gateway's `-c rovaraModelGatewayRovaraAiExempt`, set as CLOUD_ROVARA_AI_EXEMPT so the
   * settings screen can say Rovara's AI is the company's default. The gateway decides every call; this changes words only. Absent: not set (the template is what it was). Never for "production".
   */
  readonly rovaraAiExempt?: string;
}

/**
 * Lead 4 J3 (DEC 254z-amend2, 254zk(4)): the smart Just answer's Ask boxes. scripts/cloud-lambda.ts turns them on only when this variable is exactly "1"; nothing set it before (live switches check
 * 2026-11-18: the Ask boxes said "not available on this Rovara yet" although the gateway's answers purpose was live). Every web stack, including production (ANSWERS-ON-PROD), sets it from its own
 * stack parameter (CLOUD_ANSWERS_ENABLED_PARAMETER, "1" by default per DEC 254zzz215, "0" the existing operator override), so a later deploy keeps the operator's value.
 */
export const CLOUD_ANSWERS_ENABLED_ENV = "ROVARA_ANSWERS_ENABLED";
export const CLOUD_ANSWERS_ENABLED_PARAMETER = "AnswersEnabled";
export const CLOUD_ANSWERS_ENABLED_VALUES = ["1", "0"] as const;
export const CLOUD_ANSWERS_ENABLED_DEFAULT = "1";

/** Owner 2026-11-19: Cloud's own name (app.rovara.dev) and its certificate, stack parameters empty by default (cloud-web below). */
export const CLOUD_CUSTOM_DOMAIN_PARAMETER = "CustomDomainName";
export const CLOUD_CUSTOM_CERTIFICATE_PARAMETER = "CustomDomainCertificateArn";
/** Empty, or a lower-case DNS name of two or more labels (no scheme, port, path or trailing dot). */
export const CLOUD_CUSTOM_DOMAIN_PATTERN = "^(|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$";
/**
 * The viewer-request function (cloudfront-js-2.0) that sends every other name to Cloud's own name, as an Fn::Sub template: ${Target}
 * is the CustomDomainName parameter. Query values are passed on as CloudFront hands them over, the way AWS's own samples rebuild them.
 */
export const CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE = [
  "function handler(event) {",
  "  var target = \"${Target}\";",
  "  var request = event.request;",
  "  var host = request.headers.host ? request.headers.host.value : \"\";",
  "  if (target === \"\" || host === target) return request;",
  "  var parts = [];",
  "  for (var key in request.querystring) {",
  "    var field = request.querystring[key];",
  "    var values = field.multiValue ? field.multiValue : [field];",
  "    for (var i = 0; i < values.length; i++) parts.push(key + \"=\" + values[i].value);",
  "  }",
  "  var location = \"https://\" + target + request.uri + (parts.length > 0 ? \"?\" + parts.join(\"&\") : \"\");",
  "  return { statusCode: 307, statusDescription: \"Temporary Redirect\", headers: { location: { value: location }, \"cache-control\": { value: \"no-store\" } } };",
  "}",
].join("\n");

/** DEC 254zzz3(1): the server's environment variable for the exempt companies (scripts/cloud-lambda.ts reads it). */
export const CLOUD_ROVARA_AI_EXEMPT_ENV = "CLOUD_ROVARA_AI_EXEMPT";

/** DEC 254t: the server's environment variable for the switched-on company AI source kinds (scripts/cloud-lambda.ts reads it). */
export const CLOUD_AI_SOURCE_KINDS_ENV = "CLOUD_AI_SOURCE_KINDS";

/** The server's environment for the product AI settings (scripts/cloud-lambda.ts reads them; all three or none). */
export const CLOUD_PRODUCT_AI_ENV = { keysTable: "CLOUD_PRODUCT_KEYS_TABLE", keysKey: "CLOUD_PRODUCT_KEYS_KEY", macKey: "CLOUD_PRODUCT_KEYS_MAC_KEY", gatewayUrl: "CLOUD_MODEL_GATEWAY_URL" } as const;

/** The server's environment variable for "your own Bedrock" (scripts/cloud-lambda.ts bedrockBackend): the role template's docs-site address. */
export const CLOUD_BEDROCK_TEMPLATE_URL_ENV = "CLOUD_BEDROCK_TEMPLATE_URL";
/**
 * The BedrockTemplateUrl parameter's pattern: the same rule as validTemplateUrl (packages/model-gateway/src/bedrock-byo.ts) written for
 * CloudFormation. Empty, or https, a plain path to a .json file, and never an S3 or amazonaws.com host (DEC 238 Q10). The two lookaheads
 * are the host rule: no label that starts "s3." or "s3-", and no name ending ".amazonaws.com". A test holds the two rules together.
 */
export const BEDROCK_TEMPLATE_URL_PATTERN = "^(|https://(?!(?:[a-z0-9-]*\\.)*s3[.-])(?![a-z0-9.-]*\\.amazonaws\\.com/)[a-z0-9.-]{1,253}/[A-Za-z0-9._~/-]{1,512}\\.json)$";

/**
 * What the server may do in its State table, by partition-key prefix (the layout in packages/cloud-server/src/dynamo-stores.ts):
 *   SIGNIN#   a sign-in: read, created, its last-seen time updated, deleted on sign-out (session-table.ts)
 *   PENDING#  a sign-in under way: written, then taken once with a delete
 *   SESSION#  a Cloud session and its comments: written (in a transaction) and read as one partition (Query)
 *   REQUEST#  the session a start request made, and (`REQUEST#task-<task id>`) the session of a Code task: written and read
 *   PRESENCE# who is viewing: a heartbeat written, the partition read (Query)
 *   AUDIT#    the company audit record (#50): written once, a month's partition read (Query); never updated or deleted
 *   AUDITID#  an audit record's id marker: written once (the same transaction), never read or changed
 * and Query on the startedBy index (STARTED#<developer id>), which holds only META items the SESSION# rights already read.
 */
export const CLOUD_WEB_TABLE_ACCESS: ReadonlyArray<{ readonly prefix: string; readonly actions: readonly string[] }> = [
  { prefix: "SIGNIN#", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"] },
  { prefix: "PENDING#", actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"] },
  { prefix: "SESSION#", actions: ["dynamodb:PutItem", "dynamodb:Query"] },
  { prefix: "REQUEST#", actions: ["dynamodb:GetItem", "dynamodb:PutItem"] },
  { prefix: "PRESENCE#", actions: ["dynamodb:PutItem", "dynamodb:Query"] },
  // #50: the company audit record, append-only (a record and its id marker written once, in one transaction; months read by Query).
  { prefix: "AUDIT#", actions: ["dynamodb:PutItem", "dynamodb:Query"] },
  { prefix: "AUDITID#", actions: ["dynamodb:PutItem"] },
];

/** The table's index of a person's sessions (CLOUD_TABLE.startedByIndex; tests hold the two equal). */
export const CLOUD_WEB_STARTED_BY_INDEX = "startedBy";

/** The server role's statements on the State table: one per prefix, bound to it with dynamodb:LeadingKeys, plus the index's Query. */
export function cloudWebTableStatements(tableArn: string): iam.PolicyStatement[] {
  return [
    ...CLOUD_WEB_TABLE_ACCESS.map(({ prefix, actions }) => new iam.PolicyStatement({
      actions: [...actions],
      resources: [tableArn],
      conditions: {
        // Every key the request names starts with the prefix; the Null check refuses a request that names no key at all
        // (ForAllValues alone is true on an empty set).
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": `${prefix}*` },
        Null: { "dynamodb:LeadingKeys": "false" },
      },
    })),
    new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${tableArn}/index/${CLOUD_WEB_STARTED_BY_INDEX}`] }),
  ];
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
    // Like ProductKeysTableName, passed by the controller rather than a cross-stack export: the gateway deploys independently.
    // Empty (the default, an install with no model gateway): the server gets no meter table and People and limits answers "not connected yet".
    // The grant below then names a table with no name, which matches nothing.
    const meterTableName = new CfnParameter(this, "GatewayMeterTableName", {
      type: "String", default: "", allowedPattern: "^(|[A-Za-z0-9_.-]{3,255})$",
      description: "The model gateway's Meter table physical name (not ProductMeter or LearningMeter); its Issuer output must equal CodeUrl + /v1/auth; empty: no gateway, spend shows not connected yet",
    }).valueAsString;
    const meterTableSet = new CfnCondition(this, "GatewayMeterTableNameSet", { expression: Fn.conditionNot(Fn.conditionEquals(meterTableName, "")) });
    const meterTableArn = `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${meterTableName}`;

    // Sign-ins, Cloud's sessions with their comments, and who is viewing (packages/cloud-server/src/dynamo-stores.ts, CLOUD_TABLE).
    const table = new dynamodb.TableV2(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      globalSecondaryIndexes: [{
        indexName: CLOUD_WEB_STARTED_BY_INDEX,
        partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      }],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Cloud's company data (packages/cloud-server/src/company-dynamo.ts, COMPANY_TABLE): settings and rules, a change waiting for a second
    // admin, profile, invites (with invitees' email addresses) and the policy hook's install allow-list. Long-lived configuration, so a
    // table of its own: kept, recoverable, and granted to the server item by item (below), with no Scan and no batch writes.
    const companies = new dynamodb.TableV2(this, "Companies", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
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
      COMPANY_TABLE: companies.tableName,
      CLOUD_GATEWAY_METER_TABLE: Token.asString(Fn.conditionIf(meterTableSet.logicalId, meterTableName, Aws.NO_VALUE)),
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
    // Only the item actions the server's stores use (packages/cloud-server/src/dynamo-stores.ts, session-table.ts), each on the key
    // prefixes it writes or reads: no Scan, no batch actions, no stream reads, and Query only within one SESSION#/PRESENCE# partition or
    // on the startedBy index (which holds META items only). A TransactWriteItems is allowed item by item by the PutItem rights below.
    for (const statement of cloudWebTableStatements(table.tableArn)) server.addToRolePolicy(statement);
    // Exactly what DynamoCompanyStore sends: a transaction's ConditionCheck needs ConditionCheckItem; no Scan, no batch, no table changes.
    companies.grant(server, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem");
    // People and limits: exact company item reads only. BatchGetItem is the reader's current call; GetItem is the approved item-read grant.
    server.addToRolePolicy(new iam.PolicyStatement({
      sid: "GatewayMeterCompanyReads", actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [meterTableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
    clientSecret.grantRead(server);
    // Sign-ins are sealed with this stack's own key, which only the function's role may use (migration plan v3.2, 7.2 change 4).
    const sessionKey = signInKey(this, `Rovara Cloud ${env} (web): seals people's sign-ins (Code tokens) in the State table`, server.role!);
    server.addEnvironment("CLOUD_SESSIONS_KEY_ID", sessionKey.keyArn);
    if (props.productAi === true) this.productAi(env, server, codeUrl.valueAsString);
    if (props.aiSourceKinds !== undefined) {
      if (env === "production" && !productionSourceKindsAllowed(props.aiSourceKinds)) throw new Error(PRODUCTION_SOURCE_KINDS_REFUSAL);
      server.addEnvironment(CLOUD_AI_SOURCE_KINDS_ENV, props.aiSourceKinds);
    }
    if (props.rovaraAiExempt !== undefined) {
      if (env === "production") throw new Error("Rovara's AI for exempt companies is for named test environments until a Cloud release carries it");
      server.addEnvironment(CLOUD_ROVARA_AI_EXEMPT_ENV, props.rovaraAiExempt);
    }
    const answers = new CfnParameter(this, CLOUD_ANSWERS_ENABLED_PARAMETER, {
      type: "String", default: CLOUD_ANSWERS_ENABLED_DEFAULT, allowedValues: [...CLOUD_ANSWERS_ENABLED_VALUES],
      description: "The smart Just answer's Ask boxes (lead 4 J3): 1 (the default) on, 0 off. On needs the model gateway's answers purpose deployed; Code decides who may ask",
    });
    server.addEnvironment(CLOUD_ANSWERS_ENABLED_ENV, answers.valueAsString);
    // IAM auth on the function URL, signed by CloudFront's origin access control (SigV4, always), and invoke rights only for this
    // distribution: the function's own address answers 403 to anyone else, so every request goes through CloudFront.
    const url = server.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // Owner 2026-11-19: Cloud on its own name (app.rovara.dev), one name for every company. Both empty (the default): CloudFront's
    // name only, as before. Set: CloudFront answers that name with the certificate (us-east-1, made outside this stack, like the
    // gateway's), Cloud's address (the SSM parameter, the outputs) becomes it, and the CloudFront name answers 307 to it.
    const customDomain = new CfnParameter(this, CLOUD_CUSTOM_DOMAIN_PARAMETER, {
      type: "String", default: "", allowedPattern: CLOUD_CUSTOM_DOMAIN_PATTERN,
      description: "Cloud's own name, for example app.rovara.dev (lower case, no scheme or path); empty: CloudFront's name only. Point a CNAME at the distribution before setting it",
    }).valueAsString;
    const customCertificate = new CfnParameter(this, CLOUD_CUSTOM_CERTIFICATE_PARAMETER, {
      type: "String", default: "", allowedPattern: "^(|arn:aws[a-z-]*:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]{36})$",
      description: "An issued ACM certificate in us-east-1 for CustomDomainName (made outside this stack); empty with an empty CustomDomainName",
    }).valueAsString;
    new CfnRule(this, "CustomDomainNeedsCertificate", {
      assertions: [{
        assert: Fn.conditionOr(
          Fn.conditionAnd(Fn.conditionEquals(customDomain, ""), Fn.conditionEquals(customCertificate, "")),
          Fn.conditionAnd(Fn.conditionNot(Fn.conditionEquals(customDomain, "")), Fn.conditionNot(Fn.conditionEquals(customCertificate, ""))),
        ),
        assertDescription: "CustomDomainName and CustomDomainCertificateArn are set together or both left empty",
      }],
    });
    const customDomainSet = new CfnCondition(this, "CustomDomainSet", { expression: Fn.conditionNot(Fn.conditionEquals(customDomain, "")) });
    // Every request on another name (CloudFront's) goes to Cloud's own name: the server answers one address only (handler.ts,
    // approve.ts refuse writes from any other), so a page left on the old name would show but never save. 307 keeps the method
    // and is not cached by browsers, so emptying the parameter undoes it. Empty name: the request goes on unchanged.
    const toCustomDomain = new cloudfront.Function(this, "ToCustomDomain", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: `Rovara Cloud ${env}: sends other names to Cloud's own name, when it has one`,
      code: cloudfront.FunctionCode.fromInline(Fn.sub(CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE, { Target: customDomain })),
    });
    const functionAssociations = [{ function: toCustomDomain, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }];

    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(assets);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `Rovara Cloud ${env}`,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        // A signed POST/PUT needs the body's SHA-256 in x-amz-content-sha256 (Lambda takes no unsigned payloads): the browser's
        // writes send it (packages/web/src/browser-host.ts, approve.ts), and the origin request policy passes it on.
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(url, { readTimeout: Duration.seconds(30) }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Cookies, query and headers reach the function; the Host header is the function URL's own.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
        functionAssociations,
      },
      additionalBehaviors: {
        "/app/assets/*": {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          compress: true,
          functionAssociations,
        },
      },
    });
    // The name and its certificate only when set; otherwise CloudFront's own certificate, as before.
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride("DistributionConfig.Aliases", Fn.conditionIf(customDomainSet.logicalId, [customDomain], Aws.NO_VALUE));
    cfnDistribution.addPropertyOverride("DistributionConfig.ViewerCertificate", Fn.conditionIf(customDomainSet.logicalId,
      { AcmCertificateArn: customCertificate, SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" },
      { CloudFrontDefaultCertificate: true }));

    // A release adds this build's files and deletes nothing (prune: false).
    new s3deploy.BucketDeployment(this, "AppFiles", {
      sources: [s3deploy.Source.asset(join(appDirectory, "assets"), { exclude: ["*.br", "*.gz"] })],
      destinationBucket: assets,
      destinationKeyPrefix: "app/assets/",
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
      memoryLimit: 512,
      // Its own log group (named from this stack), not /aws/lambda/<function>: CloudFormation shortens that generated function name,
      // stack name included, so the role boundary (cloud-boundary.ts) can't name it.
      logGroup: new logs.LogGroup(this, "AppFilesLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });

    // CloudFront's address stays this.origin: the first-address stack imports it (an export in use can't change), and its redirect
    // there is sent on to the own name by ToCustomDomain. Cloud's address (what the server answers as) is the own name when set.
    const cloudfrontOrigin = `https://${distribution.distributionDomainName}`;
    const origin = Token.asString(Fn.conditionIf(customDomainSet.logicalId, Fn.join("", ["https://", customDomain]), cloudfrontOrigin));
    // aws-cdk-lib types TableV2.tableId as `string | undefined`, which exactOptionalPropertyTypes rejects for ITableV2.
    this.table = table as dynamodb.ITableV2;
    this.origin = cloudfrontOrigin;
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
    new CfnOutput(this, "CompanyTableName", { value: companies.tableName });
    if (props.productAi === true) new CfnOutput(this, "ServerRoleArn", { value: server.role!.roleArn, description: "The model gateway stack's CloudSettingsRoleArn: this role seals product keys" });
    addDeployedCloudSha(this);
    // Last, so the template keeps its section order; the aspect puts it on every role at synth (cloud-boundary.ts).
    applyCloudBoundary(this, env, "web", meterTableArn);
  }

  /** The product AI settings' grants (B7): the gateway's product key table by company keys, and the two KMS keys' sealing calls only. */
  private productAi(env: string, server: lambda.Function, codeUrl: string): void {
    const param = (id: string, pattern: string, description: string) => new CfnParameter(this, id, { type: "String", allowedPattern: pattern, description }).valueAsString;
    const tableName = param("ProductKeysTableName", "^[A-Za-z0-9_.-]{3,255}$", "The model gateway's product key table (gateway output ProductKeysTableName)");
    const keyArn = param("ProductKeysKeyArn", "^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", "The gateway's product key KMS key (gateway output ProductKeysKeyArn)");
    const macKeyArn = param("ProductKeysMacKeyArn", "^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", "The gateway's fingerprint HMAC key (gateway output ProductKeysMacKeyArn)");
    server.addToRolePolicy(new iam.PolicyStatement({
      sid: "ProductKeysCompanyKeys",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
      resources: [`arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${tableName}`],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
    server.addToRolePolicy(new iam.PolicyStatement({
      sid: "SealProductKeys", actions: ["kms:GenerateDataKey"], resources: [keyArn],
      conditions: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-product-ai-key", "kms:EncryptionContext:install": `${codeUrl}/v1/auth` } },
    }));
    server.addToRolePolicy(new iam.PolicyStatement({ sid: "FingerprintProductKeys", actions: ["kms:GenerateMac"], resources: [macKeyArn] }));
    server.addEnvironment(CLOUD_PRODUCT_AI_ENV.keysTable, tableName);
    server.addEnvironment(CLOUD_PRODUCT_AI_ENV.keysKey, keyArn);
    server.addEnvironment(CLOUD_PRODUCT_AI_ENV.macKey, macKeyArn);
    // The gateway runs the Vertex AI connection test for the settings routes (signed with the HMAC key above, no new grant).
    // Empty (the default): a Vertex connect answers unavailable; AI Studio and learning keys are unaffected.
    const gatewayUrl = new CfnParameter(this, "ModelGatewayUrl", { type: "String", default: "", allowedPattern: "^(|https://[^/\\s]+)$", description: "The model gateway's https address (its certificate's name, gateway output GatewayAddress); empty: no Vertex AI connect from Cloud" }).valueAsString;
    server.addEnvironment(CLOUD_PRODUCT_AI_ENV.gatewayUrl, gatewayUrl);
    // "Your own Bedrock" (DEC 238): the role template's docs-site address. Empty (the default): the variable is not set at all and the
    // Bedrock routes answer 501, so a pipeline deploy that passes no new parameter still works. Set, it needs the gateway's address.
    const templateUrl = new CfnParameter(this, "BedrockTemplateUrl", {
      type: "String", default: "", allowedPattern: BEDROCK_TEMPLATE_URL_PATTERN,
      description: "The Bedrock role template's https address on the docs site (a .json file, never S3); empty: no BYO Bedrock connect (the routes answer 501); needs ModelGatewayUrl",
    }).valueAsString;
    const templateUrlSet = new CfnCondition(this, "BedrockTemplateUrlSet", { expression: Fn.conditionNot(Fn.conditionEquals(templateUrl, "")) });
    server.addEnvironment(CLOUD_BEDROCK_TEMPLATE_URL_ENV, Token.asString(Fn.conditionIf(templateUrlSet.logicalId, templateUrl, Aws.NO_VALUE)));
    new CfnRule(this, "BedrockNeedsGateway", {
      ruleCondition: Fn.conditionNot(Fn.conditionEquals(templateUrl, "")),
      assertions: [{ assert: Fn.conditionNot(Fn.conditionEquals(gatewayUrl, "")), assertDescription: "BedrockTemplateUrl needs ModelGatewayUrl (the server refuses to start with one and not the other)" }],
    });
  }
}
