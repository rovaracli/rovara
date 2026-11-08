// packages/broker/src/aws/developer-identity.ts
// The DeveloperIdentity Lambda (spec 025 phase 25a): wires the sign-in server to AWS. The only
// new role that reads the Slack secret (R2); it never logs a secret, and never repeats a secret's
// text in an error (a JSON parse error can quote it, so parse errors are replaced).
import { linkGithubMember, unlinkGithubMember } from "../rovara-code/github-members.js";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { singleOrgIdForEnv, type OrgId, type ChannelByNameRequest, type ChannelClassRequest, type ChannelListRequest, type MemberChannelsRequest, type ChannelInfoRequest, type ChannelMembersRequest, type DeveloperSignInMethod, type EndDeveloperSessionsRequest, type EraseDeveloperNameRequest, type RealtimeTokenRequest, type SlackAuthCheckRequest, type SlackUserByEmailRequest, type TaskChannelPeopleRequest, type TaskPersonProofRequest, type StartIdentityLinkRequest, type UnlinkIdentityRequest } from "@agentx/contracts";
import { DecideStore } from "../developer/decide-session.js";
import { brokerDecideKinds, lambdaInspectInvoker } from "../developer/decide-inspect.js";
import type { DecideKinds } from "../developer/decide-kinds.js";
import { auditRuntimeFromEnvironment } from "../audit/runtime.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { ProviderNotConfiguredError, githubSignInProvider, oidcSignInProvider, samlSignInProvider, slackSignInProvider, type SignInProvider } from "../developer/providers.js";
import { samlServiceProviderAddresses } from "../developer/saml.js";
import { createDeveloperIdentityHandler, type DeveloperIdentityConfig } from "../developer/server.js";
import { slackDirectory } from "../developer/slack-directory.js";
import { DeveloperSignInStore, methodSince } from "../developer/store.js";
import { kmsTokenSigner } from "../developer/tokens.js";
import { ModelAccessInvoker } from "../model-proxy/invoker.js";
import { syncBudgets } from "../org/budget.js";
import { duplicateMerger } from "../org/merge-members.js";
import { OrgStore } from "../org/store.js";
import { unlockTrial } from "../org/trial.js";
import { developerIssuers } from "../developer/custom-domain.js";
import { trialAvailable } from "../org/trial-availability.js";
import { createEditionGuard, editionBackupName, editionRecordName, installEditionPolicy, ssmEditionRecordReader } from "./broker/edition-wiring.js";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ssoStoresFor } from "../developer/sso-sign-in.js";
import type { HttpApiV2Event } from "./lambda.js";

const SECRET_CACHE_MS = 5 * 60 * 1000;
const SLACK_JWKS_URI = "https://slack.com/openid/connect/keys";
const DEFAULT_CLOUD_DISPLAY_NAME = "Rovara";
const GITHUB_DISPLAY_NAME = "GitHub";

export type DeveloperIdentityLambdaConfig = DeveloperIdentityConfig & {
  oidcSettings?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues: string[] };
  /** Set instead of oidcSettings when the company sign-in settings are unusable. Only that method
   * then refuses ("not finished"); Slack sign-in, keys, refresh and the invoke keep working. */
  oidcProblem?: string;
  /** The hosted Rovara sign-in (DEVELOPER_CLOUD_*); it needs no required claim and creates an org on first sign-in. */
  cloudSettings?: { issuer: string; clientId: string };
  /** Set instead of cloudSettings when its settings are unusable; only the cloud method then refuses. */
  cloudProblem?: string;
  /** Sign up and sign in with GitHub (DEVELOPER_GITHUB_*): set only with the cloud method, a client id and a secret id. */
  githubSettings?: { clientId: string };
};

/**
 * Who may decide `apr_` and `spr_` now is the BROKER's question (Plan 3, Task 21a-wiring, hand-off 1): the sign-in function's kinds invoke it
 * (`decide-inspect`) and fail closed on any error. With no broker function named (`DECIDE_INSPECT_FUNCTION_NAME`), every approval is "not found",
 * so nothing can be decided.
 */
