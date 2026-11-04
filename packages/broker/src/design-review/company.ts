// Design review stage (DR-FU4): the company's design review policy, written by company admins only. It lives on the same revisioned item as the stricter-only lock (`lock.ts`, DESIGNREVIEW#LOCK):
//   - `allowed`      whether design review may run for ANY project of the company (default no). Turning it ON is a loosening: a DIFFERENT eligible admin confirms, as for every other company safeguard
//                    (a company with one eligible admin has nobody to ask, so that admin applies it alone and the audit says `sole_admin`). Turning it OFF applies at once.
//   - `defaultMode`  the mode a project runs when it has no setting of its own: never (Off, the default), auto or always.
//   - `lock`         the stricter-only lock fields (`DesignReviewLockSchema`), which no page wrote before this.
// `allowed` and `defaultMode` are company POLICY, not lock fields: the stricter-only rule and its clamp (`lock.ts`) are unchanged.
// Every change commits in ONE transaction with its audit item and is conditional on the item's revision (`POLICY_STALE` otherwise); a refused write changes nothing. Answers are fixed words.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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
  DESIGN_REVIEW_LOCK_SK, DesignReviewLockSchema, checkDesignReviewLockWrite, lockedFields, readDesignReviewCompany,
  type DesignReviewCompanyRead, type DesignReviewLock, type DesignReviewLockTable,
} from "./lock.js";

export type DesignReviewMode = "never" | "auto" | "always";
export type DesignReviewPolicyFailure =
  | "not_eligible" | "eligibility_unavailable" | "second_person_required" | "audit_unavailable" | "already_open" | "expired" | "not_found" | "not_pending"
  | "stale" | "unreadable" | "group_not_available" | "invalid";

export interface DesignReviewCompanyDeps extends AuditDeps, DesignReviewLockTable {
  now(): number;
  edition?: EditionPolicy | undefined;
  /** Who may act (the shared second-person evidence). Needed for turning "allowed" on or approving it. */
  authority?: Tier0Authority | undefined;
  newId?: () => string;
}

