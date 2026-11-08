// Builds the embedder clients from the broker's environment: the function's name is derived from the environment's name (contracts/derived-names.ts), the SDK is
// loaded on first use. Lane lessons-prod (lane 5) takes `lessonEmbedderFrom` for the lessons' `Embedder` port; the Team record uses `recordEmbedderClientFrom`.
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER, type EmbedderModelSpec } from "@agentx/contracts";
import { lambdaEmbedderInvoke, type SdkOptions } from "../team-record/aws-adapters.js";
import { createEmbedderClient, type EmbedderClient, type EmbedderKind } from "./client.js";

/** The longest the broker waits for the function (a cold start loads the model on the first call; the function keeps running and is warm for the next). */
export const EMBEDDER_WAIT_MS = 15_000;

function clientFor(spec: EmbedderModelSpec, env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number): EmbedderClient | undefined {
  const functionName = env.EMBEDDER_FUNCTION_NAME;
  if (functionName === undefined || functionName === "") return undefined;
  return createEmbedderClient({ spec, invoke: lambdaEmbedderInvoke({ ...sdk, functionName, timeoutMs }) });
}

/** The Team record's embedder client, or undefined where the install names no embedder function (a record row is then stored without a vector and found by keyword). */
export function recordEmbedderClientFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_WAIT_MS): EmbedderClient | undefined {
  return clientFor(TEAM_RECORD_EMBEDDER, env, sdk, timeoutMs);
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
export function lessonEmbedderFrom(env: Readonly<Record<string, string | undefined>>, sdk: SdkOptions, timeoutMs: number = EMBEDDER_WAIT_MS): LessonEmbedder | undefined {
  const client = clientFor(LESSON_EMBEDDER, env, sdk, timeoutMs);
  return client === undefined ? undefined : lessonEmbedderOver(client);
}
