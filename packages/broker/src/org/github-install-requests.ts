// Plan 2, Task 14: ask my GitHub admin. A Rovara owner or admin who is not an admin of their GitHub organization still connects it: GitHub
// shows them "Request" instead of "Install", an admin of the GitHub organization approves on GitHub, and GitHub then sends an
// `installation.created` webhook that names the requester. Rovara binds that installation to the requester's org only when everything
// below holds, and otherwise binds nothing:
//   - the requester is named by GitHub and has an open (waiting, unexpired) request, recorded when GitHub sent them back from "Request";
//   - the requester's GitHub account is still linked to the Rovara developer who asked, who is still an owner or admin of the request's org;
//   - the installation was created inside the request's window, and was never bound before (a permanent tombstone);
//   - the requester is an active member of the GitHub organization and the approver an admin of it (checked with the installation's own token);
//   - this delivery was not processed before.
// When GitHub names no requester, or one with no open request, nothing is attributed (github.install_request_unattributed): Rovara never
// guesses a requester from timing or from an account name. Nothing here logs a token, a code or an email address.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  GITHUB_INSTALL_REQUEST_TTL_MS,
  agentXError,
  githubAuditKey,
  githubDeliveryKey,
  githubInstallRequestKey,
  githubInstallRequestQueueKey,
  githubInstallationEverBoundKey,
  githubInstallationKey,
  orgGithubInstallRequestKey,
  orgGithubInstallationKey,
  orgMemberKey,
  orgMetaKey,
  orgPk,
  type GithubInstallRequestRecord,
  type GithubInstallationRecord,
  type OrgId,
  type OrgRole,
} from "@agentx/contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import {
  GITHUB_ISSUER, conditionFailed, consumeState, errorName, exchangeCode, failedIndexes, isOwnerOrAdmin, log, readState, revokeUserToken, userGet,
  type GithubConnectionDependencies,
} from "./github-connect-support.js";

const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_PREFIX = "GITHUB_INSTALL_REQUEST#";
/** GitHub's installation timestamps are whole seconds, so a request's start is compared at that precision. */
const SECOND_MS = 1000;

export interface InstallRequestView {
  githubLogin: string;
  status: GithubInstallRequestRecord["status"] | "expired";
  accountLogin?: string;
  requestedAt: string;
  expiresAt: string;
  requestedBy: { developerId: string; name: string };
}

/** A `waiting` request past its expiry reads as `expired`, whatever the stored item says. */
const effectiveStatus = (record: GithubInstallRequestRecord, now: number): InstallRequestView["status"] =>
  record.status === "waiting" && record.expiresAt <= now ? "expired" : record.status;

const githubIdentityKey = (githubUserId: string | number) => ownerKeyForSubject(GITHUB_ISSUER, String(githubUserId));

async function liveRole(deps: GithubConnectionDependencies, orgId: OrgId, developerId: string): Promise<OrgRole | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: { role?: OrgRole } };
  return response.Item?.role;
}

async function readRequest(deps: GithubConnectionDependencies, githubUserId: string): Promise<GithubInstallRequestRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallRequestKey(githubUserId), ConsistentRead: true })) as { Item?: GithubInstallRequestRecord };
  return response.Item;
}

/** What an item of a request carries besides its key, so the global item and the org's copy stay identical. */
const requestFields = (record: GithubInstallRequestRecord) => ({ entityType: "GITHUB_INSTALL_REQUEST", ...record });

function auditItem(tableName: string, orgId: OrgId, at: number, entry: Record<string, unknown>) {
  const iso = new Date(at).toISOString();
  return { Put: { TableName: tableName, Item: { ...githubAuditKey(orgId, iso, randomUUID()), entityType: "GITHUB_AUDIT", orgId, at: iso, ...entry } } };
}

/** The earliest-joined owner's name, for the message a person gives their GitHub admin; "an owner" when it cannot be read. */
export async function ownerNameOf(deps: GithubConnectionDependencies, orgId: OrgId): Promise<string> {
  try {
    const members = await deps.orgs.listMembers?.(orgId) ?? [];
    const owner = members.filter((member) => member.role === "owner").sort((left, right) => (left.joinedAt ?? "").localeCompare(right.joinedAt ?? ""))[0];
    const name = owner === undefined ? undefined : (await deps.identities.getDeveloper(owner.developerId))?.displayName;
    return name === undefined || name === "" ? "an owner" : name;
  } catch (error) {
    log(deps, { event: "github.install_request_owner_name_failed", orgId, error: errorName(error) });
    return "an owner";
  }
}

