import { nativeSnapshotConditions } from "../org/native-snapshot-conditions.js";
import { pinOwnerFinancialChecks, type OwnerFinancialTerms } from "./owner-approval-terms.js";
// The one monthly total each person's agent and chain budgets count against (R65), as one implementation for both. The total is a counter
// (`OWNER_AGENT_BUDGET#<developer>`) that the agent store and the chain store change in the same transaction as the item whose budget moves, so
// it can't drift from the budgets it adds up. Each store registers a source that adds up its own budgets; the counter is built from every source
// the first time it is needed and rebuilt from them after a member merge, so the two stores must share one `OwnerBudgets`.
import { PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgSettingsKey, ownerBudgetKey, type OrgId } from "@agentx/contracts";
import type { OwnedKind } from "../agents/owned-store.js";
import { NOT_EXISTS, coded, errorName, type Aliases, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { budgetOwnerOf, ownerShare, ownerTotalItems, type BudgetSubject, type OwnerShare, type OwnerTotalSeen } from "./owner-total.js";
import { budgetActorChecks, budgetActorRefused, type BudgetActor } from "../agents/budget-authority.js";
import { pinSourceWrite, staleApproval, type ApprovalSource } from "./approval-source.js";
import { cleanUsd } from "./top-ups.js";

/**
 * The cap a write is held to, with the revision of the spend policy it was read from (the write checks the policy is still at it). The cap is on the owner's
 * effective total (Plan 3 Task 33 fix round 1, I-1): `seen` is that total as read, and the write applies only while the owner counter is still at its version.
 */
export interface OwnerCap {
  usd: number;
  policyRevision: number;
  seen?: OwnerTotalSeen;
  carriedSource?: OwnerFinancialTerms["carriedSource"];
}

/** What a refusal by the cap carries, so the route can answer in words with the figures as they are now (`isOwnerCapRefusal`). */
export const isOwnerCapRefusal = (error: unknown): string | undefined => (error instanceof Error ? (error as { overOwnerCap?: string }).overOwnerCap : undefined);

/** The refusal of a raise past the cap; `overOwnerCap` names the person whose total it was. */
export const ownerOverCap = (owner: string, budgets: BudgetWords = "agent") => Object.assign(
  coded("CONFIG_INVALID", `That would take this person's ${budgets} budgets past the limit for one person. An org admin can raise the limit in the spend policy.`),
  { overOwnerCap: owner },
);

/** Which budgets a refusal talks about: the agent path says "agent", the chain path (the total holds both kinds) says "agent and chain". */
export type BudgetWords = "agent" | "agent and chain";

export const totalsMoved = (budgets: BudgetWords = "agent") => coded(budgets === "agent" ? "AGENT_REVISION_CONFLICT" : "CHAIN_REVISION_CONFLICT", `Someone else changed this person's ${budgets} budgets just now. Reload and make your change again.`);

/** What an approved `owner_cap` request adds to a budget write (Plan 3 Task 32): the request's own end rides in the write's transaction, so the approval is the override. */
export interface OverrideCap {
  /** The actual deciding actor; supplied only by the approval handler. */
  actor: BudgetActor;
  spendRequestId: string;
  source?: ApprovalSource;
  /** Current destination membership; never a replacement for the deciding actor. */
  destinationChecks?: TransactItem[];
  financialChecks?: TransactItem[];
  items: TransactItem[];
  /** The error when one of `items` is refused (the request was decided meanwhile). */
  closed: () => Error;
}

/** Adds one actual-decider fence and the approved request ending to the store transaction, classifying actor loss separately from a closed request. */
export function withOverride(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined, options: { overrideCap?: OverrideCap }, scope: { tableName: string; orgId: OrgId; by: string }): [TransactItem[], (failed: Set<number>) => Error | undefined] {
  const override = options.overrideCap;
  if (override === undefined) return [items, refuse];
  if (override.actor === undefined || override.actor.developerId !== scope.by) throw budgetActorRefused();
  const sourceIndex = override.source === undefined ? undefined : pinSourceWrite(items, override.source);
  const financialIndexes = pinOwnerFinancialChecks(items, override.financialChecks ?? []);
  const checks = budgetActorChecks(scope.tableName, scope.orgId, override.actor);
  const destinationChecks = (override.destinationChecks ?? []).filter(item => !checks.some(actor => actor.ConditionCheck?.Key?.pk === item.ConditionCheck?.Key?.pk && actor.ConditionCheck?.Key?.sk === item.ConditionCheck?.Key?.sk));
  const actorStart = items.length, destinationStart = actorStart + checks.length, start = destinationStart + destinationChecks.length;
  return [[...items, ...checks, ...destinationChecks, ...override.items], (failed) => (
    [...failed].some(index => index >= actorStart && index < destinationStart) ? budgetActorRefused()
      : [...failed].some(index => index >= destinationStart && index < start) ? staleApproval()
      : [...failed].some(index => index >= start && index < start + override.items.length) ? override.closed() : financialIndexes.some(index => failed.has(index)) || (sourceIndex !== undefined && failed.has(sourceIndex)) ? staleApproval() : refuse(failed)
  )];
}

/** What an approved request adds to a change's event: the request that overrode the cap. */
export const overrideDetail = (options: { overrideCap?: OverrideCap }): Record<string, unknown> => (options.overrideCap === undefined ? {} : { overrideCap: options.overrideCap.spendRequestId });

/** Adds up the monthly budgets of the items of one kind that count for `owner`; `counts` says whether a subject's raw owner resolves to `owner`. */
export interface OwnerBudgetSource {
  sum(orgId: OrgId, owner: string, counts: (subject: BudgetSubject) => Promise<boolean>): Promise<number>;
}

export interface OwnerBudgetsInput extends TableInput {
  /** Reads a developer id as the person it was merged into (Plan 2 Task 3); without it an id is its own person. */
  resolveOwner?: (orgId: OrgId, developerId: string) => Promise<string>;
}

/** Which counter item (or the item itself) refused a transaction of `itemsFor`. */
export type TotalsOutcome = { kind: "entity" } | { kind: "policy" } | { kind: "cap"; owner: string } | { kind: "totals" } | { kind: "other" };

export interface OwnerTotalItems {
  items: TransactItem[];
  /** Maps the indexes that failed (counting the changed item itself as 0, so the counters start at 1) to what refused. */
  classify: (failed: Set<number>) => TotalsOutcome;
}

/**
 * Pins the fields that decide whose total an item's budget is in (its status, owner, accountable maintainer and monthly budget) to what
 * the writer read, so a change worked out from a stale read is refused whole instead of leaving the total wrong.
 */
export function budgetGuard(subject: BudgetSubject): (aliases: Aliases) => string {
  return (a) => {
    const same = (attribute: string, value: unknown) => (value === undefined ? `attribute_not_exists(${a.name(attribute)})` : `${a.name(attribute)} = ${a.value(value)}`);
    return [
      ...(subject.status === undefined ? [] : [same("status", subject.status)]),
      ...(subject.owner === undefined ? [] : [same("owner", subject.owner)]),
      same("monthlyBudgetUsd", subject.monthlyBudgetUsd),
      same("accountable", subject.accountable),
    ].join(" AND ");
  };
}

/** The table a store writes: a ledger takes sources only from stores on the table it counts in. */
export interface OwnerBudgetTable { documentClient: unknown; tableName: string }

export class OwnerBudgets {
  /** One source per kind of item: a second registration of a kind (a store built again on the same ledger) replaces the first, so nothing is counted twice. */
  private readonly sources = new Map<OwnedKind, OwnerBudgetSource>();

  constructor(private readonly input: OwnerBudgetsInput) {}

  /**
   * Sets the source of one kind of item's budgets in every total this ledger builds, replacing the one registered for that kind before. A store
   * on another table than the ledger's is refused: its budgets are not in the table the totals are kept in.
   */
  register(kind: OwnedKind, source: OwnerBudgetSource, table: OwnerBudgetTable): void {
    if (table.documentClient !== this.input.documentClient || table.tableName !== this.input.tableName) {
      throw new Error(`the ${kind} budgets of a store on another table can't be added to this ledger`);
    }
    this.sources.set(kind, source);
  }

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  private async readTotal(orgId: OrgId, owner: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: ownerBudgetKey(orgId, owner), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    return response.Item;
  }

  /** The developer a record names, read as whoever they were merged into. */
  survivorOf(orgId: OrgId, developerId: string): Promise<string> {
    return this.input.resolveOwner === undefined ? Promise.resolve(developerId) : this.input.resolveOwner(orgId, developerId);
  }

  /** Whether a subject's budget counts for `owner`: its raw owner, read as the person they were merged into, is `owner`. */
  countsFor(orgId: OrgId, owner: string): (subject: BudgetSubject) => Promise<boolean> {
    const survivors = new Map<string, Promise<string>>();
    return async (subject) => {
      const raw = budgetOwnerOf(subject);
      if (raw === undefined) return false;
      let found = survivors.get(raw);
      if (found === undefined) { found = this.survivorOf(orgId, raw); survivors.set(raw, found); }
      return (await found) === owner;
    };
  }

  /** The sum of the monthly budgets, from every source, that count for `owner`. */
  async sum(orgId: OrgId, owner: string): Promise<number> {
    const counts = this.countsFor(orgId, owner);
    let total = 0;
    for (const source of this.sources.values()) total += await source.sum(orgId, owner, counts);
    return cleanUsd(total);
  }

  /**
   * Makes sure `owner` has a total to add to, built from the budgets when there is none yet. A write that changes a total never creates
   * one (`addToCounter` needs it there), and a total is only created while no write has touched it, so the figure it starts at is exact.
   */
  async ensure(orgId: OrgId, owner: string): Promise<void> {
    if (await this.readTotal(orgId, owner) !== undefined) return;
    const totalUsd = await this.sum(orgId, owner);
    try {
      await this.input.documentClient.send(new PutCommand({
        TableName: this.input.tableName,
        Item: { ...ownerBudgetKey(orgId, owner), entityType: "OWNER_AGENT_BUDGET", totalUsd, version: 0, builtAt: this.iso() },
        ConditionExpression: NOT_EXISTS,
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error; // another writer built it first, from the same budgets
    }
  }

  /**
   * Replaces `owner`'s total with the sum of their budgets and answers it. The total is replaced only while it is still the figure that was
   * read, and every write to a budget changes the total in the same transaction, so the figure written is exact; a write that raced it makes
   * it read again. A merge calls this for the survivor, because a duplicate's budgets were counted under the duplicate until now.
   */
  async rebuild(orgId: OrgId, owner: string, budgets: BudgetWords = "agent"): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seen = (await this.readTotal(orgId, owner))?.["totalUsd"];
      const total = await this.sum(orgId, owner);
      if (typeof seen === "number" && Math.abs(seen - total) < 0.000001) return total;
      try {
        await this.input.documentClient.send(new UpdateCommand({
          TableName: this.input.tableName,
          Key: ownerBudgetKey(orgId, owner),
          // A rebuild changes the figure an approval summed at, so it moves the version too (Plan 3 Task 33, R4-6).
          UpdateExpression: "SET #total = :total, #type = :type, #built = :built ADD #version :one",
          ConditionExpression: typeof seen === "number" ? "#total = :seen" : "attribute_not_exists(#total)",
          ExpressionAttributeNames: { "#total": "totalUsd", "#type": "entityType", "#built": "builtAt", "#version": "version" },
          ExpressionAttributeValues: { ":total": total, ":type": "OWNER_AGENT_BUDGET", ":built": this.iso(), ":one": 1, ...(typeof seen === "number" ? { ":seen": seen } : {}) },
        }));
        return total;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
    throw totalsMoved(budgets);
  }

  /**
   * The counter items that take a subject from `before` to `after`, in each owner's survivor's total, and what their refusals mean. An
   * owner with no total yet has one built from the budgets first; a record that names a merged duplicate has the survivor's total rebuilt,
   * because the duplicate's budgets may be counted under the duplicate. A raise held to `cap` also checks the spend policy is still at the
   * revision the cap was read from. The changed item itself must be first in the transaction.
   */
  async itemsFor(orgId: OrgId, before: BudgetSubject, after: BudgetSubject, cap?: OwnerCap, budgets: BudgetWords = "agent"): Promise<OwnerTotalItems> {
    const resolve = async (subject: BudgetSubject): Promise<{ share?: OwnerShare; stale: boolean }> => {
      const share = ownerShare(subject);
      if (share === undefined) return { stale: false };
      const owner = await this.survivorOf(orgId, share.owner);
      return { share: { owner, usd: share.usd }, stale: owner !== share.owner };
    };
    const [was, now] = await Promise.all([resolve(before), resolve(after)]);
    const owners = new Map<string, boolean>();
    for (const side of [was, now]) if (side.share !== undefined) owners.set(side.share.owner, (owners.get(side.share.owner) ?? false) || side.stale);
    for (const [owner, stale] of owners) {
      if (stale) await this.rebuild(orgId, owner, budgets);
      else await this.ensure(orgId, owner);
    }
    const counters = ownerTotalItems(this.input, orgId, was.share, now.share, cap?.usd, cap?.seen);
    const items = [...counters.items];
    let policyAt: number | undefined;
    if (cap !== undefined && counters.capped.length > 0) {
      policyAt = items.length;
      items.push({
        ConditionCheck: {
          TableName: this.input.tableName,
          Key: orgSettingsKey(orgId, "SPEND_POLICY"),
          ...(cap.policyRevision === 0
            ? { ConditionExpression: NOT_EXISTS }
            : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": cap.policyRevision } }),
        },
      });
    }
    const carried = cap?.carriedSource, carriedAt = carried === undefined ? undefined : items.length;
    if (carried !== undefined) items.push(...nativeSnapshotConditions(this.input.tableName, [carried.key], [carried.exists ? carried.fields : undefined], ["amountUsd"]));
    return {
      items,
      classify: (failed) => {
        // The item changed since it was read: that is the answer, whatever the counters make of the old figures.
        if (failed.has(0)) return { kind: "entity" };
        if (carriedAt !== undefined && failed.has(carriedAt + 1)) return { kind: "totals" };
        if (policyAt !== undefined && failed.has(policyAt + 1)) return { kind: "policy" };
        const capped = counters.capped.find((index) => failed.has(index + 1));
        if (capped !== undefined) return { kind: "cap", owner: counters.owners[capped]! };
        if (counters.items.some((_item, index) => failed.has(index + 1))) return { kind: "totals" };
        return { kind: "other" };
      },
    };
  }
}
