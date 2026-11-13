// H1: a core task's row is written by Code, which names the company `companyId` where Cloud's own task rows say `orgId` (the vendored task flow's `TaskRecord`, D7). Cloud's readers of a task row
// (`authorizeTaskAction`, `resolveTaskApprover`, `taskView`, the People and identity checks, review groups, work refusals...) compare `orgId`, and a few skip a check when it is absent
// (`checkTaskPersonIdentity` skips the removed-member check for a task with no `orgId`), so on a real core task they refuse everyone or, worse, check nothing. This is the one place that closes the
// gap: a view of a document client in which a task META row that names no `orgId` reads as having its `companyId` as one, for a Get, a BatchGet and a TransactGet. Nothing is written; a Cloud
// row, which has `orgId`, is untouched. The broker's handler gives every Cloud reader this view when the Cloud root is configured (aws/broker/handler.ts), and the root's own access functions
// take it explicitly (`viewCoreTaskRows`).
import { BatchGetCommand, GetCommand, TransactGetCommand } from "@aws-sdk/lib-dynamodb";

const isTaskMeta = (key: unknown): boolean => typeof key === "object" && key !== null && typeof (key as { pk?: unknown }).pk === "string" && (key as { pk: string }).pk.startsWith("DEVTASK#") && (key as { sk?: unknown }).sk === "META";

/** A task META row as Cloud reads it: with `orgId` where the core wrote only `companyId`. */
function seen(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (item === undefined || item["orgId"] !== undefined || typeof item["companyId"] !== "string" || typeof item["pk"] !== "string" || !item["pk"].startsWith("DEVTASK#") || item["sk"] !== "META") return item;
  return { ...item, orgId: item["companyId"] };
}

async function viewedSend(inner: (command: unknown) => Promise<unknown>, command: unknown): Promise<unknown> {
  const answer = await inner(command);
  if (command instanceof GetCommand) return isTaskMeta(command.input.Key) ? { ...(answer as object), Item: seen((answer as { Item?: Record<string, unknown> }).Item) } : answer;
  if (command instanceof BatchGetCommand) {
    const responses = (answer as { Responses?: Record<string, Array<Record<string, unknown>>> }).Responses;
    if (responses === undefined) return answer;
    return { ...(answer as object), Responses: Object.fromEntries(Object.entries(responses).map(([table, items]) => [table, items.map((item) => seen(item) ?? item)])) };
  }
  if (command instanceof TransactGetCommand) {
    const responses = (answer as { Responses?: Array<{ Item?: Record<string, unknown> }> }).Responses;
    if (responses === undefined) return answer;
    return { ...(answer as object), Responses: responses.map((entry) => (entry.Item === undefined ? entry : { ...entry, Item: seen(entry.Item) })) };
  }
  return answer;
}

/** The client as Cloud's readers should see it (every other property is the real client's). */
const VIEWED = Symbol("coreTaskRowsView");

export function viewCoreTaskRowsClient<C extends { send(command: never): Promise<unknown> }>(client: C): C {
  // A client already viewed (the broker's handler views its own, once) is not wrapped again.
  if ((client as unknown as Record<symbol, unknown>)[VIEWED] === true) return client;
  return new Proxy(client, {
    get(target, property) {
      if (property === VIEWED) return true;
      if (property === "send") return (command: unknown) => viewedSend((c) => (target as unknown as { send(command: unknown): Promise<unknown> }).send(c), command);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function viewCoreTaskRows<T extends { documentClient: { send(command: never): Promise<unknown> } }>(deps: T): T {
  // A deployment (or a test's stub) with no client has nothing to view.
  if (typeof deps.documentClient !== "object" || deps.documentClient === null) return deps;
  return { ...deps, documentClient: viewCoreTaskRowsClient(deps.documentClient) };
}
