// Plan 3 Task 28: the one monthly total each person's agent budgets count against. The total is a counter (`OWNER_AGENT_BUDGET#<developer>`)
// the agent store changes in the same transaction as the agent's own item, so it can't drift from the budgets it adds up. Only an active
// agent's `monthlyBudgetUsd` counts in the counter: not a per-run cap, not a top-up, and not an archived agent. A scope whose base is $0 counts $0 there, but it is still
// one of the owner's scopes (Plan 4 review I-2): this month's top-ups on it are spendable, so the effective total adds them. The cap itself is on the effective total, the counter plus this
// month's top-ups (Task 33 fix round 1, I-1): a raise is held to the cap less the top-ups, at the counter's version (`ownerTotalItems`' `seen`).
import { ownerBudgetKey } from "@agentx/cloud-contracts";
import { type AgentOwner, type OrgId } from "@rovara-code/contracts";
import type { AgentRecord, BuiltinSettings } from "../agents/store.js";
import { addToCounter, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { cleanUsd } from "./top-ups.js";

/** The fields of an agent record or a built-in's settings that decide whose total its budget is in. */
export interface BudgetSubject {
  owner?: AgentOwner;
  accountable?: { developerId: string };
  status?: "active" | "archived";
  monthlyBudgetUsd?: number;
}

/** The developer an agent's budget counts for: the member owner, else the accountable maintainer; a built-in with no accountable counts for no one. */
export function budgetOwnerOf(record: AgentRecord | BuiltinSettings | BudgetSubject): string | undefined {
  return "owner" in record && record.owner?.kind === "member" ? record.owner.developerId : record.accountable?.developerId;
}

/** `subject` with some of its budget fields replaced; a field given as `undefined` is removed. */
export function withBudgetFields<T extends BudgetSubject>(subject: T, changes: { status?: "active" | "archived"; owner?: AgentOwner; accountable?: { developerId: string } | undefined; monthlyBudgetUsd?: number | undefined }): T {
  const { accountable: _accountable, monthlyBudgetUsd: _monthly, ...rest } = subject; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
  const accountable = "accountable" in changes ? changes.accountable : subject.accountable;
  const monthlyBudgetUsd = "monthlyBudgetUsd" in changes ? changes.monthlyBudgetUsd : subject.monthlyBudgetUsd;
  return {
    ...rest,
    ...(changes.status === undefined ? {} : { status: changes.status }),
    ...(changes.owner === undefined ? {} : { owner: changes.owner }),
    ...(accountable === undefined ? {} : { accountable }),
    ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }),
  } as T;
}

/**
 * What an agent adds to someone's total: nothing while it is archived, has no budget or has no one to count for. A budget of $0 is a share of $0: the agent is
 * still the owner's (its top-ups are spendable and count in the effective total), and it adds nothing to the counter.
 */
export interface OwnerShare {
  owner: string;
  usd: number;
}

export function ownerShare(subject: BudgetSubject): OwnerShare | undefined {
  const owner = budgetOwnerOf(subject);
  const usd = subject.monthlyBudgetUsd;
  if (subject.status === "archived" || owner === undefined || usd === undefined || usd < 0) return undefined;
  return { owner, usd };
}

/**
 * The counter changes that take an agent's share (owners already resolved to their survivors, and their counters already there, see the store's `totalsFor`) from `before` to `after`: one item when the owner stays (nothing when the share does
 * too), two when it moves. A change that raises someone's total is held to `capUsd` when one is given. `capped` lists the indexes, among
 * the returned items, that carry the cap, so the caller can tell which refusal is which.
 *
 * Task 33 fix round 1 (I-1): the cap is on the owner's effective total, base plus this month's top-ups. `seen` is that total as the caller read it: the
 * owner's raise is held to the cap less `extraUsd` (what the counter does not hold), and only while the counter's `version` is still `version`, so a
 * top-up approved after the read can't be raced past.
 */
