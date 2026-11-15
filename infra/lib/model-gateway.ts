import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { METRICS_NAMESPACE_ROOT, RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";

/**
 * The Cloud model gateway's infrastructure (migration plan v3.2, 7.4; packages/model-gateway). Every model call of every task
 * passes through it, so it follows the availability rule of 7.5: two copies always, a release that never cuts a call, alarms.
 *
 *   worker (Code) --TLS--> load balancer (HTTPS only) --> 2+ Fargate tasks (GATEWAY_MODE=serve) --> api.anthropic.com
 *                                                              |  task token checked against Code's pinned JWKS
 *                                                              |  DynamoDB: meter (spend, holds), ledger (per-call records, pending-correction indexes),
 *                                                              |            markers (in-flight marker, ended tasks; expire),
 *                                                              |            prices (last good snapshot)
 *                                                              |  Secrets Manager: provider keys, read at run time
 *   EventBridge rule (daily) --> one Fargate task (GATEWAY_MODE=price-fetch) --> prices table
 *
 * Fargate, not Lambda: the gateway's entry is a node:http handler (server.ts createGatewayHandler) that streams one call for up
 * to an hour (provider.ts CALL_HARD_CEILING_MS), past Lambda's 15 minutes.
 *
 * Made only with `-c rovaraModelGateway=<environment>` (app.ts), never by the Cloud release pipeline, which deploys
 * RovaraCloudApp and RovaraCloudWeb by name. Two stacks:
 *  - ModelGatewayImagesStack: the image repository, deployed first so an image can be pushed before the service needs it;
 *  - ModelGatewayStack: everything else. Its parameters: CodeUrl (the one Code install trusted), CodeTaskKeyIds (the task-token
 *    key IDs Code's JWKS publishes, purpose=task; STAGING-KEY-PURPOSE-ORDER applies), CertificateArn (an existing ACM
 *    certificate for the gateway's name: this stack makes no certificate or DNS record) and ImageDigest (the image to run,
 *    by digest).
 *
 * The literals shared with the process (environment names, table keys, log events) are in
 * packages/model-gateway/src/deploy.ts; tests/contract/model-gateway-infra.test.ts holds the two to one truth.
 */

export const MODEL_GATEWAY_CONTEXT_KEY = "rovaraModelGateway";

/** Both validate the name first (the environment rules), so a bad name fails with that message, not CloudFormation's. */
export function modelGatewayStackName(env: string): string {
  environmentSettingsPrefix(env);
  return `${RESOURCE_PREFIX}-${env}-gateway`;
}
export function modelGatewayImagesStackName(env: string): string {
  environmentSettingsPrefix(env);
  return `${RESOURCE_PREFIX}-${env}-gateway-images`;
}

/** Repeated from packages/model-gateway/src/deploy.ts (infra does not depend on the gateway package); the contract test pins them. */
export const MODEL_GATEWAY_ENV = {
  mode: "GATEWAY_MODE",
  port: "GATEWAY_PORT",
  installIssuer: "GATEWAY_INSTALL_ISSUER",
  installJwksUrl: "GATEWAY_INSTALL_JWKS_URL",
  installTaskKids: "GATEWAY_INSTALL_TASK_KIDS",
  meterTable: "GATEWAY_METER_TABLE",
  ledgerTable: "GATEWAY_LEDGER_TABLE",
  markersTable: "GATEWAY_MARKERS_TABLE",
  pricesTable: "GATEWAY_PRICES_TABLE",
  anthropicKeySecret: "GATEWAY_ANTHROPIC_KEY_SECRET",
} as const;
export const MODEL_GATEWAY_PORT = 8080;
export const MODEL_GATEWAY_COMPANY_KEY_PREFIX = "CO#";
export const MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE = "expiresAt";
/** The ledger's pending-correction indexes (deploy.ts GATEWAY_LEDGER_INDEXES): sparse, string keys, every attribute projected. */
export const MODEL_GATEWAY_LEDGER_INDEXES = {
  pendingByKey: { name: "pending-by-key", partitionKey: "pendingAll", sortKey: "pendingKeyAt" },
  pendingByAge: { name: "pending-by-age", partitionKey: "pendingAll", sortKey: "pendingAt" },
} as const;
export const MODEL_GATEWAY_LOG_EVENTS = {
  refused: "refused",
  overrunBusy: "overrun_busy",
  settleFailed: "settle_failed",
  providerError: "provider_error",
  priceFetchFailed: "price_fetch_failed",
} as const;

/** The providers whose keys the gateway holds; one secret each. Only the Anthropic Messages route exists (R3a). */
export const MODEL_GATEWAY_PROVIDERS = ["anthropic"] as const;
/** Always at least this many copies serving (plan 7.5: two tasks). */
export const MODEL_GATEWAY_MIN_TASKS = 2;
/** One call may stream for up to an hour (provider.ts CALL_HARD_CEILING_MS): a release lets open calls finish, and the load
 * balancer does not cut a quiet stream before it. */
export const MODEL_GATEWAY_CALL_CEILING_SECONDS = 3600;
/** Daily, at 06:00 UTC (R3c REFRESH_INTERVAL_MS is 24 h). */
export const MODEL_GATEWAY_PRICE_FETCH_SCHEDULE = "cron(0 6 * * ? *)";
export const MODEL_GATEWAY_METRICS_NAMESPACE = `${METRICS_NAMESPACE_ROOT}/ModelGateway`;
/** Alarm thresholds (first guesses; tune from staging). Five-minute sums unless said. */
export const MODEL_GATEWAY_ALARMS = {
  target5xx: 10,
  loadBalancer5xx: 1,
  refusals: 50,
  busy: 20,
  settleFailed: 1,
  /** One hour. */
  priceFetchFailed: 1,
} as const;

/** The version ID Secrets Manager puts in the context of its key-access check (Secrets Manager encryption guide). */
export const VALIDATE_KEY_ACCESS_VERSION = "RequestToValidateKeyAccess";

export function providerSecretName(env: string, provider: string): string {
  return `${RESOURCE_PREFIX}/${env}/model-gateway/provider/${provider}`;
}

export interface ModelGatewayImagesProps extends StackProps {
  readonly environmentName: string;
}

/** The gateway's image repository: immutable tags, scanned on push, kept. */
export class ModelGatewayImagesStack extends Stack {
  readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: ModelGatewayImagesProps) {
    super(scope, id, props);
    environmentSettingsPrefix(props.environmentName);
    const repository = new ecr.Repository(this, "Images", {
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: "keep the last 50 images", maxImageCount: 50 }],
    });
    this.repository = repository;
    new CfnOutput(this, "RepositoryUri", { value: repository.repositoryUri, description: "Push the gateway image here; deploy the gateway stack with its digest" });
  }
}

