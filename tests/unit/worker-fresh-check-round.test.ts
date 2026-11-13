// TE-B1-fresh: the fresh check round (fresh-check-round.ts). Nothing starts Docker: a fake CLI records every call and plays the fresh sandbox, over a real git export.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectCommand } from "@rovara-code/contracts";
import { FRESH_ROUND_FIRST_LINE } from "../../packages/worker/src/check-round-kind.js";
import { FRESH_NOT_RUN_SENTENCES, freshSandboxArgProblems, type FreshCandidateRepository } from "../../packages/worker/src/fresh-check-sandbox.js";
import { STOP_SANDBOX_PROGRAMS_SCRIPT, createFreshCheckRunners, stopWorkingSandboxPrograms, withFreshCheckRound, type FreshCheckRoundInput } from "../../packages/worker/src/fresh-check-round.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { CheckNotRunError, runChecks, type CheckRunners } from "../../packages/worker/src/verification/checks.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const WORKING = "agentx-task-t1-working";

let root: string;
let candidate: FreshCandidateRepository;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fresh-round-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "c");
  writeFileSync(join(repo, "untracked.txt"), "x\n");
  candidate = { repositoryId: "repo", path: "repo", directory: repo, commitSha: git(repo, "rev-parse", "HEAD"), treeSha: git(repo, "rev-parse", "HEAD^{tree}") };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface FakeOptions { runExit?: number; rmFails?: boolean; remaining?: number; holdRun?: Promise<void>; onRun?: () => void; answer?: (text: string) => { exitCode: number; stdout?: string } }
