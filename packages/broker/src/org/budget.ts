import { budgetDocumentFence } from "./budget-snapshot.js";
import { budgetActorChecks, budgetActorRefused, type BudgetActor } from "../agents/budget-authority.js";
import { coded, transact } from "../agents/table-writes.js";
import { usdToWholeMicrodollars } from "./budget-amount.js";
// Monthly AI budgets (ruling R29 for the numbers). An org has one monthly limit and each member one, with
// per-member overrides; the model proxy enforces them, and this module keeps the proxy told what they are
// (syncBudgets), asks it what has been spent (ModelAccess, ruling R28; the broker never talks to LiteLLM itself),
// and refuses work at its start when little is left (`admitWork`, in spend/admission.ts, which also caps each key). Caps are soft by at least one request (ruling
// R23), so a remainder is always clamped at 0 and nothing here promises an exact cap. LiteLLM's spend is the
// authoritative figure (ruling R22).
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD, budgetSyncedKey, orgSettingsKey, type AuditEventInput, type BudgetScope } from "@agentx/cloud-contracts";
import { AgentXError, agentXError, sameJsonContent, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { auditBudgetChanged, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import type { MintKeyInput, MintedKey, ModelAccess, SpendFigures } from "../model-proxy/access.js";
import type { OrgStore } from "./store.js";
import { readTopUp, withTopUp } from "../spend/top-ups.js";
import { monthOf } from "./trial.js";

/** Server-only authority: operator credentials remain a distinct trust boundary, not company membership. */
export type BudgetWriteAuthority = BudgetActor | { operator: Extract<AuditActor, { kind: "operator" }> };

export interface OrgBudgetSettings {
  /** Absent: the org has no monthly limit (a private or single-org install until an operator sets one, ruling R47). */
  orgMonthlyUsd?: number;
  /** Absent: members have no monthly limit of their own beyond their overrides (same ruling). */
  memberDefaultMonthlyUsd?: number;
  /** developerId to that member's own monthly limit, in place of the default. */
  memberOverrides: Record<string, number>;
}

export interface BudgetDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  access: ModelAccess;
  /** Epoch milliseconds; the month the machine-time allowance is read for. Defaults to the system clock. */
  now?: () => number;
  /** Ruling R47: true on a cloud install, whose orgs start with the placeholder monthly limits; any other install's orgs start with none. */
  cloud?: boolean;
  /** The Audit Ledger's outbox; absent on a legacy install, where a budget change records nothing. */
  audit?: AuditRuntime;
  /**
   * Lessons worker (lane 2, re-check R2): the BUDGET_SYNCED markers are only a cache of what the proxy was told, and the worker's role may not write them (its State grant is limited to its own key patterns; the
   * budget settings partition is deliberately NOT among them). With this set, a marker write or delete the table refuses with AccessDenied is skipped and reported once with a fixed code; the proxy is
   * told again the next time instead (an upsert is idempotent), and a lost proxy state heals by forcing that upsert rather than by clearing markers. Any other fault still throws.
   */
  bestEffortMarkers?: { log(event: string, fields: Record<string, string>): void };
}

export interface AdmissionDependencies extends BudgetDependencies {
  /** Ruling R42: true only on a cloud install. Only its orgs are subject to the trial lock and the machine-time allowance. */
  cloud: boolean;
}

/** What a kind of work needs left, in US dollars, to be started: a quick task, a full workflow, a chat turn, a task an agent runs, or an agent-step run. */
export type SpendPath = "QUICK" | "FULL" | "CHAT" | "TASK" | "AGENT";
export const MINIMUM_REMAINING_USD: Record<SpendPath, number> = { QUICK: 0.5, FULL: 2, CHAT: 0.05, TASK: 0.5, AGENT: 0.1 };

/** The largest limit a setting may carry; the model proxy's protocol refuses more. */
export const MAX_BUDGET_USD = 1_000_000;
export const MAX_BUDGET_OVERRIDES = 500;

const defaults = (cloud: boolean | undefined): OrgBudgetSettings => cloud === true
  ? { orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: {} }
  : { memberOverrides: {} };

/**
 * What the proxy is told for a limit that is not set: the largest amount it accepts, which no member or org reaches. The broker's own
 * admission and key caps do not read the proxy's figure for such a limit (ruling R47); they treat it as unlimited.
 */
const proxyLimit = (limit: number | undefined): number => limit ?? MAX_BUDGET_USD;

export const isBudgetAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_USD;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function get(deps: Pick<BudgetDependencies, "documentClient" | "tableName">, key: OrgKey): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The org's budget settings; an org that never set any, or a record that does not read, has the defaults. */
export async function readBudgets<D extends Pick<BudgetDependencies, "documentClient" | "tableName" | "cloud">>(deps: D, orgId: OrgId): Promise<OrgBudgetSettings> {
  return budgetsFromItem(deps, await get(deps, orgSettingsKey(orgId, "BUDGET")));
}

function budgetsFromItem(deps: Pick<BudgetDependencies, "cloud">, item: Record<string, unknown> | undefined): OrgBudgetSettings {
  const base = defaults(deps.cloud);
  if (item === undefined) return base;
  const overrides: Record<string, number> = {};
  if (isRecord(item.memberOverrides)) for (const [developerId, limit] of Object.entries(item.memberOverrides)) if (isBudgetAmount(limit)) overrides[developerId] = limit;
  return withLimits({
    orgMonthlyUsd: isBudgetAmount(item.orgMonthlyUsd) ? item.orgMonthlyUsd : base.orgMonthlyUsd,
    memberDefaultMonthlyUsd: isBudgetAmount(item.memberDefaultMonthlyUsd) ? item.memberDefaultMonthlyUsd : base.memberDefaultMonthlyUsd,
  }, overrides);
}

/** Settings from limits that may be unset: an unset limit is left out of the record, never written as undefined. */
export function withLimits(limits: { orgMonthlyUsd: number | undefined; memberDefaultMonthlyUsd: number | undefined }, memberOverrides: Record<string, number>): OrgBudgetSettings {
  return {
    ...(limits.orgMonthlyUsd === undefined ? {} : { orgMonthlyUsd: limits.orgMonthlyUsd }),
    ...(limits.memberDefaultMonthlyUsd === undefined ? {} : { memberDefaultMonthlyUsd: limits.memberDefaultMonthlyUsd }),
    memberOverrides,
  };
}

/** The member's monthly limit, or undefined when they have none (ruling R47). */
export const memberLimitOf = (settings: OrgBudgetSettings, developerId: string): number | undefined => settings.memberOverrides[developerId] ?? settings.memberDefaultMonthlyUsd;

/**
 * The most `budget.changed` events one change may record. They commit in the same transaction as the settings, which holds
 * 100 items: the document, three actor checks and at most 96 pending items.
 */
export const BUDGET_CHANGE_EVENTS_MAX = 96;

const toCents = (usd: number | undefined): number | undefined => usd === undefined ? undefined : Math.round(usd * 100);

/**
 * One `budget.changed` event for each limit this write changes: the org's, the members' default, and each member whose own
 * limit moved (from what they had to what they have now, a removed override falling back to the default; an override that
 * equals the default figure, added or removed, moves nothing). A member whose only change is the default is covered by the
 * default's event. Each event has its own id, from the write's time and writer plus the limit it is about.
 */
function budgetChangeEvents(input: { orgId: OrgId; before: OrgBudgetSettings; after: OrgBudgetSettings; updatedBy: string; at: string; actor: AuditActor; revision?: number }): AuditEventInput[] {
  const { orgId, before, after, updatedBy, at, actor } = input;
  const event = (scopeKind: string, field: string, targetId: string, from: number | undefined, to: number | undefined, related?: string[]) => auditBudgetChanged({
    orgId, actor, occurredAt: at, occurrence: auditOccurrence(String(input.revision ?? 0), at, updatedBy, field, targetId),
    target: { kind: "budget", id: targetId }, scopeKind, field,
    ...(from === undefined ? {} : { fromCents: toCents(from)! }), ...(to === undefined ? {} : { toCents: toCents(to)! }),
    ...(related === undefined ? {} : { related }),
  });
  const events: AuditEventInput[] = [];
  if (before.orgMonthlyUsd !== after.orgMonthlyUsd) events.push(event("org", "org_monthly_limit", orgId, before.orgMonthlyUsd, after.orgMonthlyUsd));
  if (before.memberDefaultMonthlyUsd !== after.memberDefaultMonthlyUsd) events.push(event("org", "member_default_limit", orgId, before.memberDefaultMonthlyUsd, after.memberDefaultMonthlyUsd));
  for (const developerId of [...new Set([...Object.keys(before.memberOverrides), ...Object.keys(after.memberOverrides)])].sort()) {
    const from = memberLimitOf(before, developerId);
    const to = memberLimitOf(after, developerId);
    if (from === to) continue;
    events.push(event("member", "member_monthly_limit", developerId, from, to, [developerId]));
  }
  return events;
}

/**
 * The events a change would record: none on an install with no ledger, and none (the failure logged) when the settings to
 * compare with cannot be read or an event cannot be built. `before` is read here when the caller has not.
 */
function plannedBudgetEvents(deps: BudgetDependencies, input: { orgId: OrgId; before?: OrgBudgetSettings | undefined; after: OrgBudgetSettings; updatedBy: string; at: string; actor?: AuditActor | undefined; revision?: number }): Promise<AuditEventInput[]> {
  return tryAuditEvents(deps, async () => budgetChangeEvents({
    ...input, before: input.before ?? await readBudgets(deps, input.orgId), actor: input.actor ?? { kind: "member", id: input.updatedBy },
  }));
}

/**
 * A change that would record more events than fit in the settings' own transaction is refused, not split: the events must
 * commit with the change or not at all. The message names a count and no value.
 */
function refuseUnrecordableChange(events: readonly AuditEventInput[], maximum = BUDGET_CHANGE_EVENTS_MAX): void {
  if (events.length > maximum) {
    throw agentXError("CONFIG_INVALID", `body: this change would change ${String(events.length)} limits at once and at most ${String(maximum)} can be recorded in one request; change fewer in each`);
  }
}

/**
 * Writes the settings whole. The caller has validated them; `syncBudgets` then tells the proxy. On an install with a ledger the
 * write is one transaction with a `budget.changed` pending item for each limit it changes, and the events are sent after the
 * commit. A change of more than `BUDGET_CHANGE_EVENTS_MAX` limits is refused with CONFIG_INVALID before anything is written.
 * `options.before`/expectedRevision pin the caller snapshot; the audit always compares the canonical read.
 * `options.authority` is mandatory; the optional audit actor keeps the existing audit vocabulary.
 */
/** Canonical snapshot for writes. Legacy revisionless documents advance only under their exact stored field fence. */
async function budgetSnapshot(deps: BudgetDependencies, orgId: OrgId) {
  const raw = await get(deps, orgSettingsKey(orgId, "BUDGET"));
  const fence = budgetDocumentFence(raw, { repairMalformed: true });
  if (raw !== undefined && ((raw.orgMonthlyUsd !== undefined && !isBudgetAmount(raw.orgMonthlyUsd)) || (raw.memberDefaultMonthlyUsd !== undefined && !isBudgetAmount(raw.memberDefaultMonthlyUsd)) || (raw.memberOverrides !== undefined && (!isRecord(raw.memberOverrides) || Object.values(raw.memberOverrides).some(value => !isBudgetAmount(value)))))) throw agentXError("CONFIG_INVALID", "The company budget cannot be read for a change. Ask an org owner or admin to repair it.");
  return { raw, revision: fence.revision, fence, settings: budgetsFromItem(deps, raw) };
}

export async function writeBudgets(
  deps: BudgetDependencies, orgId: OrgId, settings: OrgBudgetSettings, updatedBy: string, at: string,
  options: { authority: BudgetWriteAuthority; expectedRevision?: number; before?: OrgBudgetSettings; actor?: AuditActor },
): Promise<void> {
  if (options?.authority === undefined) throw budgetActorRefused();
  let checks: ReturnType<typeof budgetActorChecks>;
  let auditActor = options.actor;
  let eventLimit = BUDGET_CHANGE_EVENTS_MAX;
  if ("operator" in options.authority) {
    const operator = options.authority.operator;
    if (operator?.kind !== "operator" || !/^op_[0-9a-f]{24}$/.test(operator.id) || updatedBy !== operator.id) throw budgetActorRefused();
    // The existing operator/admin credential gate is at the route; no member row is fabricated or required.
    checks = []; auditActor = operator; eventLimit = 98;
  } else {
    if (options.authority.developerId !== updatedBy || (options.authority.role !== "owner" && options.authority.role !== "admin")) throw budgetActorRefused();
    checks = budgetActorChecks(deps.tableName, orgId, options.authority);
  }
  const current = await budgetSnapshot(deps, orgId);
  const conflict = () => coded("CHANGE_STALE", "The company budget changed. Reload it and review your change again.");
  if ((options.expectedRevision !== undefined && options.expectedRevision !== current.revision) || (options.before !== undefined && !sameJsonContent(options.before, current.settings))) throw conflict();
  const revision = current.fence.nextRevision;
  const item = { ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", ...settings, revision, updatedBy, updatedAt: at };
  const events = await plannedBudgetEvents(deps, { orgId, before: current.settings, after: settings, updatedBy, at, actor: auditActor, revision });
  refuseUnrecordableChange(events, Math.min(eventLimit, 99 - checks.length));
  if (events.length > 99 - checks.length) throw agentXError("CONFIG_INVALID", "This change has too many budget audit entries for one atomic request; change fewer limits.");
  const items = [{ Put: { TableName: deps.tableName, Item: item, ...current.fence.condition } }, ...events.flatMap(event => auditPending(deps, event))];
  const actorStart = items.length;
  await transact({ ...deps, now: deps.now ?? Date.now }, [...items, ...checks], failed => [...failed].some(index => index >= actorStart) ? budgetActorRefused() : conflict());
  await flushAuditEvents(deps, events);
}

/** A call to the proxy for a budget decision: whatever goes wrong with it, the answer is MODEL_PROXY_UNAVAILABLE, with none of its detail. */
export async function viaProxy<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AgentXError && error.code === "MODEL_PROXY_UNAVAILABLE") throw error;
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not be asked about your budget");
  }
}

