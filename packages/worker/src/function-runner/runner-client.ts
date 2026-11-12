// The runner/2 client: the worker's end of the pipe to the Rovara front, joined to the sandbox controller and the code store (slice 4, lane W3). Spec: the header of rovara-local-aws `front/runner_proto.go`; transport: runner-pipe.ts;
// frames: runner-frames.ts. The front is the server of the protocol (it asks, the worker answers); the worker dials, one connection per local-aws helper per sealed round.
//
// WHAT EACH FRAME DOES
//   hello       the front's comes first; ours answers it (proto must be runner/2).
//   register    names the function version, its package and layers by digest. We answer `need` with the digests the code store does not hold (possibly none), the front streams each as `package` + `chunk`s, the store counts,
//               checks and judges them, the tree is unpacked, native code is classified (an x86_64 Python package gets the arm64 wheel swap, anything else x86_64 is Rovara.Unsupported), the function is registered with the
//               controller, and only then is `registered` sent. A refusal is `registered` with ok false and {type, message}; the front keeps the type.
//   invoke      goes to the controller; its outcome is the one `result` of that invoke (ok, function_error, init_error, timeout, crash, rejected, throttled, unavailable).
//   unregister  stops one function's sandboxes (all versions without `version`) and frees its code; answered with `unregistered`.
//   stop_all    the reset barrier: every function of the run is stopped; `stopped` is sent only once every sandbox is confirmed gone. Frames that arrive while it runs wait for it.
//   close       a closed pipe means stop everything.
//
// THE FRONT IS UNTRUSTED TOO. It runs next to the customer's tests. Every frame is parsed by runner-frames.ts (types, shapes, sizes) and then held to STATE RULES: nothing before the hello; an id of a register, invoke, unregister or
// stop_all that is already in flight (or a finished register's) is refused; `package` only for a register we asked it for, for a digest we asked for, once, with the size the register named; `chunk` only for the open package, in order
// from seq 0, never past the announced size, `last` exactly at the end; a frame for a register that has already finished is dropped (the front may still be streaming when we refuse early), but an id never seen is a violation.
// A violation sends `error` (a fixed sentence) and closes the pipe, which stops everything. Every wait has a bound. Logs here are fixed shapes: never a function name, a payload, a variable or docker's own text.
import type { RunCode } from "./code-store.js";
import { INVALID_PARAMETER, RUNNER_ERROR, UNSUPPORTED, RegistrationRefusal, refusalOf, resolveNativeCode, type NativeOutcome } from "./runner-code.js";
import type { FunctionConfig, FunctionKey, InvokeOutcome, SandboxController } from "./controller.js";
import {
  ProtocolViolation, RUNNER_MAX_PAYLOAD_BYTES, RUNNER_PROTOCOL, RunnerFrameError, createRunnerFrameDecoder, decodeBase64, encodeRunnerFrame, frameId, parseChunk, parseHello, parseInvoke, parsePackage, parseRegister, parseUnregister,
  type RawFrame, type RegisteredFunction, type RunnerResultFrame, type WorkerRunnerFrame,
} from "./runner-frames.js";
import type { PipeProcess } from "./runner-pipe.js";
import { REQUEST_ID } from "./codec.js";
import type { SandboxNetwork } from "./sandbox-spec.js";
import type { WheelIndex } from "./wheel-index.js";

export interface RunnerFunctionSettings {
  /** The AWS Lambda base image (by digest) for a runtime, from the catalog; undefined when the runner does not run that runtime (the function is then Rovara.Unsupported). */
  imageForRuntime(runtime: string): string | undefined;
  /** The agent binary on the worker (lane A1). */
  agentHostPath: string;
  agentArgs?: readonly string[];
  /** The network the sandboxes of this connection join (this round's services network), or none. */
  network: SandboxNetwork;
  /** Most sandboxes of one function version at once (default 16). */
  maxConcurrency?: number;
}

