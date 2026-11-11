// Plan 3 Task 30: the spend ledger. Every model key the broker mints has a record here (`ModelKeyRecord`, with the scopes it counts against, the tags that
// say who pays and what ran, and how much of its spend has been counted). The proxy's own figure for a key is the truth (R22); settlement reads it and
// adds the new part to every counter the key belongs to, in one transaction that is conditional on the amount already counted, so a spend is counted
// once however often it is settled, and however many settlers race. Member and org counters are advisory: LiteLLM's caps stay authoritative (R23).
//
// Two kinds of key: a key that RESERVED its cap (every task operation key, Task 31) holds `capUsd` on each of its scopes' `committedUsd` until it is
// finalized, then keeps only what it spent; a key that reserved nothing (a Slack turn's, R50) adds its spend to `committedUsd` as it settles. A finalized
// key still settles: a request the proxy admitted before the block can bill later (spike Q11), and that late spend adds to `spentUsd` and `committedUsd`.
//
// Finalizing is two-phase. When an operation ends its keys are blocked at the proxy (`blockOperationKeys`) and given a `finalizeAfter`; the sweep settles
// open keys and finalizes those past `finalizeAfter`, or ten minutes after they expired when nobody blocked them. Finalized keys keep settling for a day.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  BUDGET_ALERT_LEVELS, FINALIZE_DELAY_MS, FINALIZED_SETTLE_WINDOW_MS, KEY_EXPIRY_GRACE_MS, OrgIdSchema,
  agentRunsKey, agentXError, budgetAlertKey, ledgerKey, modelCounter, modelKeyKey, openModelKeysKey, originCounter, scopeKey, sourceCounter, taskSpendKey,
  spendCounterKey, spendOriginKind, type BudgetScope, type OrgId,
} from "@agentx/contracts";
import type { MintTags, ModelAccess } from "../model-proxy/access.js";
import { Aliases, NOT_EXISTS, errorName, failedIndexes, isTransactionConflict, withoutUndefined, type Item, type TransactItem } from "../agents/table-writes.js";
import { effectiveLimits, type SpendSettingsDependencies } from "./settings.js";
import { agentUsageCounter } from "./payer.js";
import { cleanUsd } from "./top-ups.js";
import { costSettledEvent } from "../work-events/cost.js";
import { workEventPutItem } from "../work-events/store.js";
import type { WorkEventsRuntime } from "../work-events/emit.js";

export interface LedgerDependencies extends SpendSettingsDependencies {
  access: Pick<ModelAccess, "keySpend" | "blockKey">;
  /** Epoch milliseconds. */
  now: () => number;
  /** How many open keys a sweep takes at once (default 50). */
  pageSize?: number;
  /** Where a failure that must not stop the work is reported; by default one JSON line. */
  log?: (entry: Record<string, unknown>) => void;
  /** Work events (U3): present only where they are written (named environments). Each settlement then adds one `cost_settled` event to its own transaction. */
  workEvents?: WorkEventsRuntime | undefined;
}

/** A scope a key counts against, with the limit its reservation is held to (a scope without one is counted but never refuses a key). */
export interface KeyScope {
  key: BudgetScope;
  limitUsd?: number | undefined;
}

