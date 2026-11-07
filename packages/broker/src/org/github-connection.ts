// Plan 2, Task 13: an org connects its own GitHub App installation (Rovara Cloud). `agentx github connect` makes a one-use state bound to
// the org owner or admin who started it; GitHub sends their browser back with a user authorization code. The callback proves who is
// there (the GitHub account linked to the starting developer) and that they manage the installation's account (the account itself, or an
// admin of the GitHub organization), then shows "Connect <account> to <org>?". Only the confirmation, from the same browser, binds.
//
// Secrets: the state, the confirmation token, the authorization code and the GitHub user token are never logged and never stored raw
// (the first two as SHA-256 only); the user token lives inside one callback and is revoked before it returns.
import { randomBytes } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError,
  githubConnectStateKey,
  githubDeliveryKey,
  githubInstallationEverBoundKey,
  githubInstallationKey,
  orgGithubInstallationKey,
  orgMemberKey,
  orgMetaKey,
  orgPk,
  type GithubInstallationRecord,
  type OrgId,
  type OrgRecord,
  type OrgRole,
} from "@agentx/contracts";
import { auditGithubConnected, auditGithubDisconnected, auditGithubInstallationChanged, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent } from "../audit/outbox.js";
import { parseGitHubRepository, type GitHubAppCredentialProviderOptions, type GitHubInstallation, type GitHubInstallationRepository, type GitHubTokenScope } from "../github-app.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import {
  GITHUB_ISSUER, conditionFailed, consumeState, errorName, exchangeCode, expectedTrialResult, failedIndexes, isOwnerOrAdmin, log, readState, revokeUserToken, sha256Hex, userGet,
  type ConnectStateItem, type GithubConnectApp, type GithubConnectionDependencies, type PendingBinding,
} from "./github-connect-support.js";
import { DELIVERY_RETENTION_MS, auditItem, ownerNameOf, recordInstallRequest } from "./github-install-requests.js";
import { githubNotConnectedMessage } from "./project-settings.js";

export type { GithubConnectApp, GithubConnectionDependencies };

export type ConnectOutcomeName = "confirm" | "requested" | "not_linked" | "not_yours" | "not_allowed" | "unattributed" | "taken" | "expired";
export interface ConnectOutcome {
  outcome: ConnectOutcomeName;
  orgName?: string;
  /** With `requested`: the owner's name, for the message to give the GitHub admin. */
  ownerName?: string;
  accountLogin?: string;
  /** With `confirm`: the connect attempt's id, which the confirm form posts back (the state's SHA-256). */
  connectId?: string;
  /** With `confirm`: set in the `__Host-rovara_gh_connect` cookie, never in the page. */
  confirmToken?: string;
}
export type ConfirmOutcomeName = "connected" | "connected_trial_used" | "cancelled" | "taken" | "not_allowed" | "expired";
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
// UX1: neutral words (the web app detects a missing GitHub link first and offers "Link your GitHub account" in place; the CLI prints this).
const NOT_LINKED_START_MESSAGE = "link your GitHub account to your Rovara account first, then connect GitHub again";


