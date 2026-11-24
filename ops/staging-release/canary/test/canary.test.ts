// The Canary action: each outcome, the cap at 16 (the 17th skips and says so), HOLD writes, the last-good pointer only on a PASS, alerts to both topics, rollback-mode canary.
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.ts";
import { claimSlot } from "../src/ledger.ts";
import { EXEC, HOUR, OPERATOR, OTHER, PREFIX, SHA, SLACK, World, input, passReport, withReport, EXEC2, type LaneRunPayload } from "./fakes.ts";

const holdOf = (w: World, name: string): boolean => w.hold(`code-hold/${name}-${EXEC.slice(0, 8)}`);

/** Every non-PASS outcome must leave both pointers exactly as they were and write no pointer at all. */
function expectNoPointerWrites(w: World): void {
  expect(w.pointerWrites()).toEqual([]);
  expect(w.params.has(`${PREFIX}/code-last-good`)).toBe(false);
  expect(w.params.has(`${PREFIX}/code-last-good-execution`)).toBe(false);
}

describe("PASS", () => {
  it("moves last-good (execution id first, then the sha), exits 0, claims one ledger slot, sends no alert", async () => {
    const w = new World();
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("PASS");
    expect(r.exitCode).toBe(0);
    expect(r.lastGoodMoved).toBe(true);
    expect(w.pointerWrites()).toEqual([`code-last-good-execution=${EXEC}`, `code-last-good=${SHA}`]);
    expect(w.ledger).toHaveLength(1);
    expect(w.published).toEqual([]);
    expect(w.holdNames()).toEqual([]);
    expect(w.result()).toMatchObject({ result: "PASS", lastGoodMoved: true, sha: SHA, executionId: EXEC, executionType: "STANDARD" });
  });
  it("names both shas to the lane: a Code release brings the live Cloud sha, a Cloud release the live Code sha, always mode real", async () => {
    const w = new World();
    await runCanary(input(), w.ports());
    expect(w.lastStart).toMatchObject({ mode: "real", codeSha: SHA, cloudSha: OTHER });
    const c = new World();
    c.params.set(`${PREFIX}/cloud-installed`, SHA);
    c.params.set(`${PREFIX}/code-installed`, OTHER);
    await runCanary(input({ kind: "cloud" }), c.ports());
    expect(c.lastStart).toMatchObject({ mode: "real", codeSha: OTHER, cloudSha: SHA });
    expect(c.params.get(`${PREFIX}/cloud-last-good`)).toBe(SHA);
  });
  it("closes the pipeline's install marker before it starts the lane, with one invoke per call and no secret anywhere", async () => {
    const w = new World();
    await runCanary(input(), w.ports());
    expect(w.laneCalls[0]).toMatchObject({ fn: "start", payload: { op: "install-close" } });
    expect(w.laneCalls[1]?.payload.mode).toBe("real");
    expect(JSON.stringify(w.laneCalls)).not.toMatch(/secret|token|credential/i);
  });
  it("a PASS with Lambda Errors above 0 during the canary is not proof (INCONCLUSIVE + HOLD, last-good stays)", async () => {
    const w = new World();
    w.lambdaErrorCount = 2;
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.exitCode).toBe(0);
    expectNoPointerWrites(w);
    expect(holdOf(w, "canary-inconclusive")).toBe(true);
  });
  it("Lambda Errors that cannot be read is INCONCLUSIVE too", async () => {
    const w = new World();
    w.lambdaErrorCount = null;
    expect((await runCanary(input(), w.ports())).outcome).toBe("INCONCLUSIVE");
    expectNoPointerWrites(w);
  });
  it("a PASS that cost more than the 1 USD cap is a FAIL (the money control broke)", async () => {
    const w = new World();
    withReport(w, (run) => passReport(run, { costUsd: 1.4 }));
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    expectNoPointerWrites(w);
  });
  it("if the installed pointer changed during the canary, last-good is not moved", async () => {
    const w = new World();
    let calls = 0;
    w.lane = (fn, payload, world) => {
      if (fn === "status" && ++calls === 1) world.params.set(`${PREFIX}/code-installed`, "c".repeat(40));
      return passThrough(fn, payload, world);
    };
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expectNoPointerWrites(w);
  });
  it("a failed last-good write after a PASS is INCONCLUSIVE with a HOLD (never a silent PASS)", async () => {
    const w = new World();
    w.failPointerWrite = true;
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.lastGoodMoved).toBe(false);
    expect(holdOf(w, "canary-inconclusive")).toBe(true);
  });
});

