// Slice 4, lane W3: the runner/2 client against a fake front (tests/support/fake-runner-front.ts), the real code store, and a scripted sandbox controller. Every message, the mapping of every invoke outcome, the stop barrier,
// and hostile frames: a front that lies about sizes, ids, order and shapes must end the connection, never reach the disk, the controller or a command.
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FunctionCodeStore, type RunCode } from "../../../packages/worker/src/function-runner/code-store.js";
import { createRunnerClient, type RegistrationInfo, type RunnerClient, type RunnerLogEvent } from "../../../packages/worker/src/function-runner/runner-client.js";
import { encodeRunnerFrame } from "../../../packages/worker/src/function-runner/runner-frames.js";
import { FakeWheelIndex } from "../../../packages/worker/src/function-runner/wheel-index.js";
import { ARM, X86, wheel, zip } from "../../support/x86-package-fixtures.js";
import { FakePipe, b64, fakeController, nextId, okOutcome, packageFrames, registerFrame, sha256, type FakeController, type FakeControllerOptions, type FnOptions } from "../../support/fake-runner-front.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Ctx { pipe: FakePipe; controller: FakeController; client: RunnerClient; run: RunCode; events: RunnerLogEvent[]; infos: RegistrationInfo[]; root: string }

async function setup(options: { controller?: FakeControllerOptions; index?: FakeWheelIndex; limits?: Record<string, number>; hello?: boolean } = {}): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), "runner-client-"));
  const store = new FunctionCodeStore({ root });
  const run = await store.openRun("run-1");
  const pipe = new FakePipe();
  const controller = fakeController(options.controller);
  const events: RunnerLogEvent[] = [];
  const infos: RegistrationInfo[] = [];
  const client = createRunnerClient({
    pipe, controller, code: run, ...(options.index === undefined ? {} : { wheelIndex: options.index }), runtimes: ["python3.12", "nodejs22.x"], workerVersion: "t1",
    settings: { imageForRuntime: (runtime) => (/^(?:python|nodejs)/u.test(runtime) ? `img-${runtime}` : undefined), agentHostPath: "/opt/rovara/agent", network: { mode: "none" }, maxConcurrency: 4 },
    limits: { handshakeMs: 400, registerIdleMs: 600, stopRetryMs: 5, shutdownTries: 3, retireGraceMs: 10, ...options.limits },
    log: (event) => events.push(event), onRegistered: (info) => infos.push(info),
  });
  cleanups.push(async () => { await client.close(); await run.close(); await rm(root, { recursive: true, force: true }); });
  if (options.hello !== false) {
    pipe.send({ type: "hello", proto: "runner/2", front: "rovara-aws-front", version: "t" });
    await pipe.next("hello");
  }
  return { pipe, controller, client, run, events, infos, root };
}

const handlerZip = (extra: Array<{ name: string; data: Uint8Array | string }> = []): Uint8Array => zip([{ name: "app.py", data: "def handler(e, c):\n    return e\n" }, ...extra]);
const layerZip = (tag = "a"): Uint8Array => zip([{ name: `python/lib/${tag}.py`, data: `x = "${tag}"\n` }]);

/** Registers a function through the whole need / package / registered exchange. */
async function register(ctx: Ctx, options: FnOptions = {}, answer = true): Promise<{ id: string; need: string[]; registered: Record<string, unknown> }> {
  const pkg = options.pkg ?? handlerZip();
  const made = registerFrame({ ...options, pkg });
  const before = ctx.pipe.ofType("need").length;
  ctx.pipe.send(made.frame);
  const need = (await ctx.pipe.next("need", before + 1))["packages"] as string[];
  if (answer) {
    const all = [{ bytes: pkg, kind: "function" as const }, ...made.layers.map((bytes) => ({ bytes, kind: "layer" as const }))];
    for (const item of all) if (need.includes(sha256(item.bytes))) for (const frame of packageFrames(made.id, item.bytes, item.kind, 9)) ctx.pipe.send(frame);
  }
  await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "registered" && frame.body["id"] === made.id));
  const registered = ctx.pipe.ofType("registered").find((frame) => frame["id"] === made.id)!;
  return { id: made.id, need, registered };
}

const invokeFrame = (name: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "invoke", id: nextId(), name, version: "$LATEST", requestId: "req-1", payload: b64("{\"n\":1}"), timeoutMs: 5_000, source: "direct", ...change,
});
async function call(ctx: Ctx, name: string, change: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const frame = invokeFrame(name, change);
  ctx.pipe.send(frame);
  await ctx.pipe.waitFor((frames) => frames.some((item) => item.type === "result" && item.body["id"] === frame["id"]));
  return ctx.pipe.ofType("result").find((item) => item["id"] === frame["id"])!;
}

