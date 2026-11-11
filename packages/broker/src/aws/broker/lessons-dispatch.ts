// Part of the broker: the lesson loader's one call at a coding stage's dispatch (learning v2, L4). `learnedContextForOperation` is what `taskOperationParts` spreads into the worker payload. It is
// the only place a lesson can enter a worker invocation, and it does nothing (returns `{}`) unless ALL of these hold: the install switch for lessons reaching an agent is on (`LEARNED_LESSONS_ENABLED`, apart from the Team record's), the install has lesson ports (`dependencies.lessons`, built only where the
// Team record is on), the operation is a stage of a Rovara Code task with an org, the project's learning mode allows loading (the loader's own check) (the running task's audience is checked live by the loader, decision 31). It never
// throws and never waits long: any failure, or a load slower than the deadline, sends nothing and the stage runs as it would without memory.
//
// What this returns is the lessons' IDS and VERSIONS (`learnedRefs`), never their text: the outbox row, the queue message, its dead-letter copy and a FAILED row carry only those, and the dispatcher builds the
// `learnedContext` from the lesson store at delivery (`lessons/deliver.ts`), so a lesson erased or retired after the stage was queued is never delivered and no text sits in a stored copy (WL-6). The worker gets the
// field only if it lists "task.learnedContext.v1": delivery removes it for an older worker, so an older worker is never refused and never sees a lesson.
import { LEARNED_CONTEXT_FEATURE, codeRepositoriesOf, learnedRefsOf, type LearnedRefs, type LessonStage, type ProjectDefinition } from "@rovara-code/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { learnedContextForDispatch, type TaskAudience } from "../../lessons/load.js";
import type { LessonsRuntime } from "../../lessons/runtime.js";
import { resolveAnySnapshot } from "../../lessons/replay-snapshot-store.js";
import type { Lesson } from "../../lessons/types.js";
import { learnedLessonsEnabled } from "../../lessons/switch.js";

/** The workflow modes that may carry lessons, and the lesson stage each is. Every other mode (checks, setup, spec writing, feedback review) carries none. */
const STAGES: Readonly<Record<string, LessonStage>> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", PLAN_CRITIQUE: "PLAN_CRITIQUE", REVIEW: "REVIEW" };
export const lessonStageOf = (mode: string | undefined): LessonStage | undefined => (mode === undefined ? undefined : Object.hasOwn(STAGES, mode) ? STAGES[mode] : undefined);

/** The longest a dispatch waits for the loader. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;

/** What the operation remembers about a load, so the worker's report is applied to that stage's manifest only. */
export interface LearnedLoadRef { taskId: string; project: string; stage: LessonStage; round: number }

/** The title and the start of the request: what the task is for. */
const INTENT_REQUEST_CHARS = 600;
export const intentOf = (task: Pick<DeveloperTaskRecord, "title"> & { requestText?: string | undefined }): string =>
  [task.title, (task.requestText ?? "").slice(0, INTENT_REQUEST_CHARS)].filter((part) => part.trim() !== "").join("\n");

export interface LessonsHost { lessons?: LessonsRuntime | undefined }

