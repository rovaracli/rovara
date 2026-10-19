// packages/broker/src/aws/developer-identity.ts
// The DeveloperIdentity Lambda (spec 025 phase 25a): wires the sign-in server to AWS. The only
// new role that reads the Slack secret (R2); it never logs a secret, and never repeats a secret's
// text in an error (a JSON parse error can quote it, so parse errors are replaced).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { singleOrgIdForEnv, type OrgId, type ChannelByNameRequest, type ChannelInfoRequest, type ChannelMembersRequest, type DeveloperSignInMethod, type EndDeveloperSessionsRequest, type SlackAuthCheckRequest, type SlackUserByEmailRequest, type TaskChannelPeopleRequest, type TaskPersonProofRequest } from "@agentx/contracts";
import { ProviderNotConfiguredError, oidcSignInProvider, slackSignInProvider, type SignInProvider } from "../developer/providers.js";
import { createDeveloperIdentityHandler, type DeveloperIdentityConfig } from "../developer/server.js";
import { slackDirectory } from "../developer/slack-directory.js";
import { DeveloperSignInStore, methodSince } from "../developer/store.js";
import { kmsTokenSigner } from "../developer/tokens.js";
import { ModelAccessInvoker } from "../model-proxy/invoker.js";
import { syncBudgets } from "../org/budget.js";
import { OrgStore } from "../org/store.js";
import type { HttpApiV2Event } from "./lambda.js";

const SECRET_CACHE_MS = 5 * 60 * 1000;
const SLACK_JWKS_URI = "https://slack.com/openid/connect/keys";
const DEFAULT_CLOUD_DISPLAY_NAME = "Rovara";

export type DeveloperIdentityLambdaConfig = DeveloperIdentityConfig & {
  oidcSettings?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues: string[] };
  /** Set instead of oidcSettings when the company sign-in settings are unusable. Only that method
   * then refuses ("not finished"); Slack sign-in, keys, refresh and the invoke keep working. */
  oidcProblem?: string;
  /** The hosted Rovara sign-in (DEVELOPER_CLOUD_*); it needs no required claim and creates an org on first sign-in. */
  cloudSettings?: { issuer: string; clientId: string };
  /** Set instead of cloudSettings when its settings are unusable; only the cloud method then refuses. */
  cloudProblem?: string;
};

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

export function developerIdentityConfigFromEnvironment(env: NodeJS.ProcessEnv): DeveloperIdentityLambdaConfig {
  const issuer = env.DEVELOPER_OIDC_ISSUER ?? "";
  const teamId = env.SLACK_TEAM_ID ?? "";
  const config: DeveloperIdentityLambdaConfig = {
    ...cloudConfigFromEnvironment(env),
    env: required(env, "AGENTX_ENV"),
    issuer: required(env, "DEVELOPER_TOKEN_ISSUER"),
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

let built: ReturnType<typeof createDeveloperIdentityHandler> | undefined;

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
  const oidc = oidcProvider();
  const cloud = cloudProvider();
  if (config.cloudProblem !== undefined) log({ event: "signin.not_configured", method: "cloud", detail: config.cloudProblem });
  if (config.oidcProblem !== undefined) log({ event: "signin.not_configured", method: "oidc", detail: config.oidcProblem });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } });
  const stateTableName = required(env, "STATE_TABLE_NAME");
  // Budgets reach the model proxy through its access function (ruling R28). Without MODEL_ACCESS_FUNCTION_NAME nothing is told
  // at sign-in, and the broker syncs lazily before the first key instead.
  const orgs = new OrgStore({ documentClient, tableName: stateTableName, now });
  const modelAccessFunction = env.MODEL_ACCESS_FUNCTION_NAME ?? "";
  const modelAccess = modelAccessFunction === "" ? undefined : new ModelAccessInvoker({ functionName: modelAccessFunction, lambda: new LambdaClient(region) });
  return createDeveloperIdentityHandler({
    config,
    store: new DeveloperSignInStore({
      documentClient,
      tableName: required(env, "DEVELOPER_SIGNIN_TABLE_NAME"),
      now,
    }),
    // Orgs and membership live in the State table, beside the records they scope; the sign-in table holds identities only.
    orgs,
    singleOrgId: singleOrgIdForEnv(config.env),
    ...(modelAccess === undefined ? {} : {
      onOrgJoined: ({ orgId, developerId }: { orgId: OrgId; developerId: string }) => syncBudgets({ documentClient, tableName: stateTableName, access: modelAccess, orgs }, orgId, [developerId]),
    }),
    signer: kmsTokenSigner({ kms: new KMSClient(region), keyId: required(env, "DEVELOPER_TOKEN_KEY_ARN") }),
    providers: {
      slack: slackSignInProvider({ teamId: config.slack.teamId, credentials: slackSecret, fetch, jwks: jwksFor(SLACK_JWKS_URI), now }),
      ...(oidc === undefined ? {} : { oidc }),
      ...(cloud === undefined ? {} : { cloud }),
    },
    directory: slackDirectory({
      teamId: config.slack.teamId, botToken: async () => (await slackSecret()).botToken, fetch, now,
      report: (problem) => log({ event: "signin.slack_problem", ...problem }),
    }),
    now,
    log,
  });
}

export const handler = async (event: HttpApiV2Event | ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest) => {
  built ??= build(process.env);
  return built(event);
};