export function decideKindsFromEnvironment(env: NodeJS.ProcessEnv, lambda: { send(command: unknown, options?: unknown): Promise<unknown> }): DecideKinds {
  const brokerFunction = env.DECIDE_INSPECT_FUNCTION_NAME ?? "";
  return brokerFunction === "" ? {} : brokerDecideKinds({ invoke: lambdaInspectInvoker(lambda, brokerFunction) });
}

/** Reads the given environment (F1: never process.env directly), so it can be tested. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredValuesFrom(text: string | undefined): string[] {
  const invalid = () => new Error("DEVELOPER_OIDC_REQUIRED_VALUES must be a JSON array of strings");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === undefined || text === "" ? "[]" : text);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw invalid();
  return parsed.filter((value) => value !== "");
}

function sinceFrom(text: string | undefined): { since: number } | Record<string, never> {
  const since = methodSince(text);
  return since === undefined ? {} : { since };
}

/** The cloud method's share of the configuration: nothing when DEVELOPER_CLOUD_ISSUER is unset. */
function cloudConfigFromEnvironment(env: NodeJS.ProcessEnv): Pick<DeveloperIdentityLambdaConfig, "cloud" | "cloudSettings" | "cloudProblem"> {
  const issuer = env.DEVELOPER_CLOUD_ISSUER ?? "";
  if (issuer === "") return {};
  const cloud = { displayName: env.DEVELOPER_CLOUD_DISPLAY_NAME || DEFAULT_CLOUD_DISPLAY_NAME };
  const clientId = env.DEVELOPER_CLOUD_CLIENT_ID ?? "";
  if (clientId === "") return { cloud, cloudProblem: "DEVELOPER_CLOUD_CLIENT_ID is not set; ask an admin to check the cloud sign-in settings" };
  return { cloud, cloudSettings: { issuer, clientId } };
}

/**
 * The GitHub method's share of the configuration (Task 22): it exists only on a cloud install (DEVELOPER_CLOUD_ISSUER) with both a
 * client id and the id of the secret holding the client secret. Anything less leaves it absent, so it is not offered and is refused.
 */
function githubConfigFromEnvironment(env: NodeJS.ProcessEnv): Pick<DeveloperIdentityLambdaConfig, "github" | "githubSettings"> {
  if ((env.DEVELOPER_CLOUD_ISSUER ?? "") === "") return {};
  const clientId = env.DEVELOPER_GITHUB_CLIENT_ID ?? "";
  if (clientId === "" || (env.DEVELOPER_GITHUB_SECRET_ID ?? "") === "") return {};
  return { github: { displayName: GITHUB_DISPLAY_NAME }, githubSettings: { clientId } };
}

/** The canonical issuer, and the API's own as `legacyIssuer` when a custom domain is set (DEVELOPER_CUSTOM_DOMAIN): one function, two addresses. */
function issuersOf(env: NodeJS.ProcessEnv): Pick<DeveloperIdentityLambdaConfig, "issuer" | "legacyIssuer"> {
  const { issuer, previousIssuer } = developerIssuers(required(env, "DEVELOPER_TOKEN_ISSUER"), env.DEVELOPER_CUSTOM_DOMAIN);
  return { issuer, ...(previousIssuer === undefined ? {} : { legacyIssuer: previousIssuer }) };
}

