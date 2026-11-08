// LV-1 (SRL-4 review finding F1): a lesson learned from a task keeps the audience the task had when it was reflected, and nothing in a project-wide lesson names the task except
// `provenance.supportTasks` and the Rovara source events (`rovara:task:<id>...`, or the source id `task:<id>...`). If the task is narrowed afterwards (Plan 5 visibility), the lesson, which was
// written from the task's send-back reasons and notes, would still reach every agent and every screen of the project. So a lesson is also checked against the LIVE audience of every task
// it was learned from, each time it is read.
//
// One rule, one module (owner decisions 31 and 32). The audience of a task is "who can open its session" (`task-audience.ts`); the Team record's own resolver is NOT used here. `keep` has three readers:
//   - an AGENT (`running` is given): the audience of the RUNNING task T. A lesson reaches T only if EVERY person who can see T can see EVERY source task P (audience(T) is a subset of audience(P)). If T's audience
//     cannot be read (a failed or timed-out read, a task that is gone or another company's, past the bound, no audience port, or no task id at all) NO lesson that names a task is kept: there is no weaker rule to
//     fall back to (a fallback would let a lesson from a narrow task reach a company-wide task);
//   - a PERSON (`viewer` has a developer id): the lesson is kept if that person can open every source task's session;
//   - NOBODY in particular (a path whose readers are everyone: the PR "Lessons used" names, publishing a lesson): kept only if every source task, in the lesson's own project, is open to the whole project with no People
//     denial, read live.
// Fail closed: no port, a read that fails or times out, a task that is gone, another company's, past the per-request bound or unreadable, a task id that is malformed: the lesson is withheld. Logs carry counts and
// fixed codes, never ids.
//
// `readVisible` (read-visible.ts) calls it, and every lesson read already goes through `readVisible` (tests/unit/lessons/read-paths.test.ts). A new path that hands a lesson to a person or to an
// agent WITHOUT `readVisible` (the PR "Lessons used" list, publishing a lesson to a repository) must call `liveVisible` with the reader of that path (`undefined` for something everyone in the
// project will read) and use only what it returns.
import { OrgIdSchema } from "@agentx/contracts";
import type { TaskVisibilityPort } from "../team-record/live-audience.js";
import { audienceWithin, inAudience, lessonAudiencesOf, openToWholeProject, type LessonTaskAudience, type RosterMemo } from "./task-audience.js";
import type { LessonLog } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { lessonPlaces, type IdentitySet, type Lesson } from "./types.js";

/** The most distinct source tasks one call looks up. A lesson learned from a task past it is withheld. */
export const LESSON_LIVE_TASKS_MAX = 300;
/** How long the one batched lookup (and the comparison after it) may take before every lesson that names a task is withheld. */
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

/** A reader of many calls in one request: the audiences it has looked up are remembered, so the same task is never read twice and the bound counts only the lessons checked. */
export interface LessonLiveReader {
  /** The lessons of `lessons` whose source tasks are all still visible to the reader now (see the top of this file), in their order. Never throws. */
  keep(viewer: Pick<IdentitySet, "developerId"> | undefined, lessons: readonly Lesson[]): Promise<Lesson[]>;
}

export interface LessonLiveReaderInput {
  /** The access port's task-visibility port; the lesson audiences ride on it (`withLessonAudiences`). Without them every lesson that names a task is withheld. */
  port: TaskVisibilityPort | undefined; key: ScopeKey; where: string;
  /**
   * Present: the lessons are for an AGENT, and the reader is the audience of this running task (decision 31). `taskId` is undefined for a stage that was queued without one: then nothing that names a task is kept.
   * Absent: the viewer rule (a person, or nobody in particular).
   */
  running?: { taskId: string | undefined } | undefined;
  log?: LessonLog | undefined; /** Tests and the loader's own deadline (a function gives the time left for each lookup). */ timeoutMs?: number | (() => number) | undefined; maxTasks?: number | undefined;
}

/**
 * One reader per request (LV-1 M1). Lessons that name no task pass untouched (and no read is made when none names one). Anything that cannot be read withholds the lessons it affects. `where` names the
 * caller in the log line.
 */
