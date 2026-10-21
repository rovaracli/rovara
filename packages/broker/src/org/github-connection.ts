// Plan 2, Task 13: an org connects its own GitHub App installation (Rovara Cloud). `agentx github connect` makes a one-use state bound to
// the org owner or admin who started it; GitHub sends their browser back with a user authorization code. The callback proves who is
// there (the GitHub account linked to the starting developer) and that they manage the installation's account (the account itself, or an
// admin of the GitHub organization), then shows "Connect <account> to <org>?". Only the confirmation, from the same browser, binds.
//
// Secrets: the state, the confirmation token, the authorization code and the GitHub user token are never logged and never stored raw
// (the first two as SHA-256 only); the user token lives inside one callback and is revoked before it returns.
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError,
  githubConnectStateKey,
  githubInstallationEverBoundKey,
  githubInstallationKey,
  orgGithubInstallationKey,
  orgMemberKey,
  orgMetaKey,
  type GithubInstallationRecord,
  type OrgId,
  type OrgRecord,
  type OrgRole,
} from "@agentx/contracts";
import type { GitHubInstallation } from "../github-app.js";
import { ownerKeyForSubject } from "../aws/lambda.js";

/** What the callback and the confirmation need of the GitHub App provider. */
export interface GithubConnectApp {
  appSlug(): Promise<string>;
  oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined>;
  installation(id: number): Promise<GitHubInstallation>;
}

export interface GithubConnectionDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** A Rovara Cloud install. Anything else connects GitHub through the administrator (agentx init), and these routes refuse. */
  cloud: boolean;
  /** This cell's origin (scheme and host), which a confirmation's Origin header must equal. */
  origin: string;
  app: GithubConnectApp;
  /** Which developer a sign-in identity belongs to (an unlinked identity belongs to none), and the identities a developer has. */
  identities: {
    developerForIdentity(identityKey: string): Promise<string | undefined>;
    identitiesOf(developerId: string): Promise<Array<{ provider: string }>>;
    getDeveloper(developerId: string): Promise<{ provider: string; issuer: string } | undefined>;
  };
  orgs: { getOrg(orgId: OrgId): Promise<OrgRecord | undefined> };
  /** Plan 1 Task 19: opens the org's trial for this GitHub account; TRIAL_GITHUB_USED when the account already opened another org's. */
  unlockTrial: (input: { orgId: OrgId; githubUserId: string }) => Promise<void>;
  fetch?: typeof fetch;
  /** Event names, ids and error names only. */
  log?: (entry: Record<string, unknown>) => void;
}

export type ConnectOutcomeName = "confirm" | "requested" | "not_linked" | "not_yours" | "taken" | "expired";
export interface ConnectOutcome {
  outcome: ConnectOutcomeName;
  orgName?: string;
  accountLogin?: string;
  /** With `confirm`: the connect attempt's id, which the confirm form posts back (the state's SHA-256). */
  connectId?: string;
  /** With `confirm`: set in the `__Host-rovara_gh_connect` cookie, never in the page. */
  confirmToken?: string;
}
export type ConfirmOutcomeName = "connected" | "connected_trial_used" | "cancelled" | "taken" | "expired";
export interface ConfirmOutcome { outcome: ConfirmOutcomeName; orgName?: string; accountLogin?: string }

