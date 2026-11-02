// A request the way the web app sends it (TE-4): the session cookie, the origin and the CSRF header. A browser session is what lets a settings save of commands take effect at once; a token's save is held until
// its check passes. Tests that only need a save to land (not the proof) send it this way.
import { randomUUID } from "node:crypto";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { DEV_ISSUER, type Developer } from "./developer-task-broker.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

type Reply = { status: number; body: Record<string, unknown> };
interface Harness {
  db: FakeDynamoDb;
  handler: (event: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;
  orgOf: (who: Developer) => Promise<unknown>;
}

/** `web(who, method, "/v1/app/...", body, signedInMsAgo)`: the request as that person's browser would send it. */
export function browserRequests(h: Harness) {
  const sessions = new Map<string, string>();
  return async (who: Developer, method: string, path: string, body?: unknown, authAgoMs = 0): Promise<Reply> => {
    await h.orgOf(who);
    if (h.db.get(`DEVELOPER#${who.developerId}`, "META") === undefined) {
      h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const key = `${who.developerId}:${String(authAgoMs)}`;
    let id = sessions.get(key);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date(Date.now() - authAgoMs).toISOString() });
      sessions.set(key, id);
    }
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
}
