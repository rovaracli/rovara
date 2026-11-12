// One live agent connection: the `docker run -i` process of a single sandbox plus the frames over it (slice 4, lane W1). It runs ONE invoke at a time (as a Lambda execution environment does) and ends that invoke on the
// first of: the agent's `result`, the process exiting, the deadline backstop, a protocol violation, or a cancel. It never decides what happens to the container: the controller does (controller.ts). Every untrusted byte
// from the agent passes `AgentCodec`'s decoder, which caps each frame, before anything here looks at it.

import { AGENT_PROTOCOL, CodecError, type AgentCodec, type AgentFrame, type FrameDecoder, type InvokeFrame, type ResultFrame } from "./codec.js";
import type { SandboxExit, SandboxProcess } from "./launcher.js";

/** How the sandbox's start ended, before any invoke is sent. */
export type StartupResult =
  | { kind: "ready" }
  /** The runtime did not come up (the agent's `init_error` frame). */
  | { kind: "init_error"; frame: Extract<AgentFrame, { type: "init_error" }> }
  | { kind: "exit"; exit: SandboxExit; sawFrames: boolean; fatal?: string }
  | { kind: "timeout" }
  | { kind: "protocol_error"; reason: string }
  | { kind: "stopped" };

export type RawInvokeResult =
  /** The agent answered (any status). */
  | { kind: "result"; result: ResultFrame }
  /** The docker client ended while the invoke was open. `sawFrames` says whether the agent ever spoke (no: docker or the agent itself failed to start); `fatal` is the agent's last words, when it sent any. */
  | { kind: "exit"; exit: SandboxExit; sawFrames: boolean; fatal?: string }
  | { kind: "timeout" }
  | { kind: "protocol_error"; reason: string }
  | { kind: "stopped" };

export interface SessionOptions {
  codec: AgentCodec;
  maxFrameBytes: number;
  now: () => number;
  /** Most stdout bytes accepted while the sandbox starts (hello, ready). */
  maxStartupBytes?: number;
  /** Most stdout bytes accepted while no invoke is open (only `runtime_exit` is allowed then). */
  maxIdleBytes?: number;
  /** Most stdout bytes accepted for one invoke (one result, and a few small frames around it). */
  maxInvokeBytes?: number;
  /** Most frames besides the result in one invoke (and most `fatal` frames while starting). */
  maxExtraFramesPerInvoke?: number;
  /** How long an idle sandbox may leave a frame half-sent before it is ended. */
  partialFrameMs?: number;
  /** Called when the agent reports that the runtime died while no invoke was open. */
  onRuntimeExit?: () => void;
}

export interface InvokeInput {
  requestId: string;
  /** The event, base64. */
  payload: string;
  /** What the agent enforces, in ms from the moment it hands the event to the runtime. */
  timeoutMs: number;
  /** The worker's own backstop: the invoke is ended (result `timeout`) this long after `timeoutMs`. */
  backstopMs: number;
  functionArn?: string;
  traceId?: string;
  clientContext?: string;
  cognitoIdentity?: string;
  functionVersion?: string;
  memorySizeMb?: number;
  logBytes?: number;
}

interface Current {
  input: InvokeInput;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (result: RawInvokeResult) => void;
}

const STDERR_TAIL = 2_048;
type Phase = "starting" | "idle" | "invoke";
interface Startup { timer: ReturnType<typeof setTimeout> | undefined; resolve: (result: StartupResult) => void }

export class SandboxSession {
  readonly startedAtMs: number;
  /** Set when the agent said `ready`: the runtime is polling for work. */
  readyAtMs: number | undefined;
  /** The init duration and init output from `ready`. */
  initDurationMs: number | undefined;
  initLogTail: string | undefined;
  /** The agent's `init_error` frame sent before any invoke (the next invoke would restart the runtime; the controller retires such an environment instead). */
  startupInitError: Extract<AgentFrame, { type: "init_error" }> | undefined;
  runtimeExited = false;
  fatalMessage: string | undefined;
  exit: SandboxExit | undefined;
  protocolError: string | undefined;
  framesSeen = 0;
  /** Resolves once the docker client has ended and its output has all been read. */
  readonly exited: Promise<SandboxExit>;

  private readonly decoder: FrameDecoder;
  private current: Current | undefined;
  private startup: Startup | undefined;
  /** Where the agent is in its conversation with us. A hostile function can write frames onto the agent's stdout, so only the frames that fit the phase are accepted; anything else ends the sandbox. */
  private phase: Phase = "starting";
  private phaseBytes = 0;
  private extraFrames = 0;
  private helloSeen = false;
  private partialTimer: ReturnType<typeof setTimeout> | undefined;
  private stderr = "";
  private cancelled = false;

