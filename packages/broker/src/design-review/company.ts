// Design review stage (DR-FU4): the company's design review policy, written by company admins only. It lives on the same revisioned item as the stricter-only lock (`lock.ts`, DESIGNREVIEW#LOCK):
//   - `allowed`      whether design review may run for ANY project of the company (default no).
//   - `lock`         the stricter-only lock fields (`DesignReviewLockSchema`).
// `allowed` is company POLICY, not a lock field. There is no company default mode and no mode floor (owner decision): once a company admin has allowed design review, each project's maintainers turn it on (Auto or
// Always) or off for their own project, and a project with no setting of its own is Off.
//
// Who may do what (the shared company rule, `org/second-person-approval.ts`):
//   - TIGHTENING needs only the caller's OWN live owner or admin authority, with no roster read, so the company's off switch always works (a legacy company, a young tracking record): turning `allowed` OFF and any lock
//     change that only adds or tightens a field. Those apply at once.
//   - LOOSENING (turning `allowed` ON, or any lock change that removes or loosens a field) is a decision for two people. A DIFFERENT eligible admin confirms it. The one exception is the shared sole-owner exception, taken
//     from `trySecondPersonTimed` and nothing else: the only owner, the only eligible person, and nobody eligible lost in the last 24 hours (so demoting the other admin does not open it). Anything else with nobody to
//     confirm is refused, never applied.
// At most ONE request waits at a time (one item, `DESIGNREVIEW#CHANGE`); it expires after 7 days; its proposer or any admin can withdraw it; turning `allowed` OFF withdraws it.
// Every change commits in ONE transaction with its audit item and is conditional on the item's revision (`POLICY_STALE` otherwise); a refused write changes nothing. Answers are fixed words.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { orgMetaKey, type EditionPolicy, type OrgId } from "@agentx/contracts";
import { auditCompanyDesignReviewPolicyChanged, auditCompanyDesignReviewPolicyProposed, auditOccurrence } from "../audit/events.js";
import { SYSTEM_ACTOR } from "../audit/plan3-hooks.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { trySecondPersonTimed } from "../lessons/approve.js";
import type { Tier0Authority } from "../lessons/tier0-setting.js";
import { idIn, sameId } from "../lessons/types.js";
import {
  DESIGN_REVIEW_LOCK_SK, DesignReviewLockSchema, checkDesignReviewLockWrite, parseStoredLock, lockRevisionCheck, lockedFields, readDesignReviewCompany,
  type DesignReviewCompanyRead, type DesignReviewLock, type DesignReviewLockTable,
} from "./lock.js";

export type DesignReviewPolicyFailure =
  | "not_eligible" | "eligibility_unavailable" | "second_person_required" | "sole_owner_cool_off" | "audit_unavailable" | "already_open" | "expired" | "not_found" | "not_pending"
  | "stale" | "unreadable" | "group_not_available" | "invalid";
export type PolicyRefusal = { ok: false; code: DesignReviewPolicyFailure; /** For `sole_owner_cool_off`: when the exception opens (ISO). */ availableAt?: string };

export interface DesignReviewCompanyDeps extends AuditDeps, DesignReviewLockTable {
  now(): number;
  edition?: EditionPolicy | undefined;
  /** The company's roster as the shared second-person evidence reads it. Needed only for a LOOSENING and for confirming one. */
  authority?: Tier0Authority | undefined;
  /** The caller's OWN live authority as a company owner or admin, fenced (no roster). Throws FORBIDDEN for anyone else. Needed for every change. */
  actor?: ((orgId: string, by: string) => Promise<TransactItem[]>) | undefined;
  newId?: () => string;
}

