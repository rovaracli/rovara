// What becomes of a lesson when the record rows it came from are deleted (design 4.4.3): it is WITHDRAWN when every one of its sources is gone, unless a
// valid code citation alone supports it; then it stays, with its record citations removed. A lesson with some sources left stays as it is.
// The lesson store is the learning lane's; this file is the rule and the port it plugs into.
import type { LessonCitation } from "@agentx/contracts";

/** The part of a lesson the rule reads. */
export interface LessonForDeletion {
  id: string;
  version: number;
  status: string;
  citations: readonly LessonCitation[];
  provenance: { sourceEvents: readonly string[] };
  counters: { citationStale: number };
  lastValidatedAt?: string | undefined;
}

export type LessonFate = "untouched" | "keep_without_record_citations" | "withdraw";

/** A valid code citation: the lesson has at least one, was validated against code at least once, and no check has found it stale. */
export function supportedByCode(lesson: LessonForDeletion): boolean {
  return lesson.citations.some((citation) => citation.kind === "code") && lesson.lastValidatedAt !== undefined && lesson.counters.citationStale === 0 && lesson.status === "active";
}

/** `deleted` holds the ids of the deleted rows and facts. A lesson that names none of them is untouched. */
export function lessonFate(lesson: LessonForDeletion, deleted: ReadonlySet<string>): LessonFate {
  const named = [...lesson.provenance.sourceEvents, ...lesson.citations.flatMap((citation) => (citation.kind === "record" ? [citation.eventId] : []))];
  if (!named.some((id) => deleted.has(id))) return "untouched";
  const sources = lesson.provenance.sourceEvents;
  const allGone = sources.length > 0 && sources.every((id) => deleted.has(id));
  if (!allGone) return "keep_without_record_citations";
  return supportedByCode(lesson) ? "keep_without_record_citations" : "withdraw";
}

/** The learning lane's lesson store, from the record core's side. */
export interface LessonDeletionPort {
  /** The project's lessons that are not already withdrawn, retired or rejected and that name any of `deleted` as a source or a record citation. */
  affected(orgId: string, project: string, deleted: ReadonlySet<string>): Promise<LessonForDeletion[]>;
  withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void>;
  /** Removes the record citations of the deleted rows from a lesson that stays (a new version). */
  removeRecordCitations(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>): Promise<void>;
}
