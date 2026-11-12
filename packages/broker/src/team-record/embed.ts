// R3: the Team record's embedding client. Since DECISIONS 27 it calls the self-hosted embedder (environments/embedder, bge-small-en-v1.5, 384 dimensions, texts cut at 512 tokens since DECISIONS 140) in
// both editions; Bedrock embeddings (Amazon Titan, Cohere) are gone. The model, its pinned revision and its spec are `TEAM_RECORD_EMBEDDER` in contracts, and the client
// refuses any answer that is not that spec, so a changed model can never put vectors beside the ones already stored (the index name carries the spec too).
import { TEAM_RECORD_EMBEDDER, VECTOR_DIMENSION_DEFAULT } from "@agentx/cloud-contracts";
import { EmbedderError, trimEmbedderText, type EmbedderCall, type EmbedderClient, type EmbedderErrorCode } from "../embedder/client.js";
import { assertVector } from "./vectors.js";

export interface EmbedConfig {
  client: EmbedderClient;
  /** Text longer than this is cut before the call. Default: the function's own limit. */
  maxChars?: number;
}

export type EmbedPurpose = "document" | "query";

/** The embedding could not be made. The caller stores the row with `embedPending` (design 4.11) or falls back to keyword search. */
export class EmbedUnavailableError extends Error {
  /** One of the fixed embedder codes (safe to log), when the failure came from the embedder. */
  readonly reason: EmbedderErrorCode | undefined;
  /** `timeout`: the function had its full wait and did not answer; `deadline`: the caller's run left it too little time (EmbedderError.timing). Absent: any other fault. */
  readonly timing: "timeout" | "deadline" | undefined;
  constructor(reason?: EmbedderErrorCode, timing?: "timeout" | "deadline") {
    super("team-record: embedding unavailable");
    this.name = "EmbedUnavailableError";
    this.reason = reason;
    this.timing = timing;
  }
}

export interface EmbeddedVector {
  vector: number[];
  /** True when the text was longer than the model's token budget (or the character limit) and the vector stands for the part that fit. */
  truncated: boolean;
}

export interface Embedder {
  readonly dimension: number;
  /** The Hugging Face model the vectors come from. */
  readonly modelId: string;
  readonly revision: string;
  readonly spec: string;
  embed(text: string, purpose?: EmbedPurpose): Promise<number[]>;
  /** Like `embed`, saying whether the text was cut to fit. `call.deadline` (absolute, milliseconds) is the end the call may not wait past. */
  embedWithInfo(text: string, purpose?: EmbedPurpose, call?: EmbedderCall): Promise<EmbeddedVector>;
  /** Several texts in one call to the function (at most 16, in order), each with its cut flag. The re-embed job uses it (reembed.ts). */
  embedManyWithInfo(texts: readonly string[], purpose?: EmbedPurpose, call?: EmbedderCall): Promise<EmbeddedVector[]>;
}

export function createEmbedder(config: EmbedConfig): Embedder {
  const { client } = config;
  // The record's index is 384-d and holds this model's vectors only: a client for another model is a wiring mistake, caught here and not at the first write.
  // Since DECISIONS 140 the lessons' model is the same model, so the spec no longer tells the two clients apart: the model NAME does (a lesson client asks the function for "lesson" and must never write the record's index).
  if (client.spec.model !== TEAM_RECORD_EMBEDDER.model || client.spec.spec !== TEAM_RECORD_EMBEDDER.spec || client.dimension !== VECTOR_DIMENSION_DEFAULT) throw new Error("team-record: the embedder client is not the Team record's model");
  const maxChars = config.maxChars ?? 24_000;
  async function embedWithInfo(text: string, purpose: EmbedPurpose = "document", call?: EmbedderCall): Promise<EmbeddedVector> {
    const trimmed = trimEmbedderText(text);
    const input = trimmed.slice(0, maxChars);
    if (input.length === 0) throw new Error("team-record: nothing to embed");
    try {
      const { vector, truncated } = await client.embedDetailed(input, purpose, call);
      // A wrong-size or non-numeric answer is a contract failure, never stored: the index would reject or mis-rank it.
      assertVector(vector, client.dimension);
      return { vector, truncated: truncated || trimmed.length > input.length };
    } catch (error) {
      // Every failure (the function, the network, a different model) is one fixed outcome; no text from the error leaves.
      throw new EmbedUnavailableError(error instanceof EmbedderError ? error.code : undefined, error instanceof EmbedderError ? error.timing : undefined);
    }
  }
  async function embedManyWithInfo(texts: readonly string[], purpose: EmbedPurpose = "document", call?: EmbedderCall): Promise<EmbeddedVector[]> {
    const trimmed = texts.map((text) => trimEmbedderText(text));
    const inputs = trimmed.map((text) => text.slice(0, maxChars));
    if (inputs.length === 0 || inputs.some((input) => input.length === 0)) throw new Error("team-record: nothing to embed");
    try {
      const entries = await client.embedManyDetailed(inputs, purpose, call);
      return entries.map((entry, index) => {
        assertVector(entry.vector, client.dimension);
        return { vector: entry.vector, truncated: entry.truncated || (trimmed[index] as string).length > (inputs[index] as string).length };
      });
    } catch (error) {
      throw new EmbedUnavailableError(error instanceof EmbedderError ? error.code : undefined, error instanceof EmbedderError ? error.timing : undefined);
    }
  }
  return {
    dimension: client.dimension,
    modelId: client.spec.modelId,
    revision: client.spec.revision,
    spec: client.spec.spec,
    embedWithInfo,
    embedManyWithInfo,
    async embed(text, purpose = "document") {
      return (await embedWithInfo(text, purpose)).vector;
    },
  };
}