export const DESIGN_REVIEW_CHANGE_TTL_MS = 7 * 86_400_000;
/** The one waiting request of a company. One item that a new request replaces once the old one is settled or expired, so old requests never pile up (and need no TTL). */
const CHANGE_SK = "DESIGNREVIEW#CHANGE";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const changeKey = (orgId: string) => ({ pk: orgPk(orgId), sk: CHANGE_SK });
const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException"
  || (error.name === "TransactionCanceledException" && ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")));

/** A request waiting for a different admin: to allow design review, or to loosen the lock to `lock`. */
export interface PolicyChange { id: string; kind: "allowed" | "lock"; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled"; lock?: DesignReviewLock; fromLock?: DesignReviewLock }

function parseChange(item: Record<string, unknown> | undefined): PolicyChange | undefined {
  if (item === undefined || item["entityType"] !== "DESIGN_REVIEW_POLICY_CHANGE" || typeof item["id"] !== "string" || typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
  const state = item["state"], kind = item["kind"];
  if (state !== "pending" && state !== "applied" && state !== "cancelled") return undefined;
  if (kind !== "allowed" && kind !== "lock") return undefined;
  const lock = item["lock"] === undefined ? undefined : parseStoredLock(item["lock"]);
  const fromLock = item["fromLock"] === undefined ? undefined : parseStoredLock(item["fromLock"]);
  if (kind === "lock" && (lock?.success !== true || fromLock?.success !== true)) return undefined;
  return { id: item["id"], kind, proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state, ...(lock?.success === true ? { lock: lock.data } : {}), ...(fromLock?.success === true ? { fromLock: fromLock.data } : {}) };
}

/** The company's waiting request (any state), if it ever had one. */
async function getChange(table: DesignReviewLockTable, orgId: string): Promise<PolicyChange | undefined> {
  return parseChange((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: changeKey(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item);
}

/** The company's open (pending, unexpired) request, if any. */
export async function openPolicyChange(table: DesignReviewLockTable, orgId: string, now: number): Promise<PolicyChange | undefined> {
  const change = await getChange(table, orgId);
  return change !== undefined && change.state === "pending" && change.expiresAt > now ? change : undefined;
}

/** What a page shows: the policy, the lock, and the revision a change is made against. A stored item that does not read is said so, never shown as the defaults. */
export interface DesignReviewCompanyView {
  revision: number | undefined;
  allowed: boolean;
  lock: DesignReviewLock;
  lockedFields: string[];
  unreadable: boolean;
}
export function companyViewOf(read: DesignReviewCompanyRead): DesignReviewCompanyView {
  const lock = read.lock.kind === "lock" ? read.lock.lock : {};
  return {
    revision: read.revision, allowed: read.policy.allowed, lock, lockedFields: lockedFields(lock),
    unreadable: read.lock.kind === "unreadable" || read.policyUnreadable,
  };
}

function itemOf(orgId: string, revision: number, lock: DesignReviewLock, policy: { allowed: boolean }, by: string, at: string) {
  return { pk: orgPk(orgId), sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", orgId, revision, lock, policy, updatedAt: at, updatedBy: by };
}

/** The Put of the company item under the revision it was read at: a missing item must still be missing, an existing one must still be at that revision. */
function putCompany(deps: DesignReviewLockTable, orgId: string, read: DesignReviewCompanyRead, item: Record<string, unknown>): TransactItem {
  return {
    Put: {
      TableName: deps.tableName, Item: item,
      ConditionExpression: read.revision === 0 && read.lock.kind === "none" ? "attribute_not_exists(pk)" : "#revision = :expected",
      ...(read.revision === 0 && read.lock.kind === "none" ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": read.revision } }),
    },
  };
}

/** Commits the transaction with its audit items, then sends the events. A lost race is `stale`. */
async function commit(deps: DesignReviewCompanyDeps, items: TransactItem[], events: Parameters<typeof auditPending>[1][]): Promise<boolean> {
  const audit: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...events.flatMap((event) => auditPending(audit, event))] }));
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
  await flushAuditEvents(audit, events);
  return true;
}

const lockCount = (lock: DesignReviewLock): number => lockedFields(lock).length;
const sameLock = (left: DesignReviewLock, right: DesignReviewLock): boolean => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
const TIER_RANK = { light: 0, standard: 1, thorough: 2 } as const;

/**
 * Whether going from `current` to `next` LOOSENS any lock field: a field removed or lowered, a ceiling raised, skipping allowed again, or the approver group changed or removed. A change that only adds or tightens fields
 * does not. Mixed changes loosen. Pure.
 */
export function lockLoosens(current: DesignReviewLock, next: DesignReviewLock): boolean {
  if (current.tierAtLeast !== undefined && (next.tierAtLeast === undefined || TIER_RANK[next.tierAtLeast] < TIER_RANK[current.tierAtLeast])) return true;
  if (current.allowSkip === false && next.allowSkip !== false) return true;
  if (current.capCeilingUsd !== undefined && (next.capCeilingUsd === undefined || next.capCeilingUsd > current.capCeilingUsd)) return true;
  if (current.approverGroupId !== undefined && next.approverGroupId !== current.approverGroupId) return true;
  return false;
}

/** The caller's own live authority: the commit conditions that pin it, or why not. */
async function actorOf(deps: DesignReviewCompanyDeps, orgId: string, by: string): Promise<{ ok: true; conditions: TransactItem[] } | PolicyRefusal> {
  if (deps.actor === undefined) return { ok: false, code: "eligibility_unavailable" };
  try {
    return { ok: true, conditions: await deps.actor(orgId, by) };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code === "FORBIDDEN" ? "not_eligible" : "eligibility_unavailable" };
  }
}

async function groupOf(deps: DesignReviewCompanyDeps, orgId: string, who: { proposerId: string; approverId: string }) {
  if (deps.authority === undefined) return undefined;
  const group = await deps.authority.eligibility({ kind: "company", workspaceId: orgId }, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}

type Group = NonNullable<Awaited<ReturnType<typeof groupOf>>>;
/**
 * The decision for a LOOSENING asked by one admin, from the shared rule alone: `alone` (the only owner, the only eligible person, nobody lost in 24 hours), `request` (a different eligible admin can confirm), or a refusal
 * (the cool-off, with the time it opens; or nobody else is eligible and the exception does not apply, so there is nobody who could ever confirm).
 */
async function looseningDecision(deps: DesignReviewCompanyDeps, orgId: string, by: string, at: number): Promise<{ ok: true; how: "alone" | "request"; group: Group } | PolicyRefusal> {
  const group = await groupOf(deps, orgId, { proposerId: by, approverId: by });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, by)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, by, by, at);
  if (decision.ok) return decision.mode === "sole_owner_exception" ? { ok: true, how: "alone", group } : { ok: true, how: "request", group };
  if (decision.code === "sole_owner_cool_off") return { ok: false, code: "sole_owner_cool_off", ...(decision.availableAt === undefined ? {} : { availableAt: decision.availableAt }) };
  if (decision.code === "eligibility_unavailable") return { ok: false, code: "eligibility_unavailable" };
  // Second person required: a request is useful only if somebody else could confirm it.
  return group.eligibleIds.length > 1 ? { ok: true, how: "request", group } : { ok: false, code: "second_person_required" };
}

/** The Put that opens the one waiting request. It replaces a settled or expired one, never a pending one that has not expired. */
function putChange(deps: DesignReviewCompanyDeps, orgId: string, change: PolicyChange): TransactItem {
  return {
    Put: {
      TableName: deps.tableName,
      Item: {
        ...changeKey(orgId), entityType: "DESIGN_REVIEW_POLICY_CHANGE", id: change.id, orgId, kind: change.kind, proposedBy: change.proposedBy, at: change.at, expiresAt: change.expiresAt, state: "pending",
        ...(change.lock === undefined ? {} : { lock: change.lock }), ...(change.fromLock === undefined ? {} : { fromLock: change.fromLock }),
      },
      ConditionExpression: "attribute_not_exists(pk) OR #s <> :pending OR expiresAt <= :now",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":pending": "pending", ":now": change.at },
    },
  };
}

