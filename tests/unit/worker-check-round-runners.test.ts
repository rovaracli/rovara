// Slice 1, s1-sealed T1: the sealed check round (check-round-runners.ts, createCheckRunners' `sealed` option). Deferred checks TS-SEAL-3 (the check sandbox starts only through startCheckSandbox inside withDetachedWorking) and the
// run's variables (an env file, last, never an argument). Nothing starts Docker: a fake CLI records every call and plays the check sandbox.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSandboxPlan, type CheckSandboxInput, type CheckSandboxPlan } from "../../packages/worker/src/check-sandbox.js";
import { sealedContainerExec, runSealedCheckRound, withSealedCheckRound } from "../../packages/worker/src/check-round-runners.js";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { buildServiceEnvironment, createRunDirectoryFiles, createServiceRedactor, type ServiceEnvironment } from "../../packages/worker/src/service-env.js";
import type { HelperFiles } from "../../packages/worker/src/service-helpers.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";
import { createCheckRunners, planChecks, runChecks } from "../../packages/worker/src/verification/checks.js";

const RUN = "22222222-2222-4222-8222-222222222222";
const SLOT = 7;
const NET = runNetworkName(RUN);
const WORK = "agentx-task-t1-abcd1234";
const PASSWORD = "Zq8Wv3Lm9Xc2Rt5";
const MINUTE = 60_000;

let dir: string;
let rootPath: string;
let files: HelperFiles & { directory: string };
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "sealed-round-")));
  rootPath = join(dir, "workspace");
  await mkdir(rootPath);
  await mkdir(join(rootPath, "pkg"));
  files = await createRunDirectoryFiles(dir, "run-files");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function environment(): ServiceEnvironment {
  return buildServiceEnvironment({
    sandbox: "check", sinkholeUrl: "http://sinkhole", neverValues: [],
    dependencies: [{
      id: "postgres", host: "postgres", port: 5432, credentials: { user: "app", password: PASSWORD, database: "app" },
      connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
    }],
  });
}
function plan(): CheckSandboxPlan {
  const addresses = runNetworkAddresses(SLOT);
  const input: CheckSandboxInput = {
    net: {
      name: NET, slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
      labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }),
    },
    taskId: "t1", image: "worker:img", rootPath, maskedPaths: [], filesDir: files.directory, helpers: [{ alias: "postgres", address: runNetworkHelperIp(SLOT, 1) }], sinkholeIp: runNetworkHelperIp(SLOT, 0),
    workingSandboxName: WORK,
  };
  return checkSandboxPlan(input);
}

interface ExecSeen { args: string[]; envFile?: { path: string; text: string; mode: number }; command: string[]; envFlags: string[] }
interface FakeOptions {
  /** What the check sandbox answers to one command (the part after the container name). */
  answer?: (seen: ExecSeen) => { exitCode: number; stdout?: string; stderr?: string } | Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  removeFails?: boolean;
  startExit?: number;
}
/** A docker that remembers the working sandbox's networks and whether the check sandbox is up, and logs every call in order. */
function fakeDocker(sandboxName: string, options: FakeOptions = {}) {
  const calls: string[][] = [];
  const execs: ExecSeen[] = [];
  const state = { workingNetworks: [NET, "agentx-task"], sandboxUp: false };
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      const [verb, second] = args;
      if (verb === "network" && second === "disconnect") { state.workingNetworks = state.workingNetworks.filter((name) => name !== args[2]); return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "network" && second === "connect") { state.workingNetworks = [...state.workingNetworks, args[args.length - 2]!]; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "inspect") return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(state.workingNetworks.map((name) => [name, {}]))), stderr: "" };
      if (verb === "run") { state.sandboxUp = (options.startExit ?? 0) === 0; return { exitCode: options.startExit ?? 0, stdout: "sandbox-id\n", stderr: "" }; }
      if (verb === "rm") { if (options.removeFails !== true) state.sandboxUp = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "container" && second === "inspect") return { exitCode: state.sandboxUp ? 0 : 1, stdout: state.sandboxUp ? "sandbox-id\n" : "", stderr: "" };
      if (verb === "exec") {
        const at = args.indexOf(sandboxName);
        const before = args.slice(1, at);
        const envFileAt = before.indexOf("--env-file");
        const envFilePath = envFileAt >= 0 ? before[envFileAt + 1] : undefined;
        const seen: ExecSeen = {
          args: [...args], command: args.slice(at + 1),
          envFlags: before.flatMap((arg, index) => (before[index - 1] === "--env" ? [arg] : [])),
          ...(envFilePath === undefined ? {} : { envFile: { path: envFilePath, text: readFileSync(envFilePath, "utf8"), mode: statSync(envFilePath).mode & 0o777 } }),
        };
        // The stop sequence's own execs (TERM, KILL) are not commands of the round.
        if (seen.command[2]?.includes("kill")) return { exitCode: 0, stdout: "", stderr: "" };
        execs.push(seen);
        const answered: NonNullable<FakeOptions["answer"]> = options.answer ?? (() => ({ exitCode: 0, stdout: "ok\n" }));
        const answer = await answered(seen);
        return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  };
  return { docker, calls, execs, state };
}
const verbs = (calls: string[][]) => calls.map((call) => (call[0] === "network" ? `network ${call[1]}` : call[0] === "container" ? "container inspect" : call[0]!));