export const GITHUB_CONNECT_COOKIE = "__Host-rovara_gh_connect";
const CONNECT_COOKIE_MAX_AGE_SECONDS = 600;
const STATE_TTL_MS = 900_000;
/** The state item stays this long past its expiry before DynamoDB's time to live may remove it. */
const STATE_RETENTION_SECONDS = 86_400;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,14}$/;
const USER_INSTALLATION_PAGES = 10;
const GITHUB_TIMEOUT_MS = 8_000;
const GITHUB_ISSUER = "https://github.com";
const NOT_LINKED_START_MESSAGE = "sign in to Rovara with GitHub once (agentx login, then choose GitHub), then run agentx github connect again";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** The Set-Cookie value that carries the confirmation token to the confirm page's form post, and only to this host. */
export const connectCookie = (token: string) => `${GITHUB_CONNECT_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${CONNECT_COOKIE_MAX_AGE_SECONDS}`;
/** The Set-Cookie value that removes it. */
export const clearedConnectCookie = () => `${GITHUB_CONNECT_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

interface PendingBinding {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  status: "active" | "suspended";
  githubUserId: string;
}

interface ConnectStateItem {
  orgId: OrgId;
  developerId: string;
  expiresAt: number;
  consumedAt?: number;
  callbackAt?: number;
  confirmHash?: string;
  pending?: PendingBinding;
}

function log(deps: GithubConnectionDependencies, entry: Record<string, unknown>): void {
  (deps.log ?? ((line) => { console.log(JSON.stringify({ component: "broker", ...line })); }))(entry);
}

const conditionFailed = (error: unknown) => errorName(error) === "ConditionalCheckFailedException";

function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => { if (reason?.Code === "ConditionalCheckFailed") failed.add(index); });
  return failed;
}

async function readState(deps: GithubConnectionDependencies, stateHash: string): Promise<ConnectStateItem | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubConnectStateKey(stateHash), ConsistentRead: true })) as { Item?: ConnectStateItem };
  return response.Item;
}

/** Single use: marks the state consumed. False when it was consumed already (or is gone), which the caller treats as expired. */
async function consumeState(deps: GithubConnectionDependencies, stateHash: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: githubConnectStateKey(stateHash),
      UpdateExpression: "SET consumedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(consumedAt)",
      ExpressionAttributeValues: { ":now": deps.now() },
    }));
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

const isOwnerOrAdmin = (role: OrgRole) => role === "owner" || role === "admin";

/**
 * `POST /v1/app/github/connect`: starts a connect for the caller's org. Only an owner or admin of a cloud org, who has signed in with
 * GitHub once (so the callback can recognise them), gets an install link; the link's state is theirs alone.
 */
export async function startGithubConnect(
  deps: GithubConnectionDependencies,
  caller: { developerId: string; orgId: OrgId; orgRole: OrgRole },
): Promise<{ installUrl: string; expiresAt: string }> {
  if (!deps.cloud) throw agentXError("FORBIDDEN", "on this install, GitHub is connected by the administrator during agentx init");
  if (!isOwnerOrAdmin(caller.orgRole)) throw agentXError("FORBIDDEN", "only an owner or admin can connect GitHub");
  if (!await hasLinkedGithubIdentity(deps, caller.developerId)) throw agentXError("FORBIDDEN", NOT_LINKED_START_MESSAGE);
  // The callback cannot exchange a code without the App's OAuth client: say so now rather than after a person installed the App.
  if (await deps.app.oauthClient() === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub connection is not set up on this install yet; ask the Rovara operator");
  const slug = await deps.app.appSlug();
  const state = randomBytes(32).toString("base64url");
  const now = deps.now();
  const expiresAt = now + STATE_TTL_MS;
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: {
      ...githubConnectStateKey(sha256Hex(state)), entityType: "GITHUB_CONNECT", orgId: caller.orgId, developerId: caller.developerId,
      createdAt: new Date(now).toISOString(), expiresAt, indexExpiresAt: Math.floor(expiresAt / 1000) + STATE_RETENTION_SECONDS,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  log(deps, { event: "github.connect_started", orgId: caller.orgId });
  return { installUrl: `https://github.com/apps/${slug}/installations/new?state=${state}`, expiresAt: new Date(expiresAt).toISOString() };
}

/** A GitHub identity linked to the developer; a developer from before identity links is recognised by their own record (see developerForIdentity). */
async function hasLinkedGithubIdentity(deps: GithubConnectionDependencies, developerId: string): Promise<boolean> {
  if ((await deps.identities.identitiesOf(developerId)).some((identity) => identity.provider === "github")) return true;
  const own = await deps.identities.getDeveloper(developerId);
  return own !== undefined && own.provider === "github" && own.issuer === GITHUB_ISSUER;
}

type Verdict = { kind: "ok"; pending: PendingBinding } | { kind: "not_linked" | "not_yours" | "taken" | "failed"; accountLogin?: string };

/**
 * `GET /v1/github/install/callback`. Never binds. In order: the state is open; a request (a non-owner asking an admin) ends here; the user
 * code is exchanged; that GitHub user is the developer who started this; the installation is one that user can reach; the user owns the
 * installation's account or is an admin of its organization; no other org holds it. Only then does it ask the person to confirm.
 */