/** The Update that settles a pending request (applied or cancelled). It holds only while the request is still that one, pending. */
function settleChange(deps: DesignReviewCompanyDeps, orgId: string, id: string, to: "applied" | "cancelled", now?: number): TransactItem {
  return {
    Update: {
      TableName: deps.tableName, Key: changeKey(orgId), UpdateExpression: "SET #s = :to",
      ConditionExpression: `#s = :pending AND id = :id${now === undefined ? "" : " AND expiresAt > :now"}`,
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":to": to, ":pending": "pending", ":id": id, ...(now === undefined ? {} : { ":now": now }) },
    },
  };
}

const byActor = (by: string) => (by === "system" ? SYSTEM_ACTOR : { kind: "member" as const, id: by });

export type SaveResult =
  | { ok: true; status: "applied"; changed: boolean; revision: number }
  | { ok: true; status: "needs_approval"; changeId: string; revision: number }
  | PolicyRefusal;

/**
 * Replaces the lock. `expectedRevision` is the revision the admin read. A request that changes nothing writes nothing. A lock that only adds or tightens fields applies at once, on the caller's own live authority. A lock
 * that LOOSENS anything is a loosening: `onLoosening` runs first (the route asks for a recent sign-in there); then the sole-owner exception applies it for the only owner, or a request waits for a different admin. The
 * change is one audit event, in the same transaction.
 */