function roundInput(docker: DockerCli, p: CheckSandboxPlan, extra: Partial<Parameters<typeof withSealedCheckRound>[0]> = {}): Parameters<typeof withSealedCheckRound>[0] {
  return { docker, plan: p, rootPath, files, environment: environment(), redactor: createServiceRedactor([PASSWORD]), ...extra };
}
const command = (executable: string, args: string[] = [], env?: Record<string, string>) => ({ cwd: ".", executable, args, timeoutSeconds: 60, ...(env === undefined ? {} : { env }) });

describe("withSealedCheckRound: the order is the seal (TS-SEAL-3)", () => {
  it("detaches the working sandbox, starts the check sandbox, runs the checks in it, removes it, and attaches the working sandbox again", async () => {
    const p = plan();
    const { docker, calls, execs } = fakeDocker(p.sandboxName);
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest", ["-q"])], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
    const order = verbs(calls);
    expect(order.indexOf("network disconnect")).toBeLessThan(order.indexOf("run"));
    // The proof is read again right before the start, and the start is the plan's own arguments, once.
    expect(calls.filter((call) => call[0] === "run")).toEqual([p.sandboxRunArgs]);
    expect(order.indexOf("run")).toBeLessThan(order.indexOf("exec"));
    expect(order.lastIndexOf("exec")).toBeLessThan(order.indexOf("rm"));
    expect(order.indexOf("rm")).toBeLessThan(order.indexOf("network connect"));
    expect(calls.filter((call) => call[0] === "network" && call[1] === "connect")).toEqual([["network", "connect", "--ip", p.workingSandboxIp, NET, WORK]]);
    expect(execs).toHaveLength(1);
  });

  it("every check, project command and agent replay, goes into the check sandbox; none into the working sandbox", async () => {
    const p = plan();
    const { docker, calls, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }, { order: 1, command: "cd pkg && make test", replay: "cd pkg && make test", exitCode: 0, afterFirstEdit: false, output: "" }] });
    const round = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed", "passed"]);
    expect(execs).toHaveLength(2);
    for (const call of calls.filter((entry) => entry[0] === "exec")) {
      expect(call).toContain(p.sandboxName);
      expect(call).not.toContain(WORK);
    }
    // The replay of `cd pkg && make test` runs `make test` from the contained directory.
    expect(execs[1]!.command[4]).toBe(join(rootPath, "pkg"));
    expect(execs[1]!.command.at(-1)).toBe("make test");
  });

  it("the working sandbox is attached again, and the check sandbox gone, when the round throws", async () => {
    const p = plan();
    const { docker, calls, state } = fakeDocker(p.sandboxName);
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.reject(new Error("round failed")))).rejects.toThrow("round failed");
    expect(state.sandboxUp).toBe(false);
    expect(state.workingNetworks).toContain(NET);
    const order = verbs(calls);
    expect(order.indexOf("rm")).toBeLessThan(order.indexOf("network connect"));
  });

  it("the working sandbox is attached again when the round is cancelled mid-check, and nothing runs after", async () => {
    const p = plan();
    const controller = new AbortController();
    const { docker, calls, state } = fakeDocker(p.sandboxName, { answer: () => { controller.abort(); return new Promise(() => undefined); } });
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("sleep", ["30"]), command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: controller.signal });
    expect(round.stopped).toBe(true);
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(state.sandboxUp).toBe(false);
    expect(state.workingNetworks).toContain(NET);
    expect(verbs(calls).filter((verb) => verb === "run")).toHaveLength(1);
  });

  it("does not run the round at all when the working sandbox cannot be proved off the network", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const stuck: DockerCli = { run: (args) => (args[0] === "inspect" ? Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ [NET]: {}, "agentx-task": {} }), stderr: "" }) : docker.run(args)) };
    let ran = false;
    await expect(withSealedCheckRound(roundInput(stuck, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/still on the run's services network/u);
    expect(ran).toBe(false);
    expect(calls.filter((call) => call[0] === "run")).toEqual([]);
  });

  it("does not run the round when the check sandbox cannot start, and still attaches the working sandbox", async () => {
    const p = plan();
    const { docker, state } = fakeDocker(p.sandboxName, { startExit: 125 });
    let ran = false;
    await expect(withSealedCheckRound(roundInput(docker, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/could not be started/u);
    expect(ran).toBe(false);
    expect(state.workingNetworks).toContain(NET);
  });

  it("leaves the working sandbox detached, and throws, when the check sandbox cannot be removed", async () => {
    const p = plan();
    const { docker, state } = fakeDocker(p.sandboxName, { removeFails: true });
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.resolve("done"))).rejects.toThrow(/could not be removed/u);
    expect(state.workingNetworks).not.toContain(NET);
  });

  it("each round is its own: a second call starts a second check sandbox after the first was removed (the TESTPROOF rerun)", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const input = roundInput(docker, p);
    for (let index = 0; index < 2; index += 1) await runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(verbs(calls).filter((verb) => verb === "run")).toHaveLength(2);
    expect(verbs(calls).filter((verb) => verb === "rm")).toHaveLength(2);
    const order = verbs(calls);
    expect(order.indexOf("network connect")).toBeLessThan(order.indexOf("network disconnect", order.indexOf("network connect")));
  });

  it("puts the helpers back (freshServices) only after the working sandbox is gone and the check sandbox is up, before the first check", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const seen: string[] = [];
    const input = roundInput(docker, p, { freshServices: () => { seen.push(verbs(calls).join(",")); return Promise.resolve(); } });
    await runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(seen).toEqual(["network disconnect,inspect,inspect,run"]);
  });

  it("a source guard: nothing but check-sandbox.ts reads a plan's sandboxRunArgs", async () => {
    const root = new URL("../../packages/worker/src/", import.meta.url).pathname;
    const found: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts") && /\.sandboxRunArgs\b|\{[^}]*\bsandboxRunArgs\b[^}]*\}\s*=/u.test(await readFile(path, "utf8"))) found.push(path.slice(root.length));
      }
    };
    await walk(root);
    expect(found).toEqual(["check-sandbox.ts"]);
  });
});

