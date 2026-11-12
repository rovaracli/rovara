// Slice 4, lane W1: the worker's sandbox controller against a fake Docker and a fake agent (tests/support/fake-sandbox-docker.ts). Pools, warm reuse, concurrency, the memory budget and eviction, deadlines, crashes,
// the stop barrier, and the reaper (including the fix for the parked branch's stuck-stop leak).
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxController, type FunctionConfig, type FunctionKey, type SandboxController, type SandboxControllerOptions, type SandboxLogEvent } from "../../packages/worker/src/function-runner/controller.js";
import { sandboxArgProblems, type SandboxSpec } from "../../packages/worker/src/function-runner/sandbox-spec.js";
import { echoAgent, fakeSandboxFiles, fakeSandboxHost, resultFor, type AgentBehavior, type FakeSandboxHostOptions } from "../support/fake-sandbox-docker.js";
const b64 = (text: string): string => Buffer.from(text).toString("base64");

const KEY: FunctionKey = { functionName: "resize", version: "1" };
const config = (change: Partial<FunctionConfig> = {}): FunctionConfig => ({
  runtime: "python3.12", handler: "app.handler", environment: { STAGE: "test" }, region: "us-east-1", memoryMb: 128, timeoutSeconds: 3, ephemeralMb: 512,
  image: "public.ecr.aws/lambda/python:3.12-arm64", agentHostPath: "/opt/rovara/runner/agent", codeHostPath: "/run/rovara/code/aaa", layersHostPath: "/run/rovara/layers/bbb",
  network: { mode: "none" }, maxConcurrency: 4, ...change,
});

