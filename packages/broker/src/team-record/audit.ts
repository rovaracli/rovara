// Audit events of the record core (R1's `record.*` and `lesson.withdrawn` actions). Ids, fixed words and counts only: never a row's text, a lesson's text or a
// source's name. The caller binds `emit` to the audit outbox (`tryAuditEvent`); a failed emit never blocks a delete (the delete is the privacy duty).
import { auditEventId, type AuditActor, type AuditEventInput } from "@agentx/contracts";

export type RecordAuditSink = (event: AuditEventInput) => Promise<void>;

const SYSTEM: AuditActor = { kind: "system", id: "rovara" };
const SOURCE_WORD = /^(slack|github|linear|jira|mcp|rovara|codehost)/;

/** A fixed word for a scope or source system: its prefix when it is one of ours, else `unknown`. */
export function sourceWord(value: string | undefined): string {
  return (value === undefined ? undefined : SOURCE_WORD.exec(value)?.[1]) ?? "unknown";
}

const base = (orgId: string, at: string) => ({ orgId, actor: SYSTEM, occurredAt: at });

/** `occurrence`: the queue item's request id. The rows of a source item or scope were hidden and then deleted. */
export function auditRecordTombstoned(input: { orgId: string; requestId: string; at: string; scopeOrSource: string; cause: string; count: number }): AuditEventInput {
  return {
    eventId: auditEventId("record.tombstoned", input.requestId), ...base(input.orgId, input.at), action: "record.tombstoned",
    target: { kind: "record_source", id: input.requestId.slice(0, 100) }, facts: { source: sourceWord(input.scopeOrSource), cause: input.cause, count: input.count },
  };
}

/** `occurrence`: a request id of the erase. Counts of what was removed, by kind. */
export function auditRecordErased(input: { orgId: string; occurrence: string; at: string; cause: "person_erased" | "project_archived" | "org_closed"; rows: number; facts: number; lessons: number; vectors: number }): AuditEventInput {
  return {
    eventId: auditEventId("record.erased", input.occurrence), ...base(input.orgId, input.at), action: "record.erased",
    target: { kind: "record_source", id: input.occurrence.slice(0, 100) }, facts: { cause: input.cause, rows: input.rows, facts: input.facts, lessons: input.lessons, vectors: input.vectors },
  };
}

/** `occurrence`: the lesson id and its version. */
export function auditLessonWithdrawn(input: { orgId: string; lessonId: string; version: number; at: string; cause: string }): AuditEventInput {
  return {
    eventId: auditEventId("lesson.withdrawn", input.lessonId, String(input.version)), ...base(input.orgId, input.at), action: "lesson.withdrawn",
    target: { kind: "lesson", id: input.lessonId }, facts: { cause: input.cause },
  };
}
