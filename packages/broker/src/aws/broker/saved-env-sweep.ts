// Saved project images (SV wiring): settling the end of a rebuild. Every start leaves a marker (saved-env-rebuild.ts) listed in the sparse due index; this runs in the five-minute session sweep and, for each marker
// whose time has come, looks at what the build became:
//   - the operation made for the job ended (it succeeded, failed, was cancelled or lost), or the job's lease ran out, or the build is older than a day: the BUILD is over. A job that is still the project's current one
//     was never recorded, so it is ended now with a fixed word (`endBuildJob`: a failure with the backoff, or, if the repository moved since the queue, a new job for the heads now), and the build workspace is
//     retired: its compute and volume are deleted through the workspace deletion path every workspace uses, the workspace is marked CLOSED and given an expiry, and an operation that was still live is ended;
//   - otherwise the marker is looked at again in ten minutes.
// A workspace whose compute cannot be deleted just now (it is starting or stopping) is looked at again; nothing here throws into the sweep.
import { DeleteCommand, UpdateCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { WORKFLOW_DISPATCH_DUE_INDEX, WorkspaceInstanceSchema, workspaceRecordFields } from "@agentx/contracts";
import { endBuildJob } from "../../test-env/saved-env.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { TERMINAL, operationKey } from "../cancellation.js";
import { workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { CLOSE_BUILD_WORKSPACE_EXPRESSION, SAVED_ENV_BUILD_LOOK_MS, SAVED_ENV_BUILD_PARTITION, closedWorkspaceExpiry, savedEnvBuildDueKey, startMarkerKey } from "../../test-env/saved-env-markers.js";
import { deleteWorkspaceCompute } from "./thread-workspaces.js";

/** The most markers one pass settles. */
export const SAVED_ENV_SWEEP_LIMIT = 10;
/** A build older than this is over whatever its operation says. */
export const SAVED_ENV_BUILD_MAX_AGE_MS = 24 * 3_600_000;

type Row = Record<string, unknown>;
const log = (event: string, extra: Record<string, unknown> = {}): void => { console.log(JSON.stringify({ component: "broker", event, ...extra })); };
const markerKey = startMarkerKey;

export async function sweepSavedEnvBuilds(dependencies: AwsBrokerDependencies, limit: number = SAVED_ENV_SWEEP_LIMIT, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const deps = dependencies.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env)) return "off";
  const table = dependencies.tableName;
  const send = (command: unknown): Promise<unknown> => (dependencies.documentClient as unknown as { send(command: unknown): Promise<unknown> }).send(command);
  const nowMs = deps.now();
  let settled = 0;
  let waiting = 0;
  let failed = 0;
  try {
    const due = await send(new QueryCommand({
      TableName: table, IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
      KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
      ExpressionAttributeValues: { ":pk": SAVED_ENV_BUILD_PARTITION, ":from": "0", ":due": `${String(nowMs).padStart(15, "0")}~` }, Limit: limit,
    })) as { Items?: Row[] };
    for (const listed of due.Items ?? []) {
      try {
        if (typeof listed.jobId !== "string") continue;
        // The index is eventually consistent: the marker itself says whether it is still open.
        const marker = ((await send(new GetCommand({ TableName: table, Key: markerKey(listed.jobId), ConsistentRead: true }))) as { Item?: Row }).Item;
        if (marker === undefined || marker.retiredAt !== undefined || typeof marker.orgId !== "string" || typeof marker.projectId !== "string" || typeof marker.workspaceId !== "string" || typeof marker.operationId !== "string" || typeof marker.createdAt !== "string") continue;
        const ids = { orgId: marker.orgId, projectId: marker.projectId };
        const operation = ((await send(new GetCommand({ TableName: table, Key: operationKey(marker.workspaceId, marker.operationId), ConsistentRead: true }))) as { Item?: { status?: unknown } }).Item;
        const state = await deps.store.get(ids.orgId, ids.projectId);
        const current = state?.job?.jobId === listed.jobId ? state.job : undefined;
        const operationEnded = operation === undefined || TERMINAL.has(operation.status as never);
        const leaseExpired = current !== undefined && Date.parse(current.leaseUntil) <= nowMs;
        const tooOld = nowMs - Date.parse(marker.createdAt) > SAVED_ENV_BUILD_MAX_AGE_MS;
        if (!operationEnded && !leaseExpired && !tooOld) {
          await send(new UpdateCommand({ TableName: table, Key: markerKey(listed.jobId), UpdateExpression: "SET #sort = :next", ExpressionAttributeNames: { "#sort": WORKFLOW_DISPATCH_DUE_INDEX.sortKey }, ExpressionAttributeValues: { ":next": savedEnvBuildDueKey(nowMs + SAVED_ENV_BUILD_LOOK_MS, listed.jobId) } }));
          waiting += 1;
          continue;
        }
        // The build is over. The job, if it is still the project's, was never recorded.
        if (current !== undefined) await endBuildJob(deps, ids, listed.jobId, operationEnded ? "operation_failed" : "lease_expired");
        const retired = await retireBuildWorkspace(dependencies, marker.workspaceId, marker.operationId, listed.jobId, nowMs);
        if (retired === "foreign") {
          // The workspace is not the one this job made (its operation names another job, or none): it is left alone and the marker is dropped.
          log("saved_env.marker_dropped", { reason: "workspace_not_the_jobs" });
          await send(new DeleteCommand({ TableName: table, Key: markerKey(listed.jobId) }));
        } else if (retired === "retired") {
          await send(new UpdateCommand({
            TableName: table, Key: markerKey(listed.jobId), UpdateExpression: "SET retiredAt = :now REMOVE #pk, #sort",
            ExpressionAttributeNames: { "#pk": WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, "#sort": WORKFLOW_DISPATCH_DUE_INDEX.sortKey }, ExpressionAttributeValues: { ":now": new Date(nowMs).toISOString() },
          }));
          settled += 1;
        } else {
          await send(new UpdateCommand({ TableName: table, Key: markerKey(listed.jobId), UpdateExpression: "SET #sort = :next", ExpressionAttributeNames: { "#sort": WORKFLOW_DISPATCH_DUE_INDEX.sortKey }, ExpressionAttributeValues: { ":next": savedEnvBuildDueKey(nowMs + SAVED_ENV_BUILD_LOOK_MS, listed.jobId) } }));
          waiting += 1;
        }
      } catch (error) {
        failed += 1;
        log("saved_env.sweep_item_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
  } catch (error) {
    log("saved_env.sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
  return { settled, waiting, failed };
}

/**
 * Deletes the build workspace's compute and storage through the workspace deletion path, then marks the workspace CLOSED (with an expiry) and ends an operation that was still live. False when the compute cannot
 * be deleted just now (the sweep looks again). A workspace that is not there, or already CLOSED, is done.
 * Before anything is deleted the workspace's operation must name THIS job (`savedEnvJobId`): a workspace whose operation names another job, or none (or has no record), is not what the marker says it is, and is
 * left alone (`foreign`: the caller drops the marker).
 */
export async function retireBuildWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string, operationId: string, jobId: string, nowMs: number): Promise<"retired" | "later" | "foreign"> {
  const send = (command: unknown): Promise<unknown> => (dependencies.documentClient as unknown as { send(command: unknown): Promise<unknown> }).send(command);
  const item = ((await send(new GetCommand({ TableName: dependencies.tableName, Key: workspaceKey(workspaceId), ConsistentRead: true }))) as { Item?: Row }).Item;
  if (item === undefined) return "retired";
  const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
  if (!parsed.success) return "later";
  const linked = ((await send(new GetCommand({ TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId), ConsistentRead: true }))) as { Item?: { savedEnvJobId?: unknown } }).Item;
  if (linked?.savedEnvJobId !== jobId) return "foreign";
  if (parsed.data.status !== "CLOSED") {
    try { await deleteWorkspaceCompute(dependencies, parsed.data); } catch (error) {
      log("saved_env.workspace_delete_failed", { error: error instanceof Error ? error.name : "unknown" });
      return "later";
    }
    const at = new Date(nowMs).toISOString();
    await send(new UpdateCommand({
      TableName: dependencies.tableName, Key: workspaceKey(workspaceId), UpdateExpression: CLOSE_BUILD_WORKSPACE_EXPRESSION,
      ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":at": at, ":expires": closedWorkspaceExpiry(nowMs) },
    }));
  }
  // An operation that never reported (the worker was lost) is ended: nothing will report for it now.
  await send(new UpdateCommand({
    TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId), UpdateExpression: "SET #status = :failed, updatedAt = :at, #error = :error",
    ConditionExpression: "attribute_exists(pk) AND (#status = :accepted OR #status = :dispatching OR #status = :running)", ExpressionAttributeNames: { "#status": "status", "#error": "error" },
    ExpressionAttributeValues: { ":failed": "FAILED", ":at": new Date(nowMs).toISOString(), ":error": "the saved image rebuild ended", ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING" },
  })).catch((error: unknown) => { if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error; });
  return "retired";
}