export async function saveDesignReviewCompany(
  deps: DesignReviewCompanyDeps, input: { orgId: OrgId; by: string; expectedRevision: number; lock: DesignReviewLock; onLoosening?: (() => Promise<void>) | undefined },
): Promise<SaveResult> {
  const lockParsed = DesignReviewLockSchema.safeParse(input.lock);
  if (!lockParsed.success) return { ok: false, code: "invalid" };
  if (!checkDesignReviewLockWrite(lockParsed.data, deps.edition).ok) return { ok: false, code: "group_not_available" };
  const actor = await actorOf(deps, input.orgId, input.by);
  if (!actor.ok) return actor;
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return { ok: false, code: "unreadable" };
  if (input.expectedRevision !== read.revision) return { ok: false, code: "stale" };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const nextLock = lockParsed.data;
  if (sameLock(currentLock, nextLock)) return { ok: true, status: "applied", changed: false, revision: read.revision };
  const loosens = lockLoosens(currentLock, nextLock);
  const now = deps.now();
  const at = new Date(now).toISOString();
  let how: "direct" | "alone" | "request" = "direct", fence = actor.conditions;
  if (loosens) {
    await input.onLoosening?.();
    const decision = await looseningDecision(deps, input.orgId, input.by, now);
    if (!decision.ok) return decision;
    how = decision.how;
    fence = (decision.group.fence ?? []) as TransactItem[];
    if (how === "request" && (await openPolicyChange(deps, input.orgId, now)) !== undefined) return { ok: false, code: "already_open" };
    if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  }
  // The lock is written now when it only tightens, or when the sole-owner exception lets the one owner loosen it; otherwise it waits.
  const writeLock = !loosens || how === "alone";
  const revision = read.revision + (writeLock ? 1 : 0);
  const base = { orgId: input.orgId, actor: byActor(input.by), occurredAt: at };
  const audit: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  const changeId = (deps.newId ?? (() => randomUUID()))();
  const events = await tryAuditEvents(audit, () => [
    ...(writeLock ? [auditCompanyDesignReviewPolicyChanged({ ...base, occurrence: auditOccurrence("design_review_policy", "lock", String(revision)), field: "lock", from: String(lockCount(currentLock)), to: String(lockCount(nextLock)), mode: how === "alone" ? "sole_owner_exception" : "direct", revision })] : []),
    ...(!writeLock ? [auditCompanyDesignReviewPolicyProposed({ ...base, occurrence: auditOccurrence("design_review_policy", "lock", changeId), field: "lock", from: String(lockCount(currentLock)), to: String(lockCount(nextLock)) })] : []),
  ]);
  if (loosens && events.length === 0) return { ok: false, code: "audit_unavailable" };
  const items: TransactItem[] = [];
  if (writeLock) items.push(putCompany(deps, input.orgId, read, itemOf(input.orgId, revision, nextLock, { allowed: read.policy.allowed }, input.by, at)));
  // A request that writes no item now still holds only while the lock it was made against is the lock in force.
  else { const check = lockRevisionCheck(deps, input.orgId, read.lock); if (check !== undefined) items.push(check); }
  if (!writeLock) items.push(putChange(deps, input.orgId, { id: changeId, kind: "lock", proposedBy: input.by, at: now, expiresAt: now + DESIGN_REVIEW_CHANGE_TTL_MS, state: "pending", lock: nextLock, fromLock: currentLock }));
  items.push(...fence);
  if (!(await commit(deps, items, events))) return { ok: false, code: "stale" };
  return writeLock ? { ok: true, status: "applied", changed: true, revision } : { ok: true, status: "needs_approval", changeId, revision };
}

