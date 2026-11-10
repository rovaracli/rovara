// Learning v2 WL-6: a stage's lessons at DELIVERY. The outbox row, the queue message, its dead-letter copy and a FAILED row carry only lesson ids and versions (`LearnedRefs`); the dispatcher calls this
// just before it posts the stage to the worker and gets the `learnedContext` built from the lesson store as it is at that moment. A lesson erased (even one whose purge has not finished: its authors are fenced
// first), retired, withdrawn, expired, edited since, no longer approved for use, or hidden from the task's reader since is left out; so is everything when the project's learning mode no longer loads. Any
// failure (the store, the access records, the reader's identity) delivers no lessons: the stage runs as without memory. The rules are the loader's own (`load.ts`), asked again.
import { EVAL_FILES_LESSONS_PATH, EvalFilesPayloadSchema, LearnedContextSchema, type EvalFilesPayload, type LearnedContext, type LearnedLesson, type LearnedRefs } from "@agentx/contracts";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { hasStaleCitation, approvedForUse, stageAllows, toLearned, LOAD_MAX_BYTES } from "./load.js";
import { memberView, type MemberResolver } from "./members.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { Clock } from "./ports.js";
import { createLessonLiveReader } from "./live-visibility.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { POINTER_SENTENCE } from "./repo-file-pointer.js";
import { replayLessonsFiles } from "./replay-delivery.js";
import { resolveAnySnapshot, type EvalSnapshotStore, type SnapshotStore } from "./replay-snapshot-store.js";
import type { IdentitySet, Lesson } from "./types.js";

export interface DeliveryDeps {
  store: LessonStore; settings: LearningSettingsReader; access: AccessCheckPort;
  /** Unused since decision 31 (the reader is the running task's audience, not one person); kept so the wiring needs no change. */
  identity(workspaceId: string, developerId: string): Promise<IdentitySet>;
  /** Counts approvers as members (a merged developer is the member they became). The dispatcher has no sign-in read, so it leaves this out and the loader's member-aware check (at queue time) stands; where given, a failed lookup delivers nothing. */
  resolveMember?: MemberResolver;
  /** Lane 7: the frozen snapshots of replay copies. Absent: refs that name a snapshot deliver nothing. */
  snapshots?: SnapshotStore;
  /** Lane 7 (DECISIONS 68): imported eval snapshots. */
  evalSnapshots?: EvalSnapshotStore;
  now: Clock;
  log?: LessonLog;
}

/** People who wrote or rewrote a lesson's text: an erased one's lessons are never delivered (erasure fences them before it removes anything). */
const writersOf = (lesson: Lesson): string[] => [...lesson.provenance.authors, ...(lesson.provenance.editors ?? []), ...(lesson.provenance.readFrom ?? [])];

async function notErased(store: LessonStore, key: ScopeKey, lesson: Lesson): Promise<boolean> {
  for (const person of new Set(writersOf(lesson).map((p) => p.trim().toLowerCase()))) if (await store.isErased(key, person)) return false;
  return true;
}

export async function learnedContextFromRefs(deps: DeliveryDeps, refs: LearnedRefs): Promise<LearnedContext | undefined> {
  // A file-arm ref (lane 7) is delivered as a repository file (`evalFilesFromRefs`), never as a prompt block.
  if (refs.file !== undefined) return undefined;
  try {
    const delivered = await deliveredLessons(deps, refs);
    if (delivered === undefined) return undefined;
    const { chosen, priorLoaded } = delivered;
    if (chosen.length === 0 && (priorLoaded ?? []).length === 0) return undefined;
    const context = { v: 1 as const, setVersion: refs.setVersion, stage: refs.stage, lessons: chosen.map((entry) => entry.learned), ...(priorLoaded === undefined || priorLoaded.length === 0 ? {} : { priorLoaded }) };
    const parsed = LearnedContextSchema.safeParse(context);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // The store, the access records or the reader's identity could not be read: no lessons, and the stage runs as without memory.
    return undefined;
  }
}

/**
 * Lane 7, the file arm: the files a replay copy's checkout is given for these refs, rendered from the same lessons delivery would have sent (every check applies: mode, snapshot, erasure, stage, access, size), in R2's own
 * file format. Undefined when the refs are not a file arm's, nothing is left to offer, or anything could not be read.
 */
