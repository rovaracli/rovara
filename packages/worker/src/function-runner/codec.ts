// The framing between the worker's sandbox controller and the agent that runs as PID 1 inside a function sandbox (slice 4, lane W1). It follows lane A1's spec exactly: rovara-local-aws `runner/agent/PROTOCOL.md`
// ("agent/1", rovara/fn-agent e2cd13d0d). The bytes travel over the stdin and stdout of the worker's `docker run -i`. The codec stays behind an interface so a later protocol revision touches this file only.
//
// A frame is a 4-byte big-endian unsigned length N (2 to 16 MiB) followed by N bytes of one UTF-8 JSON object with a string `type`; binary data is base64 (standard alphabet, padded); field names are camelCase.
//   worker to agent: `invoke` (one per call; the agent runs one at a time) and `shutdown`.
//   agent to worker: `hello` (first), `ready` / `init_error` (the runtime came up or did not, before any invoke), `runtime_exit` (the runtime died idle), `result` (exactly one per invoke) and `fatal`.
// The agent takes no init frame: the function's environment (the reserved AWS_LAMBDA_* variables, _HANDLER, the function's own variables) is the sandbox's own environment, set by `docker run -e` (sandbox-spec.ts).
// Stdout carries frames and nothing else; the agent captures the function's output into `logTail`.

export const AGENT_PROTOCOL = "agent/1";
/** The agent's frame cap: a 6 MiB payload as base64 plus the envelope. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MIN_FRAME_BYTES = 2;
/** Lambda's invoke payload and response limit, as the agent enforces it (decoded bytes). */
export const MAX_PAYLOAD_BYTES = 6_291_556;
export const REQUEST_ID = /^[A-Za-z0-9\-_.:]{1,128}$/u;

export type InvokeFrame = {
  type: "invoke";
  requestId: string;
  /** The event, base64. */
  payload: string;
  timeoutMs: number;
  functionArn?: string;
  traceId?: string;
  clientContext?: string;
  cognitoIdentity?: string;
  functionVersion?: string;
  memorySizeMb?: number;
  /** Size of the returned `logTail` in bytes. */
  logBytes?: number;
};

export type WorkerFrame = InvokeFrame | { type: "shutdown" };

export type ResultStatus = "ok" | "function_error" | "init_error" | "timeout" | "crash" | "rejected";
const STATUSES: readonly string[] = ["ok", "function_error", "init_error", "timeout", "crash", "rejected"];

export interface ResultFrame {
  type: "result";
  requestId: string;
  status: ResultStatus;
  /** Base64: the response body (`ok`), or the error document. */
  payload?: string;
  errorType?: string;
  errorMessage?: string;
  /** This invoke's log: START, the runtime's output, END, REPORT. */
  logTail?: string;
  logTruncated?: boolean;
  durationMs?: number;
  billedDurationMs?: number;
  initDurationMs?: number;
  /** Bytes. The agent's own sampling of resident memory; the host's cgroup `memory.peak` is better when readable. */
  maxMemoryUsed?: number;
}

export type AgentFrame =
  | { type: "hello"; proto: string; agent?: string; version?: string }
  | { type: "ready"; initDurationMs?: number; logTail?: string }
  | { type: "init_error"; reason?: string; errorType?: string; errorMessage?: string; payload?: string; logTail?: string; initDurationMs?: number }
  | { type: "runtime_exit"; exitCode?: number; signal?: string; message?: string; logTail?: string }
  | ResultFrame
  | { type: "fatal"; message: string };

export class CodecError extends Error {
  constructor(readonly reason: "frame_too_large" | "bad_json" | "bad_frame" | "bad_length") {
    super(`agent frame refused: ${reason}`);
  }
}

export interface FrameDecoder {
  /** Feeds bytes; returns the frames now complete. Throws CodecError on a bad length, an oversized or malformed frame, or a type this version does not know: the stream is then unusable and the sandbox must be ended. */
  push(chunk: Buffer): AgentFrame[];
  /** What is held for a frame that is not complete yet: bytes, and how many buffers they sit in. */
  pending(): { bytes: number; chunks: number };
}

export interface AgentCodec {
  /** Throws RangeError when the frame would exceed the agent's cap. */
  encode(frame: WorkerFrame): Buffer;
  createDecoder(options?: { maxFrameBytes?: number }): FrameDecoder;
}

// ---- field limits. A function can write frames straight onto the agent's stdout, so every field is untrusted: types are checked, text is cleaned and capped, base64 is checked and its decoded size capped.
export const MAX_ERROR_TYPE_CHARS = 256;
export const MAX_ERROR_MESSAGE_CHARS = 4_096;
export const MAX_LOG_TAIL_CHARS = 256 * 1024;
export const MAX_SHORT_TEXT_CHARS = 512;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const CONTROL_EXCEPT_LINES = /[^\P{Cc}\n\t]|\p{Cf}/gu;

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 1e9;
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const absent = (value: unknown): boolean => value === undefined || value === null;

/** One-line text: control and format characters become spaces, then it is cut to `max` UTF-16 units. */
export const cleanLine = (text: string, max: number): string => (text.length > max * 2 ? text.slice(0, max * 2) : text).replace(CONTROL, " ").slice(0, max);
/** Log text: newlines and tabs stay; other control and format characters become spaces. */
export const cleanLog = (text: string, max: number): string => text.slice(-max).replace(CONTROL_EXCEPT_LINES, " ");

/** Base64 whose decoded size is within the Lambda payload limit. Checked on length first, so a huge hostile string costs one comparison. */
function payloadOf(value: unknown): string | undefined {
  if (absent(value)) return undefined;
  if (!isString(value) || value.length > Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 4 || value.length % 4 !== 0 || !BASE64.test(value)) throw new CodecError("bad_frame");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_PAYLOAD_BYTES) throw new CodecError("bad_frame");
  return value;
}

