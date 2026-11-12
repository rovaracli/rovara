// Convergence lane A5: Cloud's `Metering` on Rovara Code's port (packages/contracts ports/policy.ts), over Code's `DocumentStore`. Nothing calls it yet: the
// composition root (S0) registers it.
//
// The money rules, each tested (tests/unit/cloud-money-metering.test.ts):
//   - An entry is recorded once: one row per entry id (`METER_ENTRY#<sha256(company, entry id)>`), put with `attribute_not_exists` in the same transaction
//     as the totals it adds to. A retry, a redelivery or a second writer racing it counts nothing more and answers the first answer.
//   - An unknown price is never $0 (decision 79, and Cloud's unpriced rule `org/task-stop-unpriced.ts`); a provider-reported $0 for an unpriced model is unknown too: a model the price table does not know, or prices at
//     nothing at all (LiteLLM's map prices some Bedrock ids at $0, CLOUD-MODEL-BUDGET-RESERVE.md finding 6), is `cost: null, source: "unknown"`, counted in
//     its own `unpricedEntries` total and never added to the dollar totals as zero.
//   - Totals are whole millionths of a dollar (`costMicros`), added atomically (no read-modify-write), so a total is exact and never has float dust.
//   - Every key is under the entry's own company (`ORG#<company>#`), so one company's entries never touch another's totals.
//
// What it does NOT write: Cloud's key ledger counters (`SPEND#<month>`, `TASK_SPENT`, `AGENT_RUN`), which the settlement of a LiteLLM key's own figure keeps
// (R22). Writing the same spend there too would count it twice (convergence plan, `metering` risk). Its totals are the core's cost view; the budget
// authority stays the key ledger until S0 decides one writer per spend.
import { createHash } from "node:crypto";
import { change, OrgIdSchema, orgScoped, when, type Cost, type DocumentKey, type DocumentStore, type MeterEntry, type MeterResult, type Metering, type ModelPrice, type ModelUsage, type PriceTable, type StoredDocument, type TransactItem } from "@rovara-code/contracts";
import { CLOUD_CURRENCY, isCountableCost } from "./units.js";

export interface CloudMeteringOptions {
  store: DocumentStore;
  /** Prices per million tokens, in millionths of a dollar, keyed `provider/modelId` (Cloud: its model catalog). Must be in dollars. */
  prices: PriceTable;
  /** Whether a provider-reported dollar cost is believed for a model the table does not price (Cloud: LiteLLM's `response_cost`). Default false. */
  trustReportedCost?: boolean;
  /** Epoch milliseconds. */
  now?: () => number;
}

const ENTRY_ENTITY = "METER_ENTRY";
const TOTAL_ENTITY = "METER_TOTAL";
const MICROS_PER_MILLION = 1_000_000;

const entryIdOf = (companyId: string, entryId: string): string => createHash("sha256").update(`${companyId}\u0000${entryId}`).digest("hex");
export const meterEntryKey = (companyId: string, id: string): DocumentKey => ({ pk: orgScoped(companyId, `METER_ENTRY#${id}`), sk: "ENTRY" });
/** A month's totals of a company: `COMPANY` for all of it, `TASK#<taskId>` for one task. */
export const meterTotalKey = (companyId: string, month: string, sk: string): DocumentKey => ({ pk: orgScoped(companyId, `METER#${month}`), sk });

/** Code's own arithmetic (core/cost/price-table.ts `costMicrosOf`): cache reads and writes at the input price when they have none of their own. */
export function costMicrosOf(price: ModelPrice, tokens: ModelUsage["tokens"]): number {
  const perMillion = tokens.input * price.inputMicrosPerMillionTokens
    + tokens.output * price.outputMicrosPerMillionTokens
    + tokens.cacheRead * (price.cacheReadMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens)
    + tokens.cacheWrite * (price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens);
  return Math.round(perMillion / MICROS_PER_MILLION);
}

const isTokenCount = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validTokens = (tokens: ModelUsage["tokens"] | undefined): boolean => tokens !== undefined && [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].every(isTokenCount);
const validRate = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
/** A price Cloud can charge with: every rate a non-negative number, and not nothing at all (a model "priced" at $0 is an unpriced model). */
const usablePrice = (price: ModelPrice | undefined): price is ModelPrice => price !== undefined
  && [price.inputMicrosPerMillionTokens, price.outputMicrosPerMillionTokens, price.cacheReadMicrosPerMillionTokens, price.cacheWriteMicrosPerMillionTokens].every(validRate)
  && typeof price.inputMicrosPerMillionTokens === "number" && typeof price.outputMicrosPerMillionTokens === "number"
  && (price.inputMicrosPerMillionTokens > 0 || price.outputMicrosPerMillionTokens > 0);