export async function completeGithubConnect(
  deps: GithubConnectionDependencies,
  query: { code?: string | undefined; installation_id?: string | undefined; setup_action?: string | undefined; state?: string | undefined },
): Promise<ConnectOutcome> {
  const expired: ConnectOutcome = { outcome: "expired" };
  if (!deps.cloud || typeof query.state !== "string" || !STATE_PATTERN.test(query.state)) return expired;
  const stateHash = sha256Hex(query.state);
  const state = await readState(deps, stateHash);
  // A state that reached the confirm page (callbackAt) is used: a second callback with it is a replay.
  if (state === undefined || state.consumedAt !== undefined || state.callbackAt !== undefined || state.expiresAt <= deps.now()) return expired;
  const org = await deps.orgs.getOrg(state.orgId);
  if (org === undefined || org.closedAt !== undefined || org.closingAt !== undefined) {
    await consumeState(deps, stateHash);
    return expired;
  }
  if (query.setup_action === "request") {
    await consumeState(deps, stateHash);
    log(deps, { event: "github.connect_requested", orgId: state.orgId });
    return { outcome: "requested", orgName: org.name };
  }
  const installationId = typeof query.installation_id === "string" && INSTALLATION_ID_PATTERN.test(query.installation_id) ? Number(query.installation_id) : undefined;
  const code = typeof query.code === "string" && query.code !== "" && query.code.length <= 512 ? query.code : undefined;
  const client = installationId === undefined || code === undefined ? undefined : await deps.app.oauthClient();
  if (installationId === undefined || code === undefined || client === undefined) {
    await consumeState(deps, stateHash);
    log(deps, { event: "github.connect_refused", orgId: state.orgId, reason: client === undefined && installationId !== undefined && code !== undefined ? "no_oauth_client" : "incomplete_callback" });
    return expired;
  }

  let token: string | undefined;
  let verdict: Verdict;
  try {
    token = await exchangeCode(deps, client, code);
    verdict = token === undefined ? { kind: "failed" } : await verify(deps, state, org, installationId, token);
  } catch (error) {
    log(deps, { event: "github.connect_failed", orgId: state.orgId, error: errorName(error) });
    verdict = { kind: "failed" };
  } finally {
    // On every path that exchanged a code, and whatever was decided: the user token is used by nothing after this.
    if (token !== undefined) await revokeUserToken(deps, client, token);
  }

  if (verdict.kind !== "ok") {
    await consumeState(deps, stateHash);
    log(deps, { event: "github.connect_refused", orgId: state.orgId, installationId, reason: verdict.kind });
    return { outcome: verdict.kind === "failed" ? "expired" : verdict.kind, orgName: org.name, ...(verdict.accountLogin === undefined ? {} : { accountLogin: verdict.accountLogin }) };
  }

  const confirmToken = randomBytes(32).toString("base64url");
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: githubConnectStateKey(stateHash),
      UpdateExpression: "SET pending = :pending, confirmHash = :hash, callbackAt = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(consumedAt) AND attribute_not_exists(confirmHash) AND expiresAt > :now",
      ExpressionAttributeValues: { ":pending": verdict.pending, ":hash": sha256Hex(confirmToken), ":now": deps.now() },
    }));
  } catch (error) {
    // Another callback with the same state got here first, or the state ran out meanwhile.
    if (conditionFailed(error)) return expired;
    throw error;
  }
  log(deps, { event: "github.connect_awaiting_confirmation", orgId: state.orgId, installationId });
  return { outcome: "confirm", orgName: org.name, accountLogin: verdict.pending.accountLogin, connectId: stateHash, confirmToken };
}

const userHeaders = (token: string) => ({
  accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rovara-github-connect", "x-github-api-version": "2022-11-28",
});

function github(deps: GithubConnectionDependencies, url: string, init: RequestInit = {}): Promise<Response> {
  return (deps.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS), ...init });
}

/** The user access token for a code, or undefined when GitHub refused it (it answers a bad or used code with HTTP 200 and an error body). */
async function exchangeCode(deps: GithubConnectionDependencies, client: { clientId: string; clientSecret: string }, code: string): Promise<string | undefined> {
  const response = await github(deps, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "rovara-github-connect" },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code }).toString(),
  });
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's token exchange failed with HTTP ${response.status}`);
  const body = await response.json().catch(() => undefined) as { access_token?: unknown } | undefined;
  return typeof body?.access_token === "string" && body.access_token !== "" ? body.access_token : undefined;
}