function text(frame: Record<string, unknown>, name: string, max: number, log = false): string | undefined {
  const value = frame[name];
  if (absent(value)) return undefined;
  if (!isString(value)) throw new CodecError("bad_frame");
  return log ? cleanLog(value, max) : cleanLine(value, max);
}
function num(frame: Record<string, unknown>, name: string, check: (v: unknown) => boolean = isCount): number | undefined {
  const value = frame[name];
  if (absent(value)) return undefined;
  if (!check(value)) throw new CodecError("bad_frame");
  return value as number;
}
const defined = (fields: Record<string, unknown>): object => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/** Checks and cleans one decoded object against the agent frames above. Throws CodecError for anything else, including a type this version does not know. */
export function parseAgentFrame(value: unknown): AgentFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodecError("bad_frame");
  const frame = value as Record<string, unknown>;
  switch (frame["type"]) {
    case "hello":
      if (!isString(frame["proto"])) throw new CodecError("bad_frame");
      return { type: "hello", proto: cleanLine(frame["proto"], 64), ...defined({ agent: text(frame, "agent", 64), version: text(frame, "version", 64) }) };
    case "ready":
      return { type: "ready", ...defined({ logTail: text(frame, "logTail", MAX_LOG_TAIL_CHARS, true), initDurationMs: num(frame, "initDurationMs") }) };
    case "init_error":
      return {
        type: "init_error",
        ...defined({
          reason: text(frame, "reason", 64), errorType: text(frame, "errorType", MAX_ERROR_TYPE_CHARS), errorMessage: text(frame, "errorMessage", MAX_ERROR_MESSAGE_CHARS), payload: payloadOf(frame["payload"]),
          logTail: text(frame, "logTail", MAX_LOG_TAIL_CHARS, true), initDurationMs: num(frame, "initDurationMs"),
        }),
      };
    case "runtime_exit":
      return { type: "runtime_exit", ...defined({ signal: text(frame, "signal", 64), message: text(frame, "message", MAX_SHORT_TEXT_CHARS), logTail: text(frame, "logTail", MAX_LOG_TAIL_CHARS, true), exitCode: num(frame, "exitCode", isInt) }) };
    case "fatal":
      if (!isString(frame["message"])) throw new CodecError("bad_frame");
      return { type: "fatal", message: cleanLine(frame["message"], MAX_SHORT_TEXT_CHARS) };
    case "result": {
      if (!isString(frame["requestId"]) || !REQUEST_ID.test(frame["requestId"]) || !isString(frame["status"]) || !STATUSES.includes(frame["status"])) throw new CodecError("bad_frame");
      const logTruncated = frame["logTruncated"];
      if (!absent(logTruncated) && !isBool(logTruncated)) throw new CodecError("bad_frame");
      return {
        type: "result", requestId: frame["requestId"], status: frame["status"] as ResultStatus,
        ...defined({
          payload: payloadOf(frame["payload"]), errorType: text(frame, "errorType", MAX_ERROR_TYPE_CHARS), errorMessage: text(frame, "errorMessage", MAX_ERROR_MESSAGE_CHARS), logTail: text(frame, "logTail", MAX_LOG_TAIL_CHARS, true),
          logTruncated: absent(logTruncated) ? undefined : (logTruncated), durationMs: num(frame, "durationMs"), billedDurationMs: num(frame, "billedDurationMs"), initDurationMs: num(frame, "initDurationMs"), maxMemoryUsed: num(frame, "maxMemoryUsed"),
        }),
      };
    }
    default:
      // A type this version does not know is a protocol violation, not something to skip: a hostile function can write to the agent's stdout.
      throw new CodecError("bad_frame");
  }
}

const COMPACT_AT = 64;
const SMALL_CHUNK = 4_096;

export const lengthPrefixedJsonCodec: AgentCodec = {
  encode(frame) {
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    if (body.length > MAX_FRAME_BYTES) throw new RangeError("the frame is larger than the agent accepts");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  },
  createDecoder(options = {}) {
    const maxFrameBytes = Math.min(MAX_FRAME_BYTES, options.maxFrameBytes ?? MAX_FRAME_BYTES);
    // Chunks are kept in a list with a running length and joined ONCE per complete frame: re-joining the whole buffer on every chunk is quadratic (a 16 MiB frame in 64 KiB chunks cost 600 ms of event-loop time).
    // A trickle of tiny chunks would instead leave millions of small Buffers (hundreds of bytes of overhead each), so the run of small chunks at the tail is merged whenever the list passes COMPACT_AT entries: memory stays
    // proportional to the bytes held, and the copying is bounded by the size of the run being merged.
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
      push(chunk) {
        if (chunk.length > 0) { chunks.push(chunk); total += chunk.length; compact(); }
        const frames: AgentFrame[] = [];
        for (;;) {
          const length = header();
          if (length === undefined) break;
          // Refuse on the header alone: a hostile length must never make the controller wait for, or buffer, that many bytes.
          if (length > maxFrameBytes) throw new CodecError("frame_too_large");
          if (length < MIN_FRAME_BYTES) throw new CodecError("bad_length");
          if (total < 4 + length) break;
          const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
          let parsed: unknown;
          try {
            parsed = JSON.parse(joined.subarray(4, 4 + length).toString("utf8"));
          } catch {
            throw new CodecError("bad_json");
          }
          const rest = joined.subarray(4 + length);
          chunks = rest.length === 0 ? [] : [rest];
          total = rest.length;
          need = undefined;
          frames.push(parseAgentFrame(parsed));
        }
        return frames;
      },
    };
  },
};