export function developerIdentityConfigFromEnvironment(env: NodeJS.ProcessEnv): DeveloperIdentityLambdaConfig {
  const issuer = env.DEVELOPER_OIDC_ISSUER ?? "";
  const teamId = env.SLACK_TEAM_ID ?? "";
  const config: DeveloperIdentityLambdaConfig = {
    ...cloudConfigFromEnvironment(env),
    ...githubConfigFromEnvironment(env),
    env: required(env, "AGENTX_ENV"),
    ...issuersOf(env),
    slack: { enabled: env.DEVELOPER_SIGNIN_SLACK === "enabled", ...(teamId === "" ? {} : { teamId }), ...sinceFrom(env.DEVELOPER_SIGNIN_SLACK_SINCE) },
    // Spec 025 E16: absent means the pop-up is allowed; only named environments set it.
    ...(env.MCP_CONFIRM_ELICITATION === "disabled" ? { confirmElicitation: false } : {}),
  };
  if (issuer === "") return config;
  const withOidc = { ...config, oidc: { displayName: env.DEVELOPER_OIDC_DISPLAY_NAME || "Company sign-in", ...sinceFrom(env.DEVELOPER_OIDC_SINCE) } };
  const problem = (text: string) => ({ ...withOidc, oidcProblem: `${text}; ask an admin to run agentx signin enable oidc` });
  const clientId = env.DEVELOPER_OIDC_CLIENT_ID ?? "";
  if (clientId === "") return problem("DEVELOPER_OIDC_CLIENT_ID is not set");
  const requiredClaim = env.DEVELOPER_OIDC_REQUIRED_CLAIM ?? "";
  let requiredValues: string[];
  try {
    requiredValues = requiredValuesFrom(env.DEVELOPER_OIDC_REQUIRED_VALUES);
  } catch (error) {
    return problem((error as Error).message);
  }
  if (requiredValues.length > 0 && requiredClaim === "") return problem("DEVELOPER_OIDC_REQUIRED_VALUES is set but DEVELOPER_OIDC_REQUIRED_CLAIM is empty");
  return { ...withOidc, oidcSettings: { issuer, clientId, ...(requiredClaim === "" ? {} : { requiredClaim }), requiredValues } };
}

/** A provider an admin has not finished setting up: every call says so, with what to fix. */
export function unconfiguredProvider(method: DeveloperSignInMethod, message: string): SignInProvider {
  const refuse = () => Promise.reject(new ProviderNotConfiguredError(message));
  return { method, authorizeUrl: refuse, complete: refuse };
}

function parseSecretObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderNotConfiguredError(`the ${what} is not valid JSON; ask an admin to run agentx signin check`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderNotConfiguredError(`the ${what} is not a JSON object; ask an admin to run agentx signin check`);
  }
  return value as Record<string, unknown>;
}

/** F25: a secret without a bot token means an admin has not finished setting Slack up. */
export function parseSlackSignInSecret(json: string): { botToken: string; clientId?: string; clientSecret?: string } {
  const value = parseSecretObject(json, "Slack secret");
  if (typeof value.botToken !== "string" || !value.botToken.startsWith("xoxb-")) {
    throw new ProviderNotConfiguredError("the Slack secret has no bot token yet; ask an admin to run agentx signin check");
  }
  return {
    botToken: value.botToken,
    ...(typeof value.clientId === "string" && value.clientId !== "" ? { clientId: value.clientId } : {}),
    ...(typeof value.clientSecret === "string" && value.clientSecret !== "" ? { clientSecret: value.clientSecret } : {}),
  };
}

function parseClientSecret(json: string, what: string, fix: string): string {
  const secret = parseSecretObject(json, what).clientSecret;
  if (typeof secret !== "string" || secret === "") throw new ProviderNotConfiguredError(`the ${what} has no clientSecret; ${fix}`);
  return secret;
}

export const parseOidcClientSecret = (json: string): string => parseClientSecret(json, "company sign-in secret", "ask an admin to run agentx signin enable oidc");
export const parseGithubClientSecret = (json: string): string => parseClientSecret(json, "GitHub sign-in secret", "ask an admin to check the GitHub sign-in settings");
export const parseCloudClientSecret = (json: string): string => parseClientSecret(json, "cloud sign-in secret", "ask an admin to check the cloud sign-in settings");

/** One remote key set per URI, so jose's key cache and refetch cooldown apply across sign-ins. */
export function remoteJwksCache(create: (url: URL) => JWTVerifyGetKey = (url) => createRemoteJWKSet(url)): (uri: string) => JWTVerifyGetKey {
  const cache = new Map<string, JWTVerifyGetKey>();
  return (uri) => {
    let jwks = cache.get(uri);
    if (jwks === undefined) {
      jwks = create(new URL(uri));
      cache.set(uri, jwks);
    }
    return jwks;
  };
}