describe("the sealed exec: the run's variables are a file, last, and never on the command line", () => {
  it("writes the variables to a 0600 env file for the exec, passes only its path, and removes it afterwards", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    const seen = execs[0]!;
    expect(seen.envFile!.mode).toBe(0o600);
    expect(seen.envFile!.text).toBe(`DATABASE_URL=postgres://app:${PASSWORD}@postgres:5432/app\n`);
    expect(seen.envFile!.path.startsWith(files.directory)).toBe(true);
    // The secret is nowhere in any docker argument of the whole round.
    expect(seen.args.join("\0")).not.toContain(PASSWORD);
    expect(existsSync(seen.envFile!.path)).toBe(false);
    expect(readdirSync(files.directory)).toEqual([]);
  });

  it("drops a name the run sets from the command's own env, so the repository cannot win over the channel", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks([command("pytest", [], { DATABASE_URL: "postgres://evil@attacker.test/x", KEEP_ME: "1" })], { firstRuns: () => [] });
    await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    const seen = execs[0]!;
    expect(seen.envFlags).toContain("KEEP_ME=1");
    expect(seen.envFlags.some((flag) => flag.startsWith("DATABASE_URL="))).toBe(false);
    expect(seen.args.join("\0")).not.toContain("attacker.test");
    expect(seen.envFile!.text).toContain("DATABASE_URL=postgres://app:");
  });

  it("does not copy the worker's own environment into the agent's replay", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    process.env["ROVARA_TEST_WORKER_SECRET"] = "worker-only-value-1234";
    try {
      const checks = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }] });
      await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    } finally { delete process.env["ROVARA_TEST_WORKER_SECRET"]; }
    expect(execs[0]!.args.join("\0")).not.toContain("worker-only-value-1234");
    // What it does get: the sandbox's Python setting and the AgentX git identity, as the working sandbox's replay does.
    expect(execs[0]!.envFlags).toEqual(expect.arrayContaining([`PYTHONUSERBASE=${join(rootPath, ".agentx-python")}`, ...Object.entries(AGENTX_GIT_IDENTITY_ENVIRONMENT).map(([name, value]) => `${name}=${value}`)]));
  });

  it("an exec after the round is over is refused, so a runner kept by mistake runs nothing", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    let kept: ReturnType<typeof createCheckRunners> | undefined;
    await withSealedCheckRound(roundInput(docker, p), (runners) => { kept = runners; return Promise.resolve(); });
    const before = calls.length;
    const result = await runChecks(planChecks([command("true")], { firstRuns: () => [] }), kept!, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(result.entries[0]).toMatchObject({ after: "failed" });
    expect(result.entries[0]!.output).toMatch(/not running/u);
    expect(calls.length).toBe(before);
  });

  it("refuses a sandbox name that is not a container name", () => {
    expect(() => sealedContainerExec({ docker: fakeDocker("x").docker, container: "--privileged x", files, environment: environment(), live: () => true })).toThrow();
    expect(() => sealedContainerExec({ docker: fakeDocker("x").docker, container: "-v", files, environment: environment(), live: () => true })).toThrow();
  });

  it("an empty environment passes no env file", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p, { environment: { entries: [], secretValues: [] } }), planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(execs[0]!.envFile).toBeUndefined();
    expect(execs[0]!.args).not.toContain("--env-file");
  });
});

