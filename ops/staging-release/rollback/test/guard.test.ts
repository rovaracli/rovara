/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- evaluator inputs are plain JSON the tests edit at a path */
// P-RB, the rollback-mode guard: target = the recorded last-good (never an unproven run), the HOLD first, one rollback per HOLD, floor, routine in reverse, alerts to both topics.
import { describe, expect, it } from "vitest";
import { guardRollback } from "../src/guard.ts";
import { requestExplicitRollback } from "../src/explicit.ts";
import { runCanary } from "../../canary/src/canary.ts";
import { OPERATOR, PREFIX, SLACK, input as canaryInput, withReport } from "../../canary/test/fakes.ts";
import { evaluate } from "../../evaluator/src/index.ts";
import { POLICY_TEXT, changesOf, CP, detail, hex, row, repin, codeInput } from "../../evaluator/test/fixtures-index.ts";
import { cloneDeep } from "../../evaluator/test/clone.ts";
import { EXEC_A, EXEC_B, EXEC_C, R1, R2, R3, RollbackWorld, SHA_A, SHA_B, SHA_C, ctx, rollbackInput } from "./world.ts";

const hold = (w: RollbackWorld, name: string, exec = R1): boolean => w.hold(`code-hold/${name}-${exec.slice(0, 8)}`);

describe("a routine rollback to the recorded last-good", () => {
  it("proceeds: the HOLD attempt is the FIRST write, the started record is written before it returns, both topics hear 'rollback started'", async () => {
    const w = RollbackWorld.standard();
    const r = await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts());
    expect(r.proceed).toBe(true);
    expect(r.mode).toBe("rollback");
    expect(w.events.filter((e) => e.type === "hold").map((e) => e.detail.slice(e.detail.lastIndexOf("/") + 1))).toEqual([`rollback-attempt-${R1.slice(0, 8)}`, `rollback-started-${R1.slice(0, 8)}`]);
    expect(w.events[0]?.type).toBe("hold");
    for (const topic of [OPERATOR, SLACK]) expect(w.alertsTo(topic).some((s) => s.includes("rollback STARTED"))).toBe(true);
    expect(w.files.get("rollback-guard.json")).toContain('"proceed": true');
    expect(w.pointerWrites()).toEqual([]);
  });
  it("a STANDARD execution passes straight through and touches nothing", async () => {
    const w = RollbackWorld.standard();
    const r = await guardRollback(ctx(EXEC_C, { executionType: "STANDARD" }), null, w.rollbackPorts());
    expect(r).toMatchObject({ proceed: true, mode: "standard" });
    expect(w.events).toEqual([]);
  });
  it("an unknown execution type is refused", async () => {
    const w = RollbackWorld.standard();
    expect((await guardRollback(ctx(R1, { executionType: "REPLAY" }), null, w.rollbackPorts())).proceed).toBe(false);
  });
  it("the audit backlog never blocks it, and the evaluator's alert is published to both topics", async () => {
    const w = RollbackWorld.standard();
    const r = await guardRollback(ctx(), rollbackInput(w, (i) => { i.unauditedAutoRuns = 9; }), w.rollbackPorts());
    expect(r.proceed).toBe(true);
    for (const topic of [OPERATOR, SLACK]) expect(w.alertsTo(topic).some((s) => s.includes("audit-backlog-rollback-allowed"))).toBe(true);
  });
});