export interface KeyInput {
  orgId: OrgId;
  /** The UTC month the key's spend is counted in (the month it was minted). */
  month: string;
  /** LiteLLM's token id for the key: the SHA-256 of it. */
  keyId: string;
  capUsd: number;
  scopes: readonly KeyScope[];
  tags: MintTags;
  /** The model the key may call, for the model counter; absent while a key is not tied to one model. */
  model?: string | undefined;
  /**
   * Counters that are not budget scopes but hold the key's cap just the same (the Public company's learning month, `LEARNING`): reserved with the scopes in one transaction (a counter with a limit refuses a cap that does not
   * fit, `ScopeFullError` naming the counter), settled with the key's spend and released at finalize. Only a reserving key (`reserve`) holds them.
   */
  holds?: readonly KeyHold[] | undefined;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A counter (the sort key of a spend counter) a key holds its cap on, and the limit its reservation is held to. */
export interface KeyHold {
  counter: string;
  limitUsd?: number | undefined;
}

export interface ModelKeyRecord {
  orgId: OrgId;
  keyId: string;
  month: string;
  capUsd: number;
  /** How much of the key's spend has been counted. */
  settledUsd: number;
  scopes: BudgetScope[];
  /** The counters the key holds its cap on besides its scopes (`KeyInput.holds`), by counter name. */
  holds?: string[];
  tags: MintTags;
  model?: string;
  /** True when the key holds its cap on each scope's `committedUsd` until it is finalized. */
  reserved: boolean;
  createdAt: number;
  expiresAt: number;
  finalizeAfter?: number;
  finalized: boolean;
  finalizedAt?: number;
  settleCount: number;
  /** Set by a settle until its budget alerts were checked, so the sweep writes an alert whose write was lost even if the key spends nothing more. */
  alertsDue?: true;
}

/** A reservation that would take a limited scope past its limit. `scope` is the scope's `scopeKey`. */
export class ScopeFullError extends Error {
  constructor(readonly scope: string) {
    super(`${scope} has no room for this key`);
    this.name = "ScopeFullError";
  }
}

/** One transaction holds at most 100 items; a key's own are the record, the index item, a ledger line, a run total and the extra counters. */
const MAX_SCOPES = 20;
/** A page is small so one slow batch of proxy calls, not a whole page of them, is the most a sweep can run past its deadline. */
const SWEEP_PAGE = 50;
const SWEEP_AT_ONCE = 8;
const OPEN_KEYS_PK = "OPEN_MODEL_KEYS";
/** How often a settle is sent again after a transaction conflict. */
const SETTLE_CONFLICT_RETRIES = 3;

/** DynamoDB's reason for each item of a cancelled transaction (`None`, `ConditionalCheckFailed`, `TransactionConflict`, ...); absent for any other error. */
function cancellationCodes(error: unknown): string[] | undefined {
  const reasons = (error as { CancellationReasons?: unknown } | null)?.CancellationReasons;
  if (errorName(error) !== "TransactionCanceledException" || !Array.isArray(reasons)) return undefined;
  return reasons.map((reason: { Code?: string } | undefined) => reason?.Code ?? "unknown");
}

/** Every counter a key's cap is held on and its spend is added to: its scopes' and its holds'. */
const counterNamesOf = (record: Pick<ModelKeyRecord, "scopes" | "holds">): string[] => [...record.scopes.map((scope) => scopeKey(scope)), ...(record.holds ?? [])];

const iso = (epochMs: number): string => new Date(epochMs).toISOString();
const log = (deps: LedgerDependencies, entry: Record<string, unknown>): void => (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

async function getItem(deps: LedgerDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function readRecord(deps: LedgerDependencies, orgId: OrgId, keyId: string): Promise<ModelKeyRecord | undefined> {
  const item = await getItem(deps, modelKeyKey(orgId, keyId));
  // The item is under this org's partition; the field is checked again so a record written wrongly is never trusted.
  if (item === undefined || item["orgId"] !== orgId || item["keyId"] !== keyId) return undefined;
  return item as unknown as ModelKeyRecord;
}

/**
 * H1 (lessons in production, lane 2 review): what became of keys an earlier attempt of some work minted, for the decision whether that work may run again without any chance of paying twice.
 *   - `clear`: every key is finalized with nothing counted, or has no record (it was taken back before anyone used it): nothing was spent, so the work may be tried again;
 *   - `spent`: some key has counted spend: the work reached the provider, so it is never repeated;
 *   - `pending`: some key is still open with nothing counted yet (the proxy may not have flushed, the sweep has not finalized it): not decided, ask again later.
 * `spent` wins over `pending`, which wins over `clear`.
 */
export async function keysOutcome(deps: LedgerDependencies, orgId: OrgId, keyIds: readonly string[]): Promise<"clear" | "spent" | "pending"> {
  let outcome: "clear" | "pending" = "clear";
  for (const keyId of new Set(keyIds)) {
    const record = await readRecord(deps, orgId, keyId);
    if (record === undefined) continue;
    if (record.settledUsd > 0) return "spent";
    if (!record.finalized) outcome = "pending";
  }
  return outcome;
}

async function send(deps: LedgerDependencies, items: TransactItem[]): Promise<void> {
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
}

/** `SET` fields (each only when the item is new, for `once`) and `ADD` amounts on one item, which an ADD creates when it is not there. */
function upsert(deps: LedgerDependencies, key: { pk: string; sk: string }, entityType: string, change: { set?: Item; add?: Record<string, number>; condition?: (aliases: Aliases) => string }): TransactItem {
  const aliases = new Aliases();
  const type = aliases.name("entityType");
  const sets = [`${type} = if_not_exists(${type}, ${aliases.value(entityType)})`];
  for (const [name, value] of Object.entries(change.set ?? {})) if (value !== undefined) sets.push(`${aliases.name(name)} = ${aliases.value(value)}`);
  const adds = Object.entries(change.add ?? {}).map(([name, amount]) => `${aliases.name(name)} ${aliases.value(amount)}`);
  const condition = change.condition?.(aliases);
  return {
    Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: `SET ${sets.join(", ")}${adds.length === 0 ? "" : ` ADD ${adds.join(", ")}`}`,
      ...(condition === undefined ? {} : { ConditionExpression: condition }),
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
}

function recordItems(deps: LedgerDependencies, input: KeyInput, reserved: boolean, createdAt: number): { record: Item; index: Item } {
  const record: Item = withoutUndefined({
    ...modelKeyKey(input.orgId, input.keyId), entityType: "MODEL_KEY", orgId: input.orgId, keyId: input.keyId, month: input.month, capUsd: cleanUsd(input.capUsd),
    settledUsd: 0, scopes: input.scopes.map((scope) => scope.key), holds: (input.holds ?? []).length === 0 ? undefined : (input.holds ?? []).map((hold) => hold.counter), tags: withoutUndefined({ ...input.tags }), model: input.model, reserved,
    createdAt, expiresAt: input.expiresAt, finalized: false, settleCount: 0,
  });
  const index: Item = { ...openModelKeysKey(iso(createdAt), input.orgId, input.keyId), entityType: "OPEN_MODEL_KEY", orgId: input.orgId, keyId: input.keyId };
  return { record, index };
}

function checkInput(input: KeyInput): void {
  if (input.scopes.length + (input.holds?.length ?? 0) > MAX_SCOPES) throw agentXError("CONFIG_INVALID", "a model key counts against too many budgets");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(input.month)) throw agentXError("CONFIG_INVALID", "a model key's spend is counted in a month, YYYY-MM");
  if (!Number.isFinite(input.expiresAt)) throw agentXError("CONFIG_INVALID", "a model key has an expiry");
  if (!/^[0-9a-f]{64}$/u.test(input.keyId)) throw agentXError("CONFIG_INVALID", "a model key is known by its token id");
  if (!Number.isFinite(input.capUsd) || input.capUsd < 0) throw agentXError("CONFIG_INVALID", "a model key's cap is an amount of dollars");
}

const uniqueScopes = (scopes: readonly KeyScope[]): KeyScope[] => {
  const seen = new Set<string>();
  return scopes.filter((scope) => !seen.has(scopeKey(scope.key)) && seen.add(scopeKey(scope.key)));
};

/**
 * Records a key that reserved nothing (a Slack turn's key, an orchestrator's; every task operation's key reserves, Task 31): it settles into the counters,
 * and its spend adds to `committedUsd` as it comes. A key already recorded answers its record and writes nothing.
 */
export async function registerKey(deps: LedgerDependencies, input: KeyInput, guard?: RegisterGuard): Promise<ModelKeyRecord> {
  checkInput(input);
  const { record, index } = recordItems(deps, { ...input, scopes: uniqueScopes(input.scopes), holds: undefined }, false, deps.now());
  const checks = guard?.checks ?? [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await send(deps, [
        { Put: { TableName: deps.tableName, Item: record, ConditionExpression: NOT_EXISTS } },
        { Put: { TableName: deps.tableName, Item: index, ConditionExpression: NOT_EXISTS } },
        ...checks,
      ]);
      return record as unknown as ModelKeyRecord;
    } catch (error) {
      // Another write touching a guarded record at the same moment cancels the transaction without any condition failing: it is tried once more, and a second conflict is the caller's.
      if (guard !== undefined && attempt === 0 && isTransactionConflict(error)) continue;
      const failed = failedIndexes(error);
      // A guard that no longer holds refuses before a repeat is looked for: the key is not recorded, and the caller gives it back.
      if (guard !== undefined && failed !== undefined && checks.some((_check, position) => failed.has(2 + position))) throw guard.refusal();
      const existing = failed === undefined ? undefined : await readRecord(deps, input.orgId, input.keyId);
      if (existing === undefined) throw error;
      return existing;
    }
  }
}

/** Conditions written in the same transaction as a key's record (checks on other items, placed after the record's own writes), and the error thrown when one of them fails. */
export interface RegisterGuard {
  checks: TransactItem[];
  refusal: () => Error;
}

/**
 * Holds `capUsd` on every scope's `committedUsd` and records the key, in one transaction: each limited scope must still have room
 * (`committedUsd <= limit - cap`), or the whole reservation is refused with the first scope that is full and nothing is written. Task 31's `mintOperationKey` calls
 * this after the key is minted and before it is handed to anyone (the id is the key's SHA-256). A repeat of the same key answers its record and holds nothing more.
 */
export async function reserve(deps: LedgerDependencies, input: KeyInput): Promise<ModelKeyRecord> {
  checkInput(input);
  const scopes = uniqueScopes(input.scopes);
  const cap = cleanUsd(input.capUsd);
  // The counters the cap is held on, in order: the scopes', then the holds' (a hold named like a scope is the scope's, once).
  const named = new Set(scopes.map((scope) => scopeKey(scope.key)));
  const holds = (input.holds ?? []).filter((hold) => !named.has(hold.counter) && named.add(hold.counter));
  const counters: Array<{ name: string; limitUsd?: number | undefined }> = [...scopes.map((scope) => ({ name: scopeKey(scope.key), limitUsd: scope.limitUsd })), ...holds.map((hold) => ({ name: hold.counter, limitUsd: hold.limitUsd }))];
  // A cap above a counter's whole limit fits nowhere, whatever is committed.
  for (const counter of counters) if (counter.limitUsd !== undefined && cleanUsd(counter.limitUsd - cap) < 0) throw new ScopeFullError(counter.name);
  const { record, index } = recordItems(deps, { ...input, scopes, holds }, true, deps.now());
  const items: TransactItem[] = [
    ...counters.map((counter) => upsert(deps, spendCounterKey(input.orgId, input.month, counter.name), "SPEND_COUNTER", {
      add: { committedUsd: cap },
      ...(counter.limitUsd === undefined ? {} : {
        // A millionth of slack keeps float dust from refusing a key that fits exactly.
        condition: (aliases) => `attribute_not_exists(${aliases.name("committedUsd")}) OR ${aliases.name("committedUsd")} <= ${aliases.value(cleanUsd(counter.limitUsd! - cap + 0.000001))}`,
      }),
    })),
    { Put: { TableName: deps.tableName, Item: record, ConditionExpression: NOT_EXISTS } },
    { Put: { TableName: deps.tableName, Item: index, ConditionExpression: NOT_EXISTS } },
  ];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await send(deps, items);
      return record as unknown as ModelKeyRecord;
    } catch (error) {
      if (errorName(error) !== "TransactionCanceledException") throw error;
      const reasons = ((error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons ?? []).map((reason) => reason?.Code);
      const failed = failedIndexes(error) ?? new Set<number>();
      // The record already exists: a repeat. (Its counter conditions may fail too, having been counted once already.)
      if (failed.has(counters.length)) {
        const existing = await readRecord(deps, input.orgId, input.keyId);
        if (existing !== undefined) return existing;
        throw error;
      }
      const full = counters.findIndex((_counter, position) => failed.has(position));
      if (full !== -1) throw new ScopeFullError(counters[full]!.name);
      // Two reservations on one counter at once: DynamoDB cancels one without a failed condition. It is decided again from the fresh counters.
      if (reasons.includes("TransactionConflict") && attempt < 3) continue;
      throw error;
    }
  }
}

/** What a scope's counter holds for a month: what was spent, and what was spent plus what open keys hold (`committedUsd`, the figure a limit is checked against). */
export interface ScopeCounter {
  spentUsd: number;
  committedUsd: number;
}

/** The counters of the given scopes for a month, by `scopeKey`; a scope nothing was counted on has zero of both. */
export async function readScopeCounters(deps: LedgerDependencies, orgId: OrgId, month: string, scopes: readonly BudgetScope[]): Promise<Map<string, ScopeCounter>> {
  const counters = new Map<string, ScopeCounter>();
  await Promise.all(scopes.map(async (scope) => {
    const item = await getItem(deps, spendCounterKey(orgId, month, scopeKey(scope)));
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? cleanUsd(value) : 0);
    counters.set(scopeKey(scope), { spentUsd: number(item?.["spentUsd"]), committedUsd: number(item?.["committedUsd"]) });
  }));
  return counters;
}

