// A spent AI budget, as the model proxy reports it (docs/learnings/model-proxy-spike.md, question 3) and as the task
// ends because of it. Pi's own error drops the proxy's body, so the body is read once, classified and discarded here.
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@rovara-code/contracts";

/**
 * Whose budget ran out: the organisation's (Team=), the member's (User=) or the task's own key (Key=) as the proxy reports them; the control plane's refusal
 * to mint a key also names the project's, the agent's, a chain's (Plan 4) and a member's testing allowance (the budget levels of Plan 3).
 */
export type ModelBudgetScope = "org" | "member" | "task" | "project" | "agent" | "chain" | "test";

/** The model's budget ran out; a task that hits it ends, and the owner can raise the budget and continue. */
export class ModelBudgetExhaustedError extends Error {
  constructor(readonly scope: ModelBudgetScope) {
    super(BUDGET_EXHAUSTED_FAILURE_MESSAGE);
    this.name = "ModelBudgetExhaustedError";
  }
}

/**
 * The scope of a proxy 422 `budget_exceeded` body, or undefined for any other answer. The three bodies share their type and
 * code and differ only in their message: `Budget has been exceeded! Team=...`, `ExceededBudget: User=...` and
 * `Budget has been exceeded! Key=...`. Nothing of the body is kept.
 */
export function budgetScopeOfProxyBody(status: number, body: string): ModelBudgetScope | undefined {
  if (status !== 422) return undefined;
  let error: unknown;
  try { error = (JSON.parse(body) as { error?: unknown }).error; } catch { return undefined; }
  if (error === null || typeof error !== "object") return undefined;
  const { type, message } = error as { type?: unknown; message?: unknown };
  if (type !== "budget_exceeded" || typeof message !== "string") return undefined;
  if (/^Budget has been exceeded! Team=/u.test(message)) return "org";
  if (/^ExceededBudget: User=/u.test(message)) return "member";
  if (/^Budget has been exceeded! Key=/u.test(message)) return "task";
  return undefined;
}

/**
 * Whether a proxy answer is its 429 `budget_held`: the task's budget has room, but other model calls of the task hold it until they settle
 * (rovara_guard.py, section 4). It is waited out and sent again, never read as a rate limit or a spent budget. Both error envelopes carry the type in
 * `error.type` (OpenAI's on the OpenAI routes, Anthropic's on /v1/messages). Nothing of the body is kept.
 */
export function budgetHeldBody(status: number, body: string): boolean {
  if (status !== 429) return false;
  let error: unknown;
  try { error = (JSON.parse(body) as { error?: unknown }).error; } catch { return false; }
  return error !== null && typeof error === "object" && (error as { type?: unknown }).type === "budget_held";
}

/** How long a call waits out held budget in all: longer than the proxy's 1,000 s orphan expiry, so a hold whose replica died is spent (or freed) first. */
export const BUDGET_HELD_MAX_WAIT_MS = 1_200_000;

/** The wait before sending a held call again: the proxy's retry-after (seconds), kept within 0.25 to 30 s; 2 s when it names none. */
export function budgetHeldDelayMs(retryAfter: string | null): number {
  const seconds = retryAfter === null || retryAfter.trim() === "" ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) ? Math.min(30_000, Math.max(250, Math.round(seconds * 1000))) : 2_000;
}

/**
 * The model proxy's 422 `budget_max_tokens` (rovara_guard.py, section 4): the task's budget cannot pay for the output limit this call asked for, but can for
 * the smaller one the proxy names in `x-rovara-max-tokens`. The call is sent again with it instead of ending the task. Undefined for any other answer.
 */
export function budgetMaxTokensHint(status: number, body: string, header: string | null): number | undefined {
  if (status !== 422 || header === null || !/^\d{1,7}$/u.test(header.trim())) return undefined;
  let error: unknown;
  try { error = (JSON.parse(body) as { error?: unknown }).error; } catch { return undefined; }
  if (error === null || typeof error !== "object" || (error as { type?: unknown }).type !== "budget_max_tokens") return undefined;
  const limit = Number(header.trim());
  return limit >= 1 ? limit : undefined;
}

/**
 * The request body sent again with an output limit of at most `limit`: every output-limit field it names is lowered (max_tokens when it names none), and an
 * Anthropic thinking budget is kept under the new limit (Anthropic needs budget_tokens < max_tokens, at least 1,024). Undefined when the body is not a JSON object.
 */
export function withOutputLimit(body: string, limit: number): string | undefined {
  let request: unknown;
  try { request = JSON.parse(body); } catch { return undefined; }
  if (request === null || typeof request !== "object" || Array.isArray(request)) return undefined;
  const fields = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;
  const next = { ...(request as Record<string, unknown>) };
  const named = fields.filter((field) => typeof next[field] === "number");
  for (const field of named.length > 0 ? named : ["max_tokens"] as const) next[field] = typeof next[field] === "number" ? Math.min(next[field], limit) : limit;
  const thinking = next.thinking;
  if (thinking !== null && typeof thinking === "object" && typeof (thinking as { budget_tokens?: unknown }).budget_tokens === "number") {
    const ceiling = Math.max(...fields.map((field) => (typeof next[field] === "number" ? next[field] : 0)));
    const budget = (thinking as { budget_tokens: number }).budget_tokens;
    if (budget >= ceiling) {
      if (ceiling - 1024 >= 1024) next.thinking = { ...(thinking as Record<string, unknown>), budget_tokens: ceiling - 1024 };
      else delete next.thinking;
    }
  }
  return JSON.stringify(next);
}

const MARKER = /^AI budget exhausted \((org|member|task|project|agent|chain|test)\)$/u;

/** What a stream's error message says when the budget ran out: Pi carries only text, so the scope travels in it. */
export const budgetExhaustedMarker = (scope: ModelBudgetScope): string => `AI budget exhausted (${scope})`;

/** The error a stream message stands for, when it is a budget one (see {@link budgetExhaustedMarker}). */
export function budgetExhaustedFromMarker(message: string | undefined): ModelBudgetExhaustedError | undefined {
  const scope = message === undefined ? undefined : MARKER.exec(message)?.[1];
  return scope === undefined ? undefined : new ModelBudgetExhaustedError(scope as ModelBudgetScope);
}

// ---- a model no source serves (Plan 3 Task 26)

/** The control plane refused to issue a key because no AI source serves the step's model; its words say what to do. The task ends on it, with those words. */
export class ModelNotAllowedError extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "ModelNotAllowedError";
  }
}

const NOT_ALLOWED_MARKER = /^Model not allowed: ([^\p{Cc}]{1,300})$/u;

/** What a stream's error message says when the control plane refused the model: Pi carries only text, so the words travel in it. */
export const modelNotAllowedMarker = (text: string): string => `Model not allowed: ${text}`;

/** The error a stream message stands for, when it is a refusal of the model (see {@link modelNotAllowedMarker}). */
export function modelNotAllowedFromMarker(message: string | undefined): ModelNotAllowedError | undefined {
  const text = message === undefined ? undefined : NOT_ALLOWED_MARKER.exec(message)?.[1];
  return text === undefined ? undefined : new ModelNotAllowedError(text);
}
