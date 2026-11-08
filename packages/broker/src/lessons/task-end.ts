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
import { currentLearningAttempt } from "./learning-deadline.js";
import { processDraft, type ProcessDeps } from "./process.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";
import type { RovaraEmitter } from "../team-record/sources/rovara.js";
import type { ReflectQueue } from "./reflect-queue.js";
import type { OutcomeRowReader } from "./task-outcome-rows.js";
import { lessonTaskRefs } from "./live-visibility.js";
import type { LessonStore, ScopeKey } from "./store.js";
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
  /** The checks a human-edit read makes on its authors now (the same readers the subject source uses). Absent: human edits are not learned from. */
  humanEdit?: { standing: (orgId: string, developerId: string, project: string) => Promise<"member" | "outsider">; isErased: (orgId: string, developerId: string, project: string) => Promise<boolean> };
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

/**
 * LV-1 M2 / R3: the tasks behind every lesson that was loaded INTO the task. A lesson learned from the task's plan may restate them, so it is also gated on them. Each load record names, per lesson, the tasks it was learned
 * from AS THEY WERE AT LOAD TIME (`taskIds`), so an edit, scrub or purge of the lesson afterwards takes nothing away; the lesson's CURRENT tasks are added too (an older record without `taskIds` has only these). Throws
 * when a record cannot be read or a lesson names a task that cannot be read (the task is then not reflected: fail closed). A lesson that is gone adds only what its record kept.
 */
export async function inheritedTasksOf(store: Pick<LessonStore, "manifests" | "get">, key: ScopeKey, taskId: string): Promise<string[]> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const manifest of await store.manifests(key, taskId)) {
    for (const entry of manifest.lessons) {
      for (const id of entry.taskIds ?? []) if (id !== taskId) out.add(id);
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const lesson = await store.get(key, entry.id);
      if (lesson === undefined) continue;
      const refs = lessonTaskRefs(lesson);
      if (refs.unreadable) throw new Error("lessons: a loaded lesson names a task that can't be read");
      for (const id of refs.taskIds) if (id !== taskId) out.add(id);
    }
  }
  return [...out];
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
  const inheritedTasks = await inheritedTasksOf(deps.process.store, { workspaceId, project: facts.project }, facts.taskId);
  return { ...buildTaskReflectSubject({ ...facts, sendBacks, ...(revert === undefined ? {} : { revert }) }), ...(inheritedTasks.length === 0 ? {} : { inheritedTasks }) };
}

/** The subject of one task (also for the nightly work source, which re-reflects a task whose change was later reverted: pass `outcome: "reverted"`). Undefined when there are no facts. */
export async function subjectForTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<ReflectSubject | undefined> {
  const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
  return base === undefined ? undefined : subjectFrom(deps, base, input.workspaceId, input.outcome);
}

export type LearnStatus = "off" | "no_facts" | "not_reflected" | "reflected";
/**
 * H1: what a reflection came to, typed. `retry` is true only for a fault that is known to have spent nothing at the moment it happened and may pass: a read of the task, the project's settings or the record failed, the
 * model path failed in a way it marked retryable (a table fault before the call, a refusal by the deadline, a call the in-VPC client refused before sending), or the spend look failed. The worker retries those, and only after it
 * has checked the ledger for the keys the attempt minted (`reflect-claims.ts`). Everything else is final: a reflection that was made (or cut at the deadline after its model answered), a refusal that trying again will not
 * change (no provider, no budget, the month's limit), a model answer that did not parse, a task that teaches nothing.
 */
export interface LearnResult { status: LearnStatus; retry: boolean }

const final = (status: LearnStatus): LearnResult => ({ status, retry: false });

/** Reflects on one finished task. Never throws. */
export async function learnFromEndedTaskTyped(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<LearnResult> {
  const faultBefore = currentLearningAttempt();
  if (faultBefore !== undefined) delete faultBefore.fault;
  try {
    // L4: the switch comes first, from the task's project alone. A project whose learning is Off or Collect never has its plan text, standing or erasure state read.
    if (deps.source.projectOf !== undefined) {
      const project = await deps.source.projectOf({ workspaceId: input.workspaceId, taskId: input.taskId });
      if (project === undefined) return final("no_facts");
      if (!modeAllows((await resolveLearning(deps.settings, input.workspaceId, project)).mode, "reflect")) return final("off");
    }
    const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
    if (base === undefined || base.facts.workspaceId !== input.workspaceId) return final("no_facts");
    // The switch again on the project the facts name (the only check for a source that cannot name the project alone; for the others it only repeats the same answer).
    const learning = await resolveLearning(deps.settings, input.workspaceId, base.facts.project);
    if (!modeAllows(learning.mode, "reflect")) return final("off");
    const subject = await subjectFrom(deps, base, input.workspaceId, input.outcome);
    if (subject === undefined) return final("no_facts");
    const result = await reflectSubject(deps.reflect, subject);
    if (result.status !== "ok") {
      // Lane 1b: "learning_paused" is a refusal (no provider, every model forbidden, a price or budget that cannot fit, the month's limit): the reason is already recorded as the project's pause, and trying again changes
      // nothing, so it ends the reflection (final) whatever fault state an earlier step left. A spend look that could not read the counter is "spend_refused" with a retryable fault (nothing was held or sent).
      if (result.reason === "learning_paused") return final("not_reflected");
      // The reflector turns a failed model call or spend look into a fixed reason; the model path says whether that failure was worth another try.
      const retryable = (result.reason === "model_error" || result.reason === "spend_refused") && currentLearningAttempt()?.fault === "retryable";
      return { status: "not_reflected", retry: retryable };
    }
    const key = { workspaceId: input.workspaceId, project: base.facts.project };
    const signal = currentLearningAttempt()?.signal;
    for (const draft of result.drafts) {
      // M4: at the deadline no new draft is started (the store's writes are refused too, `deadline-guard.ts`). The model has been paid for; what is cut is lost, not repeated.
      if (signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", { taskId: input.taskId }); break; }
      try { await processDraft(deps.process, key, draft); } catch { deps.log?.("learning.draft_failed", { taskId: input.taskId }); }
    }
    return final("reflected");
  } catch {
    deps.log?.("learning.task_end_failed", { taskId: input.taskId });
    // Outside a worker nothing is retried. Inside one, a fault here is a read that failed, before any model key was minted by this call (or one the model path marked itself).
    return { status: "not_reflected", retry: currentLearningAttempt() !== undefined && currentLearningAttempt()?.fault !== "final" };
  }
}

/** Reflects on one finished task. Never throws. */
export async function learnFromEndedTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<LearnStatus> {
  return (await learnFromEndedTaskTyped(deps, input)).status;
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