export function createLessonLiveReader(input: LessonLiveReaderInput): LessonLiveReader {
  const org = OrgIdSchema.safeParse(input.key.workspaceId);
  const audiencePort = lessonAudiencesOf(input.port);
  const maxTasks = input.maxTasks ?? LESSON_LIVE_TASKS_MAX;
  const withheld = (count: number, reason: string): void => { input.log?.(`learning.${input.where}_live_withheld`, { lessons: count, reason }); };
  const unreadable = (reason: string, tasks?: number): void => { input.log?.(`learning.${input.where}_audience_unreadable`, tasks === undefined ? { reason } : { reason, tasks }); };

  // Audiences: read once per task per request, with the same bound, per-read time and abort for every read of the request.
  const audiences = new Map<string, LessonTaskAudience | undefined>();
  const memo: RosterMemo = new Map();
  const verdicts = new Map<string, Promise<boolean>>();
  const timeLeft = (): number => (typeof input.timeoutMs === "function" ? input.timeoutMs() : input.timeoutMs ?? LESSON_LIVE_TIMEOUT_MS);
  /** `run` with a deadline: when it passes, `run`'s signal aborts (no new read starts, a read in flight is cut) and the wait ends. */
  const bounded = async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = run(abort.signal);
      work.catch(() => undefined);
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("timed out")); }, timeLeft()); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const loadAudiences = async (ids: Iterable<string>): Promise<void> => {
    if (!org.success || audiencePort === undefined) return;
    const fresh: string[] = [];
    for (const id of ids) {
      if (audiences.has(id) || fresh.includes(id)) continue;
      if (audiences.size + fresh.length >= maxTasks) { unreadable("bound"); continue; }
      fresh.push(id);
    }
    if (fresh.length === 0) return;
    for (const id of fresh) audiences.set(id, undefined);
    try {
      const found = await bounded((signal) => audiencePort.read(org.data, fresh, { signal, memo }));
      for (const id of fresh) audiences.set(id, found.get(id));
    } catch (error) {
      unreadable(error instanceof Error && error.message === "timed out" ? "timeout" : "error", fresh.length);
    }
  };

  return {
    async keep(viewer, lessons) {
      const refs = lessons.map((lesson) => lessonTaskRefs(lesson));
      const names = (index: number): boolean => refs[index]!.taskIds.length > 0 || refs[index]!.unreadable;
      const named = lessons.filter((_, index) => names(index));
      if (named.length === 0) return [...lessons];
      const unnamed = (): Lesson[] => lessons.filter((_, index) => !names(index));
      if (!org.success || audiencePort === undefined) {
        withheld(named.length, org.success ? "no_port" : "bad_org");
        return unnamed();
      }
      const running = input.running;
      const runningId = running?.taskId;
      if (running !== undefined && (runningId === undefined || !TASK_ID.test(runningId))) {
        // A stage with no (usable) task id has no audience to compare: there is no weaker reader to fall back to.
        withheld(named.length, "running_unknown");
        return unnamed();
      }
      const person = running !== undefined ? undefined : viewer?.developerId;
      const who = person === undefined || person === "" ? undefined : person;
      await loadAudiences([...(runningId === undefined ? [] : [runningId]), ...refs.flatMap((ref) => ref.taskIds)]);
      const runningAudience = runningId === undefined ? undefined : audiences.get(runningId);
      if (running !== undefined && runningAudience === undefined) {
        // The running task's audience can't be read: nothing that names a task is kept.
        withheld(named.length, "running_unreadable");
        return unnamed();
      }
      /** Whether this reader may see the source task `id` (cached per request). May throw (an unreadable roster entry). */
      const allowed = (id: string, signal: AbortSignal): Promise<boolean> => {
        const cacheKey = `${runningId ?? who ?? "-"}\u0000${id}`;
        let known = verdicts.get(cacheKey);
        if (known === undefined) {
          const source = audiences.get(id);
          known = source === undefined ? Promise.resolve(false)
            : runningAudience !== undefined ? audienceWithin(runningAudience, source, signal)
            : who !== undefined ? inAudience(source, who, signal)
            : Promise.resolve(source.project === input.key.project && openToWholeProject(source));
          verdicts.set(cacheKey, known);
          known.catch(() => { if (verdicts.get(cacheKey) === known) verdicts.delete(cacheKey); });
        }
        return known;
      };
      let ok: boolean[];
      try {
        ok = await bounded(async (signal) => {
          const out: boolean[] = [];
          for (let index = 0; index < lessons.length; index += 1) {
            if (!names(index)) { out.push(true); continue; }
            const ref = refs[index]!;
            let pass = !ref.unreadable;
            for (const id of ref.taskIds) { if (!pass) break; pass = await allowed(id, signal); }
            out.push(pass);
          }
          return out;
        });
      } catch (error) {
        // A roster entry that cannot be read (or a deadline that passed) answers "no" for everything that names a task.
        unreadable(error instanceof Error && error.message === "timed out" ? "timeout" : "error");
        withheld(named.length, "audience_unreadable");
        return unnamed();
      }
      const count = lessons.filter((_, index) => names(index) && !ok[index]).length;
      if (count > 0) withheld(count, "task_not_visible");
      return lessons.filter((_, index) => ok[index]);
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
