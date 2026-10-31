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
/** Every person a version names: its authors, `member:` source keys, and anyone who approved or asked to promote it. System and erased marks are not people. */
const peopleOf = (l: Lesson): string[] => [
  ...l.provenance.authors, ...[...l.provenance.sources, ...l.provenance.inputSources].filter((s) => s.startsWith("member:")).map((s) => s.slice("member:".length)),
  ...l.approvals.map((a) => a.by), ...(l.promotionApprovals ?? []).map((a) => a.by),
].filter((p) => p !== ERASED_MARK && !p.startsWith("system:"));
const mentions = (l: Lesson, dev: string): boolean => peopleOf(l).includes(dev);

/** A lesson with everything ever stored for it: the head and every version. Deletion and erasure judge the whole history, never only the current version. */
export interface LessonHistory { head: Lesson; all: Lesson[]; inSet: boolean }

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

  /** The one walk over history: every stored head of the project, with all its versions, whether or not a rollback dropped it from the current set. */
  async function histories(k: ScopeKey): Promise<LessonHistory[]> {
    const out: LessonHistory[] = [];
    for (const head of await deps.store.listAllHeads(k)) out.push({ head, all: [head, ...(await deps.store.versions(k, head.id))], inSet: (await deps.store.get(k, head.id)) !== undefined });
    return out;
  }
  async function historyOf(k: ScopeKey, id: string): Promise<LessonHistory | undefined> {
    const head = await deps.store.getHead(k, id);
    return head === undefined ? undefined : { head, all: [head, ...(await deps.store.versions(k, id))], inSet: (await deps.store.get(k, id)) !== undefined };
  }
  const namesDeleted = (h: LessonHistory, deleted: ReadonlySet<string>) => h.all.some((l) => recordIds(l).some((id) => deleted.has(id)));
  /** Whether the erased person is what the lesson rests on: they wrote any version, every source it ever had is gone, or they are the only person it ever names. */
  function restsOnPerson(h: LessonHistory, deleted: ReadonlySet<string>, dev: string | undefined): boolean {
    const everSources = new Set(h.all.flatMap((l) => l.provenance.sourceEvents));
    const allGone = everSources.size > 0 && [...everSources].every((id) => deleted.has(id));
    if (dev === undefined) return allGone;
    const people = new Set(h.all.flatMap(peopleOf));
    const wrote = h.all.some((l) => l.provenance.authors.includes(dev));
    return wrote || allGone || (people.size > 0 && [...people].every((p) => p === dev));
  }

  async function purge(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    const k = key(orgId, project);
    await deps.store.purge(k, lessonId);
    await deps.vectors.remove(orgId, project, lessonId);
    await emitAudit(deps.audit, { action: "lesson.withdrawn", workspaceId: orgId, project, lessonId, facts: { cause, purged: true } });
  }

  /** All or nothing: if the status change cannot be committed, NOTHING else changes (no scrub, no tombstone, no vector removal) and the call fails. */
  async function withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    if (cause === "person_erased") return purge(orgId, project, lessonId, cause);
    const k = key(orgId, project);
    const h = await historyOf(k, lessonId);
    if (h === undefined) return;
    if (h.head.status !== "withdrawn") {
      if (h.inSet) {
        let done = false;
        for (let attempt = 0; attempt < MAX_TRIES && !done; attempt += 1) {
          const lesson = await deps.store.get(k, lessonId);
          if (lesson === undefined) break;
          const setVersion = await deps.store.setVersion(k);
          done = (await deps.store.commit(k, setVersion, [{ ...lesson, version: nextVersion(lesson, await deps.store.versions(k, lessonId)), status: "withdrawn", updatedAt: deps.now() }], deps.now())).ok;
        }
        if (!done) throw new Error("withdraw not committed");
      } else {
        // Outside the current set a commit would bring it back in: its head and versions are marked in place.
        await everyVersion(k, lessonId, (l) => ({ ...l, status: "withdrawn" }));
      }
      await emitAudit(deps.audit, { action: "lesson.withdrawn", workspaceId: orgId, project, lessonId, facts: { cause } });
    }
    // Nothing is left to rest on: the record sources go from every version, the lesson cannot be restored by a rollback, and its vector is removed.
    await everyVersion(k, lessonId, (l) => scrubLesson(l, new Set(recordIds(l))));
    await deps.store.markGone(k, lessonId, "withdrawn");
    await deps.vectors.remove(orgId, project, lessonId);
  }

  async function forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>, cause: DeletionCause = "sources_deleted", erased?: ErasedPerson): Promise<void> {
    const k = key(orgId, project);
    const h = await historyOf(k, lessonId);
    if (h === undefined) return;
    if (cause === "person_erased") {
      const dev = erased?.developerId;
      if (!namesDeleted(h, deleted) && (dev === undefined || !h.all.some((l) => mentions(l, dev)))) return;
      if (restsOnPerson(h, deleted, dev)) return purge(orgId, project, lessonId, cause);
      await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted, dev));
      return;
    }
    if (!namesDeleted(h, deleted)) return;
    // A lesson that is finished (retired, rejected, withdrawn) is only scrubbed, in every version.
    if (DONE.has(h.head.status)) { await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted)); return; }
    const lesson = h.head;
    const hadSources = h.all.some((l) => l.provenance.sourceEvents.length > 0);
    const remaining = scrubLesson(lesson, deleted);
    const empty = hadSources && remaining.provenance.sourceEvents.length === 0;
    const supported = empty && supportedByCode(lesson);
    if (!h.inSet) {
      // Not in the current set: scrub in place, never commit (a commit would bring it back).
      await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted));
      if (empty && !supported) await withdraw(orgId, project, lessonId, "sources_deleted");
      else if (supported) await everyVersion(k, lessonId, (l) => backToPerson(l, deps.now()));
      return;
    }
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const fresh = await deps.store.get(k, lessonId);
      if (fresh === undefined) return;
      let next = scrubLesson(fresh, deleted);
      // Kept on code alone: a person decides again. A lesson that was only ever auto-applied goes back to pending (its corroboration is gone).
      if (supported) next = backToPerson(next, deps.now());
      next = { ...next, version: nextVersion(fresh, await deps.store.versions(k, lessonId)), updatedAt: deps.now() };
      const setVersion = await deps.store.setVersion(k);
      if (!(await deps.store.commit(k, setVersion, [next], deps.now())).ok) continue;
      // Old versions lose the deleted ids too: a rollback cannot restore them.
      await everyVersion(k, lessonId, (l) => scrubLesson(l, deleted));
      if (empty && !supported) await withdraw(orgId, project, lessonId, "sources_deleted");
      return;
    }
    throw new Error("forgetSources not committed");
  }

  return {
    async affected(orgId, project, deleted, erased) {
      const out: LessonForDeletion[] = [];
      for (const h of await histories(key(orgId, project))) {
        if (!namesDeleted(h, deleted) && !(erased !== undefined && h.all.some((l) => mentions(l, erased.developerId)))) continue;
        const l = h.head;
        out.push({
          id: l.id, version: l.version, status: l.status, citations: l.citations, provenance: { sourceEvents: l.provenance.sourceEvents }, counters: { citationStale: l.counters.citationStale },
          ...(l.lastValidatedAt === undefined ? {} : { lastValidatedAt: new Date(l.lastValidatedAt).toISOString() }),
        });
      }
      return out;
    },
    withdraw,
    forgetSources,
    async erasePerson(orgId, project, erased, deleted) {
      const k = key(orgId, project);
      const purged: string[] = [];
      const scrubbed: string[] = [];
      for (const h of await histories(k)) {
        const touches = namesDeleted(h, deleted) || h.all.some((l) => mentions(l, erased.developerId));
        if (!touches) continue;
        if (restsOnPerson(h, deleted, erased.developerId)) { await purge(orgId, project, h.head.id, "person_erased"); purged.push(h.head.id); continue; }
        await everyVersion(k, h.head.id, (l) => scrubLesson(l, deleted, erased.developerId));
        scrubbed.push(h.head.id);
      }
      await deps.store.forgetSource(k, `member:${erased.developerId}`);
      return { purged, scrubbed };
    },
  };
}

/** A code-supported lesson whose record sources are gone: it needs a person again. A lesson that was only auto-applied goes back to pending with its approval cleared. */
function backToPerson(l: Lesson, now: number): Lesson {
  const personApproved = l.approvals.some((a) => a.mode !== "auto");
  return { ...l, reviewRequired: true, ...(personApproved || l.status !== "active" ? {} : { status: "pending" as const, approvals: [], pendingExpiresAt: pendingExpiry(now) }) };
}
