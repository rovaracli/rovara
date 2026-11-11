// Audit events of the record core (R1's `record.*` and `lesson.withdrawn` actions). Ids, fixed words and counts only: never a row's text, a lesson's text or a
// source's name. The caller binds `emit` to the audit outbox (`tryAuditEvent`); a failed emit never blocks a delete (the delete is the privacy duty).
import { createHash } from "node:crypto";
import { SOURCE_WIDENED_WORDS, auditEventId, type AuditEventInput, type SourceWidenedWord } from "@agentx/cloud-contracts";
import { type AuditActor } from "@agentx/cloud-contracts";

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

// ---- the source write route (`source-write.ts`). The actor is the person; the target names the source row by a hash of its project, kind and place (the place itself is not an audit fact);
// the facts are the fixed words the contract lists. `occurrence` is what makes one occurrence unique (a server-made id per write). No second person is asked for (owner decision 2026-11-04):
// a write that widens what is kept (a retention raise, adding above the edition default, a private channel, a DM or a group DM) says so in `widened`, the contract's fixed words joined with commas.
const rowTarget = (project: string, source: string, scope: string) => ({ kind: "record_source" as const, id: createHash("sha256").update(`${project}\0${source}\0${scope}`).digest("hex").slice(0, 40) });
const person = (id: string): AuditActor => ({ kind: "member", id });

interface SourceEventBase { orgId: string; actorId: string; at: string; occurrence: string; project: string; source: string; scope: string }
const sourceBase = (action: "record.source_added" | "record.source_changed" | "record.source_removed", input: SourceEventBase) => ({
  eventId: auditEventId(action, input.occurrence), orgId: input.orgId, action, actor: person(input.actorId), occurredAt: input.at, target: rowTarget(input.project, input.source, input.scope),
});
/** The `widened` fact: present only when the write widened something. The words are the contract's fixed ones, in their fixed order. */
const widenedFact = (widened: readonly SourceWidenedWord[] | undefined) => {
  const set = new Set(widened ?? []);
  const words = SOURCE_WIDENED_WORDS.filter((word) => set.has(word));
  return words.length === 0 ? {} : { widened: words.join(",") };
};

export function auditRecordSourceAdded(input: SourceEventBase & { retention: string; restricted: boolean; widened?: readonly SourceWidenedWord[]; via?: "slack" }): AuditEventInput {
  return { ...sourceBase("record.source_added", input), facts: { source: sourceWord(input.source), retention: input.retention, restricted: input.restricted, ...widenedFact(input.widened), ...(input.via === undefined ? {} : { via: input.via }) } };
}
export function auditRecordSourceChanged(input: SourceEventBase & { fromRetention: string; toRetention: string; enabled: boolean; widened?: readonly SourceWidenedWord[] }): AuditEventInput {
  return { ...sourceBase("record.source_changed", input), facts: { source: sourceWord(input.source), fromRetention: input.fromRetention, toRetention: input.toRetention, enabled: input.enabled, ...widenedFact(input.widened) } };
}
export function auditRecordSourceRemoved(input: SourceEventBase): AuditEventInput {
  return { ...sourceBase("record.source_removed", input), facts: { source: sourceWord(input.source) } };
}