function cachedSecret<T>(client: SecretsManagerClient, secretId: string, parse: (text: string) => T): () => Promise<T> {
  let cached: { value: Promise<T>; at: number } | undefined;
  return () => {
    if (cached === undefined || Date.now() - cached.at > SECRET_CACHE_MS) {
      const value = client.send(new GetSecretValueCommand({ SecretId: secretId })).then((response) => parse(response.SecretString ?? ""));
      cached = { value, at: Date.now() };
      value.catch(() => { cached = undefined; });
    }
    return cached.value;
  };
}

/**
 * The org a Slack or company sign-in joins, which only a single-org install has (ruling R3). A cloud install has none (ruling R51): there
 * is no shared system org, so those sign-ins are refused ("Sign in with Rovara on this install") and only the cloud method makes accounts.
 */
export function singleOrgIdFor(config: { env: string; cloud?: unknown }): OrgId | undefined {
  return config.cloud === undefined ? singleOrgIdForEnv(config.env) : undefined;
}

/**
 * The two stores the sign-in function reads and writes with. With a ledger (`audit`), a sign-in method linked or unlinked and an invite
 * accepted add their audit item to the transaction that does them (Task 18); without one they write what they always did.
 */
export function developerIdentityStores(input: { documentClient: DynamoDBDocumentClient; stateTableName: string; signInTableName: string; now: () => number; audit?: AuditRuntime }): { orgs: OrgStore; store: DeveloperSignInStore } {
  const audit = input.audit === undefined ? {} : { audit: input.audit };
  return {
    // SLACK-LINK-1: each store names the other's table, so a company join and an identity link fence each other in their own transactions.
    orgs: new OrgStore({ documentClient: input.documentClient, tableName: input.stateTableName, signInTableName: input.signInTableName, now: input.now, ...audit }),
    store: new DeveloperSignInStore({ documentClient: input.documentClient, tableName: input.signInTableName, stateTableName: input.stateTableName, now: input.now, ...audit }),
  };
}

let built: ReturnType<typeof createDeveloperIdentityHandler> | undefined;
/** Enterprise foundations I-2: the stamp checked against the install's retained edition record before the first request. */
let editionGuard: (() => Promise<void>) | undefined;