async function violates(ctx: Ctx, action: () => void, reason?: string): Promise<void> {
  action();
  const end = await ctx.client.ended;
  expect(end.reason).toBe("protocol_error");
  expect(ctx.pipe.ofType("error")).toHaveLength(1);
  // The message is fixed text: it never echoes the frame.
  expect(JSON.stringify(ctx.pipe.ofType("error")[0])).not.toMatch(/evil|\.\.\//u);
  expect(ctx.pipe.ended).toBe(true);
  expect(ctx.controller.stopAllCalls).toBeGreaterThanOrEqual(1);
  if (reason !== undefined) expect(ctx.events.find((event) => event.event === "protocol_error")?.reason).toBe(reason);
}

describe("the handshake", () => {
  it("answers the front's hello with its own and is ready", async () => {
    const ctx = await setup();
    expect(ctx.pipe.ofType("hello")[0]).toMatchObject({ proto: "runner/2", worker: "rovara-worker", version: "t1", runtimes: ["python3.12", "nodejs22.x"] });
    expect(ctx.client.handshaken).toBe(true);
    expect(ctx.events[0]).toEqual({ event: "connected" });
    ctx.pipe.send({ type: "hello", proto: "runner/2" });
    ctx.pipe.send({ type: "something-new", id: "x" });
    expect((await register(ctx)).registered["ok"]).toBe(true);
    expect(ctx.pipe.ofType("hello")).toHaveLength(1);
  });

  it("refuses a front that speaks another protocol", async () => {
    const ctx = await setup({ hello: false });
    ctx.pipe.send({ type: "hello", proto: "runner/1" });
    expect((await ctx.client.ended).reason).toBe("protocol_error");
    expect(ctx.pipe.ofType("error")[0]).toMatchObject({ message: "this worker speaks runner/2" });
  });

  it("refuses any frame before the hello", async () => {
    const ctx = await setup({ hello: false });
    await violates(ctx, () => { ctx.pipe.send(invokeFrame("resize")); }, "a frame before the hello");
  });

  it("gives up when no hello arrives", async () => {
    const ctx = await setup({ hello: false, limits: { handshakeMs: 50 } });
    expect(await ctx.client.ended).toMatchObject({ reason: "handshake_timeout", handshaken: false });
  });

  it("reads frames that arrive a byte at a time", async () => {
    const ctx = await setup();
    const bytes = encodeRunnerFrame(invokeFrame("none", { id: "slow-1" }));
    for (const byte of bytes) ctx.pipe.raw(Buffer.from([byte]));
    await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "result" && frame.body["id"] === "slow-1"));
  });
});