/** The Set-Cookie value that carries the confirmation token to the confirm page's form post, and only to this host. */
export const connectCookie = (token: string) => `${GITHUB_CONNECT_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${CONNECT_COOKIE_MAX_AGE_SECONDS}`;
/** The Set-Cookie value that removes it. */
export const clearedConnectCookie = () => `${GITHUB_CONNECT_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;


/**
 * `POST /v1/app/github/connect`: starts a connect for the caller's org. Only an owner or admin of a cloud org, who has signed in with
 * GitHub once (so the callback can recognise them), gets an install link; the link's state is theirs alone.
 */
export async function startGithubConnect(
  deps: GithubConnectionDependencies,
  caller: { developerId: string; orgId: OrgId; orgRole: OrgRole },
): Promise<{ installUrl: string; expiresAt: string; orgName?: string; ownerName?: string }> {
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
  // The names go to the CLI, which prints the message a person gives their GitHub admin if GitHub shows "Request" instead of "Install".
  const orgName = (await deps.orgs.getOrg(caller.orgId))?.name;
  return {
    installUrl: `https://github.com/apps/${slug}/installations/new?state=${state}`, expiresAt: new Date(expiresAt).toISOString(),
    ...(orgName === undefined ? {} : { orgName, ownerName: await ownerNameOf(deps, caller.orgId) }),
  };
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
    // A non-owner of the GitHub organization asked its admin (Plan 2, Task 14). The request is recorded only for a developer who is still an
    // owner or admin; the installation binds later, from GitHub's webhook, and never from this callback.
    try {
      const recorded = await recordInstallRequest(deps, { stateHash }, { code: query.code });
      if (recorded === "requested") return { outcome: "requested", orgName: org.name, ownerName: await ownerNameOf(deps, org.orgId) };
      return { outcome: recorded, orgName: org.name };
    } catch (error) {
      if ((error as { code?: unknown }).code === "FORBIDDEN") return { outcome: "not_allowed", orgName: org.name };
      throw error;
    }
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
  const org = await deps.orgs.getOrg(state.orgId);
  const orgName = org?.name;
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
  // The trial's outcome is only known after the bind, so the event says what the unlock will answer, read just before: the account already
  // started another organization's trial. (A race between this read and the unlock is the one case it can differ from the outcome.)
  const event = await tryAuditEvent(deps, async () => auditGithubConnected({
    orgId: state.orgId, actor: { kind: "member", id: state.developerId }, occurredAt: at, occurrence: form.connect,
    installationId: String(pending.installationId), accountType: pending.accountType, result: await expectedTrialResult(deps, org, pending.githubUserId),
    details: [{ subject: "org", fields: { accountLogin: pending.accountLogin } }],
  }));
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: deps.tableName, Item: { ...githubInstallationKey(pending.installationId), entityType: "GITHUB_INSTALLATION", ...record },
          ConditionExpression: "attribute_not_exists(pk) OR orgId = :org", ExpressionAttributeValues: { ":org": state.orgId },
        } },
        // Unconditioned on purpose: a re-bind by the same org refreshes boundAt and the binder on both items (the global item's condition guards other orgs).
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
        ...(event === undefined ? [] : auditPending(deps, event)),
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
      return { outcome: "not_allowed", ...names };
    }
    // The state is already used, so the person starts over; a page says so, not raw JSON.
    log(deps, { event: "github.connect_confirm_failed", orgId: state.orgId, error: errorName(error) });
    return { outcome: "expired", ...names };
  }
  log(deps, { event: "github.connected", orgId: state.orgId, installationId: pending.installationId, accountType: pending.accountType });
  if (event !== undefined) await flushAuditEvents(deps, [event]);

  try {
    await deps.unlockTrial({ orgId: state.orgId, githubUserId: pending.githubUserId });
  } catch (error) {
    if ((error as { code?: unknown }).code === "TRIAL_GITHUB_USED") {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: orgMetaKey(state.orgId),
        UpdateExpression: "SET trialGithubUsedAt = if_not_exists(trialGithubUsedAt, :now)",
        ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":now": deps.now() },
      }));
      return { outcome: "connected_trial_used", ...names };
    }
    log(deps, { event: "github.connect_trial_unlock_failed", orgId: state.orgId, error: errorName(error) });
  }
  return { outcome: "connected", ...names };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Plan 2, Task 15: the installation lifecycle, the repository listing, and the check that stands in front of every token an org's work mints.
// ---------------------------------------------------------------------------------------------------------------------------------------

const INSTALLATION_ITEM_PREFIX = "GITHUB_INSTALLATION#";
const INSTALLATION_EVENT_ATTEMPTS = 3;
const NOT_CONNECTED_UNNAMED = "Rovara can't reach GitHub through your organization's GitHub connection. Connect it with: agentx github connect";

/** One installation of an org, as `GET /v1/app/github/installations` shows it. */
export interface InstallationView {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  status: GithubInstallationRecord["status"];
  /** UX3: who connected it and when (the person's id, as the members list shows it; the web app turns it into a name). Left out for an older record that lacks either. */
  connectedBy?: string;
  connectedAt?: string;
}

