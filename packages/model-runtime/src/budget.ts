// A spent AI budget, as the model proxy reports it (docs/learnings/model-proxy-spike.md, question 3) and as the task
// ends because of it. Pi's own error drops the proxy's body, so the body is read once, classified and discarded here.
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@agentx/contracts";

/** Whose budget ran out: the organisation's (Team=), the member's (User=) or the task's own key (Key=). */
export type ModelBudgetScope = "org" | "member" | "task";

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

const MARKER = /^AI budget exhausted \((org|member|task)\)$/u;

/** What a stream's error message says when the budget ran out: Pi carries only text, so the scope travels in it. */
export const budgetExhaustedMarker = (scope: ModelBudgetScope): string => `AI budget exhausted (${scope})`;

/** The error a stream message stands for, when it is a budget one (see {@link budgetExhaustedMarker}). */
export function budgetExhaustedFromMarker(message: string | undefined): ModelBudgetExhaustedError | undefined {
  const scope = message === undefined ? undefined : MARKER.exec(message)?.[1];
  return scope === undefined ? undefined : new ModelBudgetExhaustedError(scope as ModelBudgetScope);
}
