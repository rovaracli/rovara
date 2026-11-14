// The hosted setup page: the questions `rovara init --setup-table --setup-url` asks a person, served by a Lambda function behind
// an HTTP API, with a DynamoDB table (and its own KMS key) between the page and the job that runs init
// (packages/cli/src/init/ui/setup-*.ts). The Launch in AWS installer (installer.ts) uses it.
//
// The resources are made directly in the given scope, under the ids the installer has always had, so the installer's
// template is unchanged.
import {
  Aws, Duration, RemovalPolicy,
  aws_apigatewayv2 as apigwv2,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  type aws_lambda_nodejs as lambdaNodejs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { RESOURCE_PREFIX } from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";

export interface SetupPageProps {
  /** The environment the page sets up (rovara-cloud-<name>-* stacks); a token is fine. */
  readonly installName: string;
  /** The HTTP API's name. */
  readonly apiName: string;
  /** The KMS key's description. */
  readonly keyDescription: string;
}

export interface SetupPageResources {
  readonly key: kms.Key;
  readonly table: dynamodb.Table;
  readonly page: lambdaNodejs.NodejsFunction;
  readonly api: apigwv2.CfnApi;
  /** The page's address (the API's endpoint), what init takes as --setup-url. */
  readonly url: string;
}

export function setupPage(scope: Construct, props: SetupPageProps): SetupPageResources {
  // The table's own key: it also seals the admin's sign-in on its way to the job.
  const key = new kms.Key(scope, "SetupKey", {
    description: props.keyDescription,
    enableKeyRotation: true,
    removalPolicy: RemovalPolicy.DESTROY,
    pendingWindow: Duration.days(7),
  });
  const table = new dynamodb.Table(scope, "SetupTable", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: key,
    timeToLiveAttribute: "expiresAt",
    // Holds only what passes between the page and the job while init runs.
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const page = packagedFunction(scope, "SetupPage", "packages/cli/src/init/ui/setup-lambda.ts", {
    SETUP_TABLE: table.tableName,
    INSTALL_NAME: props.installName,
    SETUP_KEY_ID: key.keyArn,
  }, Duration.seconds(20));
  table.grantReadWriteData(page);
  key.grant(page, "kms:Encrypt");
  page.addToRolePolicy(new iam.PolicyStatement({
    actions: ["cloudformation:DescribeStacks"],
    resources: [`arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/${RESOURCE_PREFIX}-${props.installName}-identity/*`],
  }));
  const api = new apigwv2.CfnApi(scope, "SetupApi", { name: props.apiName, protocolType: "HTTP" });
  const integration = new apigwv2.CfnIntegration(scope, "SetupIntegration", {
    apiId: api.ref, integrationType: "AWS_PROXY", integrationUri: page.functionArn, payloadFormatVersion: "2.0",
  });
  new apigwv2.CfnRoute(scope, "SetupRoute", { apiId: api.ref, routeKey: "$default", target: `integrations/${integration.ref}` });
  new apigwv2.CfnStage(scope, "SetupStage", { apiId: api.ref, stageName: "$default", autoDeploy: true });
  page.addPermission("SetupApiInvoke", {
    principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    sourceArn: `arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${api.ref}/*`,
  });
  return { key, table, page, api, url: api.attrApiEndpoint };
}
