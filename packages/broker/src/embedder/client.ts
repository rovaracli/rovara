// The broker's side of the self-hosted embedder (environments/embedder; DECISIONS 23 and 27): one Lambda with two baked-in models, the Team record's
// (Qwen3-Embedding-0.6B, 1,024 dimensions) and the lessons' (bge-small, 384). This file is the port: it checks the request against the same limits the
// function enforces, sends it through `invoke`, and checks the answer before any vector is used or stored. The AWS call itself is `lambdaEmbedderInvoke`
// (team-record/aws-adapters.ts). Nothing here logs or keeps text from an error: every failure is one of the fixed codes below.
import type { EmbedderModelSpec } from "@agentx/contracts";

/** The function's limits (environments/embedder/app/embedder_core.py; tests/unit/embedder/spec.test.ts pins both sides to the same numbers). */
export const EMBEDDER_LIMITS = { maxTexts: 16, maxTextChars: 24_000, maxTotalChars: 96_000 } as const;

export type EmbedderKind = "query" | "document";

/**
 * What counts as blank, on both sides of the call: the code points of `BLANK_CODE_POINTS` in environments/embedder/app/embedder_core.py (tests/unit/embedder/spec.test.ts keeps the two equal).
 * JavaScript's trim() and Python's strip() disagree on some (U+001C to U+001F and U+0085 are Python-only, U+FEFF is JavaScript-only), and a text one side calls blank and the other does not would
 * fail a whole batch for good. This module cuts blanks off the edges and refuses a text that is all blank with the same set the function uses.
 */
export const EMBEDDER_BLANK_CODE_POINTS: readonly number[] = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x001c, 0x001d, 0x001e, 0x001f, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const BLANK_CLASS = `[${EMBEDDER_BLANK_CODE_POINTS.map((code) => `\\u${code.toString(16).padStart(4, "0")}`).join("")}]`;
const BLANK_EDGES = new RegExp(`^${BLANK_CLASS}+|${BLANK_CLASS}+$`, "gu");
/** The text without blanks at either end. */
export const trimEmbedderText = (text: string): string => text.replace(BLANK_EDGES, "");

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

/** One text's vector, and whether the text was longer than the model's token budget (or this port's character limit) and was cut to fit. A cut is never silent. */
export interface EmbeddedText { vector: number[]; truncated: boolean }

export interface EmbedderClient {
  readonly spec: EmbedderModelSpec;
  readonly dimension: number;
  embed(text: string, kind: EmbedderKind): Promise<number[]>;
  /** Any number of texts: split into requests inside the function's limits, in order. */
  embedMany(texts: readonly string[], kind: EmbedderKind): Promise<number[][]>;
  /** Like `embed`, with the truncation flag. */
  embedDetailed(text: string, kind: EmbedderKind): Promise<EmbeddedText>;
  /** Like `embedMany`, with the truncation flag of each text. */
  embedManyDetailed(texts: readonly string[], kind: EmbedderKind): Promise<EmbeddedText[]>;
}

export interface EmbedderClientOptions {
  invoke: EmbedderInvoke;
  spec: EmbedderModelSpec;
  /** Tries for a transient fault (throttling, a service fault). Default 2: the broker's own budget is 30 s. */
  attempts?: number;
  baseDelayMs?: number;
  /**
   * Also try again when the wait ran out (`AbortError`): a call that waited out a cold start leaves the function loading and warm for the next try. For the search path, where the second try is
   * likely quick; the ingest paths wait longer once instead (wiring.ts), because each of their retries costs a slot of the broker's own 30 s.
   */
  retryOnTimeout?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT_INVOKE = new Set(["TooManyRequestsException", "ServiceException", "ResourceNotReadyException", "EC2ThrottledException"]);
const TIMED_OUT = "AbortError";
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
export function checkEmbedderReply(reply: unknown, spec: EmbedderModelSpec, count: number): EmbeddedText[] {
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
  const flags = reply.truncated;
  if (!Array.isArray(flags) || flags.length !== count || flags.some((flag) => typeof flag !== "boolean")) throw new EmbedderError("BAD_RESPONSE");
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
  return (vectors as number[][]).map((vector, index) => ({ vector, truncated: flags[index] === true }));
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
  const retryOnTimeout = options.retryOnTimeout === true;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function request(kind: EmbedderKind, texts: string[]): Promise<EmbeddedText[]> {
    for (let attempt = 1; ; attempt += 1) {
      let reply: unknown;
      try {
        reply = await invoke({ model: spec.model, kind, texts });
      } catch (error) {
        const code = codeOf(error);
        if (code !== undefined && attempt < attempts) {
          if (TRANSIENT_INVOKE.has(code)) {
            await sleep(baseDelayMs * 2 ** (attempt - 1));
            continue;
          }
          // The function is loading (or busy) and carries on after the wait ends: the next try finds it warm.
          if (retryOnTimeout && code === TIMED_OUT) continue;
        }
        throw new EmbedderError("UNREACHABLE");
      }
      return checkEmbedderReply(reply, spec, texts.length);
    }
  }

  async function embedManyDetailed(texts: readonly string[], kind: EmbedderKind): Promise<EmbeddedText[]> {
    if (kind !== "query" && kind !== "document") throw new EmbedderError("UNKNOWN_KIND");
    const cut: boolean[] = [];
    const cleaned = texts.map((text) => {
      if (typeof text !== "string") throw new EmbedderError("BAD_REQUEST");
      const trimmed = trimEmbedderText(text);
      if (trimmed.length === 0) throw new EmbedderError("EMPTY_TEXT");
      cut.push(trimmed.length > EMBEDDER_LIMITS.maxTextChars);
      return trimmed.slice(0, EMBEDDER_LIMITS.maxTextChars);
    });
    const out: EmbeddedText[] = [];
    for (const batch of embedderBatches(cleaned)) out.push(...(await request(kind, batch)));
    // A text this port cut to the function's character limit is flagged, whatever the function says about its tokens.
    return out.map((entry, index) => (cut[index] === true ? { ...entry, truncated: true } : entry));
  }

  async function embedDetailed(text: string, kind: EmbedderKind): Promise<EmbeddedText> {
    const [entry] = await embedManyDetailed([text], kind);
    if (entry === undefined) throw new EmbedderError("BAD_RESPONSE");
    return entry;
  }

  return {
    spec,
    dimension: spec.dimension,
    embedManyDetailed,
    embedDetailed,
    async embedMany(texts, kind) {
      return (await embedManyDetailed(texts, kind)).map((entry) => entry.vector);
    },
    async embed(text, kind) {
      return (await embedDetailed(text, kind)).vector;
    },
  };
}
