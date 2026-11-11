// Approval place (U4, decision 83, requirement A-08): the company's recent sign-in window for approvals outside Rovara, stored once per company in the State table beside its other settings.
//   APPROVALWINDOW#SETTING   { revision, seconds, updatedAt, updatedBy }: the window. No item = the default (24 hours, revision 0).
//   APPROVALWINDOW#CHANGE    the one waiting request: a LENGTHENING that a different admin has to confirm.
// Who may do what (the shared company rule, `org/second-person-approval.ts`, the same shape as the design review company policy):
//   - SHORTENING (or keeping) applies at once, on the caller's OWN live owner or admin authority, with no roster read, so the safe direction always works.
//   - LENGTHENING (up to 7 days, `RECENT_SIGN_IN_MAX_SECONDS`) is a decision for two people: a DIFFERENT eligible admin confirms it. The one exception is the shared sole-owner exception (the only owner, the only eligible person,
//     nobody eligible lost in the last 24 hours). Anything else with nobody to confirm is refused, never applied. The route asks for a fresh sign-in before a lengthening and before a confirmation.
// One request waits at a time; it expires after 7 days; its proposer or any admin can withdraw it. Every change commits in ONE transaction with its audit item, conditional on the item's revision (`stale` otherwise).
// READS FAIL CLOSED: a stored item that does not read is enforced as the 1-hour minimum (never the default, which might be looser than what the company chose) and nothing can be changed until it is repaired by Rovara staff.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MIN_SECONDS, RecentSignInSettingSchema, checkRecentSignInChange, orgMetaKey, type OrgId } from "@agentx/contracts";
import { auditCompanyApprovalWindowChanged, auditCompanyApprovalWindowProposed, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { trySecondPersonTimed } from "../lessons/approve.js";
import type { Tier0Authority } from "../lessons/sole-owner-switch.js";
import { idIn, sameId } from "../lessons/types.js";

export interface ApprovalWindowTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
export interface ApprovalWindowDeps extends AuditDeps, ApprovalWindowTable {
  now(): number;
  /** The company's roster as the shared second-person evidence reads it. Needed only for a lengthening and for confirming one. */
  authority?: Tier0Authority | undefined;
  /** The caller's OWN live authority as a company owner or admin, fenced (no roster). Throws FORBIDDEN for anyone else. Needed for every change. */
  actor?: ((orgId: string, by: string) => Promise<TransactItem[]>) | undefined;
  newId?: () => string;
}

export const APPROVAL_WINDOW_SETTING_SK = "APPROVALWINDOW#SETTING";
const CHANGE_SK = "APPROVALWINDOW#CHANGE";
export const APPROVAL_WINDOW_CHANGE_TTL_MS = 7 * 86_400_000;
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const settingKey = (orgId: string) => ({ pk: orgPk(orgId), sk: APPROVAL_WINDOW_SETTING_SK });
const changeKey = (orgId: string) => ({ pk: orgPk(orgId), sk: CHANGE_SK });
const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException"
  || (error.name === "TransactionCanceledException" && ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")));

type Row = Record<string, unknown>;
async function getRow(table: ApprovalWindowTable, key: { pk: string; sk: string }): Promise<Row | undefined> {
  return (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Row }).Item;
}

export interface ApprovalWindowRead {
  /** What is enforced now: the stored window, the default when nothing is stored, the 1-hour minimum when the stored item does not read. */
  seconds: number;
  revision: number;
  isDefault: boolean;
  unreadable: boolean;
  /** Who last changed it (a developer id) and when (ISO), from the stored item; absent for the default and for an item that does not read. */
  changedBy?: string;
  changedAt?: string;
}

/** The company's window. Throws when the table cannot be read (the caller refuses the approval: it never guesses a window). */
export async function readApprovalWindow(table: ApprovalWindowTable, orgId: string): Promise<ApprovalWindowRead> {
  const row = await getRow(table, settingKey(orgId));
  if (row === undefined) return { seconds: RECENT_SIGN_IN_DEFAULT_SECONDS, revision: 0, isDefault: true, unreadable: false };
  const parsed = RecentSignInSettingSchema.safeParse({ seconds: row["seconds"] });
  const revision = row["revision"];
  if (row["entityType"] !== "APPROVAL_WINDOW" || !parsed.success || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return { seconds: RECENT_SIGN_IN_MIN_SECONDS, revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0, isDefault: false, unreadable: true };
  }
  const by = row["updatedBy"], at = row["updatedAt"];
  return { seconds: parsed.data.seconds, revision, isDefault: false, unreadable: false, ...(typeof by === "string" && by.length > 0 && by.length <= 100 ? { changedBy: by } : {}), ...(typeof at === "string" && Number.isFinite(Date.parse(at)) ? { changedAt: new Date(at).toISOString() } : {}) };
}

/** A request waiting for a different admin: to lengthen the window to `seconds` (it was `fromSeconds` when asked). */
export interface WindowChange { id: string; seconds: number; fromSeconds: number; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled" }

function parseChange(item: Row | undefined): WindowChange | undefined {
  if (item === undefined || item["entityType"] !== "APPROVAL_WINDOW_CHANGE" || typeof item["id"] !== "string" || typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
  const state = item["state"];
  if (state !== "pending" && state !== "applied" && state !== "cancelled") return undefined;
  const to = RecentSignInSettingSchema.safeParse({ seconds: item["seconds"] }), from = RecentSignInSettingSchema.safeParse({ seconds: item["fromSeconds"] });
  if (!to.success || !from.success) return undefined;
  return { id: item["id"], seconds: to.data.seconds, fromSeconds: from.data.seconds, proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state };
}

async function getChange(table: ApprovalWindowTable, orgId: string): Promise<WindowChange | undefined> {
  return parseChange(await getRow(table, changeKey(orgId)));
}

/** The company's open (pending, unexpired) request, if any. */
export async function openWindowChange(table: ApprovalWindowTable, orgId: string, now: number): Promise<WindowChange | undefined> {
  const change = await getChange(table, orgId);
  return change !== undefined && change.state === "pending" && change.expiresAt > now ? change : undefined;
}

export type ApprovalWindowFailure =
  | "not_eligible" | "eligibility_unavailable" | "second_person_required" | "sole_owner_cool_off" | "audit_unavailable" | "already_open" | "expired" | "not_found" | "not_pending" | "stale" | "unreadable" | "invalid";
export type WindowRefusal = { ok: false; code: ApprovalWindowFailure; /** For `sole_owner_cool_off`: when the exception opens (ISO). */ availableAt?: string };
export type WindowSetResult =
  | { ok: true; status: "applied"; changed: boolean; revision: number }
  | { ok: true; status: "needs_approval"; changeId: string; revision: number }
  | WindowRefusal;

const byActor = (by: string) => ({ kind: "member" as const, id: by });

function putSetting(deps: ApprovalWindowTable, orgId: string, read: ApprovalWindowRead, revision: number, seconds: number, by: string, at: string): TransactItem {
  const first = read.revision === 0;
  return {
    Put: {
      TableName: deps.tableName,
      Item: { ...settingKey(orgId), entityType: "APPROVAL_WINDOW", orgId, revision, seconds, updatedAt: at, updatedBy: by },
      ConditionExpression: first ? "attribute_not_exists(pk)" : "#revision = :expected",
      ...(first ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": read.revision } }),
    },
  };
}

/** A request that writes no setting item still holds only while the setting is at the revision it was made against. */
function settingRevisionCheck(deps: ApprovalWindowTable, orgId: string, read: ApprovalWindowRead): TransactItem {
  return read.revision === 0
    ? { ConditionCheck: { TableName: deps.tableName, Key: settingKey(orgId), ConditionExpression: "attribute_not_exists(pk)" } }
    : { ConditionCheck: { TableName: deps.tableName, Key: settingKey(orgId), ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": read.revision } } };
}

function putChange(deps: ApprovalWindowTable, orgId: string, change: WindowChange): TransactItem {
  return {
    Put: {
      TableName: deps.tableName,
      Item: { ...changeKey(orgId), entityType: "APPROVAL_WINDOW_CHANGE", id: change.id, orgId, seconds: change.seconds, fromSeconds: change.fromSeconds, proposedBy: change.proposedBy, at: change.at, expiresAt: change.expiresAt, state: "pending" },
      ConditionExpression: "attribute_not_exists(pk) OR #s <> :pending OR expiresAt <= :now",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":pending": "pending", ":now": change.at },
    },
  };
}

function settleChange(deps: ApprovalWindowTable, orgId: string, id: string, to: "applied" | "cancelled", now?: number): TransactItem {
  return {
    Update: {
      TableName: deps.tableName, Key: changeKey(orgId), UpdateExpression: "SET #s = :to",
      ConditionExpression: `#s = :pending AND id = :id${now === undefined ? "" : " AND expiresAt > :now"}`,
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":to": to, ":pending": "pending", ":id": id, ...(now === undefined ? {} : { ":now": now }) },
    },
  };
}

async function commit(deps: ApprovalWindowDeps, items: TransactItem[], events: Parameters<typeof auditPending>[1][]): Promise<boolean> {
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

async function actorOf(deps: ApprovalWindowDeps, orgId: string, by: string): Promise<{ ok: true; conditions: TransactItem[] } | WindowRefusal> {
  if (deps.actor === undefined) return { ok: false, code: "eligibility_unavailable" };
  try {
    return { ok: true, conditions: await deps.actor(orgId, by) };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code === "FORBIDDEN" ? "not_eligible" : "eligibility_unavailable" };
  }
}

async function groupOf(deps: ApprovalWindowDeps, orgId: string, who: { proposerId: string; approverId: string }) {
  if (deps.authority === undefined) return undefined;
  const group = await deps.authority.eligibility({ kind: "company", workspaceId: orgId }, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}
type Group = NonNullable<Awaited<ReturnType<typeof groupOf>>>;

/** The decision for a lengthening asked by one admin, from the shared rule alone: `alone` (the sole-owner exception), `request` (a different eligible admin can confirm), or a refusal. */
async function lengtheningDecision(deps: ApprovalWindowDeps, orgId: string, by: string, at: number): Promise<{ ok: true; how: "alone" | "request"; group: Group } | WindowRefusal> {
  const group = await groupOf(deps, orgId, { proposerId: by, approverId: by });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, by)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, by, by, at);
  if (decision.ok) return decision.mode === "sole_owner_exception" ? { ok: true, how: "alone", group } : { ok: true, how: "request", group };
  if (decision.code === "sole_owner_cool_off") return { ok: false, code: "sole_owner_cool_off", ...(decision.availableAt === undefined ? {} : { availableAt: decision.availableAt }) };
  if (decision.code === "eligibility_unavailable") return { ok: false, code: "eligibility_unavailable" };
  return group.eligibleIds.length > 1 ? { ok: true, how: "request", group } : { ok: false, code: "second_person_required" };
}

/**
 * Sets the window. `expectedRevision` is the revision the admin read. The same value writes nothing. A shorter window applies at once on the caller's own live authority. A longer one is a lengthening: `onLengthening` runs first
 * (the route asks for a recent sign-in there); then the sole-owner exception applies it for the only owner, or a request waits for a different admin. Each change is one audit event, in the same transaction.
 */
export async function setApprovalWindow(deps: ApprovalWindowDeps, input: { orgId: OrgId; by: string; expectedRevision: number; seconds: unknown; onLengthening?: (() => Promise<void>) | undefined }): Promise<WindowSetResult> {
  const actor = await actorOf(deps, input.orgId, input.by);
  if (!actor.ok) return actor;
  const read = await readApprovalWindow(deps, input.orgId);
  if (read.unreadable) return { ok: false, code: "unreadable" };
  if (input.expectedRevision !== read.revision) return { ok: false, code: "stale" };
  const check = checkRecentSignInChange({ seconds: read.seconds }, { seconds: input.seconds });
  if (!check.ok) return { ok: false, code: "invalid" };
  if (check.change === "same") return { ok: true, status: "applied", changed: false, revision: read.revision };
  const now = deps.now();
  const at = new Date(now).toISOString();
  const lengthening = check.needsSecondAdmin;
  let how: "direct" | "alone" | "request" = "direct";
  let fence = actor.conditions;
  if (lengthening) {
    await input.onLengthening?.();
    const decision = await lengtheningDecision(deps, input.orgId, input.by, now);
    if (!decision.ok) return decision;
    how = decision.how;
    fence = (decision.group.fence ?? []) as TransactItem[];
    if (how === "request" && (await openWindowChange(deps, input.orgId, now)) !== undefined) return { ok: false, code: "already_open" };
    if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  }
  const writeNow = !lengthening || how === "alone";
  const revision = read.revision + (writeNow ? 1 : 0);
  const base = { orgId: input.orgId, actor: byActor(input.by), occurredAt: at };
  const changeId = (deps.newId ?? (() => randomUUID()))();
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [
    writeNow
      ? auditCompanyApprovalWindowChanged({ ...base, occurrence: auditOccurrence("approval_window", String(revision)), from: read.seconds, to: check.setting.seconds, mode: how === "alone" ? "sole_owner_exception" : "direct", revision })
      : auditCompanyApprovalWindowProposed({ ...base, occurrence: auditOccurrence("approval_window", changeId), from: read.seconds, to: check.setting.seconds }),
  ]);
  if (lengthening && events.length === 0) return { ok: false, code: "audit_unavailable" };
  const items: TransactItem[] = [];
  if (writeNow) {
    items.push(putSetting(deps, input.orgId, read, revision, check.setting.seconds, input.by, at));
    // A window set directly or by the exception settles a waiting request: it was made against a window that no longer stands.
    const open = await openWindowChange(deps, input.orgId, now);
    if (open !== undefined) items.push(settleChange(deps, input.orgId, open.id, "cancelled"));
  } else {
    items.push(settingRevisionCheck(deps, input.orgId, read));
    items.push(putChange(deps, input.orgId, { id: changeId, seconds: check.setting.seconds, fromSeconds: read.seconds, proposedBy: input.by, at: now, expiresAt: now + APPROVAL_WINDOW_CHANGE_TTL_MS, state: "pending" }));
  }
  items.push(...fence);
  if (!(await commit(deps, items, events))) return { ok: false, code: "stale" };
  return writeNow ? { ok: true, status: "applied", changed: true, revision } : { ok: true, status: "needs_approval", changeId, revision };
}

/** Withdraws the waiting request. Its proposer, or any admin on their own live authority, may. Audited. `not_found` when no request waits or the id is another one's. */
export async function cancelApprovalWindowChange(deps: ApprovalWindowDeps, input: { orgId: OrgId; by: string; changeId: string }): Promise<{ ok: true } | WindowRefusal> {
  const actor = await actorOf(deps, input.orgId, input.by);
  if (!actor.ok) return actor;
  const now = deps.now();
  const change = await openWindowChange(deps, input.orgId, now);
  if (change === undefined || change.id !== input.changeId) return { ok: false, code: "not_found" };
  const read = await readApprovalWindow(deps, input.orgId);
  const events = await tryAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditCompanyApprovalWindowChanged({
    orgId: input.orgId, actor: byActor(input.by), occurredAt: new Date(now).toISOString(), occurrence: auditOccurrence("approval_window", "withdrawn", change.id), from: change.fromSeconds, to: change.seconds, mode: "cancelled", revision: read.revision,
  })]);
  return (await commit(deps, [settleChange(deps, input.orgId, change.id, "cancelled"), ...actor.conditions], events)) ? { ok: true } : { ok: false, code: "not_pending" };
}

