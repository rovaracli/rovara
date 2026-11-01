// A Slack turn's model access (Task 13): the proxy's address and a key minted for this turn alone, from the control plane's
// POST /v1/service/model-access. The orchestrator holds no provider secret; the key stays in memory until shortly before it
// expires, is asked for once at a time, and is never logged.
import { ModelRouteSchema, agentXError, safeRefusalWords, type InvocationModelRoute } from "@agentx/contracts";

/** Asked for again this long before the key expires, so no request carries one about to lapse. */
export const TURN_ACCESS_MARGIN_MS = 60_000;

export interface TurnModelAccess {
  baseUrl: string;
  apiKey: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Task 26: the model the broker chose for the turn, when the org routes it to a company source. Absent, the turn runs its configured model. */
  route?: InvocationModelRoute;
}

export interface TurnModelAccessInput {
  controlPlaneUrl: string;
  /** Signs the request as the orchestrator role, for the turn's thread (see createSignedServiceFetch). */
  signedFetch: typeof fetch;
  /** The thread's org when known; the control plane derives it from the signed thread's team (R32) and refuses one that differs. */
  orgId?: string;
  /** The Slack event's ID: one turn, one reference on the key. */
  turnId: string;
  /** The models the turn will call with the key: the control plane routes the orchestrator's and keeps the classifier on Rovara's catalog (Task 26). */
  models?: { orchestrator?: { provider: string; modelId: string }; classifier?: { provider: string; modelId: string } };
  now?: () => number;
}

const KEY_PATTERN = /^[^\s]{1,16384}$/u;

/** The control plane's answer; anything else is refused without echoing it. */
function parseTurnModelAccess(body: unknown): TurnModelAccess {
  const value = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const { baseUrl, apiKey, expiresAt } = value;
  const route = value.route === undefined ? undefined : ModelRouteSchema.safeParse(value.route);
  let origin: URL | undefined;
  try { origin = typeof baseUrl === "string" ? new URL(baseUrl) : undefined; } catch { origin = undefined; }
  if (origin === undefined || !/^https?:$/u.test(origin.protocol) || typeof apiKey !== "string" || !KEY_PATTERN.test(apiKey)
    || typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || route?.success === false) {
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the control plane answered the model access request with something unexpected");
  }
  return { baseUrl: baseUrl as string, apiKey, expiresAt, ...(route?.success ? { route: route.data } : {}) };
}

/** The turn's current model access, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function turnModelAccessSource(input: TurnModelAccessInput): () => Promise<TurnModelAccess> {
  const now = input.now ?? Date.now;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/model-access`;
  // The member comes from the signed Slack user header, so only the org (when known) and the turn go in the body.
  const body = JSON.stringify({
    ...(input.orgId === undefined ? {} : { orgId: input.orgId }), turnId: input.turnId,
    ...(input.models?.orchestrator === undefined ? {} : { model: input.models.orchestrator }),
    ...(input.models?.classifier === undefined ? {} : { classifierModel: input.models.classifier }),
  });
  let current: TurnModelAccess | undefined;
  let pending: Promise<TurnModelAccess> | undefined;
  return async () => {
    if (current !== undefined && current.expiresAt - TURN_ACCESS_MARGIN_MS > now()) return current;
    pending ??= (async () => {
      try {
        const response = await input.signedFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!response.ok) {
          // Only the code is kept: the control plane's words are not shown to the member.
          const error = ((await response.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
          // Task 26: no AI source serves the turn's model. Its words say what an admin must do, so the member is shown them; no other refusal's words are kept.
          const refused = error?.code === "MODEL_NOT_ALLOWED" ? safeRefusalWords(error.message) : undefined;
          if (refused !== undefined) throw agentXError("MODEL_NOT_ALLOWED", refused);
          // A refusal of the person (not of the proxy): a removed or banned member is refused as a forbidden one is, not reported as a proxy fault.
          throw agentXError(error?.code === "FORBIDDEN" || error?.code === "REMOVED_FROM_ORG" ? "FORBIDDEN" : "MODEL_PROXY_UNAVAILABLE", `model access request failed with HTTP ${response.status}`);
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

/** The model the broker chose for the turn, if it chose one: asked of the same access source, so it shares the turn's one key request. */
export async function turnModelRoute(source: () => Promise<TurnModelAccess>): Promise<InvocationModelRoute | undefined> {
  return (await source()).route;
}

/** What a runtime needs from a turn's access: the proxy's origin once, and the key as often as it is asked for. */
export async function turnModelProxy(source: () => Promise<TurnModelAccess>): Promise<{ baseUrl: string; apiKey: () => Promise<string> }> {
  const first = await source();
  return { baseUrl: first.baseUrl, apiKey: async () => (await source()).apiKey };
}
