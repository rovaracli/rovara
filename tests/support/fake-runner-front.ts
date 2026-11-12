// A fake front for the runner client's tests (slice 4, lane W3): it speaks runner/2 from the front's side over an in-memory pipe, and a scripted sandbox controller sits behind the client. Nothing starts a process.
import { createHash } from "node:crypto";
import type { FunctionConfig, FunctionKey, InvokeOutcome, InvokeRequest, SandboxController } from "../../packages/worker/src/function-runner/controller.js";
import { createRunnerFrameDecoder, encodeRunnerFrame, RUNNER_CHUNK_BYTES, type RawFrame } from "../../packages/worker/src/function-runner/runner-frames.js";
import type { PipeExit, PipeProcess } from "../../packages/worker/src/function-runner/runner-pipe.js";

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const b64 = (text: string): string => Buffer.from(text).toString("base64");

export class FakePipe implements PipeProcess {
  readonly received: RawFrame[] = [];
  readonly written: Buffer[] = [];
  paused = 0;
  resumed = 0;
  ended = false;
  killed = false;
  private readonly decoder = createRunnerFrameDecoder();
  private stdout: Array<(chunk: Buffer) => void> = [];
  private resolveExit!: (exit: PipeExit) => void;
  readonly exited = new Promise<PipeExit>((resolve) => { this.resolveExit = resolve; });
  private waiters: Array<() => void> = [];
  write(data: Buffer): Promise<void> {
    if (this.killed) return Promise.reject(new Error("closed"));
    this.written.push(data);
    for (const frame of this.decoder.push(data)) this.received.push(frame);
    for (const waiter of this.waiters.splice(0)) waiter();
    return Promise.resolve();
  }
  onStdout(listener: (chunk: Buffer) => void): void { this.stdout.push(listener); }
  onStderr(): void { /* nothing */ }
  pause(): void { this.paused += 1; }
  resume(): void { this.resumed += 1; }
  end(): void { this.ended = true; this.resolveExit({ code: 0, signal: null }); }
  kill(): void { this.killed = true; this.resolveExit({ code: null, signal: "SIGKILL" }); }
  /** The front sends a frame. */
  send(frame: object): void { this.raw(encodeRunnerFrame(frame)); }
  raw(bytes: Buffer): void { for (const listener of this.stdout) listener(bytes); }
  /** The front's process dies. */
  die(): void { this.resolveExit({ code: 1, signal: null }); }
  ofType(type: string): Array<Record<string, unknown>> { return this.received.filter((frame) => frame.type === type).map((frame) => frame.body as Record<string, unknown>); }
  async waitFor(predicate: (frames: RawFrame[]) => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate(this.received)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting; saw ${this.received.map((frame) => frame.type).join(",")}`);
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 10); });
    }
  }
  async next(type: string, count = 1): Promise<Record<string, unknown>> {
    await this.waitFor((frames) => frames.filter((frame) => frame.type === type).length >= count);
    return this.ofType(type)[count - 1]!;
  }
}

let counter = 0;
export const nextId = (): string => `id-${String((counter += 1))}`;

export interface FnOptions {
  name?: string;
  version?: string;
  runtime?: string;
  packageType?: "Zip" | "Image";
  memoryMb?: number;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  architectures?: string[];
  pkg?: Uint8Array | undefined;
  layers?: Uint8Array[];
  configHash?: string;
}

/** A register frame body for a function whose package (and layers) are the given zips. */
export function registerFrame(options: FnOptions = {}, id = nextId()): { frame: Record<string, unknown>; id: string; pkg: Uint8Array | undefined; layers: Uint8Array[] } {
  const layers = options.layers ?? [];
  const ref = (bytes: Uint8Array): Record<string, unknown> => ({ sha256: sha256(bytes), sizeBytes: bytes.length });
  const fn: Record<string, unknown> = {
    name: options.name ?? "resize", version: options.version ?? "$LATEST", arn: `arn:aws:lambda:us-east-1:000000000000:function:${options.name ?? "resize"}`, runtime: options.runtime ?? "python3.12", handler: "app.handler",
    memoryMb: options.memoryMb ?? 256, timeoutSeconds: options.timeoutSeconds ?? 10, ephemeralMb: 512, env: options.env ?? { STAGE: "test" }, region: "us-east-1", architectures: options.architectures ?? ["arm64"],
    packageType: options.packageType ?? "Zip", layers: layers.map(ref), configHash: options.configHash ?? `hash-${String((counter += 1))}`,
  };
  if (options.pkg !== undefined) fn["package"] = ref(options.pkg);
  return { frame: { type: "register", id, fn }, id, pkg: options.pkg, layers };
}

export function packageFrames(id: string, bytes: Uint8Array, kind: "function" | "layer", chunk = RUNNER_CHUNK_BYTES): object[] {
  const digest = sha256(bytes);
  const out: object[] = [{ type: "package", id, sha256: digest, kind, sizeBytes: bytes.length }];
  const buffer = Buffer.from(bytes);
  for (let at = 0, seq = 0; ; seq += 1) {
    const part = buffer.subarray(at, at + chunk);
    at += part.length;
    const last = at >= buffer.length;
    out.push({ type: "chunk", id, sha256: digest, seq, data: part.toString("base64"), last });
    if (last) break;
  }
  return out;
}

export interface FakeControllerOptions {
  outcome?: (request: InvokeRequest) => InvokeOutcome | Promise<InvokeOutcome>;
  registerError?: Error;
}

const detail = { environmentId: "env-1", cold: true, wallMs: 12, memoryMb: 256, memoryClamped: false, logTail: "START\nEND\n", logsTruncated: false } as const;
export const okOutcome = (payload: string, extra: Record<string, unknown> = {}): InvokeOutcome => ({ kind: "response", payload: Buffer.from(payload), ...detail, ...extra });

export interface FakeController extends SandboxController {
  registered: Map<string, FunctionConfig>;
  registerCalls: Array<{ key: FunctionKey; config: FunctionConfig }>;
  invokes: InvokeRequest[];
  stopped: FunctionKey[];
  stopAllCalls: number;
  /** While set, stopFunction waits for it. */
  stopGate: Promise<void> | undefined;
  stopResult: boolean;
}

export function fakeController(options: FakeControllerOptions = {}): FakeController {
  const registered = new Map<string, FunctionConfig>();
  const self: FakeController = {
    registered, registerCalls: [], invokes: [], stopped: [], stopAllCalls: 0, stopGate: undefined, stopResult: true,
    register(key, config) {
      if (options.registerError !== undefined) return Promise.reject(options.registerError);
      self.registerCalls.push({ key, config });
      registered.set(`${key.functionName}\0${key.version}`, config);
      return Promise.resolve();
    },
    async invoke(request) {
      self.invokes.push(request);
      if (!registered.has(`${request.key.functionName}\0${request.key.version}`)) return { kind: "unavailable", reason: "not_registered" };
      return options.outcome === undefined ? okOutcome(Buffer.from(request.payload).toString()) : options.outcome(request);
    },
    async stopFunction(key) {
      if (self.stopGate !== undefined) await self.stopGate;
      if (!self.stopResult) return false;
      self.stopped.push(key);
      registered.delete(`${key.functionName}\0${key.version}`);
      return true;
    },
    stopAll() { self.stopAllCalls += 1; registered.clear(); return Promise.resolve(true); },
    reap: () => Promise.resolve(0),
    stats: () => ({ environments: registered.size, idle: registered.size, busy: 0, stopping: 0, reservedMiB: 0, budgetMiB: 1_024 }),
    metrics: () => ({ total: {} as never, functions: [] }),
  };
  return self;
}
