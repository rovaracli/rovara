// Sharing a session (Plan 5 Task 4). A share with a person or a project applies at once, in one transaction with its index item, a `shared` event, the
// session's revision and the request's own item (R18). A share with the whole company is a pending change that waits on Plan 3's confirmation page
// (R66: a browser signed in within ten minutes, else an email code; a token never confirms) and answers `202 NEEDS_CONFIRMATION` with the ticketed link.
// Removing a share narrows at once. The route layer (Task 5) maps these to `PUT`, `DELETE` and `GET /v1/app/sessions/{id}/shares`.
import { undoCodeShare } from "../rovara-code/sharing.js";
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentPrincipalSchema, CHANGES_FEED_DAYS, INDEX_EXPIRY_ATTRIBUTE, LEVEL_WORDS, NeedsConfirmationSchema, SESSION_REVISION_CONFLICT_MESSAGE, SESSION_RETENTION_DAYS, SESSION_SHARES_MAX, SessionLevelSchema, agentSessionKey, agentXError, changesKey, cleanSessionName, orgProjectCatalogKey, principalKey, projectMemberKey, sessionEventId, sessionLevelRequiredMessage, sessionRequestKey, sessionViewerOnlyMessage, sharedSessionsKey, type AgentPrincipal, type AgentSessionRecord, type ApprovalId, type NeedsConfirmation, type OrgId, type SessionLevel, atLeast, hideEmailAddresses } from "@rovara-code/contracts";
import { orgMemberKey, OrgRoleSchema, type AuditProof, type OrgRole } from "@agentx/cloud-contracts";
import type { DeveloperSignInStore } from "../developer/store.js";
import { grantRoleOf } from "../developer/project-roles.js";
import {
  confirmUrlFor,
  createPendingChange,
  registerApprovalSubjectHandler,
  registerApproverRule,
  type AnyApprovalRecord,
  type ApprovalDependencies,
  type SessionShareOrgSubject,
} from "../agents/approvals.js";
import { failedIndexes, type Item, type TransactItem } from "../agents/table-writes.js";
import { auditSessionSharedOrg } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { effectiveOwnerOf, readSessionShares, requireSessionLevel, resolveSessionAccess, sessionLevelOf, type SessionAccessDependencies, type SessionCaller, type SessionShareRow } from "./access.js";
import { sameMember } from "../agents/lifecycle.js";
import { removeFollower } from "./followers.js";
import { sessionEventItem } from "./store.js";

export interface SessionShareDependencies extends SessionAccessDependencies {
  /** Existing AI-tool turn table; access changes fail closed when it is absent. */
  turnRecordsTableName?: string;
  /** Where the names in events and the people a share names are read from. */
  signInStore: Pick<DeveloperSignInStore, "getDeveloper">;
}

/** Who shares: `DeveloperCaller` fits. `orgRole` is only passed on to Plan 3's link minting, which reads it live itself. */
export interface ShareCaller extends SessionCaller {
  name: string;
  orgRole?: OrgRole;
  /** Set only by the web boundary, for a request that carried a live browser session cookie and its CSRF token (never by a token): Merge merges at once for it, and for nothing else. */
  browserSession?: true;
}

export type SessionShareReply =
  | { status: 200; body: { share: SessionShareRow } }
  | { status: 202; body: NeedsConfirmation };

const SHARE_RULE = "session_share_org";
/** How long a request item answers a repeat; the State table's TTL removes it after that. */
const REQUEST_MEMORY_DAYS = 7;
const DAY_SECONDS = 86_400;
const NOT_A_MEMBER = "That person isn't in your company.";
const TOO_MANY = `A session can be shared with at most ${String(SESSION_SHARES_MAX)} people or groups.`;