/** `GET /v1/app/github/installations`: the org's installations (any member may read them), ordered by account. */
export async function listGithubInstallations(deps: Pick<GithubConnectionDependencies, "documentClient" | "tableName">, orgId: OrgId): Promise<{ installations: InstallationView[] }> {
  const items: Array<Partial<GithubInstallationRecord>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": INSTALLATION_ITEM_PREFIX }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Partial<GithubInstallationRecord>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...page.Items ?? []);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const installations = items.flatMap((item): InstallationView[] => {
    if (typeof item.installationId !== "number" || typeof item.accountLogin !== "string" || (item.accountType !== "User" && item.accountType !== "Organization")
      || (item.repositorySelection !== "all" && item.repositorySelection !== "selected") || (item.status !== "active" && item.status !== "suspended" && item.status !== "removed")) return [];
    return [{
      installationId: item.installationId, accountLogin: item.accountLogin, accountType: item.accountType, repositorySelection: item.repositorySelection, status: item.status,
      ...(typeof item.boundByDeveloperId === "string" && /^[a-f0-9]{64}$/.test(item.boundByDeveloperId) ? { connectedBy: item.boundByDeveloperId } : {}),
      ...(typeof item.boundAt === "string" && item.boundAt.length <= 40 ? { connectedAt: item.boundAt } : {}),
    }];
  });
  return { installations: installations.sort((left, right) => left.accountLogin.toLowerCase().localeCompare(right.accountLogin.toLowerCase()) || left.installationId - right.installationId) };
}

/**
 * `DELETE /v1/app/github/installations/{id}`: an owner or admin stops this org using the installation. Both of its keys go, so an admin of
 * another org may claim the GitHub account later (Task 13's checks apply to that claim). The EVER_BOUND tombstone stays. Nothing is
 * changed on GitHub: the answer says how to remove the App's access there too.
 */
export async function disconnectGithubInstallation(
  deps: GithubConnectionDependencies,
  caller: { developerId: string; orgId: OrgId; orgRole: OrgRole },
  installationId: number,
): Promise<{ installationId: number; accountLogin: string; message: string }> {
  if (!deps.cloud) throw agentXError("FORBIDDEN", "on this install, GitHub is connected by the administrator during agentx init");
  if (!isOwnerOrAdmin(caller.orgRole)) throw agentXError("FORBIDDEN", "only an owner or admin can disconnect GitHub");
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgGithubInstallationKey(caller.orgId, installationId), ConsistentRead: true })) as { Item?: { accountLogin?: unknown; accountType?: unknown; boundAt?: unknown } };
  if (found.Item === undefined || typeof found.Item.accountLogin !== "string") throw agentXError("NOT_FOUND", "this organization has no such GitHub installation");
  const account = found.Item.accountLogin;
  const now = deps.now();
  // One occurrence per binding: the same installation connected again later has another `boundAt`.
  const event = await tryAuditEvent(deps, () => auditGithubDisconnected({
    orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(now).toISOString(),
    occurrence: auditOccurrence(String(installationId), typeof found.Item?.boundAt === "string" ? found.Item.boundAt : ""),
    installationId: String(installationId), accountType: typeof found.Item?.accountType === "string" ? found.Item.accountType : "unknown", details: [{ subject: "org", fields: { accountLogin: account } }],
  }));
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: deps.tableName, Key: orgGithubInstallationKey(caller.orgId, installationId) } },
        // The global item may already be gone (a half-finished earlier attempt) but is never another org's.
        { Delete: { TableName: deps.tableName, Key: githubInstallationKey(installationId), ConditionExpression: "attribute_not_exists(pk) OR orgId = :org", ExpressionAttributeValues: { ":org": caller.orgId } } },
        auditItem(deps.tableName, caller.orgId, now, { action: "installation_disconnected", installationId, accountLogin: account, disconnectedBy: caller.developerId }),
        ...(event === undefined ? [] : auditPending(deps, event)),
      ],
    }));
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    throw agentXError("NOT_FOUND", "this organization has no such GitHub installation");
  }
  log(deps, { event: "github.installation_disconnected", orgId: caller.orgId, installationId });
  if (event !== undefined) await flushAuditEvents(deps, [event]);
  return {
    installationId, accountLogin: account,
    message: `Rovara no longer uses ${account}. To remove its access on GitHub too, uninstall the app in ${account}'s GitHub settings.`,
  };
}

/**
 * Refuses (GITHUB_NOT_CONNECTED) unless the installation is bound to `orgId` and active. Reads the binding fresh every time: nothing about it
 * is cached, so a disconnect, an uninstall or a suspension stops the next token at once. The message names the repository when the caller has one.
 */
