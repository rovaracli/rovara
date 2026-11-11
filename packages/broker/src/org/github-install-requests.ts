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
// What must follow a bind (the owners' notice and the trial unlock) is not left to chance after the commit: a notice outbox item is written in the
// bind's own transaction, sent from after the commit and deleted when done, and the hourly sweep drains what is left (a send that failed, or a
// Lambda that died after the commit).
import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GITHUB_INSTALL_NOTICE_OUTBOX_PK, GITHUB_INSTALL_REQUEST_QUEUE_PK, GITHUB_INSTALL_REQUEST_TTL_MS, githubAuditKey, githubDeliveryKey, githubInstallNoticeOutboxKey, githubInstallRequestKey, githubInstallRequestQueueKey, githubInstallationEverBoundKey, githubInstallationKey, orgGithubInstallRequestKey, orgGithubInstallationKey, orgMemberKey, orgMetaKey, type GithubInstallNoticeOutboxRecord, type GithubInstallRequestRecord, type GithubInstallationRecord, type OrgRole } from "@agentx/cloud-contracts";
import { agentXError, orgPk, type OrgId } from "@rovara-code/contracts";
import { auditGithubConnected } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent } from "../audit/outbox.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import {
  GITHUB_ISSUER, conditionFailed, consumeState, errorName, exchangeCode, expectedTrialResult, failedIndexes, isOwnerOrAdmin, log, readState, revokeUserToken, userGet,
  type GithubConnectionDependencies,
} from "./github-connect-support.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_RETENTION_MS = 30 * DAY_MS;
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