let counter = 0;
function setup(host: FakeSandboxHostOptions = {}, controller: Partial<SandboxControllerOptions> = {}) {
  const fake = fakeSandboxHost(host);
  const fs = fakeSandboxFiles();
  const events: SandboxLogEvent[] = [];
  const clock = { now: 1_000_000 };
  const runner: SandboxController = createSandboxController({
    docker: fake.docker, launcher: fake.launcher, memoryBudgetMiB: 1_024, labels: [{ key: "rovara.run", value: "run-1" }], autoReap: false, backstopMs: 30,
    log: (event) => events.push(event), now: () => clock.now, scratchBaseDir: "/run/rovara/scratch", initTimeoutMs: 400, ...fs,
    newEnvironmentId: () => `env-${String((counter += 1)).padStart(6, "0")}`, ...controller,
  });
  return { ...fake, runner, events, clock, fs };
}
const call = (runner: SandboxController, requestId = "r1", payload = "{\"n\":1}", extra: { key?: FunctionKey; timeoutMs?: number } = {}) => runner.invoke({ key: extra.key ?? KEY, requestId, payload, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });
/** An agent that never answers an invoke. */
const silent: AgentBehavior = () => undefined;
const valuesOf = (args: string[], flag: string): string[] => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("warm reuse and cold starts", () => {
  it("starts one sandbox with the function's environment, invokes it, and reuses it warm", async () => {
    const { runner, runArgs, everStarted, events, fs } = setup();
    await runner.register(KEY, config());
    const first = await call(runner, "r1", "{\"a\":1}");
    expect(first).toMatchObject({ kind: "response", cold: true, memoryMb: 128, memoryClamped: false, initLogTail: "init output\n", report: { durationMs: 3, billedDurationMs: 3 }, maxMemoryUsedBytes: 20_000_000 });
    expect(first.kind === "response" && first.payload.toString()).toBe("{\"a\":1}");
    expect(first.kind === "response" && first.logTail).toContain("START RequestId: r1");
    expect(first.kind === "response" && first.coldStartMs).toBeGreaterThanOrEqual(0);
    const second = await call(runner, "r2", "{\"a\":2}");
    expect(second).toMatchObject({ kind: "response", cold: false });
    expect(second.kind === "response" && second.payload.toString()).toBe("{\"a\":2}");
    expect(runArgs).toHaveLength(1);
    // No init frame: the agent takes its environment from the sandbox.
    expect(everStarted[0]!.frames.map((frame) => frame.type)).toEqual(["invoke", "invoke"]);
    expect(everStarted[0]!.frames[0]).toMatchObject({ type: "invoke", requestId: "r1", payload: b64("{\"a\":1}"), timeoutMs: 3000, functionVersion: "1", memorySizeMb: 128 });
    // The environment travels in a 0600 file, never in the arguments, and the file is gone once the sandbox is up.
    expect(runArgs[0]!.some((arg) => arg.includes("STAGE") || arg.includes("AWS_LAMBDA_FUNCTION_NAME"))).toBe(false);
    expect(valuesOf(runArgs[0]!, "--env-file")).toEqual([fs.written[0]!.path]);
    expect(fs.files.size).toBe(0);
    expect(fs.written[0]!.path).toMatch(/^\/run\/rovara\/scratch\/env\/env-\d{6}\.env$/u);
    const environment = fs.written[0]!.content.trim().split("\n");
    for (const entry of ["STAGE=test", "_HANDLER=app.handler", "AWS_LAMBDA_FUNCTION_NAME=resize", "AWS_LAMBDA_FUNCTION_VERSION=1", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE=128", "AWS_REGION=us-east-1", "AWS_DEFAULT_REGION=us-east-1", "AWS_EXECUTION_ENV=AWS_Lambda_python3.12", "AWS_LAMBDA_LOG_GROUP_NAME=/aws/lambda/resize", "AWS_LAMBDA_INITIALIZATION_TYPE=on-demand", "LAMBDA_TASK_ROOT=/var/task", "LAMBDA_RUNTIME_DIR=/var/runtime", "TZ=:UTC"]) expect(environment).toContain(entry);
    expect(environment.find((entry) => entry.startsWith("AWS_LAMBDA_LOG_STREAM_NAME="))).toMatch(/^AWS_LAMBDA_LOG_STREAM_NAME=\d{4}\/\d{2}\/\d{2}\/\[1\][a-z0-9]{1,32}$/u);
    expect(first.kind === "response" && second.kind === "response" && first.environmentId === second.environmentId).toBe(true);
    const metrics = runner.metrics();
    expect(metrics.total).toMatchObject({ invocations: 2, coldStarts: 1, warmStarts: 1 });
    expect(metrics.functions[0]).toMatchObject({ functionName: "resize", version: "1" });
    expect(events.map((event) => event.event)).toEqual(["cold_start", "warm_hit"]);
  });

  it("passes the invoke's ARN, trace id, client context and identity to the agent", async () => {
    const { runner, everStarted } = setup();
    await runner.register(KEY, config({ functionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize" }));
    await runner.invoke({ key: KEY, requestId: "r1", payload: "{}", traceId: "Root=1-abc", clientContext: "e30=", cognitoIdentity: "{}", invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize:prod" });
    expect(everStarted[0]!.frames[0]).toMatchObject({ functionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize:prod", traceId: "Root=1-abc", clientContext: "e30=", cognitoIdentity: "{}" });
    await runner.invoke({ key: KEY, requestId: "r2", payload: "{}" });
    expect(everStarted[0]!.frames[1]).toMatchObject({ functionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize" });
  });

  it("builds every launched argv from the typed spec and passes the allow-list", async () => {
    const { runner, runArgs, fs } = setup();
    await runner.register(KEY, config());
    await call(runner);
    const args = runArgs[0]!;
    const environmentId = args.find((arg) => arg.startsWith("rovara.function="))!.split("=")[1]!;
    const spec: SandboxSpec = {
      environmentId, image: config().image, agentHostPath: config().agentHostPath, codeHostPath: config().codeHostPath, layersHostPath: config().layersHostPath!,
      envFile: valuesOf(args, "--env-file")[0]!,
      environment: Object.fromEntries(fs.written[0]!.content.trim().split("\n").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])),
      memoryMb: 128, cpus: 0.5, scratch: { kind: "host-dir", hostPath: `/run/rovara/scratch/tmp/${environmentId}` }, tmpExec: true, network: { mode: "none" }, labels: [{ key: "rovara.run", value: "run-1" }],
    };
    expect(args.slice(0, 2)).toEqual(["run", "-i"]);
    expect(sandboxArgProblems(args, spec)).toEqual([]);
    expect(sandboxArgProblems([...args.slice(0, 2), "--privileged", ...args.slice(2)], spec)).not.toEqual([]);
  });

  it("does not reuse an environment whose process ended while idle", async () => {
    const { runner, everStarted, runArgs } = setup();
    await runner.register(KEY, config());
    await call(runner, "r1");
    everStarted[0]!.die(1);
    await wait(10);
    const again = await call(runner, "r2");
    expect(again).toMatchObject({ kind: "response", cold: true });
    expect(runArgs).toHaveLength(2);
    expect(runner.stats().reservedMiB).toBe(128);
  });

  it("removes an idle environment whose runtime died, and starts cold next time", async () => {
    const { runner, everStarted, containers } = setup();
    await runner.register(KEY, config());
    await call(runner, "r1");
    everStarted[0]!.emit({ type: "runtime_exit", exitCode: 1, message: "died", logTail: "" });
    await wait(15);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
    expect(await call(runner, "r2")).toMatchObject({ kind: "response", cold: true });
  });

  it("keeps the environment warm after a function error, and returns the error document", async () => {
    const failing: AgentBehavior = (frame, container) => {
      if (frame.type === "invoke") container.emit(resultFor(frame, { status: "function_error", errorType: "ValueError", errorMessage: "bad", payload: b64("{\"errorType\":\"ValueError\"}") }));
    };
    const { runner, runArgs } = setup({ agent: failing });
    await runner.register(KEY, config());
    const first = await call(runner, "r1");
    expect(first).toMatchObject({ kind: "error", errorType: "ValueError", errorMessage: "bad", cold: true });
    expect(first.kind === "error" && first.payload.toString()).toBe("{\"errorType\":\"ValueError\"}");
    expect(await call(runner, "r2")).toMatchObject({ kind: "error", cold: false });
    expect(runArgs).toHaveLength(1);
    expect(runner.metrics().total.coldStarts).toBe(1);
  });

  it("keeps the environment warm after a refusal that ran nothing", async () => {
    const refuse: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.emit(resultFor(frame, { status: "rejected", errorType: "InvalidPayload", errorMessage: "bad base64", payload: "" })); };
    const { runner, runArgs } = setup({ agent: refuse });
    await runner.register(KEY, config());
    expect(await call(runner, "r1")).toMatchObject({ kind: "rejected", errorType: "InvalidPayload" });
    expect(await call(runner, "r2")).toMatchObject({ kind: "rejected", cold: false });
    expect(runArgs).toHaveLength(1);
  });

  it("returns the answer even when the sandbox exits right after answering", async () => {
    const agent: AgentBehavior = (frame, container) => {
      if (frame.type !== "invoke") return;
      container.emit(resultFor(frame, { payload: b64("\"done\"") }));
      setTimeout(() => container.die(0), 0);
    };
    const { runner } = setup({ agent });
    await runner.register(KEY, config());
    const outcome = await call(runner);
    expect(outcome).toMatchObject({ kind: "response", cold: true });
    expect(outcome.kind === "response" && outcome.payload.toString()).toBe("\"done\"");
    await wait(10);
    expect((await call(runner, "r2")).kind).toBe("response");
  });

  it("reports the agent's logs and its truncation flag", async () => {
    const noisy: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.emit(resultFor(frame, { logTail: "tail\n", logTruncated: true })); };
    const { runner } = setup({ agent: noisy });
    await runner.register(KEY, config());
    const outcome = await call(runner);
    expect(outcome).toMatchObject({ kind: "response", logTail: "tail\n", logsTruncated: true });
  });

  it("sends the first invoke only after the runtime is ready: a slow start is not charged to a short Timeout (M1)", async () => {
    const slow = setup({ startup: (container) => { container.emit({ type: "hello", proto: "agent/1" }); setTimeout(() => container.emit({ type: "ready", initDurationMs: 250 }), 250); } }, { backstopMs: 30, initTimeoutMs: 2_000, now: Date.now });
    await slow.runner.register(KEY, config());
    const started = Date.now();
    const outcome = await call(slow.runner, "r1", "{}", { timeoutMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(outcome).toMatchObject({ kind: "response", cold: true });
    // No invoke frame was sent before ready, and the cold start covers the wait.
    expect(slow.everStarted[0]!.frames.map((frame) => frame.type)).toEqual(["invoke"]);
    expect(outcome.kind === "response" && outcome.coldStartMs).toBeGreaterThanOrEqual(240);
  });

  it("a runtime that never becomes ready is a start failure after the init deadline, not a function timeout", async () => {
    const { runner, containers, everStarted } = setup({ startup: (container) => container.emit({ type: "hello", proto: "agent/1" }) }, { initTimeoutMs: 60 });
    await runner.register(KEY, config());
    const out = await call(runner, "r1", "{}", { timeoutMs: 20 });
    expect(out).toMatchObject({ kind: "unavailable", reason: "start_failed" });
    expect(everStarted[0]!.frames).toEqual([]);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("an init_error before any invoke is reported as an init error with the runtime's document, and the sandbox goes", async () => {
    const { runner, containers, everStarted } = setup({ startup: (container) => { container.emit({ type: "hello", proto: "agent/1" }); container.emit({ type: "init_error", reason: "exited", errorType: "Runtime.ImportModuleError", errorMessage: "No module named x", payload: Buffer.from("{\"e\":1}").toString("base64"), logTail: "boom\n" }); } });
    await runner.register(KEY, config());
    const out = await call(runner);
    expect(out).toMatchObject({ kind: "init_error", errorType: "Runtime.ImportModuleError", errorMessage: "No module named x", logTail: "boom\n", cold: true });
    expect(out.kind === "init_error" && out.payload.toString()).toBe("{\"e\":1}");
    expect(everStarted[0]!.frames).toEqual([]);
    expect(containers.size).toBe(0);
    expect(runner.metrics().total.initErrors).toBe(1);
  });

  it("reads the cgroup peak memory host-side when given a reader, else uses the agent's figure", async () => {
    const seen: string[] = [];
    const { runner } = setup({}, { readMemoryPeak: (id) => { seen.push(id); return Promise.resolve(33_554_432); } });
    await runner.register(KEY, config());
    const outcome = await call(runner);
    expect(outcome.kind === "response" && outcome.maxMemoryUsedBytes).toBe(33_554_432);
    expect(seen[0]).toMatch(/^[a-f0-9]{64}$/u);
    const fallback = setup({}, { readMemoryPeak: () => Promise.resolve(undefined) });
    await fallback.runner.register(KEY, config());
    expect((await call(fallback.runner)).kind === "response" && true).toBe(true);
    expect(await call(fallback.runner, "r2")).toMatchObject({ maxMemoryUsedBytes: 20_000_000 });
  });

  it("retires idle environments when the configuration changes", async () => {
    const { runner, runArgs, containers } = setup();
    await runner.register(KEY, config());
    await call(runner, "r1");
    await runner.register(KEY, config());
    expect(containers.size).toBe(1);
    await runner.register(KEY, config({ environment: { STAGE: "other" } }));
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
    expect(await call(runner, "r2")).toMatchObject({ kind: "response", cold: true });
    expect(runArgs).toHaveLength(2);
  });

  it("refuses a call it should not send: a bad request id or a payload over Lambda's limit starts nothing", async () => {
    const { runner, runArgs } = setup();
    await runner.register(KEY, config());
    for (const requestId of ["", "a b", "x\ny", "r".repeat(129), "--privileged!"]) expect(await call(runner, requestId)).toEqual({ kind: "unavailable", reason: "invalid_request" });
    expect(await runner.invoke({ key: KEY, requestId: "r1", payload: Buffer.alloc(6_291_557) })).toEqual({ kind: "unavailable", reason: "invalid_request" });
    expect(runArgs).toHaveLength(0);
    expect((await runner.invoke({ key: KEY, requestId: "r2", payload: Buffer.alloc(100_000, 97) })).kind).toBe("response");
  });
});

describe("concurrency", () => {
  it("throttles past maxConcurrency and runs one invoke per environment", async () => {
    const { runner, everStarted } = setup({ agent: silent });
    await runner.register(KEY, config({ maxConcurrency: 2 }));
    const a = call(runner, "r1", "1", { timeoutMs: 80 });
    const b = call(runner, "r2", "2", { timeoutMs: 80 });
    const c = await call(runner, "r3", "3", { timeoutMs: 80 });
    expect(c).toEqual({ kind: "throttled", reason: "concurrency" });
    await wait(10);
    expect(everStarted).toHaveLength(2);
    expect((await a).kind).toBe("timeout");
    expect((await b).kind).toBe("timeout");
    expect(runner.metrics().total.throttled).toBe(1);
  });

  it("takes a different environment for a second concurrent call, then reuses both", async () => {
    const slow: AgentBehavior = (frame, container) => { if (frame.type === "invoke") setTimeout(() => echoAgent(frame, container), 30); };
    const { runner, runArgs } = setup({ agent: slow });
    await runner.register(KEY, config({ maxConcurrency: 2 }));
    const [a, b] = await Promise.all([call(runner, "r1"), call(runner, "r2")]);
    expect(a.kind === "response" && b.kind === "response" && a.environmentId !== b.environmentId).toBe(true);
    expect(runArgs).toHaveLength(2);
    const [c, d] = await Promise.all([call(runner, "r3"), call(runner, "r4")]);
    expect(c).toMatchObject({ cold: false });
    expect(d).toMatchObject({ cold: false });
    expect(runArgs).toHaveLength(2);
  });

  it("keeps a pool per function and version", async () => {
    const { runner, runArgs } = setup();
    await runner.register(KEY, config());
    await runner.register({ functionName: "resize", version: "2" }, config());
    await runner.register({ functionName: "other", version: "1" }, config());
    await call(runner, "r1");
    await call(runner, "r2", "1", { key: { functionName: "resize", version: "2" } });
    await call(runner, "r3", "1", { key: { functionName: "other", version: "1" } });
    expect(runArgs).toHaveLength(3);
    expect(await call(runner, "r4", "1", { key: { functionName: "unknown", version: "1" } })).toEqual({ kind: "unavailable", reason: "not_registered" });
    expect(runner.metrics().functions).toHaveLength(3);
  });
});

describe("the memory budget", () => {
  it("evicts the least recently used idle environment to make room", async () => {
    const { runner, containers, clock } = setup({}, { memoryBudgetMiB: 300 });
    const A: FunctionKey = { functionName: "a", version: "1" };
    const B: FunctionKey = { functionName: "b", version: "1" };
    const C: FunctionKey = { functionName: "c", version: "1" };
    for (const key of [A, B, C]) await runner.register(key, config({ memoryMb: 128 }));
    await call(runner, "r1", "1", { key: A });
    clock.now += 1_000;
    await call(runner, "r2", "1", { key: B });
    expect(runner.stats().reservedMiB).toBe(256);
    clock.now += 1_000;
    await call(runner, "r3", "1", { key: A });
    clock.now += 1_000;
    const out = await call(runner, "r4", "1", { key: C });
    expect(out).toMatchObject({ kind: "response", cold: true });
    // B was the least recently used idle one.
    expect(containers.size).toBe(2);
    expect(runner.stats().reservedMiB).toBe(256);
    expect(runner.metrics().functions.find((entry) => entry.functionName === "b")!.metrics.evictions).toBe(1);
    expect((await call(runner, "r5", "1", { key: A })).kind === "response").toBe(true);
  });

  it("throttles for memory when everything is busy", async () => {
    const { runner } = setup({ agent: silent }, { memoryBudgetMiB: 200 });
    await runner.register(KEY, config({ memoryMb: 128, maxConcurrency: 4 }));
    const first = call(runner, "r1", "1", { timeoutMs: 60 });
    await wait(5);
    expect(await call(runner, "r2")).toEqual({ kind: "throttled", reason: "memory" });
    expect((await first).kind).toBe("timeout");
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("runs a function larger than the whole budget clamped to the budget", async () => {
    const { runner, runArgs } = setup({}, { memoryBudgetMiB: 256 });
    await runner.register(KEY, config({ memoryMb: 1_024 }));
    const out = await call(runner);
    expect(out).toMatchObject({ kind: "response", memoryMb: 256, memoryClamped: true });
    expect(runArgs[0]![runArgs[0]!.indexOf("--memory") + 1]).toBe("256m");
    expect(runner.stats().reservedMiB).toBe(256);
  });

  it("waits for a stop in progress instead of throttling", async () => {
    // A is idle; B needs its memory; A's stop is slow (the kill takes a moment).
    let slow = false;
    const fake = fakeSandboxHost({ hangKill: () => slow });
    const events: SandboxLogEvent[] = [];
    const runner = createSandboxController({ docker: fake.docker, launcher: fake.launcher, memoryBudgetMiB: 150, labels: [], autoReap: false, backstopMs: 30, scratchBaseDir: "/run/rovara/scratch", ...fakeSandboxFiles(), log: (e) => events.push(e), newEnvironmentId: () => `env-${String((counter += 1)).padStart(6, "0")}` });
    const A: FunctionKey = { functionName: "a", version: "1" };
    const B: FunctionKey = { functionName: "b", version: "1" };
    await runner.register(A, config());
    await runner.register(B, config());
    await call(runner, "r1", "1", { key: A });
    slow = true;
    const evicting = call(runner, "r2", "1", { key: B });
    await wait(10);
    fake.releaseHung();
    slow = false;
    expect(await evicting).toMatchObject({ kind: "response", cold: true });
    expect(runner.stats().reservedMiB).toBe(128);
  });
});

describe("deadlines and crashes", () => {
  it("kills the sandbox at the deadline and reports a timeout, then starts cold next time", async () => {
    const { runner, containers, runArgs } = setup({ agent: silent });
    await runner.register(KEY, config());
    const started = Date.now();
    const out = await call(runner, "r1", "1", { timeoutMs: 40 });
    expect(out).toMatchObject({ kind: "timeout", cold: true, errorType: "Sandbox.Timedout", errorMessage: "Task timed out after 0.04 seconds" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(containers.size).toBe(0);
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
    expect(runner.metrics().total.timeouts).toBe(1);
    const next = await call(runner, "r2");
    expect(next.kind).toBe("timeout");
    expect(runArgs).toHaveLength(2);
  });

  it("removes the sandbox when the agent itself reports a timeout, a crash or an init error", async () => {
    for (const [status, kind, errorType] of [["timeout", "timeout", "Sandbox.Timedout"], ["crash", "crash", "Runtime.ExitError"], ["init_error", "init_error", "Runtime.ImportModuleError"]] as const) {
      const agent: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.emit(resultFor(frame, { status, errorType, errorMessage: "m", payload: b64("{}") })); };
      const { runner, containers, runArgs } = setup({ agent });
      await runner.register(KEY, config());
      const out = await call(runner);
      expect(out, status).toMatchObject({ kind, errorType, errorMessage: "m", cold: true });
      await wait(10);
      expect(containers.size, status).toBe(0);
      expect(runner.stats().reservedMiB, status).toBe(0);
      expect(await call(runner, "r2")).toMatchObject({ cold: true });
      expect(runArgs).toHaveLength(2);
    }
  });

  it("reports a crash with the exit code, and the OOM killer when it was the cause", async () => {
    const crash: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.die(1); };
    const oom: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.die(137, { oom: true }); };
    const a = setup({ agent: crash });
    await a.runner.register(KEY, config());
    const crashed = await call(a.runner);
    expect(crashed).toMatchObject({ kind: "crash", exitCode: 1, oomKilled: false, cold: true });
    expect(a.containers.size).toBe(0);
    expect(a.runner.stats().reservedMiB).toBe(0);
    const b = setup({ agent: oom });
    await b.runner.register(KEY, config());
    expect(await call(b.runner)).toMatchObject({ kind: "crash", exitCode: 137, oomKilled: true });
    expect(b.runner.metrics().total).toMatchObject({ crashes: 1, ooms: 1 });
    expect(b.containers.size).toBe(0);
  });

  it("reports docker's own failure as an unavailable start, with a bounded text, and frees the memory", async () => {
    const { runner } = setup({ failRun: "docker: Error response from daemon: unknown or invalid runtime name: runsc\u0007" });
    await runner.register(KEY, config());
    const out = await call(runner);
    expect(out).toMatchObject({ kind: "unavailable", reason: "start_failed" });
    expect(out.kind === "unavailable" && out.detail).toContain("unknown or invalid runtime name");
    expect(out.kind === "unavailable" && out.detail).not.toContain("\u0007");
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
    expect(runner.metrics().total.startFailures).toBe(1);
  });

  it("treats an init error as a failed environment: removed, retried cold", async () => {
    const bad: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.emit(resultFor(frame, { status: "init_error", errorType: "Runtime.ImportModuleError", errorMessage: "No module named x", payload: b64("{\"errorType\":\"Runtime.ImportModuleError\"}") })); };
    const { runner, containers } = setup({ agent: bad });
    await runner.register(KEY, config());
    const out = await call(runner);
    expect(out).toMatchObject({ kind: "init_error", errorType: "Runtime.ImportModuleError" });
    await wait(10);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("kills an agent that speaks garbage or a frame over the cap", async () => {
    const garbage: AgentBehavior = (frame, container) => { if (frame.type === "invoke") { const header = Buffer.alloc(4); header.writeUInt32BE(0x7fffffff); container.emitRaw(header); } };
    const { runner, containers } = setup({ agent: garbage }, { maxFrameBytes: 1_024 });
    await runner.register(KEY, config());
    expect(await call(runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
    const junk: AgentBehavior = (frame, container) => { if (frame.type === "invoke") container.emitRaw(Buffer.from("this is not a frame at all, just stdout text\n")); };
    const other = setup({ agent: junk });
    await other.runner.register(KEY, config());
    expect(await call(other.runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    expect(other.containers.size).toBe(0);
  });

  it("a result for another request id is a protocol violation, and the sandbox goes", async () => {
    const stray: AgentBehavior = (frame, container) => {
      if (frame.type !== "invoke") return;
      container.emit(resultFor({ ...frame, requestId: "someone-else" }, { payload: b64("no") }));
      container.emit(resultFor(frame, { payload: b64("yes") }));
    };
    const { runner, containers } = setup({ agent: stray });
    await runner.register(KEY, config());
    expect(await call(runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("refuses an agent that speaks another protocol", async () => {
    const { runner, containers } = setup({ startup: (container) => container.emit({ type: "hello", proto: "agent/9" }) });
    await runner.register(KEY, config());
    expect(await call(runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    expect(containers.size).toBe(0);
  });

  it("reports the agent's last words when it dies at start", async () => {
    const { runner } = setup({ startup: (container) => { container.emit({ type: "hello", proto: "agent/1" }); container.emit({ type: "fatal", message: "listen tcp 127.0.0.1:9001: address in use\u0007" }); setTimeout(() => container.die(2), 5); }, agent: silent });
    await runner.register(KEY, config());
    const out = await call(runner);
    expect(out).toMatchObject({ kind: "unavailable", reason: "start_failed" });
    expect(out.kind === "unavailable" && out.detail).toContain("address in use");
    expect(out.kind === "unavailable" && out.detail).not.toContain("\u0007");
    expect(runner.stats().reservedMiB).toBe(0);
  });
});

describe("hostile function data stays out of the docker arguments", () => {
  it("keeps hostile names and environment values in the 0600 environment file, out of every argument and control command (L2)", async () => {
    const { runner, runArgs, controlCalls, fs } = setup();
    const key: FunctionKey = { functionName: "--privileged -v /:/host", version: "$LATEST" };
    const environment = { FLAG: "--privileged", ARGS: "-v /:/host --cap-add=ALL", BIG: "y".repeat(8_000), "ODD_NAME_1": "\u202e", PIDFILE: "/var/run/app.pid" };
    await runner.register(key, config({ environment }));
    expect((await call(runner, "r1", "{}", { key })).kind).toBe("response");
    const args = runArgs[0]!;
    expect(args.filter((arg) => arg.includes("privileged") || arg.includes("--cap-add") || arg.includes("yyyy") || arg.includes("/var/run/app.pid") || arg.includes("/:/host"))).toEqual([]);
    expect(args).not.toContain("-e");
    expect(args.some((arg, index) => args[index - 1] === "-v")).toBe(false);
    const content = fs.written[0]!.content;
    expect(content).toContain("ARGS=-v /:/host --cap-add=ALL\n");
    expect(content).toContain(`AWS_LAMBDA_FUNCTION_NAME=${key.functionName}\n`);
    // One line per variable: no value can start another.
    expect(content.split("\n").filter(Boolean).every((line) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(line))).toBe(true);
    await runner.stopAll();
    for (const control of controlCalls) { expect(control.join(" ")).not.toContain("privileged"); expect(control.at(-1)).toMatch(/^rovara-fn-[0-9a-f]{16}$/u); }
  });

  it("refuses an environment value with a newline, a carriage return or NUL: the file format has no escaping (L2)", async () => {
    const { runner } = setup();
    for (const value of ["a\nB=c", "a\r", "a\0"]) await expect(runner.register(KEY, config({ environment: { EVIL: value } })), JSON.stringify(value)).rejects.toThrow(RangeError);
  });

  it("deletes the environment file once the sandbox is up, and also when the start fails", async () => {
    const ok = setup();
    await ok.runner.register(KEY, config());
    await call(ok.runner);
    expect(ok.fs.files.size).toBe(0);
    expect(ok.fs.written).toHaveLength(1);
    const bad = setup({ failRun: "docker: boom" });
    await bad.runner.register(KEY, config());
    expect((await call(bad.runner)).kind).toBe("unavailable");
    expect(bad.fs.files.size).toBe(0);
    expect(bad.fs.written).toHaveLength(1);
  });

  it("refuses a function that sets a reserved variable, as AWS does", async () => {
    const { runner } = setup();
    for (const name of ["_HANDLER", "AWS_REGION", "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "PATH", "LD_LIBRARY_PATH", "TZ", "LANG"]) await expect(runner.register(KEY, config({ environment: { [name]: "x" } })), name).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: { AWS_ACCESS_KEY_ID: "ROVARATESTKEY", AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrap" } }))).resolves.toBeUndefined();
  });

  it("refuses names with control characters, huge or malformed environments, bad paths, and odd images at register", async () => {
    const { runner } = setup();
    await expect(runner.register({ functionName: "a\nb", version: "1" }, config())).rejects.toThrow(RangeError);
    await expect(runner.register({ functionName: "", version: "1" }, config())).rejects.toThrow(RangeError);
    await expect(runner.register({ functionName: "x".repeat(141), version: "1" }, config())).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: { "BAD NAME": "v" } }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: { "--rm": "v" } }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: { A: "v\0w" } }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: { A: "v".repeat(9_000) } }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: Object.fromEntries(Array.from({ length: 300 }, (_v, index) => [`K${String(index)}`, "v"])) }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ environment: Object.fromEntries(Array.from({ length: 20 }, (_v, index) => [`K${String(index)}`, "v".repeat(5_000)])) }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ timeoutSeconds: 0 }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ maxConcurrency: 1_000 }))).rejects.toThrow(RangeError);
  });

  it("a hostile image, path or extra mount registers but never launches", async () => {
    const { runner, runArgs, containers } = setup();
    for (const change of [{ image: "--privileged" }, { image: "img\n--cap-add=ALL" }, { codeHostPath: "/a:/b:rw" }, { layersHostPath: "/x,y" }, { agentHostPath: "../agent" }, { extraMounts: [{ hostPath: "/x", containerPath: "/etc/passwd" }] }]) {
      await runner.register(KEY, config(change));
      const out = await call(runner);
      expect(out, JSON.stringify(change)).toMatchObject({ kind: "unavailable", reason: "start_failed" });
    }
    expect(runArgs).toHaveLength(0);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });
});

describe("the stop barrier", () => {
  it("stops idle and busy sandboxes, ends the in-flight call, frees everything, then refuses later calls", async () => {
    const { runner, containers, everStarted } = setup({ agent: (frame, container) => { if (frame.type === "invoke" && frame.payload === "\"idle\"") echoAgent(frame, container); } });
    await runner.register(KEY, config({ maxConcurrency: 3 }));
    await call(runner, "r1", "\"idle\"");
    const inFlight = call(runner, "r2", "\"hang\"", { timeoutMs: 5_000 });
    await call(runner, "r3", "\"hang\"", { timeoutMs: 30 }).then(() => undefined);
    // r2 holds a busy environment, r1's is idle (or reused by r3: either way at least one is live).
    expect(containers.size).toBeGreaterThan(0);
    expect(await runner.stopFunction(KEY)).toBe(true);
    expect(containers.size).toBe(0);
    expect(everStarted.every((container) => !container.running)).toBe(true);
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
    expect(await inFlight).toEqual({ kind: "unavailable", reason: "stopped" });
    expect(await call(runner, "r4")).toEqual({ kind: "unavailable", reason: "not_registered" });
  });

  it("does not report a stop it could not confirm, keeps the memory reserved, and the reaper frees it later", async () => {
    let failing = true;
    const { runner, containers } = setup({ failRm: () => failing });
    await runner.register(KEY, config());
    await call(runner);
    expect(await runner.stopFunction(KEY)).toBe(false);
    expect(runner.stats()).toMatchObject({ environments: 1, stopping: 1, reservedMiB: 128 });
    expect(await call(runner, "r2")).toEqual({ kind: "unavailable", reason: "not_registered" });
    failing = false;
    expect(await runner.reap()).toBe(1);
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
    expect(containers.size).toBe(0);
    expect(await runner.stopFunction(KEY)).toBe(true);
  });

  it("stopAll stops every function and refuses new work", async () => {
    const { runner, containers } = setup();
    await runner.register(KEY, config());
    await runner.register({ functionName: "b", version: "1" }, config());
    await call(runner, "r1");
    await call(runner, "r2", "1", { key: { functionName: "b", version: "1" } });
    expect(await runner.stopAll()).toBe(true);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
    expect(await call(runner, "r3")).toEqual({ kind: "unavailable", reason: "closed" });
    await expect(runner.register(KEY, config())).rejects.toThrow(RangeError);
  });

  it("a stop that races a start in flight ends the container the start made", async () => {
    const { runner, containers } = setup({ agent: silent });
    await runner.register(KEY, config());
    const starting = call(runner, "r1", "1", { timeoutMs: 5_000 });
    await wait(1);
    expect(await runner.stopFunction(KEY)).toBe(true);
    expect(await starting).toEqual({ kind: "unavailable", reason: "stopped" });
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });
});

describe("the reaper", () => {
  it("ends idle environments past the idle timeout and no sooner", async () => {
    const { runner, containers, clock, events } = setup({}, { idleTimeoutMs: 10 * 60_000 });
    await runner.register(KEY, config());
    await call(runner);
    clock.now += 9 * 60_000;
    expect(await runner.reap()).toBe(0);
    expect(containers.size).toBe(1);
    clock.now += 2 * 60_000;
    expect(await runner.reap()).toBe(1);
    expect(containers.size).toBe(0);
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
    expect(runner.metrics().total.idleReaped).toBe(1);
    expect(events.some((event) => event.event === "idle_reaped")).toBe(true);
    expect(await call(runner, "r2")).toMatchObject({ kind: "response", cold: true });
  });

  it("a forced second stop of a hung stop frees the record, the memory and the scratch folder (the parked leak)", async () => {
    let kills = 0;
    const removedScratch: string[] = [];
    const { runner, containers, clock, releaseHung } = setup({ hangKill: () => { kills += 1; return kills === 1; } }, {
      stuckStopMs: 30_000, makeScratchDir: () => Promise.resolve(), removeScratchDir: (path) => { removedScratch.push(path); return Promise.resolve(); },
    });
    await runner.register(KEY, config());
    await call(runner);
    expect(runner.stats().reservedMiB).toBe(128);
    const stopping = runner.stopFunction(KEY);
    await wait(10);
    expect(runner.stats()).toMatchObject({ stopping: 1, reservedMiB: 128 });
    // Not stuck yet: the reaper leaves the attempt alone.
    expect(await runner.reap()).toBe(0);
    expect(kills).toBe(1);
    clock.now += 31_000;
    expect(await runner.reap()).toBe(1);
    expect(kills).toBe(2);
    expect(runner.stats()).toMatchObject({ environments: 0, stopping: 0, reservedMiB: 0 });
    expect(containers.size).toBe(0);
    expect(removedScratch).toHaveLength(1);
    expect(removedScratch[0]).toMatch(/^\/run\/rovara\/scratch\/tmp\/env-\d{6}$/u);
    releaseHung();
    expect(await stopping).toBe(true);
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("retries a stop that could not be confirmed on every tick, keeping the memory reserved until it is", async () => {
    let failing = 3;
    const { runner } = setup({ failRm: () => { if (failing > 0) { failing -= 1; return true; } return false; } }, { idleTimeoutMs: 1_000 });
    const clock = { now: 0 };
    void clock;
    await runner.register(KEY, config());
    await call(runner);
    expect(await runner.stopFunction(KEY)).toBe(false);
    expect(await runner.reap()).toBe(0);
    expect(runner.stats().reservedMiB).toBe(128);
    expect(await runner.reap()).toBe(0);
    expect(runner.stats().reservedMiB).toBe(128);
    expect(await runner.reap()).toBe(1);
    expect(runner.stats()).toMatchObject({ environments: 0, reservedMiB: 0 });
  });

  it("removes an idle environment whose process died, even before the idle timeout", async () => {
    const { runner, everStarted, containers } = setup();
    await runner.register(KEY, config());
    await call(runner);
    everStarted[0]!.die(9);
    await wait(10);
    await runner.reap();
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });
});

describe("what the agent's stdout may carry (H2: a function can write frames onto it)", () => {
  const frameBytes = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
  const goesAway = async (name: string, behavior: AgentBehavior, check: (out: Awaited<ReturnType<typeof call>>) => void = (out) => expect(out).toEqual({ kind: "unavailable", reason: "protocol_error" })): Promise<void> => {
    const { runner, containers } = setup({ agent: behavior });
    await runner.register(KEY, config());
    check(await call(runner));
    await wait(5);
    expect(containers.size, name).toBe(0);
    expect(runner.stats().reservedMiB, name).toBe(0);
  };

  it("kills the sandbox on a frame of an unknown type, a hello in the middle, or a command frame", async () => {
    await goesAway("unknown type", (frame, container) => { if (frame.type === "invoke") container.emit({ type: "totally-new" } as never); });
    await goesAway("hello again", (frame, container) => { if (frame.type === "invoke") container.emit({ type: "hello", proto: "agent/1" }); });
    await goesAway("invoke from the agent", (frame, container) => { if (frame.type === "invoke") container.emit({ type: "invoke", requestId: "x", payload: "", timeoutMs: 1 } as never); });
  });

  it("kills the sandbox on anything but runtime_exit while idle, and on a first frame that is not hello", async () => {
    for (const forged of [{ type: "result", requestId: "r1", status: "ok", payload: "" }, { type: "ready" }, { type: "fatal", message: "x" }, { type: "init_error" }, { type: "hello", proto: "agent/1" }]) {
      const { runner, containers, everStarted } = setup();
      await runner.register(KEY, config());
      await call(runner, "r1");
      everStarted[0]!.emit(forged as never);
      await wait(15);
      expect(containers.size, JSON.stringify(forged)).toBe(0);
      expect(runner.stats().reservedMiB).toBe(0);
    }
    const late = setup({ startup: (container) => container.emit({ type: "ready" }) });
    await late.runner.register(KEY, config());
    expect(await call(late.runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    expect(late.containers.size).toBe(0);
  });

  it("kills the sandbox that floods its stdout while idle, before decoding it", async () => {
    const { runner, containers, everStarted } = setup();
    await runner.register(KEY, config());
    await call(runner, "r1");
    // 200 tiny but valid frames of the one type idle allows: over the idle byte cap.
    everStarted[0]!.emitRaw(Buffer.concat(Array.from({ length: 5_000 }, () => frameBytes({ type: "runtime_exit", exitCode: 1, message: "x".repeat(20) }))));
    await wait(15);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });

  it("kills the sandbox that sends more than a few extra frames in one invoke, or more bytes than one invoke may carry", async () => {
    await goesAway("many extra", (frame, container) => { if (frame.type === "invoke") for (let i = 0; i < 20; i += 1) container.emit({ type: "ready" }); });
    const { runner, containers } = setup({ agent: (frame, container) => { if (frame.type === "invoke") container.emitRaw(Buffer.concat(Array.from({ length: 40 }, () => frameBytes({ type: "result", requestId: "other", status: "ok", payload: "A".repeat(64 * 1024) })))); } }, { maxFrameBytes: 128 * 1024 });
    await runner.register(KEY, config());
    expect(await call(runner)).toEqual({ kind: "unavailable", reason: "protocol_error" });
    await wait(5);
    expect(containers.size).toBe(0);
  });

  it("a forged fatal frame does not change how a crash is classified (L6): docker's record decides", async () => {
    for (const oom of [false, true]) {
      const agent: AgentBehavior = (frame, container) => { if (frame.type === "invoke") { container.emit({ type: "fatal", message: "listen tcp: address in use" }); setTimeout(() => container.die(oom ? 137 : 2, { oom }), 3); } };
      const { runner } = setup({ agent });
      await runner.register(KEY, config());
      const out = await call(runner);
      expect(out, String(oom)).toMatchObject({ kind: "crash", oomKilled: oom, errorType: oom ? "Runtime.OutOfMemory" : "Runtime.ExitError" });
    }
  });

  it("accepts the frames a real invoke may carry: a runtime_exit and a ready around its result", async () => {
    const restart: AgentBehavior = (frame, container) => {
      if (frame.type !== "invoke") return;
      container.emit({ type: "runtime_exit", exitCode: 1, message: "died" });
      container.emit({ type: "ready", initDurationMs: 9 });
      container.emit(resultFor(frame, { initDurationMs: 9 }));
    };
    const { runner, containers } = setup({ agent: restart });
    await runner.register(KEY, config());
    expect(await call(runner)).toMatchObject({ kind: "response" });
    // The runtime restarted under it (its /tmp is half used): the sandbox is not kept.
    await wait(5);
    expect(runner.stats()).toMatchObject({ idle: 0, reservedMiB: 0 });
    expect(containers.size).toBe(0);
    expect(await call(runner, "r2")).toMatchObject({ cold: true });
  });
});

describe("the services network (M2)", () => {
  const services = (ip = "10.20.30.70") => ({ mode: "services" as const, name: "rovara-svc-0123456789ab", ip, hostsFile: "/run/rovara/e/hosts", resolvConf: "/run/rovara/e/resolv.conf" });

  it("registers and starts on an internal network, at an address in .64 to .127 of its subnet", async () => {
    const { runner, runArgs } = setup();
    await runner.register(KEY, config({ network: services() }));
    expect(await call(runner)).toMatchObject({ kind: "response" });
    expect(valuesOf(runArgs[0]!, "--network")).toEqual(["rovara-svc-0123456789ab"]);
    expect(valuesOf(runArgs[0]!, "--ip")).toEqual(["10.20.30.70"]);
  });

  it("refuses at register: a network that is not internal, unknown, outside range, or whose subnet does not hold the address", async () => {
    const { runner } = setup({ networks: { "rovara-svc-0123456789ab": { internal: true, subnet: "10.20.30.0/24" }, "rovara-svc-open": { internal: false, subnet: "10.20.31.0/24" } } });
    await expect(runner.register(KEY, config({ network: { ...services("10.20.31.70"), name: "rovara-svc-open" } }))).rejects.toThrow(RangeError);
    await expect(runner.register(KEY, config({ network: { ...services(), name: "rovara-svc-missing" } }))).rejects.toThrow(RangeError);
    for (const ip of ["10.20.30.2", "10.20.30.200", "10.20.31.70", "10.20.30.63"]) await expect(runner.register(KEY, config({ network: services(ip) })), ip).rejects.toThrow(RangeError);
    for (const name of ["host", "bridge", "none", "--privileged", "container:x"]) await expect(runner.register(KEY, config({ network: { ...services(), name } })), name).rejects.toThrow(RangeError);
  });

  it("checks again at every cold start: a network replaced since register is not used", async () => {
    const networks: Record<string, { internal: boolean; subnet: string }> = { "rovara-svc-0123456789ab": { internal: true, subnet: "10.20.30.0/24" } };
    const { runner, runArgs, containers } = setup({ networks });
    await runner.register(KEY, config({ network: services() }));
    networks["rovara-svc-0123456789ab"] = { internal: false, subnet: "10.20.30.0/24" };
    expect(await call(runner)).toMatchObject({ kind: "unavailable", reason: "start_failed" });
    expect(runArgs).toHaveLength(0);
    expect(containers.size).toBe(0);
    expect(runner.stats().reservedMiB).toBe(0);
  });
});

describe("the sandbox's /tmp and scratch folders (L3, L4)", () => {
  it("defaults to a disk-backed folder per sandbox, not a tmpfs that counts as memory", async () => {
    const { runner, runArgs, fs } = setup();
    await runner.register(KEY, config());
    await call(runner);
    const args = runArgs[0]!;
    expect(args).not.toContain("--tmpfs");
    const id = args.find((arg) => arg.startsWith("rovara.function="))!.split("=")[1]!;
    expect(valuesOf(args, "--volume")).toContain(`/run/rovara/scratch/tmp/${id}:/tmp:rw`);
    expect(fs.dirs.has(`/run/rovara/scratch/tmp/${id}`)).toBe(true);
    await runner.stopAll();
    expect(fs.dirs.size).toBe(0);
  });

  it("can still be told to use a size-capped tmpfs", async () => {
    const { runner, runArgs, fs } = setup({}, { scratchKind: "tmpfs" });
    await runner.register(KEY, config({ ephemeralMb: 300 }));
    await call(runner);
    expect(valuesOf(runArgs[0]!, "--tmpfs")).toEqual(["/tmp:rw,exec,nosuid,nodev,mode=1777,size=300m,uid=993,gid=993"]);
    expect(fs.dirs.size).toBe(0);
  });

  it("makes parents 0700 and the leaf 0700 owned by the sandbox's uid, or 0777 inside the 0700 parents when it may not chown (real folders)", async () => {
    const base = await mkdtemp(join(tmpdir(), "w1-scratch-"));
    try {
      const fake = fakeSandboxHost();
      const events: SandboxLogEvent[] = [];
      const runner = createSandboxController({ docker: fake.docker, launcher: fake.launcher, memoryBudgetMiB: 512, labels: [], autoReap: false, scratchBaseDir: `${base}/run`, log: (event) => events.push(event), newEnvironmentId: () => "env-real01" });
      await runner.register(KEY, config());
      expect((await call(runner)).kind).toBe("response");
      const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777;
      expect(await mode(`${base}/run`)).toBe(0o700);
      expect(await mode(`${base}/run/tmp`)).toBe(0o700);
      expect(await mode(`${base}/run/env`)).toBe(0o700);
      const leaf = await stat(`${base}/run/tmp/env-real01`);
      expect([0o700, 0o777]).toContain(leaf.mode & 0o7777);
      if ((leaf.mode & 0o7777) === 0o700) expect(leaf.uid).toBe(993);
      // The environment file was written 0600 and is gone now.
      await expect(stat(`${base}/run/env/env-real01.env`)).rejects.toThrow();
      await runner.stopAll();
      await expect(stat(`${base}/run/tmp/env-real01`)).rejects.toThrow();
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
