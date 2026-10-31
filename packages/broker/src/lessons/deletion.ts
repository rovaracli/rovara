// Learning v2: what happens to lessons when the record rows they came from are deleted at the source, or when a person is erased (design §4.4.3). This is the
// learning lane's side of the record core's lesson-deletion port (`team-record/lesson-fate.ts`), over the lesson store. The shape matches that port (with an
// optional cause and erased-person argument added at the end) without importing it, so the lanes stay independent until they are merged.
//
// Ordinary source deletion (cause "sources_deleted"):
//   - `forgetSources` removes the deleted ids from `provenance.sourceEvents` and the record citations of the head AND of every old version, so a rollback can
//     never bring a deleted id back. A lesson with some sources left stays as it is.
//   - A lesson whose sources are ALL gone is withdrawn, unless a valid code citation alone supports it. Then it is kept, but sent back to a person
//     (`reviewRequired`; a lesson that was only auto-applied goes back to pending), because the corroboration it was applied on is gone.
//   - `withdraw` sets status `withdrawn`, strips every record source from every version, removes the vector, and tombstones the lesson so a rollback never
//     restores it. It is audited.
// Person erasure (cause "person_erased"; privacy wins over reproducibility, as for snapshots in §4.13): every lesson the person wrote, or that rests ONLY on
// their rows, is hard-deleted whatever its code citations say (head, all versions, vector, load-manifest references). Lessons others also support lose the
// person's id and rows from every version and are kept.
import { emitAudit } from "./policy.js";
import type { LessonAuditSink, LessonVectors } from "./ports.js";
import { pendingExpiry } from "./expiry.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import type { Lesson, LessonCitation } from "./types.js";

export type DeletionCause = "sources_deleted" | "source_deleted" | "person_erased";
export interface ErasedPerson { developerId: string }
export interface LessonForDeletion {
  id: string; version: number; status: string; citations: readonly LessonCitation[]; provenance: { sourceEvents: readonly string[] };
  counters: { citationStale: number }; lastValidatedAt?: string | undefined;
}
export interface LessonDeletionPort {
  affected(orgId: string, project: string, deleted: ReadonlySet<string>, erased?: ErasedPerson): Promise<LessonForDeletion[]>;
  withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void>;
  forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>, cause?: DeletionCause, erased?: ErasedPerson): Promise<void>;
  /** The whole erasure of one person in one project: purge what they wrote or alone support, scrub them from the rest. Returns what was purged and scrubbed. */
  erasePerson(orgId: string, project: string, erased: ErasedPerson, deleted: ReadonlySet<string>): Promise<{ purged: string[]; scrubbed: string[] }>;
}

const DONE: ReadonlySet<string> = new Set(["withdrawn", "retired", "rejected"]);
const MAX_TRIES = 3;
export const ERASED_MARK = "erased";

const recordIds = (lesson: Pick<Lesson, "provenance" | "citations">): string[] =>
  [...lesson.provenance.sourceEvents, ...lesson.citations.flatMap((c) => (c.kind === "record" ? [c.eventId] : []))];
const mentions = (l: Lesson, dev: string): boolean =>
  l.provenance.authors.includes(dev) || l.provenance.sources.includes(`member:${dev}`) || l.provenance.inputSources.includes(`member:${dev}`) || l.approvals.some((a) => a.by === dev)
  || l.promotionApprovals?.some((a) => a.by === dev) === true;

/** A valid code citation alone supports the lesson: it has one, was validated against code, no check found it stale, and it is live. */
export function supportedByCode(lesson: Pick<Lesson, "citations" | "lastValidatedAt" | "counters" | "status">): boolean {
  return lesson.citations.some((c) => c.kind === "code") && lesson.lastValidatedAt !== undefined && lesson.counters.citationStale === 0 && lesson.status === "active";
}

/** The lesson without the deleted ids (sources and record citations), and, if given, without the person. Citation checks are re-indexed. Pure. */
export function scrubLesson(lesson: Lesson, deleted: ReadonlySet<string>, dev?: string): Lesson {
  const citations = lesson.citations.filter((c) => c.kind !== "record" || !deleted.has(c.eventId));
  const kept = lesson.citations.flatMap((c, index) => (citations.includes(c) ? [index] : []));
  const checks = (lesson.citationChecks ?? []).flatMap((check) => { const at = kept.indexOf(check.index); return at < 0 ? [] : [{ ...check, index: at }]; });
  const out: Lesson = { ...lesson, citations, provenance: { ...lesson.provenance, sourceEvents: lesson.provenance.sourceEvents.filter((id) => !deleted.has(id)) } };
  if (checks.length > 0) out.citationChecks = checks; else delete (out as { citationChecks?: unknown }).citationChecks;
  if (dev !== undefined) {
    out.provenance = {
      ...out.provenance, authors: out.provenance.authors.filter((a) => a !== dev), sources: out.provenance.sources.filter((s) => s !== `member:${dev}`),
      inputSources: out.provenance.inputSources.filter((s) => s !== `member:${dev}`),
    };
    out.approvals = out.approvals.map((a) => (a.by === dev ? { ...a, by: ERASED_MARK } : a));
    if (out.promotionApprovals !== undefined) out.promotionApprovals = out.promotionApprovals.map((a) => (a.by === dev ? { ...a, by: ERASED_MARK } : a));
  }
  return out;
}

