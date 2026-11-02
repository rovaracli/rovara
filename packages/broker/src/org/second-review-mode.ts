// Second review (lane cr-settings, switch `cr`): the writer of the mode, `review.otherCompany` (off, shadow, on), for the company and, as an override that can only be stricter, for a project. Owner decision 2026-11-02:
//   - RAISING applies at once, by an eligible admin (a project: its maintainer or an admin), audited in the same transaction. Raising to `on` is refused unless the evidence for the chosen model holds (the caller asks
//     `secondReviewVerdictHolds` and passes the answer; nothing here trusts a stored pass).
//   - LOWERING (`on` to `shadow` or `off`, `shadow` to `off`, a company mode or a project's, and clearing a project's override when that lowers it) is a proposal that a DIFFERENT eligible person approves, with the
//     membership the decision rested on fenced into the same transaction. It is the shared sole-owner switch's shape (lessons/tier0-setting.ts, org/known-failing-policy.ts), and like that switch it has NO sole-owner exception:
//     a company of one that turned `on` keeps it on until a second admin joins (the one-admin rule). The proposer can never approve their own proposal.
//   - A project can be pinned to `on` ONLY by an admin (the project's maintainer may pin `shadow`, or `off` where that is not below the company). `on` needs the evidence for the model whenever the project is not already
//     pinned `on`, even when the company itself is `on` and the project would follow it anyway. A project pinned `on` follows the company down: when the company is LOWERED (two admins), the lowering stamps the company
//     setting (`loweredAt`) and a pin written before that stamp stops counting (`readSecondReviewSettings`), so the project is back to the company's mode and an admin must pin it again. Atomic and race-free: nothing
//     has to find and rewrite the pinned projects inside the approval.
//   - A waiting proposal whose `from` is no longer what the scope effectively has is cancelled by the next proposal for that scope, in the same transaction (audited). Cancelling one is audited in its own transaction.
//   - Stored in the State table beside the company's other second-review settings (org/second-review-settings.ts): the company's mode is written as BOTH its `default` and its `lock` (the floor a project cannot go
//     below); a project's override is its `mode`. A proposal is `SECONDREVIEW#MODECHANGE#<id>`. Nothing new in the broker's environment.
//   - Every write is conditional on the values it was made against, and an approval commits the claim on the proposal, the setting, the fence and the audit event in ONE transaction, so a setting never changes
//     without its event and an event never names a change that was not made. A refusal by the fence alone leaves the proposal open ("membership_changed_retry").
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  configuredSecondReviewMode, orgMetaKey, secondReviewModeLoweringNeedsSecondPerson, stricterSecondReviewMode, SecondReviewModeSchema,
  type AuditEventInput, type SecondReviewMode,
} from "@agentx/contracts";
import type { TransactItem } from "../audit/outbox.js";
import { trySecondPersonTimed } from "../lessons/approve.js";
import { secondPersonTier0Authority } from "../lessons/tier0-authority.js";
import { idIn, sameId } from "../lessons/types.js";
import type { Tier0Authority, Tier0Group } from "../lessons/tier0-setting.js";
import { readSecondReviewSettings, SECOND_REVIEW_SETTINGS_SK, secondReviewProjectKey, type SecondReviewSettings, type SettingsTable } from "./second-review-settings.js";
import type { SecondPersonEvidenceDependencies } from "./second-person-evidence.js";

export const SECOND_REVIEW_MODE_CHANGE_TTL_MS = 7 * 86_400_000;
const CHANGE_PREFIX = "SECONDREVIEW#MODECHANGE#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const changeKey = (orgId: string, id: string) => ({ pk: orgPk(orgId), sk: `${CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export type ModeScope = { kind: "company" } | { kind: "project"; project: string };
const scopeKey = (scope: ModeScope): string => (scope.kind === "company" ? "company" : `project:${scope.project}`);

/** A proposal to lower the mode. `from` is the effective mode it was made against: an approval after that moved is stale. */
export interface ModeChange {
  id: string; orgId: string; scope: ModeScope;
  from: SecondReviewMode; to: SecondReviewMode;
  /** A project proposal that clears the override (the project follows the company again). `to` is then the mode it falls back to. */
  clear?: true;
  proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled";
}

export type ModeFailure =
  | "not_eligible" | "eligibility_unavailable" | "audit_unavailable" | "settings_unreadable"
  | "below_company_mode" | "verdict_missing" | "already_open" | "not_found" | "not_pending" | "expired" | "stale" | "second_person_required" | "conflict"
  | "membership_changed_retry";

