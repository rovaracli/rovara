// Spec 025 phase 25a: the control plane as the developers' sign-in server. Named environments only
// (R3): the legacy deployment must not change.
import { ArnFormat, CfnOutput, CfnParameter, Duration, Fn, Lazy, RemovalPolicy, Stack, Token, aws_apigatewayv2 as apigwv2, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, type aws_lambda as lambda, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";
import { grantEditionRecordRead } from "./edition-env.js";
import { BrokerNames, BrokerSettings } from "./broker-names.js";
import { packagedFunction } from "./control-plane.js";
import { CloudIdentity } from "./cloud-identity.js";
import type { CustomDomain } from "./custom-domain.js";

const SIGN_IN_ROUTE_KEY = "ANY /v1/auth/{proxy+}";
const DEV_ROUTE_KEY = "ANY /v1/dev/{proxy+}";
/** The hosted app's routes (`GET /v1/app/me`): authorizer-free like the dev routes, the broker verifies the developer token itself. */
const APP_ROUTE_KEY = "ANY /v1/app/{proxy+}";
const FEEDBACK_REVIEW_ROUTE_KEY = "ANY /review/{proxy+}";
/** A session's link (Plan 5): `/s/<sessionId>`, served to a browser like the review pages (its own session cookie, the broker checks access). */
const SESSION_LINK_ROUTE_KEY = "ANY /s/{proxy+}";

export interface DeveloperSignInParameters {
  slackTeamId: CfnParameter; slack: CfnParameter; oidcIssuer: CfnParameter; oidcClientId: CfnParameter;
  oidcRequiredClaim: CfnParameter; oidcRequiredValues: CfnParameter; oidcDisplayName: CfnParameter;
  slackSince: CfnParameter; oidcSince: CfnParameter;
  taskPeopleChangesEnabled: CfnParameter; taskPeoplePublicInvitationsEnabled: CfnParameter; taskPeoplePrivateInvitationsEnabled: CfnParameter;
  workflowDependenciesEnabled: CfnParameter;
  /** Spec 025 E16: whether an admin may confirm a change in the AI tool's own pop-up. */
  mcpConfirmElicitation: CfnParameter;
  rovaraCodeV2Enabled: CfnParameter;
  /** Mainline #408: the plan self-check (a coding plan is checked, and the planner asked again once) and automatic fixing of blocked checks and reviews. On unless an operator turns them off. */
  planSelfCheckEnabled: CfnParameter;
  autofixEnabled: CfnParameter;
  /** Live steer: a person's message to a running step. "0" (the default) keeps every message a note; "1" turns it on. Turn it on only after the dispatcher, publisher, broker and the worker image carrying task.liveSteer.v1 are deployed. */
  liveSteerEnabled: CfnParameter;
  /** Stop & redirect: the owner (or a co-owner) stops a running step and gives a new instruction. "0" (the default) leaves the route off; "1" turns it on. Turn it on only after the dispatcher and the worker image carrying task.ownerRedirect.v1 are deployed, and the broker can ask a worker what it supports. */
  liveRedirectEnabled: CfnParameter;
  /** Live interaction A3: Ask about this task. "0" (the default) answers NOT_FOUND on every Ask route; "1" turns it on. Turn it on only after the chat service that carries the Ask route is deployed. */
  liveAskEnabled: CfnParameter;
  /** Live interaction F2 to F4: Fix with agent. "0" (the default) answers NOT_FOUND on every diagnosis route; "1" turns it on. Turn it on only after the chat service that carries the diagnosis route is deployed. */
  liveFixEnabled: CfnParameter;
  /** Proof and evidence: the evidence of a task's checks is gathered, kept and shown. "0" (the default) gathers, posts and serves nothing new; "1" turns it on. Turn it on only after the worker image that carries `task.evidenceCapture.v1` is deployed. */
  proofEvidenceEnabled: CfnParameter;
  /** Decision cards: "0" (the default) mounts no card route and answers no Slack card press; "1" turns them on. */
  decisionCardsEnabled: CfnParameter;
  /** Test environment: the project's approved test setup is proposed, proved, approved and used by tasks. "0" (the default) changes nothing; "1" turns it on. Turn it on only after the worker image that carries `task.testEnvDetect.v1` and `task.testEnvironment.v1` is deployed. */
  testEnvironmentEnabled: CfnParameter;
  /** Lessons reach the agent: approved lessons are loaded into an agent's prompt. "0" (the default) loads and sends none, even where the Team record is on; "1" turns it on. Separate from the Team record switch. */
  learnedLessonsEnabled: CfnParameter;
  /** Second review by a different AI company: an added second opinion on a task's code from a model of another company, in shadow (never blocks) and then on. "0" (the default) plans, runs and shows none; "1" turns it on. */
  secondReviewEnabled: CfnParameter;
  /** Saved environments: a project's proven setup is built into an image and used by tasks. "0" (the default) builds, pushes, pulls and sends nothing. */
  savedEnvEnabled: CfnParameter;
  /** Script tokens (UX5b): people make tokens in the app for their scripts and CI. "0" (the default): the routes are not found and every script token is refused. */
  scriptTokensEnabled: CfnParameter;
  designReviewEnabled: CfnParameter;
  /** Company setup recipes as a proposal source: approved company recipes are offered to a project's setup run, each value they add cited as the recipe's and still proved. "0" (the default) offers none; "1" turns it on. */
  setupRecipesEnabled: CfnParameter;
  /** Nightly health: the nightly run sets the project's health. "0" (the default) records and shows no health; "1" turns it on. */
  nightlyHealthEnabled: CfnParameter;
  /** Four test results: a task and its pull request say Verified, Code failed, Partially verified or Blocked by environment, the Fix setup card exists and the pull request has a Testing section. "0" (the default) changes nothing; "1" turns it on. */
  verifyResultsEnabled: CfnParameter;
  setupAgentEnabled: CfnParameter;
  testServicesEnabled: CfnParameter;
  testAccountsEnabled: CfnParameter;
  projectImagesEnabled: CfnParameter;
  /** v1.2 learning loop: whether a company that never chose gets suggested rules (the install-wide default of its master switch). Off unless an operator turns it on. */
  learningSuggestionsDefault: CfnParameter;
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
    rovaraCodeV2Enabled: new CfnParameter(stack, "RovaraCodeV2Enabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether Rovara Code version 2 (Understand, the plan check, parallel parts, merge tracking) is available in this environment: an admin may adopt it and new tasks of an org that did run it. Off unless an operator turns it on (agentx config set rovaraCode.v2 true)" }),
    planSelfCheckEnabled: new CfnParameter(stack, "PlanSelfCheckEnabled", { type: "String", default: "true", allowedValues: ["true", "false"], description: "Whether every coding plan is checked before the owner sees it, and the planner asked again once when the check finds a fixable problem (agentx config set planSelfCheck.enabled false turns it off; it also turns off checking the plan against the current app)" }),
    autofixEnabled: new CfnParameter(stack, "AutofixEnabled", { type: "String", default: "true", allowedValues: ["true", "false"], description: "Whether Rovara sends blocked checks or reviews back to coding by itself, before any pull request exists (agentx config set autofix.enabled false turns it off)" }),
    liveSteerEnabled: new CfnParameter(stack, "LiveSteerEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: a person's message to a running step is given to it live (only after the dispatcher, publisher, broker and worker image that carry live steer are deployed); 0: every message waits as a note for the next step (agentx config set liveSteer.enabled 1)" }),
    liveAskEnabled: new CfnParameter(stack, "LiveAskEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: Ask about this task is on (only after the chat service that carries the Ask route is deployed); 0: every Ask route answers not found (agentx config set liveAsk.enabled 1)" }),
    liveFixEnabled: new CfnParameter(stack, "LiveFixEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: Fix with agent is on (only after the chat service that carries the diagnosis route is deployed); 0: every diagnosis route answers not found (agentx config set liveFix.enabled 1)" }),
    proofEvidenceEnabled: new CfnParameter(stack, "ProofEvidenceEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: the evidence of a task's checks is gathered, kept and shown (only after the worker image that carries task.evidenceCapture.v1 is deployed); 0: nothing new is gathered, posted to a pull request or served (agentx config set proofEvidence.enabled 1)" }),
    decisionCardsEnabled: new CfnParameter(stack, "DecisionCardsEnabled", { type: "String", default: "1", allowedValues: ["0", "1"], description: "1: decision cards are on (the card routes and the Slack card press); 0: no card route exists and a Slack card press is answered as gone (agentx config set decisionCards.enabled 1)" }),
    testEnvironmentEnabled: new CfnParameter(stack, "TestEnvironmentEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: the project test environment is on (propose, prove, approve, and tasks use it; only after the worker image that carries task.testEnvDetect.v1 and task.testEnvironment.v1 is deployed); 0: nothing about test environments changes (agentx config set testEnvironment.enabled 1)" }),
    learnedLessonsEnabled: new CfnParameter(stack, "LearnedLessonsEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: approved lessons are loaded into an agent's prompt (only after the worker image that carries task.learnedContext.v1 is deployed; needs the Team record); 0: no lesson is loaded or sent to an agent, even where the Team record is on (agentx config set learnedLessons.enabled 1)" }),
    secondReviewEnabled: new CfnParameter(stack, "SecondReviewEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: an added second review by a model of a different AI company is on (a project or company chooses shadow or on; only after the worker image that runs the second review is deployed); 0: no second review is planned, run or shown (agentx config set secondReview.enabled 1)" }),
    setupRecipesEnabled: new CfnParameter(stack, "SetupRecipesEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: approved company setup recipes are offered to a project's setup run as a proposal source (each value they add is cited as the recipe's and is still proved and confirmed; only after the worker image that reads recipe offers is deployed); 0: no recipe is offered (agentx config set setupRecipes.enabled 1)" }),
    nightlyHealthEnabled: new CfnParameter(stack, "NightlyHealthEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: the nightly run sets the project's health (Setup needs repair, a Fix setup card, a start banner; needs the test environment); 0: no health is recorded or shown (agentx config set nightlyHealth.enabled 1)" }),
    verifyResultsEnabled: new CfnParameter(stack, "VerifyResultsEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: tasks and pull requests show one of four test results and a Testing section, and an environment fault opens a Fix setup card (only after the broker that carries the new auto-fix codes is deployed); 0: nothing about test results changes (agentx config set verifyResults.enabled 1)" }),
    savedEnvEnabled: new CfnParameter(stack, "SavedEnvEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: a project's proven setup can be built into a saved image and used by tasks (deploy the worker image and the registry roles first); 0: nothing is built, pushed, pulled or sent to a worker (agentx config set savedEnv.enabled 1)" }),
    scriptTokensEnabled: new CfnParameter(stack, "ScriptTokensEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: people can make script tokens in the app settings so their scripts and CI can read and start their own tasks; 0: no token can be made and every script token is refused (agentx config set scriptTokens.enabled 1)" }),
    designReviewEnabled: new CfnParameter(stack, "DesignReviewEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: fresh-context reviewers check the design of a Full task before a person approves it, but only where a company admin has allowed it and the project's mode is not Off (both are set in How we work); 0: no task has a design review, and a review already under way ends at its next step as not run (agentx config set designReview.enabled 1)" }),
    setupAgentEnabled: new CfnParameter(stack, "SetupAgentEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: Set up this project can start a live setup run that runs commands in a sandbox (turn on only after the five Linux checks of SH-1 pass and the worker image that carries task.setupAgent.v1 is deployed); 0: setup is the read-only draft, the prove run and the confirm card, as before" }),
    testServicesEnabled: new CfnParameter(stack, "TestServicesEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: a project's dependencies (databases, caches, queues, AWS services, outside APIs) get a backing for test runs on a sealed per-run network (turn on only after the Linux checks TS-L1 to TS-L6 pass and the worker image that carries the service runner is deployed); 0: today's flow, services are refused as before (agentx config set testServices.enabled 1)" }),
    testAccountsEnabled: new CfnParameter(stack, "TestAccountsEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: a project may use the customer's own test accounts for a dependency, each approved by a second admin (needs testServices.enabled; turn on only after the test-account proxy is deployed); 0: no test account is stored, approved or used (agentx config set testAccounts.enabled 1)" }),
    projectImagesEnabled: new CfnParameter(stack, "ProjectImagesEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: a project may bring its own images for a dependency (reviewed compose services, a model image); needs testServices.enabled; 0: only Rovara's image catalog is used (agentx config set projectImages.enabled 1)" }),
    learningSuggestionsDefault: new CfnParameter(stack, "LearningSuggestionsDefault", { type: "String", default: "off", allowedValues: ["on", "off"], description: "Whether a company that has not chosen gets suggested rules from Rovara's learning (on) or only has its corrections collected (off). A company's own choice always wins. Off unless an operator turns it on" }),
    liveRedirectEnabled: new CfnParameter(stack, "LiveRedirectEnabled", { type: "String", default: "0", allowedValues: ["0", "1"], description: "1: the task owner can stop a running step and redirect it with a new instruction (only after the dispatcher, broker and worker image that carry Stop & redirect are deployed); 0: the redirect route is off (agentx config set liveRedirect.enabled 1)" }),
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
  /** Further public routes of the same API the stage throttles like the /v1/auth, /v1/dev and /v1/app ones (the GitHub install routes). */
  throttledRoutes?: Array<{ route: apigwv2.CfnRoute; burst: number; rate: number }>;
  /** Plan 4 Task 19: the public event-hook route. It gets a bucket of its own, larger than the sign-in routes' (route settings are per route key, so it does not share `/v1/app`'s). */
  hookRoute?: apigwv2.CfnRoute;
  /** The TurnRecords table (control-plane.ts), so the broker may write AI-tool audit records.
   * The concrete Table (as with slackSecret above): dynamodb.ITable's tableStreamArn is an
   * optional string, but Table's getter returns string | undefined, which this repo's
   * exactOptionalPropertyTypes rejects as an ITable. */
  turnRecords: dynamodb.Table;
  /** The State table, where orgs and membership live; sign-in puts a developer in an org and the tokens carry it. */
  state: dynamodb.Table;
  /** The hosted Rovara cloud (agentxCloud context): the self-serve Cognito sign-in is created here and wired to the sign-in function and the broker. */
  cloud?: boolean;
  /** The optional custom domain (cloud installs): its name reaches the sign-in function and the broker, which then treat it as the canonical address and the API's own as the previous one. */
  customDomain?: CustomDomain;
}

