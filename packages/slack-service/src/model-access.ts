// A Slack turn's model access (Task 13): the proxy's address and a key minted for this turn alone, from the control plane's
// POST /v1/service/model-access. The orchestrator holds no provider secret; the key stays in memory until shortly before it
// expires, is asked for once at a time, and is never logged.
import { agentXError } from "@agentx/contracts";

/** Asked for again this long before the key expires, so no request carries one about to lapse. */
export const TURN_ACCESS_MARGIN_MS = 60_000;

export interface TurnModelAccess {
  baseUrl: string;
  apiKey: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface TurnModelAccessInput {
  controlPlaneUrl: string;
  /** Signs the request as the orchestrator role, for the turn's thread (see createSignedServiceFetch). */
  signedFetch: typeof fetch;
  orgId: string;
  slackUserId?: string;
  /** The Slack event's ID: one turn, one reference on the key. */
  turnId: string;
  now?: () => number;
}

const KEY_PATTERN = /^[^\s]{1,16384}$/u;

/** The control plane's answer; anything else is refused without echoing it. */
function parseTurnModelAccess(body: unknown): TurnModelAccess {
  const value = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const { baseUrl, apiKey, expiresAt } = value;
  let origin: URL | undefined;
  try { origin = typeof baseUrl === "string" ? new URL(baseUrl) : undefined; } catch { origin = undefined; }
  if (origin === undefined || !/^https?:$/u.test(origin.protocol) || typeof apiKey !== "string" || !KEY_PATTERN.test(apiKey)
    || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the control plane answered the model access request with something unexpected");
  }
  return { baseUrl: baseUrl as string, apiKey, expiresAt };
}

/** The turn's current model access, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function turnModelAccessSource(input: TurnModelAccessInput): () => Promise<TurnModelAccess> {
  const now = input.now ?? Date.now;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/model-access`;
  const body = JSON.stringify({ orgId: input.orgId, ...(input.slackUserId === undefined ? {} : { slackUserId: input.slackUserId }), turnId: input.turnId });
  let current: TurnModelAccess | undefined;
  let pending: Promise<TurnModelAccess> | undefined;
  return async () => {
    if (current !== undefined && current.expiresAt - TURN_ACCESS_MARGIN_MS > now()) return current;
    pending ??= (async () => {
      try {
        const response = await input.signedFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!response.ok) {
          // Only the code is kept: the control plane's words are not shown to the member.
          const code = ((await response.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined)?.error?.code;
          throw agentXError(code === "FORBIDDEN" ? "FORBIDDEN" : "MODEL_PROXY_UNAVAILABLE", `model access request failed with HTTP ${response.status}`);
        }
        current = parseTurnModelAccess(await response.json().catch(() => undefined));
        return current;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

/** What a runtime needs from a turn's access: the proxy's origin once, and the key as often as it is asked for. */
export async function turnModelProxy(source: () => Promise<TurnModelAccess>): Promise<{ baseUrl: string; apiKey: () => Promise<string> }> {
  const first = await source();
  return { baseUrl: first.baseUrl, apiKey: async () => (await source()).apiKey };
}
