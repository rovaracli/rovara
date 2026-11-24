// Opus P9 review tests (767df9393): guards the lane's own tests left unpinned (reviewer mutants O17, O19) and the FAIL / INCONCLUSIVE split for an
// inconclusive lane outcome that still names a release step.
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.ts";
import { EXEC, OPERATOR, PREFIX, SHA, SLACK, World, input, withReport } from "./fakes.ts";

describe("Opus P9 review: money and HOLD guards", () => {
  it("a claim that was written but is not listed back is not a granted slot: INCONCLUSIVE, no lane start, no pointer", async () => {
    const w = new World();
    w.fillLedger(3);
    w.afterLedgerPut = (world, key) => {
      world.ledger = world.ledger.filter((e) => e.key !== key);
    };
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reason).toContain("ledger");
    expect(w.laneCalls).toEqual([]);
    expect(w.pointerWrites()).toEqual([]);
    expect(w.hold(`code-hold/canary-inconclusive-${EXEC.slice(0, 8)}`)).toBe(true);
  });

  it("a rollback whose own canary fails writes the canary-fail HOLD before any alert", async () => {
    const w = new World();
    w.params.set(`${PREFIX}/code-last-good`, SHA);
    w.params.set(`${PREFIX}/code-hold/rollback-started-${EXEC.slice(0, 8)}`, "{}");
    withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: "S8", costUsd: 0.2 }));
    const r = await runCanary(input({ executionType: "ROLLBACK" }), w.ports());
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    const name = `${PREFIX}/code-hold/canary-fail-${EXEC.slice(0, 8)}`;
    expect(w.params.has(name)).toBe(true);
    const holdAt = w.events.findIndex((e) => e.type === "hold" && e.detail === name);
    const firstAlert = w.events.findIndex((e) => e.type === "alert");
    expect(holdAt).toBeGreaterThanOrEqual(0);
    expect(holdAt).toBeLessThan(firstAlert);
    for (const topic of [OPERATOR, SLACK]) expect(w.alertsTo(topic).some((s) => s.includes("rollback FAILED"))).toBe(true);
  });

  it("a lane FAIL that reports provider-outage or budget-refused is INCONCLUSIVE even when it names a release step (never a rollback)", async () => {
    for (const outcome of ["provider-outage", "budget-refused", "spend-cap"]) {
      const w = new World();
      withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome, firstFailure: "S5", costUsd: 0.1 }));
      const r = await runCanary(input(), w.ports());
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.exitCode).toBe(0);
      expect(r.reason).toContain("not proof either way");
      expect(w.pointerWrites()).toEqual([]);
    }
  });
});
