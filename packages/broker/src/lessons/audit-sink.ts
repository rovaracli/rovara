// Learning v2 wiring (LS-3): the lessons library's audit events written to the broker's audit ledger. The library names 30 actions; the ledger's contract names 13 (`lesson.*` in contracts/audit.ts), each with
// a fixed list of facts. This maps the ones that have a contract name and keeps only the facts that action allows; an action with no contract name is skipped (it is bookkeeping: counters, merges, pauses),
// and never written under another action's name. The events the library requires (`requireAudit`: approvals, go-live, rollback, promotion) all have a name, so they fail closed when the ledger is down.
import { auditEventId, OrgIdSchema, type AuditActor, type AuditEventInput } from "@agentx/contracts";
import type { RecordAuditSink } from "../team-record/audit.js";
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";

type Mapped = { action: AuditEventInput["action"]; facts: (event: LessonAuditEvent) => Record<string, string | number | boolean> };
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const word = (value: unknown, fallback: string): string => (typeof value === "string" && /^[a-z_]{1,40}$/u.test(value) ? value : fallback);

const MAP: Partial<Record<LessonAuditEvent["action"], Mapped>> = {
  "lesson.candidate_created": { action: "lesson.proposed", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: 1 }) },
  "lesson.pending": { action: "lesson.proposed", facts: (e) => ({ lessonType: "unknown", tier: num(e.facts["tier"]) }) },
  "lesson.approved": { action: "lesson.approved", facts: (e) => ({ tier: num(e.facts["tier"]), approvals: num(e.facts["count"]), soleOwner: false }) },
  "lesson.sole_owner_exception": { action: "lesson.approved", facts: (e) => ({ tier: num(e.facts["tier"]), approvals: 1, soleOwner: true }) },
  "lesson.activated": { action: "lesson.activated", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]), auto: false }) },
  "lesson.auto_applied": { action: "lesson.activated", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]), auto: true }) },
  "lesson.updated": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["fromTier"]) }) },
  "lesson.rejected": { action: "lesson.rejected", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.retired": { action: "lesson.retired", facts: (e) => ({ cause: word(e.facts["cause"], "person"), tier: num(e.facts["tier"]) }) },
  "lesson.auto_retired": { action: "lesson.retired", facts: (e) => ({ cause: "harmful", tier: num(e.facts["tier"]) }) },
  "lesson.expired": { action: "lesson.expired", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.withdrawn": { action: "lesson.withdrawn", facts: (e) => ({ cause: word(e.facts["cause"], "source_deleted") }) },
  "lesson.refused": { action: "lesson.refused", facts: (e) => ({ refusal: word(e.facts["reason"], "refused") }) },
  "lesson.promoted": { action: "lesson.promoted", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.rolled_back": { action: "lesson.rolled_back", facts: (e) => ({ fromSetVersion: num(e.facts["from"]), toSetVersion: num(e.facts["to"]) }) },
};

/** The ids the ledger accepts for an actor: a member id is the canonical developer id; anything else is the system. */
const actorOf = (actor: string | undefined): AuditActor => (actor !== undefined && /^[a-f0-9]{64}$/u.test(actor) ? { kind: "member", id: actor } : { kind: "system", id: "rovara" });

/** The audit sink for the lessons library over the broker's record audit sink (which writes the pending item and sends it). */
export function lessonAuditSink(write: RecordAuditSink, now: () => number): LessonAuditSink {
  let counter = 0;
  return {
    async emit(event) {
      const mapped = MAP[event.action];
      if (mapped === undefined) return;
      const org = OrgIdSchema.safeParse(event.workspaceId);
      if (!org.success) throw new Error("the audit event names no company");
      const at = new Date(now()).toISOString();
      // One event per occurrence: the time and a process counter keep two approvals of one lesson apart.
      counter += 1;
      const lessonId = event.lessonId ?? `${event.project}`;
      await write({
        eventId: auditEventId(mapped.action, lessonId, at, String(counter), event.actor ?? "system"), orgId: org.data, action: mapped.action, actor: actorOf(event.actor),
        target: { kind: "lesson", id: lessonId.slice(0, 100) }, occurredAt: at, facts: mapped.facts(event),
      });
    },
  };
}
