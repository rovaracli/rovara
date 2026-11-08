// LV-1 (SRL-4 review finding F1): a lesson learned from a task keeps the audience the task had when it was reflected, and nothing in a project-wide lesson names the task except
// `provenance.supportTasks` and the Rovara source events (`rovara:task:<id>...`, or the source id `task:<id>...`). If the task is narrowed afterwards (Plan 5 visibility), the lesson, which was
// written from the task's send-back reasons and notes, would still reach every agent and every screen of the project. So a lesson is also checked against the LIVE visibility of every task
// it was learned from, each time it is read.
//
// One rule, one module: `liveVisible` keeps a lesson only if EVERY source task is still visible to the reader (a shared or project-wide reader needs every task project-wide; a person needs to be
// allowed on every task: `mayReadTask`). The tasks of the lessons are read in batched calls (`TaskVisibilityPort.read`, the strict State-table port of SRL-4) by ONE reader per request (`createLessonLiveReader`: no task is read twice, the bound counts only the lessons checked).
// WHO the reader is, for an agent, is `readerOfRunningTask`: the running task's own live visibility (an owner-only task reads as its owner; anything else as nobody in particular). Fail closed: no port, a read that
// fails or times out, a task that is gone, another company's, past the per-request bound or unreadable, a task id that is malformed: the lesson is withheld. Logs carry counts and fixed codes, never ids.
//
// `readVisible` (read-visible.ts) calls it, and every lesson read already goes through `readVisible` (tests/unit/lessons/read-paths.test.ts). A new path that hands a lesson to a person or to an
// agent WITHOUT `readVisible` (the PR "Lessons used" list, publishing a lesson to a repository) must call `liveVisible` with the viewer of that path (`undefined` for something everyone in the
// project will read) and use only what it returns.
import { OrgIdSchema } from "@agentx/contracts";
import { createLiveAudienceReader, type TaskVisibilityPort } from "../team-record/live-audience.js";
import type { ReadAudience } from "../team-record/types.js";
import type { LessonLog } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { lessonPlaces, type IdentitySet, type Lesson } from "./types.js";

/** The most distinct source tasks one call looks up. A lesson learned from a task past it is withheld. */
export const LESSON_LIVE_TASKS_MAX = 300;
/** How long the one batched lookup may take before every lesson that names a task is withheld. */
export const LESSON_LIVE_TIMEOUT_MS = 8_000;

// The shape of a task id (the same as `live-audience.ts`): anything else cannot be asked about, so a lesson that names one is withheld.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const EVENT_TASK = /^(?:rovara:)?task:([^:]*)/;
const TASK_PLACE = /^rovara:task\/([^/]*)/;

export interface LessonTaskRefs {
  taskIds: string[];
  /** The lesson names a task that cannot be read from it (a malformed id): it is withheld. */
  unreadable: boolean;
}

/** Every task a lesson was learned from: `supportTasks`, the tasks behind lessons loaded into its task (`inheritedTasks`), task citations, the Rovara events it cites (`sourceEvents`, record citations) and any `rovara:task/<id>` place. Pure. */
export function lessonTaskRefs(lesson: Pick<Lesson, "provenance" | "citations">): LessonTaskRefs {
  const ids = new Set<string>();
  let unreadable = false;
  const take = (id: string | undefined): void => {
    if (id !== undefined && TASK_ID.test(id)) ids.add(id);
    else unreadable = true;
  };
  for (const id of lesson.provenance.supportTasks) take(id);
  for (const id of lesson.provenance.inheritedTasks ?? []) take(id);
  for (const citation of lesson.citations) {
    if (citation.kind === "task") take(citation.taskId);
  }
  const events = [...lesson.provenance.sourceEvents, ...lesson.citations.flatMap((citation) => (citation.kind === "record" ? [citation.eventId] : []))];
  for (const event of events) {
    const match = EVENT_TASK.exec(event);
    if (match !== null) take(match[1]);
  }
  for (const place of lessonPlaces(lesson).scopes) {
    const match = TASK_PLACE.exec(place);
    if (match !== null) take(match[1]);
  }
  return { taskIds: [...ids], unreadable };
}

/** Whose view: a person with a known developer id reads what that person may read; nobody in particular (a shared task, or a person whose id is not known) reads only what is project-wide. */
function audienceOf(orgId: ReturnType<typeof OrgIdSchema.parse>, viewer: Pick<IdentitySet, "developerId"> | undefined): ReadAudience {
  const developerId = viewer?.developerId;
  if (developerId === undefined || developerId === "") return { kind: "shared", orgId };
  return { kind: "caller", caller: { orgId, developerId, projectRole: undefined, identities: { ids: {}, groups: {} } } };
}

/** A reader of many calls in one request: the tasks it has looked up are remembered, so the same task is never read twice and the bound counts the tasks of lessons actually checked. */
export interface LessonLiveReader {
  /** The lessons of `lessons` whose source tasks are all still visible to `viewer` now, in their order. Never throws. */
  keep(viewer: Pick<IdentitySet, "developerId"> | undefined, lessons: readonly Lesson[]): Promise<Lesson[]>;
}