export interface DeletionDeps { store: LessonStore; vectors: LessonVectors; audit: LessonAuditSink; now: () => number }

export function lessonDeletionPort(deps: DeletionDeps): LessonDeletionPort {
  const key = (orgId: string, project: string): ScopeKey => ({ workspaceId: orgId, project });
  const everyVersion = (k: ScopeKey, id: string, fn: (l: Lesson) => Lesson) => deps.store.scrub(k, id, fn);

  async function purge(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    const k = key(orgId, project);
    await deps.store.purge(k, lessonId);
    await deps.vectors.remove(orgId, project, lessonId);
    await emitAudit(deps.audit, { action: "lesson.withdrawn", workspaceId: orgId, project, lessonId, facts: { cause, purged: true } });
  }

  async function withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    if (cause === "person_erased") return purge(orgId, project, lessonId, cause);
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
    // Nothing is left to rest on: the record sources go from every version, the lesson cannot be restored by a rollback, and its vector is removed.
    await everyVersion(k, lessonId, (l) => scrubLesson(l, new Set(recordIds(l))));
    await deps.store.markGone(k, lessonId, "withdrawn");
    await deps.vectors.remove(orgId, project, lessonId);
  }

  async function forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>, cause: DeletionCause = "sources_deleted", erased?: ErasedPerson): Promise<void> {
    const k = key(orgId, project);
    if (cause === "person_erased") {
      const lesson = await deps.store.get(k, lessonId);
      if (lesson === undefined) return;
      const alone = lesson.provenance.sourceEvents.length > 0 && lesson.provenance.sourceEvents.every((id) => deleted.has(id));
      if ((erased !== undefined && lesson.provenance.authors.includes(erased.developerId)) || alone) return purge(orgId, project, lessonId, cause);
      await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted, erased?.developerId));
      return;
    }
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const lesson = await deps.store.get(k, lessonId);
      if (lesson === undefined || DONE.has(lesson.status) || !recordIds(lesson).some((id) => deleted.has(id))) return;
      let next = scrubLesson(lesson, deleted);
      const hadSources = lesson.provenance.sourceEvents.length > 0;
      const empty = hadSources && next.provenance.sourceEvents.length === 0;
      const supported = empty && supportedByCode(lesson);
      if (supported) {
        // Kept on code alone: a person decides again. A lesson that was only ever auto-applied goes back to pending (its corroboration is gone).
        const personApproved = lesson.approvals.some((a) => a.mode !== "auto");
        next = { ...next, reviewRequired: true, ...(personApproved ? {} : { status: "pending" as const, approvals: [], pendingExpiresAt: pendingExpiry(deps.now()) }) };
      }
      next = { ...next, version: nextVersion(lesson, await deps.store.versions(k, lessonId)), updatedAt: deps.now() };
      const setVersion = await deps.store.setVersion(k);
      const result = await deps.store.commit(k, setVersion, [next], deps.now());
      if (!result.ok) continue;
      // Old versions lose the deleted ids too: a rollback cannot restore them.
      await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted));
      if (empty && !supported) await withdraw(orgId, project, lessonId, "sources_deleted");
      return;
    }
  }

  return {
    async affected(orgId, project, deleted, erased) {
      return (await deps.store.list(key(orgId, project)))
        .filter((l) => (!DONE.has(l.status) && recordIds(l).some((id) => deleted.has(id))) || (erased !== undefined && mentions(l, erased.developerId)))
        .map((l) => ({
          id: l.id, version: l.version, status: l.status, citations: l.citations, provenance: { sourceEvents: l.provenance.sourceEvents }, counters: { citationStale: l.counters.citationStale },
          ...(l.lastValidatedAt === undefined ? {} : { lastValidatedAt: new Date(l.lastValidatedAt).toISOString() }),
        }));
    },
    withdraw,
    forgetSources,
    async erasePerson(orgId, project, erased, deleted) {
      const k = key(orgId, project);
      const purged: string[] = [];
      const scrubbed: string[] = [];
      for (const lesson of await deps.store.list(k)) {
        const wrote = lesson.provenance.authors.includes(erased.developerId);
        const alone = lesson.provenance.sourceEvents.length > 0 && lesson.provenance.sourceEvents.every((id) => deleted.has(id));
        if (wrote || alone) { await purge(orgId, project, lesson.id, "person_erased"); purged.push(lesson.id); continue; }
        if (mentions(lesson, erased.developerId) || recordIds(lesson).some((id) => deleted.has(id))) {
          await everyVersion(k, lesson.id, (l) => scrubLesson(l, deleted, erased.developerId));
          scrubbed.push(lesson.id);
        }
      }
      await deps.store.forgetSource(k, `member:${erased.developerId}`);
      return { purged, scrubbed };
    },
  };
}