export function auditItem(tableName: string, orgId: OrgId, at: number, entry: Record<string, unknown>) {
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
 * (GitHub's `request` callback was not probed to carry one): `unattributed`, its own outcome and page, nothing recorded, no GitHub call, logged
 * `github.install_request_unattributed`.
 * The GitHub user token is revoked before this returns.
 */
export async function recordInstallRequest(
  deps: GithubConnectionDependencies,
  state: { stateHash: string },
  query: { code?: string | undefined },
): Promise<"requested" | "not_linked" | "unattributed" | "expired"> {
  const item = await readState(deps, state.stateHash);
  // A state that reached the confirm page (callbackAt) is used: a second callback with it is a replay.
  if (item === undefined || item.consumedAt !== undefined || item.callbackAt !== undefined || item.expiresAt <= deps.now()) return "expired";
  if (!await consumeState(deps, state.stateHash)) return "expired";
  const code = typeof query.code === "string" && query.code !== "" && query.code.length <= 512 ? query.code : undefined;
  const client = code === undefined ? undefined : await deps.app.oauthClient();
  if (code === undefined || client === undefined) {
    log(deps, { event: "github.install_request_unattributed", orgId: item.orgId, reason: code === undefined ? "no_code" : "no_oauth_client" });
    // No code: Rovara cannot say who asked, so it records nothing (an approval will arrive unattributed). The person is told so, not "expired".
    return code === undefined ? "unattributed" : "expired";
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
  // A re-ask by the same GitHub user overwrites the org's copy of the request (and deletes it when the org changed), so `GET /v1/app/github/requests`
  // shows only the latest asking. The history is not lost: every decision on a request is written to the org's GitHub audit trail, which never expires.
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
    ConditionExpression: "#status = :waiting AND expiresAt > :now AND developerId = :developerId AND orgId = :orgId AND requestedAt = :requestedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":decided": status, ":installationId": installation.id, ":accountLogin": current.account.login, ":approvedBy": { githubUserId: String(sender.id), login: sender.login },
      ":now": now, ":waiting": "waiting", ":developerId": request.developerId, ":orgId": request.orgId, ":requestedAt": request.requestedAt,
    },
  });
  const audit = auditItem(deps.tableName, request.orgId, now, {
    action: "install_request_bound",
    requester: { githubUserId: requesterId, login: requester.login, developerId: request.developerId },
    approver: { githubUserId: String(sender.id), login: sender.login },
    installationId: installation.id, accountLogin: current.account.login, deliveryId,
  });
  // The connection is recorded in the bind's own transaction. Both GitHub logins are personal data: the requester's belongs to the person
  // who asked (erased with them), the approver's and the account's to the org.
  const event = await tryAuditEvent(deps, async () => auditGithubConnected({
    orgId: request.orgId, actor: { kind: "member", id: request.developerId }, occurredAt: at, occurrence: deliveryId,
    installationId: String(installation.id), accountType: "Organization", result: await expectedTrialResult(deps, await deps.orgs.getOrg(request.orgId), requesterId),
    details: [
      { subject: request.developerId, fields: { requesterGithubLogin: requester.login } },
      { subject: "org", fields: { accountLogin: current.account.login, approverGithubLogin: sender.login } },
    ],
  }));
  // What must follow the bind, written with it: a commit without this item cannot happen, so the notice and the unlock are never lost.
  const outbox: GithubInstallNoticeOutboxRecord = {
    orgId: request.orgId, requesterDeveloperId: request.developerId, requesterGithubUserId: requesterId, requesterLogin: requester.login,
    accountLogin: current.account.login, approverLogin: sender.login, createdAt: now, attempts: 0, trialPending: true,
  };
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
        { Put: { TableName: deps.tableName, Item: { ...githubInstallNoticeOutboxKey(deliveryId), entityType: "GITHUB_INSTALL_NOTICE_OUTBOX", ...outbox }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...(event === undefined ? [] : auditPending(deps, event)),
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
  if (event !== undefined) await flushAuditEvents(deps, [event]);

  // After the commit: send now. Whatever fails here is not lost: the item stays, and the hourly sweep retries it. This never throws.
  try {
    await deliverOutboxItem(deps, deliveryId, outbox);
  } catch (error) {
    log(deps, { event: "github.install_request_notice_failed", orgId: request.orgId, error: errorName(error) });
  }
  return "bound";
}

/** A claim older than this is taken over: the worker that made it died (a Lambda lives far less). */
const OUTBOX_LEASE_MS = 15 * 60_000;
/** After this many tries an item is dropped (and logged), so one address that always bounces is not retried forever. */
const OUTBOX_MAX_ATTEMPTS = 5;
/** The sweep reads this many items a page, and keeps paging until the partition is done. */
const OUTBOX_SWEEP_PAGE = 100;

/**
 * Does what an outbox item says, at most once for each step that succeeds: the item is claimed first (conditional, so two workers never both
 * send), then the trial is unlocked and each owner still to be told is emailed. A step that failed stays on the item for the next try; when
 * nothing is left, or after OUTBOX_MAX_ATTEMPTS tries, the item is deleted. False when another worker holds the claim. Throws only when
 * DynamoDB does, before anything was sent.
 */
async function deliverOutboxItem(deps: GithubConnectionDependencies, deliveryId: string, seen: GithubInstallNoticeOutboxRecord): Promise<boolean> {
  const key = githubInstallNoticeOutboxKey(deliveryId);
  const claimedAt = deps.now();
  const attempts = seen.attempts + 1;
  let item: GithubInstallNoticeOutboxRecord;
  try {
    // The caller's copy may be stale (another worker may have released after it was read, with fewer owners left): work from the item
    // as the claim wrote it, never from the earlier read.
    const claimed = await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key,
      UpdateExpression: "SET claimedAt = :claimedAt, attempts = :attempts",
      ConditionExpression: "attempts = :seen AND (attribute_not_exists(claimedAt) OR claimedAt < :stale)",
      ExpressionAttributeValues: { ":claimedAt": claimedAt, ":attempts": attempts, ":seen": seen.attempts, ":stale": claimedAt - OUTBOX_LEASE_MS },
      ReturnValues: "ALL_NEW",
    })) as { Attributes?: GithubInstallNoticeOutboxRecord };
    if (claimed.Attributes === undefined) return false;
    item = claimed.Attributes;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }

  let trialPending = item.trialPending;
  if (trialPending) {
    try {
      await deps.unlockTrial({ orgId: item.orgId, githubUserId: item.requesterGithubUserId });
      trialPending = false;
    } catch (error) {
      // An account that already opened another org's trial will not change its answer; anything else is tried again.
      if ((error as { code?: unknown }).code === "TRIAL_GITHUB_USED") trialPending = false;
      else log(deps, { event: "github.install_request_trial_unlock_failed", orgId: item.orgId, error: errorName(error) });
    }
  }
  const pendingOwners = await tellOwners(deps, item);
  const done = !trialPending && pendingOwners?.length === 0;
  const gaveUp = !done && attempts >= OUTBOX_MAX_ATTEMPTS;
  if (gaveUp) log(deps, { event: "github.install_request_notice_failed", orgId: item.orgId, reason: "gave_up", attempts, trialPending });
  try {
    if (done || gaveUp) {
      await deps.documentClient.send(new DeleteCommand({
        TableName: deps.tableName, Key: key, ConditionExpression: "claimedAt = :claimedAt", ExpressionAttributeValues: { ":claimedAt": claimedAt },
      }));
      return true;
    }
    // What is still to do stays on the item, and the claim is released so the next sweep may take it.
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key,
      UpdateExpression: `SET trialPending = :trialPending${pendingOwners === undefined ? "" : ", pendingOwners = :pendingOwners"} REMOVE claimedAt`,
      ConditionExpression: "claimedAt = :claimedAt",
      ExpressionAttributeValues: { ":trialPending": trialPending, ":claimedAt": claimedAt, ...(pendingOwners === undefined ? {} : { ":pendingOwners": pendingOwners }) },
    }));
  } catch (error) {
    // The claim was taken over meanwhile (this worker ran past the lease): the other worker owns the item now.
    if (!conditionFailed(error)) throw error;
  }
  return false;
}

