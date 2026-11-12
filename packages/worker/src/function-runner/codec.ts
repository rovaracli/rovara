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
  /** Feeds bytes; returns the known frames now complete (a frame of an unknown `type` is skipped, as the agent skips unknown worker frames). Throws CodecError on a bad length, oversized or malformed frame: the stream is then unusable. */
  push(chunk: Buffer): AgentFrame[];
}

export interface AgentCodec {
  /** Throws RangeError when the frame would exceed the agent's cap. */
  encode(frame: WorkerFrame): Buffer;
  createDecoder(options?: { maxFrameBytes?: number }): FrameDecoder;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || value === null || check(value);
/** Copies the listed optional fields, dropping null and undefined; false when one has the wrong type. */
function pick(frame: Record<string, unknown>, strings: readonly string[], numbers: readonly string[], booleans: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [names, check] of [[strings, isString], [numbers, isNumber], [booleans, (v: unknown) => typeof v === "boolean"]] as const) {
    for (const name of names) {
      const value = frame[name];
      if (!optional(value, check)) throw new CodecError("bad_frame");
      if (value !== undefined && value !== null) out[name] = value;
    }
  }
  return out;
}

/** Checks one decoded object against the agent frames above. Returns undefined for a type this version does not know. */
export function parseAgentFrame(value: unknown): AgentFrame | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodecError("bad_frame");
  const frame = value as Record<string, unknown>;
  switch (frame["type"]) {
    case "hello":
      if (!isString(frame["proto"])) throw new CodecError("bad_frame");
      return { type: "hello", proto: frame["proto"], ...pick(frame, ["agent", "version"], []) };
    case "ready":
      return { type: "ready", ...pick(frame, ["logTail"], ["initDurationMs"]) };
    case "init_error":
      return { type: "init_error", ...pick(frame, ["reason", "errorType", "errorMessage", "payload", "logTail"], ["initDurationMs"]) };
    case "runtime_exit":
      return { type: "runtime_exit", ...pick(frame, ["signal", "message", "logTail"], ["exitCode"]) };
    case "fatal":
      if (!isString(frame["message"])) throw new CodecError("bad_frame");
      return { type: "fatal", message: frame["message"] };
    case "result": {
      if (!isString(frame["requestId"]) || !isString(frame["status"]) || !STATUSES.includes(frame["status"])) throw new CodecError("bad_frame");
      return {
        type: "result", requestId: frame["requestId"], status: frame["status"] as ResultStatus,
        ...pick(frame, ["payload", "errorType", "errorMessage", "logTail"], ["durationMs", "billedDurationMs", "initDurationMs", "maxMemoryUsed"], ["logTruncated"]),
      };
    }
    default:
      if (!isString(frame["type"])) throw new CodecError("bad_frame");
      return undefined;
  }
}

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
    let pending: Buffer = Buffer.alloc(0);
    return {
      push(chunk) {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        const frames: AgentFrame[] = [];
        for (;;) {
          if (pending.length < 4) break;
          const length = pending.readUInt32BE(0);
          // Refuse on the header alone: a hostile length must never make the controller wait for, or buffer, that many bytes.
          if (length > maxFrameBytes) throw new CodecError("frame_too_large");
          if (length < MIN_FRAME_BYTES) throw new CodecError("bad_length");
          if (pending.length < 4 + length) break;
          let parsed: unknown;
          try {
            parsed = JSON.parse(pending.subarray(4, 4 + length).toString("utf8"));
          } catch {
            throw new CodecError("bad_json");
          }
          pending = pending.subarray(4 + length);
          const known = parseAgentFrame(parsed);
          if (known !== undefined) frames.push(known);
        }
        return frames;
      },
    };
  },
};
