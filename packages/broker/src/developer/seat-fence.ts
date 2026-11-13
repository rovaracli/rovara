// packages/broker/src/developer/seat-fence.ts
// 0.5.18x (owner decision 183(d)): a Slack account LINKED to a web account acts as that account, and an unlink must remove the rights at once. The seat is read at the start of a request
// (`slackRequesterStanding`), so an unlink that commits after that read and before the request's write would still let the write act as the web account. The fence closes that window: the seat
// carries the conditions its first hop must still meet (the link's reverse item still naming the account, or the merge record still pointing at it: see `merged-owner.ts`
// `linkedPersonOf`), and every task write made for that caller adds them to its own transaction, so an unlink that commits first wins and the write is refused.
//
// The fence rides on the caller under a symbol key: object spreads keep it (a caller re-built from the seat stays fenced), JSON and DynamoDB marshalling never see it (no id reaches a log or a
// record through it). Only a Slack caller seated through a link or a merge has one; any other caller is unchanged.
import type { DeveloperTaskActions, TransactItems } from "../aws/developer-task-actions.js";

type TransactItem = TransactItems[number];
export type SeatFence = readonly TransactItem[];

export const SEAT_FENCE: unique symbol = Symbol("rovara.slackSeatFence");

/** `caller` carrying `fence` (the same object; nothing is added for an empty fence). */
export function withSeatFence<T extends object>(caller: T, fence: SeatFence): T {
  if (fence.length === 0) return caller;
  Object.defineProperty(caller, SEAT_FENCE, { value: fence, enumerable: true, configurable: true, writable: false });
  return caller;
}

/** The fence a caller carries, if any. */
export function seatFenceOf(caller: object | undefined): SeatFence | undefined {
  const fence = caller === undefined ? undefined : (caller as { [SEAT_FENCE]?: SeatFence })[SEAT_FENCE];
  return fence === undefined || fence.length === 0 ? undefined : fence;
}

const keyOf = (item: TransactItem): string | undefined => {
  const action = (item.ConditionCheck ?? item.Update ?? item.Delete ?? item.Put) as { TableName?: string; Key?: Record<string, unknown>; Item?: Record<string, unknown> } | undefined;
  const key = action?.Key ?? action?.Item;
  return action === undefined || key === undefined ? undefined : JSON.stringify([action.TableName, key["pk"], key["sk"]]);
};

/**
 * `items` with the fence's conditions in the same transaction. A fence item whose key the transaction already names is merged into that item's own condition (a transaction may name one item
 * once), with its own placeholder names, so neither condition changes the other.
 */
export function fencedItems(items: TransactItems, fence: SeatFence | undefined): TransactItems {
  if (fence === undefined || fence.length === 0) return items;
  const out = [...items];
  for (const guard of fence) {
    const check = guard.ConditionCheck;
    if (check === undefined) throw new Error("a seat fence holds condition checks only");
    const index = out.findIndex((item) => keyOf(item) === keyOf(guard));
    if (index < 0) { out.push(guard); continue; }
    const item = out[index]!;
    const kind = (["ConditionCheck", "Update", "Delete", "Put"] as const).find((name) => item[name] !== undefined)!;
    const action = item[kind] as { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
    const names = { ...action.ExpressionAttributeNames, ...check.ExpressionAttributeNames };
    const values = { ...action.ExpressionAttributeValues, ...check.ExpressionAttributeValues };
    out[index] = { [kind]: {
      ...action,
      ConditionExpression: action.ConditionExpression === undefined ? check.ConditionExpression : `(${action.ConditionExpression}) AND (${check.ConditionExpression})`,
      ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }),
      ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }),
    } };
  }
  return out;
}

/** Where each write action of `DeveloperTaskActions` takes its extra items (`ExtraItems`): those writes carry the fence too. */
const EXTRA_ARGUMENT: Partial<Record<keyof DeveloperTaskActions, number>> = { acceptTask: 3, acceptPullRequest: 3, acceptPullRequestUpdate: 3, cancelRunning: 2, startClose: 3 };

/** The task actions for a fenced caller: `transact` and every write that takes extra items add the fence to their one transaction. */
export function fencedActions(actions: DeveloperTaskActions, fence: SeatFence | undefined): DeveloperTaskActions {
  if (fence === undefined || fence.length === 0) return actions;
  return new Proxy(actions, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "transact") return (items: TransactItems) => target.transact(fencedItems(items, fence));
      const at = typeof property === "string" ? EXTRA_ARGUMENT[property as keyof DeveloperTaskActions] : undefined;
      if (at !== undefined && typeof value === "function") {
        return (...args: unknown[]) => {
          const extra = args[at] as ((operation: unknown) => TransactItems) | undefined;
          args[at] = (operation: unknown) => fencedItems(extra === undefined ? [] : extra(operation), fence);
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? (value as (...input: unknown[]) => unknown).bind(target) : value;
    },
  });
}