/**
 * The hourly sweep's second job: runs every outbox item that is left (a send that failed, or a Lambda that died after the bind committed).
 * An item claimed by a live worker is skipped. `drained` counts items finished (sent, or given up on).
 */
export async function drainInstallNoticeOutbox(deps: GithubConnectionDependencies): Promise<{ drained: number }> {
  if (!deps.cloud) return { drained: 0 };
  let drained = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": GITHUB_INSTALL_NOTICE_OUTBOX_PK }, ConsistentRead: true, Limit: OUTBOX_SWEEP_PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<GithubInstallNoticeOutboxRecord & { sk: string }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const entry of page.Items ?? []) {
      try {
        if (await deliverOutboxItem(deps, entry.sk, entry)) drained += 1;
      } catch (error) {
        log(deps, { event: "github.install_request_notice_failed", orgId: entry.orgId, error: errorName(error) });
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return { drained };
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

/**
 * One email to each owner (of `item.pendingOwners`, else every owner) who has an address on record. A failed send is logged by name. Returns the
 * owners still to be told: the ones whose send failed, or what it was before when the owners could not even be read (undefined means all).
 */
async function tellOwners(deps: GithubConnectionDependencies, item: GithubInstallNoticeOutboxRecord): Promise<string[] | undefined> {
  if (deps.notifyGithubConnected === undefined || deps.orgs.listMembers === undefined) return [];
  const stillToTell: string[] = [];
  try {
    const org = await deps.orgs.getOrg(item.orgId);
    const requester = await deps.identities.getDeveloper(item.requesterDeveloperId);
    const owners = (await deps.orgs.listMembers(item.orgId)).filter((member) => member.role === "owner" && (item.pendingOwners === undefined || item.pendingOwners.includes(member.developerId)));
    for (const owner of owners) {
      try {
        const email = (await deps.identities.getDeveloper(owner.developerId))?.email;
        if (email === undefined || email === "") continue;
        await deps.notifyGithubConnected({
          to: email, orgName: org?.name ?? "your organization", accountLogin: item.accountLogin, approverLogin: item.approverLogin,
          requester: { name: requester?.displayName ?? item.requesterLogin, ...(requester?.email === undefined || requester.email === "" ? {} : { email: requester.email }) },
        });
      } catch (error) {
        stillToTell.push(owner.developerId);
        log(deps, { event: "github.install_request_notice_failed", orgId: item.orgId, error: errorName(error) });
      }
    }
  } catch (error) {
    log(deps, { event: "github.install_request_notice_failed", orgId: item.orgId, error: errorName(error) });
    return item.pendingOwners;
  }
  return stillToTell;
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

/** A request still waiting this long after it was made is reminded, once (Plan 2, Task 14 Step 6). */
export const INSTALL_REQUEST_REMINDER_AFTER_MS = 2 * DAY_MS;
const REMINDER_SWEEP_LIMIT = 100;

/**
 * The hourly sweep. It reads the queue of waiting requests older than two days, and for each: a request that is no longer waiting, or is past
 * its expiry, only leaves the queue; one with no reminder yet gets `remindedAt` (conditional, so two overlapping sweeps remind once) and then
 * one email to the requester. The mark comes first, so a failed email is lost rather than repeated every hour: one reminder, at most.
 */
export async function sendInstallRequestReminders(deps: GithubConnectionDependencies): Promise<{ reminded: number; cleared: number }> {
  if (!deps.cloud) return { reminded: 0, cleared: 0 };
  const now = deps.now();
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk < :cutoff",
    ExpressionAttributeValues: { ":pk": GITHUB_INSTALL_REQUEST_QUEUE_PK, ":cutoff": String(now - INSTALL_REQUEST_REMINDER_AFTER_MS) },
    ConsistentRead: true, Limit: REMINDER_SWEEP_LIMIT,
  })) as { Items?: Array<{ pk: string; sk: string }> };
  let reminded = 0;
  let cleared = 0;
  for (const entry of page.Items ?? []) {
    const githubUserId = entry.sk.slice(entry.sk.indexOf("#") + 1);
    const queueKey = { pk: entry.pk, sk: entry.sk };
    try {
      const request = await readRequest(deps, githubUserId);
      const queued = entry.sk === githubInstallRequestQueueKey(request?.requestedAt ?? 0, githubUserId).sk;
      if (request === undefined || request.status !== "waiting" || request.expiresAt <= now || !queued) {
        // Left `waiting` (approved, cancelled, replaced, ended) or ran out: nothing to remind, and the entry goes.
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: queueKey } }] }));
        cleared += 1;
        continue;
      }
      // Still an owner or admin of an open org? A requester who was removed or demoted, or whose org closed, is not nudged toward an approval
      // that would be ignored: the entry goes and nothing is sent or marked.
      if (request.remindedAt === undefined && !await stillOwnerOrAdminOfOpenOrg(deps, request)) {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: queueKey } }] }));
        cleared += 1;
        continue;
      }
      if (request.remindedAt === undefined && await markReminded(deps, request, now)) {
        reminded += 1;
        const email = (await deps.identities.getDeveloper(request.developerId))?.email;
        if (email === undefined || email === "" || deps.remindGithubRequester === undefined) log(deps, { event: "github.install_request_reminder_skipped", orgId: request.orgId, reason: email === undefined || email === "" ? "no_email" : "no_sender" });
        else await deps.remindGithubRequester({ to: email, expiresAt: request.expiresAt, ...(request.requestedAccountLogin === undefined ? {} : { requestedAccountLogin: request.requestedAccountLogin }) });
      }
      // Reminded (now or before): the entry has done its work.
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: queueKey } }] }));
    } catch (error) {
      log(deps, { event: "github.install_request_reminder_failed", error: errorName(error) });
    }
  }
  return { reminded, cleared };
}