describe("the target is the last PASS, never an unproven run", () => {
  it("a native rollback that targets the SKIPPED-CAP run is refused; the explicit rollback to last-good then works and the guard accepts it", async () => {
    const w = RollbackWorld.standard();
    w.executions.set(R1, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_B, sourceSha: SHA_B });
    const refused = await guardRollback(ctx(R1), rollbackInput(w), w.rollbackPorts());
    expect(refused.proceed).toBe(false);
    expect(refused.reasons.join(" ")).toContain("not the recorded last-good execution");
    expect(hold(w, "rollback-attempt")).toBe(true);
    expect(hold(w, "rollback-refused")).toBe(true);
    expect(hold(w, "rollback-started")).toBe(false);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("rollback REFUSED"))).toBe(true);
    expect(w.alertsTo(SLACK).some((s) => s.includes("rollback REFUSED"))).toBe(true);
    const asked = await requestExplicitRollback(ctx(), w.rollbackPorts(), { execute: true });
    expect(asked.requested).toBe(true);
    expect(w.rollbackStageCalls).toEqual([EXEC_A]);
    const ok = await guardRollback(ctx(R2), rollbackInput(w), (w.executions.set(R2, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_A, sourceSha: SHA_A }), w.rollbackPorts()));
    expect(ok.proceed).toBe(true);
  });
  it("end to end with the real canary: PASS (A), SKIPPED-CAP (B), FAIL (C) -> the rollback goes to A, its canary passes, and a second rollback in the HOLD is refused", async () => {
    const w = RollbackWorld.standard();
    for (const k of ["code-installed", "code-last-good", "code-last-good-execution"]) w.params.delete(`${PREFIX}/${k}`);
    for (const h of w.holdNames()) w.params.delete(h);
    w.canaryResults.clear();
    const run = async (sha: string, exec: string): Promise<ReturnType<typeof runCanary>> => {
      w.params.set(`${PREFIX}/code-installed`, sha);
      const r = runCanary(canaryInput({ sha, executionId: exec }), w.ports());
      return r;
    };
    expect((await run(SHA_A, EXEC_A)).outcome).toBe("PASS");
    w.recordCanary(EXEC_A);
    w.fillLedger(16);
    expect((await run(SHA_B, EXEC_B)).outcome).toBe("SKIPPED-CAP");
    w.recordCanary(EXEC_B);
    w.ledger = [];
    w.statusCalls = 0;
    withReport(w, (p) => ({ runId: p.runId, mode: "real", codeSha: p.codeSha, cloudSha: p.cloudSha, result: "FAIL", outcome: "step-failed", firstFailure: "S9", costUsd: 0.3 }));
    expect((await run(SHA_C, EXEC_C)).outcome).toBe("FAIL");
    w.recordCanary(EXEC_C);
    expect(w.params.get(`${PREFIX}/code-last-good`)).toBe(SHA_A);
    expect(w.params.get(`${PREFIX}/code-last-good-execution`)).toBe(EXEC_A);
    expect(hold(w, "canary-fail", EXEC_C)).toBe(true);
    w.executions.set(EXEC_A, { executionType: "STANDARD", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_A });
    w.packages.add(EXEC_A);
    // the native rollback picks B (the last stage success): refused
    w.executions.set(R1, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_B, sourceSha: SHA_B });
    w.executions.set(EXEC_B, { executionType: "STANDARD", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_B });
    expect((await guardRollback(ctx(R1), rollbackInput(w), w.rollbackPorts())).proceed).toBe(false);
    // the explicit rollback names A and the guard accepts it
    w.executions.set(R2, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_A, sourceSha: SHA_A });
    expect((await guardRollback(ctx(R2), rollbackInput(w), w.rollbackPorts())).proceed).toBe(true);
    // the rolled-back release is installed, then its canary (exempt from the cap, even with 16 in the ledger)
    w.params.set(`${PREFIX}/code-installed`, SHA_A);
    w.statusCalls = 0;
    w.lane = (fn, p, world) => (fn === "start" ? (p.op === "install-close" ? { ok: true } : ((world.lastStart = p as any), { runId: p.runId })) : { state: "done", report: { runId: (world.lastStart as any).runId, mode: "real", codeSha: (world.lastStart as any).codeSha, cloudSha: (world.lastStart as any).cloudSha, result: "PASS", costUsd: 0.4, steps: [{ id: "S1", status: "PASS" }] } });
    w.fillLedger(16);
    const pointersBefore = w.pointerWrites().length;
    const rb = await runCanary(canaryInput({ sha: SHA_A, executionId: R2, executionType: "ROLLBACK" }), w.ports());
    expect(rb.outcome).toBe("PASS");
    expect(w.pointerWrites().length).toBe(pointersBefore);
    // a second rollback in this HOLD is refused (the marker of the first is still there)
    w.params.set(`${PREFIX}/code-installed`, SHA_C);
    w.executions.set(R3, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_A, sourceSha: SHA_A });
    const second = await guardRollback(ctx(R3), rollbackInput(w), w.rollbackPorts());
    expect(second.proceed).toBe(false);
    expect(second.reasons.join(" ")).toContain("one automatic rollback per HOLD");
  });
  const target = (edit: (w: RollbackWorld) => void): Promise<{ proceed: boolean; reasons: string[] }> => {
    const w = RollbackWorld.standard();
    edit(w);
    return guardRollback(ctx(), rollbackInput(w), w.rollbackPorts());
  };
  const refusals: [string, (w: RollbackWorld) => void, string][] = [
    ["no last-good recorded", (w) => w.params.delete(`${PREFIX}/code-last-good`), "no last-good sha"],
    ["no last-good execution recorded", (w) => w.params.delete(`${PREFIX}/code-last-good-execution`), "no last-good execution"],
    ["no installed pointer", (w) => w.params.delete(`${PREFIX}/code-installed`), "installed pointer"],
    ["last-good is the installed sha", (w) => w.params.set(`${PREFIX}/code-installed`, SHA_A), "nothing to roll back"],
    ["the target execution did not succeed", (w) => w.executions.set(EXEC_A, { executionType: "STANDARD", status: "Failed", rollbackTargetId: null, sourceSha: SHA_A }), "did not succeed"],
    ["the target's source is another sha", (w) => w.executions.set(EXEC_A, { executionType: "STANDARD", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_B }), "source sha"],
    ["the target is a rollback execution", (w) => w.executions.set(EXEC_A, { executionType: "ROLLBACK", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_A }), "not a STANDARD"],
    ["the target has no canary record", (w) => w.canaryResults.delete(EXEC_A), "no canary record"],
    ["the target's canary was a SKIPPED-CAP", (w) => w.canaryResults.set(EXEC_A, { result: "SKIPPED-CAP", sha: SHA_A, executionId: EXEC_A, executionType: "STANDARD", lastGoodMoved: false }), "not a PASS"],
    ["the target's canary PASS did not move last-good", (w) => w.canaryResults.set(EXEC_A, { result: "PASS", sha: SHA_A, executionId: EXEC_A, executionType: "STANDARD", lastGoodMoved: false }), "not a PASS"],
    ["the target's canary record names another execution", (w) => w.canaryResults.set(EXEC_A, { result: "PASS", sha: SHA_A, executionId: EXEC_B, executionType: "STANDARD", lastGoodMoved: true }), "another sha or execution"],
    ["the target's artifacts are gone", (w) => w.packages.delete(EXEC_A), "artifacts are gone"],
    ["the target execution cannot be read", (w) => w.failExecutionRead.add(EXEC_A), "could not be read"],
    ["CodePipeline does not call this a ROLLBACK", (w) => w.executions.set(R1, { executionType: "STANDARD", status: "InProgress", rollbackTargetId: EXEC_A, sourceSha: SHA_A }), "does not report this execution as a ROLLBACK"],
    ["the rollback names no target", (w) => w.executions.set(R1, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: null, sourceSha: SHA_A }), "no valid target"],
  ];
  for (const [name, edit, text] of refusals) {
    it(`refused: ${name}`, async () => {
      const r = await target(edit);
      expect(r.proceed).toBe(false);
      expect(r.reasons.join(" ")).toContain(text);
    });
  }
});