export interface ModelGatewayProps extends StackProps {
  /** The named cloud environment, for example "staging" (at most 14 characters, the environment rules). */
  readonly environmentName: string;
  readonly repository: ecr.IRepository;
}

/** Table defaults: on-demand, point-in-time recovery, deletion protection, kept if the stack goes. */
function table(scope: Construct, id: string, ttl: boolean, indexes: readonly dynamodb.GlobalSecondaryIndexPropsV2[] = []): dynamodb.TableV2 {
  return new dynamodb.TableV2(scope, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    ...(ttl ? { timeToLiveAttribute: MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE } : {}),
    ...(indexes.length === 0 ? {} : { globalSecondaryIndexes: [...indexes] }),
    billing: dynamodb.Billing.onDemand(),
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

export class ModelGatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: ModelGatewayProps) {
    super(scope, id, props);
    const env = props.environmentName;
    environmentSettingsPrefix(env);

    const codeUrl = new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "The one Rovara Code install whose task tokens the gateway accepts (its issuer is <CodeUrl>/v1/auth)",
    });
    const taskKeyIds = new CfnParameter(this, "CodeTaskKeyIds", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_-]{16}(,[A-Za-z0-9_-]{16})?$",
      constraintDescription: "one or two 16-character key IDs, comma-separated",
      description: "The kid of Code's task-token key (purpose=task) in its JWKS; a second during rotation. Never the sign-in key's kid",
    });
    const certificateArn = new CfnParameter(this, "CertificateArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]{36}$",
      constraintDescription: "an ACM certificate ARN in this region",
      description: "An existing ACM certificate for the gateway's name (this stack makes no certificate or DNS record)",
    });
    const imageDigest = new CfnParameter(this, "ImageDigest", {
      type: "String",
      allowedPattern: "^sha256:[0-9a-f]{64}$",
      constraintDescription: "an image digest, sha256:<64 hex>",
      description: "The gateway image to run, by digest, from the gateway-images stack's repository",
    });
    const issuer = `${codeUrl.valueAsString}/v1/auth`;

    // Tables. Only markers expire (DEC 222: spend, holds and per-call records are kept).
    const meter = table(this, "Meter", false);
    // The ledger's estimated calls waiting for a real price (R3c's pending-correction index), as two sparse indexes.
    const ledger = table(this, "Ledger", false, Object.values(MODEL_GATEWAY_LEDGER_INDEXES).map((index) => ({
      indexName: index.name,
      partitionKey: { name: index.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: index.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })));
    const markers = table(this, "Markers", true);
    const prices = table(this, "Prices", false);

    // Provider keys: one secret each, encrypted with a key whose policy grants decrypt of a stored value to the serving task's
    // role only (through Secrets Manager). Not a boundary against an account principal holding kms:PutKeyPolicy or
    // iam:PassRole on that role: those stay administrator rights. The value starts as a placeholder; an operator stores the
    // real key with `aws secretsmanager put-secret-value` (a new version; the console's edit reads the value first and is
    // refused).
    const serveRole = new iam.Role(this, "ServeTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: the model gateway's serving tasks`,
    });
    const executionRole = (id: string, what: string) => new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: pulls the model gateway image and writes the ${what} logs`,
    });
    const fetchRole = new iam.Role(this, "PriceFetchTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: the model gateway's daily price fetch`,
    });
    const viaSecretsManager = `secretsmanager.${this.region}.amazonaws.com`;
    const secretArnPattern = `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:${providerSecretName(env, "")}*`;
    const providerKeysKey = new kms.Key(this, "ProviderKeysKey", {
      description: `Rovara Cloud ${env}: encrypts the model gateway's provider keys; only the gateway's serving role decrypts`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AccountManagesNotUses",
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              // Not kms:CreateGrant (nor Create*): a grant would let the account give itself use of the key.
              "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
              "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:RotateKeyOnDemand",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "OperatorsStoreNotRead",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:GenerateDataKey", "kms:Encrypt"],
            resources: ["*"],
            conditions: { StringEquals: { "kms:ViaService": viaSecretsManager }, StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern } },
          }),
          // Secrets Manager checks a new key with a GenerateDataKey + Decrypt whose context names the version
          // "RequestToValidateKeyAccess" (CreateSecret needs both, as the deploying principal). That Decrypt opens no real
          // version: every stored version is bound to its own version ID in the encryption context.
          new iam.PolicyStatement({
            sid: "ValidateKeyAccessOnly",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
              StringEquals: { "kms:ViaService": viaSecretsManager, "kms:EncryptionContext:SecretVersionId": VALIDATE_KEY_ACCESS_VERSION },
              StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern },
            },
          }),
          // By the role's ARN as a condition, not as a principal: no wait on a just-made role, and a replaced role keeps access.
          new iam.PolicyStatement({
            sid: "OnlyGatewayReads",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
              StringEquals: { "kms:ViaService": viaSecretsManager },
              StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern },
              ArnEquals: { "aws:PrincipalArn": serveRole.roleArn },
            },
          }),
        ],
      }),
    });
    // L1 on purpose: the L2 Secret adds kms:Decrypt for the whole account (through Secrets Manager) to the key's policy, which
    // would let any account principal with secretsmanager:GetSecretValue read the keys.
    const secrets = MODEL_GATEWAY_PROVIDERS.map((provider) => {
      const secret = new secretsmanager.CfnSecret(this, `ProviderKey-${provider}`, {
        name: providerSecretName(env, provider),
        description: `Rovara Cloud ${env}: the model gateway's ${provider} key. Starts as a placeholder; put the real key here before switching the gateway on.`,
        kmsKeyId: providerKeysKey.keyArn,
        generateSecretString: { passwordLength: 32, excludePunctuation: true },
      });
      secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return { secretArn: secret.ref, secretName: providerSecretName(env, provider) };
    });
    const anthropic = secrets[0]!;

    // The serving role: exactly these tables and secrets, company keys only on the company tables, no deletes of money rows.
    const companyKeysOnly = {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${MODEL_GATEWAY_COMPANY_KEY_PREFIX}*`] },
      Null: { "dynamodb:LeadingKeys": "false" },
    };
    // Transactions are authorised per item action (Put/Update/ConditionCheck), so these cover TransactWriteItems too.
    const moneyActions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"];
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "MeterAndLedgerCompanyKeys", actions: moneyActions, resources: [meter.tableArn, ledger.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "MarkersCompanyKeys", actions: [...moneyActions, "dynamodb:DeleteItem"], resources: [markers.tableArn], conditions: companyKeysOnly }));
    // The correction run (in the serving tasks) finds pending calls across companies through the ledger's two indexes:
    // Query only, those two indexes by name. Their partition is one constant, not a company key, so no LeadingKeys
    // condition; the rows they return are the ones the company-keys grant above already lets this role read.
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "QueryPendingCorrections", actions: ["dynamodb:Query"],
      resources: Object.values(MODEL_GATEWAY_LEDGER_INDEXES).map((index) => `${ledger.tableArn}/index/${index.name}`),
    }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadPrices", actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [prices.tableArn] }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadProviderKeys", actions: ["secretsmanager:GetSecretValue"], resources: secrets.map((secret) => secret.secretArn) }));
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "DecryptProviderKeys", actions: ["kms:Decrypt"], resources: [providerKeysKey.keyArn],
      conditions: { StringEquals: { "kms:ViaService": viaSecretsManager } },
    }));
    // The price job: the prices table only (no meter, no ledger, no keys). Corrections run in the serving tasks.
    fetchRole.addToPolicy(new iam.PolicyStatement({ sid: "WritePrices", actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [prices.tableArn] }));

    // Network: two zones, public subnets and no NAT gateway. Tasks take only the load balancer's traffic; DynamoDB through a
    // gateway endpoint.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      gatewayEndpoints: { DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
      // aws-cdk-lib's optional members don't satisfy exactOptionalPropertyTypes for IVpc / ICluster / ITaskDefinition (as cloud-web.ts).
    }) as ec2.IVpc;
    const albGroup = new ec2.SecurityGroup(this, "LoadBalancerGroup", { vpc, allowAllOutbound: false, description: "model gateway load balancer: HTTPS in, to the tasks out" });
    albGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "workers call the gateway over TLS");
    const taskGroup = new ec2.SecurityGroup(this, "TaskGroup", { vpc, allowAllOutbound: false, description: "model gateway tasks: the load balancer in, HTTPS out" });
    taskGroup.addIngressRule(albGroup, ec2.Port.tcp(MODEL_GATEWAY_PORT), "from the load balancer only");
    albGroup.addEgressRule(taskGroup, ec2.Port.tcp(MODEL_GATEWAY_PORT), "to the tasks");
    taskGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "providers, Code's JWKS, AWS APIs, the image registry");
    const fetchGroup = new ec2.SecurityGroup(this, "PriceFetchGroup", { vpc, allowAllOutbound: false, description: "model gateway price fetch: HTTPS out only" });
    fetchGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "price sources, AWS APIs, the image registry");

    const cluster = new ecs.Cluster(this, "Cluster", { vpc }) as ecs.ICluster;
    const image = ecs.ContainerImage.fromRegistry(props.repository.repositoryUriForDigest(imageDigest.valueAsString));
    const shared = { [MODEL_GATEWAY_ENV.pricesTable]: prices.tableName, NODE_OPTIONS: "--enable-source-maps" };

    const serveLogs = new logs.LogGroup(this, "ServeLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const serveTask = new ecs.FargateTaskDefinition(this, "ServeTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole: serveRole,
      executionRole: executionRole("ServeExecutionRole", "serving"),
    });
    serveTask.addContainer("gateway", {
      image,
      essential: true,
      readonlyRootFilesystem: true,
      user: "1000:1000",
      portMappings: [{ containerPort: MODEL_GATEWAY_PORT }],
      stopTimeout: Duration.seconds(120),
      logging: ecs.LogDrivers.awsLogs({ logGroup: serveLogs, streamPrefix: "serve" }),
      // Plain settings only: no `secrets` here (ECS would put the value in the environment). The process reads the key by ARN.
      environment: {
        ...shared,
        [MODEL_GATEWAY_ENV.mode]: "serve",
        [MODEL_GATEWAY_ENV.port]: String(MODEL_GATEWAY_PORT),
        [MODEL_GATEWAY_ENV.installIssuer]: issuer,
        // Pinned here, never taken from a token (TC-1: <iss>/.well-known/jwks.json).
        [MODEL_GATEWAY_ENV.installJwksUrl]: `${issuer}/.well-known/jwks.json`,
        [MODEL_GATEWAY_ENV.installTaskKids]: taskKeyIds.valueAsString,
        [MODEL_GATEWAY_ENV.meterTable]: meter.tableName,
        [MODEL_GATEWAY_ENV.ledgerTable]: ledger.tableName,
        [MODEL_GATEWAY_ENV.markersTable]: markers.tableName,
        [MODEL_GATEWAY_ENV.anthropicKeySecret]: anthropic.secretArn,
      },
    });
    props.repository.grantPull(serveTask.obtainExecutionRole());

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: serveTask,
      desiredCount: MODEL_GATEWAY_MIN_TASKS,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskGroup],
      enableExecuteCommand: false,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      securityGroup: albGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(MODEL_GATEWAY_CALL_CEILING_SECONDS),
      dropInvalidHeaderFields: true,
    });
    const listener = alb.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn.valueAsString)],
      open: false,
    });
    const targetGroup = listener.addTargets("Tasks", {
      port: MODEL_GATEWAY_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      // A release drains a task for as long as one call may last, so no open stream is cut.
      deregistrationDelay: Duration.seconds(MODEL_GATEWAY_CALL_CEILING_SECONDS),
      healthCheck: { path: "/healthz", healthyHttpCodes: "200", interval: Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
    });

    // The daily price fetch: the same image in price-fetch mode (packages/model-gateway/src/process.ts runPriceFetch), its own role.
    const fetchLogs = new logs.LogGroup(this, "PriceFetchLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const fetchTask = new ecs.FargateTaskDefinition(this, "PriceFetchTask", {
      cpu: 512,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole: fetchRole,
      executionRole: executionRole("PriceFetchExecutionRole", "price-fetch"),
    });
    fetchTask.addContainer("price-fetch", {
      image,
      essential: true,
      readonlyRootFilesystem: true,
      user: "1000:1000",
      logging: ecs.LogDrivers.awsLogs({ logGroup: fetchLogs, streamPrefix: "price-fetch" }),
      environment: { ...shared, [MODEL_GATEWAY_ENV.mode]: "price-fetch" },
    });
    props.repository.grantPull(fetchTask.obtainExecutionRole());
    new events.Rule(this, "PriceFetchSchedule", {
      description: `Rovara Cloud ${env}: the model gateway's daily price fetch`,
      schedule: events.Schedule.expression(MODEL_GATEWAY_PRICE_FETCH_SCHEDULE),
      enabled: true,
      targets: [new targets.EcsTask({
        cluster,
        taskDefinition: fetchTask as ecs.ITaskDefinition,
        taskCount: 1,
        launchType: ecs.LaunchType.FARGATE,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [fetchGroup],
      })],
    });

    // Alarms, to one topic (subscribe by hand). Gateway events are counted from its JSON log lines.
    const topic = new sns.Topic(this, "Alarms", { displayName: `Rovara Cloud ${env} model gateway alarms`, enforceSSL: true });
    const notify = new cwActions.SnsAction(topic);
    const fiveMinutes = Duration.minutes(5);
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string, evaluationPeriods = 1, comparison = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD) => {
      new cloudwatch.Alarm(this, id, {
        metric, threshold, evaluationPeriods, comparisonOperator: comparison, alarmDescription: description,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    };
    const fromLog = (id: string, group: logs.ILogGroup, event: string, period: Duration) => new logs.MetricFilter(this, `${id}Filter`, {
      logGroup: group,
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", event),
      metricNamespace: MODEL_GATEWAY_METRICS_NAMESPACE,
      metricName: `${id}-${env}`,
      metricValue: "1",
      defaultValue: 0,
    }).metric({ statistic: "Sum", period });
    alarm("Target5xx", targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }), MODEL_GATEWAY_ALARMS.target5xx, "The gateway answered 5xx (provider errors, unavailable)");
    alarm("LoadBalancer5xx", alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }), MODEL_GATEWAY_ALARMS.loadBalancer5xx, "The load balancer answered 5xx itself (no healthy task, timeouts)");
    alarm("HealthyTasks", targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1), statistic: "Minimum" }), MODEL_GATEWAY_MIN_TASKS, "Fewer than two gateway tasks are healthy", 3, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    alarm("Refusals", fromLog("Refusals", serveLogs, MODEL_GATEWAY_LOG_EVENTS.refused, fiveMinutes), MODEL_GATEWAY_ALARMS.refusals, "Many calls refused (tokens, budgets, guard)");
    alarm("BusyAnswers", fromLog("BusyAnswers", serveLogs, MODEL_GATEWAY_LOG_EVENTS.overrunBusy, fiveMinutes), MODEL_GATEWAY_ALARMS.busy, "Many busy answers: calls waiting on another estimated-price call of the same company");
    alarm("SettleFailures", fromLog("SettleFailures", serveLogs, MODEL_GATEWAY_LOG_EVENTS.settleFailed, fiveMinutes), MODEL_GATEWAY_ALARMS.settleFailed, "A call's cost could not be settled (its hold is kept)");
    alarm("PriceFetchFailures", fromLog("PriceFetchFailures", fetchLogs, MODEL_GATEWAY_LOG_EVENTS.priceFetchFailed, Duration.hours(1)), MODEL_GATEWAY_ALARMS.priceFetchFailed, "The daily price fetch failed (the last good prices stay)");

    new CfnOutput(this, "GatewayAddress", { value: `https://${alb.loadBalancerDnsName}`, description: "Point the certificate's name at this (DNS is outside this stack); Code's model-access route answers that name" });
    new CfnOutput(this, "Issuer", { value: issuer, description: "The one Code install trusted" });
    new CfnOutput(this, "ProviderKeySecrets", { value: Fn.join(",", secrets.map((secret) => secret.secretName)), description: "Put each provider's key here (write only; only the gateway reads)" });
    new CfnOutput(this, "AlarmTopic", { value: topic.topicArn });
  }
}