async function mark(deps: BudgetDependencies, key: OrgKey, limitUsd: number): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...key, entityType: "BUDGET_SYNCED", limitUsd } }));
  } catch (error) {
    if (deps.bestEffortMarkers === undefined || (error as { name?: unknown } | null)?.name !== "AccessDeniedException") throw error;
    deps.bestEffortMarkers.log("budget_marker.skipped", { code: "access_denied" });
  }
}

/** A base limit with the month's top-up for its scope (Task 28); a limit that is not set is not read for one. */
async function monthLimit(deps: Pick<BudgetDependencies, "documentClient" | "tableName">, orgId: OrgId, month: string, scope: BudgetScope, base: number | undefined): Promise<number | undefined> {
  return base === undefined ? undefined : withTopUp(base, await readTopUp(deps, orgId, month, scope));
}

/**
 * Tells the proxy the org's limit and each named member's, and marks what it was told so `ensureSynced` skips
 * them until a limit changes. A proxy refusal propagates (MODEL_PROXY_UNAVAILABLE when it cannot be reached).
 */
export async function syncBudgets(
  deps: BudgetDependencies & { orgs: Pick<OrgStore, "orgForDeveloper"> },
  orgId: OrgId,
  developerIds: readonly string[] = [],
): Promise<void> {
  const settings = await readBudgets(deps, orgId);
  const month = monthOf((deps.now ?? Date.now)());
  const orgLimit = proxyLimit(await monthLimit(deps, orgId, month, { kind: "org" }, settings.orgMonthlyUsd));
  await deps.access.upsertOrg(orgId, orgLimit);
  await mark(deps, budgetSyncedKey(orgId), orgLimit);
  for (const developerId of new Set(developerIds)) {
    // Proxy users are global by id, so a limit is only ever written for a member of this org: an id of another org, or of nobody, is skipped.
    if ((await deps.orgs.orgForDeveloper(developerId))?.orgId !== orgId) continue;
    const limit = proxyLimit(await monthLimit(deps, orgId, month, { kind: "member", developerId }, memberLimitOf(settings, developerId)));
    await deps.access.upsertMember(orgId, developerId, limit);
    await mark(deps, budgetSyncedKey(orgId, developerId), limit);
  }
}

