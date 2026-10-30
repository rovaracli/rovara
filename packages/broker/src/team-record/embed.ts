// R3: the Bedrock embedding client. The model id is install configuration (design 4.9.1: Enterprise uses its own Bedrock and
// may pick Cohere Embed). It talks to a one-method port, so the AWS SDK (InvokeModel) is wired in one place later.
import { teamRecordEmbeddingFamily, type EmbeddingFamily } from "@agentx/contracts";
import { assertVector } from "./vectors.js";

/** Calls Bedrock InvokeModel and returns the response body as text. Throws an error with `code` set to the Bedrock error name. */
export type InvokeModelPort = (request: { modelId: string; body: string }) => Promise<string>;

export interface EmbedConfig {
  modelId: string;
  dimension: number;
  invoke: InvokeModelPort;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Text longer than this is cut before the call (Titan V2 takes 8,192 tokens; about 4 characters each, kept well under). */
  maxChars?: number;
}

export type { EmbeddingFamily };
export const embeddingFamily = teamRecordEmbeddingFamily;

export type EmbedPurpose = "document" | "query";

/** The embedding could not be made after the bounded retries. The caller stores the row with `embedPending` (design 4.11). */
export class EmbedUnavailableError extends Error {
  constructor() {
    super("team-record: embedding unavailable");
    this.name = "EmbedUnavailableError";
  }
}

const TRANSIENT = new Set(["ThrottlingException", "ServiceUnavailableException", "ModelTimeoutException", "InternalServerException", "ModelNotReadyException"]);
const DEFAULT_MAX_CHARS = 24_000;

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function requestBody(family: EmbeddingFamily, text: string, dimension: number, purpose: EmbedPurpose): string {
  if (family === "titan-v2") return JSON.stringify({ inputText: text, dimensions: dimension, normalize: true });
  return JSON.stringify({ texts: [text], input_type: purpose === "query" ? "search_query" : "search_document", embedding_types: ["float"] });
}

function parseEmbedding(family: EmbeddingFamily, raw: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (family === "titan-v2") return record.embedding;
  const embeddings = record.embeddings;
  // Cohere v3 returns an array of vectors; v4 returns { float: [...] }.
  const list = Array.isArray(embeddings) ? embeddings : (embeddings as { float?: unknown } | undefined)?.float;
  return Array.isArray(list) ? list[0] : undefined;
}

export interface Embedder {
  readonly dimension: number;
  readonly modelId: string;
  embed(text: string, purpose?: EmbedPurpose): Promise<number[]>;
}

export function createEmbedder(config: EmbedConfig): Embedder {
  const family = embeddingFamily(config.modelId);
  // Cohere Embed v3 on Bedrock returns 1,024 dimensions and takes no size parameter.
  if (family === "cohere" && config.dimension !== 1024) throw new Error("team-record: cohere embedding dimension is not supported");
  if (family === "titan-v2" && ![256, 512, 1024].includes(config.dimension)) throw new Error("team-record: titan embedding dimension is not supported");
  const attempts = config.attempts ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 200;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  return {
    dimension: config.dimension,
    modelId: config.modelId,
    async embed(text, purpose = "document") {
      const input = text.trim().slice(0, maxChars);
      if (input.length === 0) throw new Error("team-record: nothing to embed");
      const body = requestBody(family, input, config.dimension, purpose);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const vector = parseEmbedding(family, await config.invoke({ modelId: config.modelId, body }));
          if (!Array.isArray(vector)) throw new EmbedUnavailableError();
          // A wrong-size or non-numeric answer is a contract failure, never stored: the index would reject or mis-rank it.
          assertVector(vector as number[], config.dimension);
          return vector as number[];
        } catch (error) {
          if (error instanceof EmbedUnavailableError) throw error;
          const code = codeOf(error);
          if (code === undefined || !TRANSIENT.has(code)) {
            // Deterministic failures (access denied, validation, wrong size) are terminal; no free text from the error leaves.
            throw new EmbedUnavailableError();
          }
          if (attempt >= attempts) throw new EmbedUnavailableError();
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    },
  };
}