/**
 * The request callback (`setup_action=request`): a non-admin member of a GitHub organization asked its admin. The state must be open, and
 * is consumed. The code is exchanged and `GET /user` names the GitHub user, who must be linked to the developer who started this, who must
 * still be an owner or admin of the org right now. Only then is the request recorded. A callback with no `code` attributes nothing
 * (GitHub's `request` callback was not probed to carry one): `expired`, nothing recorded, logged `github.install_request_unattributed`.
 * The GitHub user token is revoked before this returns.
 */
export async function recordInstallRequest(
  deps: GithubConnectionDependencies,
  state: { stateHash: string },
  query: { code?: string | undefined },
): Promise<"requested" | "not_linked" | "expired"> {
  const item = await readState(deps, state.stateHash);
  // A state that reached the confirm page (callbackAt) is used: a second callback with it is a replay.
  if (item === undefined || item.consumedAt !== undefined || item.callbackAt !== undefined || item.expiresAt <= deps.now()) return "expired";
  if (!await consumeState(deps, state.stateHash)) return "expired";
  const code = typeof query.code === "string" && query.code !== "" && query.code.length <= 512 ? query.code : undefined;
  const client = code === undefined ? undefined : await deps.app.oauthClient();
  if (code === undefined || client === undefined) {
    log(deps, { event: "github.install_request_unattributed", orgId: item.orgId, reason: code === undefined ? "no_code" : "no_oauth_client" });
    return "expired";
  }

  let token: string | undefined;
  try {
    token = await exchangeCode(deps, client, code);
    if (token === undefined) return "expired";
    const response = await userGet(deps, token, "/user");
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's user lookup failed with HTTP ${response.status}`);
    const user = await response.json().catch(() => undefined) as { id?: unknown; login?: unknown } | undefined;
    if (typeof user?.id !== "number" || !Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== "string" || user.login === "") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub's answer names no account");
    }
    const githubUserId = String(user.id);
    if (await deps.identities.developerForIdentity(githubIdentityKey(githubUserId)) !== item.developerId) {
      log(deps, { event: "github.install_request_refused", orgId: item.orgId, reason: "not_linked" });
      return "not_linked";
    }
    // The role is read now, not taken from the moment the connect started: a demotion since means nothing is recorded.
    const role = await liveRole(deps, item.orgId, item.developerId);
    if (role === undefined || !isOwnerOrAdmin(role)) {
      log(deps, { event: "github.install_request_refused", orgId: item.orgId, reason: "not_admin_now" });
      throw agentXError("FORBIDDEN", "only an owner or admin can connect GitHub");
    }
    return await putRequest(deps, { orgId: item.orgId, developerId: item.developerId, githubUserId, githubLogin: user.login });
  } catch (error) {
    if ((error as { code?: unknown }).code === "FORBIDDEN") throw error;
    log(deps, { event: "github.install_request_failed", orgId: item.orgId, error: errorName(error) });
    return "expired";
  } finally {
    if (token !== undefined) await revokeUserToken(deps, client, token);
  }
}

