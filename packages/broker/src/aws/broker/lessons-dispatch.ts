// Part of the broker: the lesson loader's one call at a coding stage's dispatch (learning v2, L4). `learnedContextForOperation` is what `taskOperationParts` spreads into the worker payload. It is
// the only place a lesson can enter a worker invocation, and it does nothing (returns `{}`) unless ALL of these hold: the install switch for lessons reaching an agent is on (`LEARNED_LESSONS_ENABLED`, apart from the Team record's), the install has lesson ports (`dependencies.lessons`, built only where the
// Team record is on), the operation is a stage of a Rovara Code task with an org, the project's learning mode allows loading (the loader's own check), and the running task's reader can be named (its live Plan 5 visibility, `readerOfRunningTask`). It never
// throws and never waits long: any failure, or a load slower than the deadline, sends nothing and the stage runs as it would without memory.
//
// What this returns is the lessons' IDS and VERSIONS (`learnedRefs`), never their text: the outbox row, the queue message, its dead-letter copy and a FAILED row carry only those, and the dispatcher builds the
// `learnedContext` from the lesson store at delivery (`lessons/deliver.ts`), so a lesson erased or retired after the stage was queued is never delivered and no text sits in a stored copy (WL-6). The worker gets the
// field only if it lists "task.learnedContext.v1": delivery removes it for an older worker, so an older worker is never refused and never sees a lesson.
import { LEARNED_CONTEXT_FEATURE, codeRepositoriesOf, learnedRefsOf, type LearnedRefs, type LessonStage, type ProjectDefinition } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { readerOfRunningTask } from "../../lessons/live-visibility.js";
import { learnedContextForDispatch, type TaskAudience } from "../../lessons/load.js";
import type { LessonsRuntime } from "../../lessons/runtime.js";
import { learnedLessonsEnabled } from "../../lessons/switch.js";

/** The workflow modes that may carry lessons, and the lesson stage each is. Every other mode (checks, setup, spec writing, feedback review) carries none. */
const STAGES: Readonly<Record<string, LessonStage>> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", PLAN_CRITIQUE: "PLAN_CRITIQUE", REVIEW: "REVIEW" };
export const lessonStageOf = (mode: string | undefined): LessonStage | undefined => (mode === undefined ? undefined : Object.hasOwn(STAGES, mode) ? STAGES[mode] : undefined);

/** The longest a dispatch waits for the loader. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;
/** The longest the running task's own visibility read may take (it is part of the deadline above). */
const READER_TIMEOUT_MS = 800;

/** What the operation remembers about a load, so the worker's report is applied to that stage's manifest only. */
export interface LearnedLoadRef { taskId: string; project: string; stage: LessonStage; round: number }

export interface LessonsHost { lessons?: LessonsRuntime | undefined }

export async function learnedContextForOperation(
  host: LessonsHost,
  input: { orgId: string; task: DeveloperTaskRecord | undefined; workflowMode: string | undefined; legacyTask?: boolean | undefined; agentRun?: unknown; definition: Pick<ProjectDefinition, "repositories"> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ learnedRefs?: LearnedRefs; load?: LearnedLoadRef }> {
  // The install switch for lessons reaching an agent (lessons/switch.ts), apart from the Team record's: off, nothing is loaded, recorded or sent.
  if (!learnedLessonsEnabled(env)) return {};
  const lessons = host.lessons;
  const stage = lessonStageOf(input.workflowMode);
  const task = input.task;
  if (lessons === undefined || stage === undefined || task === undefined || input.legacyTask === true || input.agentRun !== undefined) return {};
  if (task.orgId === undefined || task.orgId !== input.orgId || task.purpose !== undefined) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // LV-1 H1: who reads what this stage produces is the running task's LIVE Plan 5 visibility (the same strict port as every other lesson read), not `task.shared` (the Slack-thread flag) and not the owner by
    // default. An owner-only task reads as its owner; a project-wide task, a task shared with a list and a task whose visibility cannot be read read as nobody in particular (only lessons whose every source
    // task is project-wide load).
    const reader = await readerOfRunningTask({ port: lessons.access.taskVisibility, orgId: task.orgId, taskId: task.taskId, where: "dispatch", log: lessons.load.log, timeoutMs: READER_TIMEOUT_MS });
    const audience: TaskAudience = reader.kind === "owner" ? { kind: "private", identity: await lessons.directory.identity(task.orgId, reader.developerId) } : { kind: "shared" };
    const round = task.workflow?.revision ?? 0;
    const run = learnedContextForDispatch(lessons.load, {
      workspaceId: task.orgId, project: task.project, taskId: task.taskId, stage, round, intent: task.title,
      repos: codeRepositoriesOf(input.definition as ProjectDefinition).map((repository) => repository.name), files: [], languages: [], taskAudience: audience,
      // The delivery removes the field for a worker that does not list the feature; the loader is asked as for a worker that does.
    }, [LEARNED_CONTEXT_FEATURE]);
    const result = await Promise.race([run, new Promise<Awaited<typeof run>>((resolve) => { timer = setTimeout(() => resolve({}), LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
    if (result.learnedContext === undefined) return {};
    const refs = learnedRefsOf(result.learnedContext, { orgId: task.orgId, project: task.project, audience: reader.kind === "owner" ? { kind: "private", developerId: reader.developerId } : { kind: "shared" }, taskId: task.taskId });
    return { learnedRefs: refs, load: { taskId: task.taskId, project: task.project, stage, round } };
  } catch {
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
