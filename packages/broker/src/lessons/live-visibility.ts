// LV-1 (SRL-4 review finding F1): a lesson learned from a task keeps the audience the task had when it was reflected, and nothing in a project-wide lesson names the task except
// `provenance.supportTasks` and the Rovara source events (`rovara:task:<id>...`, or the source id `task:<id>...`). If the task is narrowed afterwards (Plan 5 visibility), the lesson, which was
// written from the task's send-back reasons and notes, would still reach every agent and every screen of the project. So a lesson is also checked against the LIVE visibility of every task
// it was learned from, each time it is read.
//
// One rule, one module: `liveVisible` keeps a lesson only if EVERY source task is still visible to the reader (a shared or project-wide reader needs every task project-wide; a person needs to be
// allowed on every task: `mayReadTask`). The tasks of the lessons are read in batched calls (`TaskVisibilityPort.read`, the strict State-table port of SRL-4) by ONE reader per request (`createLessonLiveReader`: no task is read twice, the bound counts only the lessons checked).
// WHO the reader is, for an agent (owner decision 31): the audience of the RUNNING task, as a set (`task-audience.ts`: who can actually open its session). A lesson reaches the running task T only if
// EVERY person who can see T can see EVERY source task P of the lesson (audience(T) is a subset of audience(P)). A running task whose audience cannot be read (no port, a failed or timed-out read, gone, another
// company's), or no running task at all, reads as nobody in particular: only lessons whose source tasks are all project-wide (with no denials). Fail closed: no port, a read that fails or times out, a task that
// is gone, another company's, past the per-request bound or unreadable, a task id that is malformed: the lesson is withheld. Logs carry counts and fixed codes, never ids.
//
// `readVisible` (read-visible.ts) calls it, and every lesson read already goes through `readVisible` (tests/unit/lessons/read-paths.test.ts). A new path that hands a lesson to a person or to an
// agent WITHOUT `readVisible` (the PR "Lessons used" list, publishing a lesson to a repository) must call `liveVisible` with the viewer of that path (`undefined` for something everyone in the
// project will read) and use only what it returns.
import { OrgIdSchema } from "@agentx/contracts";
import { createLiveAudienceReader, type TaskVisibilityPort } from "../team-record/live-audience.js";
import type { ReadAudience } from "../team-record/types.js";
import { audienceWithin, lessonAudiencesOf, type LessonTaskAudience, type RosterMemo } from "./task-audience.js";
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

export interface LessonLiveReaderInput { port: TaskVisibilityPort | undefined; key: ScopeKey; where: string; /** The task the lessons are for (an agent's running task): its audience is compared with every source task's (decision 31). Absent: the viewer rule. */ runningTaskId?: string | undefined; log?: LessonLog | undefined; /** Tests and the loader's own deadline (a function gives the time left for each lookup). */ timeoutMs?: number | (() => number) | undefined; maxTasks?: number | undefined }

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

  // Audiences (decision 31): read once per task per request, with the same bound, per-read time and abort as the visibility reader.
  const audiencePort = input.runningTaskId === undefined ? undefined : lessonAudiencesOf(input.port);
  const audiences = new Map<string, LessonTaskAudience | undefined>();
  const memo: RosterMemo = new Map();
  const loadAudiences = async (ids: Iterable<string>): Promise<void> => {
    if (!org.success || audiencePort === undefined) return;
    const fresh: string[] = [];
    for (const id of ids) {
      if (audiences.has(id) || fresh.includes(id)) continue;
      if (audiences.size + fresh.length >= (input.maxTasks ?? LESSON_LIVE_TASKS_MAX)) { input.log?.(`learning.${input.where}_audience_unreadable`, { reason: "bound" }); continue; }
      fresh.push(id);
    }
    if (fresh.length === 0) return;
    for (const id of fresh) audiences.set(id, undefined);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ms = typeof input.timeoutMs === "function" ? input.timeoutMs() : input.timeoutMs ?? LESSON_LIVE_TIMEOUT_MS;
      const work = audiencePort.read(org.data, fresh, { signal: abort.signal, memo });
      work.catch(() => undefined);
      const found = await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("timed out")); }, ms); })]);
      for (const id of fresh) audiences.set(id, found.get(id));
    } catch {
      input.log?.(`learning.${input.where}_audience_unreadable`, { reason: "error", tasks: fresh.length });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
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
      const runningTaskId = input.runningTaskId;
      if (runningTaskId !== undefined && audiencePort !== undefined && TASK_ID.test(runningTaskId)) {
        await loadAudiences([runningTaskId, ...refs.flatMap((ref) => ref.taskIds)]);
        const running = audiences.get(runningTaskId);
        if (running !== undefined) {
          let withheldCount = 0;
          const result = lessons.filter((_, index) => {
            if (!names(index)) return true;
            const ref = refs[index]!;
            const ok = !ref.unreadable && ref.taskIds.every((id) => { const source = audiences.get(id); return source !== undefined && audienceWithin(running, source); });
            if (!ok) withheldCount += 1;
            return ok;
          });
          if (withheldCount > 0) withheld(withheldCount, "task_not_visible");
          return result;
        }
        // The running task's audience can't be read: it reads as nobody in particular, below.
        input.log?.(`learning.${input.where}_reader_nobody`, { reason: "unknown" });
      } else if (runningTaskId !== undefined) {
        input.log?.(`learning.${input.where}_reader_nobody`, { reason: "unreadable" });
      }
      await reader.load(refs.flatMap((ref) => ref.taskIds));
      const audience = audienceOf(org.data, runningTaskId === undefined ? viewer : undefined);
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