const BudgetAmountSchema = z.number().refine(value => usdToWholeMicrodollars(value) !== undefined, "must be USD from 0 to 1000000 with at most 6 decimal places");
/** The body of a budget change, from an org owner or admin (`PUT /v1/dev/org/budget`) or an operator (`PUT /v1/admin/org/budget`). */
export const PutBudgetBodySchema = z.object({
  requestId: z.string().uuid(),
  orgMonthlyUsd: BudgetAmountSchema.optional(),
  memberDefaultMonthlyUsd: BudgetAmountSchema.optional(),
  memberOverrides: z.record(z.string().min(1).max(256), BudgetAmountSchema).refine((overrides) => Object.keys(overrides).length <= MAX_BUDGET_OVERRIDES, `at most ${String(MAX_BUDGET_OVERRIDES)} overrides`).optional(),
}).strict();

/**
 * Sets the org's monthly limit, the members' default, and per-member overrides; what is not named stays as it was, and
 * `memberOverrides`, when named, replaces the whole map. The settings are written, then the proxy is told (the org and every
 * member whose limit this named or removed), always. Members under the default are told lazily, at their next start. If the
 * proxy cannot be reached the settings stand and the call fails with MODEL_PROXY_UNAVAILABLE. The caller has decided who may ask.
 */
