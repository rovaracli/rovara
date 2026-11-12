// Convergence D1 (plan 3.3 row D1): workflow dispatch rows move from Cloud's one install-wide partition (`WORKFLOW_DISPATCH`) to the company's own
// (`ORG#<company>#WORKFLOW_DISPATCH`, Code's `dispatchPartition`).
//
// Why rows are not simply all moved: tasks are pinned to an engine (decision 130). Cloud's own sweep reads the old partition and acts on Cloud tasks;
// the core's sweep reads the new one. A row of a Cloud task moved to the new partition would be run by the core for a task the core does not own. So:
//
//  - DUAL READ (`dueRowsBothPartitions`): the core's sweep in Cloud reads its own partition AND the old one, and from the old one takes only rows of
//    core-stamped tasks of its company (Cloud code that still writes the old partition for a core task, a webhook say, is covered). A row of a kind the
//    core does not run is reported, never run.
//  - BACKFILL (this move, forward): copies a row into the new partition and deletes the old one in one transaction, for rows of core-stamped tasks
//    (`scope: "core-tasks"`, the default), or for every task (`scope: "all"`: only once Cloud's own path is deleted, wave 4 DEL). It marks each moved
//    row `movedFrom`, so the reverse finds exactly what it moved.
//  - REVERSE: puts every marked row back in the old partition, in Cloud's shape, and deletes the new one.
//
// Shape differences handled (key mapping, kept in one place for the parity suite too): `orgId` is not on old rows (read from the task record);
// `autofixCause` is `cause`; `companyId` and the scoped `dispatchDuePk` are new; kinds only Cloud runs (`CHECKS`, `UPDATE`, `RECHECK`, `GROUNDING`,
// `agent_run`, `operation_end`) are conflicts.
import { WORKFLOW_DISPATCH_DUE_INDEX, when, type DocumentStore, type JsonValue, type StoredDocument } from "@rovara-code/contracts";
import { dispatchPartition, type DispatchKind } from "@rovara-code/broker/core/task-flow";
import { engineOfStoredTask } from "../../app/engine-stamp.js";
import { partitionSource, partitionsSource, type DataMove, type MoveContext, type MovePlan } from "../framework.js";

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

export const OLD_DISPATCH_PARTITION = "WORKFLOW_DISPATCH";
const MOVED_FROM = "movedFrom";
const MOVE_ID = "d1-dispatch-partition";

/** The kinds Code's core runs (its `DispatchKind`). */
export const CORE_DISPATCH_KINDS: ReadonlySet<string> = new Set<DispatchKind>(["UNDERSTAND", "PLAN", "REPLAN", "CRITIQUE", "CRITIC_REPLAN", "IMPLEMENT", "REVIEW", "PUBLISH", "SYNC", "AUTOFIX"]);

/** The company of a task: Cloud's task record says `orgId`, a core record `companyId` (D7). Both task key forms are tried. */
async function taskCompany(store: Pick<DocumentStore, "get">, taskId: string): Promise<string | undefined> {
  const record = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
  const value = record?.orgId ?? record?.companyId;
  return typeof value === "string" ? value : undefined;
}

/** An old-partition row in the core's shape for one company. */
export function toCoreRow(old: StoredDocument, companyId: string): StoredDocument {
  const rest: Record<string, unknown> = { ...old };
  const autofixCause = rest.autofixCause;
  for (const name of ["autofixCause", "dispatchDuePk", "pk"]) delete rest[name];
  const partition = dispatchPartition(companyId);
  return {
    ...rest,
    pk: partition,
    sk: old.sk,
    companyId,
    dispatchDuePk: partition,
    ...(typeof autofixCause === "string" ? { cause: autofixCause } : {}),
    [MOVED_FROM]: OLD_DISPATCH_PARTITION,
  };
}

/** A moved row back in Cloud's shape. */
export function toCloudRow(moved: StoredDocument): StoredDocument {
  const rest: Record<string, unknown> = { ...moved };
  const cause = rest.cause;
  for (const name of ["cause", "companyId", MOVED_FROM, "pk", "dispatchDuePk"]) delete rest[name];
  return { ...rest, pk: OLD_DISPATCH_PARTITION, sk: moved.sk, dispatchDuePk: OLD_DISPATCH_PARTITION, ...(typeof cause === "string" ? { autofixCause: cause } : {}) };
}

