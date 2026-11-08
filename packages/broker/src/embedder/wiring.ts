// Builds the embedder clients from the broker's environment: the function's name is derived from the environment's name (contracts/derived-names.ts), the SDK is
// loaded on first use. Lane lessons-prod (lane 5) takes `lessonEmbedderFrom` for the lessons' `Embedder` port; the Team record uses `recordEmbedderClientFrom`.
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER, type EmbedderModelSpec } from "@agentx/contracts";
import { lambdaEmbedderInvoke, type SdkOptions } from "../team-record/aws-adapters.js";
import { createEmbedderClient, type EmbedderClient, type EmbedderKind } from "./client.js";

/**
 * The longest the broker waits for the function on the SEARCH path: a person is waiting, and the broker's own limit is 30 s. A cold start loads the model on the first call; the function keeps
 * running when the wait ends and is warm for the next try, so the search client tries once more when the wait runs out (`retryOnTimeout`): two waits of 9 s leave the rest of the 30 s for
 * the vector query and the keyword fallback.
 */
export const EMBEDDER_SEARCH_WAIT_MS = 9_000;
/**
 * The longest the broker waits on the INGEST path (the queue consumer and the taps: a row is written first, then embedded). Unchanged from before: that path shares the broker's 30 s with the
 * rest of the message, so its wait cannot grow. A row that is not embedded in time keeps `embedPending` and the re-embed job (below) finishes it.
 */
export const EMBEDDER_INGEST_WAIT_MS = 15_000;
/**
 * The longest the re-embed job waits for one call. The job has the whole 30 s of a run to itself and starts a call only when this much of the run is left (team-record/reembed.ts), so this is
 * the one place the wait can be raised: a cold start of the 2.4 GB model, or a long text, fits.
 */
export const EMBEDDER_JOB_WAIT_MS = 20_000;

function clientFor(spec: EmbedderModelSpec, env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number, retryOnTimeout: boolean): EmbedderClient | undefined {
  const functionName = env.EMBEDDER_FUNCTION_NAME;
  if (functionName === undefined || functionName === "") return undefined;
  return createEmbedderClient({ spec, retryOnTimeout, invoke: lambdaEmbedderInvoke({ ...sdk, functionName, timeoutMs }) });
}

/** The Team record's embedder client for searches (a short wait, one more try after a timeout), or undefined where the install names no embedder function. */
export function recordSearchEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_SEARCH_WAIT_MS): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs, true);
}

/** The Team record's embedder client for ingest (one wait), or undefined where the install names no embedder function. */
export function recordEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_INGEST_WAIT_MS): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs, false);
}

/** The Team record's embedder client for the re-embed job (the longest wait), or undefined where the install names no embedder function. */
export function recordJobEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_JOB_WAIT_MS): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs, false);
}

/** What the lessons lane's `Embedder` port needs (`embed(text)`), plus the batch and query forms. 384 dimensions; never mixed with the Team record's index. */
export interface LessonEmbedder {
  readonly dimension: number;
  readonly spec: string;
  embed(text: string): Promise<number[]>;
  embedMany(texts: readonly string[], kind?: EmbedderKind): Promise<number[][]>;
}

export function lessonEmbedderOver(client: EmbedderClient): LessonEmbedder {
  return {
    dimension: client.dimension,
    spec: client.spec.spec,
    embed: (text) => client.embed(text, "document"),
    embedMany: (texts, kind = "document") => client.embedMany(texts, kind),
  };
}

/** The lessons' embedder, or undefined where the install names no embedder function. */
export function lessonEmbedderFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_INGEST_WAIT_MS): LessonEmbedder | undefined {
  const client = clientFor(LESSON_EMBEDDER, env, sdk, timeoutMs, false);
  return client === undefined ? undefined : lessonEmbedderOver(client);
}