export type AllowResult =
  | { ok: true; status: "applied"; changed: boolean; revision: number }
  | { ok: true; status: "needs_approval"; changeId: string }
  | PolicyRefusal;

/**
 * Asks to allow or not allow design review for the company. NOT allowing applies at once on the caller's own live authority (it also withdraws a request that waits); an audit outage never blocks it. ALLOWING is a
 * loosening: the sole-owner exception applies it for the only owner, otherwise a request waits for a DIFFERENT admin. A single admin who is not the only owner, or who is inside the cool-off, is refused.
 */
export async function requestDesignReviewAllowed(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; by: string; allowed: boolean; expectedRevision: number }): Promise<AllowResult> {
  const actor = await actorOf(deps, input.orgId, input.by);
  if (!actor.ok) return actor;
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return { ok: false, code: "unreadable" };
  if (input.expectedRevision !== read.revision) return { ok: false, code: "stale" };
  const now = deps.now();
  const when = new Date(now).toISOString();
  const audit: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const open = await openPolicyChange(deps, input.orgId, now);
  if (!input.allowed) {
    // Off applies at once and withdraws a waiting request. Already off with nothing waiting: nothing to do.
    if (!read.policy.allowed && open === undefined) return { ok: true, status: "applied", changed: false, revision: read.revision };
    const revision = read.revision + (read.policy.allowed ? 1 : 0);
    const events = await tryAuditEvents(audit, () => [
      ...(read.policy.allowed ? [auditCompanyDesignReviewPolicyChanged({ orgId: input.orgId, actor: byActor(input.by), occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)), field: "allowed", from: "on", to: "off", mode: "direct", revision })] : []),
      ...(open === undefined ? [] : [auditCompanyDesignReviewPolicyChanged({ orgId: input.orgId, actor: byActor(input.by), occurredAt: when, occurrence: auditOccurrence("design_review_policy", "withdrawn", open.id), field: open.kind, from: "requested", to: "withdrawn", mode: "cancelled", revision })]),
    ]);
    const items: TransactItem[] = [];
    if (read.policy.allowed) items.push(putCompany(deps, input.orgId, read, itemOf(input.orgId, revision, currentLock, { allowed: false }, input.by, when)));
    if (open !== undefined) items.push(settleChange(deps, input.orgId, open.id, "cancelled"));
    items.push(...actor.conditions);
    return (await commit(deps, items, events)) ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
  }
  if (read.policy.allowed) return { ok: true, status: "applied", changed: false, revision: read.revision };
  const decision = await looseningDecision(deps, input.orgId, input.by, now);
  if (!decision.ok) return decision;
  if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  if (decision.how === "request") {
    if (open !== undefined) return { ok: false, code: "already_open" };
    const id = (deps.newId ?? (() => randomUUID()))();
    const events = await tryAuditEvents(audit, () => [auditCompanyDesignReviewPolicyProposed({ orgId: input.orgId, actor: byActor(input.by), occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", id), field: "allowed", from: "off", to: "on" })]);
    if (events.length === 0) return { ok: false, code: "audit_unavailable" };
    const ok = await commit(deps, [putChange(deps, input.orgId, { id, kind: "allowed", proposedBy: input.by, at: now, expiresAt: now + DESIGN_REVIEW_CHANGE_TTL_MS, state: "pending" }), ...((decision.group.fence ?? []) as TransactItem[])], events);
    // A lost race (the membership fence or the revision moved, or another request was opened first) is `stale`: ask again.
    return ok ? { ok: true, status: "needs_approval", changeId: id } : { ok: false, code: "stale" };
  }
  // The sole-owner exception: applied for the one owner, audited, fenced on the membership read.
  const revision = read.revision + 1;
  const events = await tryAuditEvents(audit, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: byActor(input.by), occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)), field: "allowed", from: "off", to: "on", mode: "sole_owner_exception", revision,
  })]);
  if (events.length === 0) return { ok: false, code: "audit_unavailable" };
  const items = [putCompany(deps, input.orgId, read, itemOf(input.orgId, revision, currentLock, { allowed: true }, input.by, when)), ...(open === undefined ? [] : [settleChange(deps, input.orgId, open.id, "cancelled")]), ...((decision.group.fence ?? []) as TransactItem[])];
  return (await commit(deps, items, events)) ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
}