export interface RunnerClientLimits {
  /** The front's hello must arrive within this (default 10 s). */
  handshakeMs: number;
  /** A registration that has heard nothing from the front for this long is failed (default 100 s; the front's own limit is 120 s). */
  registerIdleMs: number;
  /** Registrations in flight at once (default 16). */
  maxRegistrations: number;
  /** Invokes in flight at once, over all functions (default 2,048; the controller's own limits bite first). */
  maxInflightInvokes: number;
  /** Bytes of a package held in memory before the pipe is paused (default 4 MiB). */
  highWaterBytes: number;
  /** How long a retired code tree is kept for calls still running on it, beyond the function's Timeout (default 5 s). */
  retireGraceMs: number;
  /** Pause between attempts to confirm sandboxes stopped (default 250 ms). */
  stopRetryMs: number;
  /** Attempts to confirm a close-time stop before giving up (default 40). */
  shutdownTries: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerClientLimits = {
  handshakeMs: 10_000, registerIdleMs: 100_000, maxRegistrations: 16, maxInflightInvokes: 2_048, highWaterBytes: 4 * 1024 * 1024, retireGraceMs: 5_000, stopRetryMs: 250, shutdownTries: 40,
};

export interface RunnerLogEvent {
  event: "connected" | "registered" | "register_refused" | "invoke_rejected" | "unregistered" | "stop_all" | "protocol_error" | "closed" | "stop_unconfirmed" | "ignored_frame";
  /** A fixed code: a refusal's type, a violation's reason, the end reason. */
  reason?: string;
}

/** What `onRegistered` is told. Names are the function's own: for evidence lines, never for logs. */
export interface RegistrationInfo {
  name: string;
  version: string;
  ok: boolean;
  errorType?: string;
  native?: NativeOutcome["native"];
  swapped?: boolean;
  /** The function declared x86_64 and holds no native code, so it runs on arm64 as is. */
  declaredX86RunsOnArm64?: boolean;
}

export type RunnerEndReason = "pipe_closed" | "protocol_error" | "handshake_timeout" | "closed";
export interface RunnerEnd {
  reason: RunnerEndReason;
  /** The front's hello was received and answered. */
  handshaken: boolean;
  /** Every sandbox was confirmed gone when the connection ended. */
  stopped: boolean;
}

export interface RunnerClientOptions {
  pipe: PipeProcess;
  controller: SandboxController;
  code: RunCode;
  settings: RunnerFunctionSettings;
  /** Where the arm64 wheels come from (X2). Without it an x86_64 package is Rovara.Unsupported. */
  wheelIndex?: WheelIndex;
  workerVersion?: string;
  /** The runtimes this worker can run (informational, in our hello). */
  runtimes?: readonly string[];
  limits?: Partial<RunnerClientLimits>;
  log?: (event: RunnerLogEvent) => void;
  onRegistered?: (info: RegistrationInfo) => void;
}

export interface RunnerClient {
  /** Resolves when the connection has ended and every sandbox is gone (or could not be confirmed gone). Never rejects. */
  readonly ended: Promise<RunnerEnd>;
  /** Ends the connection from our side (the round is over): the pipe is closed and everything stopped. */
  close(): Promise<RunnerEnd>;
  readonly handshaken: boolean;
}

/** A byte stream the code store reads, fed by chunk frames, with a bound on what it holds before the pipe is paused. */
class ByteChannel implements AsyncIterable<Uint8Array> {
  private queue: Buffer[] = [];
  private held = 0;
  private produced = false;
  private closed = false;
  private high = false;
  private waiter: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  constructor(private readonly highWater: number, private readonly pressure: (channel: ByteChannel, high: boolean) => void) {}
  push(bytes: Buffer): void {
    if (this.closed || this.produced || bytes.length === 0) return;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: bytes });
      return;
    }
    this.queue.push(bytes);
    this.held += bytes.length;
    this.update();
  }
  /** The last chunk has been pushed. */
  end(): void {
    this.produced = true;
    this.wakeIfDone();
  }
  /** Nobody reads this any more, or the package failed: what is held is dropped and later chunks are discarded. */
  abandon(): void {
    this.closed = true;
    this.queue = [];
    this.held = 0;
    this.update();
    this.wakeIfDone();
  }
  private wakeIfDone(): void {
    if (this.waiter !== undefined && this.queue.length === 0 && (this.produced || this.closed)) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: true, value: undefined });
    }
  }
  /** High above the water mark, low again at a quarter of it. */
  private update(): void {
    const high = !this.closed && (this.high ? this.held > this.highWater / 4 : this.held > this.highWater);
    if (high !== this.high) { this.high = high; this.pressure(this, high); }
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const next = this.queue.shift();
        if (next !== undefined) {
          this.held -= next.length;
          this.update();
          return Promise.resolve({ done: false, value: next });
        }
        if (this.produced || this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
      return: (): Promise<IteratorResult<Uint8Array>> => { this.abandon(); return Promise.resolve({ done: true, value: undefined }); },
    };
  }
}