describe("one rollback per HOLD, and a HOLD always", () => {
  it("a started marker from another execution refuses, even when the input claims no prior rollback and lists no holds (the guard's own reading wins)", async () => {
    const w = RollbackWorld.standard();
    w.params.set(`${PREFIX}/code-hold/rollback-started-99999999`, "{}");
    const r = await guardRollback(ctx(), rollbackInput(w, (i) => { i.holdParameters = []; i.trigger.rollback.priorAutoRollbacksThisHold = 0; }), w.rollbackPorts());
    expect(r.proceed).toBe(false);
    expect(r.reasons.join(" ")).toContain("one automatic rollback per HOLD");
    expect(hold(w, "rollback-started")).toBe(false);
  });
  it("the evaluator is given the holds the guard read (its own attempt marker included), whatever the input lists", async () => {
    const w = RollbackWorld.standard();
    const r = await guardRollback(ctx(), rollbackInput(w, (i) => { i.holdParameters = []; }), w.rollbackPorts());
    expect(r.proceed).toBe(true);
  });
  it("refused attempts do not use up the one rollback", async () => {
    const w = RollbackWorld.standard();
    w.params.set(`${PREFIX}/code-hold/rollback-refused-99999999`, "{}");
    w.params.set(`${PREFIX}/code-hold/rollback-attempt-99999999`, "{}");
    expect((await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts())).proceed).toBe(true);
  });
  it("a retried guard in the same execution is not a second rollback", async () => {
    const w = RollbackWorld.standard();
    expect((await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts())).proceed).toBe(true);
    expect((await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts())).proceed).toBe(true);
  });
  it("a rollback that cannot write its HOLD never proceeds", async () => {
    const w = RollbackWorld.standard();
    w.failHoldWrite = true;
    const r = await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts());
    expect(r.proceed).toBe(false);
    expect(r.reasons.join(" ")).toContain("HOLD could not be written");
  });
  it("a rollback that cannot write its started record never proceeds", async () => {
    const w = RollbackWorld.standard();
    const ports = w.rollbackPorts();
    const put = ports.putHold;
    ports.putHold = (name, value) => (name.includes("rollback-started") ? Promise.reject(new Error("denied")) : put(name, value));
    expect((await guardRollback(ctx(), rollbackInput(w), ports)).proceed).toBe(false);
  });
  it("every new merge stays MANUAL until the HOLD is cleared (the pinned evaluator reads the holds the guard left)", async () => {
    const w = RollbackWorld.standard();
    await guardRollback(ctx(), rollbackInput(w), w.rollbackPorts());
    const push = (holds: string[]): Record<string, any> => {
      const i = cloneDeep(codeInput()) as Record<string, any>;
      i.holdParameters = holds;
      return i;
    };
    expect(w.holdNames().every((h) => h.startsWith(`${PREFIX}/code-hold/`))).toBe(true);
    const held = evaluate(push(w.holdNames()));
    expect(held.verdict).toBe("MANUAL");
    expect(held.reasons.map((r) => r.code)).toContain("hold");
    expect(evaluate(push([])).verdict).toBe("AUTO");
  });
});

