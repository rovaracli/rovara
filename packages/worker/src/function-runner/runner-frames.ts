// The runner/2 frames between the Rovara front (Go, in the local-aws helper) and the worker's runner client (slice 4, lane W3). The spec is the header of rovara-local-aws `front/runner_proto.go` (rovara/s4-front 8a6d3dee3);
// this file is its worker-side half: the framing, the shapes of the front's frames (checked as hostile input) and the shapes of ours.
//
// Framing is agent/1's: a 4-byte big-endian unsigned length N (2 to 16 MiB), then N bytes of one UTF-8 JSON object with a string `type`. Binary data is base64 (standard alphabet, padded); field names are camelCase.
// A frame whose type this version does not know is IGNORED (both sides do that, so the protocol can grow). A bad length, bytes that are not a JSON object with a type, or a known type whose fields do not parse is a PROTOCOL ERROR:
// the receiver sends `error` when it can and closes the stream.
// The front is a program in a container that runs the customer's repository tests next to it, so every field of every frame it sends is checked here: types, shapes, sizes. Nothing it says is a path, an argument or a command.

export const RUNNER_PROTOCOL = "runner/2";
export const MAX_RUNNER_FRAME_BYTES = 16 * 1024 * 1024;
export const MIN_RUNNER_FRAME_BYTES = 2;
/** The front streams a package in raw chunks of at most this many bytes. */
export const RUNNER_CHUNK_BYTES = 512 * 1024;
/** Lambda's invoke and response limit (decoded bytes), as the agent enforces it. */
export const RUNNER_MAX_PAYLOAD_BYTES = 6_291_556;
/** The most packages (a function's zip and its layers) one registration names: Lambda's five layers and the function. */
export const RUNNER_MAX_PACKAGES = 6;

export class RunnerFrameError extends Error {
  constructor(readonly reason: "bad_length" | "frame_too_large" | "bad_json" | "not_object" | "bad_frame") {
    // Never echoes bytes of the frame.
    super(`runner frame refused: ${reason}`);
    this.name = "RunnerFrameError";
  }
}

/** One decoded frame of the stream: its type and its JSON object. The fields are NOT checked yet (see `parseRegister` and the other parsers). */
export interface RawFrame {
  type: string;
  body: Readonly<Record<string, unknown>>;
}

export interface RunnerFrameDecoder {
  /** Feeds bytes; returns the frames now complete. Throws RunnerFrameError on a bad length, an oversized or malformed frame: the stream is then unusable. */
  push(chunk: Buffer): RawFrame[];
  /** What is held for a frame that is not complete yet. */
  pending(): { bytes: number; chunks: number };
  /** True when the stream may end here (no partial frame is held). */
  atBoundary(): boolean;
}

const COMPACT_AT = 64;
const SMALL_CHUNK = 4_096;

