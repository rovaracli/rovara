// SH35: the ExecutionTarget seam. The `sandbox` target is today's task sandbox with NO behaviour change (the same docker calls, arguments, environment, timeouts and outputs), `runner:<id>` is refused
// ("no runner configured"), and no call site starts a command except through the seam.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectCommand } from "../../packages/contracts/src/index.js";
import {
  NO_RUNNER_CONFIGURED, SANDBOX_TARGET, executionFor, formatExecutionTarget, parseExecutionTarget, proveCommandPort,
} from "../../packages/worker/src/execution-target.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "a".repeat(64);
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A fake Docker that records every call WITH the options it was given (timeout, signal, output hooks), and answers `exec` with a fixed result. */
function recordingDocker(exec: { exitCode: number; stdout: string; stderr: string }) {
  const calls: Array<{ args: string[]; timeoutMs: number | undefined; hasSignal: boolean }> = [];
  const docker: DockerCli = {
    run: async (args, options) => {
      calls.push({ args: [...args], timeoutMs: options?.timeoutMs, hasSignal: options?.signal !== undefined });
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] === "exec") { options?.onStdout?.(Buffer.from(exec.stdout)); options?.onStderr?.(Buffer.from(exec.stderr)); return exec; }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls };
}

async function sandboxWith(exec = { exitCode: 3, stdout: "out\n", stderr: "err\n" }, shared?: string) {
  const root = shared ?? await mkdtemp(join(tmpdir(), "exec-target-"));
  if (shared === undefined) roots.push(root);
  const fake = recordingDocker(exec);
  return { sandbox: new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }), fake, root };
}

/** The docker calls after the start, with this sandbox's container name and every random file name made stable, so two runs of the same command can be compared. */
function normalized(calls: ReturnType<typeof recordingDocker>["calls"], name: string) {
  return calls.filter((call) => call.args[0] === "exec").map((call) => ({ ...call, args: call.args.map((arg) => arg.split(name).join("<container>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>").replace(/[0-9a-f]{16,}/gu, "<hex>")) }));
}

const command: ProjectCommand = { cwd: ".", executable: "pytest", args: ["-q", "tests/unit"], timeoutSeconds: 1_800, env: { PYTHONHASHSEED: "0", CI: "1" } };

describe("the sandbox target is the task sandbox, unchanged", () => {
  it("runs a project command with the same docker calls, arguments, environment, timeout and output", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    const signal = new AbortController().signal;
    const directResult = await direct.sandbox.runCommand(command, signal);
    const seamResult = await executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).runCommand(command, signal);
    expect(seamResult).toEqual(directResult);
    expect(seamResult).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    const expected = normalized(direct.fake.calls, direct.sandbox.name);
    expect(expected.length).toBeGreaterThan(0);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(expected);
    // The command's environment and its timeout reached docker.
    expect(expected.some((call) => call.args.some((arg) => arg.includes("PYTHONHASHSEED=0")))).toBe(true);
    expect(expected.some((call) => call.timeoutMs !== undefined)).toBe(true);
    expect(expected.some((call) => call.hasSignal)).toBe(true);
  });

  it("runs a project command with no signal exactly as the sandbox does", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    await direct.sandbox.runCommand(command);
    await executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).runCommand(command);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(normalized(direct.fake.calls, direct.sandbox.name));
  });

  it("gives the agent's shell the same docker calls, environment, timeout and output", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    const run = async (operations: ReturnType<TaskSandbox["bashOperations"]>, root: string) => {
      const seen: string[] = [];
      const result = await operations.exec("echo hi && pytest -q", root, { onData: (data) => seen.push(data.toString("utf8")), timeout: 120, env: { ...process.env, AGENTX_TEST: "1" } });
      return { result, seen };
    };
    const expected = await run(direct.sandbox.bashOperations(), direct.root);
    const actual = await run(executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).bashOperations(), viaSeam.root);
    expect(actual.result).toEqual(expected.result);
    expect(actual.seen).toEqual(expected.seen);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(normalized(direct.fake.calls, direct.sandbox.name));
  });

  it("calls the sandbox's own methods, passing exactly the arguments given", async () => {
    const seen: unknown[][] = [];
    const sandbox = {
      runCommand: (...args: unknown[]) => { seen.push(args); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); },
      bashOperations: () => { seen.push(["bash"]); return { exec: () => Promise.resolve({ exitCode: 0 }) }; },
    } as unknown as TaskSandbox;
    const target = executionFor(SANDBOX_TARGET, { sandbox });
    const signal = new AbortController().signal;
    await target.runCommand(command);
    await target.runCommand(command, signal);
    target.bashOperations();
    expect(seen).toEqual([[command], [command, signal], ["bash"]]);
    expect(seen[0]).toHaveLength(1);
  });

  it("needs the sandbox the caller started, and never starts or falls back to anything else", () => {
    expect(() => executionFor(SANDBOX_TARGET, {})).toThrow(/no task sandbox/u);
  });
});

describe("the runner target is refused", () => {
  it("is refused with 'no runner configured', even when a sandbox is at hand", async () => {
    const { sandbox } = await sandboxWith();
    const target = parseExecutionTarget("runner:build-host-1");
    expect(target).toEqual({ kind: "runner", id: "build-host-1" });
    expect(() => executionFor(target, { sandbox })).toThrow(NO_RUNNER_CONFIGURED);
    expect(() => executionFor(target, {})).toThrow(NO_RUNNER_CONFIGURED);
  });

  it("parses only 'sandbox' and 'runner:<id>'", () => {
    expect(parseExecutionTarget("sandbox")).toEqual(SANDBOX_TARGET);
    expect(formatExecutionTarget(parseExecutionTarget("runner:a_b-1"))).toBe("runner:a_b-1");
    for (const bad of ["", "local", "Sandbox", "runner:", "runner:UPPER", "runner:a b", "runner:../x", "runner:-x", "sandbox:x", "runner:" + "a".repeat(64)]) {
      expect(() => parseExecutionTarget(bad), bad).toThrow(RangeError);
    }
  });
});

describe("Prove's command port", () => {
  it("returns the exit code, the output and a timeout flag from the target", async () => {
    const calls: unknown[][] = [];
    const port = proveCommandPort({
      bashOperations: () => { throw new Error("not used"); },
      runCommand: (...args) => { calls.push(args); return Promise.resolve({ exitCode: 124, stdout: "o", stderr: "e", timedOut: true }); },
    });
    const signal = new AbortController().signal;
    expect(await port(command, signal)).toEqual({ exitCode: 124, timedOut: true, stdout: "o", stderr: "e" });
    expect(calls).toEqual([[command, signal]]);
    const plain = proveCommandPort({ bashOperations: () => { throw new Error("x"); }, runCommand: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) });
    expect(await plain(command, signal)).toEqual({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
  });
});

describe("no call site reaches the sandbox's commands except through the seam", () => {
  it("has no direct sandbox.bashOperations() or sandbox.runCommand() outside the sandbox and the seam", async () => {
    const base = join(process.cwd(), "packages/worker/src");
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path); else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    await walk(base);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("/task-sandbox.ts") || file.endsWith("/execution-target.ts")) continue;
      const text = await readFile(file, "utf8");
      text.split("\n").forEach((line, at) => {
        if (/\bsandbox\.(bashOperations|runCommand)\(/u.test(line)) offenders.push(`${file.slice(base.length + 1)}:${String(at + 1)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
