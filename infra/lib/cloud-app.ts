import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_efs as efs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpAlbIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Construct } from "constructs";
import { resolve } from "node:path";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";

/**
 * Rovara Cloud (owner decisions 2026-11-14): the web app and Cloud's server (scripts/cloud-server.ts, packages/cloud-server)
 * on an existing Rovara Code install. Cloud has no user pool, workers or Slack service of its own: people sign in through
 * Code, as its sign-in client `rovara-cloud` (Code specs 063, 065, 066), so anyone Code lets in can use Cloud.
 *
 *   browser -> HTTP API (HTTPS) -> VPC link -> internal load balancer -> one Fargate task -> Code's API
 *                                                                         |
 *                                                                         |  DynamoDB (KMS-sealed): sign-ins
 *                                                                         EFS: Cloud's sessions
 *
 * Sign-ins (migration plan v3.2, 7.2 change 4) live in a DynamoDB table with expiry, under a hash of the cookie, each one
 * sealed with a data key from a KMS key only the task's role may use (packages/cloud-server/src/sessions.ts). The task
 * reads its client secret from Secrets Manager at run time; it is not in the task's environment.
 *
 * One task, never two at once (a release stops the old one first): Cloud's own sessions are a file (LocalWorkSessionStore)
 * on EFS, and who is viewing a session is in its memory (LocalPresenceBoard).
 *
 * After the first deploy, a Code administrator registers Cloud (the RegisterWithCode output) and puts the secret it shows
 * once into CodeClientSecret; the task reads it within five minutes, or at once after a restart (docs/rovara-cloud-install.md).
 */
export const CLOUD_APP_CONTEXT_KEY = "rovaraCloudApp";
/** The client ID Cloud signs in to Code as (Code's `admin sign-in-client add <id>`), and the audience its tokens carry. */
export const CLOUD_APP_CLIENT_ID = "rovara-cloud";
/** What Cloud asks to do as the signed-in person (Code spec 065): every scope Code has, as scripts/cloud-server.ts asks. */
export const CLOUD_APP_SCOPES = ["projects:members", "projects:create"] as const;
export const CLOUD_APP_PORT = 8080;
/** Where Code sends people back after sign-in: scripts/cloud-server.ts answers it (createCloudHandler's callbackPath). */
export const CLOUD_APP_CALLBACK_PATH = "/callback";
/** Inside the container: the EFS volume holding Cloud's sessions file. */
export const CLOUD_APP_DATA_PATH = "/data";
/** The KMS encryption context every sign-in's data key carries (packages/cloud-server/src/session-crypto.ts). */
export const CLOUD_SESSION_KEY_PURPOSE = "rovara-cloud-session";

/**
 * The key that seals sign-ins (packages/cloud-server/src/session-crypto.ts). The account may manage it but not use it: only
 * `server` may make and open data keys, and only for sign-ins (the encryption context). Retained, so a sealed sign-in is
 * never orphaned mid-release. Used by this stack and cloud-web.ts.
 */
export function signInKey(scope: Construct, description: string, server: iam.IRole): kms.Key {
  const sealUse = ["kms:GenerateDataKey", "kms:Decrypt"];
  const forSignIns = { StringEquals: { "kms:EncryptionContext:purpose": CLOUD_SESSION_KEY_PURPOSE } };
  const key = new kms.Key(scope, "SignInKey", {
    description,
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
        new iam.PolicyStatement({ sid: "OnlyCloudsServerSeals", principals: [new iam.ArnPrincipal(server.roleArn)], actions: sealUse, resources: ["*"], conditions: forSignIns }),
      ],
    }),
  });
  server.addToPrincipalPolicy(new iam.PolicyStatement({ actions: sealUse, resources: [key.keyArn], conditions: forSignIns }));
  return key;
}

export function cloudAppStackName(env: string): string {
  return `${RESOURCE_PREFIX}-${env}-app`;
}

export interface CloudAppProps extends StackProps {
  /** The named cloud environment, for example "production" (at most 14 characters, the environment rules). */
  readonly environmentName: string;
  /** The container image; by default built from environments/cloud/Dockerfile at deploy. Tests pass a stand-in. */
  readonly image?: ecs.ContainerImage;
}

export class CloudAppStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudAppProps) {
    super(scope, id, props);
    const env = props.environmentName;
    // Validates the name at synth.
    environmentSettingsPrefix(env);