const PutBodySchema = z.object({ requestId: z.string().uuid(), principal: AgentPrincipalSchema, level: SessionLevelSchema }).strict();
const PRINCIPAL_KEY = /^(?:MEMBER#[a-f0-9]{64}|PROJECT#[a-z][a-z0-9-]{0,62}|ORG)$/;

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const secondsOf = (ms: number) => Math.floor(ms / 1000);
const isoOf = (ms: number) => new Date(ms).toISOString();
const sameKey = (a: AgentPrincipal, b: AgentPrincipal) => principalKey(a) === principalKey(b);

function parseBody(body: unknown): z.infer<typeof PutBodySchema> {
  const parsed = PutBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

const getItem = async (deps: SessionShareDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** When an item written for an ended session expires: with the session's own record, a year after it ended (m22). Undefined for an open session. */
const endedExpiry = (session: AgentSessionRecord): number | undefined => (session.endedAt === undefined ? undefined : secondsOf(Date.parse(session.endedAt)) + SESSION_RETENTION_DAYS * DAY_SECONDS);

/** Words for who a share is with, in the event: a person by name, a project, or everyone. */
async function whoWords(deps: SessionShareDependencies, principal: AgentPrincipal): Promise<string> {
  if (principal.kind === "org") return "everyone in your company";
  if (principal.kind === "project") return `the ${principal.project} project`;
  return await nameOf(deps, principal.developerId) ?? "a teammate";
}

async function nameOf(deps: SessionShareDependencies, developerId: string): Promise<string | undefined> {
  try {
    const record = await deps.signInStore.getDeveloper(developerId);
    return record === undefined ? undefined : cleanSessionName(record.displayName);
  } catch {
    return undefined;
  }
}

/** Code tasks use the session sharing rules even through their legacy surfaces. */
async function codeSession(deps: SessionShareDependencies, session: AgentSessionRecord): Promise<boolean> {
  if (session.subject.kind !== "task") return false;
  const task = await getItem(deps, { pk: `DEVTASK#${session.subject.taskId}`, sk: "META" });
  // A task that is missing or belongs to another org is no Code task of this one: the session keeps Plan 5's own sharing rules (a take-over recorded on a foreign task is ignored the same way).
  if (task === undefined || task["orgId"] !== session.orgId) return false;
  return (task["workflow"] as { definitionId?: string } | undefined)?.definitionId === "agentx-task-to-pr";
}

// ---- a share's checks

/** The person is a current member of the org (their member record), with the role it names. */
async function memberRole(deps: SessionShareDependencies, orgId: OrgId, developerId: string): Promise<OrgRole | undefined> {
  const role = OrgRoleSchema.safeParse((await getItem(deps, orgMemberKey(orgId, developerId)))?.["role"]);
  return role.success ? role.data : undefined;
}

/** Refuses a principal that isn't in the company, and a `use` or `edit` share to a project viewer of the session's project (m8). A local session's registration checks its first shares the same way (Task 18). */
export async function checkPrincipal(deps: SessionShareDependencies, orgId: OrgId, session: Pick<AgentSessionRecord, "project">, principal: AgentPrincipal, level: SessionLevel): Promise<void> {
  if (principal.kind === "member") {
    const role = await memberRole(deps, orgId, principal.developerId);
    // The words never name the person: an id from another company must not reveal who it is.
    if (role === undefined) throw agentXError("CONFIG_INVALID", NOT_A_MEMBER);
    if (level !== "view" && session.project !== undefined) {
      const grant = grantRoleOf(await getItem(deps, projectMemberKey(orgId, principal.developerId, session.project)));
      // An org owner or admin is a maintainer whatever grant they hold (m-1).
      const effective = role === "owner" || role === "admin" ? "maintainer" : grant ?? await deps.projectMembers.roleOf(orgId, session.project, { developerId: principal.developerId, orgRole: role });
      if (effective === "viewer") throw agentXError("SESSION_LEVEL_REQUIRED", sessionViewerOnlyMessage(session.project));
    }
  } else if (principal.kind === "project" && await getItem(deps, orgProjectCatalogKey(orgId, principal.project)) === undefined) {
    throw agentXError("PROJECT_NOT_FOUND", `project \`${principal.project}\` doesn't exist in this AgentX`);
  }
}

// ---- writing one share

interface ApplyInput {
  narrowingOrg?: true;
  orgId: OrgId;
  session: AgentSessionRecord;
  sharer: { developerId: string; name: string };
  principal: AgentPrincipal;
  level: SessionLevel;
  /** Names this write: its request item, its event and its notice are keyed by it, so a repeat of it writes the same ones. */
  requestId: string;
  fingerprint: string;
  /**
   * Set only by the confirmation of a share with the whole company (Task 22): the ledger's outbox and the decision's proof. The event goes in this write's transaction, with the
   * approval's id as its occurrence (`requestId` is that id there). A share with a person or a project is not recorded, so its callers leave this out.
   */
  audit?: { deps: AuditDeps; proof?: AuditProof };
}

/** The deterministic position of a change notice among the owner's notices written in one instant (the feed's own counter is Task 8's). */
const noticeNumber = (seed: string) => Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 1_000_000;

/**
 * Writes one share in one transaction: the session's revision (conditional, so a lost race is the conflict text), the share, its index item, the
 * `shared` event, a notice with an undo for the owner when someone else shared it, the audit item of a company-wide share, and the request's item last. A share already at that level writes
 * only the request item. A lost race on the request item is a repeat: its stored outcome is returned.
 */
async function applyShare(deps: SessionShareDependencies, input: ApplyInput): Promise<SessionShareRow> {
  const { orgId, session, principal, level } = input;
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const expiry = endedExpiry(session);
  const row: SessionShareRow = { principal, level, sharedBy: input.sharer, sharedAt: at };
  const requestItem = (result: unknown): TransactItem => ({
    Put: {
      TableName: deps.tableName,
      Item: {
        ...sessionRequestKey(orgId, input.sharer.developerId, input.requestId), entityType: "SESSION_REQUEST", orgId, fingerprint: input.fingerprint, result, at,
        [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + REQUEST_MEMORY_DAYS * DAY_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(pk) OR #expires <= :now",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":now": secondsOf(nowMs) },
    },
  });

  const shares = await readSessionShares(deps, orgId, session.sessionId);
  const existing = shares.find((share) => sameKey(share.principal, principal));
  if (input.narrowingOrg && (principal.kind !== "org" || existing === undefined || existing.level === level || !atLeast(existing.level, level))) {
    throw agentXError("SESSION_REVISION_CONFLICT", SESSION_REVISION_CONFLICT_MESSAGE);
  }
  if (existing !== undefined && existing.level === level) {
    await send(deps, [requestItem({ share: existing })], undefined, input);
    return existing;
  }
  if (existing === undefined && shares.length >= SESSION_SHARES_MAX) throw agentXError("CONFIG_INVALID", TOO_MANY);

  const code = await codeSession(deps, session);
  const widening = existing === undefined || !atLeast(existing.level, level);
  const key = principalKey(principal);
  const stamped = (item: Item): Item => (expiry === undefined ? item : { ...item, [INDEX_EXPIRY_ATTRIBUTE]: expiry });
  const put = (item: Item, condition?: string): TransactItem => ({ Put: { TableName: deps.tableName, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) } });
  const who = await whoWords(deps, principal);
  const items: TransactItem[] = [
    {
      Update: {
        TableName: deps.tableName, Key: agentSessionKey(orgId, session.sessionId, "META"), UpdateExpression: "ADD #revision :one",
        ConditionExpression: "attribute_exists(pk) AND #revision = :revision", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":one": 1, ":revision": session.revision },
      },
    },
    put(stamped({ ...agentSessionKey(orgId, session.sessionId, `SHARE#${key}`), entityType: "AGENT_SESSION_SHARE", orgId, sessionId: session.sessionId, principal, level, sharedBy: input.sharer, sharedAt: at })),
    put(stamped({ ...sharedSessionsKey(orgId, principal, session.sessionId), entityType: "SHARED_SESSION", orgId, sessionId: session.sessionId, principal, level, sharedAt: at })),
    sessionEventItem(deps, { orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("shared", `${input.sharer.developerId}|${input.requestId}`), at, type: "shared",
      actor: { kind: "member", developerId: input.sharer.developerId, name: cleanSessionName(input.sharer.name) ?? "Someone" },
      text: `${cleanSessionName(input.sharer.name) ?? "Someone"} shared this session with ${who} (${LEVEL_WORDS[level]})`,
    }),
  ];
  if (input.narrowingOrg && existing !== undefined) {
    const grant = items[1]!.Put!;
    grant.ConditionExpression = "attribute_exists(pk) AND #priorLevel = :priorLevel AND sharedAt = :priorAt";
    grant.ExpressionAttributeNames = { "#priorLevel": "level" };
    grant.ExpressionAttributeValues = { ":priorLevel": existing.level, ":priorAt": existing.sharedAt };
  }
  // The owner who is told is the effective one, who may be the person that took the session over (m-2).
  const ownerId = await effectiveOwnerOf(deps, session);
  if (input.sharer.developerId !== ownerId && (!code || widening)) {
    // Ids, a kind and a revision only: a notice never carries a name or a title. `undo` is `DELETE …/shares/<principalKey>`.
    items.push(put({
      ...changesKey(orgId, ownerId, at, noticeNumber(`${session.sessionId}|${input.requestId}`)), entityType: "CHANGE_NOTICE", orgId, type: "session_shared",
      sessionId: session.sessionId, revision: session.revision + 1, by: input.sharer.developerId, undo: { principalKey: key }, at,
      [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + CHANGES_FEED_DAYS * DAY_SECONDS,
    }));
  }
  const events = input.audit === undefined ? [] : await tryAuditEvents(input.audit.deps, () => [auditSessionSharedOrg({
    orgId, actor: auditActorOf(input.sharer.developerId), occurredAt: at, occurrence: input.requestId, ...(input.audit?.proof === undefined ? {} : { proof: input.audit.proof }),
    related: [ownerId, ...(session.subject.kind === "task" ? [session.subject.taskId] : session.subject.kind === "chain" ? [session.subject.chainRunId] : [])],
    sessionId: session.sessionId, level,
  })]);
  if (input.audit !== undefined) items.push(...events.flatMap((event) => auditPending(input.audit!.deps, event)));
  items.push(requestItem({ share: row }));
  // A repeat of a request that already committed wrote nothing, and its events were flushed by the call that wrote them.
  if (await send(deps, items, 0, input) === "written" && input.audit !== undefined) await flushAuditEvents(input.audit.deps, events);
  return row;
}

/** Sends the transaction; a cancelled one is read for what it means: the session moved (the conflict text), or this very request already committed (its stored outcome). */
async function send(deps: SessionShareDependencies, items: TransactItem[], revisionIndex: number | undefined, input: ApplyInput): Promise<"written" | "repeat"> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return "written";
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    if (failed.has(items.length - 1)) {
      const earlier = await readRequest(deps, input.orgId, input.sharer.developerId, input.requestId);
      if (earlier !== undefined) {
        if (earlier.fingerprint !== input.fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for a different request");
        return "repeat";
      }
    }
    if ((input.narrowingOrg && failed.has(1)) || (revisionIndex !== undefined && failed.has(revisionIndex))) throw agentXError("SESSION_REVISION_CONFLICT", SESSION_REVISION_CONFLICT_MESSAGE);
    throw error;
  }
}

async function readRequest(deps: SessionShareDependencies, orgId: OrgId, developerId: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
  const item = await getItem(deps, sessionRequestKey(orgId, developerId, requestId));
  const expires = item?.[INDEX_EXPIRY_ATTRIBUTE];
  if (item === undefined || (typeof expires === "number" && expires <= secondsOf(deps.now()))) return undefined;
  return { fingerprint: String(item["fingerprint"]), result: item["result"] };
}

/**
 * The `202` answer for a pending change the caller must confirm in a browser: Plan 3's ticketed link for them (`mintConfirmUrl`; the bare link when it can't mint one, since
 * the page's own sign-in step takes it from there) and the change's words. A take-over answers the same way (Task 12b).
 */
export async function confirmationReply(approvals: ApprovalDependencies, caller: ShareCaller, record: { approvalId: ApprovalId; changes: string[] }): Promise<{ status: 202; body: NeedsConfirmation }> {
  let confirmUrl = confirmUrlFor(approvals, record);
  if (approvals.mintConfirmUrl !== undefined) {
    try {
      confirmUrl = await approvals.mintConfirmUrl({ orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole ?? "member" }, record.approvalId);
    } catch (error) {
      // The bare link still works: the page's own sign-in step takes it from there.
      if (!(error instanceof Error && error.name === "AgentXError")) throw error;
    }
  }
  return { status: 202, body: NeedsConfirmationSchema.parse({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl, changes: record.changes }) };
}

// ---- PUT /v1/app/sessions/{id}/shares

/**
 * Shares the session. The caller needs `edit` (the owner always has it). A person or a project applies at once; the whole company answers `202` with
 * the link where the sharer confirms it (`approvals` is what that needs; without it the answer is `RUNTIME_UNAVAILABLE`). The same `requestId` with the
 * same body answers the first outcome and writes nothing; with another body it is `IDEMPOTENCY_CONFLICT`.
 */
export async function putSessionShare(deps: SessionShareDependencies, caller: ShareCaller, sessionId: string, body: unknown, approvals?: ApprovalDependencies): Promise<SessionShareReply> {
  const input = parseBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "share it");
  const { session } = access;
  const fingerprint = sha256({ op: "share", sessionId: session.sessionId, principal: input.principal, level: input.level });

  const orgShare = input.principal.kind === "org"
    ? (await readSessionShares(deps, caller.orgId, session.sessionId)).find((share) => share.principal.kind === "org") : undefined;
  const narrowingCodeOrg = orgShare !== undefined && atLeast(orgShare.level, input.level) && orgShare.level !== input.level && await codeSession(deps, session);
  if (input.principal.kind === "org" && !narrowingCodeOrg) {
    if (approvals === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Sharing with everyone isn't available right now.");
    const existing = (await readSessionShares(deps, caller.orgId, session.sessionId)).find((share) => share.principal.kind === "org");
    if (existing?.level === input.level) return { status: 200, body: { share: existing } };
    const record = await createPendingChange(approvals, {
      orgId: caller.orgId, requestId: input.requestId, requestedBy: caller.developerId,
      subject: { kind: SHARE_RULE, sessionId: session.sessionId, level: input.level },
      changes: [`Share "${hideEmailAddresses(session.title)}" with everyone in your company (${LEVEL_WORDS[input.level]})`],
      approvers: { kind: "rule", rule: SHARE_RULE, candidates: [caller.developerId] },
    });
    // A replay of a request that was decided since is not waiting any more.
    if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
    return confirmationReply(approvals, caller, record);
  }

  const earlier = await readRequest(deps, caller.orgId, caller.developerId, input.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for a different request");
    return { status: 200, body: earlier.result as { share: SessionShareRow } };
  }
  await checkPrincipal(deps, caller.orgId, session, input.principal, input.level);
  const share = await applyShare(deps, { orgId: caller.orgId, session, sharer: { developerId: caller.developerId, name: caller.name }, principal: input.principal, level: input.level, requestId: input.requestId, fingerprint, ...(narrowingCodeOrg ? { narrowingOrg: true as const } : {}) });
  return { status: 200, body: { share } };
}

// ---- GET and DELETE

/** `GET /v1/app/sessions/{id}/shares`: who the session is shared with, to anyone who can view it. */
export async function listSessionShares(deps: SessionShareDependencies, caller: SessionCaller, sessionId: string): Promise<{ shares: SessionShareRow[] }> {
  const { session } = await requireSessionLevel(deps, caller, sessionId, "view", "see who it is shared with");
  const shares = await readSessionShares(deps, caller.orgId, session.sessionId);
  return { shares: shares.sort((a, b) => (a.sharedAt < b.sharedAt ? -1 : a.sharedAt > b.sharedAt ? 1 : principalKey(a.principal) < principalKey(b.principal) ? -1 : 1)) };
}

/**
 * `DELETE /v1/app/sessions/{id}/shares/{principalKey}`: narrows at once. The owner, an `edit` holder and the person who made the share may remove
 * it. A share that isn't there is `{ removed: false }` and writes nothing. Followers whose level falls to none are removed afterwards (m6): a follower
 * is derived state, and the notice path re-checks levels too.
 */
export async function deleteSessionShare(deps: SessionShareDependencies, caller: SessionCaller & { name?: string }, sessionId: string, key: string): Promise<{ removed: boolean }> {
  if (key.startsWith("SLACK#")) return undoCodeShare(deps, caller, sessionId, key);
  if (!PRINCIPAL_KEY.test(key)) throw agentXError("CONFIG_INVALID", "principal: is not a person, a project or the company");
  const access = await resolveSessionAccess(deps, caller, sessionId);
  const { session } = access;
  const existing = (await readSessionShares(deps, caller.orgId, session.sessionId)).find((share) => principalKey(share.principal) === key);
  if (existing === undefined) return { removed: false };
  // The person who made the share may take it back, and a person merged into another since is the same person (the merge mover rewrites `sharedBy` where it finds it; this covers the rest).
  if (!access.owner && access.level !== "edit" && !await sameMember(deps, caller.orgId, existing.sharedBy.developerId, caller.developerId)) {
    throw agentXError("SESSION_LEVEL_REQUIRED", sessionLevelRequiredMessage("edit", "remove this share", access.effectiveOwner.name));
  }
  const name = cleanSessionName(caller.name ?? await nameOf(deps, caller.developerId) ?? "") ?? "Someone";
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const items: TransactItem[] = [
    {
      Update: {
        TableName: deps.tableName, Key: agentSessionKey(caller.orgId, session.sessionId, "META"), UpdateExpression: "ADD #revision :one",
        ConditionExpression: "attribute_exists(pk) AND #revision = :revision", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":one": 1, ":revision": session.revision },
      },
    },
    { Delete: { TableName: deps.tableName, Key: agentSessionKey(caller.orgId, session.sessionId, `SHARE#${key}`), ConditionExpression: "attribute_exists(pk)" } },
    { Delete: { TableName: deps.tableName, Key: sharedSessionsKey(caller.orgId, existing.principal, session.sessionId) } },
    sessionEventItem(deps, { orgId: caller.orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("shared", `remove|${key}|${String(session.revision)}`), at, type: "shared",
      actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} stopped sharing this session with ${await whoWords(deps, existing.principal)}`,
    }),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    // Someone removed it first: it is gone, which is what was asked.
    if (failed.has(1) && !failed.has(0)) return { removed: false };
    if (failed.has(0)) throw agentXError("SESSION_REVISION_CONFLICT", SESSION_REVISION_CONFLICT_MESSAGE);
    throw error;
  }
  await dropFollowersWithoutAccess(deps, session, existing.principal);
  return { removed: true };
}

/**
 * Deletes the `FOLLOWER#` items of people who can no longer see the session (m6). Only the people the removed share could have covered are looked at:
 * the member of a member share, else every follower. Each is judged on the full path, so a person who reaches the project through its Slack channel
 * keeps their follow (I-1); the read-only path is for the realtime authorizer, which makes no Slack call.
 */
async function dropFollowersWithoutAccess(deps: SessionShareDependencies, session: AgentSessionRecord, removed: AgentPrincipal): Promise<void> {
  const prefix = "FOLLOWER#";
  const judge = async (sk: string): Promise<void> => {
    const developerId = sk.slice(prefix.length);
    if (await sessionLevelOf(deps, { orgId: session.orgId, developerId }, session, {}) !== "none") return;
    await removeFollower(deps, session, developerId);
  };
  if (removed.kind === "member") {
    const sk = `${prefix}${removed.developerId}`;
    if (await getItem(deps, agentSessionKey(session.orgId, session.sessionId, sk as `FOLLOWER#${string}`)) !== undefined) await judge(sk);
    return;
  }
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": agentSessionKey(session.orgId, session.sessionId, "META").pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (typeof item.sk === "string" && item.sk.startsWith(prefix)) await judge(item.sk);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

// ---- what confirming a company-wide share does

const isChange = (record: AnyApprovalRecord): record is Extract<AnyApprovalRecord, { kind: "change" }> => record.kind === "change";

/** Registers the rule and the handler behind `session_share_org`. Safe to call more than once. */
export function registerSessionShareApprovals(): void {
  // The asker and nobody else, while they can still share the session: read now, never from what they could do when they asked.
  registerApproverRule(SHARE_RULE, async (deps, record, caller) => {
    if (!isChange(record) || record.subject.kind !== SHARE_RULE || caller.orgId !== record.orgId || caller.developerId !== record.requestedBy) return false;
    if (deps.agentSessions === undefined) return false;
    try {
      await requireSessionLevel(deps.agentSessions, caller, record.subject.sessionId, "edit", "share it");
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "AgentXError") return false;
      throw error;
    }
  });
  registerApprovalSubjectHandler(SHARE_RULE, async (deps, record, decision) => {
    if (!isChange(record)) return;
    const sessions = deps.agentSessions;
    if (sessions === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Sharing sessions isn't available right now.");
    // A record nobody has decided is never applied: the share would be credited to the person who asked.
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
    const subject = record.subject as SessionShareOrgSubject;
    const decider = { orgId: record.orgId, developerId: record.decidedBy };
    // Still allowed to share it now; a session that changed hands or a role that changed since is refused with its words.
    const { session } = await requireSessionLevel(sessions, decider, subject.sessionId, "edit", "share it");
    const existing = (await readSessionShares(sessions, record.orgId, subject.sessionId)).find((share) => share.principal.kind === "org");
    if (existing?.level === subject.level) return;
    await applyShare(sessions, {
      orgId: record.orgId, session, sharer: { developerId: decider.developerId, name: await nameOf(sessions, decider.developerId) ?? "Someone" },
      principal: { kind: "org" }, level: subject.level, requestId: record.approvalId,
      fingerprint: sha256({ op: "share", sessionId: subject.sessionId, principal: { kind: "org" }, level: subject.level }),
      audit: { deps, ...(decision?.proof === undefined ? {} : { proof: decision.proof }) },
    });
  });
}

