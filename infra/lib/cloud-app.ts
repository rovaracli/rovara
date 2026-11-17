import {
  CfnOutput,
  CfnParameter,
  RemovalPolicy,
  Stack,
  type StackProps,
  Duration,
  Token,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { Construct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";
import { applyCloudBoundary } from "./cloud-boundary.js";

/**
 * Rovara Cloud's first address (owner decisions 2026-11-14): Cloud's web app and server on an existing Rovara Code install. Cloud has
 * no user pool, workers or Slack service of its own: people sign in through Code, as its sign-in client `rovara-cloud` (Code specs 063,
 * 065, 066), so anyone Code lets in can use Cloud.
 *
 * Cloud now runs on CloudFront, Lambda and DynamoDB (cloud-web.ts, PrepLabsAI/Rovara-cloud#11), with no gap on a release. This stack
 * keeps only its first address, so links and bookmarks to it still work: the same HTTP API answers every request with a 308 to the
 * same path at Cloud's address, from a small function. The single Fargate task, its VPC, load balancer and EFS are gone.
 *
 *   browser -> HTTP API (the first address) -> redirect function -> 308 to https://<cloudfront>/<same path and query>
 *
 * Kept outside this stack when the Fargate app went (removal policy RETAIN), to delete by hand once no longer needed: the EFS file
 * system that held Cloud's sessions (copied to the new table by PR 3, #37), the Fargate sign-ins' KMS key and its log group.
 *
 * Still made here: Cloud's client secret `rovara-cloud/<env>/code-client-secret`, unchanged, which cloud-web.ts reads by name. A new
 * environment gets it from this stack (the pipeline deploys both).
 */

export const CLOUD_APP_CONTEXT_KEY = "rovaraCloudApp";
/** The client ID Cloud signs in to Code as (Code's `admin sign-in-client add <id>`), and the audience its tokens carry. */
export const CLOUD_APP_CLIENT_ID = "rovara-cloud";
/** What Cloud asks to do as the signed-in person (Code spec 065): every scope Code has, as scripts/cloud-server.ts asks. */
export const CLOUD_APP_SCOPES = ["projects:members", "projects:create"] as const;
/** Where Code sends people back after sign-in: Cloud's server answers it (createCloudHandler's callbackPath). */
export const CLOUD_APP_CALLBACK_PATH = "/callback";
/** The KMS encryption context every sign-in's data key carries (packages/cloud-server/src/session-crypto.ts). */
export const CLOUD_SESSION_KEY_PURPOSE = "rovara-cloud-session";

/**
 * The key that seals sign-ins (packages/cloud-server/src/session-crypto.ts). The account may manage it but not use it: only
 * `server` may make and open data keys, and only for sign-ins (the encryption context). Retained, so a sealed sign-in is
 * never orphaned mid-release. Used by cloud-web.ts.
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
  /** Cloud's address (cloud-web.ts): every request to the first address is sent to the same path there. */
  readonly movedTo: string;
}

/** The redirect, inline: a function URL's or HTTP API's payload 2.0 in, a 308 to the same path and query at MOVED_TO out. */
export const REDIRECT_SOURCE = [
  "exports.handler = async (event) => ({",
  "  statusCode: 308,",
  "  headers: { location: process.env.MOVED_TO + event.rawPath + (event.rawQueryString ? \"?\" + event.rawQueryString : \"\"), \"cache-control\": \"no-store\" },",
  "  body: \"\",",
  "});",
].join("\n");

export class CloudAppStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudAppProps) {
    super(scope, id, props);
    const env = props.environmentName;
    // Validates the name at synth.
    environmentSettingsPrefix(env);
    // Known at synth only in tests; deployed it is CloudFront's domain, which the web stack makes.
    if (!Token.isUnresolved(props.movedTo) && !/^https:\/\/[^/\s]+$/u.test(props.movedTo)) throw new Error("movedTo must be an https address with no path");

    // Not used here: the pipeline passes CodeUrl to both stacks (--parameters CodeUrl=…), and CloudFormation refuses a parameter a
    // template doesn't declare ("Parameters: [CodeUrl] do not exist in the template", v0.10.1).
    new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "Not used by this stack: the pipeline passes it to every stack it deploys (cloud-web.ts uses it)",
    });

    // Unchanged from the Fargate app (the same id and settings), so production keeps its secret and a new environment gets one.
    new secretsmanager.Secret(this, "CodeClientSecret", {
      secretName: `${RESOURCE_PREFIX}/${env}/code-client-secret`,
      description: `Rovara Cloud ${env}: its secret as Rovara Code's sign-in client ${CLOUD_APP_CLIENT_ID}. Starts as a placeholder; put the secret Code shows once here.`,
      // A placeholder until the Code administrator's registration shows the real one; CloudFormation never regenerates it.
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const redirect = new lambda.Function(this, "Redirect", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      handler: "index.handler",
      code: lambda.Code.fromInline(REDIRECT_SOURCE),
      environment: { MOVED_TO: props.movedTo },
      logGroup: new logs.LogGroup(this, "RedirectLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      description: `Rovara Cloud ${env}: sends its first address to its current one`,
    });
    // The same HTTP API (the same logical id), so the first address stays the same.
    const api = new apigwv2.HttpApi(this, "Api", {
      apiName: cloudAppStackName(env),
      description: `Rovara Cloud ${env}: its first address, which sends people to its current one`,
      defaultIntegration: new HttpLambdaIntegration("Redirect", redirect),
    });

    new CfnOutput(this, "FirstUrl", { value: `${api.apiEndpoint}/app`, description: "Cloud's first address: it redirects to CloudUrl" });
    new CfnOutput(this, "CloudUrl", { value: `${props.movedTo}/app`, description: "Rovara Cloud's web app" });
    // Last, so the template keeps its section order; the aspect puts it on every role at synth (cloud-boundary.ts).
    applyCloudBoundary(this, env, "app");
  }
}