export interface SettleOutcome {
  /** What this call added; 0 when there was nothing new, the key is unknown or another settler counted it. */
  deltaUsd: number;
  /** How much of the key's spend is counted now. */
  settledUsd: number;
}

const overshoot = (spent: number, capUsd: number): number => Math.max(0, cleanUsd(spent - capUsd));

/** The counters a key's spend is added to besides its scopes: the agent's usage, the model source, the model, and the agent's spend by where the run came from. */
function extraCounters(record: ModelKeyRecord): string[] {
  return [
    agentUsageCounter(record.tags.agentId),
    sourceCounter(record.tags.source),
    ...(record.model === undefined ? [] : [modelCounter(record.model)]),
    originCounter(record.tags.agentId, spendOriginKind(record.tags.origin)),
  ];
}

async function settleOnce(deps: LedgerDependencies, record: ModelKeyRecord): Promise<SettleOutcome | "raced"> {
  const spent = cleanUsd(await deps.access.keySpend([record.keyId]));
  const deltaUsd = cleanUsd(spent - record.settledUsd);
  if (!(deltaUsd > 0)) return { deltaUsd: 0, settledUsd: record.settledUsd };
  const at = deps.now();
  const seq = record.settleCount + 1;
  // An open reserving key already holds its cap, so only what passes the cap adds to committed; any other key adds all of it.
  const committed = record.reserved && !record.finalized ? cleanUsd(overshoot(spent, record.capUsd) - overshoot(record.settledUsd, record.capUsd)) : deltaUsd;
  const orgId = record.orgId;
  const items: TransactItem[] = [
    upsert(deps, modelKeyKey(orgId, record.keyId), "MODEL_KEY", {
      set: { settledUsd: spent, settleCount: seq, lastSettledAt: iso(at), alertsDue: true },
      condition: (aliases) => `${aliases.name("settledUsd")} = ${aliases.value(record.settledUsd)} AND ${aliases.name("finalized")} = ${aliases.value(record.finalized)}`,
    }),
    ...counterNamesOf(record).map((name) => upsert(deps, spendCounterKey(orgId, record.month, name), "SPEND_COUNTER", { add: { spentUsd: deltaUsd, ...(committed === 0 ? {} : { committedUsd: committed }) } })),
    ...extraCounters(record).map((sk) => upsert(deps, spendCounterKey(orgId, record.month, sk), "SPEND_COUNTER", { add: { spentUsd: deltaUsd } })),
    { Put: { TableName: deps.tableName, Item: withoutUndefined({
      ...ledgerKey(orgId, record.month, iso(at), record.keyId, seq), entityType: "LEDGER", orgId, month: record.month, at: iso(at), keyId: record.keyId,
      usd: deltaUsd, settledUsd: spent, finalized: record.finalized, model: record.model, ...record.tags,
    }), ConditionExpression: NOT_EXISTS } },
    // Plan 5, Task 7a (N5): what the task has cost so far, added in this same conditional transaction so a raced or replayed settle adds nothing. A session shows cost
    // from this one counter and never sums keys. Tasks started before this deploy show cost from the deploy onward.
    ...(record.tags.taskId === undefined ? [] : [upsert(deps, taskSpendKey(orgId, record.tags.taskId), "TASK_SPENT", { set: { orgId }, add: { settledUsd: deltaUsd } })]),
    // A run is the task, or the operation of Slack-thread work. A Slack turn's key has neither (R50), so each turn is a run of its own, keyed by its key's
    // token id; the routes never show that key.
    upsert(deps, agentRunsKey(orgId, record.month, record.tags.agentId, record.tags.taskId ?? record.tags.operationId ?? record.keyId), "AGENT_RUN", {
      set: withoutUndefined({ orgId, agentId: record.tags.agentId, project: record.tags.project, origin: record.tags.origin, payerKind: record.tags.payerKind, taskId: record.tags.taskId, lastAt: iso(at) }),
      add: { usd: deltaUsd },
    }),
  ];
  // Work events (U3): the settlement's cost event goes last, in the same transaction (a transaction holds at most 100 items; a key's own are few, and a full one simply gets no event).
  if (deps.workEvents !== undefined && items.length < 100) {
    const event = costSettledEvent({ orgId, project: record.tags.project, taskId: record.tags.taskId, keyId: record.keyId, sequence: seq, at: iso(at), deltaUsd, source: record.tags.source });
    if (event !== undefined) items.push(workEventPutItem(deps.tableName, event));
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await send(deps, items);
      break;
    } catch (error) {
      // The first item is the record: it fails when someone else counted first, and that is not an error.
      if (failedIndexes(error)?.has(0) === true) return "raced";
      // Another settle touching the same counters (two keys of one run share every scope counter, the agent's counters and the run total) cancels this
      // transaction with no condition failed and nothing written. The same items are sent again: they hold only while the amount counted is the one read, so
      // a retry cannot count twice. A conflict that outlasts the tries leaves the key in the sweep's index, which settles it on its next run.
      if (!isTransactionConflict(error) || attempt >= SETTLE_CONFLICT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1) + Math.floor(Math.random() * 20)));
    }
  }
  await settleAlerts(deps, { ...record, settledUsd: spent });
  return { deltaUsd, settledUsd: spent };
}