    const codeUrl = new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "The Rovara Code install Cloud signs people in through and calls, for example https://abc.execute-api.us-east-1.amazonaws.com",
    });

    // aws-cdk-lib types Vpc.vpnGatewayId as `string | undefined`, which exactOptionalPropertyTypes rejects for IVpc.
    const vpc = new ec2.Vpc(this, "Network", {
      maxAzs: 2,
      natGateways: 0,
      // The task has a public address for its way out (Code, ECR, Secrets Manager, logs); nothing reaches it from outside
      // but the load balancer. The load balancer, the API's VPC link and EFS sit in the isolated subnets.
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    }) as ec2.IVpc;
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    const linkAccess = new ec2.SecurityGroup(this, "ApiLinkAccess", { vpc, allowAllOutbound: false, description: "The HTTP API VPC link: out to the load balancer only" });
    const balancerAccess = new ec2.SecurityGroup(this, "LoadBalancerAccess", { vpc, allowAllOutbound: false, description: "The internal load balancer: in from the VPC link, out to the task" });
    const serviceAccess = new ec2.SecurityGroup(this, "ServiceAccess", { vpc, allowAllOutbound: true, description: "The Cloud task: in from the load balancer only" });
    linkAccess.addEgressRule(balancerAccess, ec2.Port.tcp(80), "To the load balancer");
    balancerAccess.addIngressRule(linkAccess, ec2.Port.tcp(80), "From the HTTP API VPC link");
    balancerAccess.addEgressRule(serviceAccess, ec2.Port.tcp(CLOUD_APP_PORT), "To the Cloud task");
    serviceAccess.addIngressRule(balancerAccess, ec2.Port.tcp(CLOUD_APP_PORT), "From the load balancer");

    const clientSecret = new secretsmanager.Secret(this, "CodeClientSecret", {
      secretName: `${RESOURCE_PREFIX}/${env}/code-client-secret`,
      description: `Rovara Cloud ${env}: its secret as Rovara Code's sign-in client ${CLOUD_APP_CLIENT_ID}. Starts as a placeholder; put the secret Code shows once here.`,
      // A placeholder until the Code administrator's registration shows the real one; CloudFormation never regenerates it.
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const sessions = new efs.FileSystem(this, "Sessions", {
      vpc,
      vpcSubnets: isolated,
      encrypted: true,
      enableAutomaticBackups: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      // Cloud's sessions; deleting the stack must not delete them.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    sessions.connections.allowDefaultPortFrom(serviceAccess, "The Cloud task mounts its session files");
    // The image runs as the node user (uid and gid 1000); only it can read the files.
    const dataPoint = sessions.addAccessPoint("CloudData", {
      path: "/cloud",
      posixUser: { uid: "1000", gid: "1000" },
      createAcl: { ownerUid: "1000", ownerGid: "1000", permissions: "700" },
    });

    // Sign-ins: one item per login under a hash of its cookie (SIGNIN#<hash>), and sign-ins under way (PENDING#<state>),
    // deleted by DynamoDB after expiresAt. The key shape is Cloud's shared table's (CLOUD_TABLE in dynamo-stores.ts), so the
    // shared table can take these items over. Losing them only asks people to sign in again, so the table goes with the stack.
    const signIns = new dynamodb.Table(this, "SignIns", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });

    // Cluster.defaultCloudMapNamespace is `INamespace | undefined`, which exactOptionalPropertyTypes rejects for ICluster.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: cloudAppStackName(env) }) as ecs.ICluster;
    const task = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      volumes: [{
        name: "data",
        efsVolumeConfiguration: { fileSystemId: sessions.fileSystemId, transitEncryption: "ENABLED", authorizationConfig: { accessPointId: dataPoint.accessPointId, iam: "ENABLED" } },
      }],
    });
    sessions.grant(task.taskRole, "elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite");

    const sessionKey = signInKey(this, `Rovara Cloud ${env}: seals people's sign-ins (Code tokens) in the SignIns table`, task.taskRole);
    // Read, write and delete one sign-in by its key: no scan, no query.
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: [signIns.tableArn],
    }));
    // The client secret, read by the server itself when it calls Code's token endpoint.
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [clientSecret.secretArn] }));

    const balancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      vpcSubnets: isolated,
      internetFacing: false,
      securityGroup: balancerAccess,
      dropInvalidHeaderFields: true,
    });
    // Plain HTTP inside the VPC only: the HTTP API ends TLS at AWS's edge and reaches this through the VPC link.
    const listener = balancer.addListener("Http", { port: 80, protocol: elbv2.ApplicationProtocol.HTTP, open: false });

    const vpcLink = new apigwv2.VpcLink(this, "ApiLink", { vpc, subnets: isolated, securityGroups: [linkAccess] });
    const api = new apigwv2.HttpApi(this, "Api", {
      apiName: cloudAppStackName(env),
      description: `Rovara Cloud ${env}: the web app and Cloud's server`,
      defaultIntegration: new HttpAlbIntegration("Cloud", listener, { vpcLink }),
    });
    const origin = api.apiEndpoint;

    const container = task.addContainer("Cloud", {
      image: props.image ?? ecs.ContainerImage.fromAsset(resolve(process.cwd()), { file: "environments/cloud/Dockerfile", platform: Platform.LINUX_ARM64 }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "cloud", logGroup }),
      portMappings: [{ containerPort: CLOUD_APP_PORT }],
      readonlyRootFilesystem: true,
      environment: {
        PORT: String(CLOUD_APP_PORT),
        HOST: "0.0.0.0",
        CLOUD_ORIGIN: origin,
        ROVARA_CODE_URL: codeUrl.valueAsString,
        ROVARA_CLIENT_ID: CLOUD_APP_CLIENT_ID,
        ROVARA_SCOPES: CLOUD_APP_SCOPES.join(" "),
        CLOUD_ENVIRONMENT: env,
        AWS_REGION: this.region,
        CLOUD_SESSIONS_TABLE: signIns.tableName,
        CLOUD_SESSIONS_KEY_ID: sessionKey.keyArn,
        ROVARA_CLIENT_SECRET_ID: clientSecret.secretArn,
        CLOUD_WORK_SESSIONS_FILE: `${CLOUD_APP_DATA_PATH}/work-sessions.json`,
        // The file an older Cloud kept sign-ins in, under raw cookies: its sign-ins are revoked at Code and it is removed.
        CLOUD_LEGACY_SESSIONS_FILE: `${CLOUD_APP_DATA_PATH}/sessions.json`,
      },
    });
    container.addMountPoints({ containerPath: CLOUD_APP_DATA_PATH, sourceVolume: "data", readOnly: false });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      // Never two tasks writing the session files: a release stops the old task, then starts the new one.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceAccess],
      circuitBreaker: { rollback: true },
    });
    listener.addTargets("Cloud", {
      port: CLOUD_APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(10),
      // `/` answers a redirect to /app without asking Code anything.
      healthCheck: { path: "/", healthyHttpCodes: "200-399", interval: Duration.seconds(15) },
    });

    const callbackUrl = `${origin}${CLOUD_APP_CALLBACK_PATH}`;
    new CfnOutput(this, "CloudUrl", { value: `${origin}/app`, description: "Rovara Cloud's web app" });
    new CfnOutput(this, "CallbackUrl", { value: callbackUrl, description: "The redirect URL to register for Cloud on Rovara Code" });
    new CfnOutput(this, "ClientSecretName", { value: clientSecret.secretName, description: "Put the secret Code shows once at registration here" });
    new CfnOutput(this, "RegisterWithCode", {
      description: "Run once, as a Rovara Code administrator, then put the secret file's contents into ClientSecretName and restart the service",
      value: Fn.join("", [
        `npx @preplabsai/rovara-code admin sign-in-client add ${CLOUD_APP_CLIENT_ID} --name "Rovara Cloud" --audience ${CLOUD_APP_CLIENT_ID} --redirect `,
        callbackUrl,
        ` --confidential --full-access --scope ${CLOUD_APP_SCOPES.join(",")} --secret-file rovara-cloud-secret.txt`,
      ]),
    });
    new CfnOutput(this, "RestartCommand", {
      value: Fn.join("", ["aws ecs update-service --region ", this.region, " --cluster ", cluster.clusterName, " --service ", service.serviceName, " --force-new-deployment"]),
      description: "Restarts Cloud, so it reads a changed client secret at once (otherwise within five minutes)",
    });
  }
}