export async function evalFilesFromRefs(deps: DeliveryDeps, refs: LearnedRefs): Promise<EvalFilesPayload | undefined> {
  if (refs.file === undefined || refs.snapshotId === undefined) return undefined;
  try {
    const delivered = await deliveredLessons(deps, refs);
    if (delivered === undefined) return undefined;
    const files = replayLessonsFiles(delivered.chosen.map((entry) => entry.lesson), refs.file.repository);
    const lessonsFile = files?.files.find((file) => file.path === EVAL_FILES_LESSONS_PATH);
    if (files === undefined || lessonsFile === undefined) return undefined;
    const parsed = EvalFilesPayloadSchema.safeParse({ repository: refs.file.repository, lessonsFile: { path: EVAL_FILES_LESSONS_PATH, content: lessonsFile.content }, pointerLine: POINTER_SENTENCE });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface Delivered { chosen: Array<{ lesson: Lesson; learned: LearnedLesson }>; priorLoaded: LearnedContext["priorLoaded"] }

/** The lessons a stage is given now, after every delivery check; throws when the store cannot be read (the callers deliver nothing then). */
async function deliveredLessons(deps: DeliveryDeps, refs: LearnedRefs): Promise<Delivered | undefined> {
  const key: ScopeKey = { workspaceId: refs.orgId, project: refs.project };
  {
    const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
    // Lane 7: refs that name a snapshot are a replay copy's: the project's OWN mode decides (the install's switch does not), and the lessons are the snapshot's, at its versions.
    if (!modeAllows(refs.snapshotId === undefined ? resolved.mode : resolved.chosenMode, "load")) return undefined;
    // The snapshot's own lessons (imported by an operator, or the live versions it names), looked up by id and version. A snapshot that is missing or not this project's delivers nothing.
    let pinned: Map<string, Lesson> | undefined;
    if (refs.snapshotId !== undefined) {
      const snapshot = await resolveAnySnapshot({ snapshots: deps.snapshots, evalSnapshots: deps.evalSnapshots, store: deps.store }, key, refs.snapshotId);
      if (snapshot === undefined) return undefined;
      pinned = new Map(snapshot.lessons.map((lesson) => [`${lesson.id}@${String(lesson.version)}`, lesson]));
    }
    const now = deps.now();
    // Decision 31: the reader is the running task's audience, asked again now (the people who can open its session now, not the audience the load saw, and not `task.shared`). A lesson is delivered only if everyone who
    // can see the task can see every source task of the lesson. A stage queued before the task id was carried, or a task whose audience can't be read, gets no lesson that names a task (there is no weaker rule to fall back to). Restricted places and
    // the lesson's own frozen audience are checked as for nobody in particular (`viewer` undefined): a lesson only some people may read never reaches an agent that several people can see.
    const viewer = undefined;
    const liveReader = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "deliver", running: { taskId: refs.taskId }, ...(deps.log === undefined ? {} : { log: deps.log }) });

    const fetched: Lesson[] = [];
    for (const ref of refs.lessons) {
      if (pinned !== undefined) {
        // A snapshot lesson: exactly the version the snapshot names (the lesson may have been edited or have expired since); one the snapshot does not name is never delivered.
        const frozen = pinned.get(`${ref.id}@${String(ref.version)}`);
        if (frozen === undefined || frozen.status !== "active") continue;
        fetched.push(frozen);
        continue;
      }
      const lesson = await deps.store.get(key, ref.id);
      if (lesson === undefined || lesson.status !== "active" || lesson.version !== ref.version || lesson.expiresAt <= now) continue;
      fetched.push(lesson);
    }
    const member = await memberView(deps.resolveMember, key.workspaceId, fetched.flatMap((l) => l.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => a.by)));
    if (member === undefined) return undefined;
    const live: Lesson[] = [];
    for (const lesson of fetched) {
      // A snapshot's lessons were active under the arm's own pipeline when frozen: the live approval policy does not re-decide them (the project's mode, the access checks, erasure and the stage rules still do).
      if ((pinned === undefined && !approvedForUse(lesson, resolved.approval, member, resolved.trialAllowed)) || hasStaleCitation(lesson) || !stageAllows(lesson, refs.stage, member)) continue;
      if (!(await notErased(deps.store, key, lesson))) continue;
      live.push(lesson);
    }
    const readable = new Set((await readVisible({ access: deps.access, key, viewer, lessons: live, where: "deliver", live: liveReader, ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
    const chosen: Delivered["chosen"] = [];
    let bytes = 0;
    for (const lesson of live) {
      if (!readable.has(lesson.id)) continue;
      const learned = toLearned(lesson);
      const size = Buffer.byteLength(JSON.stringify(learned), "utf8");
      if (bytes + size > LOAD_MAX_BYTES) continue;
      chosen.push({ lesson, learned });
      bytes += size;
    }

    // The reviewer's list of what earlier stages were given: titles of lessons that still exist, are not withdrawn, whose writers are not erased, and that the reader may still see.
    let priorLoaded: LearnedContext["priorLoaded"];
    if (refs.priorLoaded !== undefined) {
      const seen: Lesson[] = [];
      for (const ref of refs.priorLoaded) {
        const lesson = await deps.store.get(key, ref.id);
        if (lesson === undefined || lesson.status === "withdrawn" || !(await notErased(deps.store, key, lesson))) continue;
        seen.push(lesson);
      }
      const shown = new Set((await readVisible({ access: deps.access, key, viewer, lessons: seen, where: "deliver", live: liveReader, ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
      priorLoaded = seen.filter((lesson) => shown.has(lesson.id)).map((lesson) => ({ id: lesson.id, type: lesson.type, title: lesson.title }));
    }

    return { chosen, priorLoaded };
  }
}