/**
 * Withdraws the waiting request. Its proposer, or any admin on their own live authority, may. Audited. Answers `not_found` when no request waits or the id is another one's.
 */
export async function cancelDesignReviewChange(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; by: string; changeId: string }): Promise<{ ok: true } | PolicyRefusal> {
  const actor = await actorOf(deps, input.orgId, input.by);
  if (!actor.ok) return actor;
  const now = deps.now();
  const change = await openPolicyChange(deps, input.orgId, now);
  if (change === undefined || change.id !== input.changeId) return { ok: false, code: "not_found" };
  const read = await readDesignReviewCompany(deps, input.orgId);
  const when = new Date(now).toISOString();
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: byActor(input.by), occurredAt: when, occurrence: auditOccurrence("design_review_policy", "withdrawn", change.id), field: change.kind, from: "requested", to: "withdrawn", mode: "cancelled", revision: read.revision ?? 0,
  })]);
  return (await commit(deps, [settleChange(deps, input.orgId, change.id, "cancelled"), ...actor.conditions], events)) ? { ok: true } : { ok: false, code: "not_pending" };
}

/**
 * A DIFFERENT eligible admin confirms the waiting request. The one who asked can never confirm it. Applied with the request's claim and the audit in ONE transaction, fenced on the membership read. A request older than
 * 7 days is `expired`; one whose subject moved since (already allowed, or the lock changed) is `stale`.
 */
export async function approveDesignReviewChange(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; changeId: string; approverId: string }): Promise<AllowResult> {
  const change = await getChange(deps, input.orgId);
  if (change === undefined || change.id !== input.changeId) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  if (sameId(change.proposedBy, input.approverId)) return { ok: false, code: "second_person_required" };
  const group = await groupOf(deps, input.orgId, { proposerId: change.proposedBy, approverId: input.approverId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) return { ok: false, code: decision.code === "eligibility_unavailable" ? "eligibility_unavailable" : "second_person_required" };
  if (decision.mode !== "second_person") return { ok: false, code: "second_person_required" };
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return { ok: false, code: "unreadable" };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  if (change.kind === "allowed" ? read.policy.allowed : !sameLock(currentLock, change.fromLock ?? {})) return { ok: false, code: "stale" };
  if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  const revision = read.revision + 1;
  const when = new Date(at).toISOString();
  const nextLock = change.kind === "lock" ? change.lock ?? currentLock : currentLock;
  const events = await tryAuditEvents({ audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: { kind: "member", id: input.approverId }, occurredAt: when, occurrence: auditOccurrence("design_review_policy", change.kind, String(revision)),
    field: change.kind, from: change.kind === "allowed" ? "off" : String(lockCount(currentLock)), to: change.kind === "allowed" ? "on" : String(lockCount(nextLock)), mode: "second_person", revision,
  })]);
  if (events.length === 0) return { ok: false, code: "audit_unavailable" };
  const item = itemOf(input.orgId, revision, nextLock, { allowed: change.kind === "allowed" ? true : read.policy.allowed }, input.approverId, when);
  const ok = await commit(deps, [putCompany(deps, input.orgId, read, item), settleChange(deps, input.orgId, change.id, "applied", at), ...((group.fence ?? []) as TransactItem[])], events);
  return ok ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
}