export async function changeBudgets(
  deps: BudgetDependencies & { orgs: Pick<OrgStore, "orgForDeveloper" | "getOrg"> },
  input: { authority: BudgetWriteAuthority; orgId: OrgId; body: unknown; updatedBy: string; at: string; /** Who is recorded as the changer; the member `updatedBy` when absent. */ actor?: AuditActor },
): Promise<OrgBudgetSettings> {
  const parsed = PutBudgetBodySchema.safeParse(input.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { orgMonthlyUsd, memberDefaultMonthlyUsd, memberOverrides } = parsed.data;
  if (orgMonthlyUsd === undefined && memberDefaultMonthlyUsd === undefined && memberOverrides === undefined) {
    throw agentXError("CONFIG_INVALID", "body: name at least one of orgMonthlyUsd, memberDefaultMonthlyUsd and memberOverrides");
  }
  // Ruling R49: a trial org stays within the placeholder limits until billing exists; a team plan may go up to MAX_BUDGET_USD.
  if ((await deps.orgs.getOrg(input.orgId))?.plan === "trial") {
    const tooHigh = (orgMonthlyUsd ?? 0) > DEFAULT_ORG_MONTHLY_BUDGET_USD
      || [memberDefaultMonthlyUsd ?? 0, ...Object.values(memberOverrides ?? {})].some((limit) => limit > DEFAULT_MEMBER_MONTHLY_BUDGET_USD);
    if (tooHigh) {
      throw agentXError("CONFIG_INVALID", `a trial organization's limits are at most $${String(DEFAULT_ORG_MONTHLY_BUDGET_USD)} a month for the organization and $${String(DEFAULT_MEMBER_MONTHLY_BUDGET_USD)} for a member; upgrade the plan to raise them`);
    }
  }
  // Proxy users are global by id: an override may name only a member of the org itself, or one admin could set another org's member's cap.
  for (const developerId of Object.keys(memberOverrides ?? {})) {
    if ((await deps.orgs.orgForDeveloper(developerId))?.orgId !== input.orgId) throw agentXError("CONFIG_INVALID", "memberOverrides: every override must name a member of this organization");
  }
  const snapshot = await budgetSnapshot(deps, input.orgId);
  const before = snapshot.settings;
  const after = withLimits({
    orgMonthlyUsd: orgMonthlyUsd ?? before.orgMonthlyUsd,
    memberDefaultMonthlyUsd: memberDefaultMonthlyUsd ?? before.memberDefaultMonthlyUsd,
  }, memberOverrides ?? before.memberOverrides);
  // The canonical writer checks the audit count before committing or telling the proxy.
  await writeBudgets(deps, input.orgId, after, input.updatedBy, input.at, { authority: input.authority, expectedRevision: snapshot.revision, before, ...(input.actor === undefined ? {} : { actor: input.actor }) });
  await syncBudgets(deps, input.orgId, [...Object.keys(before.memberOverrides), ...Object.keys(after.memberOverrides)]);
  return after;
}

/**
 * The lazy sync (before the first key for an org or member the proxy may not know yet, and again after a limit
 * changes): one read of the settings and one of each marker, and an upsert only when the marker differs from the
 * current limit. A member lowered by an admin is upserted again here, at their next start.
 */
export async function ensureSynced(deps: BudgetDependencies, orgId: OrgId, developerId?: string, options: { force?: boolean } = {}): Promise<OrgBudgetSettings> {
  const settings = await readBudgets(deps, orgId);
  const synced = async (key: OrgKey, limit: number) => options.force !== true && (await get(deps, key))?.limitUsd === limit;
  // The limit the proxy enforces is the base plus this month's top-up, so a new month (or a top-up) changes it and is told again.
  const month = monthOf((deps.now ?? Date.now)());
  const orgLimit = proxyLimit(await monthLimit(deps, orgId, month, { kind: "org" }, settings.orgMonthlyUsd));
  if (!await synced(budgetSyncedKey(orgId), orgLimit)) {
    await viaProxy(() => deps.access.upsertOrg(orgId, orgLimit));
    await mark(deps, budgetSyncedKey(orgId), orgLimit);
  }
  if (developerId !== undefined) {
    const limit = proxyLimit(await monthLimit(deps, orgId, month, { kind: "member", developerId }, memberLimitOf(settings, developerId)));
    if (!await synced(budgetSyncedKey(orgId, developerId), limit)) {
      await viaProxy(() => deps.access.upsertMember(orgId, developerId, limit));
      await mark(deps, budgetSyncedKey(orgId, developerId), limit);
    }
  }
  return settings;
}

export const dollars = (amount: number): string => amount.toFixed(2);
/** Subtraction of cents leaves float dust (29 - 28.8); a key's cap is never given more precision than a millionth of a dollar. */
export const clean = (amount: number): number => Number(amount.toFixed(6));
/** What is left, clamped at 0 (R23) and cleaned, so float dust (a millionth of a dollar) is nothing left rather than a key capped at nearly 0. */
export const remaining = (figures: SpendFigures): number => clean(Math.max(0, figures.limitUsd - figures.spentUsd));

export const budgetExceeded = (spent: number, limit: number) =>
  agentXError("BUDGET_EXCEEDED", `Your monthly AI budget is used up ($${dollars(spent)} of $${dollars(limit)}). Ask an admin to raise it.`);
export const orgBudgetExceeded = () =>
  agentXError("ORG_BUDGET_EXCEEDED", "Your company's monthly AI budget is used up. Ask an admin to raise it.");

/**
 * Whether the proxy's refusal says it has lost the org or member it was told about (its database was restored or replaced):
 * a 404, or a 400 saying the team or user does not exist. Any other refusal is its own.
 */
function isLostProxyState(error: unknown): boolean {
  if (!(error instanceof AgentXError)) return false;
  if (error.code === "NOT_FOUND") return true;
  return error.code === "CONFIG_INVALID" && /\b(team|user)\b[^.]{0,40}(does not exist|doesn't exist|not found)/iu.test(error.message);
}

/**
 * Runs a call that names the org (and member) to the proxy. When the proxy answers that it does not know them, the
 * BUDGET_SYNCED markers (which say the proxy was told) are cleared, the proxy is told again, and the call is made once more.
 * A second refusal is the call's own. Lost proxy state therefore heals itself instead of failing every call until a limit changes.
 */
async function healingLostProxyState<T>(deps: BudgetDependencies, orgId: OrgId, developerId: string | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isLostProxyState(error)) throw error;
    if (deps.bestEffortMarkers !== undefined) {
      // R2: this caller may not write the markers, so it does not clear them: the proxy is told again whatever they say.
      await ensureSynced(deps, orgId, developerId, { force: true });
      return call();
    }
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: budgetSyncedKey(orgId) }));
    if (developerId !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: budgetSyncedKey(orgId, developerId) }));
    await ensureSynced(deps, orgId, developerId);
    return call();
  }
}

