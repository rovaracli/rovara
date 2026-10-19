// A task's model access (ruling R29): the proxy's address and a key minted for this task alone, from the
// control plane through the operation's callback capability. The worker holds no provider secret; the key
// stays in memory until shortly before it expires, is asked for once at a time, and is never logged.
import { agentXError } from "@agentx/contracts";
import { ModelBudgetExhaustedError, type ModelBudgetScope } from "@agentx/model-runtime";

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

/**
 * A 402 from the control plane is a spent budget (ruling R37): ORG_BUDGET_EXCEEDED is the organisation's, and BUDGET_EXCEEDED
 * is the task's own when its message says so (ruling R35) and the member's otherwise. Only the code and the first words
 * of the message are read; nothing of the body is kept.
 */
async function budgetScopeOf(response: Response): Promise<ModelBudgetScope | undefined> {
  if (response.status !== 402) return undefined;
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined;
  const { code, message } = body?.error ?? {};
  if (code === "ORG_BUDGET_EXCEEDED") return "org";
  if (code !== "BUDGET_EXCEEDED") return undefined;
  return typeof message === "string" && message.startsWith("This task has used its AI budget") ? "task" : "member";
}

/** What the runtime needs from the control plane's answer: the proxy's origin once, and the key as often as it is asked for. */
export async function modelProxyFromSource(source: () => Promise<ModelAccess>): Promise<{ baseUrl: string; apiKey: () => Promise<string> }> {
  const first = await source();
  return { baseUrl: first.baseUrl, apiKey: async () => (await source()).apiKey };
}

/** The current model access, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function modelAccessSource(input: ModelAccessSourceInput): () => Promise<ModelAccess> {
  const transport = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/model-access`;
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