describe("the rollback must be routine in reverse (the pinned evaluator, rollback mode)", () => {
  it("a Remove row (the bad release added a resource) stops the rollback: refused, alert, the HOLD stays, nothing deployed", async () => {
    const w = RollbackWorld.standard();
    const r = await guardRollback(ctx(), rollbackInput(w, (i) => { changesOf(i, CP).push(row("Gone", "AWS::DynamoDB::Table", "Remove", null, [], [])); }), w.rollbackPorts());
    expect(r.proceed).toBe(false);
    expect(r.reasons.join(" ")).toContain("non-routine rollback");
    expect(hold(w, "rollback-attempt")).toBe(true);
    expect(hold(w, "rollback-started")).toBe(false);
    expect(w.alertsTo(OPERATOR).some((s) => s.includes("rollback REFUSED"))).toBe(true);
  });
  it("an access-stack row, a target below the floor, and an unknown floor all stop it", async () => {
    const floorSha = hex("f");
    const below = RollbackWorld.standard();
    const bi = rollbackInput(below, (i) => {
      i.policyFiles["rollback-floor.txt"] = `${POLICY_TEXT["rollback-floor.txt"]}\ncode ${floorSha}  # MODEL-QUOTA-AWARE\n`;
      repin(i);
      i.trigger.rollback.floorAncestry = { [floorSha]: false };
    });
    const r = await guardRollback(ctx(), bi, below.rollbackPorts());
    expect(r.proceed).toBe(false);
    expect(r.reasons.join(" ")).toContain("P-RB/below-floor");
    const access = RollbackWorld.standard();
    const ai = rollbackInput(access, (i) => {
      changesOf(i, "agentx-staging-access").push(row("X", "AWS::SSM::Parameter", "Modify", "False", ["Properties"], [detail("Properties", "Value", "/Properties/Value", "DirectModification", "Static")]));
    });
    expect((await guardRollback(ctx(), ai, access.rollbackPorts())).proceed).toBe(false);
  });
  it("an input for another sha, another installed sha, a push-mode trigger or garbage is refused", async () => {
    const edits: ((i: Record<string, any>) => void)[] = [
      (i) => { i.sha = SHA_B; },
      (i) => { i.previousInstalledSha = SHA_B; },
      (i) => { i.pipeline = "cloud"; },
      (i) => { i.trigger = { kind: "push", variables: {}, rollback: null }; },
      (i) => { i.trigger.rollback.lastGoodSha = SHA_B; },
      (i) => { i.trigger.variables = { X: "1" }; },
    ];
    for (const edit of edits) {
      const w = RollbackWorld.standard();
      expect((await guardRollback(ctx(), rollbackInput(w, edit), w.rollbackPorts())).proceed).toBe(false);
    }
    const w = RollbackWorld.standard();
    expect((await guardRollback(ctx(), null, w.rollbackPorts())).proceed).toBe(false);
    expect((await guardRollback(ctx(), "nope", w.rollbackPorts())).proceed).toBe(false);
  });
  it("an evaluator that throws is a refusal", async () => {
    const w = RollbackWorld.standard();
    const ports = w.rollbackPorts();
    ports.evaluate = () => { throw new Error("boom"); };
    expect((await guardRollback(ctx(), rollbackInput(w), ports)).proceed).toBe(false);
  });
  it("an evaluator verdict for another sha is refused", async () => {
    const w = RollbackWorld.standard();
    const ports = w.rollbackPorts();
    ports.evaluate = () => ({ verdict: "AUTO", reasons: [], alerts: [], sha: SHA_B, pipeline: "code" });
    expect((await guardRollback(ctx(), rollbackInput(w), ports)).proceed).toBe(false);
  });
});

