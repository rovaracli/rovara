// Team record source-row lane, T4: what a task tells the Team record besides a send-back (`send-back-events.ts` is the send-back's own). Four things are told: a remembered note, a plan's outcome,
// a published review's outcome and the end of the task. Each hook point (`learning/capture-comment.ts`, `rovara-code/outcome-hooks.ts`, and the task-end handler below) announces here with one
// call, the same way a send-back is announced: a process-wide list of listeners, none by default, so with the Team record off nothing happens and the caller is exactly what it was.
//
// An announcement never reaches its caller as a failure and never holds it long: the event is built and the listeners run inside one small time budget; a listener that throws, or is still
// working when the budget ends, is logged with a fixed code (`record.emit_failed`) and the caller goes on. (A write that outlives the budget finishes on its own; the row is keyed by the task
// and the item, so a repeat is the same row.)
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TaskEndHandler, TaskEndOutcome } from "../agents/task-end.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { RovaraEmitter, RovaraEventBase, TaskVisibility } from "../team-record/sources/rovara.js";

/** How long a caller waits for the record before it goes on without it. */
export const RECORD_EMIT_BUDGET_MS = 1_500;

/** What an announcement says of the task. WHO may see its rows is not said here: the listener asks `task-visibility.ts` (the task's Plan 5 visibility) when it writes, so every emit point has the one answer. */
type Base = Omit<RovaraEventBase, "visibility">;
export type RovaraRecordEvent =
  | (Base & { kind: "remembered"; noteId: string; text: string; actorDeveloperId: string; origin?: "slack" })
  | (Base & { kind: "planOutcome"; planId: string; outcome: string; claims: number; claimsHeld: number })
  | (Base & { kind: "reviewOutcome"; publicationId: string; outcome: string; claims: number; claimsHeld: number })
  | (Base & { kind: "taskEnded"; outcome: "merged" | "closed" | "failed" | "cancelled" | "reverted"; rounds: number; sendBacks: number });
export type RovaraRecordListener = (event: RovaraRecordEvent) => Promise<void>;

const listeners: RovaraRecordListener[] = [];