describe("register", () => {
  it("asks for the missing digests, takes the stream, unpacks it and registers the function with the controller", async () => {
    const layer = layerZip("a");
    const pkg = handlerZip();
    const ctx = await setup();
    const { need, registered } = await register(ctx, { pkg, layers: [layer], env: { STAGE: "test" }, memoryMb: 512, timeoutSeconds: 7 });
    expect(need.sort()).toEqual([sha256(pkg), sha256(layer)].sort());
    expect(registered).toMatchObject({ ok: true });
    expect(registered["error"]).toBeUndefined();
    const { key, config } = ctx.controller.registerCalls[0]!;
    expect(key).toEqual({ functionName: "resize", version: "$LATEST" });
    expect(config).toMatchObject({
      runtime: "python3.12", handler: "app.handler", environment: { STAGE: "test" }, region: "us-east-1", memoryMb: 512, timeoutSeconds: 7, ephemeralMb: 512, image: "img-python3.12", agentHostPath: "/opt/rovara/agent",
      functionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize", network: { mode: "none" }, maxConcurrency: 4,
    });
    expect(readdirSync(config.codeHostPath)).toEqual(["app.py"]);
    expect(readdirSync(`${config.layersHostPath!}/python/lib`)).toEqual(["a.py"]);
    expect(ctx.infos).toEqual([expect.objectContaining({ name: "resize", ok: true, swapped: false })]);
  });

  it("asks only for digests the store does not hold, and sends an empty need when it holds them all", async () => {
    const layer = layerZip("a");
    const ctx = await setup();
    await register(ctx, { name: "one", pkg: handlerZip(), layers: [layer] });
    const second = await register(ctx, { name: "two", pkg: handlerZip([{ name: "other.py", data: "y = 1\n" }]), layers: [layer] });
    expect(second.need).toEqual([sha256(handlerZip([{ name: "other.py", data: "y = 1\n" }]))]);
    const same = await register(ctx, { name: "three", pkg: handlerZip(), layers: [layer] }, false);
    expect(same.need).toEqual([]);
    expect(same.registered["ok"]).toBe(true);
    expect(ctx.pipe.ofType("package")).toHaveLength(0);
    expect(ctx.controller.registerCalls).toHaveLength(3);
  });

  it("answers a repeat of the same registration without touching anything", async () => {
    const ctx = await setup();
    const pkg = handlerZip();
    await register(ctx, { pkg, configHash: "h1" });
    const again = registerFrame({ pkg, configHash: "h1" });
    ctx.pipe.send(again.frame);
    await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "registered" && frame.body["id"] === again.id));
    expect(ctx.pipe.ofType("need")).toHaveLength(1);
    expect(ctx.controller.registerCalls).toHaveLength(1);
  });

  it("registers a new configuration of the same function and keeps the old code for calls still running", async () => {
    const ctx = await setup();
    await register(ctx, { pkg: handlerZip(), configHash: "h1", timeoutSeconds: 1 });
    const first = ctx.controller.registerCalls[0]!.config.codeHostPath;
    await register(ctx, { pkg: handlerZip([{ name: "v2.py", data: "z = 2\n" }]), configHash: "h2", timeoutSeconds: 1 });
    const second = ctx.controller.registerCalls[1]!.config.codeHostPath;
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    ctx.pipe.send({ type: "stop_all", id: "s1" });
    await ctx.pipe.next("stopped");
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("refuses with the type and a fixed sentence: a package that is not the digest, not a zip, or unsafe", async () => {
    const ctx = await setup();
    const good = handlerZip();
    // A package whose bytes are not the digest the register named.
    const liar = registerFrame({ pkg: good, name: "liar" });
    ctx.pipe.send(liar.frame);
    await ctx.pipe.next("need", 1);
    const wrong = Buffer.from(good);
    wrong[wrong.length - 30] = (wrong[wrong.length - 30]! ^ 0xff) & 0xff;
    for (const frame of packageFrames(liar.id, wrong, "function")) ctx.pipe.send({ ...frame, sha256: sha256(good) });
    await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "registered" && frame.body["id"] === liar.id));
    expect(ctx.pipe.ofType("registered")[0]).toMatchObject({ ok: false, error: { type: "InvalidParameterValueException", message: "The function's code is not the package that was announced" } });
    const garbage = Buffer.from("this is not a zip at all, not even close, but it is long enough");
    const notZip = await register(ctx, { name: "garbage", pkg: garbage });
    expect(notZip.registered).toMatchObject({ ok: false, error: { type: "InvalidParameterValueException" } });
    const slip = await register(ctx, { name: "slip", pkg: zip([{ name: "../evil.py", data: "x" }]) });
    expect(slip.registered).toMatchObject({ ok: false, error: { type: "InvalidParameterValueException", message: expect.not.stringContaining("evil") as unknown } });
    expect(ctx.controller.registerCalls).toHaveLength(0);
    expect(ctx.client.handshaken).toBe(true);
    expect((await ctx.client.close()).reason).toBe("closed");
  });

  it("keeps draining the front's stream after a refusal and answers once the whole stream is in", async () => {
    const ctx = await setup();
    const garbage = Buffer.from("x".repeat(100));
    const made = registerFrame({ pkg: garbage, layers: [layerZip("q")] });
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("need");
    for (const frame of packageFrames(made.id, garbage, "function", 30)) ctx.pipe.send(frame);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(ctx.pipe.ofType("registered")).toHaveLength(0);
    for (const frame of packageFrames(made.id, made.layers[0]!, "layer", 30)) ctx.pipe.send(frame);
    await ctx.pipe.next("registered");
    expect(ctx.pipe.ofType("registered")[0]).toMatchObject({ ok: false });
    // A late frame of the finished registration is dropped, not a violation.
    ctx.pipe.send({ type: "chunk", id: made.id, sha256: sha256(garbage), seq: 9, data: "", last: true });
    expect((await register(ctx, { name: "after" })).registered["ok"]).toBe(true);
  });

  it("refuses what the runner cannot run before asking for any code", async () => {
    const ctx = await setup();
    for (const options of [{ packageType: "Image" as const, pkg: undefined }, { runtime: "java21" }, { pkg: undefined }]) {
      const made = registerFrame(options);
      ctx.pipe.send(made.frame);
      await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "registered" && frame.body["id"] === made.id));
    }
    expect(ctx.pipe.ofType("need")).toHaveLength(0);
    expect(ctx.pipe.ofType("registered").map((frame) => (frame["error"] as { type: string }).type)).toEqual(["Rovara.Unsupported", "Rovara.Unsupported", "InvalidParameterValueException"]);
  });

  it("maps the controller's refusals to InvalidParameterValueException and discards the tree", async () => {
    const ctx = await setup({ controller: { registerError: new RangeError("not a valid function configuration: environment entry") } });
    const result = await register(ctx, { env: { PATH: "/x" } });
    expect(result.registered).toMatchObject({ ok: false, error: { type: "InvalidParameterValueException", message: "not a valid function configuration: environment entry" } });
    expect(readdirSync(join(ctx.root, "runs", "run-1", "trees"))).toEqual([]);
  });

  it("fails a registration the front stops feeding", async () => {
    const ctx = await setup({ limits: { registerIdleMs: 60 } });
    const made = registerFrame({ pkg: handlerZip() });
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("registered");
    expect(ctx.pipe.ofType("registered")[0]).toMatchObject({ ok: false, error: { type: "Rovara.RunnerError" } });
  });

  it("pauses the pipe while a package arrives faster than the disk takes it, and resumes", async () => {
    const ctx = await setup({ limits: { highWaterBytes: 2_048 } });
    const big = zip([{ name: "blob.bin", data: Buffer.alloc(60_000, 7), store: true }, { name: "app.py", data: "x" }]);
    const made = registerFrame({ pkg: big });
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("need");
    ctx.pipe.raw(Buffer.concat(packageFrames(made.id, big, "function", 4_096).map((frame) => encodeRunnerFrame(frame))));
    await ctx.pipe.next("registered");
    expect(ctx.pipe.ofType("registered")[0]).toMatchObject({ ok: true });
    expect(ctx.pipe.paused).toBeGreaterThan(0);
    expect(ctx.pipe.resumed).toBeGreaterThan(0);
  });
});