/** Writes the global request item and the org's copy, replacing what the rules allow (see githubInstallRequestKey). */
async function putRequest(
  deps: GithubConnectionDependencies,
  who: { orgId: OrgId; developerId: string; githubUserId: string; githubLogin: string },
): Promise<"requested" | "expired"> {
  const now = deps.now();
  const existing = await readRequest(deps, who.githubUserId);
  let replacedOther: GithubInstallRequestRecord | undefined;
  if (existing?.status === "waiting" && existing.developerId !== who.developerId) {
    // Another developer's open request for this GitHub user is replaced only when the identity is no longer theirs (it was unlinked).
    if (await deps.identities.developerForIdentity(githubIdentityKey(who.githubUserId)) === existing.developerId) {
      log(deps, { event: "github.install_request_refused", orgId: who.orgId, reason: "held_by_another_developer" });
      return "expired";
    }
    replacedOther = existing;
  }
  const record: GithubInstallRequestRecord = {
    orgId: who.orgId, developerId: who.developerId, githubUserId: who.githubUserId, githubLogin: who.githubLogin,
    requestedAt: now, expiresAt: now + GITHUB_INSTALL_REQUEST_TTL_MS, status: "waiting",
  };
  const items: Array<Record<string, unknown>> = [
    { Put: {
      TableName: deps.tableName, Item: { ...githubInstallRequestKey(who.githubUserId), ...requestFields(record) },
      ...(existing === undefined
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#status = :status AND requestedAt = :requestedAt", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":status": existing.status, ":requestedAt": existing.requestedAt } }),
    } },
    { Put: { TableName: deps.tableName, Item: { ...orgGithubInstallRequestKey(who.orgId, who.githubUserId), ...requestFields(record) } } },
    { Put: { TableName: deps.tableName, Item: { ...githubInstallRequestQueueKey(record.requestedAt, who.githubUserId), entityType: "GITHUB_INSTALL_REQUEST_QUEUE", orgId: who.orgId } } },
  ];
  if (existing !== undefined) {
    if (existing.status === "waiting") items.push({ Delete: { TableName: deps.tableName, Key: githubInstallRequestQueueKey(existing.requestedAt, who.githubUserId) } });
    if (existing.orgId !== who.orgId) items.push({ Delete: { TableName: deps.tableName, Key: orgGithubInstallRequestKey(existing.orgId, who.githubUserId) } });
  }
  if (replacedOther !== undefined) {
    const audit = auditItem(deps.tableName, who.orgId, now, {
      action: "install_request_replaced", githubUserId: who.githubUserId, githubLogin: who.githubLogin,
      replacedDeveloperId: replacedOther.developerId, replacedOrgId: replacedOther.orgId, developerId: who.developerId,
    });
    items.push(audit);
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (failedIndexes(error) !== undefined || conditionFailed(error)) {
      // Another request for this GitHub user landed first. The person asks again; nothing is half written.
      log(deps, { event: "github.install_request_conflict", orgId: who.orgId });
      return "expired";
    }
    throw error;
  }
  log(deps, { event: "github.install_request_recorded", orgId: who.orgId });
  return "requested";
}

/** `installation.created_at` as epoch milliseconds: GitHub has sent an ISO 8601 string and epoch seconds in installation payloads. */
function createdAtMs(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface InstallationCreatedPayload {
  installation: { id: number; created_at: string | number; account: { login: string; id: number; type: string } };
  requester: { id: number; login: string } | null;
  sender: { id: number; login: string };
}

/**
 * An `installation` webhook with action `created`. Binds the installation to the requester's org when every condition in the file's
 * header holds ("bound"), and otherwise changes nothing but, in three cases, the request's own status ("ignored"). A GitHub call that
 * fails for a reason other than "no such membership" throws, so the webhook answers retryably and a redelivery can try again.
 */
export async function bindRequestedInstallation(
  deps: GithubConnectionDependencies,
  deliveryId: string,
  payload: InstallationCreatedPayload,
): Promise<"bound" | "ignored"> {
  const { installation, requester, sender } = payload;
  const ignored = (reason: string, extra: Record<string, unknown> = {}): "ignored" => {
    log(deps, { event: "github.install_request_ignored", installationId: installation.id, reason, ...extra });
    return "ignored";
  };
  if (!deps.cloud) return ignored("not_cloud");
  // A delivery that was decided before is a replay: a redelivery by hand or by the recovery sweep does nothing, whatever has changed since.
  const seen = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubDeliveryKey(deliveryId), ConsistentRead: true })) as { Item?: unknown };
  if (seen.Item !== undefined) return ignored("delivery_seen");
  const unattributed = (reason: string): "ignored" => {
    log(deps, { event: "github.install_request_unattributed", installationId: installation.id, reason });
    return "ignored";
  };
  if (requester === null) return unattributed("no_requester");
  const requesterId = String(requester.id);
  const request = await readRequest(deps, requesterId);
  const now = deps.now();
  if (request === undefined || request.status !== "waiting" || request.expiresAt <= now) return unattributed("no_open_request");
  if (await deps.identities.developerForIdentity(githubIdentityKey(requesterId)) !== request.developerId) return unattributed("not_linked_to_requester");
  const role = await liveRole(deps, request.orgId, request.developerId);
  if (role === undefined || !isOwnerOrAdmin(role)) return ignored("not_admin_now", { orgId: request.orgId });
  const created = createdAtMs(installation.created_at);
  if (created === undefined || created < Math.floor(request.requestedAt / SECOND_MS) * SECOND_MS || created >= request.expiresAt) {
    return ignored("outside_request_window", { orgId: request.orgId });
  }
  const tombstone = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationEverBoundKey(installation.id), ConsistentRead: true })) as { Item?: unknown };
  if (tombstone.Item !== undefined) return await endRequest(deps, request, "reinstall_needed", installation.id, deliveryId);
  if (installation.account.type !== "Organization") return ignored("not_an_organization", { orgId: request.orgId });
  if (deps.app.orgMembership === undefined) return ignored("no_membership_check", { orgId: request.orgId });
  const asker = await deps.app.orgMembership(installation.id, installation.account.login, requester.login);
  if (asker?.state !== "active") return ignored("requester_not_a_member", { orgId: request.orgId });
  const approver = await deps.app.orgMembership(installation.id, installation.account.login, sender.login);
  if (approver?.state !== "active" || approver.role !== "admin") return ignored("approver_not_an_admin", { orgId: request.orgId });
  let current;
  try {
    current = await deps.app.installation(installation.id);
  } catch (error) {
    if ((error as { code?: unknown }).code === "NOT_FOUND") return ignored("installation_gone", { orgId: request.orgId });
    throw error;
  }
  if (current.account.id !== installation.account.id || current.account.type !== "Organization") return ignored("installation_account_differs", { orgId: request.orgId });

  const at = new Date(now).toISOString();
  const record: GithubInstallationRecord = {
    installationId: installation.id, orgId: request.orgId, accountLogin: current.account.login, accountId: current.account.id, accountType: "Organization",
    repositorySelection: current.repositorySelection, installedByGithubUserId: requesterId, boundByDeveloperId: request.developerId,
    status: current.suspendedAt === null ? "active" : "suspended", boundAt: at, updatedAt: at,
  };
  const decided = (status: "connected") => ({
    UpdateExpression: "SET #status = :decided, installationId = :installationId, accountLogin = :accountLogin, approvedBy = :approvedBy, decidedAt = :now",
    ConditionExpression: "#status = :waiting AND expiresAt > :now AND developerId = :developerId AND orgId = :orgId",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":decided": status, ":installationId": installation.id, ":accountLogin": current.account.login, ":approvedBy": { githubUserId: String(sender.id), login: sender.login },
      ":now": now, ":waiting": "waiting", ":developerId": request.developerId, ":orgId": request.orgId,
    },
  });
  const audit = auditItem(deps.tableName, request.orgId, now, {
    action: "install_request_bound",
    requester: { githubUserId: requesterId, login: requester.login, developerId: request.developerId },
    approver: { githubUserId: String(sender.id), login: sender.login },
    installationId: installation.id, accountLogin: current.account.login, deliveryId,
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: deps.tableName,
          Item: { ...githubDeliveryKey(deliveryId), entityType: "GITHUB_DELIVERY_INSTALL_REQUEST", processedAt: at, expiresAt: now + DELIVERY_RETENTION_MS, indexExpiresAt: Math.floor((now + DELIVERY_RETENTION_MS) / 1000) },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Update: { TableName: deps.tableName, Key: githubInstallRequestKey(requesterId), ...decided("connected") } },
        { Update: { TableName: deps.tableName, Key: orgGithubInstallRequestKey(request.orgId, requesterId), ...decided("connected") } },
        // Must be unbound: no `OR orgId = :org` here, so another org's binding, and this org's own, both refuse.
        { Put: { TableName: deps.tableName, Item: { ...githubInstallationKey(installation.id), entityType: "GITHUB_INSTALLATION", ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: {
          TableName: deps.tableName,
          Item: { ...githubInstallationEverBoundKey(installation.id), entityType: "GITHUB_INSTALLATION_EVER_BOUND", firstBoundAt: at, firstOrgId: request.orgId },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Put: { TableName: deps.tableName, Item: { ...orgGithubInstallationKey(request.orgId, installation.id), entityType: "ORG_GITHUB_INSTALLATION", ...record } } },
        audit,
        { Delete: { TableName: deps.tableName, Key: githubInstallRequestQueueKey(request.requestedAt, requesterId) } },
        // The org is still open and the requester still owns or administers it, in the same transaction as the bind.
        { ConditionCheck: { TableName: deps.tableName, Key: orgMetaKey(request.orgId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt)" } },
        { ConditionCheck: {
          TableName: deps.tableName, Key: orgMemberKey(request.orgId, request.developerId),
          ConditionExpression: "attribute_exists(pk) AND (#role = :owner OR #role = :admin)",
          ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":owner": "owner", ":admin": "admin" },
        } },
      ],
    }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    // A delivery recorded in between is a replay. The installation bound meanwhile is taken; a tombstone written meanwhile is a reinstall.
    if (failed.has(0)) return ignored("delivery_seen", { orgId: request.orgId });
    if (failed.has(3)) return await endRequest(deps, request, "taken", installation.id, deliveryId);
    if (failed.has(4)) return await endRequest(deps, request, "reinstall_needed", installation.id, deliveryId);
    return ignored("request_changed", { orgId: request.orgId });
  }
  log(deps, { event: "github.install_request_bound", orgId: request.orgId, installationId: installation.id });

  try {
    await deps.unlockTrial({ orgId: request.orgId, githubUserId: requesterId });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "TRIAL_GITHUB_USED") log(deps, { event: "github.install_request_trial_unlock_failed", orgId: request.orgId, error: errorName(error) });
  }
  await tellOwners(deps, request, { accountLogin: current.account.login, approverLogin: sender.login });
  return "bound";
}