/**
 * Checks the key's budget alerts and, when they were written, clears the key's `alertsDue` mark (only while the amount counted is the one checked, so a
 * newer settle's mark stays). A failure is logged and leaves the mark, so the sweep writes the alert later whether or not the key spends again.
 */
async function settleAlerts(deps: LedgerDependencies, record: ModelKeyRecord): Promise<void> {
  try {
    await checkAlerts(deps, record.orgId, record.month, record.scopes);
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: modelKeyKey(record.orgId, record.keyId), UpdateExpression: "REMOVE #due",
      ConditionExpression: "#settled = :settled", ExpressionAttributeNames: { "#due": "alertsDue", "#settled": "settledUsd" }, ExpressionAttributeValues: { ":settled": record.settledUsd },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") log(deps, { event: "spend.alert_failed", keyId: record.keyId, error: errorName(error) ?? "unknown" });
  }
}

/**
 * Counts what the key has spent since it was last counted: the new part of the proxy's figure goes to every counter of the key, with a ledger line, in one
 * transaction that holds only while the amount already counted is the one read. A lost race reads the key again once, so two settles of one key add once.
 * A key of another org, one the ledger does not know, or a finalized one past its day, counts nothing.
 */
export async function settleKey(deps: LedgerDependencies, orgId: OrgId, keyId: string, options: { pastWindow?: true } = {}): Promise<SettleOutcome> {
  let last: ModelKeyRecord | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await readRecord(deps, orgId, keyId);
    if (record === undefined) return { deltaUsd: 0, settledUsd: 0 };
    last = record;
    if (options.pastWindow !== true && record.finalized && deps.now() > (record.finalizedAt ?? 0) + FINALIZED_SETTLE_WINDOW_MS) return { deltaUsd: 0, settledUsd: record.settledUsd };
    const outcome = await settleOnce(deps, record);
    if (outcome !== "raced") return outcome;
  }
  return { deltaUsd: 0, settledUsd: last?.settledUsd ?? 0 };
}

