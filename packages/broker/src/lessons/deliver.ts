// Learning v2 WL-6: a stage's lessons at DELIVERY. The outbox row, the queue message, its dead-letter copy and a FAILED row carry only lesson ids and versions (`LearnedRefs`); the dispatcher calls this
// just before it posts the stage to the worker and gets the `learnedContext` built from the lesson store as it is at that moment. A lesson erased (even one whose purge has not finished: its authors are fenced
// first), retired, withdrawn, expired, edited since, no longer approved for use, or hidden from the task's reader since is left out; so is everything when the project's learning mode no longer loads. Any
// failure (the store, the access records, the reader's identity) delivers no lessons: the stage runs as without memory. The rules are the loader's own (`load.ts`), asked again.
import { LearnedContextSchema, type LearnedContext, type LearnedLesson, type LearnedRefs } from "@agentx/contracts";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { hasStaleCitation, approvedForUse, stageAllows, toLearned, LOAD_MAX_BYTES } from "./load.js";
import { memberView, type MemberResolver } from "./members.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { Clock } from "./ports.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { isRestricted, type IdentitySet, type Lesson } from "./types.js";

export interface DeliveryDeps {
  store: LessonStore; settings: LearningSettingsReader; access: AccessCheckPort;
  /** The reader's identity for the access check (the accounts a developer linked). May throw: nothing is delivered. */
  identity(workspaceId: string, developerId: string): Promise<IdentitySet>;
  /** Counts approvers as members (a merged developer is the member they became). The dispatcher has no sign-in read, so it leaves this out and the loader's member-aware check (at queue time) stands; where given, a failed lookup delivers nothing. */
  resolveMember?: MemberResolver;
  now: Clock;
  log?: LessonLog;
}

/** People who wrote or rewrote a lesson's text: an erased one's lessons are never delivered (erasure fences them before it removes anything). */
const writersOf = (lesson: Lesson): string[] => [...lesson.provenance.authors, ...(lesson.provenance.editors ?? [])];

async function notErased(store: LessonStore, key: ScopeKey, lesson: Lesson): Promise<boolean> {
  for (const person of new Set(writersOf(lesson).map((p) => p.trim().toLowerCase()))) if (await store.isErased(key, person)) return false;
  return true;
}

export async function learnedContextFromRefs(deps: DeliveryDeps, refs: LearnedRefs): Promise<LearnedContext | undefined> {
  const key: ScopeKey = { workspaceId: refs.orgId, project: refs.project };
  try {
    const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
    if (!modeAllows(resolved.mode, "load")) return undefined;
    const now = deps.now();
    // The reader the load was for: a private task's owner (their linked accounts), or nobody in particular for a shared task.
    const viewer = refs.audience.kind === "shared" ? undefined : await deps.identity(key.workspaceId, refs.audience.developerId);

    const fetched: Lesson[] = [];
    for (const ref of refs.lessons) {
      const lesson = await deps.store.get(key, ref.id);
      if (lesson === undefined || lesson.status !== "active" || lesson.version !== ref.version || lesson.expiresAt <= now) continue;
      fetched.push(lesson);
    }
    const member = await memberView(deps.resolveMember, key.workspaceId, fetched.flatMap((l) => l.approvals.filter((a) => a.mode !== "auto").map((a) => a.by)));
    if (member === undefined) return undefined;
    const live: Lesson[] = [];
    for (const lesson of fetched) {
      if (!approvedForUse(lesson, resolved.approval, member) || hasStaleCitation(lesson) || !stageAllows(lesson, refs.stage, member)) continue;
      if (!(await notErased(deps.store, key, lesson))) continue;
      live.push(lesson);
    }
    const readable = new Set((await readVisible({ access: deps.access, key, viewer, lessons: live, where: "deliver", ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
    const chosen: LearnedLesson[] = [];
    let bytes = 0;
    for (const lesson of live) {
      if (!readable.has(lesson.id)) continue;
      const learned = toLearned(lesson);
      const size = Buffer.byteLength(JSON.stringify(learned), "utf8");
      if (bytes + size > LOAD_MAX_BYTES) continue;
      chosen.push(learned);
      bytes += size;
    }

    // The reviewer's list of what earlier stages were given: titles of lessons that still exist, are not withdrawn or restricted, whose writers are not erased, and that the reader may still see.
    let priorLoaded: LearnedContext["priorLoaded"];
    if (refs.priorLoaded !== undefined) {
      const seen: Lesson[] = [];
      for (const ref of refs.priorLoaded) {
        const lesson = await deps.store.get(key, ref.id);
        if (lesson === undefined || lesson.status === "withdrawn" || isRestricted(lesson) || !(await notErased(deps.store, key, lesson))) continue;
        seen.push(lesson);
      }
      const shown = new Set((await readVisible({ access: deps.access, key, viewer, lessons: seen, where: "deliver", ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
      priorLoaded = seen.filter((lesson) => shown.has(lesson.id)).map((lesson) => ({ id: lesson.id, type: lesson.type, title: lesson.title }));
    }

    if (chosen.length === 0 && (priorLoaded ?? []).length === 0) return undefined;
    const context = { v: 1 as const, setVersion: refs.setVersion, stage: refs.stage, lessons: chosen, ...(priorLoaded === undefined || priorLoaded.length === 0 ? {} : { priorLoaded }) };
    const parsed = LearnedContextSchema.safeParse(context);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // The store, the access records or the reader's identity could not be read: no lessons, and the stage runs as without memory.
    return undefined;
  }
}