export async function requireInstallationBound(
  deps: Pick<GithubConnectionDependencies, "documentClient" | "tableName">,
  orgId: OrgId,
  installationId: number,
  repository?: { owner: string; name: string },
): Promise<void> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown; status?: unknown } };
  if (response.Item?.orgId === orgId && response.Item.status === "active") return;
  throw agentXError("GITHUB_NOT_CONNECTED", repository === undefined ? NOT_CONNECTED_UNNAMED : githubNotConnectedMessage(`${repository.owner}/${repository.name}`));
}

/** What the repository checks need: the binding table, the install's kind, and what GitHub says about a repository. */
export interface RepositoryGateDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Rovara Cloud. Anything else has no bindings: the checks look the repository up and return. */
  cloud: boolean;
  app: {
    /** The installation that covers the repository, as GitHub says (`fresh`: asked again, not from a cache); undefined when the App is not installed there. */
    installationForRepository(owner: string, name: string, options?: { fresh?: boolean }): Promise<{ installationId: number } | undefined>;
    /** GitHub's immutable id of the repository, read with a token minted for `scope`. Needed only by `requireRepositoryConnected`. */
    repositoryIdentity?(url: string, scope: GitHubTokenScope): Promise<{ repositoryId: number } | undefined>;
  };
}

/**
 * The installation that covers the repository, after the pin and the org's binding were checked (cloud); the lookup alone elsewhere. On
 * cloud GitHub is asked afresh every time (one App-JWT call per repository): an installation limited to selected repositories can lose one
 * at any time, and a provider's per-owner cache, which can outlive that on a warm Lambda, must not answer a gate. A fresh answer is also the
 * one that follows an App reinstalled under a new id.
 */
async function connectedInstallation(
  deps: RepositoryGateDependencies,
  orgId: OrgId,
  owner: string,
  name: string,
  pinnedInstallationId: number | undefined,
): Promise<number> {
  const fullName = `${owner}/${name}`;
  const found = await deps.app.installationForRepository(owner, name, deps.cloud ? { fresh: true } : {});
  if (found === undefined) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(fullName));
  if (!deps.cloud) return found.installationId;
  // A repository that moved to another installation (a transfer) must be connected again on purpose: the project's pin stays with the old one.
  if (pinnedInstallationId !== undefined && pinnedInstallationId !== found.installationId) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(fullName));
  await requireInstallationBound(deps, orgId, found.installationId, { owner, name });
  return found.installationId;
}

/**
 * Whether the org's own GitHub connection reaches `owner/name`: the installation GitHub says covers it must be bound to the org and active
 * (and be the one `pinnedInstallationId` names, when the project's entry pins one). Returns the installation and the repository's GitHub id.
 * On an install that is not cloud nothing is bound, so it returns after the lookups.
 */
export async function requireRepositoryConnected(
  deps: RepositoryGateDependencies,
  orgId: OrgId,
  owner: string,
  name: string,
  pinnedInstallationId?: number,
): Promise<{ installationId: number; githubRepositoryId: number }> {
  const installationId = await connectedInstallation(deps, orgId, owner, name, pinnedInstallationId);
  if (deps.app.repositoryIdentity === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "reading a repository from GitHub is not set up in this deployment; ask Rovara support");
  const scope: GitHubTokenScope = deps.cloud ? { orgId } : { system: "private-install" };
  const identity = await deps.app.repositoryIdentity(`https://github.com/${owner}/${name}.git`, scope);
  if (identity === undefined) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(`${owner}/${name}`));
  return { installationId, githubRepositoryId: identity.repositoryId };
}

/**
 * `requireRepositoryConnected` for each repository of a project, passing each entry's pinned installation. It answers only whether each is
 * reached (the start path needs nothing of GitHub's repository id, so it asks GitHub nothing more than the installation). Not cloud: returns.
 */
export async function requireRepositoriesConnected(
  deps: Pick<RepositoryGateDependencies, "documentClient" | "tableName" | "cloud"> & { app: Pick<RepositoryGateDependencies["app"], "installationForRepository"> },
  orgId: OrgId,
  definition: { repositories: ReadonlyArray<{ url: string; installationId?: number | undefined }> },
): Promise<void> {
  if (!deps.cloud) return;
  for (const repository of definition.repositories) {
    const { owner, name } = parseGitHubRepository(repository.url);
    await connectedInstallation(deps, orgId, owner, name, repository.installationId);
  }
}

