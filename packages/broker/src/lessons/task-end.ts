// Learning v2 wiring (WA-2): the terminal-task hook. When a task ends (`agents/task-end.ts`, the one place every end goes through), and only when the project's learning mode allows
// reflection, the finished task becomes a reflector subject built from the REAL sources of who did what (`task-subject.ts`): the task record says who started it, the Team record's
// rows say who sent it back and who reverted it. The subject goes to the reflector, and each draft to the curate-and-settle pipeline (`processDraft`).
//
//  - Behind the switch: the project's learning mode is read first (`resolveLearning`, which fails closed to Off); Off and Collect reflect nothing and read nothing more.
//  - Absent unless wired: the handler exists only where the broker was given `learning` dependencies (the model, store, vectors, spend, directory and the task-side facts). Where it
//    was not, nothing is registered and the end of a task is exactly what it was.
//  - Never in the way: the hook never throws and never delays an end beyond its own awaited work; a failure is a fixed log line and the task has ended all the same.
//  - The task-side facts come from a `TaskSubjectSource` (intent, plan and review spans, trusts, links, the commits, the start fields). Where it gives nothing the hook does nothing.
import { randomUUID } from "node:crypto";
import { registerTaskEndHandler, type TaskEndHandler, type TaskEndOutcome } from "../agents/task-end.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { processDraft, type ProcessDeps } from "./process.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";
import type { RovaraEmitter } from "../team-record/sources/rovara.js";
import type { ReflectQueue } from "./reflect-queue.js";
import type { OutcomeRowReader } from "./task-outcome-rows.js";
import { buildTaskReflectSubject, type SendBackFact, type TaskSubjectFacts } from "./task-subject.js";

/** What the task record side knows: the subject's facts without the parts that live in the Team record, and the requests of the task's human send-backs. */
export interface TaskSubjectBase {
  facts: Omit<TaskSubjectFacts, "sendBacks" | "revert">;
  /** The request ids of the task's human send-backs (the task's own decision history); each one's row is read for who and what. */
  sendBackRequestIds: readonly string[];
}
export interface TaskSubjectSource {
  read(input: { workspaceId: string; taskId: string }): Promise<TaskSubjectBase | undefined>;
  /**
   * L4: the task's project from the task record alone (one read), so the learning mode can be checked BEFORE `read` fetches plans, standing and erasure state. Undefined: no such task in the workspace, or one that
   * teaches nothing. A source without it is read first (the old order); the production source has it.
   */
  projectOf?(input: { workspaceId: string; taskId: string }): Promise<string | undefined>;
}