export function encodeRunnerFrame(frame: object): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > MAX_RUNNER_FRAME_BYTES || body.length < MIN_RUNNER_FRAME_BYTES) throw new RangeError("the frame is not a size the runner protocol carries");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createRunnerFrameDecoder(maxFrameBytes = MAX_RUNNER_FRAME_BYTES): RunnerFrameDecoder {
  const cap = Math.min(MAX_RUNNER_FRAME_BYTES, maxFrameBytes);
  // Chunks are kept in a list with a running length and joined once per complete frame (a 16 MiB frame in 64 KiB chunks must not cost a quadratic copy); a trickle of tiny chunks is merged so memory stays proportional to the bytes held.
  let chunks: Buffer[] = [];
  let total = 0;
  let need: number | undefined;
  const compact = (): void => {
    if (chunks.length <= COMPACT_AT) return;
    let from = chunks.length;
    while (from > 0 && chunks[from - 1]!.length < SMALL_CHUNK) from -= 1;
    if (chunks.length - from < 2) return;
    chunks = [...chunks.slice(0, from), Buffer.concat(chunks.slice(from))];
  };
  const header = (): number | undefined => {
    if (need !== undefined) return need;
    if (total < 4) return undefined;
    const bytes = Buffer.alloc(4);
    let filled = 0;
    for (const chunk of chunks) {
      filled += chunk.copy(bytes, filled, 0, Math.min(chunk.length, 4 - filled));
      if (filled === 4) break;
    }
    need = bytes.readUInt32BE(0);
    return need;
  };
  return {
    pending: () => ({ bytes: total, chunks: chunks.length }),
    atBoundary: () => total === 0,
    push(chunk) {
      if (chunk.length > 0) { chunks.push(chunk); total += chunk.length; compact(); }
      const frames: RawFrame[] = [];
      for (;;) {
        const length = header();
        if (length === undefined) break;
        // Refused on the header alone: a hostile length must never make the client wait for, or buffer, that many bytes.
        if (length > cap) throw new RunnerFrameError("frame_too_large");
        if (length < MIN_RUNNER_FRAME_BYTES) throw new RunnerFrameError("bad_length");
        if (total < 4 + length) break;
        const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
        let parsed: unknown;
        try {
          parsed = JSON.parse(joined.subarray(4, 4 + length).toString("utf8"));
        } catch {
          throw new RunnerFrameError("bad_json");
        }
        const rest = joined.subarray(4 + length);
        chunks = rest.length === 0 ? [] : [rest];
        total = rest.length;
        need = undefined;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new RunnerFrameError("not_object");
        const type = (parsed as Record<string, unknown>)["type"];
        if (typeof type !== "string" || type === "") throw new RunnerFrameError("not_object");
        frames.push({ type, body: parsed as Record<string, unknown> });
      }
      return frames;
    },
  };
}

// ---- the front's frames, checked

/** A request id the front made (a UUID): plain characters, so it is safe to echo and to use as a map key. */
export const RUNNER_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const FUNCTION_NAME = /^[A-Za-z0-9_.:-]{1,140}$/u;
const FUNCTION_VERSION = /^(?:\$LATEST|[0-9]{1,10})$/u;
const RUNTIME = /^[a-z0-9.]{1,32}$/u;
const REGION = /^[a-z0-9-]{1,32}$/u;
const NO_CONTROL = /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;
const MAX_ENV_ENTRIES = 1_000;
const MAX_ENV_TEXT = 128 * 1024;

export class ProtocolViolation extends Error {
  constructor(readonly reason: string) {
    super(`runner protocol violation: ${reason}`);
    this.name = "ProtocolViolation";
  }
}
const violation = (reason: string): never => { throw new ProtocolViolation(reason); };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function str(body: Record<string, unknown>, name: string, pattern: RegExp, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) return violation(`field ${name}`);
  return value;
}
function optionalStr(body: Record<string, unknown>, name: string, max: number): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max || !NO_CONTROL.test(value)) return violation(`field ${name}`);
  return value;
}

export function frameId(body: Readonly<Record<string, unknown>>): string {
  return str(body, "id", RUNNER_ID, 64);
}

export interface PackageRef {
  arn?: string;
  sha256: string;
  sizeBytes: number;
}

/** One function version as the front registers it. Types and shapes are checked here; whether the function can run (runtime, memory, environment names) is for the controller and the registration. */
export interface RegisteredFunction {
  name: string;
  version: string;
  arn: string;
  runtime: string;
  handler: string;
  memoryMb: number;
  timeoutSeconds: number;
  ephemeralMb: number;
  env: Record<string, string>;
  region: string;
  architectures: string[];
  packageType: "Zip" | "Image";
  imageUri?: string;
  package?: PackageRef;
  layers: PackageRef[];
  configHash: string;
}

function packageRef(value: unknown): PackageRef {
  if (!isRecord(value)) return violation("package reference");
  const ref: PackageRef = { sha256: str(value, "sha256", SHA256, 64), sizeBytes: 0 };
  const size = value["sizeBytes"];
  if (!isInt(size) || size < 0 || size > 1e12) return violation("package size");
  ref.sizeBytes = size;
  const arn = optionalStr(value, "arn", 512);
  if (arn !== undefined) ref.arn = arn;
  return ref;
}