function passThrough(fn: "start" | "status", payload: Record<string, unknown>, w: World): unknown {
  if (fn === "start") {
    if (payload.op === "install-close") return { ok: true };
    w.lastStart = payload as unknown as LaneRunPayload;
    return { runId: payload.runId };
  }
  return { state: "done", report: passReport(w.lastStart as LaneRunPayload) };
}

describe("FAIL", () => {
  const failing = (w: World, step = "S8", extra: Record<string, unknown> = {}): void =>
    withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: step, costUsd: 0.3, steps: [{ id: step, status: "FAIL" }], ...extra }));
  it("writes the HOLD BEFORE the alerts, alerts both topics, exits 1, and never moves last-good", async () => {
    const w = new World();
    failing(w);
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    expectNoPointerWrites(w);
    expect(holdOf(w, "canary-fail")).toBe(true);
    const holdAt = w.events.findIndex((e) => e.type === "hold");
    const alertAt = w.events.findIndex((e) => e.type === "alert");
    expect(holdAt).toBeGreaterThanOrEqual(0);
    expect(holdAt).toBeLessThan(alertAt);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("canary FAIL"))).toBe(true);
    expect(w.alertsTo(SLACK).some((s) => s.includes("canary FAIL"))).toBe(true);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("HOLD set"))).toBe(true);
  });
  it("each release-caused step fails the canary", async () => {
    for (const step of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S13"]) {
      const w = new World();
      failing(w, step);
      expect((await runCanary(input(), w.ports())).outcome, step).toBe("FAIL");
    }
  });
  it("the watchdog stop and an over-cap report are FAILs", async () => {
    for (const outcome of ["budget-near-cap", "over-cap"]) {
      const w = new World();
      failing(w, "S8", { outcome });
      expect((await runCanary(input(), w.ports())).outcome, outcome).toBe("FAIL");
    }
  });
  it("a FAIL whose HOLD cannot be written exits 4, not quietly", async () => {
    const w = new World();
    failing(w);
    w.failHoldWrite = true;
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(4);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("HOLD could not be written"))).toBe(true);
  });
});

