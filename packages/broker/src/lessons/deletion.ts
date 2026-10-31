// Learning v2: what happens to lessons when the record rows they came from are deleted at the source (design §4.4.3). This is the learning lane's side of the
// record core's lesson-deletion port (`team-record/lesson-fate.ts`): the same three calls, over the lesson store. The shape below matches that port without
// importing it, so the lanes stay independent until they are merged.
//   - `forgetSources` removes the deleted ids from BOTH `provenance.sourceEvents` and the lesson's record citations (a new version), so a lesson's remaining
//     sources shrink across runs: resting on A and B, it is kept when A goes and withdrawn when B goes later.
//   - A lesson whose sources are ALL gone is withdrawn, unless a valid code citation alone supports it (active, validated, no stale check): then it stays,
//     with its record citations removed. A lesson that never had a record source is untouched by this.
//   - `withdraw` sets status `withdrawn` (it stops loading at once), removes the lesson's vector, and is audited.
import { emitAudit } from "./policy.js";
import type { LessonAuditSink, LessonVectors } from "./ports.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import type { Lesson, LessonCitation } from "./types.js";

export interface LessonForDeletion {
  id: string; version: number; status: string; citations: readonly LessonCitation[]; provenance: { sourceEvents: readonly string[] };
  counters: { citationStale: number }; lastValidatedAt?: string | undefined;
}
export interface LessonDeletionPort {
  affected(orgId: string, project: string, deleted: ReadonlySet<string>): Promise<LessonForDeletion[]>;
  withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void>;
  forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>): Promise<void>;
}

const DONE: ReadonlySet<string> = new Set(["withdrawn", "retired", "rejected"]);
const MAX_TRIES = 3;

const recordIds = (lesson: Pick<Lesson, "provenance" | "citations">): string[] =>
  [...lesson.provenance.sourceEvents, ...lesson.citations.flatMap((c) => (c.kind === "record" ? [c.eventId] : []))];

/** A valid code citation alone supports the lesson: it has one, was validated against code, no check found it stale, and it is live. */
export function supportedByCode(lesson: Pick<Lesson, "citations" | "lastValidatedAt" | "counters" | "status">): boolean {
  return lesson.citations.some((c) => c.kind === "code") && lesson.lastValidatedAt !== undefined && lesson.counters.citationStale === 0 && lesson.status === "active";
}

export interface DeletionDeps { store: LessonStore; vectors: LessonVectors; audit: LessonAuditSink; now: () => number }

export function lessonDeletionPort(deps: DeletionDeps): LessonDeletionPort {
  const key = (orgId: string, project: string): ScopeKey => ({ workspaceId: orgId, project });

  async function withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    const k = key(orgId, project);
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const lesson = await deps.store.get(k, lessonId);
      if (lesson === undefined || lesson.status === "withdrawn") break;
      const setVersion = await deps.store.setVersion(k);
      const result = await deps.store.commit(k, setVersion, [{ ...lesson, version: nextVersion(lesson, await deps.store.versions(k, lessonId)), status: "withdrawn", updatedAt: deps.now() }], deps.now());
      if (!result.ok) continue;
      await emitAudit(deps.audit, { action: "lesson.withdrawn", workspaceId: orgId, project, lessonId, facts: { cause } });
      break;
    }
    // The vector goes whether or not the status write won the race: a withdrawn lesson must never be found by similarity again.
    await deps.vectors.remove(orgId, project, lessonId);
  }

  return {
    async affected(orgId, project, deleted) {
      return (await deps.store.list(key(orgId, project)))
        .filter((l) => !DONE.has(l.status) && recordIds(l).some((id) => deleted.has(id)))
        .map((l) => ({
          id: l.id, version: l.version, status: l.status, citations: l.citations, provenance: { sourceEvents: l.provenance.sourceEvents }, counters: { citationStale: l.counters.citationStale },
          ...(l.lastValidatedAt === undefined ? {} : { lastValidatedAt: new Date(l.lastValidatedAt).toISOString() }),
        }));
    },
    withdraw,
    async forgetSources(orgId, project, lessonId, deleted) {
      const k = key(orgId, project);
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const lesson = await deps.store.get(k, lessonId);
        if (lesson === undefined || DONE.has(lesson.status) || !recordIds(lesson).some((id) => deleted.has(id))) return;
        const sourceEvents = lesson.provenance.sourceEvents.filter((id) => !deleted.has(id));
        const citations = lesson.citations.filter((c) => c.kind !== "record" || !deleted.has(c.eventId));
        // Checks follow their citations by position, so the positions of what remains are rebuilt.
        const kept = lesson.citations.flatMap((c, index) => (citations.includes(c) ? [index] : []));
        const citationChecks = (lesson.citationChecks ?? []).flatMap((check) => { const at = kept.indexOf(check.index); return at < 0 ? [] : [{ ...check, index: at }]; });
        const pruned: Lesson = {
          ...lesson, version: nextVersion(lesson, await deps.store.versions(k, lessonId)), citations,
          provenance: { ...lesson.provenance, sourceEvents }, ...(citationChecks.length === 0 ? {} : { citationChecks }), updatedAt: deps.now(),
        };
        if (citationChecks.length === 0) delete (pruned as { citationChecks?: unknown }).citationChecks;
        const setVersion = await deps.store.setVersion(k);
        const result = await deps.store.commit(k, setVersion, [pruned], deps.now());
        if (!result.ok) continue;
        // Nothing left to rest on: the lesson is withdrawn, unless code alone supports it.
        const hadSources = lesson.provenance.sourceEvents.length > 0;
        if (hadSources && sourceEvents.length === 0 && !supportedByCode(pruned)) await withdraw(orgId, project, lessonId, "sources_deleted");
        return;
      }
    },
  };
}