/** The same two reads the bind makes: the requester's live role in the request's org, and that the org is open. */
async function stillOwnerOrAdminOfOpenOrg(deps: GithubConnectionDependencies, request: GithubInstallRequestRecord): Promise<boolean> {
  const role = await liveRole(deps, request.orgId, request.developerId);
  if (role === undefined || !isOwnerOrAdmin(role)) return false;
  const org = await deps.orgs.getOrg(request.orgId);
  return org !== undefined && org.closedAt === undefined && org.closingAt === undefined;
}

/** Sets `remindedAt` on both items of a request that is still waiting and has none. False when another sweep, or a decision, got there first. */
async function markReminded(deps: GithubConnectionDependencies, request: GithubInstallRequestRecord, now: number): Promise<boolean> {
  const update = {
    UpdateExpression: "SET remindedAt = :now",
    ConditionExpression: "attribute_not_exists(remindedAt) AND #status = :waiting AND requestedAt = :requestedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":now": now, ":waiting": "waiting", ":requestedAt": request.requestedAt },
  };
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: { TableName: deps.tableName, Key: githubInstallRequestKey(request.githubUserId), ...update } },
        { Update: { TableName: deps.tableName, Key: orgGithubInstallRequestKey(request.orgId, request.githubUserId), ...update } },
      ],
    }));
    return true;
  } catch (error) {
    if (failedIndexes(error) !== undefined) return false;
    throw error;
  }
}
