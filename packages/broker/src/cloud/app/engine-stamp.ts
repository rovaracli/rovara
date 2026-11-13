// Convergence S0 (plan 3.2, decision 130): every task is pinned to one engine when it starts, and keeps it.
//
// The stamp is its own small item, `TASK_ENGINE#<taskId>` / `STAMP`, written only by the core's start, in the start's own transaction (the core's
// `startExtras` seam), so a core task and its stamp exist together or not at all. A task with no stamp is a Cloud task: every task that exists today,
// and every task started while the switch is off. So with the switch off nothing new is written anywhere, and no task record changes shape (Cloud's
// strict readers never meet a new field).
//
// Routing reads the stamp, never the switch: a flip of the switch changes where the NEXT task starts and nothing else. A running core task finishes on
// the core after the switch is turned off; a running Cloud task finishes on Cloud's path after it is turned on.
import { when, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@rovara-code/contracts";
import { CORE_AREAS, coreAreaOn, flagSnapshot, type CoreArea, type CoreEngineFlags } from "./flags.js";

export type Engine = "cloud" | "core";

/** The attribute of the stamp item that holds the stamp. */
export const ENGINE_STAMP_ATTRIBUTE = "coreEngine";

export const engineStampKey = (taskId: string): DocumentKey => ({ pk: `TASK_ENGINE#${taskId}`, sk: "STAMP" });

export interface EngineStamp {
  /** `core` when at least one area runs on the core. */
  engine: Engine;
  /** Each area's engine for this task. With decision 130's one combined switch all three agree; a later lane may narrow one. */
  areas: Readonly<Record<CoreArea, Engine>>;
  /** The switches the task started under (`flagSnapshot`). */
  flags: string;
  stampedAt: string;
}

const CLOUD_AREAS: Readonly<Record<CoreArea, Engine>> = Object.freeze({ merge: "cloud", build: "cloud", flow: "cloud" });

/** The stamp a new task of this company gets now. */
export function stampForNewTask(flags: CoreEngineFlags, companyId: string, now: Date): EngineStamp {
  const areas = Object.fromEntries(CORE_AREAS.map((area) => [area, coreAreaOn(flags, area, companyId) ? "core" : "cloud"])) as Record<CoreArea, Engine>;
  // The task flow owns the start: a task whose flow stays on Cloud's path cannot have its build or merge on the core (the core's build step and merge
  // tracking read the core's task record, which only the core's start writes). Narrowing `flow` therefore keeps the whole task on Cloud.
  const pinned = areas.flow === "core" ? areas : CLOUD_AREAS;
  return { engine: pinned.flow, areas: { ...pinned }, flags: flagSnapshot(flags), stampedAt: now.toISOString() };
}

/** Where a new task starts. */
export function engineForNewTask(flags: CoreEngineFlags, companyId: string): Engine {
  return coreAreaOn(flags, "flow", companyId) ? "core" : "cloud";
}

/** The stamp kept on a stamp item, or undefined when it has none or it cannot be read (both mean Cloud). */
export function stampOf(record: Readonly<Record<string, unknown>> | undefined): EngineStamp | undefined {
  const raw = record?.[ENGINE_STAMP_ATTRIBUTE];
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Partial<EngineStamp>;
  if (value.engine !== "cloud" && value.engine !== "core") return undefined;
  const areas = value.areas as Partial<Record<CoreArea, unknown>> | undefined;
  if (areas === undefined || CORE_AREAS.some((area) => areas[area] !== "cloud" && areas[area] !== "core")) return undefined;
  if (typeof value.flags !== "string" || typeof value.stampedAt !== "string") return undefined;
  return value as EngineStamp;
}

/** The engine that runs this area of an existing task. Unstamped (or unreadable): Cloud. */
export function engineOfTask(record: Readonly<Record<string, unknown>> | undefined, area: CoreArea): Engine {
  return stampOf(record)?.areas[area] ?? "cloud";
}

/** The stamp item, written once with the core's start (a repeat of the start writes nothing new: `when.absent()`). */
export function stampItem(companyId: string, taskId: string, stamp: EngineStamp): Extract<TransactItem, { kind: "put" }> {
  const item: StoredDocument = { ...engineStampKey(taskId), entityType: "TASK_ENGINE", orgId: companyId, taskId, [ENGINE_STAMP_ATTRIBUTE]: { engine: stamp.engine, areas: { ...stamp.areas }, flags: stamp.flags, stampedAt: stamp.stampedAt } };
  return { kind: "put", item, condition: when.absent() };
}

/** The engine that runs this area of an existing task, read from its stamp item. No stamp (or an unreadable one): Cloud. */
export async function engineOfStoredTask(store: Pick<DocumentStore, "get">, taskId: string, area: CoreArea): Promise<Engine> {
  return engineOfTask(await store.get(engineStampKey(taskId)), area);
}
