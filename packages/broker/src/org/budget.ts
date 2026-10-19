// Monthly AI budgets (ruling R29 for the numbers). An org has one monthly limit and each member one, with
// per-member overrides; the model proxy enforces them, and this module keeps the proxy told what they are
// (syncBudgets), asks it what has been spent (ModelAccess, ruling R28; the broker never talks to LiteLLM itself),
// and refuses work at its start when little is left (admitSpend). Caps are soft by at least one request (ruling
// R23), so a remainder is always clamped at 0 and nothing here promises an exact cap. LiteLLM's spend is the
// authoritative figure (ruling R22).
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD, PER_TASK_BUDGET_USD, TASK_BUDGET_EXCEEDED_PREFIX,
  AgentXError, agentXError, budgetSyncedKey, orgSettingsKey, type OrgId, type OrgKey,
} from "@agentx/contracts";
import type { ModelAccess, SpendFigures } from "../model-proxy/access.js";
import type { OrgStore } from "./store.js";
import { admitMachineTime, admitTrial } from "./trial.js";

export interface OrgBudgetSettings {
  orgMonthlyUsd: number;
  memberDefaultMonthlyUsd: number;
  /** developerId to that member's own monthly limit, in place of the default. */
  memberOverrides: Record<string, number>;
}

export interface BudgetDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  access: ModelAccess;
  /** Epoch milliseconds; the month the machine-time allowance is read for. Defaults to the system clock. */
  now?: () => number;
}

export interface AdmissionDependencies extends BudgetDependencies {
  /** Ruling R42: true only on a cloud install. Only its orgs are subject to the trial lock and the machine-time allowance. */
  cloud: boolean;
}

/** What a kind of work needs left, in US dollars, to be started: a quick task, a full workflow, or a chat turn. */
export type SpendPath = "QUICK" | "FULL" | "CHAT";
export const MINIMUM_REMAINING_USD: Record<SpendPath, number> = { QUICK: 0.5, FULL: 2, CHAT: 0.05 };

/** The largest limit a setting may carry; the model proxy's protocol refuses more. */
export const MAX_BUDGET_USD = 1_000_000;
export const MAX_BUDGET_OVERRIDES = 500;

const defaults = (): OrgBudgetSettings => ({
  orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD,
  memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD,
  memberOverrides: {},
});

export const isBudgetAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_USD;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function get(deps: BudgetDependencies, key: OrgKey): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The org's budget settings; an org that never set any, or a record that does not read, has the defaults. */
export async function readBudgets(deps: BudgetDependencies, orgId: OrgId): Promise<OrgBudgetSettings> {
  const item = await get(deps, orgSettingsKey(orgId, "BUDGET"));
  if (item === undefined) return defaults();
  const base = defaults();
  const overrides: Record<string, number> = {};
  if (isRecord(item.memberOverrides)) for (const [developerId, limit] of Object.entries(item.memberOverrides)) if (isBudgetAmount(limit)) overrides[developerId] = limit;
  return {
    orgMonthlyUsd: isBudgetAmount(item.orgMonthlyUsd) ? item.orgMonthlyUsd : base.orgMonthlyUsd,
    memberDefaultMonthlyUsd: isBudgetAmount(item.memberDefaultMonthlyUsd) ? item.memberDefaultMonthlyUsd : base.memberDefaultMonthlyUsd,
    memberOverrides: overrides,
  };
}

export const memberLimitOf = (settings: OrgBudgetSettings, developerId: string): number => settings.memberOverrides[developerId] ?? settings.memberDefaultMonthlyUsd;

/** Writes the settings whole. The caller has validated them; `syncBudgets` then tells the proxy. */
export async function writeBudgets(deps: BudgetDependencies, orgId: OrgId, settings: OrgBudgetSettings, updatedBy: string, at: string): Promise<void> {
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", ...settings, updatedBy, updatedAt: at },
  }));
}

/** A call to the proxy for a budget decision: whatever goes wrong with it, the answer is MODEL_PROXY_UNAVAILABLE, with none of its detail. */
async function viaProxy<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AgentXError && error.code === "MODEL_PROXY_UNAVAILABLE") throw error;
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not be asked about your budget");
  }
}