/** One repository of an installation, as `GET /v1/app/github/repositories` lists it (before the route marks the ones a project uses). */
export type InstallationRepositoryView = GitHubInstallationRepository;

/**
 * `GET /v1/app/github/repositories?installation=<id>`: the repositories the installation reaches. The installation must be this org's
 * (404 otherwise, whoever else holds it), and the token that reads them is minted for the org, which the provider checks again.
 */
export async function listInstallationRepositories(
  deps: GithubConnectionDependencies,
  orgId: OrgId,
  installationId: number,
): Promise<{ repositories: InstallationRepositoryView[] }> {
  if (!deps.cloud) throw agentXError("FORBIDDEN", "on this install, GitHub is connected by the administrator during agentx init");
  const global = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown } };
  if (global.Item?.orgId !== orgId) throw agentXError("NOT_FOUND", "this organization has no such GitHub installation");
  if (deps.app.listInstallationRepositories === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "listing GitHub repositories is not set up in this deployment; ask Rovara support");
  // A suspended or removed installation is refused by the provider's own check (GITHUB_NOT_CONNECTED), before any token is minted.
  const repositories = await deps.app.listInstallationRepositories(installationId, { orgId });
  return { repositories: [...repositories].sort((left, right) => left.fullName.toLowerCase().localeCompare(right.fullName.toLowerCase())) };
}

/** What an `installation` or `installation_repositories` delivery (other than `created`) tells. */
export type InstallationLifecycleEvent =
  | { kind: "installation"; action: "deleted" | "suspend" | "unsuspend"; installationId: number; eventAt?: number }
  | { kind: "repositories"; installationId: number; repositorySelection: "all" | "selected"; eventAt?: number };

/**
 * Follows GitHub's own changes to an installation that is bound to an org: `deleted` makes it `removed`, `suspend` `suspended`, `unsuspend`
 * `active` again, and a repository change updates `repositorySelection`. Both copies of the binding change together, with the delivery id
 * (a replay changes nothing) and an audit item. A delivery for an installation nobody bound is logged (`github.installation_unbound`) and
 * ignored: no write. A removed installation never comes back, and a suspension or unsuspension that does not follow from the current status
 * changes nothing.
 */