interface Seen { args: string[] }
function fakeDocker(options: FakeOptions = {}) {
  const calls: Seen[] = [];
  const state = { up: new Set<string>(), mountedDirectories: [] as string[] };
  const docker: DockerCli = {
    run: (args) => {
      calls.push({ args: [...args] });
      const [verb] = args;
      if (verb === "run") {
        options.onRun?.();
        const started = () => {
          if ((options.runExit ?? 0) === 0) { state.up.add(args[args.indexOf("--name") + 1]!); state.mountedDirectories.push(args[args.indexOf("--volume") + 1]!.split(":")[0]!); }
          return { exitCode: options.runExit ?? 0, stdout: "id\n", stderr: options.runExit === undefined ? "" : "docker said: secret-looking-text" };
        };
        return options.holdRun === undefined ? Promise.resolve(started()) : options.holdRun.then(started);
      }
      if (verb === "rm") { if (options.rmFails !== true) state.up.delete(args[args.length - 1]!); return Promise.resolve({ exitCode: options.rmFails === true ? 1 : 0, stdout: "", stderr: "" }); }
      if (verb === "exec") {
        const text = args.join(" ");
        if (text.includes("REMAINING:")) return Promise.resolve({ exitCode: options.remaining === undefined ? 0 : 0, stdout: `REMAINING:${String(options.remaining ?? 0)}\n`, stderr: "" });
        if (text.includes("kill")) return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        const answer = (options.answer ?? (() => ({ exitCode: 0, stdout: "ok\n" })))(text);
        return Promise.resolve({ exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unexpected" });
    },
  };
  return { docker, calls, state, verbs: () => calls.map((call) => call.args[0]!) };
}

const command = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "repo", executable, args, timeoutSeconds: 30 });
function input(docker: DockerCli, extra: Partial<FreshCheckRoundInput> = {}): FreshCheckRoundInput {
  return { docker, rootPath: root, taskId: "t1", image: "worker:img", candidate: () => Promise.resolve([candidate]), setup: [], ensureNetwork: () => Promise.resolve(), hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3, environment: {}, ...extra };
}
const exportsLeft = () => (existsSync(join(root, ".agentx", "fresh-check")) ? readdirSync(join(root, ".agentx", "fresh-check")).filter((name) => name !== "scratch") : []);
const runCalls = (calls: Seen[]) => calls.filter((call) => call.args[0] === "run");

describe("withFreshCheckRound", () => {
  it("exports the commit, starts a hardened sandbox on the export, runs the round by docker exec into it, then removes it and the export", async () => {
    const fake = fakeDocker();
    const lines: string[] = [];
    const result = await withFreshCheckRound(input(fake.docker, { onProgress: (line) => lines.push(line) }), async (runners) => {
      const run = await runners.runProjectCommand(command("npm", ["test"]), new AbortController().signal);
      expect(run.exitCode).toBe(0);
      expect(fake.state.up.size).toBe(1);
      expect(exportsLeft()).toHaveLength(1);
      return "done";
    });
    expect(result).toEqual({ kind: "ran", value: "done" });
    expect(lines[0]).toBe(FRESH_ROUND_FIRST_LINE);
    const [start] = runCalls(fake.calls);
    const name = start!.args[start!.args.indexOf("--name") + 1]!;
    expect(freshSandboxArgProblems(start!.args, { name, taskId: "t1", image: "worker:img", rootPath: root, exportDirectory: fake.state.mountedDirectories[0]!, environment: {}, hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3 })).toEqual([]);
    expect(fake.state.mountedDirectories[0]).not.toBe(root);
    // every docker call is the start, an exec into THAT container, or its removal: never a network change, never the working sandbox
    for (const call of fake.calls) {
      if (call.args[0] === "exec") expect(call.args).toContain(name);
      expect(call.args.join(" ")).not.toContain(WORKING);
      expect(call.args[0] === "network" || call.args[0] === "pause").toBe(false);
    }
    expect(fake.verbs().at(-1)).toBe("rm");
    expect(fake.state.up.size).toBe(0);
    expect(exportsLeft()).toEqual([]);
  });

  it("a second round on the same task gets a new directory and a new container", async () => {
    const fake = fakeDocker();
    await withFreshCheckRound(input(fake.docker), () => Promise.resolve(1));
    await withFreshCheckRound(input(fake.docker), () => Promise.resolve(2));
    const starts = runCalls(fake.calls).map((call) => [call.args[call.args.indexOf("--name") + 1], call.args[call.args.indexOf("--volume") + 1]]);
    expect(new Set(starts.map((start) => start[0])).size).toBe(2);
    expect(new Set(starts.map((start) => start[1])).size).toBe(2);
  });

  it("removes the sandbox and the export when the round fails", async () => {
    const fake = fakeDocker();
    await expect(withFreshCheckRound(input(fake.docker), () => Promise.reject(new Error("round failed")))).rejects.toThrow("round failed");
    expect(fake.state.up.size).toBe(0);
    expect(exportsLeft()).toEqual([]);
  });

  it("removes the sandbox and the export when the task is cancelled during the round", async () => {
    const fake = fakeDocker();
    const stop = new AbortController();
    const running = withFreshCheckRound(input(fake.docker, { signal: stop.signal }), async () => { stop.abort(); throw new Error("aborted"); });
    await expect(running).rejects.toThrow("aborted");
    expect(fake.state.up.size).toBe(0);
    expect(exportsLeft()).toEqual([]);
  });

  it("a removal that fails is tried twice and logged, and the export is still removed", async () => {
    const fake = fakeDocker({ rmFails: true });
    const events: Array<Record<string, unknown>> = [];
    await withFreshCheckRound(input(fake.docker, { log: (event) => events.push(event) }), () => Promise.resolve(1));
    expect(fake.verbs().filter((verb) => verb === "rm")).toHaveLength(2);
    expect(events.map((event) => event.event)).toContain("fresh-check-round.remove.failed");
    expect(exportsLeft()).toEqual([]);
  });

  it("NEVER falls back: a failed export is 'not run', the round is not called, and nothing runs anywhere", async () => {
    const fake = fakeDocker();
    let called = false;
    const result = await withFreshCheckRound(input(fake.docker, { candidate: () => Promise.resolve([{ ...candidate, treeSha: "c".repeat(40) }]) }), () => { called = true; return Promise.resolve(1); });
    expect(called).toBe(false);
    expect(result).toEqual({ kind: "not_run", reason: "tree_changed", sentence: FRESH_NOT_RUN_SENTENCES.tree_changed });
    expect(fake.calls).toEqual([]);
    expect(exportsLeft()).toEqual([]);
  });

  it("NEVER falls back: a sandbox that does not start is 'not run' with a fixed sentence (docker's words are not repeated), and is removed", async () => {
    const fake = fakeDocker({ runExit: 125 });
    let called = false;
    const result = await withFreshCheckRound(input(fake.docker), () => { called = true; return Promise.resolve(1); });
    expect(called).toBe(false);
    expect(result).toEqual({ kind: "not_run", reason: "sandbox_failed", sentence: FRESH_NOT_RUN_SENTENCES.sandbox_failed });
    expect(JSON.stringify(result)).not.toContain("secret-looking-text");
    expect(fake.calls.every((call) => call.args[0] === "run" || call.args[0] === "rm")).toBe(true);
    expect(exportsLeft()).toEqual([]);
  });

  it("an unreadable candidate, a missing image and a stopped task are 'not run', before any Docker call", async () => {
    const fake = fakeDocker();
    expect(await withFreshCheckRound(input(fake.docker, { candidate: () => Promise.reject(new Error("x")) }), () => Promise.resolve(1))).toMatchObject({ kind: "not_run", reason: "export_failed" });
    expect(await withFreshCheckRound(input(fake.docker, { image: undefined }), () => Promise.resolve(1))).toMatchObject({ kind: "not_run", reason: "no_image" });
    const stopped = new AbortController(); stopped.abort();
    expect(await withFreshCheckRound(input(fake.docker, { signal: stopped.signal }), () => Promise.resolve(1))).toMatchObject({ kind: "not_run", reason: "stopped" });
    expect(fake.calls).toEqual([]);
  });

  it("the project's setup commands run in the fresh sandbox before the round; a failing one is 'could not be prepared', never 'failed'", async () => {
    const fake = fakeDocker({ answer: (text) => ({ exitCode: text.includes("install-deps") ? 1 : 0 }) });
    let called = false;
    const result = await withFreshCheckRound(input(fake.docker, { setup: [command("install-deps")] }), () => { called = true; return Promise.resolve(1); });
    expect(called).toBe(false);
    expect(result).toEqual({ kind: "not_run", reason: "not_prepared", sentence: FRESH_NOT_RUN_SENTENCES.not_prepared });
    expect(fake.state.up.size).toBe(0);
    const ok = fakeDocker();
    const order: string[] = [];
    await withFreshCheckRound(input(ok.docker, { setup: [command("install-deps")] }), (runners) => { order.push(`round after ${ok.calls.filter((call) => call.args.join(" ").includes("install-deps")).length} setup exec`); void runners; return Promise.resolve(1); });
    expect(order).toEqual(["round after 1 setup exec"]);
  });

  it("a runner kept after the round rejects: it cannot start a command in a later place", async () => {
    const fake = fakeDocker();
    let kept: CheckRunners | undefined;
    await withFreshCheckRound(input(fake.docker), (runners) => { kept = runners; return Promise.resolve(1); });
    const execsBefore = fake.calls.filter((call) => call.args[0] === "exec").length;
    await expect(kept!.runProjectCommand(command("npm"), new AbortController().signal)).rejects.toThrow();
    expect(fake.calls.filter((call) => call.args[0] === "exec")).toHaveLength(execsBefore);
  });

  it("the agent's replay gets the AgentX git identity only: none of the worker's environment", async () => {
    const fake = fakeDocker();
    process.env["PI_FRESH_TEST_WORKER_SECRET"] = "worker-only";
    try {
      await withFreshCheckRound(input(fake.docker), async (runners) => { await runners.runAgentCommand("npm test", 5_000, new AbortController().signal); });
    } finally { delete process.env["PI_FRESH_TEST_WORKER_SECRET"]; }
    const text = fake.calls.filter((call) => call.args[0] === "exec").map((call) => call.args.join(" ")).join("\n");
    expect(text).not.toContain("PI_FRESH_TEST_WORKER_SECRET");
    for (const [key] of Object.entries(AGENTX_GIT_IDENTITY_ENVIRONMENT)) expect(text).toContain(key);
  });

  it("the helpers seam: started after the sandbox, stopped after the round, and a helper that cannot start makes the round 'not run'", async () => {
    const fake = fakeDocker();
    const events: string[] = [];
    const helper = { name: "model-stand-in", start: (start: { container: string }) => { events.push(`start ${fake.state.up.has(start.container) ? "after the sandbox" : "BEFORE"}`); return Promise.resolve(() => { events.push("stop"); return Promise.resolve(); }); } };
    await withFreshCheckRound(input(fake.docker, { hooks: { helpers: [helper] } }), () => { events.push("round"); return Promise.resolve(1); });
    expect(events).toEqual(["start after the sandbox", "round", "stop"]);
    const failing = await withFreshCheckRound(input(fake.docker, { hooks: { helpers: [{ name: "x", start: () => Promise.reject(new Error("no")) }] } }), () => Promise.resolve(1));
    expect(failing).toMatchObject({ kind: "not_run", reason: "sandbox_failed" });
    expect(fake.state.up.size).toBe(0);
  });

  it("the residual line the model-host block supplies is printed second", async () => {
    const lines: string[] = [];
    await withFreshCheckRound(input(fakeDocker().docker, { onProgress: (line) => lines.push(line), hooks: { residualLine: "not sealed; model hosts blocked by name only" } }), () => Promise.resolve(1));
    expect(lines).toEqual([FRESH_ROUND_FIRST_LINE, "not sealed; model hosts blocked by name only"]);
  });
});

describe("createFreshCheckRunners (the runners a task uses: a round opens at freshServices and closes at endRound)", () => {
  it("runChecks runs the checks in the fresh sandbox, the first progress line is 'not sealed', and the sandbox is gone afterwards", async () => {
    const fake = fakeDocker();
    const lines: string[] = [];
    const runners = createFreshCheckRunners(input(fake.docker, { onProgress: (line) => lines.push(line) }));
    const round = await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
    expect(lines[0]).toBe(FRESH_ROUND_FIRST_LINE);
    expect(fake.state.up.size).toBe(0);
    // the export is kept for the evidence (H1c) until it is released
    expect(exportsLeft()).toHaveLength(1);
    await runners.releaseEvidence();
    expect(exportsLeft()).toEqual([]);
  });
  it("two rounds (the extra try) are two sandboxes", async () => {
    const fake = fakeDocker();
    const runners = createFreshCheckRunners(input(fake.docker));
    for (let round = 0; round < 2; round += 1) await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(runCalls(fake.calls)).toHaveLength(2);
  });
  it("a round that could not start gives every check 'not_run' with the fixed sentence, and the working place is never used", async () => {
    const fake = fakeDocker({ runExit: 125 });
    const runners = createFreshCheckRunners(input(fake.docker));
    const round = await runChecks({ source: "project", readiness: [command("npm", ["test"]), command("npm", ["run", "lint"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    for (const entry of round.entries) expect(entry.output).toContain(FRESH_NOT_RUN_SENTENCES.sandbox_failed);
    expect(fake.calls.filter((call) => call.args[0] === "exec")).toEqual([]);
  });
  it("a command outside a round is refused (CheckNotRunError), not run somewhere else", async () => {
    const runners = createFreshCheckRunners(input(fakeDocker().docker));
    await expect(runners.runProjectCommand(command("npm"), new AbortController().signal)).rejects.toBeInstanceOf(CheckNotRunError);
    await expect(runners.runAgentCommand("npm test", 1_000, new AbortController().signal)).rejects.toBeInstanceOf(CheckNotRunError);
  });
});

describe("L6: the first line is printed even when the round cannot start", () => {
  it("no image, a stopped task and a failing start all print 'not sealed' first", async () => {
    for (const extra of [{ image: undefined }, { signal: (() => { const stop = new AbortController(); stop.abort(); return stop.signal; })() }] as Array<Partial<FreshCheckRoundInput>>) {
      const lines: string[] = [];
      const result = await withFreshCheckRound(input(fakeDocker().docker, { onProgress: (line) => lines.push(line), ...extra }), () => Promise.resolve(1));
      expect(result.kind).toBe("not_run");
      expect(lines[0]).toBe(FRESH_ROUND_FIRST_LINE);
    }
  });
});

describe("H1b: nothing the agent left running may act during the round", () => {
  it("quiesce runs before the export and before any docker call; a failure is 'not run' and nothing starts", async () => {
    const fake = fakeDocker();
    const order: string[] = [];
    const ok = await withFreshCheckRound(input(fake.docker, { quiesce: () => { order.push(`quiesce after ${String(fake.calls.length)} docker calls`); return Promise.resolve(); } }), () => Promise.resolve(1));
    expect(ok.kind).toBe("ran");
    expect(order).toEqual(["quiesce after 0 docker calls"]);
    const second = fakeDocker();
    let called = false;
    const refused = await withFreshCheckRound(input(second.docker, { quiesce: () => Promise.reject(new Error("could not stop")) }), () => { called = true; return Promise.resolve(1); });
    expect(refused).toEqual({ kind: "not_run", reason: "quiesce_failed", sentence: FRESH_NOT_RUN_SENTENCES.quiesce_failed });
    expect(called).toBe(false);
    expect(second.calls).toEqual([]);
    expect(exportsLeft()).toEqual([]);
  });
  it("every round quiesces (the extra try's second round too)", async () => {
    let count = 0;
    const runners = createFreshCheckRunners(input(fakeDocker().docker, { quiesce: () => { count += 1; return Promise.resolve(); } }));
    for (let round = 0; round < 2; round += 1) await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(count).toBe(2);
  });
  it("stopWorkingSandboxPrograms runs the stop script in the WORKING sandbox and fails closed unless nothing is left", async () => {
    const calls: string[][] = [];
    const docker = (remaining: number, exitCode = 0): DockerCli => ({ run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode, stdout: `REMAINING:${String(remaining)}\n`, stderr: "" }); } });
    await stopWorkingSandboxPrograms(docker(0), WORKING);
    expect(calls).toEqual([["exec", WORKING, "sh", "-c", STOP_SANDBOX_PROGRAMS_SCRIPT]]);
    await expect(stopWorkingSandboxPrograms(docker(2), WORKING)).rejects.toThrow(/could not be stopped/u);
    await expect(stopWorkingSandboxPrograms(docker(0, 1), WORKING)).rejects.toThrow(/could not be stopped/u);
    await expect(stopWorkingSandboxPrograms({ run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) }, WORKING)).rejects.toThrow();
  });
  it("the stop script never kills PID 1, the sandbox's own sleep or itself", () => {
    expect(STOP_SANDBOX_PROGRAMS_SCRIPT).toContain('[ "$pid" = 1 ] && continue');
    expect(STOP_SANDBOX_PROGRAMS_SCRIPT).toContain('[ "$pid" = "$$" ] && continue');
    expect(STOP_SANDBOX_PROGRAMS_SCRIPT).toContain('"sleep infinity "*');
  });
});

describe("L3: a round ended while its sandbox was still starting releases it when it arrives", () => {
  it("endRound before the start finishes leaves no container and no export", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    let reached!: () => void;
    const runCalled = new Promise<void>((done) => { reached = done; });
    const fake = fakeDocker({ holdRun: hold, onRun: () => reached() });
    const runners = createFreshCheckRunners(input(fake.docker));
    const stop = new AbortController();
    const starting = runners.freshServices!(stop.signal);
    // the container is being started (docker run is in flight) when the round is cancelled and ended
    await runCalled;
    stop.abort();
    await runners.endRound!();
    release();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.state.up.size).toBe(0);
    expect(exportsLeft()).toEqual([]);
    await expect(runners.runProjectCommand(command("npm"), new AbortController().signal)).rejects.toBeInstanceOf(CheckNotRunError);
  });
});