  constructor(private readonly process: SandboxProcess, private readonly options: SessionOptions) {
    this.startedAtMs = options.now();
    this.decoder = options.codec.createDecoder({ maxFrameBytes: options.maxFrameBytes });
    process.onStdout((chunk) => this.onStdout(chunk));
    process.onStderr((chunk) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL); });
    this.exited = process.exited.then((exit) => {
      this.exit = exit;
      this.clearPartialTimer();
      if (this.cancelled) { this.finish({ kind: "stopped" }); this.finishStartup({ kind: "stopped" }); }
      else { this.finish(this.exitResult(exit)); this.finishStartup(this.exitResult(exit)); }
      return exit;
    });
  }

  /** True when this environment can no longer serve a call: its process ended, it broke the protocol, or its runtime died. */
  get dead(): boolean {
    return this.exit !== undefined || this.protocolError !== undefined || this.runtimeExited;
  }

  /** The tail of the docker client's stderr with control characters removed. For diagnosis of a start failure only; it is the daemon's text, so never stored or sent on. */
  stderrTail(): string {
    return this.stderr.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  }

  /** Resolves when the runtime is ready, or the start failed, or `timeoutMs` passed. The first invoke is sent only after this says `ready`, so a slow start is not charged to the function's Timeout. */
  whenReady(timeoutMs: number): Promise<StartupResult> {
    return new Promise((resolve) => {
      if (this.readyAtMs !== undefined) { resolve({ kind: "ready" }); return; }
      if (this.startupInitError !== undefined) { resolve({ kind: "init_error", frame: this.startupInitError }); return; }
      if (this.exit !== undefined) { resolve(this.cancelled ? { kind: "stopped" } : this.exitResult(this.exit)); return; }
      if (this.protocolError !== undefined) { resolve({ kind: "protocol_error", reason: this.protocolError }); return; }
      if (this.cancelled) { resolve({ kind: "stopped" }); return; }
      const waiting: Startup = { timer: undefined, resolve };
      waiting.timer = setTimeout(() => this.finishStartup({ kind: "timeout" }), timeoutMs);
      this.startup = waiting;
    });
  }

  invoke(input: InvokeInput): Promise<RawInvokeResult> {
    return new Promise((resolve) => {
      if (this.current !== undefined) { resolve({ kind: "protocol_error", reason: "overlapping_invoke" }); return; }
      if (this.exit !== undefined) { resolve(this.exitResult(this.exit)); return; }
      if (this.protocolError !== undefined) { resolve({ kind: "protocol_error", reason: this.protocolError }); return; }
      const current: Current = { input, timer: undefined, resolve };
      this.current = current;
      this.enter("invoke");
      current.timer = setTimeout(() => this.finish({ kind: "timeout" }), input.timeoutMs + input.backstopMs);
      const frame: InvokeFrame = {
        type: "invoke", requestId: input.requestId, payload: input.payload, timeoutMs: input.timeoutMs,
        ...(input.functionArn === undefined ? {} : { functionArn: input.functionArn }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        ...(input.clientContext === undefined ? {} : { clientContext: input.clientContext }),
        ...(input.cognitoIdentity === undefined ? {} : { cognitoIdentity: input.cognitoIdentity }),
        ...(input.functionVersion === undefined ? {} : { functionVersion: input.functionVersion }),
        ...(input.memorySizeMb === undefined ? {} : { memorySizeMb: input.memorySizeMb }),
        ...(input.logBytes === undefined ? {} : { logBytes: input.logBytes }),
      };
      let bytes: Buffer;
      try {
        bytes = this.options.codec.encode(frame);
      } catch {
        this.finish({ kind: "protocol_error", reason: "frame_too_large" });
        return;
      }
      this.process.write(bytes).catch(() => undefined);
    });
  }

  /** Ends the invoke in flight (result `stopped`) and refuses later ones. The process is ended by the controller. */
  cancel(): void {
    this.cancelled = true;
    this.finish({ kind: "stopped" });
    this.finishStartup({ kind: "stopped" });
  }

  /** SIGKILLs the docker client. */
  killClient(): void {
    this.process.kill();
  }

  private exitResult(exit: SandboxExit): Extract<RawInvokeResult, { kind: "exit" }> {
    return { kind: "exit", exit, sawFrames: this.framesSeen > 0, ...(this.fatalMessage === undefined ? {} : { fatal: this.fatalMessage }) };
  }

  private clearPartialTimer(): void {
    if (this.partialTimer !== undefined) clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
  }

  /** An idle sandbox has no business sending anything, least of all half a frame: a trickle of bytes that never completes would hold buffers for as long as the environment lives. */
  private watchPartialFrame(): void {
    if (this.phase !== "idle") { this.clearPartialTimer(); return; }
    if (this.decoder.pending().bytes === 0) { this.clearPartialTimer(); return; }
    if (this.partialTimer !== undefined) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = undefined;
      if (this.phase === "idle" && this.decoder.pending().bytes > 0) this.fail("partial_frame");
    }, this.options.partialFrameMs ?? 2_000);
    this.partialTimer.unref();
  }

  private enter(phase: Phase): void {
    this.clearPartialTimer();
    this.phase = phase;
    this.phaseBytes = 0;
    this.extraFrames = 0;
  }

  private fail(reason: string): void {
    if (this.protocolError !== undefined) return;
    this.clearPartialTimer();
    this.protocolError = reason;
    this.process.kill();
    this.finish({ kind: "protocol_error", reason });
    this.finishStartup({ kind: "protocol_error", reason });
  }

  private byteCap(): number {
    const max = this.options.maxFrameBytes;
    if (this.phase === "starting") return this.options.maxStartupBytes ?? 8 * 1024 * 1024;
    if (this.phase === "idle") return this.options.maxIdleBytes ?? 64 * 1024;
    return this.options.maxInvokeBytes ?? 2 * max;
  }

  private onStdout(chunk: Buffer): void {
    if (this.protocolError !== undefined || this.cancelled) return;
    // The byte cap is checked on the raw chunk, before any decoding: a function that floods the agent's stdout costs a counter, not a parse.
    this.phaseBytes += chunk.length;
    if (this.phaseBytes > this.byteCap()) { this.fail("flood"); return; }
    let frames: AgentFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof CodecError ? error.reason : "bad_stream");
      return;
    }
    for (const frame of frames) {
      if (this.protocolError !== undefined) return;
      this.framesSeen += 1;
      this.onFrame(frame);
    }
    if (this.protocolError === undefined) this.watchPartialFrame();
  }

  /** The frames each phase accepts. Everything else is a protocol violation. */
  private onFrame(frame: AgentFrame): void {
    const phase = this.phase;
    // The agent speaks first, and what it says first is `hello`.
    if (!this.helloSeen && frame.type !== "hello") { this.fail("no_hello"); return; }
    switch (frame.type) {
      case "hello":
        if (phase !== "starting" || this.helloSeen || this.framesSeen > 1 || frame.proto !== AGENT_PROTOCOL) { this.fail("bad_hello"); return; }
        this.helloSeen = true;
        return;
      case "ready":
        if (phase === "idle") { this.fail("unexpected_frame"); return; }
        if (phase === "invoke" && ++this.extraFrames > (this.options.maxExtraFramesPerInvoke ?? 8)) { this.fail("too_many_frames"); return; }
        this.readyAtMs ??= this.options.now();
        this.initDurationMs = frame.initDurationMs;
        this.initLogTail = frame.logTail;
        if (phase === "starting") { this.enter("idle"); this.finishStartup({ kind: "ready" }); }
        return;
      case "init_error":
        if (phase === "idle") { this.fail("unexpected_frame"); return; }
        if (phase === "invoke" && ++this.extraFrames > (this.options.maxExtraFramesPerInvoke ?? 8)) { this.fail("too_many_frames"); return; }
        this.startupInitError ??= frame;
        if (phase === "starting") { this.enter("idle"); this.finishStartup({ kind: "init_error", frame }); }
        return;
      case "runtime_exit":
        if (phase === "starting") { this.fail("unexpected_frame"); return; }
        if (phase === "invoke" && ++this.extraFrames > (this.options.maxExtraFramesPerInvoke ?? 8)) { this.fail("too_many_frames"); return; }
        this.runtimeExited = true;
        if (phase === "idle") this.options.onRuntimeExit?.();
        return;
      case "fatal":
        // Recorded for diagnosis only. It never changes how a crash is classified: a function can forge it.
        if (phase === "idle" || ++this.extraFrames > (this.options.maxExtraFramesPerInvoke ?? 8)) { this.fail(phase === "idle" ? "unexpected_frame" : "too_many_frames"); return; }
        this.fatalMessage = frame.message;
        return;
      case "result":
        if (phase !== "invoke" || this.current === undefined) { this.fail("unexpected_frame"); return; }
        if (frame.requestId !== this.current.input.requestId) { this.fail("unexpected_result"); return; }
        this.finish({ kind: "result", result: frame });
        return;
    }
  }

  private finishStartup(result: StartupResult): void {
    const waiting = this.startup;
    if (waiting === undefined) return;
    this.startup = undefined;
    if (waiting.timer !== undefined) clearTimeout(waiting.timer);
    waiting.resolve(result);
  }

  /** Ends the invoke in flight, once. */
  private finish(result: RawInvokeResult): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    if (this.phase === "invoke") this.enter("idle");
    if (current.timer !== undefined) clearTimeout(current.timer);
    current.resolve(result);
  }
}
