// Plan 2, Tasks 13 and 14: what the GitHub connect flow and the "ask my GitHub admin" flow share: the dependencies, the connect state's
// single use, and the calls made with a GitHub user token. Moved out of github-connection.ts unchanged, so the request flow needs no import cycle.
// Secrets: the user token and the authorization code are never logged or stored.
import { createHash } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, githubConnectStateKey, trialGithubKey, type OrgId, type OrgRecord, type OrgRole } from "@agentx/contracts";
import type { AuditRuntime } from "../audit/outbox.js";
import type { GitHubInstallation, GitHubInstallationRepository, GitHubTokenScope } from "../github-app.js";

export const GITHUB_ISSUER = "https://github.com";
const GITHUB_TIMEOUT_MS = 8_000;
export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** What one owner is told when a GitHub organization is connected to their Rovara organization by a request. */
export interface GithubConnectedNotice {
  to: string;
  orgName: string;
  accountLogin: string;
  requester: { name: string; email?: string };
  approverLogin: string;
}

/** What the requester is told once, two days after asking, when their GitHub admin has not approved yet. */
export interface GithubRequestReminder {
  to: string;
  /** The GitHub organization the request names, when GitHub's callback said (it is not known today). */
  requestedAccountLogin?: string;
  /** When the request expires (epoch milliseconds). */
  expiresAt: number;
}

/** What the callback and the confirmation need of the GitHub App provider. */
export interface GithubConnectApp {
  appSlug(): Promise<string>;
  oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined>;
  installation(id: number): Promise<GitHubInstallation>;
  /**
   * Plan 2, Task 14: `GET /orgs/{org}/memberships/{login}` made with a token of this installation (the App's `members: read`). `undefined`
   * when GitHub answers 404 (not a member, or not visible). Anything else GitHub answers is thrown.
   */
  orgMembership?(installationId: number, org: string, login: string): Promise<{ state: string; role: string } | undefined>;
  /**
   * Plan 2, Task 15: the repositories one installation reaches (GitHub's `GET /installation/repositories`, read with a token minted for the
   * org in `scope`, which the provider refuses unless the installation is bound to that org and active).
   */
  listInstallationRepositories?(installationId: number, scope: GitHubTokenScope): Promise<GitHubInstallationRepository[]>;
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
    getDeveloper(developerId: string): Promise<{ provider: string; issuer: string; displayName?: string; email?: string } | undefined>;
  };
  orgs: { getOrg(orgId: OrgId): Promise<OrgRecord | undefined>; listMembers?(orgId: OrgId): Promise<Array<{ developerId: string; role: OrgRole; joinedAt?: string }>> };
  /**
   * Plan 2, Task 14: tells one owner that a GitHub organization was connected through a request (an email). It may throw; the caller
   * logs the failure by name and goes on. Absent, nobody is told.
   */
  notifyGithubConnected?: (input: GithubConnectedNotice) => Promise<void>;
  /** Plan 2, Task 14 Step 6: emails a requester their one reminder. It may throw; the sweep logs it by name and goes on. Absent, nobody is reminded. */
  remindGithubRequester?: (input: GithubRequestReminder) => Promise<void>;
  /** Plan 1 Task 19: opens the org's trial for this GitHub account; TRIAL_GITHUB_USED when the account already opened another org's. */
  unlockTrial: (input: { orgId: OrgId; githubUserId: string }) => Promise<void>;
  fetch?: typeof fetch;
  /** Event names, ids and error names only. */
  log?: (entry: Record<string, unknown>) => void;
  /** The Audit Ledger's outbox (Task 18): a connection, a disconnect and GitHub's own changes are recorded in the transaction that makes them. Absent on a legacy install. */
  audit?: AuditRuntime;
}

export interface PendingBinding {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  status: "active" | "suspended";
  githubUserId: string;
}

