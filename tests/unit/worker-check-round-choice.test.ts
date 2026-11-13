// TE-B1-fresh: the one place that brings the round kinds together (check-round-choice.ts): which runners a task's official check rounds use, and which its original-code rounds use.
import { describe, expect, it } from "vitest";
import { realModelCallsAllowed, chooseCheckRound } from "../../packages/worker/src/check-round-kind.js";
import { checkRoundRunners, quietWorkingPlace, runnersKind } from "../../packages/worker/src/check-round-choice.js";
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
    expect(chosen).toEqual({ kind: "working", beforeKind: "working", final: base, before: base });
  });
  it("a task with test services keeps today's sealed RUNNERS for both whatever the kind says, but is labelled from the chooser alone (M1): sealed only when the chooser said sealed", () => {
    const base = runners("base");
    const sealed = runners("sealed");
    for (const [kind, label] of [["working", "working"], ["fresh_unsealed", "working"], ["sealed", "sealed"]] as const) {
      const chosen = checkRoundRunners({ kind, testServices: sealedRun(sealed), base, fresh: wiring() });
      expect(chosen.kind, kind).toBe(label);
      expect(chosen.beforeKind, kind).toBe(label);
      expect(chosen.final, kind).toBe(sealed);
      expect(chosen.before, kind).toBe(sealed);
      expect(runnersKind(chosen.final), kind).toBe(label);
    }
  });
  it("M1: a round with test services while the self-test is held reports working, never sealed (through the chooser)", () => {
    const kind = chooseCheckRound({ freshGate: true, testServices: true, sealedCleared: false, devcontainer: false, sandbox: true, candidateCommitted: true });
    expect(checkRoundRunners({ kind, testServices: sealedRun(runners("sealed")), base: runners("base"), fresh: wiring() }).kind).toBe("working");
    const none = chooseCheckRound({ freshGate: false, testServices: true, sealedCleared: false, devcontainer: false, sandbox: true, candidateCommitted: true });
    expect(checkRoundRunners({ kind: none, testServices: sealedRun(runners("sealed")), base: runners("base"), fresh: undefined }).kind).toBe("working");
  });
  it("M3: each runners object has its own kind; the original-code runners are working, so a real model call is never allowed there", () => {
    const base = runners("base");
    const chosen = checkRoundRunners({ kind: "fresh_unsealed", testServices: undefined, base, fresh: wiring() });
    expect(runnersKind(chosen.final)).toBe("fresh_unsealed");
    expect(realModelCallsAllowed(runnersKind(chosen.final))).toBe(true);
    expect(runnersKind(chosen.before)).toBe("working");
    expect(chosen.beforeKind).toBe("working");
    expect(realModelCallsAllowed(runnersKind(chosen.before))).toBe(false);
    expect(runnersKind(runners("unknown"))).toBeUndefined();
    expect(realModelCallsAllowed(runnersKind(runners("unknown")))).toBe(false);
  });
  it("only the fresh round has an evidence source (H1c)", () => {
    const base = runners("base");
    expect(checkRoundRunners({ kind: "fresh_unsealed", testServices: undefined, base, fresh: wiring() }).evidence).toBeDefined();
    expect(checkRoundRunners({ kind: "working", testServices: undefined, base, fresh: undefined }).evidence).toBeUndefined();
    expect(checkRoundRunners({ kind: "sealed", testServices: sealedRun(runners("s")), base, fresh: undefined }).evidence).toBeUndefined();
  });
  it("a sealed kind with no test services run cannot be sealed: it is working", () => {
    const base = runners("base");
    expect(checkRoundRunners({ kind: "sealed", testServices: undefined, base, fresh: undefined }).kind).toBe("working");
  });
});

describe("quietWorkingPlace (H1b)", () => {
  it("stops the worker's leftover processes, then the working sandbox's programs; a failure of either rejects", async () => {
    const calls: string[] = [];
    const docker = { run: (args: readonly string[]) => { calls.push(args[0] === "exec" ? `exec ${args[1]!}` : args[0]!); return Promise.resolve({ exitCode: 0, stdout: "REMAINING:0\n", stderr: "" }); } };
    const quiet = quietWorkingPlace({ docker, rootPath: "/w", sandboxName: "agentx-task-t", stopProcesses: (root) => { calls.push(`stop ${root}`); return Promise.resolve(); } });
    await quiet(new AbortController().signal);
    expect(calls).toEqual(["stop /w", "exec agentx-task-t"]);
    await expect(quietWorkingPlace({ docker, rootPath: "/w", sandboxName: "x", stopProcesses: () => Promise.reject(new Error("no")) })(new AbortController().signal)).rejects.toThrow();
    const left = { run: () => Promise.resolve({ exitCode: 0, stdout: "REMAINING:3\n", stderr: "" }) };
    await expect(quietWorkingPlace({ docker: left, rootPath: "/w", sandboxName: "x", stopProcesses: () => Promise.resolve() })(new AbortController().signal)).rejects.toThrow();
  });
});
