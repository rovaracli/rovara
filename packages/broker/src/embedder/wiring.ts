// Builds the embedder clients from the broker's environment: the function's name is derived from the environment's name (contracts/derived-names.ts), the SDK is
// loaded on first use. Lane lessons-prod (lane 5) takes `lessonEmbedderFrom` for the lessons' `Embedder` port (a short wait and a pause after a timeout, like the search client); the Team record uses `recordEmbedderClientFrom`.
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER, type EmbedderModelSpec } from "@agentx/cloud-contracts";
import { lambdaEmbedderInvoke, type SdkOptions } from "../team-record/aws-adapters.js";
import { createEmbedderClient, type EmbedderCall, type EmbedderClient, type EmbedderKind } from "./client.js";

/**
 * The longest the broker waits for the function on the SEARCH path: a person is waiting, and the broker's own limit is 30 s. A cold start loads the model on the first call; the function keeps
 * running when the wait ends and is warm for a later call. The search does NOT try again at once (review R4): the first call is still busy in its container, a Lambda environment serves one
 * request at a time, so a second call would start a second cold container (3,008 MB) and take a second of the function's few reserved slots. A search whose wait ran out answers by keyword, and for
 * `EMBEDDER_SEARCH_COOLDOWN_MS` afterwards THIS broker container sends the function no more search calls. The pause is per container (a Lambda environment serves one request at a time, so searches
 * that arrive together run in different containers, each with its own pause): it stops one container from starting a second cold embedder for the same person, but a burst of simultaneous cold searches
 * can still start several (up to the function's reserved slots). The remedy for that is keeping the function warm (provisioned concurrency), not this pause.
 */
export const EMBEDDER_SEARCH_WAIT_MS = 9_000;
/** After a search wait ran out, no search call to the function from this broker container for this long (about a cold start's load time); searches answer by keyword meanwhile. */
export const EMBEDDER_SEARCH_COOLDOWN_MS = 20_000;
/**
 * The longest the broker waits on the INGEST path (the queue consumer and the taps: a row is written first, then embedded). Unchanged from before: that path shares the broker's 30 s with the
 * rest of the message, so its wait cannot grow. A row that is not embedded in time keeps `embedPending` and the re-embed job (below) finishes it.
 */
export const EMBEDDER_INGEST_WAIT_MS = 15_000;
/**
 * The longest the re-embed job waits for one call (a cold start of the 2.4 GB model, or a long text). The job passes each call the run's end as a deadline (team-record/reembed.ts), so a call
 * never waits past the run, whatever this is; and it starts the first call of a run only when this much of the run is left.
 */
export const EMBEDDER_JOB_WAIT_MS = 20_000;

function clientFor(spec: EmbedderModelSpec, env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number, cooldownAfterTimeoutMs = 0, now?: () => number): EmbedderClient | undefined {
  const functionName = env.EMBEDDER_FUNCTION_NAME;
  if (functionName === undefined || functionName === "") return undefined;
  return createEmbedderClient({ spec, cooldownAfterTimeoutMs, ...(now === undefined ? {} : { now }), invoke: lambdaEmbedderInvoke({ ...sdk, functionName, timeoutMs }) });
}

/** The Team record's embedder client for searches (a short wait, no retry after a timeout, a pause after one), or undefined where the install names no embedder function. */
export function recordSearchEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_SEARCH_WAIT_MS, cooldownMs: number = EMBEDDER_SEARCH_COOLDOWN_MS, now?: () => number): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs, cooldownMs, now);
}

/** The Team record's embedder client for ingest (one wait), or undefined where the install names no embedder function. */
export function recordEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_INGEST_WAIT_MS): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs);
}

/** The Team record's embedder client for the re-embed job (the longest wait), or undefined where the install names no embedder function. */
export function recordJobEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_JOB_WAIT_MS, now?: () => number): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs, 0, now);
}

/** What the lessons lane's `Embedder` port needs (`embed(text)`), plus the batch and query forms. 384 dimensions; never mixed with the Team record's index. */
export interface LessonEmbedder {
  readonly dimension: number;
  readonly spec: string;
  embed(text: string): Promise<number[]>;
  embedMany(texts: readonly string[], kind?: EmbedderKind, call?: EmbedderCall): Promise<number[][]>;
  /** Whether the SDK client is loaded now or within `waitMs` (round 3, R2-4): the lessons' time budgets start after it, so the load is never part of them. */
  warm?(waitMs: number): Promise<boolean>;
}

export function lessonEmbedderOver(client: EmbedderClient): LessonEmbedder {
  return {
    dimension: client.dimension,
    spec: client.spec.spec,
    embed: (text) => client.embed(text, "document"),
    embedMany: (texts, kind = "document", call) => client.embedMany(texts, kind, call),
    ...(client.warm === undefined ? {} : { warm: (waitMs: number) => client.warm!(waitMs) }),
  };
}

/**
 * The lessons' wait (round 2, N4). Lessons use the embedder inside a dispatch (the loader races it for 300 ms) and in the curator (5 s), and both pass their race down as the call's deadline, so a call never waits past
 * its race whatever this is; this is the ceiling for a caller that passes none (the nightly measure). A container still loading its models is NOT asked again: after a timeout this broker container sends the function no
 * more lesson calls for `EMBEDDER_LESSON_COOLDOWN_MS` (the lessons rank by keywords and paths meanwhile), because the abandoned call keeps its cold container busy and a second call would start another
 * cold container and take another of the function's few reserved slots, which the Team record's search and ingest share. The load path has no throttle retry: a retry needs a second of the call's deadline, and the load's is 300 ms.
 */
export const EMBEDDER_LESSON_WAIT_MS = 5_000;
export const EMBEDDER_LESSON_COOLDOWN_MS = 20_000;

/** The lessons' embedder, or undefined where the install names no embedder function. */
export function lessonEmbedderFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_LESSON_WAIT_MS, cooldownMs: number = EMBEDDER_LESSON_COOLDOWN_MS, now?: () => number): LessonEmbedder | undefined {
  const client = clientFor(LESSON_EMBEDDER, env, sdk, timeoutMs, cooldownMs, now);
  return client === undefined ? undefined : lessonEmbedderOver(client);
}