/** Ends a `waiting` request as `taken` or `reinstall_needed` (conditional on it still waiting), audits it, and drops its queue item. */
async function endRequest(
  deps: GithubConnectionDependencies,
  request: GithubInstallRequestRecord,
  status: "taken" | "reinstall_needed",
  installationId: number,
  deliveryId: string,
): Promise<"ignored"> {
  const now = deps.now();
  const update = {
    UpdateExpression: "SET #status = :ended, installationId = :installationId, decidedAt = :now",
    ConditionExpression: "#status = :waiting AND developerId = :developerId AND requestedAt = :requestedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":ended": status, ":installationId": installationId, ":now": now, ":waiting": "waiting", ":developerId": request.developerId, ":requestedAt": request.requestedAt },
  };
  const audit = auditItem(deps.tableName, request.orgId, now, {
    action: status === "taken" ? "install_request_taken" : "install_request_reinstall_needed",
    requester: { githubUserId: request.githubUserId, login: request.githubLogin, developerId: request.developerId }, installationId, deliveryId,
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: { TableName: deps.tableName, Key: githubInstallRequestKey(request.githubUserId), ...update } },
        { Update: { TableName: deps.tableName, Key: orgGithubInstallRequestKey(request.orgId, request.githubUserId), ...update } },
        { Delete: { TableName: deps.tableName, Key: githubInstallRequestQueueKey(request.requestedAt, request.githubUserId) } },
        audit,
      ],
    }));
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
  }
  log(deps, { event: "github.install_request_ended", orgId: request.orgId, installationId, reason: status });
  return "ignored";
}

