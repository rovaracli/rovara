// TE-B1-fresh: the one place that brings the round kinds together (check-round-choice.ts): which runners a task's official check rounds use, and which its original-code rounds use.
import { describe, expect, it } from "vitest";
import { realModelCallsAllowed, chooseCheckRound } from "../../packages/worker/src/check-round-kind.js";
import { answerSandboxRestart } from "../support/fake-sandbox-restart.js";
import { checkRoundRunners, ptraceScopeFromProc, quietWorkingPlace, runnersKind } from "../../packages/worker/src/check-round-choice.js";
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

describe("quietWorkingPlace (H1b): the working sandbox is restarted and checked from the host", () => {
  const docker = (calls: string[]) => ({ run: (args: readonly string[]) => { calls.push(args[0]!); return Promise.resolve(answerSandboxRestart(args)!); } });
  const input = (calls: string[], extra: Partial<Parameters<typeof quietWorkingPlace>[0]> = {}) => ({ docker: docker(calls), rootPath: "/w", sandboxName: "agentx-task-t", stopProcesses: (root: string) => { calls.push(`stop ${root}`); return Promise.resolve(); }, ptraceScope: () => Promise.resolve(1), ...extra });
  it("stops the worker's leftover processes, then checks ptrace, then restarts the sandbox and verifies it from the host", async () => {
    const calls: string[] = [];
    await quietWorkingPlace(input(calls))(new AbortController().signal);
    expect(calls).toEqual(["stop /w", "restart", "inspect", "top"]);
  });
  it("a failure of the host stop, the restart or the host's view rejects", async () => {
    const signal = new AbortController().signal;
    await expect(quietWorkingPlace(input([], { stopProcesses: () => Promise.reject(new Error("no")) }))(signal)).rejects.toThrow();
    const extra = { run: (args: readonly string[]) => Promise.resolve(answerSandboxRestart(args, "PID PPID COMMAND\n4242 0 /usr/bin/tini -- sleep infinity\n4243 4242 sleep infinity\n4244 4242 bash\n")!) };
    await expect(quietWorkingPlace(input([], { docker: extra }))(signal)).rejects.toThrow(/could not be stopped/u);
  });
  it("M2: ptrace between programs must be restricted (yama ptrace_scope 1 or more); 0, unreadable or not a number is refused with its own reason and nothing is restarted", async () => {
    const signal = new AbortController().signal;
    for (const scope of [1, 2, 3]) await quietWorkingPlace(input([], { ptraceScope: () => Promise.resolve(scope) }))(signal);
    for (const scope of [0, undefined, Number.NaN, -1]) {
      const calls: string[] = [];
      await expect(quietWorkingPlace(input(calls, { ptraceScope: () => Promise.resolve(scope) }))(signal), String(scope)).rejects.toMatchObject({ reason: "ptrace_unrestricted" });
      expect(calls.includes("restart")).toBe(false);
    }
    await expect(quietWorkingPlace(input([], { ptraceScope: () => Promise.reject(new Error("no file")) }))(signal)).rejects.toMatchObject({ reason: "ptrace_unrestricted" });
  });
  it("ptraceScopeFromProc reads the yama setting as a number", async () => {
    expect(await ptraceScopeFromProc(() => Promise.resolve("1\n"))).toBe(1);
    expect(await ptraceScopeFromProc(() => Promise.resolve("0"))).toBe(0);
    expect(await ptraceScopeFromProc(() => Promise.resolve("x"))).toBeUndefined();
    expect(await ptraceScopeFromProc(() => Promise.reject(new Error("ENOENT")))).toBeUndefined();
  });
});
