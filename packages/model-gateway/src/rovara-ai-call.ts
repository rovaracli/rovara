// Rovara's AI as one call shape (DEC 240, DEC 243): the checked Anthropic request as Bedrock takes it, and what a failed Bedrock answer means.
// Shared by every route that can run on Rovara's own Bedrock account: the agent route (server.ts) and, for a company the operator named
// exempt, the answers and learning routes (learning-route.ts; DEC 254zzz3(1)). This module holds no secret and reads nothing: the caller
// gives it the allow-list (`RovaraAi.models`) and the checked call.
import type { RovaraAi } from "./agent-ai.js";
import { BEDROCK_MODEL_ACCESS_WORDS } from "./bedrock-byo-sessions.js";
import { CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS, REASONING_CARRYOVER_MODEL, toConverse } from "./bedrock-converse.js";
import { BEDROCK_CLAUDE_ID, bedrockConversePath, bedrockInvokePath } from "./bedrock-transport.js";
import type { GuardFailure } from "./guard.js";
import type { RouteCall, RouteRefusal } from "./server.js";

/** DEC 240: a model that is not on Rovara's AI allow-list. Before any hold. */
export const ROVARA_AI_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not offered on Rovara's AI." });
/** DEC 243c: a request a non-Claude model is not offered with on Rovara's AI (images, documents, thinking blocks, tool_choice none). */
export const ROVARA_AI_FEATURE: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This request uses something Rovara's AI does not offer for this model (only text and tools)." });
/** DEC 243: the model is on the allow-list but not enabled yet in Rovara's account (its one-time Marketplace enable). Free. */
export const ROVARA_AI_MODEL_NOT_ENABLED: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "model_not_enabled", message: "This model is not enabled yet on Rovara's AI. Choose another model, or try again after Rovara enables it." });
/** Bedrock's words for "the account has no access to this model yet" (a Marketplace agreement or model access), read only to classify. */
const MODEL_ACCESS_WORDS = BEDROCK_MODEL_ACCESS_WORDS;
/** DEC 240: Bedrock refused Rovara's own role. Free: the customer is never charged for it. */
export const ROVARA_AI_UNAVAILABLE: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "unavailable", message: "Rovara's AI is unavailable right now. Try again later." });
export const PROVIDER_ERROR: RouteRefusal = Object.freeze({ ok: false as const, status: 502, code: "provider_error", message: "provider unavailable" });
/** Bedrock's InvokeModel body version for Anthropic models. */
export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * The checked Anthropic body as Bedrock's InvokeModel takes it for a Claude id: no model or stream field (the path says both),
 * Bedrock's version, the allowed beta flags as a body field, and no metadata (Bedrock's Anthropic body has none).
 */
export function invokeCall(checked: RouteCall, id: string): RouteCall {
  const rest = Object.fromEntries(Object.entries(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>).filter(([name]) => !["model", "stream", "metadata"].includes(name)));
  const beta = checked.headers["anthropic-beta"];
  const body = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest, ...(beta === undefined ? {} : { anthropic_beta: beta.split(",").map((flag) => flag.trim()) }) };
  return { ...checked, model: id, bytes: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" }, path: bedrockInvokePath(id, checked.streaming) };
}

/** The checked call (model by its agent name) as Rovara's AI sends it: only an allow-listed model; Claude through InvokeModel, any other through Converse (DEC 243c). */
export function rovaraGuard(checked: RouteCall, ai: Pick<RovaraAi, "models" | "maxOutputTokens">): RouteCall | GuardFailure {
  const id = ai.models.get(checked.model);
  if (id === undefined) return ROVARA_AI_MODEL;
  if (!BEDROCK_CLAUDE_ID.test(id)) {
    // DEC 243c: any other model through Converse, held to at most its own output limit.
    const limit = ai.maxOutputTokens?.(id);
    const maxTokens = Math.min(checked.maxTokens, typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS);
    const converse = toConverse(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>, maxTokens, REASONING_CARRYOVER_MODEL.test(id));
    if (converse === undefined) return ROVARA_AI_FEATURE;
    return { ...checked, model: id, maxTokens, bytes: Buffer.from(JSON.stringify(converse)), headers: { "content-type": "application/json" }, path: bedrockConversePath(id, checked.streaming) };
  }
  return invokeCall(checked, id);
}

/**
 * A Bedrock error answer on Rovara's own account carries no output and no token counts: nothing the company used, so it is never charged
 * (DEC 240b charges from Bedrock's token counts). This includes 5xx and model timeouts, and an exception that arrives as the stream's first
 * frame (bedrock-transport.ts answers that as its error status). A stream that breaks AFTER output started keeps the core's rule (charged).
 * Its refusal of Rovara's own role is Rovara's to fix.
 */
export function rovaraProviderFailure(status: number, body?: Uint8Array): { charged: boolean; refusal: RouteRefusal } {
  if (status === 403 && body !== undefined && MODEL_ACCESS_WORDS.test(Buffer.from(body).toString("utf8"))) return { charged: false, refusal: ROVARA_AI_MODEL_NOT_ENABLED };
  if (status === 401 || status === 403) return { charged: false, refusal: ROVARA_AI_UNAVAILABLE };
  return { charged: false, refusal: PROVIDER_ERROR };
}