describe("the explicit rollback (the fallback role's use)", () => {
  const c = { kind: "code", parameterPrefix: PREFIX, topics: { operator: OPERATOR, slack: SLACK }, s3Path: "s3://runs/" };
  it("a dry run asks for nothing and writes nothing", async () => {
    const w = RollbackWorld.standard();
    const r = await requestExplicitRollback(c, w.rollbackPorts(), { execute: false });
    expect(r).toMatchObject({ requested: false, dryRun: true, reasons: [], targetExecutionId: EXEC_A, sha: SHA_A });
    expect(w.rollbackStageCalls).toEqual([]);
    expect(w.events).toEqual([]);
  });
  it("--execute sets a HOLD first, asks for the last-good execution by name, and alerts both topics", async () => {
    const w = RollbackWorld.standard();
    const r = await requestExplicitRollback(c, w.rollbackPorts(), { execute: true });
    expect(r.requested).toBe(true);
    expect(w.rollbackStageCalls).toEqual([EXEC_A]);
    expect(w.events.findIndex((e) => e.type === "hold")).toBeLessThan(w.events.findIndex((e) => e.type === "rollback-stage"));
    for (const topic of [OPERATOR, SLACK]) expect(w.alertsTo(topic).some((s) => s.includes("rollback REQUESTED"))).toBe(true);
  });
  it("it never targets an unproven or already-used target", async () => {
    const skipped = RollbackWorld.standard();
    skipped.params.set(`${PREFIX}/code-last-good-execution`, EXEC_B);
    expect((await requestExplicitRollback(c, skipped.rollbackPorts(), { execute: true })).requested).toBe(false);
    expect(skipped.rollbackStageCalls).toEqual([]);
    const used = RollbackWorld.standard();
    used.params.set(`${PREFIX}/code-hold/rollback-started-99999999`, "{}");
    const r = await requestExplicitRollback(c, used.rollbackPorts(), { execute: true });
    expect(r.requested).toBe(false);
    expect(r.reasons.join(" ")).toContain("one automatic rollback per HOLD");
    const none = RollbackWorld.standard();
    none.params.delete(`${PREFIX}/code-last-good`);
    expect((await requestExplicitRollback(c, none.rollbackPorts(), { execute: true })).requested).toBe(false);
  });
  it("a HOLD that cannot be written stops the request before it asks", async () => {
    const w = RollbackWorld.standard();
    w.failHoldWrite = true;
    expect((await requestExplicitRollback(c, w.rollbackPorts(), { execute: true })).requested).toBe(false);
    expect(w.rollbackStageCalls).toEqual([]);
  });
  it("an invalid kind is refused", async () => {
    const w = RollbackWorld.standard();
    expect((await requestExplicitRollback({ ...c, kind: "prod" }, w.rollbackPorts(), { execute: true })).requested).toBe(false);
  });
});