/** DELETE /applications/{client_id}/token: best effort, once. A failure is logged by name and never stops the answer. */
async function revokeUserToken(deps: GithubConnectionDependencies, client: { clientId: string; clientSecret: string }, token: string): Promise<void> {
  try {
    const response = await github(deps, `https://api.github.com/applications/${encodeURIComponent(client.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "rovara-github-connect", "x-github-api-version": "2022-11-28",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ access_token: token }),
    });
    if (!response.ok && response.status !== 404) log(deps, { event: "github.connect_token_revoke_failed", status: response.status });
  } catch (error) {
    log(deps, { event: "github.connect_token_revoke_failed", error: errorName(error) });
  }
}

async function userGet(deps: GithubConnectionDependencies, token: string, path: string): Promise<Response> {
  return github(deps, `https://api.github.com${path}`, { headers: userHeaders(token) });
}

async function verify(deps: GithubConnectionDependencies, state: ConnectStateItem, org: OrgRecord, installationId: number, token: string): Promise<Verdict> {
  // C2: this GitHub user is the developer who started the connect (linked to them), not just someone with the link.
  const userResponse = await userGet(deps, token, "/user");
  if (!userResponse.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's user lookup failed with HTTP ${userResponse.status}`);
  const user = await userResponse.json().catch(() => undefined) as { id?: unknown } | undefined;
  if (typeof user?.id !== "number" || !Number.isSafeInteger(user.id) || user.id < 1) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub's answer names no account");
  const githubUserId = user.id;
  if (await deps.identities.developerForIdentity(ownerKeyForSubject(GITHUB_ISSUER, String(githubUserId))) !== state.developerId) return { kind: "not_linked" };

  // An installation this user can reach: a crafted installation_id that is not theirs stops here.
  if (!await userCanReach(deps, token, installationId)) return { kind: "not_yours" };

  let installation: GitHubInstallation;
  try {
    installation = await deps.app.installation(installationId);
  } catch (error) {
    if ((error as { code?: unknown }).code === "NOT_FOUND") return { kind: "not_yours" };
    throw error;
  }

  // C1: reading the repositories is not enough. The user is the account itself, or an active admin of the GitHub organization.
  const { account } = installation;
  if (account.type === "User") {
    if (account.id !== githubUserId) return { kind: "not_yours", accountLogin: account.login };
  } else if (account.type === "Organization") {
    const membership = await userGet(deps, token, `/user/memberships/orgs/${encodeURIComponent(account.login)}`);
    if (membership.status === 403 || membership.status === 404) return { kind: "not_yours", accountLogin: account.login };
    if (!membership.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's membership lookup failed with HTTP ${membership.status}`);
    const body = await membership.json().catch(() => undefined) as { state?: unknown; role?: unknown } | undefined;
    if (body?.state !== "active" || body.role !== "admin") return { kind: "not_yours", accountLogin: account.login };
  } else {
    return { kind: "not_yours", accountLogin: account.login };
  }

  const held = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown } };
  if (held.Item !== undefined && held.Item.orgId !== org.orgId) return { kind: "taken", accountLogin: account.login };

  return {
    kind: "ok",
    pending: {
      installationId, accountLogin: account.login, accountId: account.id, accountType: account.type, repositorySelection: installation.repositorySelection,
      status: installation.suspendedAt === null ? "active" : "suspended", githubUserId: String(githubUserId),
    },
  };
}

/** Whether `GET /user/installations` (up to 10 pages of 100) lists the installation. */
async function userCanReach(deps: GithubConnectionDependencies, token: string, installationId: number): Promise<boolean> {
  for (let page = 1; page <= USER_INSTALLATION_PAGES; page += 1) {
    const response = await userGet(deps, token, `/user/installations?per_page=100&page=${page}`);
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's installation lookup failed with HTTP ${response.status}`);
    const body = await response.json().catch(() => undefined) as { installations?: unknown } | undefined;
    const installations = Array.isArray(body?.installations) ? body.installations as Array<{ id?: unknown }> : [];
    if (installations.some((entry) => entry.id === installationId)) return true;
    if (installations.length < 100) return false;
  }
  return false;
}

/**
 * `POST /v1/github/install/confirm`. The form came from this cell's callback page and the cookie from the same browser: the state is
 * consumed only with the cookie's token (compared by hash), unexpired and unused. `cancel` writes nothing else. `connect` binds in one
 * transaction (the global item for another org is `taken`), records the permanent tombstone, and opens the trial for the GitHub account.
 */
export async function confirmGithubConnect(
  deps: GithubConnectionDependencies,
  form: { connect: string; decision: "connect" | "cancel" },
  cookie: string | undefined,
  origin: string | undefined,
): Promise<ConfirmOutcome> {
  if (origin !== deps.origin) throw agentXError("CONFIG_INVALID", "this confirmation did not come from the connect page");
  const expired: ConfirmOutcome = { outcome: "expired" };
  if (!deps.cloud || !HASH_PATTERN.test(form.connect) || cookie === undefined || !COOKIE_TOKEN_PATTERN.test(cookie)) return expired;
  const state = await readState(deps, form.connect);
  if (state?.pending === undefined) return expired;
  const now = deps.now();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: githubConnectStateKey(form.connect),
      UpdateExpression: "SET consumedAt = :now",
      ConditionExpression: "attribute_not_exists(consumedAt) AND expiresAt > :now AND confirmHash = :h",
      ExpressionAttributeValues: { ":now": now, ":h": sha256Hex(cookie) },
    }));
  } catch (error) {
    if (conditionFailed(error)) return expired;
    throw error;
  }
  const { pending } = state;
  const orgName = (await deps.orgs.getOrg(state.orgId))?.name;
  const names = { ...(orgName === undefined ? {} : { orgName }), accountLogin: pending.accountLogin };
  if (form.decision === "cancel") {
    log(deps, { event: "github.connect_cancelled", orgId: state.orgId });
    return { outcome: "cancelled", ...names };
  }

  const at = new Date(now).toISOString();
  const record: GithubInstallationRecord = {
    installationId: pending.installationId, orgId: state.orgId, accountLogin: pending.accountLogin, accountId: pending.accountId,
    accountType: pending.accountType, repositorySelection: pending.repositorySelection, installedByGithubUserId: pending.githubUserId,
    boundByDeveloperId: state.developerId, status: pending.status, boundAt: at, updatedAt: at,
  };
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: deps.tableName, Item: { ...githubInstallationKey(pending.installationId), entityType: "GITHUB_INSTALLATION", ...record },
          ConditionExpression: "attribute_not_exists(pk) OR orgId = :org", ExpressionAttributeValues: { ":org": state.orgId },
        } },
        { Put: { TableName: deps.tableName, Item: { ...orgGithubInstallationKey(state.orgId, pending.installationId), entityType: "ORG_GITHUB_INSTALLATION", ...record } } },
        { Update: {
          TableName: deps.tableName, Key: githubInstallationEverBoundKey(pending.installationId),
          UpdateExpression: "SET entityType = :type, firstBoundAt = if_not_exists(firstBoundAt, :now), firstOrgId = if_not_exists(firstOrgId, :org)",
          ExpressionAttributeValues: { ":type": "GITHUB_INSTALLATION_EVER_BOUND", ":now": at, ":org": state.orgId },
        } },
        // The org is still open, and the person who started the connect is still its owner or admin: a removal or demotion since binds nothing.
        { ConditionCheck: {
          TableName: deps.tableName, Key: orgMetaKey(state.orgId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt)",
        } },
        { ConditionCheck: {
          TableName: deps.tableName, Key: orgMemberKey(state.orgId, state.developerId),
          ConditionExpression: "attribute_exists(pk) AND (#role = :owner OR #role = :admin)",
          ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":owner": "owner", ":admin": "admin" },
        } },
      ],
    }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed?.has(0)) {
      log(deps, { event: "github.connect_refused", orgId: state.orgId, installationId: pending.installationId, reason: "taken" });
      return { outcome: "taken", ...names };
    }
    if (failed !== undefined && (failed.has(3) || failed.has(4))) {
      log(deps, { event: "github.connect_refused", orgId: state.orgId, installationId: pending.installationId, reason: "not_allowed_now" });
      return { outcome: "expired", ...names };
    }
    throw error;
  }
  log(deps, { event: "github.connected", orgId: state.orgId, installationId: pending.installationId, accountType: pending.accountType });

  try {
    await deps.unlockTrial({ orgId: state.orgId, githubUserId: pending.githubUserId });
  } catch (error) {
    if ((error as { code?: unknown }).code === "TRIAL_GITHUB_USED") return { outcome: "connected_trial_used", ...names };
    log(deps, { event: "github.connect_trial_unlock_failed", orgId: state.orgId, error: errorName(error) });
  }
  return { outcome: "connected", ...names };
}