export interface LessonLiveReaderInput { port: TaskVisibilityPort | undefined; key: ScopeKey; where: string; log?: LessonLog | undefined; /** Tests and the loader's own deadline (a function gives the time left for each lookup). */ timeoutMs?: number | (() => number) | undefined; maxTasks?: number | undefined }

/**
 * One reader per request (LV-1 M1). Lessons that name no task pass untouched (and no read is made when none names one). Anything that cannot be read withholds the lessons it affects. `where` names the
 * caller in the log line.
 */
export function createLessonLiveReader(input: LessonLiveReaderInput): LessonLiveReader {
  const org = OrgIdSchema.safeParse(input.key.workspaceId);
  const reader = org.success && input.port !== undefined
    ? createLiveAudienceReader(org.data, input.port, {
      timeoutMs: input.timeoutMs ?? LESSON_LIVE_TIMEOUT_MS, maxTasks: input.maxTasks ?? LESSON_LIVE_TASKS_MAX,
      log: (event, fields) => { input.log?.(`learning.${input.where}_${event.replace(/\./gu, "_")}`, fields); },
    })
    : undefined;
  const withheld = (count: number, reason: string): void => { input.log?.(`learning.${input.where}_live_withheld`, { lessons: count, reason }); };
  return {
    async keep(viewer, lessons) {
      const refs = lessons.map((lesson) => lessonTaskRefs(lesson));
      const names = (index: number): boolean => refs[index]!.taskIds.length > 0 || refs[index]!.unreadable;
      const named = lessons.filter((_, index) => names(index));
      if (named.length === 0) return [...lessons];
      if (!org.success || reader === undefined) {
        withheld(named.length, org.success ? "no_port" : "bad_org");
        return lessons.filter((_, index) => !names(index));
      }
      await reader.load(refs.flatMap((ref) => ref.taskIds));
      const audience = audienceOf(org.data, viewer);
      let count = 0;
      const kept = lessons.filter((_, index) => {
        if (!names(index)) return true;
        const ref = refs[index]!;
        if (!ref.unreadable && reader.verdictOf(audience, ref.taskIds) === "allow") return true;
        count += 1;
        return false;
      });
      if (count > 0) withheld(count, "task_not_visible");
      return kept;
    },
  };
}

/**
 * The lessons of `lessons` whose source tasks are all still visible to `viewer` now, in their order (one call of a fresh reader). Never throws: anything that cannot be read withholds the lessons it
 * affects. `where` names the caller in the log line.
 */
export async function liveVisible(input: LessonLiveReaderInput & { viewer: Pick<IdentitySet, "developerId"> | undefined; lessons: readonly Lesson[] }): Promise<Lesson[]> {
  return createLessonLiveReader(input).keep(input.viewer, input.lessons);
}

/** Who a running task's lessons are read as. */
export type RunningTaskReader = { kind: "owner"; developerId: string } | { kind: "nobody" };

/**
 * LV-1 H1: the reader of what an agent is given (and of the plan, code, pull request and review notes it writes) is whoever may read the RUNNING task's output, taken from the task's LIVE Plan 5
 * visibility through the same strict port, never from `task.shared` (the Slack-thread flag) and never from the owner by default:
 *   - an owner-only task reads as its owner (their lessons, their restricted places);
 *   - a project-wide task, a task shared with a list, and a task whose visibility cannot be read (a missing port, a failed or timed-out read, a task that is gone or another company's) read as NOBODY IN
 *     PARTICULAR: only lessons whose every source task is project-wide reach it. (A list could be checked person by person; the narrower rule is simpler and never wider than the truth.)
 * Never throws. A timeout aborts the read.
 */
export async function readerOfRunningTask(input: { port: TaskVisibilityPort | undefined; orgId: string; taskId: string; where: string; log?: LessonLog | undefined; timeoutMs?: number | undefined }): Promise<RunningTaskReader> {
  const nobody = (reason: string): RunningTaskReader => { input.log?.(`learning.${input.where}_reader_nobody`, { reason }); return { kind: "nobody" }; };
  const org = OrgIdSchema.safeParse(input.orgId);
  if (!org.success || input.port === undefined || !TASK_ID.test(input.taskId)) return nobody("unreadable");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("timed out")); }, input.timeoutMs ?? LESSON_LIVE_TIMEOUT_MS); });
    const work = input.port.read(org.data, [input.taskId], { signal: abort.signal });
    work.catch(() => undefined);
    const visibility = (await Promise.race([work, timeout])).get(input.taskId);
    if (visibility === undefined) return nobody("missing");
    if (visibility.kind === "private") return visibility.ownerDeveloperId === "" ? nobody("unreadable") : { kind: "owner", developerId: visibility.ownerDeveloperId };
    return { kind: "nobody" };
  } catch {
    return nobody("error");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