interface Stream {
  sha256: string;
  kind: "function" | "layer";
  size: number;
  nextSeq: number;
  bytes: number;
  channel: ByteChannel;
  settled: Promise<void>;
}

interface Registration {
  id: string;
  fn: RegisteredFunction;
  state: "queued" | "awaiting" | "working" | "finished";
  needed: Set<string>;
  arrived: Set<string>;
  streams: Map<string, Stream>;
  open: Stream | undefined;
  failure: RegistrationRefusal | undefined;
  aborted: boolean;
  abort: AbortController;
  timer: NodeJS.Timeout | undefined;
  wake: (() => void) | undefined;
  done: Promise<void>;
  resolveDone: () => void;
}

interface HeldFunction {
  name: string;
  version: string;
  key: FunctionKey;
  treeKey: string;
  configHash: string;
  shas: string;
  timeoutSeconds: number;
}

const mapKey = (name: string, version: string): string => `${name}\0${version}`;
const TOMBSTONES = 512;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export function createRunnerClient(options: RunnerClientOptions): RunnerClient {
  const limits: RunnerClientLimits = { ...DEFAULT_RUNNER_LIMITS, ...options.limits };
  const { pipe, controller, code, settings } = options;
  const log = (event: RunnerLogEvent): void => { try { options.log?.(event); } catch { /* a log sink must not change what the client does */ } };

  const decoder = createRunnerFrameDecoder();
  const registrations = new Map<string, Registration>();
  /** Finished register ids (a bounded memory): a late package or chunk for one is dropped; a register frame reusing one is refused. */
  const tombstones = new Set<string>();
  const inflightInvokes = new Set<string>();
  const inflightOther = new Set<string>();
  const functions = new Map<string, HeldFunction>();
  const retiring = new Map<string, NodeJS.Timeout>();
  /** Trees of functions whose sandboxes could not be confirmed gone: removed once a stop is confirmed. */
  const leftovers = new Set<string>();
  const heldPackages = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const pressured = new Set<ByteChannel>();
  let barrier: Promise<void> | undefined;
  let treeCounter = 0;
  let handshaken = false;
  let ended = false;
  let endReason: RunnerEndReason = "closed";
  let resolveEnded!: (end: RunnerEnd) => void;
  const endedPromise = new Promise<RunnerEnd>((resolve) => { resolveEnded = resolve; });

  // ---- sending

  function send(frame: WorkerRunnerFrame): void {
    if (ended && frame.type !== "error") return;
    let bytes: Buffer;
    try {
      bytes = encodeRunnerFrame(frame);
    } catch {
      if (frame.type === "result") send({ type: "result", id: frame.id, status: "unavailable", reason: "protocol_error", detail: "the result was too large to send" });
      return;
    }
    pipe.write(bytes).catch(() => { void end("pipe_closed"); });
  }

  function remember(id: string): void {
    tombstones.add(id);
    if (tombstones.size > TOMBSTONES) tombstones.delete(tombstones.values().next().value as string);
  }

  function pressure(channel: ByteChannel, high: boolean): void {
    if (high) pressured.add(channel); else pressured.delete(channel);
    if (ended) return;
    if (pressured.size > 0) pipe.pause(); else pipe.resume();
  }

  // ---- ending

  async function end(reason: RunnerEndReason, tell?: string): Promise<RunnerEnd> {
    if (ended) return endedPromise;
    ended = true;
    endReason = reason;
    clearTimeout(handshakeTimer);
    if (tell !== undefined) {
      try { await pipe.write(encodeRunnerFrame({ type: "error", message: tell })); } catch { /* the pipe is going away */ }
    }
    pipe.end();
    if (reason !== "protocol_error") log({ event: "closed", reason });
    for (const registration of [...registrations.values()]) abortRegistration(registration);
    await Promise.allSettled([...registrations.values()].map((registration) => registration.done));
    for (const timer of retiring.values()) clearTimeout(timer);
    retiring.clear();
    // A closed pipe means stop everything. The controller refuses new work afterwards; a reconnect gets a new controller.
    let stopped = false;
    for (let attempt = 0; attempt < limits.shutdownTries && !stopped; attempt += 1) {
      stopped = await controller.stopAll().catch(() => false);
      if (!stopped) { await controller.reap().catch(() => 0); await sleep(limits.stopRetryMs); }
    }
    if (!stopped) log({ event: "stop_unconfirmed" });
    pipe.kill();
    const result: RunnerEnd = { reason: endReason, handshaken, stopped };
    resolveEnded(result);
    return result;
  }

  function violate(reason: string): void {
    void end("protocol_error", "the runner protocol was not followed");
    log({ event: "protocol_error", reason });
  }

  // ---- registration

  function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const before = locks.get(name) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    locks.set(name, tail);
    void tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
    return run;
  }

  function touch(registration: Registration): void {
    if (registration.timer !== undefined) clearTimeout(registration.timer);
    if (registration.state === "finished") return;
    registration.timer = setTimeout(() => {
      registration.failure ??= new RegistrationRefusal(RUNNER_ERROR, "The function's code did not arrive in time");
      abortRegistration(registration);
    }, limits.registerIdleMs);
    registration.timer.unref();
  }

  function abortRegistration(registration: Registration): void {
    registration.aborted = true;
    registration.abort.abort();
    for (const stream of registration.streams.values()) stream.channel.abandon();
    registration.wake?.();
  }

  function finish(registration: Registration, refusal?: RegistrationRefusal, info?: Partial<RegistrationInfo>): void {
    if (registration.state === "finished") return;
    registration.state = "finished";
    if (registration.timer !== undefined) clearTimeout(registration.timer);
    registrations.delete(registration.id);
    remember(registration.id);
    const { name, version } = registration.fn;
    if (refusal === undefined) send({ type: "registered", id: registration.id, ok: true });
    else send({ type: "registered", id: registration.id, ok: false, error: { type: refusal.errorType, message: refusal.message } });
    log({ event: refusal === undefined ? "registered" : "register_refused", ...(refusal === undefined ? {} : { reason: refusal.errorType }) });
    try { options.onRegistered?.({ name, version, ok: refusal === undefined, ...(refusal === undefined ? {} : { errorType: refusal.errorType }), ...info }); } catch { /* an observer must not change what the client does */ }
    registration.resolveDone();
  }

  /** What can be decided from the register frame alone, before any code is asked for. */
  function preflight(fn: RegisteredFunction): RegistrationRefusal | undefined {
    if (fn.packageType === "Image") return new RegistrationRefusal(UNSUPPORTED, "Container-image functions are not supported by the function runner yet");
    if (settings.imageForRuntime(fn.runtime) === undefined) return new RegistrationRefusal(UNSUPPORTED, "The function runner does not run this runtime yet");
    if (fn.package === undefined) return new RegistrationRefusal(INVALID_PARAMETER, "The function has no code package");
    if (fn.layers.length > 5) return new RegistrationRefusal(INVALID_PARAMETER, "The function has more layers than Lambda allows");
    return undefined;
  }

  const shasOf = (fn: RegisteredFunction): string[] => [fn.package!.sha256, ...fn.layers.map((layer) => layer.sha256)];

  function onRegister(body: Readonly<Record<string, unknown>>): void {
    const { id, fn } = parseRegister(body);
    if (registrations.has(id) || tombstones.has(id) || inflightInvokes.has(id) || inflightOther.has(id)) return violate("duplicate id");
    let resolveDone!: () => void;
    const registration: Registration = {
      id, fn, state: "queued", needed: new Set(), arrived: new Set(), streams: new Map(), open: undefined, failure: undefined, aborted: false, abort: new AbortController(), timer: undefined, wake: undefined,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }), resolveDone: () => resolveDone(),
    };
    if (registrations.size >= limits.maxRegistrations) {
      registrations.set(id, registration);
      return finish(registration, new RegistrationRefusal(RUNNER_ERROR, "The function runner has too many registrations in flight"));
    }
    registrations.set(id, registration);
    touch(registration);
    const gate = barrier;
    void (async () => {
      try {
        if (gate !== undefined) await gate;
        await withLock(fn.name, () => runRegistration(registration));
      } catch (error) {
        finish(registration, refusalOf(error));
      }
    })();
  }

  async function runRegistration(registration: Registration): Promise<void> {
    const { fn } = registration;
    if (registration.aborted) return finish(registration, registration.failure ?? new RegistrationRefusal(RUNNER_ERROR, "The function runner was reset while the function was being registered"));
    const early = preflight(fn);
    if (early !== undefined) return finish(registration, early);
    // The same registration again (same configuration hash and code): nothing to do.
    const held = functions.get(mapKey(fn.name, fn.version));
    const shas = shasOf(fn).join(",");
    if (held !== undefined && held.configHash === fn.configHash && held.shas === shas) return finish(registration);
    for (const sha of new Set(shasOf(fn))) if (!code.has(sha)) registration.needed.add(sha);
    registration.state = "awaiting";
    send({ type: "need", id: registration.id, packages: [...registration.needed] });
    touch(registration);
    // Wait until every needed package has fully arrived (or the registration is aborted); then until the store has judged each.
    while (!registration.aborted && registration.arrived.size < registration.needed.size) {
      await new Promise<void>((resolve) => { registration.wake = resolve; });
      registration.wake = undefined;
    }
    await Promise.allSettled([...registration.streams.values()].map((stream) => stream.settled));
    if (registration.failure !== undefined) return finish(registration, registration.failure);
    if (registration.aborted) return finish(registration, new RegistrationRefusal(RUNNER_ERROR, "The function runner was reset while the function was being registered"));
    registration.state = "working";
    touch(registration);
    const outcome = await materializeAndRegister(registration);
    finish(registration, undefined, outcome);
  }

  async function materializeAndRegister(registration: Registration): Promise<Partial<RegistrationInfo>> {
    const { fn } = registration;
    const treeKey = `t${String(treeCounter += 1)}`;
    const key: FunctionKey = { functionName: fn.name, version: fn.version };
    let materialized: Awaited<ReturnType<RunCode["materialize"]>> | undefined;
    try {
      materialized = await code.materialize(treeKey, { packageSha256: fn.package!.sha256, layerSha256s: fn.layers.map((layer) => layer.sha256) });
      if (registration.aborted) throw new RegistrationRefusal(RUNNER_ERROR, "The function runner was reset while the function was being registered");
      const native = await resolveNativeCode(materialized, { runtime: fn.runtime, wheelIndex: options.wheelIndex });
      if (registration.aborted) throw new RegistrationRefusal(RUNNER_ERROR, "The function runner was reset while the function was being registered");
      const config: FunctionConfig = {
        runtime: fn.runtime, handler: fn.handler, environment: fn.env, region: fn.region, memoryMb: fn.memoryMb, timeoutSeconds: fn.timeoutSeconds, ephemeralMb: fn.ephemeralMb > 0 ? fn.ephemeralMb : 512,
        image: settings.imageForRuntime(fn.runtime)!, agentHostPath: settings.agentHostPath, codeHostPath: materialized.taskDir, layersHostPath: materialized.optDir, network: settings.network, maxConcurrency: settings.maxConcurrency ?? 16,
        ...(fn.arn === "" ? {} : { functionArn: fn.arn }), ...(settings.agentArgs === undefined ? {} : { agentArgs: settings.agentArgs }),
      };
      try {
        await controller.register(key, config);
      } catch (error) {
        // The controller's refusals are RangeErrors with fixed sentences ("not a valid function configuration: <what>").
        if (error instanceof RangeError) throw new RegistrationRefusal(INVALID_PARAMETER, error.message);
        throw error;
      }
      const previous = functions.get(mapKey(fn.name, fn.version));
      functions.set(mapKey(fn.name, fn.version), { name: fn.name, version: fn.version, key, treeKey, configHash: fn.configHash, shas: shasOf(fn).join(","), timeoutSeconds: fn.timeoutSeconds });
      if (previous !== undefined) retireTree(previous);
      for (const sha of shasOf(fn)) heldPackages.add(sha);
      return { native: native.native, swapped: native.swapped, declaredX86RunsOnArm64: fn.architectures.includes("x86_64") && !materialized.needsArchAction && !native.native.native };
    } catch (error) {
      await code.discard(treeKey).catch(() => undefined);
      throw refusalOf(error);
    }
  }

  /** The old tree of a replaced function stays for the calls still running on it (the old Timeout and a moment), then goes. */
  function retireTree(old: HeldFunction): void {
    const timer = setTimeout(() => { retiring.delete(old.treeKey); void code.discard(old.treeKey).catch(() => undefined); }, old.timeoutSeconds * 1_000 + limits.retireGraceMs);
    timer.unref();
    retiring.set(old.treeKey, timer);
  }

  async function discardRetired(): Promise<void> {
    const keys = [...retiring.keys(), ...leftovers];
    leftovers.clear();
    for (const timer of retiring.values()) clearTimeout(timer);
    retiring.clear();
    await Promise.all(keys.map((key) => code.discard(key).catch(() => undefined)));
  }

  function onPackage(body: Readonly<Record<string, unknown>>): void {
    const header = parsePackage(body);
    const registration = registrations.get(header.id);
    if (registration === undefined) {
      if (tombstones.has(header.id)) return log({ event: "ignored_frame", reason: "package for a finished registration" });
      return violate("package for an unknown id");
    }
    if (registration.state !== "awaiting" || !registration.needed.has(header.sha256) || registration.streams.has(header.sha256) || registration.open !== undefined) return violate("package not asked for");
    const fn = registration.fn;
    const expected = header.sha256 === fn.package?.sha256 ? "function" : "layer";
    const ref = header.sha256 === fn.package?.sha256 ? fn.package : fn.layers.find((layer) => layer.sha256 === header.sha256);
    if (header.kind !== expected || ref === undefined || ref.sizeBytes !== header.sizeBytes) return violate("package does not match the registration");
    touch(registration);
    const channel = new ByteChannel(limits.highWaterBytes, pressure);
    const stream: Stream = { sha256: header.sha256, kind: header.kind, size: header.sizeBytes, nextSeq: 0, bytes: 0, channel, settled: Promise.resolve() };
    stream.settled = code.receive({ kind: header.kind, sha256: header.sha256, sizeBytes: header.sizeBytes }, channel, { signal: registration.abort.signal }).then(
      () => { channel.abandon(); },
      (error: unknown) => {
        registration.failure ??= refusalOf(error);
        channel.abandon();
      },
    );
    registration.streams.set(header.sha256, stream);
    registration.open = stream;
  }

  function onChunk(body: Readonly<Record<string, unknown>>): void {
    const chunk = parseChunk(body);
    const registration = registrations.get(chunk.id);
    if (registration === undefined) {
      if (tombstones.has(chunk.id)) return;
      return violate("chunk for an unknown id");
    }
    const stream = registration.open;
    if (stream === undefined || stream.sha256 !== chunk.sha256) return violate("chunk without its package");
    if (chunk.seq !== stream.nextSeq) return violate("chunk out of order");
    stream.nextSeq += 1;
    stream.bytes += chunk.data.length;
    if (stream.bytes > stream.size) return violate("chunk past the announced size");
    if (chunk.last && stream.bytes !== stream.size) return violate("package ended short");
    if (!chunk.last && stream.bytes === stream.size) return violate("package did not end at its size");
    touch(registration);
    stream.channel.push(chunk.data);
    if (chunk.last) {
      stream.channel.end();
      registration.open = undefined;
      registration.arrived.add(stream.sha256);
      registration.wake?.();
    }
  }

  // ---- invoke

  function onInvoke(body: Readonly<Record<string, unknown>>): void {
    const frame = parseInvoke(body);
    if (inflightInvokes.has(frame.id) || inflightOther.has(frame.id) || registrations.has(frame.id)) return violate("duplicate id");
    inflightInvokes.add(frame.id);
    const gate = barrier;
    void (async () => {
      let result: RunnerResultFrame;
      try {
        if (gate !== undefined) await gate;
        result = await runInvoke(frame);
      } catch {
        result = { type: "result", id: frame.id, status: "unavailable", reason: "protocol_error", detail: "the runner failed to run the call" };
      }
      inflightInvokes.delete(frame.id);
      send(result);
    })();
  }

  async function runInvoke(frame: ReturnType<typeof parseInvoke>): Promise<RunnerResultFrame> {
    const refuse = (reason: string, detail: string): RunnerResultFrame => { log({ event: "invoke_rejected", reason }); return { type: "result", id: frame.id, status: "unavailable", reason, detail }; };
    if (ended) return refuse("closed", "the runner connection is closed");
    const held = functions.get(mapKey(frame.name, frame.version));
    if (held === undefined) return { type: "result", id: frame.id, status: "unavailable", reason: "not_registered" };
    if (inflightInvokes.size > limits.maxInflightInvokes) return { type: "result", id: frame.id, status: "throttled", reason: "concurrency" };
    const payload = decodeBase64(frame.payload, RUNNER_MAX_PAYLOAD_BYTES);
    if (payload === undefined) return refuse("invalid_request", "the payload is not valid base64 or is over 6,291,556 bytes");
    if (!REQUEST_ID.test(frame.requestId)) return refuse("invalid_request", "the request id is not a plain id");
    if (frame.timeoutMs < 1 || frame.timeoutMs > 900_000) return refuse("invalid_request", "the timeout is out of range");
    const outcome = await controller.invoke({
      key: held.key, requestId: frame.requestId, payload, timeoutMs: frame.timeoutMs,
      ...(frame.functionArn === undefined ? {} : { invokedFunctionArn: frame.functionArn }), ...(frame.traceId === undefined ? {} : { traceId: frame.traceId }),
      ...(frame.clientContext === undefined ? {} : { clientContext: frame.clientContext }), ...(frame.cognitoIdentity === undefined ? {} : { cognitoIdentity: frame.cognitoIdentity }),
    });
    return resultOf(frame.id, outcome);
  }

  // ---- unregister and stop_all

  async function removeFunction(held: HeldFunction): Promise<boolean> {
    functions.delete(mapKey(held.name, held.version));
    const confirmed = await controller.stopFunction(held.key).catch(() => false);
    if (confirmed) await code.discard(held.treeKey).catch(() => undefined);
    else leftovers.add(held.treeKey);
    return confirmed;
  }

  function onUnregister(body: Readonly<Record<string, unknown>>): void {
    const frame = parseUnregister(body);
    if (inflightInvokes.has(frame.id) || inflightOther.has(frame.id) || registrations.has(frame.id)) return violate("duplicate id");
    inflightOther.add(frame.id);
    const gate = barrier;
    void (async () => {
      try {
        if (gate !== undefined) await gate;
        await withLock(frame.name, async () => {
          const targets = [...functions.values()].filter((held) => held.name === frame.name && (frame.version === undefined || held.version === frame.version));
          await Promise.all(targets.map((held) => removeFunction(held)));
        });
      } catch { /* answered below: the front does not wait for this */ }
      inflightOther.delete(frame.id);
      log({ event: "unregistered" });
      send({ type: "unregistered", id: frame.id });
    })();
  }

  function onStopAll(body: Readonly<Record<string, unknown>>): void {
    const id = frameId(body);
    if (inflightInvokes.has(id) || inflightOther.has(id) || registrations.has(id)) return violate("duplicate id");
    inflightOther.add(id);
    const previous = barrier;
    const run = (async () => {
      if (previous !== undefined) await previous.catch(() => undefined);
      // Registrations in flight are over: the front is told so, and what they were making is cleaned up.
      const flying = [...registrations.values()];
      for (const registration of flying) {
        registration.failure ??= new RegistrationRefusal(RUNNER_ERROR, "The function runner was reset while the function was being registered");
        abortRegistration(registration);
      }
      await Promise.allSettled(flying.map((registration) => registration.done));
      // The barrier: answered only when every sandbox of every function is confirmed gone.
      while (!ended) {
        const targets = [...functions.values()];
        const results = await Promise.all(targets.map((held) => controller.stopFunction(held.key).catch(() => false)));
        if (results.every(Boolean) && controller.stats().environments === 0) {
          await Promise.all(targets.map((held) => code.discard(held.treeKey).catch(() => undefined)));
          for (const held of targets) functions.delete(mapKey(held.name, held.version));
          await discardRetired();
          await Promise.all([...heldPackages].map((sha) => code.dropPackage(sha).catch(() => undefined)));
          heldPackages.clear();
          log({ event: "stop_all" });
          return true;
        }
        await controller.reap().catch(() => 0);
        await sleep(limits.stopRetryMs);
      }
      return false;
    })();
    const gated = run.then(() => undefined, () => undefined);
    barrier = gated;
    void gated.then(() => { if (barrier === gated) barrier = undefined; });
    void run.then((confirmed) => {
      inflightOther.delete(id);
      if (confirmed) send({ type: "stopped", id });
    });
  }

  // ---- the stream

  function dispatch(frame: RawFrame): void {
    if (!handshaken) {
      if (frame.type !== "hello") return violate("a frame before the hello");
      const hello = parseHello(frame.body);
      if (hello.proto !== RUNNER_PROTOCOL) { void end("protocol_error", `this worker speaks ${RUNNER_PROTOCOL}`); return; }
      handshaken = true;
      clearTimeout(handshakeTimer);
      send({ type: "hello", proto: RUNNER_PROTOCOL, worker: "rovara-worker", version: options.workerVersion ?? "0", ...(options.runtimes === undefined ? {} : { runtimes: [...options.runtimes] }) });
      log({ event: "connected" });
      return;
    }
    switch (frame.type) {
      case "hello": return; // a second hello is ignored, as the front ignores ours
      case "register": return onRegister(frame.body);
      case "package": return onPackage(frame.body);
      case "chunk": return onChunk(frame.body);
      case "invoke": return onInvoke(frame.body);
      case "unregister": return onUnregister(frame.body);
      case "stop_all": return onStopAll(frame.body);
      default: return log({ event: "ignored_frame", reason: "unknown type" }); // an unknown type is ignored
    }
  }

  pipe.onStdout((chunk) => {
    if (ended) return;
    let frames: RawFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      return violate(error instanceof RunnerFrameError ? error.reason : "bad stream");
    }
    for (const frame of frames) {
      if (ended) return;
      try {
        dispatch(frame);
      } catch (error) {
        if (error instanceof ProtocolViolation) return violate(error.reason);
        throw error;
      }
    }
  });
  pipe.onStderr(() => undefined);
  void pipe.exited.then(() => { void end("pipe_closed"); });
  // (Declared here, after the functions that clear it: they only run once frames arrive.)
  const handshakeTimer = setTimeout(() => { if (!handshaken) void end("handshake_timeout"); }, limits.handshakeMs);
  handshakeTimer.unref();

  return {
    ended: endedPromise,
    close: () => end("closed"),
    get handshaken() { return handshaken; },
  };
}

