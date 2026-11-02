// The nightly run's result route, broker side (NH-1): `POST /v1/internal/workspaces/{w}/operations/{o}/nightly-result`, the ONE action a nightly run's worker has to report with.
//
// The slot id is not a secret (the scheduler's input names it), so nothing about WHO may record is read from the body. The caller is authenticated the way every operation callback is, and then held to the
// same rules the setup run's callback is held to:
//   - the capability (`nightly-result`) was granted by the broker to the verification operation of a nightly task, and carries the operation's fence (a stale fence is refused before this runs);
//   - the operation is RUNNING, is a task operation in verification mode, and its workspace's task is a `nightly_run` task of the operation's company that is still open: the org and the project come
//     from that task, never from the body;
//   - the result is accepted only for what that task was started to run: the same slot, environment revision, branch and commit, all four. A result for another slot, another revision or another commit,
//     from a worker that holds a valid capability for its own run, is refused and changes nothing.
// Everything else (the lock the slot holds, the clock, the coverage map's digest, the classification and the project's health) is `recordNightlyResultWithHealth`'s own. With `nh` or the test environment
// off, the route answers CALLBACK_FORBIDDEN and nothing is read.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { NIGHTLY_RUN_PURPOSE, NightlyResultCallbackBodySchema, NightlyResultSchema, agentXError, type OrgId } from "@agentx/contracts";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { healthWiringOn, recordNightlyResultWithHealth } from "./health-wiring.js";
import type { MapStore } from "./nightly.js";

/** The authenticated operation, as the callback route read it. */
export interface NightlyOperation { kind: string; workflowMode?: string | undefined; status: string; workspaceId: string; orgId?: string | undefined }

/** The run an operation belongs to: its task, which must be a nightly task of the operation's company, still open. Undefined for anything else. */
export async function nightlyRunOfOperation(deps: TestEnvDeps, operation: NightlyOperation): Promise<{ orgId: OrgId; project: string; taskId: string; started: NonNullable<DeveloperTaskRecord["nightlyRun"]> } | undefined> {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || operation.status !== "RUNNING") return undefined;
  const get = async <T>(key: { pk: string; sk: string }): Promise<T | undefined> => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
  const pointer = await get<DeveloperTaskPointerRecord>(taskPointerKey(operation.workspaceId));
  if (pointer === undefined) return undefined;
  const task = await get<DeveloperTaskRecord>(taskKey(pointer.taskId));
  if (task === undefined || task.purpose !== NIGHTLY_RUN_PURPOSE || task.nightlyRun === undefined || task.orgId === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined) return undefined;
  if (operation.orgId !== undefined && operation.orgId !== task.orgId) return undefined;
  return { orgId: task.orgId, project: task.project, taskId: task.taskId, started: task.nightlyRun };
}

/** Handles one nightly result. Throws CALLBACK_FORBIDDEN for an operation that is not a running nightly run (or while `nh` is off) or a result for anything else than what the run was started to run, CONFIG_INVALID for a body that is not the shape. */
export async function handleNightlyResultCallback(
  deps: TestEnvDeps & { maps: MapStore },
  operation: NightlyOperation,
  rawBody: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ recorded: true; flakyCount: number; failingCount: number }> {
  if (!healthWiringOn(env)) throw agentXError("CALLBACK_FORBIDDEN", "nightly runs are not on");
  const run = await nightlyRunOfOperation(deps, operation);
  if (run === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the nightly callback is limited to a running nightly run");
  const body = NightlyResultCallbackBodySchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", "the nightly callback body is not the shape");
  const result = NightlyResultSchema.safeParse(body.data.result);
  if (!result.success) throw agentXError("CONFIG_INVALID", "the nightly result could not be read");
  const { slotId, envRevision, branch, headSha } = result.data;
  if (slotId !== run.started.slotId || envRevision !== run.started.envRevision || branch !== run.started.branch || headSha !== run.started.headSha) {
    throw agentXError("CALLBACK_FORBIDDEN", "this result is not for what this run was started to run");
  }
  return recordNightlyResultWithHealth(deps, deps.maps, { orgId: run.orgId, project: run.project, result: result.data, ...(body.data.coverageMap === undefined ? {} : { coverageMap: body.data.coverageMap }) }, env);
}