describe("native code", () => {
  const X86_TAGS = "Tag: cp312-cp312-manylinux_2_17_x86_64\n";
  const dist = (so: Uint8Array): Array<{ name: string; data: Uint8Array | string }> => [
    { name: "numpy/__init__.py", data: "x86 build" }, { name: "numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so", data: so },
    { name: "numpy-2.5.4.dist-info/METADATA", data: "Metadata-Version: 2.1\nName: numpy\nVersion: 2.5.4\n" },
    { name: "numpy-2.5.4.dist-info/WHEEL", data: `Wheel-Version: 1.0\nRoot-Is-Purelib: false\n${X86_TAGS}` },
    { name: "numpy-2.5.4.dist-info/RECORD", data: "numpy/__init__.py,sha256=x,9\nnumpy/_core/_mul.cpython-312-x86_64-linux-gnu.so,sha256=x,64\nnumpy-2.5.4.dist-info/METADATA,,\nnumpy-2.5.4.dist-info/WHEEL,,\nnumpy-2.5.4.dist-info/RECORD,,\n" },
  ];
  const ARM_FILE = "numpy-2.5.4-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl";
  const armWheel = (): Uint8Array => wheel({ name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_27_aarch64"], files: { "numpy/__init__.py": "arm build", "numpy/_core/_mul.cpython-312-aarch64-linux-gnu.so": ARM() } });

  it("swaps an x86_64 Python package for the aarch64 wheels, on disk, and registers it", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", ARM_FILE, armWheel());
    const ctx = await setup({ index });
    const result = await register(ctx, { pkg: handlerZip(dist(X86())), architectures: ["x86_64"] });
    expect(result.registered).toMatchObject({ ok: true });
    const task = ctx.controller.registerCalls[0]!.config.codeHostPath;
    expect(existsSync(`${task}/numpy/_core/_mul.cpython-312-aarch64-linux-gnu.so`)).toBe(true);
    expect(existsSync(`${task}/numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so`)).toBe(false);
    expect(index.downloads).toEqual([ARM_FILE]);
    expect(ctx.infos[0]).toMatchObject({ ok: true, swapped: true, native: { arch: "arm64" } });
  });

  it("answers Rovara.Unsupported for x86_64 code when there is no wheel index, no wheel, or it is not Python", async () => {
    const noIndex = await setup();
    expect((await register(noIndex, { pkg: handlerZip(dist(X86())) })).registered).toMatchObject({ ok: false, error: { type: "Rovara.Unsupported", message: "native code built for x86_64; local runs are arm64" } });
    expect(noIndex.controller.registerCalls).toHaveLength(0);
    expect(readdirSync(join(noIndex.root, "runs", "run-1", "trees"))).toEqual([]);
    const empty = await setup({ index: new FakeWheelIndex() });
    const refused = await register(empty, { pkg: handlerZip(dist(X86())) });
    expect(refused.registered).toMatchObject({ ok: false, error: { type: "Rovara.Unsupported", message: expect.stringContaining("numpy 2.5.4: no-arm64-wheel") as unknown } });
    const node = await setup({ index: new FakeWheelIndex() });
    const addon = zip([{ name: "index.js", data: "x" }, { name: "build/Release/a.node", data: X86() }]);
    expect((await register(node, { runtime: "nodejs22.x", pkg: addon })).registered).toMatchObject({ ok: false, error: { type: "Rovara.Unsupported" } });
  });

  it("runs arm64 native code as it is, and notes a declared x86_64 function with no native code", async () => {
    const ctx = await setup();
    const arm = zip([{ name: "app.py", data: "x" }, { name: "lib/native.so", data: ARM() }]);
    expect((await register(ctx, { pkg: arm })).registered).toMatchObject({ ok: true });
    expect(ctx.infos[0]).toMatchObject({ ok: true, swapped: false, native: { arch: "arm64" } });
    expect((await register(ctx, { name: "plain", pkg: handlerZip(), architectures: ["x86_64"] })).registered).toMatchObject({ ok: true });
    expect(ctx.infos[1]).toMatchObject({ declaredX86RunsOnArm64: true });
  });
});

describe("invoke", () => {
  it("passes the call to the controller and maps every outcome to a result", async () => {
    const detail = { environmentId: "e", cold: true, wallMs: 40, memoryMb: 128, memoryClamped: true, logTail: "LOG\n", logsTruncated: true, initLogTail: "INIT\n", coldStartMs: 25, report: { durationMs: 7, billedDurationMs: 8, initDurationMs: 22 }, maxMemoryUsedBytes: 12_345 };
    const script: Record<string, () => ReturnType<NonNullable<FakeControllerOptions["outcome"]>>> = {
      ok: () => ({ kind: "response", payload: Buffer.from("{\"a\":1}"), ...detail }),
      fn: () => ({ kind: "error", errorType: "ValueError", errorMessage: "boom", payload: Buffer.from("{\"errorType\":\"ValueError\"}"), ...detail }),
      init: () => ({ kind: "init_error", errorType: "Runtime.ImportModuleError", errorMessage: "no module", payload: Buffer.from("{}"), ...detail }),
      slow: () => ({ kind: "timeout", errorType: "Sandbox.Timedout", errorMessage: "Task timed out after 3.00 seconds", ...detail }),
      dead: () => ({ kind: "crash", exitCode: 137, signal: null, oomKilled: true, errorType: "Runtime.OutOfMemory", errorMessage: "oom", ...detail }),
      bad: () => ({ kind: "rejected", errorType: "Runtime.InvalidRequest", errorMessage: "no", ...detail }),
      busy: () => ({ kind: "throttled", reason: "memory" }),
      down: () => ({ kind: "unavailable", reason: "start_failed", detail: "docker said no" }),
    };
    const ctx = await setup({ controller: { outcome: (request) => script[request.requestId.split("-")[0]!]!() } });
    await register(ctx);
    const results: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(script)) results[name] = await call(ctx, "resize", { requestId: `${name}-1` });
    expect(results["ok"]).toMatchObject({ status: "ok", payload: b64("{\"a\":1}"), logTail: "INIT\nLOG\n", logTruncated: true, durationMs: 7, billedDurationMs: 8, initDurationMs: 22, maxMemoryUsed: 12_345, cold: true, memoryClamped: true });
    expect(results["fn"]).toMatchObject({ status: "function_error", errorType: "ValueError", errorMessage: "boom", payload: b64("{\"errorType\":\"ValueError\"}") });
    expect(results["init"]).toMatchObject({ status: "init_error", errorType: "Runtime.ImportModuleError" });
    expect(results["slow"]).toMatchObject({ status: "timeout", errorType: "Sandbox.Timedout" });
    expect(results["dead"]).toMatchObject({ status: "crash", errorType: "Runtime.OutOfMemory" });
    expect(results["bad"]).toMatchObject({ status: "rejected", errorType: "Runtime.InvalidRequest" });
    expect(results["busy"]).toMatchObject({ status: "throttled", reason: "memory" });
    expect(results["down"]).toMatchObject({ status: "unavailable", reason: "start_failed", detail: "docker said no" });
    expect(Object.values(results).map((result) => result["type"])).toEqual(Array(8).fill("result"));
  });

  it("hands the controller the deadline, ARN, request id, trace id, client context and identity", async () => {
    const ctx = await setup();
    await register(ctx);
    const result = await call(ctx, "resize", { requestId: "r-7", timeoutMs: 1_500, functionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize:3", traceId: "Root=1-a", clientContext: "e30=", cognitoIdentity: "{}", source: "stub" });
    expect(result).toMatchObject({ status: "ok", payload: b64("{\"n\":1}") });
    expect(ctx.controller.invokes[0]).toMatchObject({ key: { functionName: "resize", version: "$LATEST" }, requestId: "r-7", timeoutMs: 1_500, invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:resize:3", traceId: "Root=1-a", clientContext: "e30=", cognitoIdentity: "{}" });
    expect(ctx.controller.invokes[0]!.payload.toString()).toBe("{\"n\":1}");
  });

  it("answers unavailable not_registered for a function it was not told about, without asking the controller", async () => {
    const ctx = await setup();
    expect(await call(ctx, "ghost")).toMatchObject({ status: "unavailable", reason: "not_registered" });
    await register(ctx);
    expect(await call(ctx, "resize", { version: "7" })).toMatchObject({ status: "unavailable", reason: "not_registered" });
    expect(ctx.controller.invokes).toHaveLength(0);
  });

  it("answers invalid_request for a payload that is not base64, over 6 MiB, a bad request id or a bad deadline", async () => {
    const ctx = await setup();
    await register(ctx);
    for (const change of [{ payload: "not base64!" }, { payload: Buffer.alloc(6_291_557).toString("base64") }, { requestId: "bad id with spaces" }, { timeoutMs: 0 }, { timeoutMs: 901_000 }]) {
      expect(await call(ctx, "resize", change)).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    }
    expect(ctx.controller.invokes).toHaveLength(0);
    // The largest payload goes through, and its echo comes back in one frame.
    const edge = Buffer.alloc(6_291_556, 65);
    const result = await call(ctx, "resize", { payload: edge.toString("base64") });
    expect(result).toMatchObject({ status: "ok" });
    expect(Buffer.from(result["payload"] as string, "base64").length).toBe(6_291_556);
  });

  it("answers invokes in whatever order they finish, exactly one result each", async () => {
    const ctx = await setup({ controller: { outcome: async (request) => { await new Promise((resolve) => { setTimeout(resolve, request.requestId === "slow" ? 60 : 5); }); return okOutcome(request.requestId); } } });
    await register(ctx);
    const slow = invokeFrame("resize", { requestId: "slow" });
    const fast = invokeFrame("resize", { requestId: "fast" });
    ctx.pipe.send(slow);
    ctx.pipe.send(fast);
    await ctx.pipe.next("result", 2);
    expect(ctx.pipe.ofType("result").map((result) => result["id"])).toEqual([fast["id"], slow["id"]]);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(ctx.pipe.ofType("result")).toHaveLength(2);
  });

  it("answers a call the controller breaks on with a protocol_error result, not silence", async () => {
    const ctx = await setup({ controller: { outcome: () => { throw new Error("kaboom with /secret/path"); } } });
    await register(ctx);
    const result = await call(ctx, "resize");
    expect(result).toMatchObject({ status: "unavailable", reason: "protocol_error" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("unregister and stop_all", () => {
  it("unregister stops one version, or every version, and frees the code", async () => {
    const ctx = await setup();
    await register(ctx, { name: "a", version: "1" });
    await register(ctx, { name: "a", version: "2", pkg: handlerZip([{ name: "b.py", data: "1" }]) });
    await register(ctx, { name: "b", version: "1" });
    const dirs = ctx.controller.registerCalls.map((call) => call.config.codeHostPath);
    ctx.pipe.send({ type: "unregister", id: "u1", name: "a", version: "1" });
    await ctx.pipe.next("unregistered", 1);
    expect(ctx.controller.stopped).toEqual([{ functionName: "a", version: "1" }]);
    expect(existsSync(dirs[0]!)).toBe(false);
    expect(await call(ctx, "a", { version: "1" })).toMatchObject({ reason: "not_registered" });
    expect(await call(ctx, "a", { version: "2" })).toMatchObject({ status: "ok" });
    ctx.pipe.send({ type: "unregister", id: "u2", name: "a" });
    await ctx.pipe.next("unregistered", 2);
    expect(ctx.controller.stopped).toHaveLength(2);
    expect(await call(ctx, "a", { version: "2" })).toMatchObject({ reason: "not_registered" });
    expect(await call(ctx, "b", { version: "1" })).toMatchObject({ status: "ok" });
    ctx.pipe.send({ type: "unregister", id: "u3", name: "nobody" });
    await ctx.pipe.next("unregistered", 3);
  });

  it("stop_all is answered only after every sandbox is gone, and frames that arrive meanwhile wait for it", async () => {
    const ctx = await setup();
    await register(ctx, { name: "a" });
    let open!: () => void;
    ctx.controller.stopGate = new Promise<void>((resolve) => { open = resolve; });
    ctx.pipe.send({ type: "stop_all", id: "s1" });
    const inv = invokeFrame("a");
    ctx.pipe.send(inv);
    const again = registerFrame({ name: "a", pkg: handlerZip(), configHash: "after-reset" });
    ctx.pipe.send(again.frame);
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(ctx.pipe.ofType("stopped")).toHaveLength(0);
    expect(ctx.pipe.ofType("result")).toHaveLength(0);
    expect(ctx.pipe.ofType("need")).toHaveLength(1);
    ctx.controller.stopGate = undefined;
    open();
    await ctx.pipe.next("stopped");
    // Order: the barrier answer first, then the waiting register, then the invoke that arrived before it.
    await ctx.pipe.next("result");
    expect(ctx.pipe.ofType("result")[0]).toMatchObject({ id: inv["id"], reason: "not_registered" });
    expect(ctx.pipe.ofType("need")[1]).toMatchObject({ id: again.id });
    expect(ctx.controller.stopAllCalls).toBe(0);
  });

  it("does not answer stop_all while a sandbox is unconfirmed, and answers once it is", async () => {
    const ctx = await setup();
    await register(ctx);
    ctx.controller.stopResult = false;
    ctx.pipe.send({ type: "stop_all", id: "s1" });
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    expect(ctx.pipe.ofType("stopped")).toHaveLength(0);
    ctx.controller.stopResult = true;
    await ctx.pipe.next("stopped");
    expect(ctx.controller.registered.size).toBe(0);
  });

  it("ends a registration in flight when stop_all arrives, and a stop_all clears the held packages", async () => {
    const ctx = await setup();
    const pkg = handlerZip();
    const made = registerFrame({ pkg });
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("need");
    ctx.pipe.send({ type: "stop_all", id: "s1" });
    await ctx.pipe.next("stopped");
    expect(ctx.pipe.ofType("registered")[0]).toMatchObject({ id: made.id, ok: false, error: { type: "Rovara.RunnerError" } });
    // The packages of the run are dropped too: the next registration asks for the digest again.
    await register(ctx, { pkg });
    ctx.pipe.send({ type: "stop_all", id: "s2" });
    await ctx.pipe.next("stopped", 2);
    const again = await register(ctx, { pkg, configHash: "fresh" });
    expect(again.need).toEqual([sha256(pkg)]);
  });

  it("treats a closed pipe as stop everything", async () => {
    const ctx = await setup();
    await register(ctx);
    ctx.pipe.die();
    expect(await ctx.client.ended).toEqual({ reason: "pipe_closed", handshaken: true, stopped: true });
    expect(ctx.controller.stopAllCalls).toBe(1);
    expect(ctx.pipe.killed).toBe(true);
  });

  it("closes from our side the same way", async () => {
    const ctx = await setup();
    await register(ctx);
    expect(await ctx.client.close()).toMatchObject({ reason: "closed", stopped: true });
    expect(ctx.pipe.ended).toBe(true);
    expect(ctx.controller.stopAllCalls).toBe(1);
  });
});

describe("hostile frames", () => {
  const header = (length: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(length, 0); return b; };
  const json = (text: string): Buffer => { const body = Buffer.from(text); return Buffer.concat([header(body.length), body]); };

  it("refuses a length over 16 MiB on the header alone, and lengths of 0 and 1", async () => {
    for (const bad of [0xffffffff, 16 * 1024 * 1024 + 1, 1, 0]) {
      const ctx = await setup();
      await violates(ctx, () => { ctx.pipe.raw(header(bad)); });
      expect(ctx.client.handshaken).toBe(true);
    }
  });

  it("refuses bytes that are not a JSON object with a type", async () => {
    for (const body of ["not json at all", "[1,2]", "{\"nothing\":1}", "{\"type\":5}", "{\"type\":\"\"}", "null", "\"x\""]) {
      const ctx = await setup();
      await violates(ctx, () => { ctx.pipe.raw(json(body)); });
    }
  });

  it("ends when the stream stops inside a frame", async () => {
    const ctx = await setup();
    ctx.pipe.raw(Buffer.concat([header(500), Buffer.from("{\"type\":\"inv")]));
    ctx.pipe.die();
    expect((await ctx.client.ended).reason).toBe("pipe_closed");
  });

  it("refuses a register or invoke whose fields are not what the spec says", async () => {
    const bad: Array<Record<string, unknown>> = [
      { type: "register", id: "r1" }, { type: "register", id: "r2", fn: "nope" }, { type: "register", id: "bad id!", fn: {} },
      { ...registerFrame({ pkg: handlerZip() }).frame, id: "r4", fn: { ...(registerFrame({ pkg: handlerZip() }).frame["fn"] as object), env: { A: 1 } } },
      { ...registerFrame({ pkg: handlerZip() }).frame, id: "r5", fn: { ...(registerFrame({ pkg: handlerZip() }).frame["fn"] as object), name: "../x" } },
      { ...registerFrame({ pkg: handlerZip() }).frame, id: "r6", fn: { ...(registerFrame({ pkg: handlerZip() }).frame["fn"] as object), version: "latest" } },
      { ...registerFrame({ pkg: handlerZip() }).frame, id: "r7", fn: { ...(registerFrame({ pkg: handlerZip() }).frame["fn"] as object), layers: Array(7).fill({ sha256: "a".repeat(64), sizeBytes: 1 }) } },
      { type: "invoke", id: "i1", name: "x", version: "$LATEST", requestId: "r", payload: 5, timeoutMs: 1, source: "direct" },
      { type: "invoke", id: "i2", name: "x", version: "$LATEST", requestId: "r", payload: "", timeoutMs: "1", source: "direct" },
      { type: "invoke", name: "x", version: "$LATEST", requestId: "r", payload: "", timeoutMs: 1, source: "direct" },
      { type: "unregister", id: "u1", name: "a/b" }, { type: "stop_all" },
    ];
    for (const frame of bad) {
      const ctx = await setup();
      await violates(ctx, () => { ctx.pipe.send(frame); });
    }
  });

  it("refuses an id that is already in flight or already used by a register", async () => {
    const ctx = await setup();
    const made = registerFrame({ pkg: handlerZip() });
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("need");
    await violates(ctx, () => { ctx.pipe.send({ ...made.frame }); }, "duplicate id");
    const finished = await setup();
    const done = await register(finished);
    await violates(finished, () => { finished.pipe.send({ ...registerFrame({ pkg: handlerZip() }, done.id).frame }); }, "duplicate id");
    const slow = await setup({ controller: { outcome: () => new Promise(() => undefined) } });
    await register(slow);
    const frame = invokeFrame("resize");
    slow.pipe.send(frame);
    await violates(slow, () => { slow.pipe.send({ ...frame, requestId: "other" }); }, "duplicate id");
  });

  it("refuses package and chunk frames the register did not ask for", async () => {
    const pkg = handlerZip();
    const start = async (): Promise<{ ctx: Ctx; made: ReturnType<typeof registerFrame> }> => {
      const ctx = await setup();
      const made = registerFrame({ pkg, layers: [layerZip("z")] });
      ctx.pipe.send(made.frame);
      await ctx.pipe.next("need");
      return { ctx, made };
    };
    const digest = sha256(pkg);
    const attacks: Array<[string, (id: string) => object[]]> = [
      ["unknown id", () => [{ type: "package", id: "ghost", sha256: digest, kind: "function", sizeBytes: pkg.length }]],
      ["a digest never asked for", (id) => [{ type: "package", id, sha256: "e".repeat(64), kind: "function", sizeBytes: 5 }]],
      ["a wrong kind", (id) => [{ type: "package", id, sha256: digest, kind: "layer", sizeBytes: pkg.length }]],
      ["a wrong size", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length + 1 }]],
      ["a chunk with no package", (id) => [{ type: "chunk", id, sha256: digest, seq: 0, data: "AAAA", last: false }]],
      ["a second package while one is open", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }, { type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }]],
      ["a chunk out of order", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }, { type: "chunk", id, sha256: digest, seq: 1, data: "AAAA", last: false }]],
      ["a chunk past the announced size", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 2 }, { type: "chunk", id, sha256: digest, seq: 0, data: "AAAA", last: false }]],
      ["a last chunk short of the size", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 100 }, { type: "chunk", id, sha256: digest, seq: 0, data: "AAAA", last: true }]],
      ["a chunk that fills the size but is not last", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 3 }, { type: "chunk", id, sha256: digest, seq: 0, data: "AAAA", last: false }]],
      ["a chunk of another digest", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }, { type: "chunk", id, sha256: "d".repeat(64), seq: 0, data: "AAAA", last: false }]],
      ["base64 that is not base64", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }, { type: "chunk", id, sha256: digest, seq: 0, data: "!!!!", last: false }]],
      ["unpadded base64", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: pkg.length }, { type: "chunk", id, sha256: digest, seq: 0, data: "AAA", last: false }]],
      ["a chunk over 512 KiB", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 900_000 }, { type: "chunk", id, sha256: digest, seq: 0, data: Buffer.alloc(512 * 1024 + 3).toString("base64"), last: false }]],
      ["an empty chunk that is not last", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 10 }, { type: "chunk", id, sha256: digest, seq: 0, data: "", last: false }]],
      ["a chunk seq that is not a number", (id) => [{ type: "package", id, sha256: digest, kind: "function", sizeBytes: 10 }, { type: "chunk", id, sha256: digest, seq: "0", data: "AAAA", last: false }]],
    ];
    for (const [label, frames] of attacks) {
      const { ctx, made } = await start();
      try {
        await violates(ctx, () => { for (const frame of frames(made.id)) ctx.pipe.send(frame); });
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  });

  it("refuses a package for a registration that never needed it (all digests held)", async () => {
    const ctx = await setup();
    const pkg = handlerZip();
    await register(ctx, { pkg });
    const made = registerFrame({ name: "second", pkg, configHash: "second" });
    ctx.pipe.send(made.frame);
    await ctx.pipe.waitFor((frames) => frames.some((frame) => frame.type === "registered" && frame.body["id"] === made.id));
    // The registration is finished: its late frames are dropped, not a violation; an id never seen is.
    ctx.pipe.send({ type: "package", id: made.id, sha256: sha256(pkg), kind: "function", sizeBytes: pkg.length });
    await violates(ctx, () => { ctx.pipe.send({ type: "chunk", id: "never-seen", sha256: sha256(pkg), seq: 0, data: "AAAA", last: false }); });
  });

  it("holds the disk to the code store's limits: an announced size beyond a zip's cap ends in a refusal, nothing written", async () => {
    const ctx = await setup();
    const made = registerFrame({ pkg: handlerZip() });
    (made.frame["fn"] as { package: { sizeBytes: number } }).package.sizeBytes = 200 * 1024 * 1024;
    ctx.pipe.send(made.frame);
    await ctx.pipe.next("need");
    ctx.pipe.send({ type: "package", id: made.id, sha256: sha256(handlerZip()), kind: "function", sizeBytes: 200 * 1024 * 1024 });
    // The store refuses the size at once; the chunks that follow are drained and the refusal is answered when the stream ends.
    ctx.pipe.send({ type: "chunk", id: made.id, sha256: sha256(handlerZip()), seq: 0, data: Buffer.alloc(16).toString("base64"), last: false });
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(readdirSync(join(ctx.root, "runs", "run-1", "blobs"))).toEqual([]);
    expect(readdirSync(join(ctx.root, "runs", "run-1", "incoming"))).toEqual([]);
  });
});