export const DESIGN_REVIEW_DP_MIGRATION_SK = "DESIGNREVIEW#DPMIGRATION";

/** The record that the move of the old `dp` list ran (or was skipped) for this company, if any. */
export async function dpMigrationRecord(table: DesignReviewLockTable, orgId: string): Promise<{ outcome: "moved" | "skipped" } | undefined> {
  const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: orgPk(orgId), sk: DESIGN_REVIEW_DP_MIGRATION_SK }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  return item === undefined ? undefined : { outcome: item["outcome"] === "skipped" ? "skipped" : "moved" };
}
/** Whether the move already ran (or was skipped) for this company. */
export async function dpMigrationRan(table: DesignReviewLockTable, orgId: string): Promise<boolean> {
  return (await dpMigrationRecord(table, orgId)) !== undefined;
}

/**
 * The company half of the `dp` move (dp-migration.ts), by the system, and the record that the move ran in the SAME transaction (so it never repeats). With `allow`, the company becomes "allowed" unless an admin already
 * touched the item (a member wrote it after it first existed: their choice stands, the record is still written). Without `allow` (the move was refused for a project, or has no evidence for this company) only the record
 * is written, as `skipped`, so a refusal is not retried every tick. Audited as the system with mode `migration`. Answers `ran` for a move that already ran, `stale` for a lost race (the next tick tries again).
 */
export async function recordDpMigration(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; projectCount: number; allow: boolean; reason?: string }): Promise<"done" | "kept" | "skipped" | "ran" | "stale" | "unreadable"> {
  if (await dpMigrationRan(deps, input.orgId)) return "ran";
  const read = await readDesignReviewCompany(deps, input.orgId);
  const at = new Date(deps.now()).toISOString();
  const marker = (outcome: "moved" | "skipped"): TransactItem => ({ Put: { TableName: deps.tableName, Item: { pk: orgPk(input.orgId), sk: DESIGN_REVIEW_DP_MIGRATION_SK, entityType: "DESIGN_REVIEW_DP_MIGRATION", orgId: input.orgId, ranAt: at, projectCount: input.projectCount, outcome, ...(input.reason === undefined ? {} : { reason: input.reason }) }, ConditionExpression: "attribute_not_exists(pk)" } });
  if (!input.allow) return (await commit(deps, [marker("skipped")], [])) ? "skipped" : "ran";
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return "unreadable";
  // An admin's choice before the move reached this company stands.
  if (read.policy.allowed || (read.revision > 0 && read.updatedBy !== undefined && read.updatedBy !== "system")) return (await commit(deps, [marker("moved")], [])) ? (read.policy.allowed ? "done" : "kept") : "ran";
  const revision = read.revision + 1;
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: SYSTEM_ACTOR, occurredAt: at, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)),
    field: "allowed", from: "off", to: "on", mode: "migration", revision,
  })]);
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const item = itemOf(input.orgId, revision, currentLock, { allowed: true }, "system", at);
  return (await commit(deps, [putCompany(deps, input.orgId, read, item), marker("moved")], events)) ? "done" : "stale";
}

