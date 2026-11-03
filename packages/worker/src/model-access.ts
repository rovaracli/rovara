// A task's model access (ruling R29): the proxy's address and a key minted for this task alone, from the
// control plane through the operation's callback capability. The worker holds no provider secret; the key
// stays in memory until shortly before it expires, is asked for once at a time, and is never logged.
import { TASK_BUDGET_EXCEEDED_PREFIX, agentXError, safeRefusalWords } from "@agentx/contracts";
import { ModelBudgetExhaustedError, ModelNotAllowedError, type ModelBudgetScope } from "@agentx/model-runtime";

/** Asked for again this long before the key expires, so no request carries one about to lapse. */
export const MODEL_ACCESS_MARGIN_MS = 60_000;

export interface ModelAccess {
  baseUrl: string;
  apiKey: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface ModelAccessSourceInput {
  controlPlaneUrl: string;
  /** The operation's callback capability, which grants this one request. */
  capability: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** DR5: the key slot of one design reviewer. The broker mints a key for that slot alone; without it the request is the operation's own key, as always. */
  slot?: string;
}

const KEY_PATTERN = /^[^\s]{1,16384}$/u;

/** The answer from the control plane; anything else is refused without echoing it. */
function parseModelAccess(body: unknown): ModelAccess {
  const value = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const { baseUrl, apiKey, expiresAt } = value;
  let origin: URL | undefined;
  try { origin = typeof baseUrl === "string" ? new URL(baseUrl) : undefined; } catch { origin = undefined; }
  if (origin === undefined || !/^https?:$/u.test(origin.protocol) || typeof apiKey !== "string" || !KEY_PATTERN.test(apiKey)
    || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered the model access request with something unexpected");
  }
  return { baseUrl: baseUrl as string, apiKey, expiresAt };
}

/** The budget level each refusal code of the control plane names; BUDGET_EXCEEDED is the member's or, by its message, the task's. */
const BUDGET_CODE_SCOPES: ReadonlyMap<string, ModelBudgetScope> = new Map([
  ["ORG_BUDGET_EXCEEDED", "org"], ["PROJECT_BUDGET_EXCEEDED", "project"], ["AGENT_BUDGET_EXCEEDED", "agent"], ["CHAIN_BUDGET_EXCEEDED", "chain"], ["TEST_ALLOWANCE_USED", "test"],
]);

/**
 * A 402 from the control plane is a spent budget (ruling R37): ORG_BUDGET_EXCEEDED is the organisation's, PROJECT_BUDGET_EXCEEDED the project's,
 * AGENT_BUDGET_EXCEEDED the agent's, CHAIN_BUDGET_EXCEEDED the chain's and TEST_ALLOWANCE_USED the member's testing allowance; BUDGET_EXCEEDED is the task's own when its message says so
 * (ruling R35) and the member's otherwise. An agent with no budget (AGENT_BUDGET_REQUIRED, a 409) is the agent's too. Only the code and the first words of
 * the message are read; nothing of the body is kept.
 */
async function budgetScopeOf(response: Response): Promise<ModelBudgetScope | undefined> {
  if (response.status !== 402 && response.status !== 409) return undefined;
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined;
  const { code, message } = body?.error ?? {};
  if (typeof code !== "string") return undefined;
  if (response.status === 409) return code === "AGENT_BUDGET_REQUIRED" ? "agent" : code === "CHAIN_BUDGET_REQUIRED" ? "chain" : undefined;
  if (code !== "BUDGET_EXCEEDED") return BUDGET_CODE_SCOPES.get(code);
  return typeof message === "string" && message.startsWith(TASK_BUDGET_EXCEEDED_PREFIX) ? "task" : "member";
}

/** Task 26: a 403 MODEL_NOT_ALLOWED is the control plane saying no AI source serves the step's model; its words are kept (bounded, printable). */
async function notAllowedText(response: Response): Promise<string | undefined> {
  if (response.status !== 403) return undefined;
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined;
  return body?.error?.code === "MODEL_NOT_ALLOWED" ? safeRefusalWords(body.error.message) : undefined;
}

/**
 * What the runtime needs of the proxy, without asking for a key: the proxy's origin (the worker's own configuration names it) and
 * the key as often as it is asked for. Nothing is minted until a request actually needs the proxy, so a ChatGPT-plan task whose
 * requests go direct to OpenAI never mints one unless its plan falls back to the proxy's models.
 */
export function lazyModelProxy(input: { baseUrl: string; source: () => Promise<ModelAccess> }): { baseUrl: string; apiKey: () => Promise<string> } {
  let origin: URL | undefined;
  try { origin = new URL(input.baseUrl); } catch { origin = undefined; }
  if (origin === undefined || !/^https?:$/u.test(origin.protocol)) throw agentXError("CONFIG_INVALID", "the worker's model proxy address is not an http or https URL");
  return { baseUrl: input.baseUrl, apiKey: async () => (await input.source()).apiKey };
}

/** The current model access, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function modelAccessSource(input: ModelAccessSourceInput): () => Promise<ModelAccess> {
  const transport = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/model-access${input.slot === undefined ? "" : `?slot=${encodeURIComponent(input.slot)}`}`;
  let current: ModelAccess | undefined;
  let pending: Promise<ModelAccess> | undefined;
  return async () => {
    if (current !== undefined && current.expiresAt - MODEL_ACCESS_MARGIN_MS > now()) return current;
    pending ??= (async () => {
      try {
        const response = await transport(url, { method: "GET", headers: { "x-agentx-callback-capability": input.capability } });
        if (!response.ok) {
          const exhausted = await budgetScopeOf(response);
          if (exhausted !== undefined) throw new ModelBudgetExhaustedError(exhausted);
          const refused = await notAllowedText(response);
          if (refused !== undefined) throw new ModelNotAllowedError(refused);
          throw agentXError("RUNTIME_UNAVAILABLE", `model access request failed with HTTP ${response.status}`);
        }
        current = parseModelAccess(await response.json().catch(() => undefined));
        return current;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