/** The two places a person can start connecting GitHub from, and so the two places the end pages send them back to. Fixed values only: never an address from a request. */
export type ConnectReturnTo = "/app/onboard" | "/app/admin/connections";
export const CONNECT_RETURN_TOS: readonly ConnectReturnTo[] = ["/app/onboard", "/app/admin/connections"];
export interface ConnectStateItem {
  orgId: OrgId;
  developerId: string;
  expiresAt: number;
  consumedAt?: number;
  callbackAt?: number;
  confirmHash?: string;
  pending?: PendingBinding;
  /** UX3: where the person started (a fixed choice); the pages at the end of the flow take them back there. Absent means onboarding. */
  returnTo?: ConnectReturnTo;
}

export function log(deps: GithubConnectionDependencies, entry: Record<string, unknown>): void {
  (deps.log ?? ((line) => { console.log(JSON.stringify({ component: "broker", ...line })); }))(entry);
}

export const conditionFailed = (error: unknown) => errorName(error) === "ConditionalCheckFailedException";

export function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => { if (reason?.Code === "ConditionalCheckFailed") failed.add(index); });
  return failed;
}

export async function readState(deps: GithubConnectionDependencies, stateHash: string): Promise<ConnectStateItem | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubConnectStateKey(stateHash), ConsistentRead: true })) as { Item?: ConnectStateItem };
  return response.Item;
}

/** Single use: marks the state consumed. False when it was consumed already (or is gone), which the caller treats as expired. */
export async function consumeState(deps: GithubConnectionDependencies, stateHash: string): Promise<boolean> {
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

/**
 * What unlocking the org's trial with this GitHub account will answer: `connected_trial_used` when the account already started another org's trial.
 * The unlock runs after the bind commits (the confirmation) or from the notice outbox after it (a request bound by GitHub's webhook), so the audit
 * event of the bind says what the unlock will answer, read just before. Two orgs binding with one account at the same moment can both read no claim:
 * the loser's event then says `connected` and its unlock finds the trial used. Only the fact is affected; the claim stays the authority.
 */
export async function expectedTrialResult(deps: GithubConnectionDependencies, org: OrgRecord | undefined, githubUserId: string): Promise<"connected" | "connected_trial_used"> {
  if (org?.plan !== "trial" || org.trialUnlockedAt !== undefined) return "connected";
  const claim = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: trialGithubKey(githubUserId), ConsistentRead: true })) as { Item?: { orgId?: unknown } };
  return claim.Item !== undefined && claim.Item.orgId !== org.orgId ? "connected_trial_used" : "connected";
}

export const isOwnerOrAdmin = (role: OrgRole) => role === "owner" || role === "admin";

export const userHeaders = (token: string) => ({
  accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rovara-github-connect", "x-github-api-version": "2022-11-28",
});

export function github(deps: GithubConnectionDependencies, url: string, init: RequestInit = {}): Promise<Response> {
  return (deps.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS), ...init });
}

/** The user access token for a code, or undefined when GitHub refused it (it answers a bad or used code with HTTP 200 and an error body). */
export async function exchangeCode(deps: GithubConnectionDependencies, client: { clientId: string; clientSecret: string }, code: string): Promise<string | undefined> {
  const response = await github(deps, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "rovara-github-connect" },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code }).toString(),
  });
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's token exchange failed with HTTP ${response.status}`);
  // A GitHub App user token that expires comes with a refresh token (`ghr_`). It is dropped here, never stored or logged. Open question
  // (check once on staging): whether revoking the access token below also invalidates the paired refresh token.
  const body = await response.json().catch(() => undefined) as { access_token?: unknown } | undefined;
  return typeof body?.access_token === "string" && body.access_token !== "" ? body.access_token : undefined;
}

/** DELETE /applications/{client_id}/token: best effort, once. A failure is logged by name and never stops the answer. */
export async function revokeUserToken(deps: GithubConnectionDependencies, client: { clientId: string; clientSecret: string }, token: string): Promise<void> {
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

export async function userGet(deps: GithubConnectionDependencies, token: string, path: string): Promise<Response> {
  return github(deps, `https://api.github.com${path}`, { headers: userHeaders(token) });
}

