// S3-10 review H1(b): the broker WITHOUT a Cloud root (cc off) still knows a core task by its engine stamp, and never hands one to Cloud's own code. A core task's worker callbacks and Cloud's share the
// WORKSPACE#/OPERATION# row keys and the callback signing key, so Cloud's callback code would accept a core worker's post and write rows in its own shape over the core's. With cc off:
//   - a worker callback the core serves (CORE_CALLBACK_ACTIONS) on a core-stamped task is answered 503 (the worker retries later; no row is read beyond the stamp, none is written);
//   - Cloud's decide, close, retry, cancel and revise routes see the task as the core's (`owns`) and are refused in words (RUNTIME_UNAVAILABLE), never run over the core's rows.
// The reverse plan is cc on -> drain -> no core task in flight -> off (docs/day-two.md): with it, this guard never fires. It is the safety net for a flip straight to off, or a rollback.
// Cheap with cc off: a company that never started a core task has no in-use mark, so an install that never switched on reads one partition (cached) and nothing per request.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@rovara-code/contracts";
import type { CoreTaskRoutes } from "../../rovara-code/task-routes.js";
import { CORE_NOT_AVAILABLE_PREFIX } from "../../rovara-code/task-routes.js";
import { taskKey, taskPointerKey } from "../../developer/task-records.js";
import { CORE_IN_USE_PARTITION, engineOfStoredTask } from "./engine-stamp.js";

/** The worker callbacks Code's callback service answers (entry.ts `CORE_CALLBACK_ACTIONS`, kept equal by a test). Kept here so this file imports nothing heavy. */
export const GUARDED_CALLBACK_ACTIONS: ReadonlySet<string> = new Set([
  "events", "artifacts", "result", "candidate-export", "candidate-build-source", "baseline-source", "e2e-admission", "e2e-evidence", "pull-request", "pull-request-update", "setup-agent", "repository-credentials",
]);
const CALLBACK_PATH = /^\/v1\/internal\/workspaces\/([0-9a-f-]{36})\/operations\/([0-9a-f-]{36})\/([a-z0-9-]+)$/u;

/** What a person is told for a core task while the core engine is off on this install. */
export const CORE_ENGINE_OFF_WORDS = `${CORE_NOT_AVAILABLE_PREFIX} This task runs on Rovara's new engine, which is switched off on this install right now. Try again once it is back on.`;

export interface CoreStampGuardDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

export interface CoreStampGuard {
  /** A 503 for a worker callback of a core-stamped task; undefined for anything else (Cloud's, as before). */
  callback(request: { method: string; path: string }): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined>;
  /** Install with `installCoreTaskRoutes`: owns a core-stamped task, and refuses every action on it. */
  readonly taskRoutes: CoreTaskRoutes;
}

const retryLater = (): { statusCode: number; headers: Record<string, string>; body: string } => ({
  statusCode: 503, headers: { "content-type": "application/json", "retry-after": "60", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "the core engine is off on this install; try again later" } }),
});

export function createCoreStampGuard(deps: CoreStampGuardDeps): CoreStampGuard {
  const read = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  // Whether any company ever started a core task (an in-use mark exists). True is kept for good (a mark is never removed); false is read again after a minute.
  let used = false;
  let checkedAt = -Infinity;
  const everUsed = async (): Promise<boolean> => {
    if (used || deps.now() - checkedAt < 60_000) return used;
    const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": CORE_IN_USE_PARTITION }, Limit: 1, ConsistentRead: true })) as { Items?: unknown[] };
    used = (page.Items ?? []).length > 0;
    checkedAt = deps.now();
    return used;
  };
  const isCore = async (taskId: string): Promise<boolean> => (await engineOfStoredTask({ get: read as never }, taskId, "flow")) === "core";
  const refuse = async (): Promise<never> => { throw agentXError("RUNTIME_UNAVAILABLE", CORE_ENGINE_OFF_WORDS); };
  return {
    async callback(request) {
      if (request.method !== "POST") return undefined;
      const match = CALLBACK_PATH.exec(request.path.split("?")[0] ?? "");
      if (match === null || !GUARDED_CALLBACK_ACTIONS.has(match[3]!)) return undefined;
      if (!(await everUsed())) return undefined;
      const taskId = (await read(taskPointerKey(match[1]!)))?.["taskId"];
      return typeof taskId === "string" && await isCore(taskId) ? retryLater() : undefined;
    },
    taskRoutes: {
      async owns(caller, taskId) {
        if (!(await everUsed())) return false;
        if (!(await isCore(taskId))) return false;
        const row = await read(taskKey(taskId));
        return row !== undefined && (row["orgId"] ?? row["companyId"]) === caller.orgId;
      },
      decide: refuse, close: refuse, retry: refuse, cancel: refuse, revisePlan: refuse,
    },
  };
}
