// H1: a core task's row is written by Code, which names the company `companyId` where Cloud's own task rows say `orgId` (the vendored task flow's `TaskRecord`, D7). Cloud's access functions
// (`authorizeTaskAction`, `resolveTaskApprover`, `taskView`) read the row themselves and compare `orgId`, so on a real core task they refuse everyone. This is the one place that closes the
// gap: a view of the routes' document client in which a task row that names no `orgId` reads as having its `companyId` as one. Nothing is written; a Cloud row, which has `orgId`, is untouched.
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const isTaskMeta = (key: unknown): boolean => typeof key === "object" && key !== null && typeof (key as { pk?: unknown }).pk === "string" && (key as { pk: string }).pk.startsWith("DEVTASK#") && (key as { sk?: unknown }).sk === "META";

export function viewCoreTaskRows<T extends { documentClient: { send(command: unknown): Promise<unknown> } }>(deps: T): T {
  const inner = deps.documentClient;
  const documentClient = {
    async send(command: unknown): Promise<unknown> {
      const answer = await inner.send(command);
      if (!(command instanceof GetCommand) || !isTaskMeta(command.input.Key)) return answer;
      const item = (answer as { Item?: Record<string, unknown> }).Item;
      if (item === undefined || item["orgId"] !== undefined || typeof item["companyId"] !== "string") return answer;
      return { ...(answer as object), Item: { ...item, orgId: item["companyId"] } };
    },
  };
  return { ...deps, documentClient };
}