/** Mints a key for the org (and member) the input names, healing lost proxy state once. */
export async function mintKeyHealing(deps: BudgetDependencies, input: MintKeyInput): Promise<MintedKey> {
  return healingLostProxyState(deps, input.orgId, input.developerId, () => deps.access.mintKey(input));
}

export async function figuresFor(deps: BudgetDependencies, orgId: OrgId, developerId: string | undefined): Promise<{ member?: SpendFigures; org: SpendFigures }> {
  // viaProxy is outermost: the proxy's own refusal must reach the healing as it is, and only what is left of it becomes MODEL_PROXY_UNAVAILABLE.
  return viaProxy(() => healingLostProxyState(deps, orgId, developerId, async () => {
    if (developerId === undefined) return { org: await deps.access.orgSpend(orgId) };
    return deps.access.spend(orgId, developerId);
  }));
}

/** LiteLLM's token id for a key: the lowercase hex SHA-256 of it. Safe to store; the key is not recoverable from it. */
export const keyIdOf = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * Ruling R38: the cumulative spend of a task's keys so far, which a Continue records as the start of the task's new cap window.
 * Zero when the task has minted none. A proxy that cannot answer is MODEL_PROXY_UNAVAILABLE, so the Continue changes nothing.
 */
export async function taskSpendBaseline(deps: BudgetDependencies, keyIds: readonly string[]): Promise<number> {
  return keyIds.length === 0 ? 0 : clean(await viaProxy(() => deps.access.keySpend(keyIds)));
}

