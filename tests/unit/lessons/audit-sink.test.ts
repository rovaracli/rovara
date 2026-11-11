// S2 of the wire-lessons review: the audit sink must never pass an event that grants something without writing it. Every action of the library is either given a ledger name or listed as bookkeeping,
// an unmapped action under `requireAudit` fails (so the change is refused), and the moved-citation and merge events reach the ledger.
import { describe, expect, it } from "vitest";
import { AuditEventInputSchema } from "@agentx/cloud-contracts";
import { BOOKKEEPING, LEDGERED, lessonAuditSink } from "../../../packages/broker/src/lessons/audit-sink.js";
import { emitAudit, requireAudit } from "../../../packages/broker/src/lessons/policy.js";
import { LESSON_AUDIT_ACTIONS, type LessonAuditAction } from "../../../packages/broker/src/lessons/types.js";
import { PROJECT, WS } from "./lesson-helpers.js";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const event = (action: LessonAuditAction, facts: Record<string, string | number | boolean> = {}) => ({ action, workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", actor: "a".repeat(64), facts });
function sink() {
  const written: unknown[] = [];
  return { written, sink: lessonAuditSink(async (e) => { written.push(e); }, () => NOW) };
}

describe("the audit sink decides every action of the library", () => {
  it("each action is either given a ledger name or listed as bookkeeping, never both", () => {
    for (const action of LESSON_AUDIT_ACTIONS) {
      const ledgered = LEDGERED.includes(action), skipped = BOOKKEEPING.includes(action);
      expect(ledgered !== skipped, `${action}: ledgered=${String(ledgered)} bookkeeping=${String(skipped)}`).toBe(true);
    }
  });
  it("each ledgered action writes an event the ledger's contract accepts", async () => {
    for (const action of LEDGERED) {
      const s = sink();
      await s.sink.emit(event(action, { tier: 1, count: 2, scope: "project", from: "one", to: "auto", mode: "second_person", type: "convention", cause: "person", reason: "refused", citations: 1 }));
      expect(s.written, action).toHaveLength(1);
      expect(AuditEventInputSchema.safeParse(s.written[0]).success, action).toBe(true);
    }
  });
  it("the three the review named reach the ledger: both tier-0 setting events and a moved citation", async () => {
    for (const [action, expected] of [["lesson.tier0_setting_proposed", "lesson.tier0_setting_proposed"], ["lesson.tier0_setting_changed", "lesson.tier0_setting_changed"], ["lesson.citation_moved", "lesson.edited"]] as const) {
      const s = sink();
      expect(await requireAudit(s.sink, event(action, { scope: "company", from: "one", to: "auto", mode: "direct", tier: 1, citations: 2 }))).toBe(true);
      expect(s.written).toHaveLength(1);
      expect((s.written[0] as { action: string }).action).toBe(expected);
    }
  });
});

describe("an action with no ledger name under requireAudit fails closed", () => {
  it("returns false and writes nothing, for every bookkeeping action", async () => {
    for (const action of BOOKKEEPING) {
      const s = sink();
      expect(await requireAudit(s.sink, event(action)), action).toBe(false);
      expect(s.written, action).toHaveLength(0);
    }
  });
  it("an action the sink has never heard of is refused the same way", async () => {
    const s = sink();
    expect(await requireAudit(s.sink, event("lesson.brand_new" as never))).toBe(false);
    expect(s.written).toHaveLength(0);
  });
  it("bookkeeping stays best-effort under emitAudit: skipped, no error", async () => {
    const s = sink();
    await expect(emitAudit(s.sink, event("lesson.helpful"))).resolves.toBeUndefined();
    expect(s.written).toHaveLength(0);
  });
});
