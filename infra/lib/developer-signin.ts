// Spec 025 phase 25a: the control plane as the developers' sign-in server. Named environments only
// (R3): the legacy deployment must not change.
import { ArnFormat, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";
import { packagedFunction } from "./control-plane.js";
import { CloudIdentity } from "./cloud-identity.js";

const SIGN_IN_ROUTE_KEY = "ANY /v1/auth/{proxy+}";
const DEV_ROUTE_KEY = "ANY /v1/dev/{proxy+}";
/** The hosted app's routes (`GET /v1/app/me`): authorizer-free like the dev routes, the broker verifies the developer token itself. */
const APP_ROUTE_KEY = "ANY /v1/app/{proxy+}";
const FEEDBACK_REVIEW_ROUTE_KEY = "ANY /review/{proxy+}";

export interface DeveloperSignInParameters {
  slackTeamId: CfnParameter; slack: CfnParameter; oidcIssuer: CfnParameter; oidcClientId: CfnParameter;
  oidcRequiredClaim: CfnParameter; oidcRequiredValues: CfnParameter; oidcDisplayName: CfnParameter;
  slackSince: CfnParameter; oidcSince: CfnParameter;
  taskPeopleChangesEnabled: CfnParameter; taskPeoplePublicInvitationsEnabled: CfnParameter; taskPeoplePrivateInvitationsEnabled: CfnParameter;
  workflowDependenciesEnabled: CfnParameter;
  /** Spec 025 E16: whether an admin may confirm a change in the AI tool's own pop-up. */
  mcpConfirmElicitation: CfnParameter;
}

/** Declared on the stack itself, so the parameter names are exactly these. */
export function developerSignInParameters(stack: Stack): DeveloperSignInParameters {
  return {
    slackTeamId: new CfnParameter(stack, "SlackTeamId", { type: "String", default: "", allowedPattern: "^$|^[TE][A-Z0-9]{2,31}$", description: "The Slack workspace (team) ID this environment serves; Slack sign-in is refused while it is empty" }),
    slack: new CfnParameter(stack, "DeveloperSignInSlack", { type: "String", default: "disabled", allowedValues: ["enabled", "disabled"], description: "enabled: developers may sign in with Slack; disabled: they may not" }),
    oidcIssuer: new CfnParameter(stack, "DeveloperOidcIssuer", { type: "String", default: "", allowedPattern: "^$|^https://\\S+$", description: "Company OIDC issuer URL for developer sign-in; empty turns company sign-in off" }),
    oidcClientId: new CfnParameter(stack, "DeveloperOidcClientId", { type: "String", default: "", maxLength: 256, description: "Client ID of the company OIDC app for developer sign-in" }),
    oidcRequiredClaim: new CfnParameter(stack, "DeveloperOidcRequiredClaim", { type: "String", default: "", maxLength: 128, description: "Claim a company sign-in must carry, for example groups; empty for none" }),
    oidcRequiredValues: new CfnParameter(stack, "DeveloperOidcRequiredValues", { type: "String", default: "[]", allowedPattern: "^\\[.*\\]$", description: "JSON string array; the required claim must contain one of these values" }),
    oidcDisplayName: new CfnParameter(stack, "DeveloperOidcDisplayName", { type: "String", default: "Company sign-in", minLength: 1, maxLength: 40, description: "Name on the company sign-in button, for example Okta" }),
    // FR-045: a session started before its method was last turned on was ended by that disable, so
    // it stays ended. agentx signin enable sets these; 0 means the method was never turned back on.
    slackSince: new CfnParameter(stack, "DeveloperSignInSlackSince", { type: "String", default: "0", allowedPattern: "^[0-9]{1,12}$", description: "When Slack sign-in was last turned on, in epoch seconds; Slack sessions started before it are refused" }),
    oidcSince: new CfnParameter(stack, "DeveloperOidcSince", { type: "String", default: "0", allowedPattern: "^[0-9]{1,12}$", description: "When company sign-in was last turned on, in epoch seconds; company sessions started before it are refused" }),
    taskPeopleChangesEnabled: new CfnParameter(stack, "TaskPeopleChangesEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people role changes are enabled in this environment" }),
    taskPeoplePublicInvitationsEnabled: new CfnParameter(stack, "TaskPeoplePublicInvitationsEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people may invite members to public channels in this environment" }),
    taskPeoplePrivateInvitationsEnabled: new CfnParameter(stack, "TaskPeoplePrivateInvitationsEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people may invite members to private channels in this environment" }),
    workflowDependenciesEnabled: new CfnParameter(stack, "WorkflowDependenciesEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether bounded serial task work breakdowns are enabled in this environment" }),
    mcpConfirmElicitation: new CfnParameter(stack, "McpConfirmElicitation", { type: "String", default: "enabled", allowedValues: ["enabled", "disabled"], description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button (or the CLI)" }),
  };
}