export interface TaskLearningDeps {
  source: TaskSubjectSource;
  rows: OutcomeRowReader;
  settings: LearningSettingsReader;
  reflect: ReflectDeps;
  process: ProcessDeps;
  /** Writes the human send-backs of tasks to the Team record, naming who sent them back. Without it send-backs are not recorded here (and so never counted). */
  rovara?: Pick<RovaraEmitter, "sendBack">;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

const MAX_SEND_BACKS = 50;

/** The reflector's outcome word for how a task ended; undefined for an end that teaches nothing (an agent step that succeeded, a question answered). */
export function reflectOutcomeOf(outcome: TaskEndOutcome): ReflectSubject["outcome"] | undefined {
  switch (outcome) {
    case "merged": return "merged";
    case "closed": return "closed";
    case "failed": case "cancelled": case "creator_removed": return "abandoned";
    default: return undefined;
  }
}

/** Builds the subject from the task-side facts and the record's rows. The workspace is the caller's, never the source's claim. */
async function subjectFrom(deps: TaskLearningDeps, base: TaskSubjectBase, workspaceId: string, outcome: ReflectSubject["outcome"] | undefined): Promise<ReflectSubject | undefined> {
  if (base.facts.workspaceId !== workspaceId) return undefined;
  const facts = { ...base.facts, ...(outcome === undefined ? {} : { outcome }) };
  const where = { workspaceId, project: facts.project, taskId: facts.taskId };
  const sendBacks: SendBackFact[] = [];
  for (const requestId of base.sendBackRequestIds.slice(0, MAX_SEND_BACKS)) {
    const fact = await deps.rows.sendBack({ ...where, requestId });
    if (fact !== undefined) sendBacks.push(fact);
  }
  const revert = facts.outcome === "reverted" ? await deps.rows.revertedBy(where) : undefined;
  return buildTaskReflectSubject({ ...facts, sendBacks, ...(revert === undefined ? {} : { revert }) });
}

/** The subject of one task (also for the nightly work source, which re-reflects a task whose change was later reverted: pass `outcome: "reverted"`). Undefined when there are no facts. */
export async function subjectForTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<ReflectSubject | undefined> {
  const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
  return base === undefined ? undefined : subjectFrom(deps, base, input.workspaceId, input.outcome);
}

export type LearnStatus = "off" | "no_facts" | "not_reflected" | "reflected";

/** Reflects on one finished task. Never throws. */
export async function learnFromEndedTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<LearnStatus> {
  try {
    // L4: the switch comes first, from the task's project alone. A project whose learning is Off or Collect never has its plan text, standing or erasure state read.
    if (deps.source.projectOf !== undefined) {
      const project = await deps.source.projectOf({ workspaceId: input.workspaceId, taskId: input.taskId });
      if (project === undefined) return "no_facts";
      if (!modeAllows((await resolveLearning(deps.settings, input.workspaceId, project)).mode, "reflect")) return "off";
    }
    const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
    if (base === undefined || base.facts.workspaceId !== input.workspaceId) return "no_facts";
    // The switch again on the project the facts name (the only check for a source that cannot name the project alone; for the others it only repeats the same answer).
    const learning = await resolveLearning(deps.settings, input.workspaceId, base.facts.project);
    if (!modeAllows(learning.mode, "reflect")) return "off";
    const subject = await subjectFrom(deps, base, input.workspaceId, input.outcome);
    if (subject === undefined) return "no_facts";
    const result = await reflectSubject(deps.reflect, subject);
    if (result.status !== "ok") return "not_reflected";
    const key = { workspaceId: input.workspaceId, project: base.facts.project };
    for (const draft of result.drafts) {
      try { await processDraft(deps.process, key, draft); } catch { deps.log?.("learning.draft_failed", { taskId: input.taskId }); }
    }
    return "reflected";
  } catch {
    deps.log?.("learning.task_end_failed", { taskId: input.taskId });
    return "not_reflected";
  }
}

/**
 * WB-4 (lessons in production, lane 2): the end of a task never runs the reflector. The handler sends ONE message of ids only (`{ orgId, taskId, outcome, requestId }`) to the LessonsReflect queue and returns; a
 * worker (`reflect-worker.ts`, its own Lambda) runs `learnFromEndedTask` under its own time and spend limits. A queue that did not take the message is one fixed log line: the task has ended all the same and is never
 * held up (the nightly re-reflection and the next task's own end are the only other chances to learn from it; a lost message is a lost reflection, never a lost task).
 */
export interface TaskEndEnqueue {
  queue: ReflectQueue;
  newRequestId?: () => string;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The handler for `registerTaskEndHandler`. It reads the queue when a task ends, so a later broker's queue is the one it uses; none means it does nothing. */
export function learningTaskEndHandler(get: () => TaskEndEnqueue | undefined): TaskEndHandler {
  return async (_endDeps, event) => {
    const target = get();
    const outcome = reflectOutcomeOf(event.outcome);
    if (target === undefined || outcome === undefined) return;
    try {
      await target.queue.send({ orgId: event.orgId, taskId: event.taskId, outcome, requestId: (target.newRequestId ?? randomUUID)() });
    } catch {
      // One fixed line (never the error's text): the end goes on.
      (target.log ?? ((name, fields) => console.log(JSON.stringify({ component: "lessons", event: name, ...fields }))))("learning.enqueue_failed", { taskId: event.taskId });
    }
  };
}

/** Registers the hook once at broker start. Returns the function that takes it off again. */
export function registerLearningTaskEnd(get: () => TaskEndEnqueue | undefined): () => void {
  return registerTaskEndHandler(learningTaskEndHandler(get));
}