/** One email to each owner who has an address on record; a failed send is logged by name and never undoes the bind. */
async function tellOwners(deps: GithubConnectionDependencies, request: GithubInstallRequestRecord, details: { accountLogin: string; approverLogin: string }): Promise<void> {
  if (deps.notifyGithubConnected === undefined || deps.orgs.listMembers === undefined) return;
  try {
    const org = await deps.orgs.getOrg(request.orgId);
    const requester = await deps.identities.getDeveloper(request.developerId);
    const owners = (await deps.orgs.listMembers(request.orgId)).filter((member) => member.role === "owner");
    for (const owner of owners) {
      try {
        const email = (await deps.identities.getDeveloper(owner.developerId))?.email;
        if (email === undefined || email === "") continue;
        await deps.notifyGithubConnected({
          to: email, orgName: org?.name ?? "your organization", accountLogin: details.accountLogin, approverLogin: details.approverLogin,
          requester: { name: requester?.displayName ?? request.githubLogin, ...(requester?.email === undefined || requester.email === "" ? {} : { email: requester.email }) },
        });
      } catch (error) {
        log(deps, { event: "github.install_request_notice_failed", orgId: request.orgId, error: errorName(error) });
      }
    }
  } catch (error) {
    log(deps, { event: "github.install_request_notice_failed", orgId: request.orgId, error: errorName(error) });
  }
}