/**
 * A DIFFERENT eligible admin confirms the waiting lengthening. The one who asked can never confirm it. Applied with the request's claim and the audit in ONE transaction, fenced on the membership read. A request older than 7 days is
 * `expired`; one whose window moved since it was asked (`fromSeconds` is no longer the window) is `stale`.
 */
export async function approveApprovalWindowChange(deps: ApprovalWindowDeps, input: { orgId: OrgId; changeId: string; approverId: string }): Promise<WindowSetResult> {
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
  const read = await readApprovalWindow(deps, input.orgId);
  if (read.unreadable) return { ok: false, code: "unreadable" };
  if (read.seconds !== change.fromSeconds) return { ok: false, code: "stale" };
  if (deps.audit === undefined) return { ok: false, code: "audit_unavailable" };
  const revision = read.revision + 1;
  const when = new Date(at).toISOString();
  const events = await tryAuditEvents({ audit: deps.audit }, () => [auditCompanyApprovalWindowChanged({
    orgId: input.orgId, actor: byActor(input.approverId), occurredAt: when, occurrence: auditOccurrence("approval_window", String(revision)), from: read.seconds, to: change.seconds, mode: "second_person", revision,
  })]);
  if (events.length === 0) return { ok: false, code: "audit_unavailable" };
  const ok = await commit(deps, [putSetting(deps, input.orgId, read, revision, change.seconds, input.approverId, when), settleChange(deps, input.orgId, change.id, "applied", at), ...((group.fence ?? []) as TransactItem[])], events);
  return ok ? { ok: true, status: "applied", changed: true, revision } : { ok: false, code: "stale" };
}