describe("INCONCLUSIVE: exit 0 and a HOLD, never a rollback, never a PASS", () => {
  const cases: [string, (w: World) => void][] = [
    ["the lane refuses on budget (budget-refused)", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "budget-refused", firstFailure: "S1", costUsd: 0 }))],
    ["a provider outage", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "provider-outage", firstFailure: "S3", costUsd: 0.1 }))],
    ["step S0 (the lane's own precondition) failing", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: "S0", costUsd: 0 }))],
    ["step S12 failing", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: "S12", costUsd: 0 }))],
    ["an unknown lane outcome", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "surprise", firstFailure: "S8", costUsd: 0.1 }))],
    ["a FAIL with no failing step", (w) => withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", costUsd: 0.1 }))],
    ["a report for another run", (w) => withReport(w, (run) => passReport(run, { runId: "someone-else" }))],
    ["a report that names other shas", (w) => withReport(w, (run) => passReport(run, { codeSha: "d".repeat(40) }))],
    ["a dry-run report", (w) => withReport(w, (run) => passReport(run, { mode: "dry" }))],
    ["a PASS where a step did not pass", (w) => withReport(w, (run) => passReport(run, { steps: [{ id: "S1", status: "PASS" }, { id: "S8", status: "FAIL" }] }))],
    ["a PASS with no steps", (w) => withReport(w, (run) => passReport(run, { steps: [] }))],
    ["a PASS with an outcome", (w) => withReport(w, (run) => passReport(run, { outcome: "budget-refused" }))],
    ["a PASS with no readable cost", (w) => withReport(w, (run) => passReport(run, { costUsd: "free" }))],
    ["a report that is not an object", (w) => withReport(w, () => "PASS")],
    ["a result that is neither PASS nor FAIL", (w) => withReport(w, (run) => passReport(run, { result: "OK" }))],
    ["the lane being unreachable at install-close", (w) => { w.lane = () => { throw new Error("no route"); }; }],
    ["a lane that refuses (not-configured)", (w) => { w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { refusal: "not-configured" } : { ok: true }); }],
    ["a lane that refuses the spend cap", (w) => { w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { refusal: "spend-cap" } : { ok: true }); }],
    ["a start answer for another run", (w) => { w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { runId: "x" } : { ok: true }); }],
    ["a lane that stays busy", (w) => { w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { refusal: "lock-busy" } : { ok: true }); }],
    ["an install marker that stays open", (w) => { w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { refusal: "install-open" } : { ok: true }); }],
    ["a status call that keeps failing", (w) => { w.lane = (fn, p, world) => { if (fn === "status") throw new Error("boom"); return passThrough(fn, p, world); }; }],
    ["a status answer that is garbage three times", (w) => { w.lane = (fn, p, world) => (fn === "status" ? "garbage" : passThrough(fn, p, world)); }],
    ["a lane that never finishes (no answer in time)", (w) => { w.lane = (fn, p, world) => (fn === "status" ? { state: "running" } : passThrough(fn, p, world)); }],
    ["a status answer in an unknown state three times", (w) => { w.lane = (fn, p, world) => (fn === "status" ? { state: "paused" } : passThrough(fn, p, world)); }],
    ["a lane refusing the install-close", (w) => { w.lane = () => ({ refusal: "lock-busy" }); }],
  ];
  for (const [name, setup] of cases) {
    it(name, async () => {
      const w = new World();
      setup(w);
      const r = await runCanary(input(), w.ports());
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.exitCode).toBe(0);
      expectNoPointerWrites(w);
      expect(holdOf(w, "canary-inconclusive")).toBe(true);
      expect(w.alertsTo(OPERATOR).some((s) => s.includes("canary INCONCLUSIVE"))).toBe(true);
      expect(w.alertsTo(SLACK).some((s) => s.includes("canary INCONCLUSIVE"))).toBe(true);
      expect(w.result()).toMatchObject({ result: "INCONCLUSIVE", exitCode: 0 });
    });
  }
  it("a busy lane is waited for (bounded) before it gives up", async () => {
    const w = new World();
    let busy = 2;
    w.lane = (fn, p, world) => (fn === "start" && p.op !== "install-close" && busy-- > 0 ? { refusal: "lock-busy" } : passThrough(fn, p, world));
    expect((await runCanary(input(), w.ports())).outcome).toBe("PASS");
    expect(busy).toBeLessThan(0);
  });
  it("a single failed status call is tolerated", async () => {
    const w = new World();
    let n = 0;
    w.lane = (fn, p, world) => {
      if (fn === "status" && n++ === 0) throw new Error("blip");
      return passThrough(fn, p, world);
    };
    expect((await runCanary(input(), w.ports())).outcome).toBe("PASS");
  });
  it("the installed pointer is not the sha under test", async () => {
    const w = new World();
    w.params.set(`${PREFIX}/code-installed`, "c".repeat(40));
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(w.laneCalls).toEqual([]);
    expect(w.ledger).toEqual([]);
    expectNoPointerWrites(w);
  });
  it("the other pipeline's installed sha is missing or malformed", async () => {
    for (const value of [null, "short"]) {
      const w = new World();
      if (value === null) w.params.delete(`${PREFIX}/cloud-installed`);
      else w.params.set(`${PREFIX}/cloud-installed`, value);
      expect((await runCanary(input(), w.ports())).outcome).toBe("INCONCLUSIVE");
      expect(w.laneCalls).toEqual([]);
    }
  });
  it("an unreadable cap ledger means no canary is started (no spend)", async () => {
    const w = new World();
    w.failLedgerList = true;
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(w.laneCalls).toEqual([]);
  });
  it("a HOLD that cannot be written exits 4", async () => {
    const w = new World();
    w.failHoldWrite = true;
    w.lane = () => { throw new Error("no route"); };
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.exitCode).toBe(4);
  });
  it("invalid input is INCONCLUSIVE with a HOLD, and an invalid kind (no hold possible) exits 4", async () => {
    for (const bad of [{ sha: "xyz" }, { executionId: "nope" }, { executionType: "" }, { executionType: "REPLAY" }, { parameterPrefix: "/prod" }, { topics: { operator: null, slack: SLACK } }]) {
      const w = new World();
      const r = await runCanary(input(bad), w.ports());
      expect(r.outcome, JSON.stringify(bad)).toBe("INCONCLUSIVE");
      expect(r.exitCode).toBe(0);
      expect(w.laneCalls).toEqual([]);
    }
    const w = new World();
    const r = await runCanary(input({ kind: "prod" }), w.ports());
    expect(r.exitCode).toBe(4);
    expect(w.laneCalls).toEqual([]);
  });
});