/**
 * Writes each alert level a counter has reached, once a month: `budgetAlertKey` is created only if absent. A scope without a limit has none. An alert
 * that cannot be written is the next settle's to write; it never holds up a settle.
 */
export async function checkAlerts(deps: LedgerDependencies, orgId: OrgId, month: string, scopes: readonly BudgetScope[]): Promise<void> {
  if (scopes.length === 0) return;
  const limits = await effectiveLimits(deps, { orgId, month, scopes });
  for (const scope of scopes) {
    const limit = limits.get(scopeKey(scope));
    if (limit === undefined || !(limit > 0)) continue;
    const spent = (await getItem(deps, spendCounterKey(orgId, month, scopeKey(scope))))?.["spentUsd"];
    if (typeof spent !== "number") continue;
    for (const { level, ratio } of BUDGET_ALERT_LEVELS) {
      if (spent < limit * ratio) continue;
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName, ConditionExpression: NOT_EXISTS,
          Item: { ...budgetAlertKey(orgId, month, scopeKey(scope), level), entityType: "BUDGET_ALERT", orgId, month, scope: scopeKey(scope), level, spentUsd: cleanUsd(spent), limitUsd: limit, at: iso(deps.now()) },
        }));
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
  }
}

/**
 * Ends a key's reservation: the cap it did not spend (`max(0, cap - counted)`) goes back to each scope's `committedUsd`, and the key is marked finalized, in
 * one transaction that holds only while the amount counted and the open state are as read (a lost race reads again once). Answers false when the key is
 * unknown or already finalized. Spend that comes later is still settled, as late spend.
 */