function storedResult(item: StoredDocument | undefined, companyId: string, id: string): MeterResult | undefined {
  if (item === undefined || item["entityType"] !== ENTRY_ENTITY || item["orgId"] !== companyId || item["entryHash"] !== id) return undefined;
  const source = item["source"], micros = item["costMicros"];
  if (source === "unknown") return { cost: null, source };
  if ((source === "price-table" || source === "provider-reported") && typeof micros === "number" && Number.isSafeInteger(micros) && micros >= 0) return { cost: { micros, currency: CLOUD_CURRENCY }, source };
  return undefined;
}

export class CloudMetering implements Metering {
  private readonly now: () => number;

  constructor(private readonly options: CloudMeteringOptions) {
    if (options.prices.currency !== CLOUD_CURRENCY) throw new RangeError("Cloud's prices are in US dollars");
    this.now = options.now ?? Date.now;
  }

  async price(usage: ModelUsage): Promise<Cost | null> {
    if (!validTokens(usage.tokens)) return null;
    const price = this.options.prices.models[`${usage.provider}/${usage.modelId}`];
    return usablePrice(price) ? { micros: costMicrosOf(price, usage.tokens), currency: CLOUD_CURRENCY } : null;
  }

  async record(entry: MeterEntry): Promise<MeterResult> {
    if (!OrgIdSchema.safeParse(entry.companyId).success) throw new RangeError("a meter entry names no company Rovara knows");
    if (typeof entry.entryId !== "string" || entry.entryId.length === 0 || entry.entryId.length > 512) throw new RangeError("a meter entry needs an id");
    const id = entryIdOf(entry.companyId, entry.entryId);
    const key = meterEntryKey(entry.companyId, id);
    const earlier = storedResult(await this.options.store.get(key), entry.companyId, id);
    if (earlier !== undefined) return earlier;
    const priced = await this.price(entry.usage);
    const reported = this.options.trustReportedCost === true && priced === null && isCountableCost(entry.reportedCost) && entry.reportedCost.micros > 0 ? entry.reportedCost : undefined;
    const result: MeterResult = priced !== null ? { cost: priced, source: "price-table" } : reported !== undefined ? { cost: { micros: reported.micros, currency: CLOUD_CURRENCY }, source: "provider-reported" } : { cost: null, source: "unknown" };
    const at = Number.isFinite(Date.parse(entry.at)) ? new Date(Date.parse(entry.at)) : new Date(this.now());
    const month = at.toISOString().slice(0, 7);
    // A known cost adds its millionths; an unknown one adds to its own count, never to the dollars as zero.
    const totals = result.cost === null ? [change.add("entries", 1), change.add("unpricedEntries", 1)] : [change.add("entries", 1), change.add("costMicros", result.cost.micros)];
    const items: TransactItem[] = [
      { kind: "put", condition: when.absent(), item: {
        ...key, entityType: ENTRY_ENTITY, orgId: entry.companyId, entryHash: id, at: at.toISOString(), month, source: result.source,
        ...(result.cost === null ? {} : { costMicros: result.cost.micros }),
        provider: entry.usage.provider.slice(0, 200), modelId: entry.usage.modelId.slice(0, 200),
        ...(entry.taskId === undefined ? {} : { taskId: entry.taskId.slice(0, 200) }),
      } },
      { kind: "update", key: meterTotalKey(entry.companyId, month, "COMPANY"), ops: [...totals, change.setIfAbsent("entityType", TOTAL_ENTITY)] },
      ...(entry.taskId === undefined ? [] : [{ kind: "update" as const, key: meterTotalKey(entry.companyId, month, `TASK#${entry.taskId.slice(0, 200)}`), ops: [...totals, change.setIfAbsent("entityType", TOTAL_ENTITY)] }]),
    ];
    const written = await this.options.store.transact(items);
    if (written.applied) return result;
    // Another writer recorded this entry first: its answer is the answer, and nothing more was counted.
    const first = storedResult(await this.options.store.get(key), entry.companyId, id);
    if (first === undefined) throw new Error("a meter entry could not be recorded");
    return first;
  }
}

export function createCloudMetering(options: CloudMeteringOptions): CloudMetering {
  return new CloudMetering(options);
}