describe("SKIPPED-CAP: 16 canaries per rolling 24 h across both pipelines", () => {
  it("the 16th canary runs, the 17th skips and says so", async () => {
    const w = new World();
    w.fillLedger(15);
    const sixteenth = await runCanary(input(), w.ports());
    expect(sixteenth.outcome).toBe("PASS");
    w.lastStart = null;
    w.statusCalls = 0;
    w.laneCalls = [];
    w.params.set(`${PREFIX}/code-installed`, "c".repeat(40));
    const seventeenth = await runCanary(input({ executionId: EXEC2, sha: "c".repeat(40) }), w.ports());
    expect(seventeenth.outcome).toBe("SKIPPED-CAP");
    expect(seventeenth.exitCode).toBe(0);
    expect(w.laneCalls).toEqual([]);
    expect(seventeenth.cap).toEqual({ limit: 16, n: 16 });
  });
  it("says so in the result, the stage summary, and an alert to both topics, and moves no pointer and sets no HOLD", async () => {
    const w = new World();
    w.fillLedger(16);
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("SKIPPED-CAP");
    expectNoPointerWrites(w);
    expect(w.holdNames()).toEqual([]);
    expect(w.files.get("summary.txt")).toContain("canary skipped: cap 16/24h reached (n=16)");
    expect(w.result()).toMatchObject({ result: "SKIPPED-CAP", lastGoodMoved: false, cap: { limit: 16, n: 16 } });
    for (const topic of [OPERATOR, SLACK]) expect(w.alertsTo(topic).some((s) => s.includes("canary skipped: cap 16/24h reached"))).toBe(true);
    const slack = JSON.parse(w.published.find((p) => p.topic === SLACK)?.message ?? "{}") as { content: { description: string } };
    expect(slack.content.description).toContain("canary skipped: cap 16/24h reached (n=16)");
  });
  it("entries older than 24 h do not count; a fresh one inside does", async () => {
    const w = new World();
    w.fillLedger(10, { ageMs: 25 * HOUR });
    w.fillLedger(15);
    expect((await runCanary(input(), w.ports())).outcome).toBe("PASS");
    const w2 = new World();
    w2.fillLedger(1, { ageMs: 23 * HOUR + 59 * 60_000 });
    w2.fillLedger(15, { ageMs: 25 * HOUR });
    w2.fillLedger(15);
    expect((await runCanary(input(), w2.ports())).outcome).toBe("SKIPPED-CAP");
  });
  it("the ledger is shared: Code and Cloud canaries count together", async () => {
    const w = new World();
    w.fillLedger(8, { kind: "code" });
    w.fillLedger(8, { kind: "cloud" });
    expect((await runCanary(input(), w.ports())).outcome).toBe("SKIPPED-CAP");
  });
  it("rollback canaries are not counted against the cap", async () => {
    const w = new World();
    w.fillLedger(20, { rollback: true });
    w.fillLedger(15);
    expect((await runCanary(input(), w.ports())).outcome).toBe("PASS");
  });
  it("a retry of the same execution reuses its claim instead of claiming twice", async () => {
    const w = new World();
    w.fillLedger(14);
    await runCanary(input(), w.ports());
    const claims = w.ledger.length;
    w.statusCalls = 0;
    await runCanary(input(), w.ports());
    expect(w.ledger.length).toBe(claims);
  });
  it("a skipped run leaves nothing for last-good: a FAIL afterwards rolls back to the last PASS (see the rollback tests)", async () => {
    const w = new World();
    w.fillLedger(16);
    expect((await runCanary(input(), w.ports())).outcome).toBe("SKIPPED-CAP");
    expect(w.params.has(`${PREFIX}/code-last-good-execution`)).toBe(false);
  });
  it("the lane's own counter running out is a cap too, not a PASS", async () => {
    const w = new World();
    w.lane = (fn, p) => (fn === "start" && p.op !== "install-close" ? { refusal: "counter-exhausted" } : { ok: true });
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("INCONCLUSIVE");
    expectNoPointerWrites(w);
  });
});

