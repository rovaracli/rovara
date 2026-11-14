// TE-F1e steps (a)-(b): whose call this is and whether its operation is live, read from the function's OWN State records for the operation a verified capability names. Nothing comes from the frame or the worker.
// The reads and checks follow the task model fallback's (model-selection/authorize-fallback.ts): the operation (its org, kind, fence and a live status), its workspace (the same org, this operation active at this
// fence, BUSY), the workspace's task pointer, and the task (the same org and workspace, not closed, on the workspace's project). Any mismatch is undefined: the caller answers the one `not_found`.
// Read-only: the function's role holds GetItem only on these key prefixes (WORKSPACE#, DEVTASK#), apart from its read-write meter and source prefixes.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type OrgId } from "@rovara-code/contracts";
import { operationKey } from "../aws/cancellation.js";
import { taskKey, taskPointerKey } from "../developer/task-records.js";
import type { ModelEgressCapabilityClaims } from "./capability.js";

export interface OperationScope {
  readonly orgId: OrgId;
  readonly project: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly operationId: string;
}

export type OperationScopeReader = (claims: ModelEgressCapabilityClaims) => Promise<OperationScope | undefined>;

const LIVE = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export function createOperationScopeReader(deps: { readonly documentClient: Pick<DynamoDBDocumentClient, "send">; readonly tableName: string }): OperationScopeReader {
  const read = async (Key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  return async (claims) => {
    try {
      const [operation, workspace, pointer] = await Promise.all([
        read(operationKey(claims.workspaceId, claims.operationId)),
        read({ pk: `WORKSPACE#${claims.workspaceId}`, sk: "META" }),
        read(taskPointerKey(claims.workspaceId)),
      ]);
      const org = OrgIdSchema.safeParse(operation?.orgId);
      if (!org.success || operation === undefined || workspace === undefined || pointer === undefined) return undefined;
      if (operation.id !== claims.operationId || operation.workspaceId !== claims.workspaceId || operation.kind !== "task" || operation.fence !== claims.fence || !LIVE.has(String(operation.status))) return undefined;
      if (workspace.orgId !== org.data || workspace.activeOperationId !== claims.operationId || workspace.fence !== claims.fence || workspace.status !== "BUSY" || typeof workspace.projectName !== "string") return undefined;
      if (typeof pointer.taskId !== "string" || pointer.cancelledAt !== undefined) return undefined;
      const task = await read(taskKey(pointer.taskId));
      if (task === undefined || task.orgId !== org.data || task.taskId !== pointer.taskId || task.workspaceId !== claims.workspaceId || task.closedAt !== undefined || task.outcome !== undefined || task.project !== workspace.projectName) return undefined;
      return { orgId: org.data, project: workspace.projectName, taskId: pointer.taskId, workspaceId: claims.workspaceId, operationId: claims.operationId };
    } catch {
      return undefined;
    }
  };
}