export class DeveloperSignIn extends Construct {
  /** Existing table, exposed without changing its construct path or permissions. */
  readonly table: dynamodb.Table;
  /** The cloud sign-in, when the agentxCloud context is on. */
  readonly cloud: CloudIdentity | undefined;
  /** The sign-in function (DeveloperIdentity). The audit ledger gives it the outbox (Audit Ledger, Task 18), because it links and unlinks sign-in methods and accepts invites. */
  readonly signInFunction: lambdaNodejs.NodejsFunction;
  /** The developer token key. Only the sign-in function may sign with it; `allowPublicKeyRead` lets one more role read its public half (Plan 5 Task 8's realtime authorizer). */
  readonly tokenKey: kms.Key;
  private readonly publicKeyReaders: string[] = [];

  /** Lets `role` read the token key's public half (`kms:GetPublicKey`) past the key's own deny. It still cannot sign: only the sign-in function's role is exempt from the Sign deny. */
  allowPublicKeyRead(role: iam.IRole): void {
    this.publicKeyReaders.push(role.roleArn);
  }

  constructor(scope: Construct, id: string, props: DeveloperSignInProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    const issuer = `${props.api.attrApiEndpoint}/v1/auth`;
    // The broker function's name on a cloud install (Plan 3, Task 21a-wiring, hand-off 1), from the naming's one prefix. The sign-in function invokes the broker
    // (`decide-inspect`) and the broker already holds the sign-in function's ARN, so each cannot name the other by reference without a circular dependency:
    // the broker has a fixed name and the sign-in function names it as text, in its environment and in its one `lambda:InvokeFunction` statement.
    // A function with a custom name cannot be replaced by CloudFormation later: any change that needs a new broker function will fail until the name is changed first.
    const brokerFunctionName = `${props.naming.resourcePrefix}-broker`;

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

    const tokenKey = this.tokenKey = new kms.Key(this, "TokenKey", {
      alias: props.naming.developerTokenKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} developer access tokens`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Access tokens live one hour, so nothing outlives the key for long.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The cloud sign-in's Cognito pool calls back to this server, so the construct needs its issuer.
    const cloud = props.cloud === true ? new CloudIdentity(this, "CloudIdentity", { env: props.env, signInIssuer: issuer, ...(props.customDomain === undefined ? {} : { customDomain: props.customDomain }) }) : undefined;
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
      // 0.5.7: the custom domain's name ("" when none). DEVELOPER_TOKEN_ISSUER above stays the API's own address; with a name the function
      // serves that address as its own issuer too, and the custom name as the canonical one (developer-identity.ts).
      ...(props.customDomain === undefined ? {} : { DEVELOPER_CUSTOM_DOMAIN: props.customDomain.name.valueAsString }),
      ...(cloud === undefined ? {} : {
        DEVELOPER_CLOUD_ISSUER: cloud.issuer,
        DEVELOPER_CLOUD_CLIENT_ID: cloud.clientId,
        DEVELOPER_CLOUD_SECRET_ID: cloud.secretName,
        DEVELOPER_CLOUD_DISPLAY_NAME: cloud.displayName,
        // Plan 3, Task 21a-presence: the pool the decide flow creates and reads email-code users in (AdminCreateUser, AdminGetUser).
        DEVELOPER_CLOUD_USER_POOL_ID: cloud.userPoolId,
        // Empty unless the GitHub OAuth app is configured (GitHubClientId); the function then reads its secret by id.
        DEVELOPER_GITHUB_CLIENT_ID: cloud.githubClientId.valueAsString,
        DEVELOPER_GITHUB_SECRET_ID: cloud.githubClientSecretArn.valueAsString,
        // Plan 2, Task 8: the email that tells an account a new sign-in method was linked to it goes out from the cloud sign-in's SES sender.
        // All three are empty unless both CloudSignInEmailFrom and CloudSignInEmailSourceArn are set (no sender: no notice). SES identities are
        // regional, so the function sends in the region of the sender's identity ARN (arn:aws:ses:<region>:...). The ":::" keeps Fn::Select in range
        // even for the empty default, so nothing depends on how CloudFormation orders the evaluation of Fn::If's branches.
        DEVELOPER_NOTICE_EMAIL_FROM: Token.asString(Fn.conditionIf(cloud.emailFromSes.logicalId, cloud.emailFrom.valueAsString, "")),
        DEVELOPER_NOTICE_EMAIL_REGION: Token.asString(Fn.conditionIf(cloud.emailFromSes.logicalId, Fn.select(3, Fn.split(":", Fn.join("", [cloud.emailSourceArn.valueAsString, ":::"]))), "")),
        ROVARA_WEB_ORIGIN: cloud.webOrigin.valueAsString,
        // Plan 3, Task 21a-wiring: who may decide an approval is the broker's question; the decide flow invokes it by this name.
        DECIDE_INSPECT_FUNCTION_NAME: brokerFunctionName,
      }),
    }, Duration.seconds(15));
    this.signInFunction = fn;
    // What DeveloperSignInStore sends on every sign-in: GetItem, PutItem, UpdateItem, and TransactWriteItems
    // made of Put and Update items (IAM authorizes each item as PutItem or UpdateItem).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [table.tableArn],
    }));
    // Plan 2, Task 8: unlinking a sign-in method (unlinkIdentity, the `unlink-identity` invoke). It lists the developer's own IDENTITY# items
    // (Query on `DEVELOPER#<id>`) and, in one transaction, deletes the one it removes (a transaction's Delete is authorized as DeleteItem; the
    // same transaction's Put and Update are the table-wide grants above). Both stay inside the developer partitions; nothing else is deleted
    // or listed, and the broker gets neither (its sign-in table policy stays reads and the developer-partition Query).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DeleteItem"], resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"], resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] } },
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
    // Plan 3, Task 11: a merge also leaves one marker in the sparse `MEMBER_MERGE_QUEUE` partition (ids and the org only), in the same transaction.
    // The broker lists the partition, moves what the duplicate owned and deletes the marker. This function only writes it: PutItem, never a read,
    // a list, an update or a delete (a transaction's Put is authorized as PutItem).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MEMBER_MERGE_QUEUE"] } },
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
      sid: "SignOnlyAsDeveloperIdentity",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": fn.role!.roleArn } },
    }));
    // The public half is public; besides the sign-in function, the roles `allowPublicKeyRead` names may read it (the realtime authorizer, Plan 5 Task 8).
    tokenKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "GetPublicKeyOnlyAsDeveloperIdentityAndTokenVerifiers",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:GetPublicKey"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": Lazy.list({ produce: () => [fn.role!.roleArn, ...this.publicKeyReaders] }) } },
    }));
    props.slackSecret.grantRead(fn);
    // Enterprise foundations I-2: the sign-in server checks its edition stamp against the install's retained edition record before it serves.
    grantEditionRecordRead(fn, props.env);
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
      // The notice of a newly linked sign-in method (Plan 2, Task 8): ses:SendEmail on the sender's SES identity and nothing else (the Simple
      // content of SESv2 SendEmail needs no ses:SendRawEmail, and no configuration set is used), and only when that sender is configured:
      // an empty ARN is not a valid resource, so the policy itself is conditional, as with the GitHub secret above.
      const noticeSend = new iam.Policy(this, "IdentityNoticeSend", {
        statements: [new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: [cloud.emailSourceArn.valueAsString] })],
      });
      noticeSend.attachToRole(fn.role!);
      (noticeSend.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = cloud.emailFromSes;
      // Plan 3, Task 21a-presence (R66, R67, R6-2): decisions need a person present. The fresh sign-in's server-side state, the session it
      // makes, and the decide tickets and rate counters live in this table under their own prefixes (developer/decide-session.ts), each
      // narrowed by leading keys. The function needs no more than this on them: the state is written, read and spent (Delete); the session
      // is written, and ended when a newer sign-in replaces it (the broker reads, claims and ends it too); tickets and counters are read, written and counted (Put, Update).
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DECIDE_STATE#*"] } },
      }));
      // The session is written once; a new sign-in also ends the session the browser held before (DeleteItem on that one cookie's hash).
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DECIDE_SESSION#*"] } },
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DECIDE_TICKET#*", "DECIDE_RATE#*"] } },
      }));
      // Plan 3, Task 21a-wiring (hand-off 1): the decide flow asks the broker whether a member may decide an approval (`decide-inspect`, a direct invoke).
      // One statement: that action on the broker function's ARN, built from its fixed name (no qualifier, no wildcard). The broker needs no new grant.
      (props.broker.node.defaultChild as lambda.CfnFunction).functionName = brokerFunctionName;
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [stack.formatArn({ service: "lambda", resource: "function", resourceName: brokerFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }));
      // A member who has only ever signed in with GitHub gets an email-code user in the cloud pool (R6-2): created, or an existing one read
      // before it is linked. Those two actions on this pool's ARN, nothing else in Cognito.
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"], resources: [cloud.userPoolArn] }));
      // Plan 2, Task 14: the broker emails an org's owners when a GitHub organization is connected because its GitHub admin approved a request
      // (sendGithubConnectedNotice). The same sender, so the same grant: ses:SendEmail on the sender's SES identity and nothing else, in a policy
      // of its own that exists only under the same condition, and the same two settings (the sender and the region of its identity ARN).
      // Both are empty with no sender, and the broker then sends nothing.
      const brokerNoticeSend = new iam.Policy(this, "BrokerGithubConnectedNoticeSend", {
        statements: [new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: [cloud.emailSourceArn.valueAsString] })],
      });
      brokerNoticeSend.attachToRole(props.broker.role!);
      (brokerNoticeSend.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = cloud.emailFromSes;
      props.broker.addEnvironment("DEVELOPER_NOTICE_EMAIL_FROM", Token.asString(Fn.conditionIf(cloud.emailFromSes.logicalId, cloud.emailFrom.valueAsString, "")));
      props.broker.addEnvironment("DEVELOPER_NOTICE_EMAIL_REGION", Token.asString(Fn.conditionIf(cloud.emailFromSes.logicalId, Fn.select(3, Fn.split(":", Fn.join("", [cloud.emailSourceArn.valueAsString, ":::"]))), "")));
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
    const webRoute = new apigwv2.CfnRoute(this, "WebRoute", { apiId: props.api.ref, routeKey: "ANY /v1/web/{proxy+}", target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE" });
    props.broker.addPermission("WebApiInvoke", { principal: new iam.ServicePrincipal("apigateway.amazonaws.com"), sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/web/*` });
    // The review page uses its own opaque, revocable session cookie and owner checks in the broker.
    const feedbackReviewRoute = new apigwv2.CfnRoute(this, "FeedbackReviewRoute", {
      apiId: props.api.ref, routeKey: FEEDBACK_REVIEW_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    const sessionLinkRoute = new apigwv2.CfnRoute(this, "SessionLinkRoute", {
      apiId: props.api.ref, routeKey: SESSION_LINK_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    // Public routes are stage-capped: bursts of 50, 20 requests a second on average,
    // across all callers. A developer signs in a few times a week, so this only bites a flood.
    const throttle = { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 };
    const throttledRoutes = [...(props.throttledRoutes ?? []), { route: webRoute, burst: 400, rate: 200 }];
    props.stage.routeSettings = {
      [SIGN_IN_ROUTE_KEY]: throttle, [DEV_ROUTE_KEY]: throttle, [APP_ROUTE_KEY]: throttle, [FEEDBACK_REVIEW_ROUTE_KEY]: throttle, [SESSION_LINK_ROUTE_KEY]: throttle,
      ...Object.fromEntries(throttledRoutes.map(({ route, burst, rate }) => [route.routeKey, { ThrottlingBurstLimit: burst, ThrottlingRateLimit: rate }])),
      ...(props.hookRoute === undefined ? {} : { [props.hookRoute.routeKey]: { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 } }),
    };
    // Route settings must name routes that already exist.
    props.stage.addDependency(authRoute);
    props.stage.addDependency(devRoute);
    props.stage.addDependency(appRoute);
    props.stage.addDependency(feedbackReviewRoute);
    props.stage.addDependency(sessionLinkRoute);
    for (const { route } of throttledRoutes) props.stage.addDependency(route);
    if (props.hookRoute !== undefined) props.stage.addDependency(props.hookRoute);

    const broker = props.broker;
    // The sign-in issuer is the API's address plus /v1/auth: the broker is given the API's id (in its names) and builds the URL.
    BrokerNames.of(broker).add("signInApi", props.api.ref);
    // 0.5.7: the custom domain's name ("" when none), a packed setting; the broker then takes it as the canonical address and the API's own as the previous issuer.
    if (props.customDomain !== undefined) BrokerSettings.of(broker).add("customDomain", props.customDomain.name.valueAsString);
    broker.addEnvironment("AGENTX_ENV", props.env);
    // The table and the function by name, in the broker's names (BrokerNames; its variables are held to Lambda's 4 KB). Lambda's Invoke takes a name.
    const brokerNames = BrokerNames.of(broker);
    brokerNames.add("signInTable", table.tableName);
    brokerNames.add("identityFunction", fn.functionName);
    // The constrained parameters (a Slack team id pattern, allowed lists, digit patterns) are the broker's settings (BrokerSettings: one JSON variable, as its names are; Lambda's 4 KB).
    // The issuer URL is free text, so it stays a variable of its own.
    const brokerSettings = BrokerSettings.of(broker);
    brokerSettings.add("slackTeamId", p.slackTeamId.valueAsString);
    brokerSettings.add("signInSlack", p.slack.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_ISSUER", p.oidcIssuer.valueAsString);
    brokerSettings.add("signInSlackSince", p.slackSince.valueAsString);
    brokerSettings.add("oidcSince", p.oidcSince.valueAsString);
    brokerSettings.add("mcpConfirmElicitation", p.mcpConfirmElicitation.valueAsString);
    // The broker reads only whether the cloud sign-in is configured (it then resolves orgs by membership, R6)
    // and where invite links point; the sign-in function holds the client settings and the secret.
    if (cloud !== undefined) {
      // The pool's id, in the broker's names: the broker builds the issuer URL from it (a URL of 70 to 100 bytes against the id's 20).
      BrokerNames.of(broker).add("cloudUserPool", cloud.userPoolId);
      broker.addEnvironment("ROVARA_WEB_ORIGIN", cloud.webOrigin.valueAsString);
      // Whether GitHub tokens are accepted (developerClaims checks the method is on); the client id is not a secret, the secret stays with the sign-in function.
      BrokerSettings.of(broker).add("developerGithubClientId", cloud.githubClientId.valueAsString);
      // Plan 3, Task 21a-presence (PF9): the confirmation page's session is read, claimed once (UpdateItem) and ended (DeleteItem) by the
      // broker; a ticket for a token's member is minted with PutItem, and its counters and "one live ticket" pointer with UpdateItem. Each
      // statement is narrowed to its own prefixes by leading keys; nothing else on the sign-in table is added.
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DECIDE_SESSION#*"] } },
      }));
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DECIDE_TICKET#*", "DECIDE_RATE#*"] } },
      }));
    }
    fn.grantInvoke(broker);
    // Spec 025 25e: EMAIL# is the email index resolveDeveloper reads to name a developer by email. Plan 2, Task 13: SIGNIN_IDENTITY# is
    // the forward link "which developer is this sign-in" (DeveloperSignInStore.developerForIdentity), which the GitHub connect callback
    // reads to check that the GitHub user is the developer who started the connect. Read only.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*", "SIGNIN_IDENTITY#*"] } },
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
    new CfnOutput(stack, "DeveloperSignInIssuer", { value: props.customDomain === undefined ? issuer : props.customDomain.issuer() });
  }
}