function build(env: NodeJS.ProcessEnv): ReturnType<typeof createDeveloperIdentityHandler> {
  const region = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const config = developerIdentityConfigFromEnvironment(env);
  const secrets = new SecretsManagerClient(region);
  const slackSecret = cachedSecret(secrets, required(env, "SLACK_SECRET_ARN"), parseSlackSignInSecret);
  const now = () => Date.now();
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
  const jwksFor = remoteJwksCache();
  const oidcSettings = config.oidcSettings;
  const oidcSecretId = env.DEVELOPER_OIDC_SECRET_ID ?? "";
  const oidcProvider = (): SignInProvider | undefined => {
    if (config.oidc === undefined) return undefined;
    if (config.oidcProblem !== undefined) return unconfiguredProvider("oidc", config.oidcProblem);
    if (oidcSettings === undefined || oidcSecretId === "") return unconfiguredProvider("oidc", "DEVELOPER_OIDC_SECRET_ID is not set; ask an admin to run agentx signin enable oidc");
    return oidcSignInProvider({ ...oidcSettings, clientSecret: cachedSecret(secrets, oidcSecretId, parseOidcClientSecret), fetch, jwksFor, now });
  };
  const cloudSecretId = env.DEVELOPER_CLOUD_SECRET_ID ?? "";
  const cloudProvider = (): SignInProvider | undefined => {
    if (config.cloud === undefined) return undefined;
    if (config.cloudProblem !== undefined) return unconfiguredProvider("cloud", config.cloudProblem);
    if (config.cloudSettings === undefined || cloudSecretId === "") return unconfiguredProvider("cloud", "DEVELOPER_CLOUD_SECRET_ID is not set; ask an admin to check the cloud sign-in settings");
    return oidcSignInProvider({ method: "cloud", ...config.cloudSettings, requiredValues: [], clientSecret: cachedSecret(secrets, cloudSecretId, parseCloudClientSecret), fetch, jwksFor, now });
  };
  const githubSecretId = env.DEVELOPER_GITHUB_SECRET_ID ?? "";
  const githubProvider = (): SignInProvider | undefined => {
    if (config.githubSettings === undefined) return undefined;
    return githubSignInProvider({ ...config.githubSettings, clientSecret: cachedSecret(secrets, githubSecretId, parseGithubClientSecret), fetch, now });
  };
  const oidc = oidcProvider();
  const cloud = cloudProvider();
  const github = githubProvider();
  if ((env.DEVELOPER_GITHUB_CLIENT_ID ?? "") !== "" && github === undefined) log({ event: "signin.not_configured", method: "github", detail: "GitHub sign-in needs the cloud sign-in and DEVELOPER_GITHUB_SECRET_ID; it is off" });
  if (config.cloudProblem !== undefined) log({ event: "signin.not_configured", method: "cloud", detail: config.cloudProblem });
  if (config.oidcProblem !== undefined) log({ event: "signin.not_configured", method: "oidc", detail: config.oidcProblem });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } });
  const stateTableName = required(env, "STATE_TABLE_NAME");
  // Budgets reach the model proxy through its access function (ruling R28). Without MODEL_ACCESS_FUNCTION_NAME nothing is told
  // at sign-in, and the broker syncs lazily before the first key instead.
  const audit = auditRuntimeFromEnvironment(env, { component: "developer-identity", now });
  const { orgs, store } = developerIdentityStores({
    documentClient, stateTableName, signInTableName: required(env, "DEVELOPER_SIGNIN_TABLE_NAME"), now,
    ...(audit === undefined ? {} : { audit }),
  });
  const modelAccessFunction = env.MODEL_ACCESS_FUNCTION_NAME ?? "";
  const modelAccess = modelAccessFunction === "" ? undefined : new ModelAccessInvoker({ functionName: modelAccessFunction, lambda: new LambdaClient(region) });
  const singleOrg = singleOrgIdFor(config);
  // Enterprise foundations E2/E3: the edition from the deploy stamp, read once; the hosted cloud method is the cross-check, as in the broker.
  const editionPolicy = installEditionPolicy(env, config.cloud !== undefined);
  editionGuard = createEditionGuard({ stamp: editionPolicy?.edition, recordName: editionRecordName(config.env), backupName: editionBackupName(config.env), read: ssmEditionRecordReader(new SSMClient(region)), log });
  const ssoStores = ssoStoresFor({ documentClient, tableName: stateTableName, policy: editionPolicy });
  // Enterprise foundations I4: SAML sign-in exists only where the edition has company sign-in; it stays off until an administrator saves and enables the identity provider's settings.
  const saml = ssoStores === undefined ? undefined : samlSignInProvider({
    sp: samlServiceProviderAddresses(config.issuer), orgId: singleOrg, load: (orgId) => ssoStores.saml.config.get(orgId), replay: ssoStores.saml.replay, stash: ssoStores.saml.stash, now,
  });
  // Plan 2, Task 8: the notice of a newly linked sign-in method goes out through the cloud sign-in's SES sender (empty: no sender, no notice).
  // SES identities are regional, so the client sends in the region of the sender's identity ARN when the stack names one.
  const noticeFrom = env.DEVELOPER_NOTICE_EMAIL_FROM ?? "";
  const noticeRegion = env.DEVELOPER_NOTICE_EMAIL_REGION || env.AWS_REGION;
  const notice = {
    ses: noticeFrom === "" ? undefined : new SESv2Client(noticeRegion === undefined ? {} : { region: noticeRegion }),
    from: noticeFrom === "" ? undefined : noticeFrom,
    cellUrl: env.ROVARA_WEB_ORIGIN || new URL(config.issuer).origin,
  };
  // Plan 3, Task 21a: the decide flow (`/v1/auth/decide/*`) exists on a cloud install that names its pool; its kinds ask the broker (decideKindsFromEnvironment).
  const userPoolId = env.DEVELOPER_CLOUD_USER_POOL_ID ?? "";
  const decide = config.cloud === undefined || config.cloudSettings === undefined || userPoolId === "" ? undefined : {
    store: new DecideStore({ documentClient, tableName: required(env, "DEVELOPER_SIGNIN_TABLE_NAME"), now }),
    kinds: decideKindsFromEnvironment(env, new LambdaClient(region)),
    cloudIssuer: config.cloudSettings.issuer.replace(/\/+$/, ""),
    cognito: { client: new CognitoIdentityProviderClient(region), userPoolId },
  };
  return createDeveloperIdentityHandler({
    config,
    store,
    notice,
    ...(editionPolicy === undefined ? {} : { editionPolicy }),
    // Enterprise foundations I1: the group mapping and the break-glass list, built once for this process; and the ledger a break-glass sign-in is recorded in.
    ...(ssoStores === undefined ? {} : { sso: ssoStores }),
    ...(saml === undefined ? {} : { saml }),
    ...(audit === undefined ? {} : { audit }),
    ...(decide === undefined ? {} : { decide }),
    // A duplicate member of one person (from before identity links) is merged into the member their email names, in one transaction over both tables.
    ...duplicateMerger({
      documentClient, tableName: stateTableName, signInStore: store, now,
      ...(audit === undefined ? {} : { audit }),
      ...(modelAccess === undefined ? {} : { orgSpentUsd: async (orgId: OrgId) => (await modelAccess.orgSpend(orgId)).spentUsd }),
    }),
    // Orgs and membership live in the State table, beside the records they scope; the sign-in table holds identities only.
    orgs,
    ...(singleOrg === undefined ? {} : { singleOrgId: singleOrg }),
    // Signing in with GitHub opens a trial org (unlockTrial): it claims the GitHub account for the org in the State table.
    // Rovara Code (Plan 6 Task 14): the member's GitHub account is linked in their org, both ways, so an approval on GitHub can be told from a requester's. Best effort and first, so a
    // trial that cannot unlock still links; a failure is the sign-in's log, never its refusal.
    ...(github === undefined ? {} : {
      onGithubSignIn: async (input: { orgId: OrgId; githubUserId: string; developerId: string }) => {
        await linkGithubMember({ documentClient, tableName: stateTableName, now }, input.orgId, input.developerId, input.githubUserId).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "developer-identity", event: "github_member.link_failed", error: error instanceof Error ? error.name : "unknown" }));
        });
        if (trialAvailable(editionPolicy)) await unlockTrial({ documentClient, tableName: stateTableName, now }, { orgId: input.orgId, githubUserId: input.githubUserId });
      },
      onGithubUnlinked: async (input: { orgId: OrgId; developerId: string }) => { await unlinkGithubMember({ documentClient, tableName: stateTableName, now }, input.orgId, input.developerId); },
    }),
    ...(modelAccess === undefined ? {} : {
      onOrgJoined: ({ orgId, developerId }: { orgId: OrgId; developerId: string }) => syncBudgets({ documentClient, tableName: stateTableName, access: modelAccess, orgs, cloud: config.cloud !== undefined }, orgId, [developerId]),
    }),
    signer: kmsTokenSigner({ kms: new KMSClient(region), keyId: required(env, "DEVELOPER_TOKEN_KEY_ARN") }),
    providers: {
      slack: slackSignInProvider({ teamId: config.slack.teamId, credentials: slackSecret, fetch, jwks: jwksFor(SLACK_JWKS_URI), now }),
      ...(oidc === undefined ? {} : { oidc }),
      ...(cloud === undefined ? {} : { cloud }),
      ...(github === undefined ? {} : { github }),
      ...(saml === undefined ? {} : { saml }),
    },
    directory: slackDirectory({
      teamId: config.slack.teamId, botToken: async () => (await slackSecret()).botToken, fetch, now,
      report: (problem) => log({ event: "signin.slack_problem", ...problem }),
    }),
    now,
    log,
  });
}

export const handler = async (event: HttpApiV2Event | ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | ChannelClassRequest | ChannelListRequest | MemberChannelsRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | EraseDeveloperNameRequest | UnlinkIdentityRequest | StartIdentityLinkRequest | ChannelByNameRequest | RealtimeTokenRequest) => {
  built ??= build(process.env);
  await editionGuard?.();
  return built(event);
};