export interface DeveloperSignInProps {
  naming: AgentXNaming;
  env: string;
  api: apigwv2.CfnApi;
  brokerIntegration: apigwv2.CfnIntegration;
  broker: lambdaNodejs.NodejsFunction;
  /** The concrete Secret (F5): control-plane.ts passes a secretsmanager.Secret. */
  slackSecret: secretsmanager.Secret;
  parameters: DeveloperSignInParameters;
  /** The API's default stage, which throttles the public /v1/auth routes. */
  stage: apigwv2.CfnStage;
  /** The TurnRecords table (control-plane.ts), so the broker may write AI-tool audit records.
   * The concrete Table (as with slackSecret above): dynamodb.ITable's tableStreamArn is an
   * optional string, but Table's getter returns string | undefined, which this repo's
   * exactOptionalPropertyTypes rejects as an ITable. */
  turnRecords: dynamodb.Table;
  /** The State table, where orgs and membership live; sign-in puts a developer in an org and the tokens carry it. */
  state: dynamodb.Table;
  /** The hosted Rovara cloud (agentxCloud context): the self-serve Cognito sign-in is created here and wired to the sign-in function and the broker. */
  cloud?: boolean;
}

export class DeveloperSignIn extends Construct {
  /** Existing table, exposed without changing its construct path or permissions. */
  readonly table: dynamodb.Table;
  /** The cloud sign-in, when the agentxCloud context is on. */
  readonly cloud: CloudIdentity | undefined;

