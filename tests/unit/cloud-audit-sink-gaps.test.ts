// Convergence A7: what the core's audit events cannot say yet is listed once (`cloud/adapters/audit-sink/gaps.ts`), each owed upstream by a date. An entry past its date fails here, so it cannot sit unseen.
import { describe, expect, it } from "vitest";
import { AUDIT_SINK_GAPS } from "../../packages/broker/src/cloud/adapters/audit-sink/index.js";

describe("the audit sink's owed-upstream list", () => {
  it("gives every gap an id, an action, a date, what is missing and what the adapter does meanwhile, once each", () => {
    expect(new Set(AUDIT_SINK_GAPS.map((gap) => gap.id)).size).toBe(AUDIT_SINK_GAPS.length);
    for (const gap of AUDIT_SINK_GAPS) {
      expect(gap.owedUntil, gap.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(gap.what.length, gap.id).toBeGreaterThan(20);
      expect(gap.meanwhile.length, gap.id).toBeGreaterThan(20);
    }
  });

  it("has no gap past its date (the day itself is still allowed)", () => {
    const late = AUDIT_SINK_GAPS.filter((gap) => Date.now() > Date.parse(`${gap.owedUntil}T23:59:59.999Z`)).map((gap) => gap.id);
    expect(late, "change Code's port (then move the vendor pin) or, with the owner's word, move the date").toEqual([]);
  });
});