/** What the writer asks of its caller: the audit event as a pending item (the route's ledger), and how to send it on after the commit. */
export interface ModeAudit { pending(event: Omit<AuditEventInput, "eventId" | "orgId" | "occurredAt" | "actor">, actorId: string, at: number): { put: TransactItem; flush(): Promise<void> } | undefined }

export interface ModeDeps {
  table: SettingsTable;
  evidence: SecondPersonEvidenceDependencies;
  audit: ModeAudit;
  now(): number;
  newId?: () => string;
  /** For tests: replaces the authority built from `evidence`. */
  authority?: Tier0Authority;
}
const authorityOf = (deps: ModeDeps): Tier0Authority => deps.authority ?? secondPersonTier0Authority(deps.evidence);
const send = (deps: ModeDeps, command: unknown) => deps.table.documentClient.send(command);

/** The mode a scope effectively has now (a project: its override, else the company's, never below the company's floor). */
export function effectiveMode(settings: Pick<SecondReviewSettings, "companyDefault" | "companyLock" | "projectMode">, scope: ModeScope): SecondReviewMode {
  return scope.kind === "company"
    ? stricterSecondReviewMode(settings.companyDefault ?? "off", settings.companyLock ?? "off")
    : configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
}
const companyModeOf = (settings: SecondReviewSettings): SecondReviewMode => effectiveMode(settings, { kind: "company" });

/** `attr = :v` for a stored value, `attribute_not_exists` for an absent one: a write made against what was read. */
function sameAsRead(fields: ReadonlyArray<[name: string, value: unknown]>, prefix: string): { expression: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const parts = fields.map(([name, value], index) => {
    names[`#${prefix}${index}`] = name;
    if (value === undefined) return `attribute_not_exists(#${prefix}${index})`;
    values[`:${prefix}${index}`] = value;
    return `#${prefix}${index} = :${prefix}${index}`;
  });
  return { expression: parts.join(" AND "), names, values };
}

