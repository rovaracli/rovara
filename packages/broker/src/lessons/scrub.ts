// Learning v2: the pure rewrite of a lesson without deleted record ids and, when given, without erased people (ids compared by the one normaliser).
import { ERASED_MARK, normId, type Lesson } from "./types.js";

/** The lesson without the deleted ids (sources and record citations), and, if given, without the person. Citation checks are re-indexed. Pure. */
export function scrubLesson(lesson: Lesson, deleted: ReadonlySet<string>, dev?: string | ReadonlySet<string>): Lesson {
  const people = dev === undefined ? undefined : typeof dev === "string" ? new Set([normId(dev)]) : new Set([...dev].map(normId));
  const gone = (id: string): boolean => people !== undefined && people.has(normId(id));
  const citations = lesson.citations.filter((c) => c.kind !== "record" || !deleted.has(c.eventId));
  const kept = lesson.citations.flatMap((c, index) => (citations.includes(c) ? [index] : []));
  const checks = (lesson.citationChecks ?? []).flatMap((check) => { const at = kept.indexOf(check.index); return at < 0 ? [] : [{ ...check, index: at }]; });
  const out: Lesson = { ...lesson, citations, provenance: { ...lesson.provenance, sourceEvents: lesson.provenance.sourceEvents.filter((id) => !deleted.has(id)) } };
  if (checks.length > 0) out.citationChecks = checks; else delete (out as { citationChecks?: unknown }).citationChecks;
  if (people !== undefined) {
    out.provenance = {
      ...out.provenance, authors: out.provenance.authors.filter((a) => !gone(a)), sources: out.provenance.sources.filter((s) => !(s.startsWith("member:") && gone(s.slice(7)))),
      inputSources: out.provenance.inputSources.filter((s) => !(s.startsWith("member:") && gone(s.slice(7)))),
    };
    out.approvals = out.approvals.map((a) => (gone(a.by) ? { ...a, by: ERASED_MARK } : a));
    if (out.promotionApprovals !== undefined) out.promotionApprovals = out.promotionApprovals.map((a) => (gone(a.by) ? { ...a, by: ERASED_MARK } : a));
  }
  return out;
}