export async function finalizeKey(deps: LedgerDependencies, orgId: OrgId, keyId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await readRecord(deps, orgId, keyId);
    if (record === undefined || record.finalized) return false;
    const release = record.reserved ? Math.max(0, cleanUsd(record.capUsd - record.settledUsd)) : 0;
    const items: TransactItem[] = [
      upsert(deps, modelKeyKey(orgId, keyId), "MODEL_KEY", {
        set: { finalized: true, finalizedAt: deps.now() },
        condition: (aliases) => `${aliases.name("finalized")} = ${aliases.value(false)} AND ${aliases.name("settledUsd")} = ${aliases.value(record.settledUsd)}`,
      }),
      ...(release === 0 ? [] : counterNamesOf(record).map((name) => upsert(deps, spendCounterKey(orgId, record.month, name), "SPEND_COUNTER", { add: { committedUsd: -release } }))),
    ];
    try {
      await send(deps, items);
      return true;
    } catch (error) {
      if (failedIndexes(error)?.has(0) !== true) throw error;
    }
  }
  return false;
}

/**
 * Takes back a reservation whose key was never handed out and will never be used (the mint was refused, or its answer was lost): the record and its
 * index item are deleted and the whole cap goes back to each scope, in one transaction that holds only while the key is open and has counted nothing.
 * Answers false when there is nothing to take back (no record, a key that was settled or finalized, or one that reserved nothing).
 */
export async function abandonKey(deps: LedgerDependencies, orgId: OrgId, keyId: string): Promise<boolean> {
  const record = await readRecord(deps, orgId, keyId);
  if (record === undefined || !record.reserved || record.finalized || record.settleCount > 0 || record.settledUsd > 0) return false;
  try {
    await send(deps, [
      { Delete: { TableName: deps.tableName, Key: modelKeyKey(orgId, keyId), ConditionExpression: "settleCount = :none AND finalized = :open", ExpressionAttributeValues: { ":none": 0, ":open": false } } },
      { Delete: { TableName: deps.tableName, Key: openModelKeysKey(iso(record.createdAt), orgId, keyId) } },
      ...counterNamesOf(record).map((name) => upsert(deps, spendCounterKey(orgId, record.month, name), "SPEND_COUNTER", { add: { committedUsd: -cleanUsd(record.capUsd) } })),
    ]);
    return true;
  } catch (error) {
    if (failedIndexes(error) !== undefined) return false;
    throw error;
  }
}