  constructor(scope: Construct, id: string, props: DeveloperSignInProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    const issuer = `${props.api.attrApiEndpoint}/v1/auth`;

    const table = this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retained: developer records and session history must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const tokenKey = new kms.Key(this, "TokenKey", {
      alias: props.naming.developerTokenKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} developer access tokens`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Access tokens live one hour, so nothing outlives the key for long.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The cloud sign-in's Cognito pool calls back to this server, so the construct needs its issuer.
    const cloud = props.cloud === true ? new CloudIdentity(this, "CloudIdentity", { env: props.env, signInIssuer: issuer }) : undefined;
    this.cloud = cloud;

    const oidcSecretName = `agentx/${props.env}/developer-oidc`;
    const fn = packagedFunction(this, "Function", "packages/broker/src/aws/developer-identity.ts", {
      AGENTX_ENV: props.env,
      DEVELOPER_TOKEN_ISSUER: issuer,
      DEVELOPER_SIGNIN_TABLE_NAME: table.tableName,
      STATE_TABLE_NAME: props.state.tableName,
      DEVELOPER_TOKEN_KEY_ARN: tokenKey.keyArn,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      SLACK_TEAM_ID: p.slackTeamId.valueAsString,
      DEVELOPER_SIGNIN_SLACK: p.slack.valueAsString,
      DEVELOPER_OIDC_ISSUER: p.oidcIssuer.valueAsString,
      DEVELOPER_OIDC_CLIENT_ID: p.oidcClientId.valueAsString,
      DEVELOPER_OIDC_REQUIRED_CLAIM: p.oidcRequiredClaim.valueAsString,
      DEVELOPER_OIDC_REQUIRED_VALUES: p.oidcRequiredValues.valueAsString,
      DEVELOPER_OIDC_DISPLAY_NAME: p.oidcDisplayName.valueAsString,
      DEVELOPER_OIDC_SECRET_ID: oidcSecretName,
      DEVELOPER_SIGNIN_SLACK_SINCE: p.slackSince.valueAsString,
      DEVELOPER_OIDC_SINCE: p.oidcSince.valueAsString,
      MCP_CONFIRM_ELICITATION: p.mcpConfirmElicitation.valueAsString,
      ...(cloud === undefined ? {} : {
        DEVELOPER_CLOUD_ISSUER: cloud.issuer,
        DEVELOPER_CLOUD_CLIENT_ID: cloud.clientId,
        DEVELOPER_CLOUD_SECRET_ID: cloud.secretName,
        DEVELOPER_CLOUD_DISPLAY_NAME: cloud.displayName,
        // Empty unless the GitHub OAuth app is configured (GitHubClientId); the function then reads its secret by id.
        DEVELOPER_GITHUB_CLIENT_ID: cloud.githubClientId.valueAsString,
        DEVELOPER_GITHUB_SECRET_ID: cloud.githubClientSecretArn.valueAsString,
      }),
    }, Duration.seconds(15));
    // Exactly what DeveloperSignInStore sends: GetItem, PutItem, UpdateItem, and TransactWriteItems
    // made of Put and Update items (IAM authorizes each item as PutItem or UpdateItem).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [table.tableArn],
    }));
    // Orgs and membership (OrgStore): the bare org partition (the org record and its member rows), the developer's org
    // pointer, the verified-email pointers that link one person's cloud sign-ins, the invites a sign-in accepts, and the
    // claim a GitHub account holds on its one free trial (unlockTrial, run when someone signs in with GitHub; cloud installs
    // only); never an org-scoped row. Its transactions are made of Put and Update items, which IAM authorizes as
    // PutItem and UpdateItem. The `?` matches one character each, the 20 of an org ID.
    const orgPattern = "org_????????????????????";
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}`, "DEVELOPER_ORG#*", "ORG_EMAIL#*", "ORG_INVITE#*", ...(cloud === undefined ? [] : ["TRIAL_GITHUB#*"])] } },
    }));
    // Healing a duplicate member (mergeDuplicateMember) touches exactly these further keys, each with only the action it uses.
    // A member's project grants (`ORG#<id>#MEMBER#<developer>`): copied to the survivor (PutItem), listed (Query), then removed (DeleteItem).
    // The org's budget settings (`ORG#<id>#SETTINGS`): read, and written back with the duplicate's override moved (GetItem, PutItem).
    // A race org (the leftover of two sign-ins of one person at once) is checked and closed: its whole partition and its project
    // catalog are listed (Query); the closing itself is an Update on the org record, already covered above, never a delete of it.
    // The duplicate's member row, in the bare org partition, and the developer's org pointer are deleted (DeleteItem). IAM leading keys
    // cannot tell the member row from the org record in that partition, so the DeleteItem grant reaches both; the code deletes only the
    // member row. A transaction's Delete is authorized as DeleteItem. No `ORG#*` wildcard, no scan, no other org-scoped row.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}#MEMBER#*`] } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}#SETTINGS`] } },
    }));
    // Accepting an invite checks, in the same transaction, that the org is not closed or closing (a ConditionCheck on the org record, which
    // IAM authorizes as ConditionCheckItem). That action on that one key; the function never reads or writes anything else through it.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:ConditionCheckItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}`] } },
    }));
    // A removed member's ban on a single-org install (`ORG#<id>#BAN`): read by a sign-in that would join the install's org (GetItem) and
    // cleared when an invite is accepted (DeleteItem, below). The function never writes a ban; only the broker's removal does.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}#BAN`] } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}#MEMBER#*`, `ORG#${orgPattern}`, `ORG#${orgPattern}#PROJECT_CATALOG`] } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DeleteItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`ORG#${orgPattern}#MEMBER#*`, `ORG#${orgPattern}`, `ORG#${orgPattern}#BAN`, "DEVELOPER_ORG#*"] } },
    }));
    tokenKey.grant(fn, "kms:Sign", "kms:GetPublicKey");
    tokenKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "SignAndGetPublicKeyOnlyAsDeveloperIdentity",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign", "kms:GetPublicKey"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": fn.role!.roleArn } },
    }));
    props.slackSecret.grantRead(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      // Secrets Manager appends "-" and six characters to a secret's name in its ARN.
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${oidcSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));

    // Only this function exchanges the cloud pool's authorization code, so only it may read the client secret.
    if (cloud !== undefined) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [cloud.secret.secretArn] }));
      // Likewise the GitHub client secret, and only when GitHub sign-in is configured (an empty ARN is not a valid resource, so the policy
      // itself is conditional). It is a separate policy on this function's role: no other function is granted it.
      const githubSecretRead = new iam.Policy(this, "GitHubSecretRead", {
        statements: [new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [cloud.githubClientSecretArn.valueAsString] })],
      });
      githubSecretRead.attachToRole(fn.role!);
      (githubSecretRead.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = cloud.githubEnabled;
    }

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0",
    });
    const authRoute = new apigwv2.CfnRoute(this, "AuthRoute", {
      apiId: props.api.ref, routeKey: SIGN_IN_ROUTE_KEY, target: `integrations/${integration.ref}`, authorizationType: "NONE",
    });
    fn.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/auth/*`,
    });

    // D17: no API Gateway JWT authorizer. One would fetch <api>/v1/auth's discovery document when it
    // is created, before this API exists, so a fresh install could never create it. The broker
    // verifies the developer access token itself (packages/broker/src/developer/verify-token.ts).
    const devRoute = new apigwv2.CfnRoute(this, "DevRoute", {
      apiId: props.api.ref, routeKey: DEV_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    const appRoute = new apigwv2.CfnRoute(this, "AppRoute", {
      apiId: props.api.ref, routeKey: APP_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    // The review page uses its own opaque, revocable session cookie and owner checks in the broker.
    const feedbackReviewRoute = new apigwv2.CfnRoute(this, "FeedbackReviewRoute", {
      apiId: props.api.ref, routeKey: FEEDBACK_REVIEW_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    // Public routes are stage-capped: bursts of 50, 20 requests a second on average,
    // across all callers. A developer signs in a few times a week, so this only bites a flood.
    const throttle = { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 };
    props.stage.routeSettings = { [SIGN_IN_ROUTE_KEY]: throttle, [DEV_ROUTE_KEY]: throttle, [APP_ROUTE_KEY]: throttle, [FEEDBACK_REVIEW_ROUTE_KEY]: throttle };
    // Route settings must name routes that already exist.
    props.stage.addDependency(authRoute);
    props.stage.addDependency(devRoute);
    props.stage.addDependency(appRoute);
    props.stage.addDependency(feedbackReviewRoute);

    const broker = props.broker;
    broker.addEnvironment("DEVELOPER_TOKEN_ISSUER", issuer);
    broker.addEnvironment("AGENTX_ENV", props.env);
    broker.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", table.tableName);
    broker.addEnvironment("DEVELOPER_IDENTITY_FUNCTION_ARN", fn.functionArn);
    broker.addEnvironment("SLACK_TEAM_ID", p.slackTeamId.valueAsString);
    broker.addEnvironment("DEVELOPER_SIGNIN_SLACK", p.slack.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_ISSUER", p.oidcIssuer.valueAsString);
    broker.addEnvironment("DEVELOPER_SIGNIN_SLACK_SINCE", p.slackSince.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_SINCE", p.oidcSince.valueAsString);
    broker.addEnvironment("MCP_CONFIRM_ELICITATION", p.mcpConfirmElicitation.valueAsString);
    // The broker reads only whether the cloud sign-in is configured (it then resolves orgs by membership, R6)
    // and where invite links point; the sign-in function holds the client settings and the secret.
    if (cloud !== undefined) {
      broker.addEnvironment("DEVELOPER_CLOUD_ISSUER", cloud.issuer);
      broker.addEnvironment("ROVARA_WEB_ORIGIN", cloud.webOrigin.valueAsString);
      // Whether GitHub tokens are accepted (developerClaims checks the method is on); the client id is not a secret, the secret stays with the sign-in function.
      broker.addEnvironment("DEVELOPER_GITHUB_CLIENT_ID", cloud.githubClientId.valueAsString);
    }
    fn.grantInvoke(broker);
    // Spec 025 25e: EMAIL# is the email index resolveDeveloper reads to name a developer by email.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*"] } },
    }));
    // GET /v1/app/me lists a developer's linked identities (DeveloperSignInStore.identitiesOf): a Query on the developer's own
    // partition, which holds one IDENTITY# row per linked sign-in beside the developer record.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] } },
    }));
    // The workflow E2E terminal authority transaction also condition-checks the original creator
    // record. Keep that cross-table fence to developer identity rows only.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:ConditionCheckItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        Null: { "dynamodb:LeadingKeys": "false" },
      },
    }));

    // FR-037, R27: the developer task routes write immutable AI-tool turn records, only under TASK#.
    // No update or delete: a record is written once with a condition and never changed.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [props.turnRecords.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } },
    }));
    // Spec 025 E3: admin change audit records, only under CHANGE#. Written once, then stepped forward
    // by the broker alone; no delete, and no route edits them (FR-051).
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
      resources: [props.turnRecords.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } },
    }));

    // The issuer the tokens carry and the broker checks, for operators and scripts to read.
    new CfnOutput(stack, "DeveloperSignInIssuer", { value: issuer });
  }
}
