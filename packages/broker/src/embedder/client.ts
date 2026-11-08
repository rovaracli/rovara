// The broker's side of the self-hosted embedder (environments/embedder; DECISIONS 23 and 27): one Lambda with two baked-in models, the Team record's
// (Qwen3-Embedding-0.6B, 1,024 dimensions) and the lessons' (bge-small, 384). This file is the port: it checks the request against the same limits the
// function enforces, sends it through `invoke`, and checks the answer before any vector is used or stored. The AWS call itself is `lambdaEmbedderInvoke`
// (team-record/aws-adapters.ts). Nothing here logs or keeps text from an error: every failure is one of the fixed codes below.
import type { EmbedderModelSpec } from "@agentx/contracts";

/** The function's limits (environments/embedder/app/embedder_core.py; tests/unit/embedder/spec.test.ts pins both sides to the same numbers). */
export const EMBEDDER_LIMITS = { maxTexts: 16, maxTextChars: 24_000, maxTotalChars: 96_000 } as const;

export type EmbedderKind = "query" | "document";

/** What the function itself reports (a normal reply with `ok: false`), plus what only this side can see. */
export const EMBEDDER_FUNCTION_CODES = ["BAD_REQUEST", "UNKNOWN_MODEL", "UNKNOWN_KIND", "TOO_MANY_TEXTS", "EMPTY_TEXT", "TEXT_TOO_LONG", "REQUEST_TOO_LARGE", "MODEL_UNAVAILABLE", "INTERNAL"] as const;
export const EMBEDDER_ERROR_CODES = [...EMBEDDER_FUNCTION_CODES, "UNREACHABLE", "BAD_RESPONSE", "SPEC_MISMATCH"] as const;
export type EmbedderErrorCode = (typeof EMBEDDER_ERROR_CODES)[number];

/** A refusal or failure with a fixed code. The message is the code, so it is safe to log. */
export class EmbedderError extends Error {
  constructor(readonly code: EmbedderErrorCode) {
    super(`embedder: ${code}`);
    this.name = "EmbedderError";
  }
}

export interface EmbedderRequest { model: EmbedderModelSpec["model"]; kind: EmbedderKind; texts: string[] }

/** Sends one request to the function and returns its parsed JSON answer. Throws an error whose `code` is the AWS error name (never its message). */
export type EmbedderInvoke = (request: EmbedderRequest) => Promise<unknown>;

export interface EmbedderClient {
  readonly spec: EmbedderModelSpec;
  readonly dimension: number;
  embed(text: string, kind: EmbedderKind): Promise<number[]>;
  /** Any number of texts: split into requests inside the function's limits, in order. */
  embedMany(texts: readonly string[], kind: EmbedderKind): Promise<number[][]>;
}

export interface EmbedderClientOptions {
  invoke: EmbedderInvoke;
  spec: EmbedderModelSpec;
  /** Tries for a transient fault (throttling, a service fault). Default 2: the broker's own budget is 30 s. */
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT_INVOKE = new Set(["TooManyRequestsException", "ServiceException", "ResourceNotReadyException", "EC2ThrottledException"]);
const FUNCTION_CODES: ReadonlySet<string> = new Set(EMBEDDER_FUNCTION_CODES);

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks one answer against what was asked and what this broker expects; returns the vectors or throws a fixed code. */
export function checkEmbedderReply(reply: unknown, spec: EmbedderModelSpec, count: number): number[][] {
  if (!isRecord(reply)) throw new EmbedderError("BAD_RESPONSE");
  if (reply.ok === false) {
    const code = reply.code;
    throw new EmbedderError(typeof code === "string" && FUNCTION_CODES.has(code) ? (code as EmbedderErrorCode) : "BAD_RESPONSE");
  }
  if (reply.ok !== true || reply.model !== spec.model) throw new EmbedderError("BAD_RESPONSE");
  // A different model, revision or spec than this broker was built for: its vectors must not be compared with, or stored beside, the ones already there.
  if (reply.modelId !== spec.modelId || reply.revision !== spec.revision || reply.spec !== spec.spec) throw new EmbedderError("SPEC_MISMATCH");
  if (reply.dimension !== spec.dimension) throw new EmbedderError("BAD_RESPONSE");
  const vectors = reply.vectors;
  if (!Array.isArray(vectors) || vectors.length !== count) throw new EmbedderError("BAD_RESPONSE");
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== spec.dimension) throw new EmbedderError("BAD_RESPONSE");
    let sum = 0;
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new EmbedderError("BAD_RESPONSE");
      sum += value * value;
    }
    // Normalized by the function; a vector far from unit length is not one of its answers.
    if (Math.abs(Math.sqrt(sum) - 1) > 0.01) throw new EmbedderError("BAD_RESPONSE");
  }
  return vectors as number[][];
}

/** Splits cleaned texts into requests of at most `maxTexts` texts and `maxTotalChars` characters, keeping the order. */
export function embedderBatches(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (current.length >= EMBEDDER_LIMITS.maxTexts || chars + text.length > EMBEDDER_LIMITS.maxTotalChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function createEmbedderClient(options: EmbedderClientOptions): EmbedderClient {
  const { invoke, spec } = options;
  const attempts = options.attempts ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function request(kind: EmbedderKind, texts: string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt += 1) {
      let reply: unknown;
      try {
        reply = await invoke({ model: spec.model, kind, texts });
      } catch (error) {
        const code = codeOf(error);
        if (code !== undefined && TRANSIENT_INVOKE.has(code) && attempt < attempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new EmbedderError("UNREACHABLE");
      }
      return checkEmbedderReply(reply, spec, texts.length);
    }
  }

  async function embedMany(texts: readonly string[], kind: EmbedderKind): Promise<number[][]> {
    if (kind !== "query" && kind !== "document") throw new EmbedderError("UNKNOWN_KIND");
    const cleaned = texts.map((text) => {
      if (typeof text !== "string") throw new EmbedderError("BAD_REQUEST");
      const trimmed = text.trim();
      if (trimmed.length === 0) throw new EmbedderError("EMPTY_TEXT");
      return trimmed.slice(0, EMBEDDER_LIMITS.maxTextChars);
    });
    const out: number[][] = [];
    for (const batch of embedderBatches(cleaned)) out.push(...(await request(kind, batch)));
    return out;
  }

  return {
    spec,
    dimension: spec.dimension,
    embedMany,
    async embed(text, kind) {
      const [vector] = await embedMany([text], kind);
      if (vector === undefined) throw new EmbedderError("BAD_RESPONSE");
      return vector;
    },
  };
}