/**
 * Takes a task's earlier keys out of the way of its next one (Task 31's I1): each open, reserved key is blocked at the proxy, settled and finalized at once,
 * which releases its unspent hold, so the run's next key does not compete with its own earlier holds. This skips the 120-second window an ended key gets,
 * and that is safe (Task 31 re-check M-1, documented rather than changed): a request the proxy admitted before the block still runs, but a finalized key keeps
 * settling for `FINALIZED_SETTLE_WINDOW_MS`, so what it spends is still counted on every scope; it is only not held. A scope can be overshot by what such
 * requests spend, bounded by the key's own cap and corrected at the next settle. Keeping the window for a key of the running operation would instead hold its
 * cap beside the next key's, the early end I1 fixed. A finalize that loses both of its tries (a settle kept moving the figure) gets the window, so the sweep
 * finalizes it, instead of holding until the key expires (M-2). Answers how many were finalized at once.
 */
export async function supersedeKeys(deps: LedgerDependencies, orgId: OrgId, keyIds: readonly string[]): Promise<number> {
  let finalized = 0;
  for (const keyId of new Set(keyIds)) {
    const record = await readRecord(deps, orgId, keyId);
    if (record === undefined || record.finalized || !record.reserved) continue;
    await deps.access.blockKey(keyId);
    await settleKey(deps, orgId, keyId);
    if (await finalizeKey(deps, orgId, keyId)) finalized += 1;
    else await startFinalizeClock(deps, orgId, keyId);
  }
  return finalized;
}