export const DESIGN_REVIEW_ALLOW_CHANGE_TTL_MS = 7 * 86_400_000;
const CHANGE_PREFIX = "DESIGNREVIEW#ALLOWCHANGE#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const changeKey = (orgId: string, id: string) => ({ pk: orgPk(orgId), sk: `${CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException"
  || (error.name === "TransactionCanceledException" && ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")));
const onOff = (value: boolean): string => (value ? "on" : "off");

/** A pending request to allow design review: made by one admin, waiting for a different one. */
export interface AllowChange { id: string; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled" }

function parseChange(item: Record<string, unknown> | undefined): AllowChange | undefined {
  if (item === undefined || item["entityType"] !== "DESIGN_REVIEW_ALLOW_CHANGE" || typeof item["id"] !== "string" || typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
  const state = item["state"];
  if (state !== "pending" && state !== "applied" && state !== "cancelled") return undefined;
  return { id: item["id"], proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state };
}

/** The company's open (pending, unexpired) request to allow design review, if any. */
export async function openAllowChange(table: DesignReviewLockTable, orgId: string, now: number): Promise<AllowChange | undefined> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": CHANGE_PREFIX },
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).map((item) => parseChange(item)).find((change) => change !== undefined && change.state === "pending" && change.expiresAt > now);
}

async function getChange(table: DesignReviewLockTable, orgId: string, id: string): Promise<AllowChange | undefined> {
  return parseChange((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: changeKey(orgId, id), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item);
}

/** What a page shows: the policy, the lock, and the revision a change is made against. A stored item that does not read is said so, never shown as the defaults. */
export interface DesignReviewCompanyView {
  revision: number | undefined;
  allowed: boolean;
  defaultMode: DesignReviewMode;
  lock: DesignReviewLock;
  lockedFields: string[];
  unreadable: boolean;
}
export function companyViewOf(read: DesignReviewCompanyRead): DesignReviewCompanyView {
  const lock = read.lock.kind === "lock" ? read.lock.lock : {};
  return {
    revision: read.revision, allowed: read.policy.allowed, defaultMode: read.policy.defaultMode, lock, lockedFields: lockedFields(lock),
    unreadable: read.lock.kind === "unreadable" || read.policyUnreadable,
  };
}

function itemOf(orgId: string, revision: number, lock: DesignReviewLock, policy: { allowed: boolean; defaultMode: DesignReviewMode }, by: string, at: string) {
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

export type SaveResult = { ok: true; changed: boolean; revision: number } | { ok: false; code: DesignReviewPolicyFailure; fields?: string[] };

/**
 * Sets the default mode and/or the lock (a direct write: both are the company admin's to set; the caller checked the role). `expectedRevision` is the revision the admin read. A request that changes nothing writes nothing.
 * Each part that changed is one audit event, in the same transaction.
 */
export async function saveDesignReviewCompany(
  deps: DesignReviewCompanyDeps, input: { orgId: OrgId; by: string; expectedRevision: number; defaultMode?: DesignReviewMode | undefined; lock?: DesignReviewLock | undefined },
): Promise<SaveResult> {
  const lockParsed = input.lock === undefined ? undefined : DesignReviewLockSchema.safeParse(input.lock);
  if (lockParsed !== undefined && !lockParsed.success) return { ok: false, code: "invalid" };
  if (lockParsed?.success === true) {
    const check = checkDesignReviewLockWrite(lockParsed.data, deps.edition);
    if (!check.ok) return { ok: false, code: "group_not_available" };
  }
  // Live authority, as for "allowed": the caller's role in the request is not enough on its own.
  const group = await groupOf(deps, input.orgId, { proposerId: input.by, approverId: input.by });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.by)) return { ok: false, code: "not_eligible" };
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return { ok: false, code: "unreadable" };
  if (input.expectedRevision !== read.revision) return { ok: false, code: "stale" };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const nextLock = lockParsed?.success === true ? lockParsed.data : currentLock;
  const nextMode = input.defaultMode ?? read.policy.defaultMode;
  const modeChanged = nextMode !== read.policy.defaultMode, lockChanged = !sameLock(currentLock, nextLock);
  if (!modeChanged && !lockChanged) return { ok: true, changed: false, revision: read.revision };
  const revision = read.revision + 1;
  const at = new Date(deps.now()).toISOString();
  const base = { orgId: input.orgId, actor: input.by === "system" ? SYSTEM_ACTOR : { kind: "member" as const, id: input.by }, occurredAt: at };
  const audit: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  const events = await tryAuditEvents(audit, () => [
    ...(modeChanged ? [auditCompanyDesignReviewPolicyChanged({ ...base, occurrence: auditOccurrence("design_review_policy", "defaultMode", String(revision)), field: "defaultMode", from: read.policy.defaultMode, to: nextMode, mode: "direct", revision })] : []),
    ...(lockChanged ? [auditCompanyDesignReviewPolicyChanged({ ...base, occurrence: auditOccurrence("design_review_policy", "lock", String(revision)), field: "lock", from: String(lockCount(currentLock)), to: String(lockCount(nextLock)), mode: "direct", revision })] : []),
  ]);
  const item = itemOf(input.orgId, revision, nextLock, { allowed: read.policy.allowed, defaultMode: nextMode }, input.by, at);
  return (await commit(deps, [putCompany(deps, input.orgId, read, item), ...((group.fence ?? []) as TransactItem[])], events)) ? { ok: true, changed: true, revision } : { ok: false, code: "stale" };
}

export type AllowResult =
  | { ok: true; status: "applied"; changed: boolean; revision: number }
  | { ok: true; status: "needs_approval"; changeId: string }
  | { ok: false; code: DesignReviewPolicyFailure };

async function groupOf(deps: DesignReviewCompanyDeps, orgId: string, who: { proposerId: string; approverId: string }) {
  if (deps.authority === undefined) return undefined;
  const group = await deps.authority.eligibility({ kind: "company", workspaceId: orgId }, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}

/**
 * Asks to allow or not allow design review for the company. NOT allowing applies at once (the stricter side; an audit outage never blocks it). ALLOWING is a loosening: with another eligible admin it opens a request that
 * a DIFFERENT admin approves; with no other eligible admin it applies for the one admin who asked (mode `sole_admin`, audited, and the audit must be writable). Only an eligible company admin may ask.
 */
export async function requestDesignReviewAllowed(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; by: string; allowed: boolean; expectedRevision: number }): Promise<AllowResult> {
  const group = await groupOf(deps, input.orgId, { proposerId: input.by, approverId: input.by });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.by)) return { ok: false, code: "not_eligible" };
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return { ok: false, code: "unreadable" };
  if (input.expectedRevision !== read.revision) return { ok: false, code: "stale" };
  if (read.policy.allowed === input.allowed) return { ok: true, status: "applied", changed: false, revision: read.revision };
  const at = deps.now();
  const soleAdmin = group.eligibleIds.length === 1;
  if (input.allowed && !soleAdmin) {
    if ((await openAllowChange(deps, input.orgId, at)) !== undefined) return { ok: false, code: "already_open" };
    if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
    const auditDeps: AuditDeps = { audit: deps.audit };
    const id = (deps.newId ?? (() => randomUUID()))();
    const when = new Date(at).toISOString();
    const events = await tryAuditEvents({ audit: deps.audit }, () => [auditCompanyDesignReviewPolicyProposed({ orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", id), field: "allowed", from: "off", to: "on" })]);
    if (events.length === 0) return { ok: false, code: "audit_unavailable" };
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: { ...changeKey(input.orgId, id), entityType: "DESIGN_REVIEW_ALLOW_CHANGE", id, orgId: input.orgId, proposedBy: input.by, at, expiresAt: at + DESIGN_REVIEW_ALLOW_CHANGE_TTL_MS, state: "pending" }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...events.flatMap((event) => auditPending(auditDeps, event)),
      ] }));
    } catch (error) {
      if (conditionFailed(error)) return { ok: false, code: "already_open" };
      throw error;
    }
    await flushAuditEvents({ audit: deps.audit }, events);
    return { ok: true, status: "needs_approval", changeId: id };
  }
  // Not allowing, or allowing as the only eligible admin: applied now, against the revision read, fenced on the membership the decision rested on.
  if (input.allowed && deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  const revision = read.revision + 1;
  const when = new Date(at).toISOString();
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)),
    field: "allowed", from: onOff(read.policy.allowed), to: onOff(input.allowed), mode: input.allowed ? "sole_admin" : "direct", revision,
  })]);
  if (input.allowed && events.length === 0) return { ok: false, code: "audit_unavailable" };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const item = itemOf(input.orgId, revision, currentLock, { allowed: input.allowed, defaultMode: read.policy.defaultMode }, input.by, when);
  const fence = (group.fence ?? []) as TransactItem[];
  return (await commit(deps, [putCompany(deps, input.orgId, read, item), ...fence], events)) ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
}