/**
 * The one write of a record's `modelKeyIds` (convergence lane A5, owner decision 60 item S2: no list append and no `size` on Code's document store). The
 * whole list is written, the keys the caller read plus the new one, only while the record still holds exactly the list read: none (`attribute_not_exists`,
 * on a record that exists) or that same list (`=`). That is the old `size(#ids) = :count` fence made exact: two mints that raced cannot both be given the
 * task's whole remainder, and a list that was emptied and refilled to the same length in between is not overwritten either. The stored shape (a list of
 * token ids, in mint order) is unchanged, so readers and stored rows need no migration.
 */
export function modelKeyIdsWrite(knownIds: readonly string[], keyId: string): { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  return {
    UpdateExpression: "SET #ids = :next",
    ConditionExpression: knownIds.length === 0 ? "attribute_exists(pk) AND attribute_not_exists(#ids)" : "#ids = :known",
    ExpressionAttributeNames: { "#ids": "modelKeyIds" },
    ExpressionAttributeValues: { ":next": [...knownIds, keyId], ...(knownIds.length === 0 ? {} : { ":known": [...knownIds] }) },
  };
}

/**
 * Notes a minted key on the record that owns it (a task, or the operation of Slack work), so the next mint counts its spend.
 * `knownIds` are the keys the record held when the caller read it: the write happens only if it still holds exactly those (`modelKeyIdsWrite`),
 * so two mints that raced cannot both be given the task's whole remainder. Answers false when another mint recorded first.
 *
 * Never delete or revoke task keys before the task closes: their spend is the task's cumulative count (ruling R30), and a
 * key the proxy no longer knows makes `keySpend` fail closed.
 */
export async function recordMintedKey(deps: BudgetDependencies, key: OrgKey | { pk: string; sk: string }, keyId: string, knownIds: readonly string[]): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, ...modelKeyIdsWrite(knownIds, keyId) }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