export function parseRegister(body: Readonly<Record<string, unknown>>): { id: string; fn: RegisteredFunction } {
  const id = frameId(body);
  const raw = body["fn"];
  if (!isRecord(raw)) return violation("register fn");
  const ints = (name: string): number => {
    const value = raw[name];
    return isInt(value) && value >= 0 && value <= 1e9 ? value : violation(`fn ${name}`);
  };
  const envRaw = raw["env"];
  const env: Record<string, string> = {};
  if (envRaw !== undefined && envRaw !== null) {
    if (!isRecord(envRaw)) return violation("fn env");
    const entries = Object.entries(envRaw);
    if (entries.length > MAX_ENV_ENTRIES) return violation("fn env size");
    let text = 0;
    for (const [key, value] of entries) {
      if (typeof value !== "string") return violation("fn env value");
      text += key.length + value.length;
      if (text > MAX_ENV_TEXT) return violation("fn env size");
      env[key] = value;
    }
  }
  const archesRaw = raw["architectures"];
  const architectures: string[] = [];
  if (archesRaw !== undefined && archesRaw !== null) {
    if (!Array.isArray(archesRaw) || archesRaw.length > 4) return violation("fn architectures");
    for (const arch of archesRaw) {
      if (typeof arch !== "string" || !/^[a-z0-9_]{1,16}$/u.test(arch)) return violation("fn architectures");
      architectures.push(arch);
    }
  }
  const packageType = raw["packageType"];
  if (packageType !== "Zip" && packageType !== "Image") return violation("fn packageType");
  const layersRaw = raw["layers"];
  const layers: PackageRef[] = [];
  if (layersRaw !== undefined && layersRaw !== null) {
    if (!Array.isArray(layersRaw) || layersRaw.length > RUNNER_MAX_PACKAGES) return violation("fn layers");
    for (const layer of layersRaw) layers.push(packageRef(layer));
  }
  const fn: RegisteredFunction = {
    name: str(raw, "name", FUNCTION_NAME, 140),
    version: str(raw, "version", FUNCTION_VERSION, 11),
    arn: str(raw, "arn", NO_CONTROL, 512),
    runtime: raw["runtime"] === "" || raw["runtime"] === undefined ? "" : str(raw, "runtime", RUNTIME, 32),
    handler: str(raw, "handler", NO_CONTROL, 256),
    memoryMb: ints("memoryMb"),
    timeoutSeconds: ints("timeoutSeconds"),
    ephemeralMb: ints("ephemeralMb"),
    env,
    region: str(raw, "region", REGION, 32),
    architectures,
    packageType,
    layers,
    configHash: str(raw, "configHash", NO_CONTROL, 128),
  };
  const imageUri = optionalStr(raw, "imageUri", 1024);
  if (imageUri !== undefined) fn.imageUri = imageUri;
  if (raw["package"] !== undefined && raw["package"] !== null) fn.package = packageRef(raw["package"]);
  return { id, fn };
}

export interface PackageHeader {
  id: string;
  sha256: string;
  kind: "function" | "layer";
  sizeBytes: number;
}

export function parsePackage(body: Readonly<Record<string, unknown>>): PackageHeader {
  const b = body as Record<string, unknown>;
  const kind = b["kind"];
  const size = b["sizeBytes"];
  if ((kind !== "function" && kind !== "layer") || !isInt(size) || size < 1 || size > 1e12) return violation("package header");
  return { id: frameId(body), sha256: str(b, "sha256", SHA256, 64), kind, sizeBytes: size };
}

export interface ChunkFrame {
  id: string;
  sha256: string;
  seq: number;
  data: Buffer;
  last: boolean;
}

export function parseChunk(body: Readonly<Record<string, unknown>>): ChunkFrame {
  const b = body as Record<string, unknown>;
  const seq = b["seq"];
  const data = b["data"];
  const last = b["last"];
  if (!isInt(seq) || seq < 0 || seq > 1e9 || typeof last !== "boolean" || typeof data !== "string") return violation("chunk");
  // Checked on length first (a hostile string costs one comparison), then on shape: standard padded base64 and nothing else.
  if (data.length > Math.ceil((RUNNER_CHUNK_BYTES * 4) / 3) + 8 || data.length % 4 !== 0 || !BASE64.test(data)) return violation("chunk data");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > RUNNER_CHUNK_BYTES) return violation("chunk size");
  if (bytes.length === 0 && !last) return violation("empty chunk");
  return { id: frameId(body), sha256: str(b, "sha256", SHA256, 64), seq, data: bytes, last };
}