/** `GET /v1/app/github/requests`: the org's requests, newest first. A `waiting` one past its expiry shows as `expired`. */
export async function listInstallRequests(deps: GithubConnectionDependencies, orgId: OrgId): Promise<{ requests: InstallRequestView[] }> {
  const records: GithubInstallRequestRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": REQUEST_PREFIX }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: GithubInstallRequestRecord[]; LastEvaluatedKey?: Record<string, unknown> };
    records.push(...page.Items ?? []);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const now = deps.now();
  const requests: InstallRequestView[] = [];
  for (const record of records.sort((left, right) => right.requestedAt - left.requestedAt)) {
    const name = (await deps.identities.getDeveloper(record.developerId))?.displayName ?? record.githubLogin;
    requests.push({
      githubLogin: record.githubLogin, status: effectiveStatus(record, now),
      ...(record.accountLogin === undefined ? {} : { accountLogin: record.accountLogin }),
      requestedAt: new Date(record.requestedAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString(),
      requestedBy: { developerId: record.developerId, name },
    });
  }
  return { requests };
}

/**
 * `DELETE /v1/app/github/requests/{githubUserId}`: the requester, or an owner or admin of the request's org, cancels a `waiting` request.
 * The request is looked up in the caller's own org, so another org's request is NOT_FOUND. Anyone else in the org gets FORBIDDEN.
 */
export async function cancelInstallRequest(
  deps: GithubConnectionDependencies,
  caller: { developerId: string; orgId: OrgId; orgRole: OrgRole },
  githubUserId: string,
): Promise<{ githubUserId: string; status: "cancelled" }> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgGithubInstallRequestKey(caller.orgId, githubUserId), ConsistentRead: true })) as { Item?: GithubInstallRequestRecord };
  const request = found.Item;
  if (request === undefined || request.orgId !== caller.orgId) throw agentXError("NOT_FOUND", "no such GitHub request");
  if (request.developerId !== caller.developerId && !isOwnerOrAdmin(caller.orgRole)) throw agentXError("FORBIDDEN", "only the person who asked, or an owner or admin, can cancel this request");
  const now = deps.now();
  if (request.status !== "waiting" || request.expiresAt <= now) throw agentXError("CONFIG_INVALID", "this request is no longer waiting");
  const update = {
    UpdateExpression: "SET #status = :cancelled, decidedAt = :now",
    ConditionExpression: "#status = :waiting AND requestedAt = :requestedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":cancelled": "cancelled", ":now": now, ":waiting": "waiting", ":requestedAt": request.requestedAt },
  };
  const audit = auditItem(deps.tableName, request.orgId, now, {
    action: "install_request_cancelled", requester: { githubUserId, login: request.githubLogin, developerId: request.developerId }, cancelledBy: caller.developerId,
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: { TableName: deps.tableName, Key: githubInstallRequestKey(githubUserId), ...update } },
        { Update: { TableName: deps.tableName, Key: orgGithubInstallRequestKey(request.orgId, githubUserId), ...update } },
        { Delete: { TableName: deps.tableName, Key: githubInstallRequestQueueKey(request.requestedAt, githubUserId) } },
        audit,
      ],
    }));
  } catch (error) {
    // Approved, replaced or cancelled between the read and the write.
    if (failedIndexes(error) !== undefined) throw agentXError("CONFIG_INVALID", "this request is no longer waiting");
    throw error;
  }
  log(deps, { event: "github.install_request_cancelled", orgId: request.orgId });
  return { githubUserId, status: "cancelled" };
}