describe("the claim race: the slot is decided after the claim is written", () => {
  it("two claims in the same second at 15 existing: both skip (a tie counts both), never both run", async () => {
    const w = new World();
    w.fillLedger(14);
    const key2 = `canary-ledger/${"20261123T120000Z"}-cloud-${EXEC2}`;
    let injected = false;
    w.afterLedgerPut = (world, key) => {
      if (injected || key.includes(EXEC2)) return;
      injected = true;
      world.ledger.push({ key: key2, lastModifiedMs: world.now });
    };
    w.fillLedger(1, { ageMs: 10 * 60_000 });
    const mine = await claimSlot(w.ports(), "code", EXEC);
    expect(mine.state).toBe("cap");
  });
  it("a competitor that wrote later never takes an earlier claim's slot", async () => {
    const w = new World();
    w.fillLedger(15);
    w.afterLedgerPut = (world) => {
      world.now += 5000;
      world.ledger.push({ key: `canary-ledger/20261123T120005Z-cloud-${EXEC2}`, lastModifiedMs: world.now });
      world.now -= 5000;
    };
    const mine = await claimSlot(w.ports(), "code", EXEC);
    expect(mine.state).toBe("granted");
  });
});

describe("alerts reach both topics and a delivery problem is never silent or fatal", () => {
  it("the operator topic failing does not stop the Slack topic, and the failure is recorded", async () => {
    const w = new World();
    w.fillLedger(16);
    w.failTopics.add(OPERATOR);
    const r = await runCanary(input(), w.ports());
    expect(r.outcome).toBe("SKIPPED-CAP");
    expect(w.alertsTo(SLACK).length).toBeGreaterThan(0);
    expect(r.alertDelivery[0]?.operator).toMatch(/^failed/);
    expect(r.alertDelivery[0]?.slack).toBe("ok");
  });
  it("Slack not configured is said in the summary and the email still goes", async () => {
    const w = new World();
    w.fillLedger(16);
    const r = await runCanary(input({ topics: { operator: OPERATOR, slack: null } }), w.ports());
    expect(r.alertDelivery[0]?.slack).toBe("not-configured");
    expect(w.files.get("summary.txt")).toContain("Slack: not configured");
    expect(w.alertsTo(OPERATOR).length).toBeGreaterThan(0);
  });
  it("alert text is plain ASCII, one short email subject, a Chatbot custom notification for Slack", async () => {
    const w = new World();
    w.fillLedger(16);
    await runCanary(input(), w.ports());
    for (const p of w.published) {
      expect(p.subject.length).toBeLessThanOrEqual(100);
      expect(p.subject).toMatch(/^[\x20-\x7e]+$/);
      expect(p.message).not.toContain("\u2014");
    }
    const chatbot = JSON.parse(w.published.find((p) => p.topic === SLACK)?.message ?? "{}") as Record<string, unknown>;
    expect(chatbot).toMatchObject({ version: "1.0", source: "custom" });
  });
});

describe("rollback-mode canary (P-RB)", () => {
  const rollbackWorld = (): World => {
    const w = new World();
    w.params.set(`${PREFIX}/code-last-good`, SHA);
    w.params.set(`${PREFIX}/code-hold/rollback-started-${EXEC.slice(0, 8)}`, "{}");
    return w;
  };
  const rb = () => input({ executionType: "ROLLBACK" });
  it("a passing rolled-back release alerts 'rollback finished', moves no pointer, is exempt from the cap and records a rollback ledger entry", async () => {
    const w = rollbackWorld();
    w.fillLedger(16);
    const r = await runCanary(rb(), w.ports());
    expect(r.outcome).toBe("PASS");
    expect(r.exitCode).toBe(0);
    expect(w.pointerWrites()).toEqual([]);
    expect(w.ledger.some((e) => e.key.includes("canary-ledger/rollback-"))).toBe(true);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("rollback finished"))).toBe(true);
    expect(w.alertsTo(SLACK).some((s) => s.includes("rollback finished"))).toBe(true);
  });
  it("a rollback whose canary fails alerts 'rollback failed', exits 1 and moves no pointer", async () => {
    const w = rollbackWorld();
    withReport(w, (run) => ({ runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: "S8", costUsd: 0.2 }));
    const r = await runCanary(rb(), w.ports());
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    expect(w.pointerWrites()).toEqual([]);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("rollback FAILED"))).toBe(true);
  });
  it("without the guard's rollback-started record, or on a sha that is not last-good, it is INCONCLUSIVE", async () => {
    const a = rollbackWorld();
    a.params.delete(`${PREFIX}/code-hold/rollback-started-${EXEC.slice(0, 8)}`);
    expect((await runCanary(rb(), a.ports())).outcome).toBe("INCONCLUSIVE");
    expect(a.laneCalls).toEqual([]);
    const b = rollbackWorld();
    b.params.set(`${PREFIX}/code-last-good`, "e".repeat(40));
    expect((await runCanary(rb(), b.ports())).outcome).toBe("INCONCLUSIVE");
    expect(b.laneCalls).toEqual([]);
  });
});