/** Gives an open key the in-flight window (`finalizeAfter`), unless it has one or was finalized; the sweep finalizes it once the window has passed. */
async function startFinalizeClock(deps: LedgerDependencies, orgId: OrgId, keyId: string): Promise<void> {
  try {
    await send(deps, [upsert(deps, modelKeyKey(orgId, keyId), "MODEL_KEY", {
      set: { finalizeAfter: deps.now() + FINALIZE_DELAY_MS },
      condition: (aliases) => `${aliases.name("finalized")} = ${aliases.value(false)} AND attribute_not_exists(${aliases.name("finalizeAfter")})`,
    })]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
  }
}

/**
 * The first phase of finalizing: an operation has ended, so each of its still-open keys is blocked at the proxy and given a `finalizeAfter` (after
 * `FINALIZE_DELAY_MS`, so a request the proxy had admitted before the block still counts). Keys that name another operation, are finalized or
 * were blocked already are left alone, so reporting the same end twice blocks nothing. Answers how many keys it blocked; a proxy that cannot block
 * a key throws after the other keys were tried, and that key's clock stays unstarted, so a later end (or the sweep's expiry backstop) deals with it.
 */
export async function blockOperationKeys(deps: LedgerDependencies, input: { orgId: OrgId; operationId: string; keyIds: readonly string[] }): Promise<number> {
  let blocked = 0;
  let failure: unknown;
  for (const keyId of new Set(input.keyIds)) {
    const record = await readRecord(deps, input.orgId, keyId);
    if (record === undefined || record.finalized || record.finalizeAfter !== undefined || record.tags.operationId !== input.operationId) continue;
    try {
      await deps.access.blockKey(keyId);
      await send(deps, [upsert(deps, modelKeyKey(input.orgId, keyId), "MODEL_KEY", {
        set: { finalizeAfter: deps.now() + FINALIZE_DELAY_MS },
        condition: (aliases) => `${aliases.name("finalized")} = ${aliases.value(false)} AND attribute_not_exists(${aliases.name("finalizeAfter")})`,
      })]);
      blocked += 1;
    } catch (error) {
      if (failedIndexes(error) !== undefined) continue;
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("a model key could not be blocked");
  return blocked;
}

/**
 * Takes back a key that never took part: the record of a key that reserved nothing and was never settled is deleted with its index item (a mint whose
 * recording on the task lost a race gives its key back). A key that reserved, or that was settled, stays for the sweep to finalize.
 */
export async function forgetKey(deps: LedgerDependencies, orgId: OrgId, keyId: string): Promise<boolean> {
  const record = await readRecord(deps, orgId, keyId);
  if (record === undefined || record.reserved || record.settleCount > 0 || record.settledUsd > 0) return false;
  try {
    await send(deps, [
      { Delete: { TableName: deps.tableName, Key: modelKeyKey(orgId, keyId), ConditionExpression: "settleCount = :none", ExpressionAttributeValues: { ":none": 0 } } },
      { Delete: { TableName: deps.tableName, Key: openModelKeysKey(iso(record.createdAt), orgId, keyId) } },
    ]);
    return true;
  } catch (error) {
    if (failedIndexes(error) !== undefined) return false;
    throw error;
  }
}

export interface SweepPage {
  /** How many index items the page took. */
  examined: number;
  settled: number;
  finalized: number;
  failed: number;
  /** True when the page stopped at its deadline before taking every item it held; `next` is then the last key it did. */
  stopped?: true;
  /** Pass this to the next call for the next page: the last key this page took. Absent on the last page. */
  next?: string;
}

async function dropIndexItem(deps: LedgerDependencies, item: Item): Promise<void> {
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
}

/**
 * One page of the open keys, by cursor: each is settled, and an open one is finalized once it is due (`finalizeAfter` has passed, or it expired ten
 * minutes ago). A finalized key keeps settling for a day; past it the key is settled one last time and dropped from the index, as is one whose record
 * is gone or belongs to another org than its index item names (a key whose last settle fails stays another day). A key whose spend cannot be read counts
 * as failed and the page goes on; only a key that has failed for more than a day past its expiry is finalized anyway, so a lost key cannot hold a
 * reservation forever. A key that owes an alert (a lost alert write) gets it written here.
 *
 * Items are taken 8 at a time. With a `deadline` (epoch milliseconds) the page stops before any batch after the first once the deadline has passed, and
 * `next` is the last key it took, so the next call resumes exactly there and no key is skipped.
 */
export async function sweepSpend(deps: LedgerDependencies, now: number, cursor?: string, options: { deadline?: number } = {}): Promise<SweepPage> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": OPEN_KEYS_PK },
    Limit: deps.pageSize ?? SWEEP_PAGE, ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk: OPEN_KEYS_PK, sk: cursor } }),
  })) as { Items?: Item[]; LastEvaluatedKey?: { sk?: string } };
  const items = response.Items ?? [];
  const page: SweepPage = { examined: 0, settled: 0, finalized: 0, failed: 0 };
  const sweepOne = async (item: Item): Promise<void> => {
    const org = OrgIdSchema.safeParse(item["orgId"]);
    const keyId = item["keyId"];
    if (!org.success || typeof keyId !== "string") { await dropIndexItem(deps, item); return; }
    const orgId = org.data;
    const record = await readRecord(deps, orgId, keyId);
    if (record === undefined) { await dropIndexItem(deps, item); return; }
    const finalizedAt = record.finalizedAt ?? 0;
    if (record.finalized && now > finalizedAt + FINALIZED_SETTLE_WINDOW_MS) {
      // Its day is over: one last settle so nothing since the last sweep is lost, then it is dropped. A key that cannot be settled stays a second day.
      try {
        if ((await settleKey(deps, orgId, keyId, { pastWindow: true })).deltaUsd > 0) page.settled += 1;
      } catch (error) {
        page.failed += 1;
        log(deps, { event: "spend.final_settle_failed", keyId, error: errorName(error) ?? "unknown", ...(cancellationCodes(error) === undefined ? {} : { reasons: cancellationCodes(error) }) });
        if (now <= finalizedAt + 2 * FINALIZED_SETTLE_WINDOW_MS) return;
      }
      await dropIndexItem(deps, item);
      return;
    }
    const due = !record.finalized && ((record.finalizeAfter !== undefined && now >= record.finalizeAfter) || now >= record.expiresAt + KEY_EXPIRY_GRACE_MS);
    let delta = 0;
    try {
      delta = (await settleKey(deps, orgId, keyId)).deltaUsd;
      if (delta > 0) page.settled += 1;
    } catch (error) {
      page.failed += 1;
      log(deps, { event: "spend.settle_failed", keyId, error: errorName(error) ?? "unknown", ...(cancellationCodes(error) === undefined ? {} : { reasons: cancellationCodes(error) }) });
      // A key the proxy has lost for good would otherwise hold its reservation forever.
      if (!(due && now >= record.expiresAt + KEY_EXPIRY_GRACE_MS + FINALIZED_SETTLE_WINDOW_MS)) return;
    }
    // A settle that counted something has checked the alerts itself; one that did not may still owe the alert an earlier settle could not write.
    if (delta === 0 && record.alertsDue === true) await settleAlerts(deps, record);
    if (due && await finalizeKey(deps, orgId, keyId)) page.finalized += 1;
  };
  let took = cursor;
  for (let start = 0; start < items.length; start += SWEEP_AT_ONCE) {
    if (start > 0 && options.deadline !== undefined && deps.now() >= options.deadline) return { ...page, ...(took === undefined ? {} : { next: took }), stopped: true };
    const batch = items.slice(start, start + SWEEP_AT_ONCE);
    await Promise.all(batch.map((item) => sweepOne(item).catch((error: unknown) => {
      page.failed += 1;
      log(deps, { event: "spend.sweep_item_failed", error: errorName(error) ?? "unknown" });
    })));
    page.examined += batch.length;
    took = String(batch.at(-1)!["sk"]);
  }
  const next = response.LastEvaluatedKey?.sk;
  return next === undefined ? page : { ...page, next };
}
