// TE-B1-fresh: the fresh check round (fresh-check-round.ts). Nothing starts Docker: a fake CLI records every call and plays the fresh sandbox, over a real git export.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectCommand } from "@rovara-code/contracts";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { WorkspaceSafety, withWorkspaceSafety } from "../../packages/worker/src/workspace-safety.js";
import { FRESH_ROUND_FIRST_LINE } from "../../packages/worker/src/check-round-kind.js";
import { FRESH_NOT_RUN_SENTENCES, freshSandboxArgProblems, type FreshCandidateRepository } from "../../packages/worker/src/fresh-check-sandbox.js";
import { createFreshCheckRunners, restartWorkingSandbox, withFreshCheckRound, type FreshCheckRoundInput } from "../../packages/worker/src/fresh-check-round.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";
import { FAKE_TINI_PID, PRISTINE_TOP, STATE_FORMAT, answerSandboxRestart } from "../support/fake-sandbox-restart.js";
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

interface FakeOptions { runExit?: number; rmFails?: boolean; holdRun?: Promise<void>; onRun?: () => void; answer?: (text: string) => { exitCode: number; stdout?: string } }
interface Seen { args: string[] }
function fakeDocker(options: FakeOptions = {}) {
  const calls: Seen[] = [];
  const state = { up: new Set<string>(), mountedDirectories: [] as string[] };
  const docker: DockerCli = {
    run: (args) => {
      calls.push({ args: [...args] });
      const [verb] = args;
      if (verb === "ps") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
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
  return { docker, rootPath: root, taskId: "t1", image: "worker:img", candidate: () => Promise.resolve([candidate]), pinned: () => [candidate], setup: [], ensureNetwork: () => Promise.resolve(), hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3, environment: {}, ...extra };
}
/** The runners a task uses, pinned to the test candidate as run-task pins them. */
function freshRunners(extra: Partial<FreshCheckRoundInput> & { keepExport?: boolean } = {}, docker: DockerCli = fakeDocker().docker) {
  const runners = createFreshCheckRunners(input(docker, extra));
  runners.pin([candidate]);
  return runners;
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

  it("a removal that fails is tried twice and logged, and the export is preserved for an unconfirmed stop", async () => {
    const fake = fakeDocker({ rmFails: true });
    const events: Array<Record<string, unknown>> = [];
    await expect(withFreshCheckRound(input(fake.docker, { log: (event) => events.push(event) }), () => Promise.resolve(1))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(fake.verbs().filter((verb) => verb === "rm")).toHaveLength(2);
    expect(events.map((event) => event.event)).toContain("fresh-check-round.remove.failed");
    expect(exportsLeft()).toHaveLength(1);
  });

  it("NEVER falls back: a failed export is 'not run', the round is not called, and nothing runs anywhere", async () => {
    const fake = fakeDocker();
    let called = false;
    const result = await withFreshCheckRound(input(fake.docker, { candidate: () => Promise.resolve([{ ...candidate, treeSha: "c".repeat(40) }]), pinned: () => [{ ...candidate, treeSha: "c".repeat(40) }] }), () => { called = true; return Promise.resolve(1); });
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
    expect(fake.calls.every((call) => call.args[0] === "run" || call.args[0] === "rm" || call.args[0] === "ps")).toBe(true);
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
    const runners = freshRunners({ onProgress: (line) => lines.push(line), keepExport: true }, fake.docker);
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
    const runners = freshRunners({ keepExport: true }, fake.docker);
    for (let round = 0; round < 2; round += 1) await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(runCalls(fake.calls)).toHaveLength(2);
  });
  it("a round that could not start gives every check 'not_run' with the fixed sentence, and the working place is never used", async () => {
    const fake = fakeDocker({ runExit: 125 });
    const runners = freshRunners({ keepExport: true }, fake.docker);
    const round = await runChecks({ source: "project", readiness: [command("npm", ["test"]), command("npm", ["run", "lint"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    for (const entry of round.entries) expect(entry.output).toContain(FRESH_NOT_RUN_SENTENCES.sandbox_failed);
    expect(fake.calls.filter((call) => call.args[0] === "exec")).toEqual([]);
  });
  it("a command outside a round is refused (CheckNotRunError), not run somewhere else", async () => {
    const runners = freshRunners({ keepExport: true });
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
    const runners = freshRunners({ quiesce: () => { count += 1; return Promise.resolve(); } });
    for (let round = 0; round < 2; round += 1) await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(count).toBe(2);
  });
  it("restartWorkingSandbox restarts the sandbox with no grace period and takes the verdict from the host, never from the container: no exec, no stdout of the sandbox", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve(answerSandboxRestart(args)!); } };
    await restartWorkingSandbox(docker, WORKING);
    expect(calls).toEqual([["restart", "--timeout", "0", WORKING], ["inspect", "--format", STATE_FORMAT, WORKING], ["top", WORKING, "-eo", "pid,ppid,args"]]);
    expect(calls.some((call) => call[0] === "exec")).toBe(false);
  });
  const withTop = (top: string, extra: Partial<Record<"restart" | "inspect", { exitCode: number; stdout: string; stderr: string }>> = {}): DockerCli => ({
    run: (args) => Promise.resolve(args[0] === "restart" ? extra.restart ?? answerSandboxRestart(args)! : args[0] === "inspect" ? extra.inspect ?? answerSandboxRestart(args)! : answerSandboxRestart(args, top)!),
  });
  const rows = (...lines: string[]) => `PID PPID COMMAND\n${lines.join("\n")}\n`;
  const TINI = `${String(FAKE_TINI_PID)} 0 /usr/bin/tini -- sleep infinity`;
  const SLEEP = `${String(FAKE_TINI_PID + 1)} ${String(FAKE_TINI_PID)} sleep infinity`;
  it("restartWorkingSandbox fails closed on anything but exactly tini and its sleep, matched by host-side PIDs", async () => {
    await restartWorkingSandbox(withTop(PRISTINE_TOP), WORKING);
    const bad: Array<[string, string]> = [
      ["an extra process", rows(TINI, SLEEP, `${String(FAKE_TINI_PID + 2)} ${String(FAKE_TINI_PID)} bash`)],
      ["an extra process under the sleep", rows(TINI, SLEEP, `${String(FAKE_TINI_PID + 2)} ${String(FAKE_TINI_PID + 1)} bash`)],
      ["only tini", rows(TINI)],
      ["nothing", rows()],
      ["no header-only garbage", "not a table"],
      ["the sleep is not tini's child", rows(TINI, `${String(FAKE_TINI_PID + 1)} 1 sleep infinity`)],
      ["the first row is not the container's PID 1", rows(`${String(FAKE_TINI_PID + 7)} 0 /usr/bin/tini -- sleep infinity`, `${String(FAKE_TINI_PID + 8)} ${String(FAKE_TINI_PID + 7)} sleep infinity`)],
      ["the child is not the sleep", rows(TINI, `${String(FAKE_TINI_PID + 1)} ${String(FAKE_TINI_PID)} bash -c loop`)],
      ["two sleeps", rows(TINI, SLEEP, `${String(FAKE_TINI_PID + 3)} ${String(FAKE_TINI_PID)} sleep infinity`)],
      ["no row has the container's PID 1 while another row is named tini (the sleep still says tini's PID is State.Pid)", rows(`${String(FAKE_TINI_PID + 5000)} 0 /usr/bin/tini -- sleep infinity`, SLEEP)],
      ["tini that is not tini", rows(`${String(FAKE_TINI_PID)} 0 /bin/bash`, SLEEP)],
    ];
    for (const [name, top] of bad) await expect(restartWorkingSandbox(withTop(top), WORKING), name).rejects.toThrow(/could not be stopped/u);
    await expect(restartWorkingSandbox(withTop(PRISTINE_TOP, { restart: { exitCode: 1, stdout: "", stderr: "x" } }), WORKING)).rejects.toThrow(/could not be stopped/u);
    await expect(restartWorkingSandbox(withTop(PRISTINE_TOP, { inspect: { exitCode: 0, stdout: "false 0\n", stderr: "" } }), WORKING)).rejects.toThrow(/could not be stopped/u);
    await expect(restartWorkingSandbox(withTop(PRISTINE_TOP, { inspect: { exitCode: 0, stdout: "true abc\n", stderr: "" } }), WORKING)).rejects.toThrow(/could not be stopped/u);
    // a container's PID 1 is never host PID 0 or 1: a state that says so is not a sandbox we can look at
    for (const pid of ["0", "1"]) await expect(restartWorkingSandbox(withTop(rows(`${pid} 0 /usr/bin/tini -- sleep infinity`, `9 ${pid} sleep infinity`), { inspect: { exitCode: 0, stdout: `true ${pid}\n`, stderr: "" } }), WORKING), pid).rejects.toThrow(/could not be stopped/u);
    await expect(restartWorkingSandbox({ run: () => Promise.reject(new Error("docker gone")) }, WORKING)).rejects.toThrow(/could not be stopped/u);
  });
});

describe("L3: a round ended while its sandbox was still starting releases it when it arrives", () => {
  it("endRound before the start finishes leaves no container and no export", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    let reached!: () => void;
    const runCalled = new Promise<void>((done) => { reached = done; });
    const fake = fakeDocker({ holdRun: hold, onRun: () => reached() });
    const runners = freshRunners({ keepExport: true }, fake.docker);
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
    const runners = freshRunners({ keepExport: true }, fake.docker);
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const root = evidence(runners)!;
    expect(root).toBeDefined();
    expect(existsSync(root)).toBe(true);
    expect(fake.state.up.size).toBe(0);
    await runners.releaseEvidence();
    expect(existsSync(root)).toBe(false);
    expect(evidence(runners)).toBeUndefined();
  });
  it("a round that did not run exposes no evidence; an unremoved container retains its export privately", async () => {
    const failed = freshRunners({ keepExport: true }, fakeDocker({ runExit: 125 }).docker);
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, failed, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(evidence(failed)).toBeUndefined();
    const stuck = freshRunners({ keepExport: true }, fakeDocker({ rmFails: true }).docker);
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, stuck, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(evidence(stuck)).toBeUndefined();
    expect(exportsLeft()).toHaveLength(1);
  });
  it("a new round releases the earlier round's export", async () => {
    const runners = freshRunners({ keepExport: true });
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const first = evidence(runners)!;
    await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(existsSync(first)).toBe(false);
    await runners.releaseEvidence();
  });
});

describe("H1b (2): the round is pinned to the candidate that was recorded", () => {
  it("a candidate that is not the recorded one is 'not run': nothing is exported, nothing starts, the round is not called", async () => {
    const moved = { ...candidate, treeSha: "d".repeat(40) };
    const fake = fakeDocker();
    let called = false;
    for (const current of [[moved], [{ ...candidate, commitSha: "e".repeat(40) }], [], [candidate, { ...candidate, repositoryId: "other" }]]) {
      const result = await withFreshCheckRound(input(fake.docker, { candidate: () => Promise.resolve(current) }), () => { called = true; return Promise.resolve(1); });
      expect(result).toEqual({ kind: "not_run", reason: "candidate_moved", sentence: FRESH_NOT_RUN_SENTENCES.candidate_moved });
    }
    expect(called).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(exportsLeft()).toEqual([]);
  });
  it("duplicates are refused on either side: [A, A] is not [A, B], and a record with a repeat is no record", async () => {
    const fake = fakeDocker();
    const other = { ...candidate, repositoryId: "other", directory: candidate.directory };
    for (const [current, pinned] of [[[candidate, candidate], [candidate, other]], [[candidate, other], [candidate, candidate]], [[candidate, candidate], [candidate, candidate]]] as const) {
      const result = await withFreshCheckRound(input(fake.docker, { candidate: () => Promise.resolve(current), pinned: () => current === pinned ? pinned : pinned }), () => Promise.resolve(1));
      expect(result, JSON.stringify([current.length, pinned.length])).toMatchObject({ kind: "not_run", reason: "candidate_moved" });
    }
    expect(fake.calls).toEqual([]);
  });
  it("a round with nothing recorded is not run", async () => {
    const fake = fakeDocker();
    expect(await withFreshCheckRound(input(fake.docker, { pinned: () => undefined }), () => Promise.resolve(1))).toMatchObject({ kind: "not_run", reason: "candidate_moved" });
    expect(await withFreshCheckRound(input(fake.docker, { pinned: () => [] }), () => Promise.resolve(1))).toMatchObject({ kind: "not_run", reason: "candidate_moved" });
    expect(fake.calls).toEqual([]);
  });
  it("the same candidate is run, whatever the order or extra fields of the record", async () => {
    const fake = fakeDocker();
    const result = await withFreshCheckRound(input(fake.docker, { pinned: () => [{ ...candidate, baseCommitSha: "f".repeat(40) } as typeof candidate] }), () => Promise.resolve(1));
    expect(result.kind).toBe("ran");
  });
  it("the runners a task uses are not run until the candidate is pinned, and a HEAD that moved and came back is caught at the round", async () => {
    const fake = fakeDocker();
    const unpinned = createFreshCheckRunners(input(fake.docker));
    const round = await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, unpinned, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries[0]).toMatchObject({ after: "not_run" });
    expect(round.entries[0]!.output).toContain(FRESH_NOT_RUN_SENTENCES.candidate_moved);
    // a survivor moved HEAD to B for the round's read: the record says A
    let reads = 0;
    const runners = createFreshCheckRunners(input(fake.docker, { candidate: () => { reads += 1; return Promise.resolve([{ ...candidate, treeSha: "b".repeat(40) }]); } }));
    runners.pin([candidate]);
    const moved = await runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(moved.entries[0]).toMatchObject({ after: "not_run" });
    expect(reads).toBe(1);
    expect(fake.calls.filter((call) => call.args[0] === "run")).toEqual([]);
  });
});


describe("landing: exported paths and abort-join", () => {
  it("cd resolves the export, never a working-tree symlink or directory", async () => {
    const fake = fakeDocker({ onRun: () => {
      rmSync(join(candidate.directory, "a.txt"));
      mkdirSync(join(root, "working-only"));
      symlinkSync("working-only", join(root, "alias"));
    } });
    const result = await withFreshCheckRound(input(fake.docker), async (runners) => {
      rmSync(candidate.directory, { recursive: true, force: true });
      expect(await runners.runAgentCommand("cd repo && npm test", 1000, new AbortController().signal)).toMatchObject({ exitCode: 0 });
      for (const path of ["working-only", "alias", "missing-private-path"]) {
        await expect(runners.runAgentCommand(`cd ${path} && npm test`, 1000, new AbortController().signal)).rejects.toMatchObject({ message: "AgentX did not replay this command: its directory is not available in the fresh export." });
      }
      await expect(runners.runAgentCommand("cd ../escape && npm test", 1000, new AbortController().signal)).rejects.toThrow("AgentX replays only a simple test command, and this is not one.");
      const commands = fake.calls.filter(({ args }) => args[0] === "exec" && args.join(" ").includes("npm test"));
      expect(commands).toHaveLength(1);
      expect(commands[0]!.args).toContain(join(root, "repo"));
      return 1;
    });
    expect(result).toEqual({ kind: "ran", value: 1 });
  });

  it.each(["setup", "project", "replay", "quiesce"] as const)("preserves an unconfirmed %s stop and leaves the export and container alone", async (stage) => {
    const safety = new WorkspaceSafety();
    const stop = new AbortController();
    const fake = fakeDocker();
    let failure: RunnerKillUnconfirmedError | undefined;
    const fail = () => { failure = new RunnerKillUnconfirmedError({ kind: "sandbox" }); stop.abort(); throw failure; };
    const docker: DockerCli = { run: (args, options) => args[0] === "exec" ? Promise.resolve().then(fail) : fake.docker.run(args, options) };
    await withWorkspaceSafety(safety, async () => {
      const runners = freshRunners({ signal: stop.signal, ...(stage === "setup" ? { setup: [command("npm", ["install"])] } : {}), ...(stage === "quiesce" ? { quiesce: async () => fail() } : {}) }, docker);
      await expect((async () => {
        await runners.freshServices!(stop.signal);
        if (stage === "replay") await runners.runAgentCommand("cd repo && npm test", 1000, stop.signal);
        else await runners.runProjectCommand(command("npm", ["test"]), stop.signal);
      })()).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
      expect(safety.failure).toBe(failure);
      await runners.endRound!();
      await runners.releaseEvidence();
      expect(fake.verbs()).not.toContain("rm");
      if (stage !== "quiesce") {
        expect(exportsLeft()).toHaveLength(1);
        expect(safety.quarantinables.flat().map((item) => item.name)).toEqual([...fake.state.up]);
      }
    });
  });

  it.each(["run", "exec", "rm"])("propagates Docker killUnconfirmed during %s", async (verb) => {
    const safety = new WorkspaceSafety();
    const fake = fakeDocker();
    const docker: DockerCli = { run: (args, options) => args[0] === verb ? Promise.resolve({ exitCode: 0, stdout: "private-input", stderr: "private-input", killUnconfirmed: true }) : fake.docker.run(args, options) };
    await withWorkspaceSafety(safety, async () => {
      await expect(withFreshCheckRound(input(docker), (runners) => runners.runProjectCommand(command("npm", ["test"]), new AbortController().signal))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
      expect(safety.unsafe).toBe(true);
      expect(safety.failure?.message).not.toContain("private-input");
      expect(exportsLeft()).toHaveLength(1);
    });
  });

  it("a pre-existing latch prevents candidate reads and all Docker calls", async () => {
    const safety = new WorkspaceSafety();
    const fake = fakeDocker();
    await withWorkspaceSafety(safety, async () => {
      const failure = new RunnerKillUnconfirmedError({ kind: "local" });
      await expect(withFreshCheckRound(input(fake.docker, { candidate: async () => { throw new Error("must not read"); } }), async () => 1)).rejects.toBe(failure);
      expect(fake.calls).toEqual([]);
    });
  });
});


it("landing: an unsafe helper stop prevents subsequent stops and removal", async () => {
  const safety = new WorkspaceSafety();
  const fake = fakeDocker();
  const calls: string[] = [];
  await withWorkspaceSafety(safety, async () => {
    await expect(withFreshCheckRound(input(fake.docker, { hooks: { helpers: [
      { name: "first", start: async () => async () => { calls.push("first"); } },
      { name: "last", start: async () => async () => { calls.push("last"); new RunnerKillUnconfirmedError({ kind: "local" }); } },
    ] } }), async () => 1)).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(calls).toEqual(["last"]);
    expect(fake.verbs()).not.toContain("rm");
    expect(exportsLeft()).toHaveLength(1);
  });
});

it("landing: retained evidence is left untouched after an unsafe stop", async () => {
  const safety = new WorkspaceSafety();
  await withWorkspaceSafety(safety, async () => {
    const runners = freshRunners({ keepExport: true });
    await runners.freshServices!(new AbortController().signal);
    await runners.endRound!();
    const exported = runners.evidenceRoot()!;
    expect(existsSync(exported)).toBe(true);
    new RunnerKillUnconfirmedError({ kind: "local" });
    await runners.releaseEvidence();
    expect(existsSync(exported)).toBe(true);
  });
});

it("landing: a late start observes the latch before handing over runners or removing the container", async () => {
  const safety = new WorkspaceSafety();
  let release!: () => void;
  let began!: () => void;
  const starting = new Promise<void>((resolve) => { began = resolve; });
  const fake = fakeDocker({ holdRun: new Promise<void>((resolve) => { release = resolve; }), onRun: began });
  await withWorkspaceSafety(safety, async () => {
    const runners = freshRunners({}, fake.docker);
    const opened = runners.freshServices!(new AbortController().signal);
    await starting;
    const failure = new RunnerKillUnconfirmedError({ kind: "local" });
    release();
    await expect(opened).rejects.toBe(failure);
    await runners.endRound!();
    expect(fake.verbs()).not.toContain("rm");
    expect(exportsLeft()).toHaveLength(1);
  });
});


it("landing: unconfirmed stops propagate even outside a task latch", async () => {
  const failure = new RunnerKillUnconfirmedError({ kind: "sandbox" });
  await expect(withFreshCheckRound(input(fakeDocker().docker, { quiesce: async () => { throw failure; } }), async () => 1)).rejects.toBe(failure);
  const fake = fakeDocker();
  const docker: DockerCli = { run: async (args, options) => { if (args[0] === "exec") throw failure; return fake.docker.run(args, options); } };
  const runners = freshRunners({ setup: [command("npm", ["install"])] }, docker);
  await expect(runners.freshServices!(new AbortController().signal)).rejects.toBe(failure);
  expect(fake.verbs()).not.toContain("rm");
});

it("landing: abort-join during startup fences a late host client even before its container exists", async () => {
  const safety = new WorkspaceSafety();
  let release!: () => void;
  let began!: () => void;
  const starting = new Promise<void>((resolve) => { began = resolve; });
  const fake = fakeDocker({ holdRun: new Promise<void>((resolve) => { release = resolve; }), onRun: began });
  await withWorkspaceSafety(safety, async () => {
    const runners = freshRunners({}, fake.docker);
    const fresh = runners.freshServices!.bind(runners);
    let opening: Promise<void> | undefined;
    runners.freshServices = (signal) => { opening = fresh(signal); return opening; };
    const stop = new AbortController();
    const running = runChecks({ source: "project", readiness: [command("npm", ["test"])] }, runners, { budgetMs: 60_000, signal: stop.signal, abortJoinMs: 5 });
    await starting;
    stop.abort();
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    // An absent container alone cannot prove a still-starting host Docker client has ended.
    const recorded = [...safety.unconfirmed];
    release();
    await expect(opening).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(recorded).toEqual([{ kind: "local" }]);
    expect(fake.verbs()).not.toContain("rm");
  });
});