describe("H1c: the export is kept for the evidence only when the round ran and its container is gone", () => {
  const evidence = (runners: ReturnType<typeof createFreshCheckRunners>) => runners.evidenceRoot();
  it("a round that ran keeps its export until it is released; the container is already gone", async () => {
    const fake = fakeDocker();
    const runners = createFreshCheckRunners(input(fake.docker));
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const root = evidence(runners)!;
    expect(root).toBeDefined();
    expect(existsSync(root)).toBe(true);
    expect(fake.state.up.size).toBe(0);
    await runners.releaseEvidence();
    expect(existsSync(root)).toBe(false);
    expect(evidence(runners)).toBeUndefined();
  });
  it("a round that did not run, or whose container could not be removed, keeps nothing", async () => {
    const failed = createFreshCheckRunners(input(fakeDocker({ runExit: 125 }).docker));
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, failed, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(evidence(failed)).toBeUndefined();
    const stuck = createFreshCheckRunners(input(fakeDocker({ rmFails: true }).docker));
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, stuck, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(evidence(stuck)).toBeUndefined();
    expect(exportsLeft()).toEqual([]);
  });
  it("a new round releases the earlier round's export", async () => {
    const runners = createFreshCheckRunners(input(fakeDocker().docker));
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const first = evidence(runners)!;
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(existsSync(first)).toBe(false);
    await runners.releaseEvidence();
  });
});