export function ownerTotalItems(table: TableInput, orgId: OrgId, before: OwnerShare | undefined, after: OwnerShare | undefined, capUsd?: number, seen?: OwnerTotalSeen): { items: TransactItem[]; owners: string[]; capped: number[] } {
  const items: TransactItem[] = [];
  const owners: string[] = [];
  const capped: number[] = [];
  // `moves`: the agent starts or stops counting for this owner. A $0 share changes no figure, but its top-ups join or leave the owner's effective total, so the
  // counter's version still moves (a zero `ADD`), and a join held to the cap is pinned to the version the cap was read at (Plan 4 review I-2).
  const add = (owner: string, delta: number, moves = false) => {
    if (delta === 0 && !moves) return;
    const holdsCap = delta > 0 && capUsd !== undefined;
    const pinned = delta === 0 && moves && capUsd !== undefined && seen?.owner === owner;
    if (holdsCap || pinned) capped.push(items.length);
    owners.push(owner);
    const held = (holdsCap || pinned) && seen?.owner === owner ? seen : undefined;
    const counter = withVersionBump(addToCounter(table, ownerBudgetKey(orgId, owner), "totalUsd", delta, holdsCap ? cleanUsd(capUsd - (held?.extraUsd ?? 0)) : undefined));
    items.push(held === undefined ? counter : atVersion(counter, held.version));
  };
  if (before !== undefined && after !== undefined && before.owner === after.owner) {
    add(after.owner, cleanUsd(after.usd - before.usd));
  } else {
    if (before !== undefined) add(before.owner, cleanUsd(-before.usd) + 0, true);
    if (after !== undefined) add(after.owner, cleanUsd(after.usd), true);
  }
  return { items, owners, capped };
}

/** An owner's effective total as a writer read it (Task 33 fix round 1, I-1): the counter's `version`, and what the total holds beyond the counter (top-ups). */
export interface OwnerTotalSeen {
  owner: string;
  version: number;
  extraUsd: number;
}

/** A counter update held to the version it was read at too (a counter from before versions has none, which reads as 0). */
function atVersion(item: TransactItem, version: number): TransactItem {
  const update = item.Update;
  if (update === undefined) return item;
  return {
    Update: {
      ...update,
      ConditionExpression: `${update.ConditionExpression ?? "attribute_exists(pk)"} AND ${version === 0 ? "(attribute_not_exists(#ownerVersion) OR #ownerVersion = :seenVersion)" : "#ownerVersion = :seenVersion"}`,
      ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":seenVersion": version },
    },
  };
}

/**
 * Task 33 (R4-6): every change to an owner's budgets or top-ups moves the owner counter's `version`, so an approval that summed the owner's total at one version
 * can be made conditional on nothing having changed since. This adds the bump to a counter update (`ADD`).
 */
export function withVersionBump(item: TransactItem): TransactItem {
  const update = item.Update;
  if (update === undefined) return item;
  return {
    Update: {
      ...update,
      UpdateExpression: `${update.UpdateExpression ?? ""}, #ownerVersion :ownerVersionStep`,
      ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#ownerVersion": "version" },
      ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":ownerVersionStep": 1 },
    },
  };
}

/**
 * The owner counter's version step on its own: conditional on the version being `expected` (an owner's approval that summed the total at it), or on the counter
 * existing (a change that moves the total anyway). A counter from before versions has none, which reads as 0.
 */
export function ownerVersionItem(table: TableInput, orgId: OrgId, owner: string, expected?: number): TransactItem {
  return {
    Update: {
      TableName: table.tableName,
      Key: ownerBudgetKey(orgId, owner),
      UpdateExpression: "ADD #version :one",
      ConditionExpression: expected === undefined ? "attribute_exists(pk)"
        : expected === 0 ? "attribute_exists(pk) AND (attribute_not_exists(#version) OR #version = :expected)" : "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":one": 1, ...(expected === undefined ? {} : { ":expected": expected }) },
    },
  };
}