export interface DispatchMoveOptions {
  /** `core-tasks`: only rows of core-stamped tasks (while both engines run). `all`: every row (after Cloud's own path is deleted). */
  scope?: "core-tasks" | "all";
  /** The companies whose new partitions the reverse reads. */
  companies: () => Promise<readonly string[]> | readonly string[];
  /** Items per page (default 100). */
  pageSize?: number;
}

export function dispatchPartitionMove(options: DispatchMoveOptions): DataMove {
  const scope = options.scope ?? "core-tasks";
  return {
    id: MOVE_ID,
    title: "Workflow dispatch rows into each company's partition (D1)",
    status: "ready",
    source: {
      forward: partitionSource(OLD_DISPATCH_PARTITION, options.pageSize),
      reverse: partitionsSource(async () => (await options.companies()).map(dispatchPartition), options.pageSize),
    },
    async plan(item: StoredDocument, direction, context: MoveContext): Promise<MovePlan> {
      if (direction === "reverse") {
        if (item[MOVED_FROM] !== OLD_DISPATCH_PARTITION) return { kind: "skip", reason: "not moved by this move" };
        const back = toCloudRow(item);
        return { kind: "write", steps: [
          { kind: "put", item: back, condition: when.absent() },
          { kind: "delete", key: { pk: item.pk, sk: item.sk }, condition: when.eq("nextAttemptAt", item.nextAttemptAt ?? null) },
        ] };
      }
      const taskId = item.taskId;
      if (typeof taskId !== "string") return { kind: "conflict", reason: "the row names no task" };
      if (typeof item.kind !== "string" || !CORE_DISPATCH_KINDS.has(item.kind)) {
        // A kind only Cloud runs stays on Cloud's partition while Cloud's path is there; after DEL it is a conflict to look at by hand.
        return scope === "all" ? { kind: "conflict", reason: `a kind the core does not run (${typeof item.kind === "string" ? item.kind : "none"})` } : { kind: "skip", reason: "a kind only Cloud runs" };
      }
      if (scope === "core-tasks" && (await engineOfStoredTask(context.store, taskId, "flow")) !== "core") return { kind: "skip", reason: "a Cloud task (pinned to Cloud's path)" };
      const companyId = await taskCompany(context.store, taskId);
      if (companyId === undefined) return { kind: "conflict", reason: "the task's company cannot be read" };
      const moved = toCoreRow(item, companyId);
      return { kind: "write", steps: [
        { kind: "put", item: moved, condition: when.absent() },
        // Fenced on the due time read: a sweep that rescheduled the row meanwhile makes this apply fail, and the runner plans it again.
        { kind: "delete", key: { pk: item.pk, sk: item.sk }, condition: when.eq("nextAttemptAt", item.nextAttemptAt ?? null) },
      ] };
    },
  };
}

export interface DualReadReport {
  rows: StoredDocument[];
  /** Old-partition rows of this company's core tasks that the core cannot run (reported, not run). */
  unknownKinds: { taskId: string; kind: string }[];
}

/**
 * The core sweep's due rows in Cloud: its own partition, plus the old partition's rows of this company's core-stamped tasks, in the core's shape (oldest
 * first). The old rows keep their old key, so the stage machine's resolve and reschedule steps (which address `row.pk`/`row.sk`) act on the row that is there.
 */
export async function dueRowsBothPartitions(store: DocumentStore, companyId: string, now: string, limit: number): Promise<DualReadReport> {
  const due = { op: "lte" as const, value: `${now}#￿` };
  const [own, old] = await Promise.all([
    store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: dispatchPartition(companyId), sort: due, limit }),
    store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: OLD_DISPATCH_PARTITION, sort: due, limit }),
  ]);
  const unknownKinds: DualReadReport["unknownKinds"] = [];
  const adopted: StoredDocument[] = [];
  for (const row of old.items) {
    const taskId = row.taskId;
    if (typeof taskId !== "string" || (await engineOfStoredTask(store, taskId, "flow")) !== "core") continue;
    if ((await taskCompany(store, taskId)) !== companyId) continue;
    if (typeof row.kind !== "string" || !CORE_DISPATCH_KINDS.has(row.kind)) { unknownKinds.push({ taskId, kind: typeof row.kind === "string" ? row.kind : "none" }); continue; }
    adopted.push({ ...toCoreRow(row, companyId), pk: row.pk, dispatchDuePk: row.dispatchDuePk as JsonValue });
  }
  const rows = [...own.items, ...adopted].sort((a, b) => textOf(a.dispatchDueSk).localeCompare(textOf(b.dispatchDueSk))).slice(0, limit);
  return { rows, unknownKinds };
}