async function mark(deps: BudgetDependencies, key: OrgKey, limitUsd: number): Promise<void> {
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...key, entityType: "BUDGET_SYNCED", limitUsd } }));
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
  await deps.access.upsertOrg(orgId, settings.orgMonthlyUsd);
  await mark(deps, budgetSyncedKey(orgId), settings.orgMonthlyUsd);
  for (const developerId of new Set(developerIds)) {
    // Proxy users are global by id, so a limit is only ever written for a member of this org: an id of another org, or of nobody, is skipped.
    if ((await deps.orgs.orgForDeveloper(developerId))?.orgId !== orgId) continue;
    const limit = memberLimitOf(settings, developerId);
    await deps.access.upsertMember(orgId, developerId, limit);
    await mark(deps, budgetSyncedKey(orgId, developerId), limit);
  }
}

/**
 * The lazy sync (before the first key for an org or member the proxy may not know yet, and again after a limit
 * changes): one read of the settings and one of each marker, and an upsert only when the marker differs from the
 * current limit. A member lowered by an admin is upserted again here, at their next start.
 */
export async function ensureSynced(deps: BudgetDependencies, orgId: OrgId, developerId?: string): Promise<OrgBudgetSettings> {
  const settings = await readBudgets(deps, orgId);
  const synced = async (key: OrgKey, limit: number) => (await get(deps, key))?.limitUsd === limit;
  if (!await synced(budgetSyncedKey(orgId), settings.orgMonthlyUsd)) {
    await viaProxy(() => deps.access.upsertOrg(orgId, settings.orgMonthlyUsd));
    await mark(deps, budgetSyncedKey(orgId), settings.orgMonthlyUsd);
  }
  if (developerId !== undefined) {
    const limit = memberLimitOf(settings, developerId);
    if (!await synced(budgetSyncedKey(orgId, developerId), limit)) {
      await viaProxy(() => deps.access.upsertMember(orgId, developerId, limit));
      await mark(deps, budgetSyncedKey(orgId, developerId), limit);
    }
  }
  return settings;
}

const dollars = (amount: number): string => amount.toFixed(2);
/** Subtraction of cents leaves float dust (29 - 28.8); a key's cap is never given more precision than a millionth of a dollar. */
const clean = (amount: number): number => Number(amount.toFixed(6));
/** What is left, clamped at 0 (R23) and cleaned, so float dust (a millionth of a dollar) is nothing left rather than a key capped at nearly 0. */
const remaining = (figures: SpendFigures): number => clean(Math.max(0, figures.limitUsd - figures.spentUsd));

export const budgetExceeded = (spent: number, limit: number) =>
  agentXError("BUDGET_EXCEEDED", `Your monthly AI budget is used up ($${dollars(spent)} of $${dollars(limit)}). Ask an admin to raise it.`);
export const orgBudgetExceeded = () =>
  agentXError("ORG_BUDGET_EXCEEDED", "Your company's monthly AI budget is used up. Ask an admin to raise it.");

async function figuresFor(deps: BudgetDependencies, orgId: OrgId, developerId: string | undefined): Promise<{ member?: SpendFigures; org: SpendFigures }> {
  if (developerId === undefined) return { org: await viaProxy(() => deps.access.orgSpend(orgId)) };
  return viaProxy(() => deps.access.spend(orgId, developerId));
}

/**
 * Whether work may start. On a cloud install, first the org's trial must be unlocked and its month's machine time not used up
 * (both answered from the org's own records, before the proxy is asked anything; a private install has neither limit, R42), then the budgets (ruling R23: soft caps, remainders clamped at 0). The member (when there is one: Slack work
 * of an unlinked requester answers to the org alone) must have at least the path's minimum left, then the org must.
 * Answers the most a key for this work may spend: what is left to the member and the org, never more than one task's
 * budget. The proxy's own failures propagate, MODEL_PROXY_UNAVAILABLE among them, before anything is charged.
 */
