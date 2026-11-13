// TE-B1-fresh: the one place that brings the round kinds together (check-round-choice.ts): which runners a task's official check rounds use, and which its original-code rounds use.
import { describe, expect, it } from "vitest";
import { checkRoundRunners } from "../../packages/worker/src/check-round-choice.js";
import type { TestServicesRun } from "../../packages/worker/src/test-services-run.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";

const runners = (name: string): CheckRunners & { name: string } => ({ name, runProjectCommand: () => Promise.reject(new Error(name)), runAgentCommand: () => Promise.reject(new Error(name)) });
const wiring = (calls: string[][] = []) => ({ seam: { setup: [] }, docker: { run: (args: readonly string[]) => { calls.push([...args]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); } }, rootPath: "/w", taskId: "t", image: "img", candidate: () => Promise.resolve([]), onProgress: () => undefined });
const sealedRun = (made: CheckRunners): TestServicesRun => ({ ids: ["postgres"], checkRunners: () => made, usageRecord: () => Promise.resolve(undefined), dispose: () => Promise.resolve() });

describe("checkRoundRunners", () => {
  it("working: the same runners for both, exactly as today", () => {
    const base = runners("base");
    const chosen = checkRoundRunners({ kind: "working", testServices: undefined, base, fresh: undefined });
    expect(chosen.kind).toBe("working");
    expect(chosen.final).toBe(base);
    expect(chosen.before).toBe(base);
  });
  it("fresh: the official round gets the fresh runners, and the original-code rounds keep the working ones (nothing to export there)", () => {
    const base = runners("base");
    const calls: string[][] = [];
    const chosen = checkRoundRunners({ kind: "fresh_unsealed", testServices: undefined, base, fresh: wiring(calls) });
    expect(chosen.kind).toBe("fresh_unsealed");
    expect(chosen.final).not.toBe(base);
    expect(typeof chosen.final.freshServices).toBe("function");
    expect(typeof chosen.final.endRound).toBe("function");
    expect(chosen.before).toBe(base);
    // nothing starts until a round does
    expect(calls).toEqual([]);
  });
  it("fresh without its wiring is working, never a half-fresh round", () => {
    const base = runners("base");
    const chosen = checkRoundRunners({ kind: "fresh_unsealed", testServices: undefined, base, fresh: undefined });
    expect(chosen).toEqual({ kind: "working", final: base, before: base });
  });
  it("a task with test services keeps today's sealed path for both, whatever the kind says (a plan with dependencies is not moved)", () => {
    const base = runners("base");
    const sealed = runners("sealed");
    for (const kind of ["working", "fresh_unsealed", "sealed"] as const) {
      const chosen = checkRoundRunners({ kind, testServices: sealedRun(sealed), base, fresh: wiring() });
      expect(chosen.kind, kind).toBe("sealed");
      expect(chosen.final, kind).toBe(sealed);
      expect(chosen.before, kind).toBe(sealed);
    }
  });
  it("a sealed kind with no test services run cannot be sealed: it is working", () => {
    const base = runners("base");
    expect(checkRoundRunners({ kind: "sealed", testServices: undefined, base, fresh: undefined }).kind).toBe("working");
  });
});