export async function applyInstallationLifecycle(
  deps: Pick<GithubConnectionDependencies, "documentClient" | "tableName" | "now" | "log" | "audit">,
  deliveryId: string,
  event: InstallationLifecycleEvent,
): Promise<"applied" | "ignored"> {
  const full = deps as GithubConnectionDependencies;
  for (let attempt = 0; attempt < INSTALLATION_EVENT_ATTEMPTS; attempt += 1) {
    const read = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(event.installationId), ConsistentRead: true })) as { Item?: Partial<GithubInstallationRecord> };
    const bound = read.Item;
    if (bound === undefined || typeof bound.orgId !== "string" || typeof bound.status !== "string") {
      log(full, { event: "github.installation_unbound", installationId: event.installationId });
      return "ignored";
    }
    const orgId = bound.orgId;
    const was = bound.status;
    // GitHub's own timestamp orders deliveries: one older than what is already applied (a replay under another delivery id, or one that
    // arrived late) says nothing about the installation now. `deleted` is terminal and is applied whatever its stamp (it is also not
    // allowed to wind the stored stamp back).
    const eventAt = event.kind === "installation" && event.action === "deleted" ? undefined : event.eventAt;
    if (eventAt !== undefined && typeof bound.githubUpdatedAt === "number" && bound.githubUpdatedAt > eventAt) {
      log(full, { event: "github.installation_event_stale", orgId, installationId: event.installationId, kind: event.kind === "installation" ? event.action : "repositories" });
      return "ignored";
    }
    let next: { status?: GithubInstallationRecord["status"]; repositorySelection?: "all" | "selected"; action: string } | undefined;
    if (event.kind === "repositories") next = was === "removed" || bound.repositorySelection === event.repositorySelection ? undefined : { repositorySelection: event.repositorySelection, action: "installation_repositories_changed" };
    else if (event.action === "deleted") next = was === "removed" ? undefined : { status: "removed", action: "installation_removed" };
    else if (event.action === "suspend") next = was === "active" ? { status: "suspended", action: "installation_suspended" } : undefined;
    else next = was === "suspended" ? { status: "active", action: "installation_unsuspended" } : undefined;
    if (next === undefined) {
      log(full, { event: "github.installation_event_ignored", orgId, installationId: event.installationId, kind: event.kind === "installation" ? event.action : "repositories" });
      return "ignored";
    }
    const now = deps.now();
    const at = new Date(now).toISOString();
    const expression = `SET updatedAt = :at${eventAt === undefined ? "" : ", githubUpdatedAt = :eventAt"}${next.status === undefined ? "" : ", #status = :status"}${next.repositorySelection === undefined ? "" : ", repositorySelection = :selection"}`;
    const values = { ":at": at, ...(eventAt === undefined ? {} : { ":eventAt": eventAt }), ...(next.status === undefined ? {} : { ":status": next.status }), ...(next.repositorySelection === undefined ? {} : { ":selection": next.repositorySelection }) };
    // DynamoDB refuses a name or a value that no expression uses: the org's copy has no condition on the status, so it declares #status only when it sets it.
    const copyUpdate = {
      UpdateExpression: expression, ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: values,
      ...(next.status === undefined ? {} : { ExpressionAttributeNames: { "#status": "status" } }),
    };
    const globalUpdate = {
      // `<=`: GitHub stamps whole seconds, and two real changes in one second (a suspend, then an unsuspend) must both apply.
      UpdateExpression: expression, ConditionExpression: `orgId = :org AND #status = :was${eventAt === undefined ? "" : " AND (attribute_not_exists(githubUpdatedAt) OR githubUpdatedAt <= :eventAt)"}`,
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ...values, ":org": orgId, ":was": was },
    };
    // A change of status is recorded (removed, suspended, active again); a change of the repositories the App reaches is not an event of the chain.
    const nextStatus = next.status;
    const changed = nextStatus === undefined ? undefined : await tryAuditEvent(deps, () => auditGithubInstallationChanged({
      orgId, actor: { kind: "github", id: String(event.installationId) }, occurredAt: at, occurrence: deliveryId,
      installationId: String(event.installationId), status: nextStatus, accountType: String(bound.accountType ?? "unknown"),
    }));
    const items = (withOrgCopy: boolean) => [
      { Put: {
        TableName: deps.tableName,
        Item: { ...githubDeliveryKey(deliveryId), entityType: "GITHUB_DELIVERY_INSTALL_REQUEST", processedAt: at, expiresAt: now + DELIVERY_RETENTION_MS, indexExpiresAt: Math.floor((now + DELIVERY_RETENTION_MS) / 1000) },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Update: { TableName: deps.tableName, Key: githubInstallationKey(event.installationId), ...globalUpdate } },
      ...(withOrgCopy ? [{ Update: { TableName: deps.tableName, Key: orgGithubInstallationKey(orgId, event.installationId), ...copyUpdate } }] : []),
      auditItem(deps.tableName, orgId, now, { action: next.action, installationId: event.installationId, deliveryId, ...(next.status === undefined ? {} : { status: next.status }), ...(next.repositorySelection === undefined ? {} : { repositorySelection: next.repositorySelection }) }),
      ...(changed === undefined ? [] : auditPending(deps, changed)),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items(true) }));
    } catch (error) {
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      if (failed.has(0)) return "ignored";
      // The org's copy is missing (it is only for listing): the global binding, which every token checks, still changes.
      if (failed.has(2) && !failed.has(1)) {
        try {
          await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items(false) }));
        } catch (retry) {
          if (failedIndexes(retry) === undefined) throw retry;
          continue;
        }
      } else continue;
    }
    log(full, { event: "github.installation_changed", orgId, installationId: event.installationId, change: next.action });
    if (changed !== undefined) await flushAuditEvents(deps, [changed]);
    return "applied";
  }
  log(full, { event: "github.installation_event_conflict", installationId: event.installationId });
  return "ignored";
}

/** The provider's pre-mint check (`requireInstallationBound` option) for a cloud install: reads the binding fresh before every token. */
export function installationBindingCheck(deps: Pick<GithubConnectionDependencies, "documentClient" | "tableName">): NonNullable<GitHubAppCredentialProviderOptions["requireInstallationBound"]> {
  return (orgId, installationId, repository) => requireInstallationBound(deps, orgId, installationId, repository);
}