/** The setting write for a mode change, conditional on what was read. A project change with `clear` removes the override. */
function settingUpdate(deps: ModeDeps, input: { orgId: string; scope: ModeScope; to: SecondReviewMode; clear?: boolean; lowering?: boolean; seen: SecondReviewSettings; by: string; at: number }): TransactItem {
  const company = input.scope.kind === "company";
  const key = company ? { pk: orgPk(input.orgId), sk: SECOND_REVIEW_SETTINGS_SK } : secondReviewProjectKey(input.orgId, (input.scope as { project: string }).project);
  // The project's guard is its STORED mode (a pin that has lapsed is still what is stored).
  const guard = company ? sameAsRead([["default", input.seen.companyDefault], ["lock", input.seen.companyLock]], "g") : sameAsRead([["mode", input.seen.projectModeStored]], "g");
  const names: Record<string, string> = { ...guard.names, "#t": "updatedAt", "#b": "updatedBy", "#e": "entityType" };
  const values: Record<string, unknown> = { ...guard.values, ":t": input.at, ":b": input.by, ":e": company ? "SECOND_REVIEW_SETTINGS" : "SECOND_REVIEW_PROJECT" };
  let expression: string;
  if (company) {
    names["#d"] = "default"; names["#l"] = "lock"; values[":m"] = input.to;
    // A lowering stamps the company, so a project pinned `on` before it stops counting.
    if (input.lowering === true) names["#la"] = "loweredAt";
    expression = `SET #d = :m, #l = :m, #t = :t, #b = :b, #e = :e${input.lowering === true ? ", #la = :t" : ""}`;
  } else if (input.clear === true) {
    names["#m"] = "mode"; names["#ma"] = "modeAt";
    expression = "SET #t = :t, #b = :b, #e = :e REMOVE #m, #ma";
  } else {
    names["#m"] = "mode"; names["#ma"] = "modeAt"; values[":m"] = input.to;
    expression = "SET #m = :m, #ma = :t, #t = :t, #b = :b, #e = :e";
  }
  return { Update: { TableName: deps.table.tableName, Key: key, UpdateExpression: expression, ConditionExpression: guard.expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
}

const auditFor = (deps: ModeDeps, event: Parameters<ModeAudit["pending"]>[0], actorId: string, at: number) => deps.audit.pending(event, actorId, at);
const eventTarget = (orgId: string, scope: ModeScope) => (scope.kind === "company" ? { kind: "org" as const, id: orgId.slice(0, 100) } : { kind: "project" as const, name: scope.project });

async function read(deps: ModeDeps, orgId: string, scope: ModeScope): Promise<SecondReviewSettings | undefined> {
  try { return await readSecondReviewSettings(deps.table, orgId, scope.kind === "project" ? scope.project : ""); } catch { return undefined; }
}

async function sendTransaction(deps: ModeDeps, items: TransactItem[]): Promise<"ok" | "cancelled"> {
  try { await send(deps, new TransactWriteCommand({ TransactItems: items })); return "ok"; } catch (error) {
    if (errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException") return "cancelled";
    throw error;
  }
}

export type ModeRequest = { ok: true; status: "applied"; mode: SecondReviewMode } | { ok: true; status: "needs_approval"; changeId: string } | { ok: false; code: ModeFailure };

/**
 * Asks to set the mode. The caller has checked the person's role for the scope (an admin; for a project also its maintainer) and that this is a live browser session; `onAllowed` is whether the evidence for the
 * chosen model holds (asked when `to` is `on`). A project value below the company's mode is refused. Equal or higher applies now; lower opens a proposal.
 */
export async function requestSecondReviewMode(deps: ModeDeps, input: { orgId: string; scope: ModeScope; to: SecondReviewMode | "inherit"; requestedBy: string; onAllowed: boolean; /** The caller's role: a company owner or admin. A project is pinned `on` only by one. */ requesterIsAdmin: boolean }): Promise<ModeRequest> {
  const { orgId, scope } = input;
  if (input.to === "inherit" ? scope.kind !== "project" : !SecondReviewModeSchema.safeParse(input.to).success) return { ok: false, code: "conflict" };
  // Blocking for a project is an admin's decision (owner decision 2026-11-02), not the maintainer's.
  if (scope.kind === "project" && input.to === "on" && !input.requesterIsAdmin) return { ok: false, code: "not_eligible" };
  const seen = await read(deps, orgId, scope);
  if (seen === undefined) return { ok: false, code: "settings_unreadable" };
  const before = effectiveMode(seen, scope);
  const clear = input.to === "inherit";
  const companyMode = companyModeOf(seen);
  const to: SecondReviewMode = clear ? companyMode : input.to as SecondReviewMode;
  if (scope.kind === "project" && !clear && secondReviewModeLoweringNeedsSecondPerson(companyMode, to)) return { ok: false, code: "below_company_mode" };
  const at = deps.now();
  const facts = { scope: scope.kind, from: before, to };
  if (!secondReviewModeLoweringNeedsSecondPerson(before, to)) {
    // Equal or stricter: applied now. `on` only for a model whose evidence holds, and that is asked whenever the scope is not already SET to `on` (a project that merely follows an `on` company is not pinned to it).
    const alreadyOn = scope.kind === "project" ? seen.projectMode === "on" : before === "on";
    if (to === "on" && !alreadyOn && !input.onAllowed) return { ok: false, code: "verdict_missing" };
    const audit = auditFor(deps, { action: "company.second_review_mode_changed", target: eventTarget(orgId, scope), facts: { ...facts, mode: "direct" } }, input.requestedBy, at);
    if (audit === undefined) return { ok: false, code: "audit_unavailable" };
    const result = await sendTransaction(deps, [settingUpdate(deps, { orgId, scope, to, clear, seen, by: input.requestedBy, at }), audit.put]);
    if (result === "cancelled") return { ok: false, code: "stale" };
    await audit.flush();
    return { ok: true, status: "applied", mode: to };
  }
  // Lowering: a proposal for a different eligible person.
  const open = await openModeChange(deps.table, orgId, scope, at).catch(() => "unreadable" as const);
  if (open === "unreadable") return { ok: false, code: "settings_unreadable" };
  // A waiting proposal that was made against a mode the scope no longer has can never be approved (it would be stale): the new proposal replaces it, in the same transaction.
  if (open !== undefined && open.from === before) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  const audit = auditFor(deps, { action: "company.second_review_mode_proposed", target: eventTarget(orgId, scope), facts }, input.requestedBy, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  const replaced = open === undefined ? undefined : auditFor(deps, { action: "company.second_review_mode_cancelled", target: eventTarget(orgId, scope), facts: { scope: scope.kind, from: open.from, to: open.to, cause: "stale" } }, input.requestedBy, at);
  if (open !== undefined && replaced === undefined) return { ok: false, code: "audit_unavailable" };
  const change: ModeChange = { id, orgId, scope, from: before, to, ...(clear ? { clear: true as const } : {}), proposedBy: input.requestedBy, at, expiresAt: at + SECOND_REVIEW_MODE_CHANGE_TTL_MS, state: "pending" };
  const result = await sendTransaction(deps, [
    ...(open === undefined ? [] : [cancelUpdate(deps, orgId, open.id), replaced!.put]),
    { Put: { TableName: deps.table.tableName, Item: { ...changeKey(orgId, id), entityType: "SECOND_REVIEW_MODE_CHANGE", ...structuredClone(change) }, ConditionExpression: "attribute_not_exists(pk)" } }, audit.put,
  ]);
  if (result === "cancelled") return { ok: false, code: "conflict" };
  await audit.flush();
  if (replaced !== undefined) await replaced.flush();
  return { ok: true, status: "needs_approval", changeId: id };
}

/** Marks a pending proposal cancelled (only while it is pending). */
const cancelUpdate = (deps: ModeDeps, orgId: string, id: string): TransactItem => ({
  Update: { TableName: deps.table.tableName, Key: changeKey(orgId, id), UpdateExpression: "SET #s = :cancelled", ConditionExpression: "#s = :pending", ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":cancelled": "cancelled", ":pending": "pending" } },
});

function parseChange(item: Record<string, unknown> | undefined): ModeChange | undefined {
  if (item?.entityType !== "SECOND_REVIEW_MODE_CHANGE" || typeof item.id !== "string" || typeof item.orgId !== "string") return undefined;
  const scope = item.scope as { kind?: unknown; project?: unknown } | undefined;
  const from = SecondReviewModeSchema.safeParse(item.from), to = SecondReviewModeSchema.safeParse(item.to);
  if (!from.success || !to.success || typeof item.proposedBy !== "string" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
  if (item.state !== "pending" && item.state !== "applied" && item.state !== "cancelled") return undefined;
  const parsedScope: ModeScope | undefined = scope?.kind === "company" ? { kind: "company" } : scope?.kind === "project" && typeof scope.project === "string" ? { kind: "project", project: scope.project } : undefined;
  if (parsedScope === undefined) return undefined;
  return { id: item.id, orgId: item.orgId, scope: parsedScope, from: from.data, to: to.data, ...(item.clear === true ? { clear: true as const } : {}), proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state };
}

/** A proposal by id, or none (an unreadable one is none). */
export async function getModeChange(table: SettingsTable, orgId: string, id: string): Promise<ModeChange | undefined> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: changeKey(orgId, id), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return parseChange(found.Item);
}

async function getChange(deps: ModeDeps, orgId: string, id: string): Promise<ModeChange | undefined> {
  const found = await send(deps, new GetCommand({ TableName: deps.table.tableName, Key: changeKey(orgId, id), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return parseChange(found.Item);
}

/** Every proposal item of the company, paged through to the end. */
async function allModeChanges(table: SettingsTable, orgId: string): Promise<ModeChange[]> {
  const found: ModeChange[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": CHANGE_PREFIX },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) { const change = parseChange(item); if (change !== undefined) found.push(change); }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

/** The scope's pending proposal that has not expired. */
export async function openModeChange(table: SettingsTable, orgId: string, scope: ModeScope, now: number): Promise<ModeChange | undefined> {
  return (await allModeChanges(table, orgId)).find((change) => change.state === "pending" && change.expiresAt > now && scopeKey(change.scope) === scopeKey(scope));
}

/** Every pending, unexpired proposal of the company (the settings page lists them for admins). */
export async function openModeChanges(table: SettingsTable, orgId: string, now: number): Promise<ModeChange[]> {
  return (await allModeChanges(table, orgId)).filter((change) => change.state === "pending" && change.expiresAt > now);
}

const groupOf = async (deps: ModeDeps, scope: ModeScope, orgId: string, who: { proposerId: string; approverId: string }): Promise<Tier0Group | undefined> => {
  const tier0Scope = scope.kind === "company" ? { kind: "company" as const, workspaceId: orgId } : { kind: "project" as const, workspaceId: orgId, project: scope.project };
  const group = await authorityOf(deps).eligibility(tier0Scope, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
};

export type ModeApproval = { ok: true; mode: SecondReviewMode } | { ok: false; code: ModeFailure };

/** A DIFFERENT eligible person approves a proposal to lower the mode. The proposer can never approve it and the sole-owner exception does not apply (the one-admin rule). */
export async function approveSecondReviewModeChange(deps: ModeDeps, input: { orgId: string; changeId: string; approverId: string }): Promise<ModeApproval> {
  const { orgId } = input;
  const change = await getChange(deps, orgId, input.changeId).catch(() => undefined);
  if (change === undefined || change.orgId !== orgId) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  if (sameId(change.proposedBy, input.approverId)) return { ok: false, code: "second_person_required" };
  const group = await groupOf(deps, change.scope, orgId, { proposerId: change.proposedBy, approverId: input.approverId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) return { ok: false, code: decision.code === "eligibility_unavailable" ? "eligibility_unavailable" : "second_person_required" };
  if (decision.mode !== "second_person") return { ok: false, code: "second_person_required" };
  const seen = await read(deps, orgId, change.scope);
  if (seen === undefined) return { ok: false, code: "settings_unreadable" };
  // The world moved since the proposal: what the scope effectively has is no longer what the proposal was made against.
  if (effectiveMode(seen, change.scope) !== change.from) return { ok: false, code: "stale" };
  // Clearing a project's override lands on the COMPANY's mode as it is now, which may differ from what it was when the proposal was made: the event and the answer say what the setting becomes.
  const to: SecondReviewMode = change.clear === true ? companyModeOf(seen) : change.to;
  const audit = auditFor(deps, { action: "company.second_review_mode_changed", target: eventTarget(orgId, change.scope), facts: { scope: change.scope.kind, from: change.from, to, mode: "second_person" } }, input.approverId, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  const claim: TransactItem = {
    Update: { TableName: deps.table.tableName, Key: changeKey(orgId, change.id), UpdateExpression: "SET #s = :applied", ConditionExpression: "#s = :pending AND proposedBy = :by AND expiresAt = :expires",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":applied": "applied", ":pending": "pending", ":by": change.proposedBy, ":expires": change.expiresAt } },
  };
  const write = settingUpdate(deps, { orgId, scope: change.scope, to, clear: change.clear === true, lowering: change.scope.kind === "company", seen, by: input.approverId, at });
  const result = await sendTransaction(deps, [...((group.fence ?? []) as TransactItem[]), claim, write, audit.put]);
  if (result === "ok") { await audit.flush(); return { ok: true, mode: to }; }
  // Refused: when the setting and the proposal are as they were, only the membership fence failed, and the proposal stays open for another try (every check runs again).
  const again = await read(deps, orgId, change.scope);
  const still = await getChange(deps, orgId, change.id).catch(() => undefined);
  if (again !== undefined && effectiveMode(again, change.scope) === change.from && still?.state === "pending") {
    const refused = auditFor(deps, { action: "company.second_review_mode_refused", target: eventTarget(orgId, change.scope), facts: { refusal: "membership_changed_retry" } }, input.approverId, at);
    if (refused !== undefined) { await sendTransaction(deps, [refused.put]).then(() => refused.flush()).catch(() => undefined); }
    return { ok: false, code: "membership_changed_retry" };
  }
  return { ok: false, code: "stale" };
}

/** The proposer, or another eligible person, withdraws a pending proposal. */
export async function cancelSecondReviewModeChange(deps: ModeDeps, input: { orgId: string; changeId: string; actorId: string }): Promise<{ ok: true } | { ok: false; code: ModeFailure }> {
  const change = await getChange(deps, input.orgId, input.changeId).catch(() => undefined);
  if (change === undefined || change.orgId !== input.orgId) return { ok: false, code: "not_found" };
  const group = await groupOf(deps, change.scope, input.orgId, { proposerId: input.actorId, approverId: input.actorId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const at = deps.now();
  const audit = auditFor(deps, { action: "company.second_review_mode_cancelled", target: eventTarget(input.orgId, change.scope), facts: { scope: change.scope.kind, from: change.from, to: change.to, cause: "withdrawn" } }, input.actorId, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  // The cancellation and its audit event commit together.
  const result = await sendTransaction(deps, [cancelUpdate(deps, input.orgId, change.id), audit.put]);
  if (result === "cancelled") return { ok: false, code: "not_pending" };
  await audit.flush();
  return { ok: true };
}