/** A DIFFERENT eligible admin approves a request to allow design review. The one who asked can never approve it. Applied with the change's claim and the audit in ONE transaction, fenced on the membership read. */
export async function approveDesignReviewAllowed(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; changeId: string; approverId: string }): Promise<AllowResult> {
  const change = await getChange(deps, input.orgId, input.changeId);
  if (change === undefined) return { ok: false, code: "not_found" };
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
  if (read.policy.allowed) return { ok: false, code: "stale" };
  if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  const revision = read.revision + 1;
  const when = new Date(at).toISOString();
  const events = await tryAuditEvents({ audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: { kind: "member", id: input.approverId }, occurredAt: when, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)),
    field: "allowed", from: "off", to: "on", mode: "second_person", revision,
  })]);
  if (events.length === 0) return { ok: false, code: "audit_unavailable" };
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const item = itemOf(input.orgId, revision, currentLock, { allowed: true, defaultMode: read.policy.defaultMode }, input.approverId, when);
  const claim: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: changeKey(input.orgId, change.id), UpdateExpression: "SET #s = :applied", ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":applied": "applied", ":pending": "pending" },
    },
  };
  const ok = await commit(deps, [putCompany(deps, input.orgId, read, item), claim, ...((group.fence ?? []) as TransactItem[])], events);
  return ok ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
}

export const DESIGN_REVIEW_DP_MIGRATION_SK = "DESIGNREVIEW#DPMIGRATION";

/** Whether the one-time move of the old `dp` project list into stored settings already ran for this company. */
export async function dpMigrationRan(table: DesignReviewLockTable, orgId: string): Promise<boolean> {
  return (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: orgPk(orgId), sk: DESIGN_REVIEW_DP_MIGRATION_SK }, ConsistentRead: true })) as { Item?: unknown }).Item !== undefined;
}

/**
 * The company half of the `dp` move (dp-migration.ts), by the system: the company becomes "allowed" if it is not, and the record that the move ran is written in the SAME transaction (so it never repeats, and an admin
 * who turns "allowed" off afterwards is not overridden). `projectCount` is how many `dp` projects of this company were moved. Audited as the system with mode `migration`. Answers `ran` for a move that already ran,
 * `stale` for a lost race (the next sweep tick tries again).
 */
export async function recordDpMigration(deps: DesignReviewCompanyDeps, input: { orgId: OrgId; projectCount: number }): Promise<"done" | "ran" | "stale" | "unreadable"> {
  if (await dpMigrationRan(deps, input.orgId)) return "ran";
  const read = await readDesignReviewCompany(deps, input.orgId);
  if (read.revision === undefined || read.lock.kind === "unreadable" || read.policyUnreadable) return "unreadable";
  const at = new Date(deps.now()).toISOString();
  const marker: TransactItem = { Put: { TableName: deps.tableName, Item: { pk: orgPk(input.orgId), sk: DESIGN_REVIEW_DP_MIGRATION_SK, entityType: "DESIGN_REVIEW_DP_MIGRATION", orgId: input.orgId, ranAt: at, projectCount: input.projectCount }, ConditionExpression: "attribute_not_exists(pk)" } };
  if (read.policy.allowed) return (await commit(deps, [marker], [])) ? "done" : "ran";
  const revision = read.revision + 1;
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditCompanyDesignReviewPolicyChanged({
    orgId: input.orgId, actor: SYSTEM_ACTOR, occurredAt: at, occurrence: auditOccurrence("design_review_policy", "allowed", String(revision)),
    field: "allowed", from: "off", to: "on", mode: "migration", revision,
  })]);
  const currentLock = read.lock.kind === "lock" ? read.lock.lock : {};
  const item = itemOf(input.orgId, revision, currentLock, { allowed: true, defaultMode: read.policy.defaultMode }, "system", at);
  return (await commit(deps, [putCompany(deps, input.orgId, read, item), marker], events)) ? "done" : "stale";
}