const text = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

/** The one `result` frame of an invoke, from the controller's outcome. */
export function resultOf(id: string, outcome: InvokeOutcome): RunnerResultFrame {
  switch (outcome.kind) {
    case "throttled": return { type: "result", id, status: "throttled", reason: outcome.reason };
    case "unavailable": return { type: "result", id, status: "unavailable", reason: outcome.reason, ...(text(outcome.detail) === undefined ? {} : { detail: outcome.detail }) };
    default: break;
  }
  const initLog = outcome.initLogTail ?? "";
  const logTail = `${initLog}${outcome.logTail}`;
  const base: RunnerResultFrame = {
    type: "result", id, status: "ok", durationMs: outcome.report?.durationMs ?? outcome.wallMs,
    ...(outcome.report?.billedDurationMs === undefined ? {} : { billedDurationMs: outcome.report.billedDurationMs }),
    ...((outcome.report?.initDurationMs ?? outcome.coldStartMs) === undefined ? {} : { initDurationMs: (outcome.report?.initDurationMs ?? outcome.coldStartMs)! }),
    ...(outcome.maxMemoryUsedBytes === undefined ? {} : { maxMemoryUsed: outcome.maxMemoryUsedBytes }),
    ...(logTail === "" ? {} : { logTail }), ...(outcome.logsTruncated ? { logTruncated: true } : {}), ...(outcome.cold ? { cold: true } : {}), ...(outcome.memoryClamped ? { memoryClamped: true } : {}),
  };
  switch (outcome.kind) {
    case "response": return { ...base, status: "ok", payload: outcome.payload.toString("base64") };
    case "error": return { ...base, status: "function_error", errorType: outcome.errorType, errorMessage: outcome.errorMessage, payload: outcome.payload.toString("base64") };
    case "init_error": return { ...base, status: "init_error", errorType: outcome.errorType, errorMessage: outcome.errorMessage, payload: outcome.payload.toString("base64") };
    case "timeout": return { ...base, status: "timeout", errorType: outcome.errorType, errorMessage: outcome.errorMessage };
    case "crash": return { ...base, status: "crash", errorType: outcome.errorType, errorMessage: outcome.errorMessage, };
    case "rejected": return { ...base, status: "rejected", errorType: outcome.errorType, errorMessage: outcome.errorMessage };
  }
}
