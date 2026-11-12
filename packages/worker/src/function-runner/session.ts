// One live agent connection: the `docker run -i` process of a single sandbox plus the frames over it (slice 4, lane W1). It runs ONE invoke at a time (as a Lambda execution environment does) and ends that invoke on the
// first of: the agent's `result`, the process exiting, the deadline backstop, a protocol violation, or a cancel. It never decides what happens to the container: the controller does (controller.ts). Every untrusted byte
// from the agent passes `AgentCodec`'s decoder, which caps each frame, before anything here looks at it.

import { AGENT_PROTOCOL, CodecError, type AgentCodec, type AgentFrame, type FrameDecoder, type InvokeFrame, type ResultFrame } from "./codec.js";
import type { SandboxExit, SandboxProcess } from "./launcher.js";

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
  private stderr = "";
  private cancelled = false;

  constructor(private readonly process: SandboxProcess, private readonly options: SessionOptions) {
    this.startedAtMs = options.now();
    this.decoder = options.codec.createDecoder({ maxFrameBytes: options.maxFrameBytes });
    process.onStdout((chunk) => this.onStdout(chunk));
    process.onStderr((chunk) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL); });
    this.exited = process.exited.then((exit) => {
      this.exit = exit;
      if (this.cancelled) this.finish({ kind: "stopped" });
      else this.finish(this.exitResult(exit));
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

  invoke(input: InvokeInput): Promise<RawInvokeResult> {
    return new Promise((resolve) => {
      if (this.current !== undefined) { resolve({ kind: "protocol_error", reason: "overlapping_invoke" }); return; }
      if (this.exit !== undefined) { resolve(this.exitResult(this.exit)); return; }
      if (this.protocolError !== undefined) { resolve({ kind: "protocol_error", reason: this.protocolError }); return; }
      const current: Current = { input, timer: undefined, resolve };
      this.current = current;
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
  }

  /** SIGKILLs the docker client. */
  killClient(): void {
    this.process.kill();
  }

  private exitResult(exit: SandboxExit): RawInvokeResult {
    return { kind: "exit", exit, sawFrames: this.framesSeen > 0, ...(this.fatalMessage === undefined ? {} : { fatal: this.fatalMessage }) };
  }

  private onStdout(chunk: Buffer): void {
    if (this.protocolError !== undefined) return;
    let frames: AgentFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.protocolError = error instanceof CodecError ? error.reason : "bad_stream";
      this.process.kill();
      this.finish({ kind: "protocol_error", reason: this.protocolError });
      return;
    }
    for (const frame of frames) {
      this.framesSeen += 1;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: AgentFrame): void {
    switch (frame.type) {
      case "hello":
        if (frame.proto !== AGENT_PROTOCOL) {
          this.protocolError = "bad_protocol";
          this.process.kill();
          this.finish({ kind: "protocol_error", reason: this.protocolError });
        }
        return;
      case "ready":
        this.readyAtMs ??= this.options.now();
        this.initDurationMs = frame.initDurationMs;
        this.initLogTail = frame.logTail;
        return;
      case "init_error":
        this.startupInitError ??= frame;
        return;
      case "runtime_exit":
        if (this.current === undefined) { this.runtimeExited = true; this.options.onRuntimeExit?.(); }
        return;
      case "fatal":
        this.fatalMessage = frame.message.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300);
        return;
      case "result":
        if (this.current === undefined || frame.requestId !== this.current.input.requestId) return;
        this.finish({ kind: "result", result: frame });
        return;
    }
  }

  /** Ends the invoke in flight, once. */
  private finish(result: RawInvokeResult): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    if (current.timer !== undefined) clearTimeout(current.timer);
    current.resolve(result);
  }
}