export interface InvokeRequestFrame {
  id: string;
  name: string;
  version: string;
  requestId: string;
  /** Base64, checked for shape; the decoded size is the client's to check. */
  payload: string;
  timeoutMs: number;
  functionArn?: string;
  traceId?: string;
  clientContext?: string;
  cognitoIdentity?: string;
  logBytes?: number;
  source: string;
}

export function parseInvoke(body: Readonly<Record<string, unknown>>): InvokeRequestFrame {
  const b = body as Record<string, unknown>;
  const timeout = b["timeoutMs"];
  const payload = b["payload"];
  if (!isInt(timeout) || typeof payload !== "string") return violation("invoke");
  const out: InvokeRequestFrame = {
    id: frameId(body),
    name: str(b, "name", FUNCTION_NAME, 140),
    version: str(b, "version", FUNCTION_VERSION, 11),
    requestId: str(b, "requestId", /^.{0,256}$/su, 256),
    payload,
    timeoutMs: timeout,
    source: str(b, "source", /^[a-z]{1,16}$/u, 16),
  };
  for (const name of ["functionArn", "traceId", "clientContext", "cognitoIdentity"] as const) {
    const value = optionalStr(b, name, name === "clientContext" ? 16_384 : 2_048);
    if (value !== undefined) out[name] = value;
  }
  const logBytes = b["logBytes"];
  if (logBytes !== undefined && logBytes !== null) {
    if (!isInt(logBytes) || logBytes < 0) return violation("invoke logBytes");
    out.logBytes = logBytes;
  }
  return out;
}

export function parseUnregister(body: Readonly<Record<string, unknown>>): { id: string; name: string; version?: string } {
  const b = body as Record<string, unknown>;
  const version = b["version"];
  const out: { id: string; name: string; version?: string } = { id: frameId(body), name: str(b, "name", FUNCTION_NAME, 140) };
  if (version !== undefined && version !== null && version !== "") out.version = str(b, "version", FUNCTION_VERSION, 11);
  return out;
}

export function parseHello(body: Readonly<Record<string, unknown>>): { proto: string; front?: string; version?: string } {
  const b = body as Record<string, unknown>;
  const out: { proto: string; front?: string; version?: string } = { proto: str(b, "proto", NO_CONTROL, 64) };
  const front = optionalStr(b, "front", 64);
  const version = optionalStr(b, "version", 64);
  if (front !== undefined) out.front = front;
  if (version !== undefined) out.version = version;
  return out;
}

/** Strict base64 of at most `maxBytes` decoded bytes; undefined for anything else. */
export function decodeBase64(value: string, maxBytes: number): Buffer | undefined {
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4 || value.length % 4 !== 0 || !BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > maxBytes ? undefined : bytes;
}

// ---- our frames

export interface WorkerHello { type: "hello"; proto: typeof RUNNER_PROTOCOL; worker: string; version: string; runtimes?: string[] }
export interface NeedFrame { type: "need"; id: string; packages: string[] }
export interface RegisteredFrame { type: "registered"; id: string; ok: boolean; error?: { type: string; message: string } }
export type RunnerResultStatus = "ok" | "function_error" | "init_error" | "timeout" | "crash" | "rejected" | "throttled" | "unavailable";
export interface RunnerResultFrame {
  type: "result";
  id: string;
  status: RunnerResultStatus;
  reason?: string;
  detail?: string;
  payload?: string;
  errorType?: string;
  errorMessage?: string;
  logTail?: string;
  logTruncated?: boolean;
  durationMs?: number;
  billedDurationMs?: number;
  initDurationMs?: number;
  maxMemoryUsed?: number;
  cold?: boolean;
  memoryClamped?: boolean;
}
export interface UnregisteredFrame { type: "unregistered"; id: string }
export interface StoppedFrame { type: "stopped"; id: string }
export interface ErrorFrame { type: "error"; id?: string; message: string }
export type WorkerRunnerFrame = WorkerHello | NeedFrame | RegisteredFrame | RunnerResultFrame | UnregisteredFrame | StoppedFrame | ErrorFrame;