describe("the sealed runners keep the run's secrets out of what they report", () => {
  it("redacts the password, in any case, from stdout, stderr and the agent's output", async () => {
    const p = plan();
    const { docker } = fakeDocker(p.sandboxName, { answer: () => ({ exitCode: 1, stdout: `connecting as ${PASSWORD}\n`, stderr: `FATAL: password authentication failed for ${PASSWORD.toUpperCase()} / ${PASSWORD.toLowerCase()}\n` }) });
    const checks = planChecks([command("pytest")], { firstRuns: () => [] });
    const readiness = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(readiness.entries[0]!.after).toBe("failed");
    expect(readiness.entries[0]!.output.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    expect(readiness.entries[0]!.output).toContain("<redacted>");
    const replay = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }] });
    const agent = await runSealedCheckRound(roundInput(docker, p), replay, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(JSON.stringify(agent.entries).toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  it("redacts the password from the message of a failed exec", async () => {
    const p = plan();
    const { docker } = fakeDocker(p.sandboxName, { answer: () => { throw new Error(`docker exec failed near ${PASSWORD}`); } });
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries[0]).toMatchObject({ after: "failed" });
    expect(JSON.stringify(round.entries)).not.toContain(PASSWORD);
  });
});

describe("createCheckRunners with `sealed` has no unsealed fallback", () => {
  const sealed = { exec: () => Promise.reject(new Error("unused")), redact: (text: string) => text };
  it("throws when given a devcontainer, a task sandbox, bash operations or the local shell as well", () => {
    const cli = { run: () => Promise.reject(new Error("unused")) } as never;
    expect(() => createCheckRunners({ rootPath, sealed, devcontainer: { cli, target: { rootPath } as never } })).toThrow(/check sandbox alone/u);
    expect(() => createCheckRunners({ rootPath, sealed, sandbox: {} as never })).toThrow(/check sandbox alone/u);
    expect(() => createCheckRunners({ rootPath, sealed, bashOperations: { exec: () => Promise.reject(new Error("unused")) } })).toThrow(/check sandbox alone/u);
    expect(() => createCheckRunners({ rootPath, sealed, local: true })).toThrow(/check sandbox alone/u);
    expect(() => createCheckRunners({ rootPath, sealed })).not.toThrow();
  });

  it("still refuses an agent command that is not a simple test command, and a cd that leaves the workspace", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks(undefined, { firstRuns: () => [
      { order: 0, command: "make test; rm -rf pkg", replay: "make test; rm -rf pkg", exitCode: 0, afterFirstEdit: false, output: "" },
      { order: 1, command: "cd .. && make test", replay: "cd .. && make test", exitCode: 0, afterFirstEdit: false, output: "" },
    ] });
    const round = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(execs).toEqual([]);
  });
});
