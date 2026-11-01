// Part of the broker: the lesson loader's one call at a coding stage's dispatch (learning v2, L4). `learnedContextForOperation` is what `taskOperationParts` spreads into the worker payload. It is
// the only place a lesson can enter a worker invocation, and it does nothing (returns `{}`) unless ALL of these hold: the install has lesson ports (`dependencies.lessons`, built only where the
// Team record is on), the operation is a stage of a Rovara Code task with an org, the project's learning mode allows loading (the loader's own check), and the task's owner can be told. It never
// throws and never waits long: any failure, or a load slower than the deadline, sends nothing and the stage runs as it would without memory.
//
// The worker gets the field only if it lists "task.learnedContext.v1": delivery (`ec2-delivery.ts`) removes it for an older worker, so an older worker is never refused and never sees a lesson.
import { LEARNED_CONTEXT_FEATURE, codeRepositoriesOf, type LearnedContext, type LessonStage, type ProjectDefinition } from "@agentx/contracts";
import { effectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { learnedContextForDispatch, type TaskAudience } from "../../lessons/load.js";
import type { LessonsRuntime } from "../../lessons/runtime.js";

/** The workflow modes that may carry lessons, and the lesson stage each is. Every other mode (checks, setup, spec writing, feedback review) carries none. */
const STAGES: Readonly<Record<string, LessonStage>> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", PLAN_CRITIQUE: "PLAN_CRITIQUE", REVIEW: "REVIEW" };
export const lessonStageOf = (mode: string | undefined): LessonStage | undefined => (mode === undefined ? undefined : Object.hasOwn(STAGES, mode) ? STAGES[mode] : undefined);

/** The longest a dispatch waits for the loader. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;

/** What the operation remembers about a load, so the worker's report is applied to that stage's manifest only. */
export interface LearnedLoadRef { taskId: string; project: string; stage: LessonStage; round: number }

export interface LessonsHost { lessons?: LessonsRuntime | undefined }

export async function learnedContextForOperation(
  host: LessonsHost,
  input: { orgId: string; task: DeveloperTaskRecord | undefined; workflowMode: string | undefined; legacyTask?: boolean | undefined; agentRun?: unknown; definition: Pick<ProjectDefinition, "repositories"> },
): Promise<{ learnedContext?: LearnedContext; load?: LearnedLoadRef }> {
  const lessons = host.lessons;
  const stage = lessonStageOf(input.workflowMode);
  const task = input.task;
  if (lessons === undefined || stage === undefined || task === undefined || input.legacyTask === true || input.agentRun !== undefined) return {};
  if (task.orgId === undefined || task.orgId !== input.orgId || task.purpose !== undefined) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let audience: TaskAudience;
    if (task.shared) audience = { kind: "shared" };
    else {
      // A private task reads what its owner may read; an owner that cannot be named reads nothing.
      const owner = effectiveTaskOwner(task);
      audience = { kind: "private", identity: await lessons.directory.identity(task.orgId, owner.developerId) };
    }
    const round = task.workflow?.revision ?? 0;
    const run = learnedContextForDispatch(lessons.load, {
      workspaceId: task.orgId, project: task.project, taskId: task.taskId, stage, round, intent: task.title,
      repos: codeRepositoriesOf(input.definition as ProjectDefinition).map((repository) => repository.name), files: [], languages: [], taskAudience: audience,
      // The delivery removes the field for a worker that does not list the feature; the loader is asked as for a worker that does.
    }, [LEARNED_CONTEXT_FEATURE]);
    const result = await Promise.race([run, new Promise<{ learnedContext?: LearnedContext }>((resolve) => { timer = setTimeout(() => resolve({}), LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
    return result.learnedContext === undefined ? {} : { learnedContext: result.learnedContext, load: { taskId: task.taskId, project: task.project, stage, round } };
  } catch {
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