export async function learnedContextForOperation(
  host: LessonsHost,
  input: { orgId: string; task: DeveloperTaskRecord | undefined; workflowMode: string | undefined; legacyTask?: boolean | undefined; agentRun?: unknown; definition: Pick<ProjectDefinition, "repositories"> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ learnedRefs?: LearnedRefs; load?: LearnedLoadRef }> {
  // Lane 7: a replay copy has its memory set at creation, and it is the only task whose lessons are not decided by the live set or the install switch: "off" loads nothing; a snapshot loads exactly that snapshot's
  // lessons (the harness names the explicit delivery in its plan, decision 47). Any other value on the mark is a task we cannot place: nothing is loaded (fail closed).
  const copy = input.task?.evalRun === undefined && input.task?.evalMemory === undefined ? undefined : input.task;
  if (copy !== undefined && (copy.evalRun !== true || copy.evalMemory?.mode !== "snapshot")) return {};
  // The install switch for lessons reaching an agent (lessons/switch.ts), apart from the Team record's: off, nothing is loaded, recorded or sent.
  if (copy === undefined && !learnedLessonsEnabled(env)) return {};
  const lessons = host.lessons;
  const stage = lessonStageOf(input.workflowMode);
  const task = input.task;
  if (lessons === undefined || stage === undefined || task === undefined || input.legacyTask === true || input.agentRun !== undefined) return {};
  if (task.orgId === undefined || task.orgId !== input.orgId || task.purpose !== undefined) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Decision 31: who reads what this stage produces is the people who can open the RUNNING task's session (its project's members minus anyone its People list denies, or the narrower list), read live by the loader
    // (`readVisible` with `running`). A lesson loads only if all of them can see every task it was learned from. No reader is named here: the loader's audience is "nobody in particular" for restricted
    // places, and a task whose audience can't be read loads NO lesson that names a task (there is no weaker rule to fall back to).
    const audience: TaskAudience = { kind: "shared" };
    const round = task.workflow?.revision ?? 0;
    // What the task is about, not only its title: the request, and from the plan on the plan's summary and the files it names (so path scopes filter). A plan that cannot be read adds nothing; the load goes on.
    const run = (async () => {
      // The snapshot's lessons, at its versions, from the lesson store's history; a snapshot that cannot be read or is another project's loads nothing.
      let memory: { mode: "snapshot"; snapshotId: string; lessons: readonly Lesson[] } | undefined;
      if (copy?.evalMemory?.mode === "snapshot") {
        const key = { workspaceId: task.orgId!, project: task.project };
        const snapshot = await resolveAnySnapshot({ snapshots: lessons.snapshots, evalSnapshots: lessons.evalSnapshots, store: lessons.store }, key, copy.evalMemory.snapshotId);
        if (snapshot === undefined) return {};
        memory = { mode: "snapshot", snapshotId: copy.evalMemory.snapshotId, lessons: snapshot.lessons };
      }
      const plan = await lessons.planFacts?.(task).catch(() => undefined);
      return learnedContextForDispatch(lessons.load, {
        workspaceId: task.orgId!, project: task.project, taskId: task.taskId, stage, round, intent: intentOf(task),
        ...(plan === undefined || plan.summary === "" ? {} : { planSummary: plan.summary }),
        repos: codeRepositoriesOf(input.definition as ProjectDefinition).map((repository) => repository.name), files: plan?.files ?? [], languages: [], taskAudience: audience,
        ...(memory === undefined ? {} : { memory }),
        // The delivery removes the field for a worker that does not list the feature; the loader is asked as for a worker that does.
      }, [LEARNED_CONTEXT_FEATURE]);
    })();
    const result = await Promise.race([run, new Promise<Awaited<typeof run>>((resolve) => { timer = setTimeout(() => resolve({}), LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
    if (result.learnedContext === undefined) return {};
    // The file arm (lane 7): the lessons are placed as `.rovara/lessons.md` in the copy's checkout of its first code repository, not sent as a prompt block (delivery builds the file from the snapshot).
    const fileRepository = copy?.evalLessonsFile === true ? codeRepositoriesOf(input.definition as ProjectDefinition)[0]?.name : undefined;
    if (copy?.evalLessonsFile === true && fileRepository === undefined) return {};
    const fileArm = fileRepository === undefined ? {} : { file: { repository: fileRepository } };
    const refs = learnedRefsOf(result.learnedContext, { orgId: task.orgId, project: task.project, audience: { kind: "shared" }, taskId: task.taskId, ...(copy?.evalMemory?.mode === "snapshot" ? { snapshotId: copy.evalMemory.snapshotId } : {}), ...fileArm });
    return { learnedRefs: refs, load: { taskId: task.taskId, project: task.project, stage, round } };
  } catch {
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