/** Registers a listener. Returns the function that removes it. */
export function registerRovaraRecordListener(listener: RovaraRecordListener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** How many listeners hear the announcements (zero wherever the Team record is off). */
export const rovaraRecordListenerCount = (): number => listeners.length;

export type RecordEmitLog = (event: string, fields: { kind: string; reason: "threw" | "timeout" }) => void;
const consoleLog: RecordEmitLog = (event, fields) => console.log(JSON.stringify({ component: "broker", level: "warn", event, ...fields }));

/**
 * Builds the event (the builder may read) and tells every listener, within `budgetMs`. Never throws. With no listener the builder is not even called. A builder that answers `undefined` means
 * "nothing to record" (an unknown visibility, an end that teaches nothing).
 */
export async function announceRovaraEvent(kind: RovaraRecordEvent["kind"], build: () => RovaraRecordEvent | undefined | Promise<RovaraRecordEvent | undefined>, options: { budgetMs?: number; log?: RecordEmitLog } = {}): Promise<void> {
  if (listeners.length === 0) return;
  const log = options.log ?? consoleLog;
  const failed = (reason: "threw" | "timeout"): void => { try { log("record.emit_failed", { kind, reason }); } catch { /* a log line never fails the caller */ } };
  const work = (async (): Promise<void> => {
    let event: RovaraRecordEvent | undefined;
    try { event = await build(); } catch { failed("threw"); return; }
    if (event === undefined) return;
    for (const listener of [...listeners]) {
      try { await listener(event); } catch { failed("threw"); }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), options.budgetMs ?? RECORD_EMIT_BUDGET_MS); });
  try {
    if (await Promise.race([work.then(() => "done" as const), limit]) === "timeout") failed("timeout");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The task as an announcement names it: where it is. A `DeveloperTaskRecord` fits. A task with no org (from before orgs) has no Team record to write to. */
export interface RecordedTask { orgId?: string | undefined; project: string; taskId: string }

const baseOf = (task: RecordedTask, at: string): Base | undefined =>
  task.orgId === undefined ? undefined : { workspaceId: task.orgId, project: task.project, taskId: task.taskId, at };

/** A note was remembered (the first time only). `actorDeveloperId` is the author of the words: the row is theirs, so an erase of them takes it. */
export const announceRemembered = (task: RecordedTask, input: { noteId: string; text: string; actorDeveloperId: string; at: string; origin?: "slack" | undefined }, options?: { log?: RecordEmitLog }): Promise<void> =>
  announceRovaraEvent("remembered", () => {
    const base = baseOf(task, input.at);
    return base === undefined ? undefined : { ...base, kind: "remembered", noteId: input.noteId, text: input.text, actorDeveloperId: input.actorDeveloperId, ...(input.origin === undefined ? {} : { origin: input.origin }) };
  }, options);

export const announcePlanOutcome = (task: RecordedTask, input: { planId: string; outcome: string; claims: number; claimsHeld: number; at: string }, options?: { log?: RecordEmitLog }): Promise<void> =>
  announceRovaraEvent("planOutcome", () => {
    const base = baseOf(task, input.at);
    return base === undefined ? undefined : { ...base, kind: "planOutcome", planId: input.planId, outcome: input.outcome, claims: input.claims, claimsHeld: input.claimsHeld };
  }, options);

export const announceReviewOutcome = (task: RecordedTask, input: { publicationId: string; outcome: string; claims: number; claimsHeld: number; at: string }, options?: { log?: RecordEmitLog }): Promise<void> =>
  announceRovaraEvent("reviewOutcome", () => {
    const base = baseOf(task, input.at);
    return base === undefined ? undefined : { ...base, kind: "reviewOutcome", publicationId: input.publicationId, outcome: input.outcome, claims: input.claims, claimsHeld: input.claimsHeld };
  }, options);

/** Who may read a task's rows now: its Plan 5 visibility (`lessons/task-visibility.ts`). `undefined`: nothing can be recorded for it. */
export type TaskVisibilityReader = (orgId: string, taskId: string) => Promise<TaskVisibility | undefined>;

/** The listener that writes each announcement to the Team record through the Rovara emitter, with the task's visibility read when it writes. */
export function recordListenerOf(emitter: RovaraEmitter, visibilityOf: TaskVisibilityReader): RovaraRecordListener {
  return async (event) => {
    const visibility = await visibilityOf(event.workspaceId, event.taskId);
    if (visibility === undefined) return;
    switch (event.kind) {
      case "remembered": { const { kind: _kind, ...input } = event; return await emitter.remembered({ ...input, visibility }); } // eslint-disable-line @typescript-eslint/no-unused-vars
      case "planOutcome": { const { kind: _kind, ...input } = event; return await emitter.planOutcome({ ...input, visibility }); } // eslint-disable-line @typescript-eslint/no-unused-vars
      case "reviewOutcome": { const { kind: _kind, ...input } = event; return await emitter.reviewOutcome({ ...input, visibility }); } // eslint-disable-line @typescript-eslint/no-unused-vars
      case "taskEnded": { const { kind: _kind, ...input } = event; return await emitter.taskEnded({ ...input, visibility }); } // eslint-disable-line @typescript-eslint/no-unused-vars
    }
  };
}

/** The record's word for how a task ended; undefined for an end it does not keep (an agent step that succeeded, a question answered). */
export function recordOutcomeOf(outcome: TaskEndOutcome): Extract<RovaraRecordEvent, { kind: "taskEnded" }>["outcome"] | undefined {
  switch (outcome) {
    case "merged": case "closed": case "failed": case "cancelled": return outcome;
    case "creator_removed": return "cancelled";
    default: return undefined;
  }
}

const SEND_BACK_SOURCES: ReadonlySet<string> = new Set(["SEND_BACK", "FINDINGS", "AUTO_FIX"]);

/**
 * The handler for `registerTaskEndHandler`: the finished task becomes a `rovara.task` row. It reads the task as it is now (the end event names only the org and the task), refuses a task of another
 * org, counts the send-backs from the workflow's own decisions (a person's, one over review findings, and Rovara's own) and the rounds as the first round plus one per send-back. It never throws: a handler that threw would
 * make the end tell its handlers again.
 */
export function recordTaskEndHandler(): TaskEndHandler {
  return async (deps, event) => {
    const outcome = recordOutcomeOf(event.outcome);
    if (outcome === undefined) return;
    await announceRovaraEvent("taskEnded", async () => {
      const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(event.taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      const task = stored.Item;
      if (task === undefined || task.orgId !== event.orgId) return undefined;
      const base = baseOf(task, new Date(deps.now()).toISOString());
      if (base === undefined) return undefined;
      const sendBacks = (task.workflow?.decisions ?? []).filter((decision) => SEND_BACK_SOURCES.has(String(decision.source))).length;
      return { ...base, kind: "taskEnded", outcome, rounds: sendBacks + 1, sendBacks };
    }, deps.log === undefined ? {} : { log: (name, fields) => deps.log?.(name, fields) });
  };
}
