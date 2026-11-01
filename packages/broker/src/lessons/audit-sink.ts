// Learning v2 wiring (LS-3): the lessons library's audit events written to the broker's audit ledger. The library names more actions than the ledger's contract (`lesson.*` in contracts/audit.ts), each contract
// action with a fixed list of facts. This maps the ones that have a contract name and keeps only the facts that action allows, and never writes an event under another action's name.
// An action with no contract name is either listed in BOOKKEEPING (counters, pauses, votes: it grants nothing, and is skipped for `emitAudit`) or unknown. Under `requireAudit` (the event grants something:
// an approval, a go-live, a rollback, a promotion, a setting loosened) an action with no contract name THROWS, so the change is refused instead of passing with no ledger entry. A test holds that every
// action of the library is either mapped or listed, so a new action cannot be added without a decision.
import { auditEventId, OrgIdSchema, type AuditActor, type AuditEventInput } from "@agentx/contracts";
import type { RecordAuditSink } from "../team-record/audit.js";
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";
import type { LessonAuditAction } from "./types.js";

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
  // A citation that moved, and a duplicate that was merged in, each commit a new version of the lesson's text or lines: recorded as an edit by the system.
  "lesson.citation_moved": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["tier"]) }) },
  "lesson.merged": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["tier"]) }) },
  // Loosening the tier-0 approval setting and the company sole-owner switch (a proposal for a second person, then the change; the exception is audited as such).
  "lesson.tier0_setting_proposed": { action: "lesson.tier0_setting_proposed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromLevel: word(e.facts["from"], "unknown"), toLevel: word(e.facts["to"], "unknown") }) },
  "lesson.tier0_setting_changed": { action: "lesson.tier0_setting_changed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromLevel: word(e.facts["from"], "unknown"), toLevel: word(e.facts["to"], "unknown"), mode: word(e.facts["mode"], "second_person") }) },
  "lesson.sole_owner_switch_proposed": { action: "lesson.sole_owner_switch_proposed", facts: (e) => ({ fromEnabled: e.facts["from"] === true, toEnabled: e.facts["to"] === true }) },
  "lesson.sole_owner_switch_changed": { action: "lesson.sole_owner_switch_changed", facts: (e) => ({ fromEnabled: e.facts["from"] === true, toEnabled: e.facts["to"] === true, mode: word(e.facts["mode"], "second_person") }) },
};

/** Actions with no ledger name on purpose: bookkeeping that grants nothing. Under `emitAudit` they are skipped; under `requireAudit` they would fail, so a grant never uses one. */
export const BOOKKEEPING: readonly LessonAuditAction[] = [
  "lesson.stale", "lesson.retire_proposed", "lesson.wrong_here", "lesson.helpful", "lesson.source_paused", "lesson.source_resumed", "lesson.volume_spike",
  "lesson.contradiction", "lesson.promote_failed", "lesson.held_source_paused", "lesson.tier0_setting_cancelled",
];
/** The actions that have a ledger name. */
export const LEDGERED: readonly LessonAuditAction[] = Object.keys(MAP) as LessonAuditAction[];

/** The ids the ledger accepts for an actor: a member id is the canonical developer id; anything else is the system. */
const actorOf = (actor: string | undefined): AuditActor => (actor !== undefined && /^[a-f0-9]{64}$/u.test(actor) ? { kind: "member", id: actor } : { kind: "system", id: "rovara" });

/** The audit sink for the lessons library over the broker's record audit sink (which writes the pending item and sends it). */
export function lessonAuditSink(write: RecordAuditSink, now: () => number): LessonAuditSink {
  let counter = 0;
  return {
    async emit(event, options) {
      const mapped = MAP[event.action];
      if (mapped === undefined) {
        // An event that grants something and cannot be recorded must not pass; bookkeeping may be skipped.
        if (options?.required === true || !BOOKKEEPING.includes(event.action)) throw new Error(`the ledger has no name for ${event.action}`);
        return;
      }
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