export async function admitSpend(deps: AdmissionDependencies, input: { orgId: OrgId; developerId?: string | undefined; path: SpendPath }): Promise<{ maxBudgetUsd: number }> {
  if (deps.cloud) {
    await admitTrial(deps, input.orgId);
    await admitMachineTime(deps, input.orgId);
  }
  await ensureSynced(deps, input.orgId, input.developerId);
  const { member, org } = await figuresFor(deps, input.orgId, input.developerId);
  const needed = MINIMUM_REMAINING_USD[input.path];
  if (member !== undefined && remaining(member) < needed) throw budgetExceeded(member.spentUsd, member.limitUsd);
  if (remaining(org) < needed) throw orgBudgetExceeded();
  return { maxBudgetUsd: clean(Math.min(member === undefined ? Infinity : remaining(member), remaining(org), PER_TASK_BUDGET_USD)) };
}

/** LiteLLM's token id for a key: the lowercase hex SHA-256 of it. Safe to store; the key is not recoverable from it. */
export const keyIdOf = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * Ruling R30: what a task's next key may spend. The task's budget less what its earlier keys have spent (so a re-mint
 * never restores a spent budget), further limited by what the member and the org have left. Refuses when any of the
 * three is 0: a key capped at nothing could be read by the proxy as no cap.
 */
export async function mintCap(deps: BudgetDependencies, input: { orgId: OrgId; developerId?: string | undefined; budgetUsd: number; previousKeyIds: readonly string[]; budgetBaselineUsd?: number | undefined }): Promise<{ maxBudgetUsd: number }> {
  await ensureSynced(deps, input.orgId, input.developerId);
  const [taskSpent, figures] = await Promise.all([viaProxy(() => deps.access.keySpend(input.previousKeyIds)), figuresFor(deps, input.orgId, input.developerId)]);
  const { member, org } = figures;
  if (member !== undefined && remaining(member) <= 0) throw budgetExceeded(member.spentUsd, member.limitUsd);
  if (remaining(org) <= 0) throw orgBudgetExceeded();
  // Ruling R38: a human Continue starts a new window, so what the task's keys had spent by then no longer counts against its cap.
  const windowSpent = clean(Math.max(0, taskSpent - (input.budgetBaselineUsd ?? 0)));
  const taskRemaining = clean(Math.max(0, input.budgetUsd - windowSpent));
  if (taskRemaining <= 0) {
    throw agentXError("BUDGET_EXCEEDED", `${TASK_BUDGET_EXCEEDED_PREFIX} ($${dollars(windowSpent)} of $${dollars(input.budgetUsd)}). Start a new task to continue.`);
  }
  return { maxBudgetUsd: clean(Math.min(taskRemaining, member === undefined ? Infinity : remaining(member), remaining(org))) };
}

/**
 * Ruling R38: the cumulative spend of a task's keys so far, which a Continue records as the start of the task's new cap window.
 * Zero when the task has minted none. A proxy that cannot answer is MODEL_PROXY_UNAVAILABLE, so the Continue changes nothing.
 */
export async function taskSpendBaseline(deps: BudgetDependencies, keyIds: readonly string[]): Promise<number> {
  return keyIds.length === 0 ? 0 : clean(await viaProxy(() => deps.access.keySpend(keyIds)));
}

/**
 * Notes a minted key on the record that owns it (a task, or the operation of Slack work), so the next mint counts its spend.
 * `knownCount` is how many keys the record held when the caller read it: the write happens only if it still holds that many,
 * so two mints that raced cannot both be given the task's whole remainder. Answers false when another mint recorded first.
 *
 * Never delete or revoke task keys before the task closes: their spend is the task's cumulative count (ruling R30), and a
 * key the proxy no longer knows makes `keySpend` fail closed.
 */
export async function recordMintedKey(deps: BudgetDependencies, key: OrgKey | { pk: string; sk: string }, keyId: string, knownCount: number): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: key,
      UpdateExpression: "SET #ids = list_append(if_not_exists(#ids, :none), :id)",
      ConditionExpression: knownCount === 0 ? "attribute_exists(pk) AND attribute_not_exists(#ids)" : "size(#ids) = :count",
      ExpressionAttributeNames: { "#ids": "modelKeyIds" },
      ExpressionAttributeValues: { ":none": [], ":id": [keyId], ...(knownCount === 0 ? {} : { ":count": knownCount }) },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
