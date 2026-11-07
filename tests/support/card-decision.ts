// The plan review page's own decision door (`/review/{task}/task/api/decision`), as the page's script posts it: a signed-in browser with the review cookie and its CSRF pair. Decision journey slice 2:
// a run limit is acknowledged only from a signed-in browser (the card or this page), never through a token's `/v1/dev/.../workflow/decision`, so tests that approve with the limit shown go through here.
import { randomUUID } from "node:crypto";
import { DEV_ISSUER, type Developer } from "./developer-task-broker.js";

interface PageHarness {
  db: { set(item: Record<string, unknown>): void };
  orgOf(who: Developer): Promise<unknown>;
  handler(event: Record<string, unknown>): Promise<{ statusCode: number; body: string }>;
}

/** Approves (or decides) on the plan review page as `who`; `authAgoMs` is how long ago they signed in. Answers the status and the parsed body. */
export async function pageDecision(h: PageHarness, who: Developer, taskId: string, body: Record<string, unknown>, authAgoMs = 0): Promise<{ status: number; body: Record<string, unknown> }> {
  await h.orgOf(who);
  const id = randomUUID();
  h.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600, authTime: new Date(Date.now() - authAgoMs).toISOString() });
  const response = await h.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task/api/decision`, rawQueryString: "",
    headers: { host: new URL(DEV_ISSUER).host, cookie: `__Host-agentx_review_session=${id}; __Host-agentx_review_csrf=${"c".repeat(43)}`, origin: new URL(DEV_ISSUER).origin, "x-agentx-csrf": "c".repeat(43), "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), answers: [], includedCommentIds: [], ...body }), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  });
  const parse = (): Record<string, unknown> => { try { return JSON.parse(response.body) as Record<string, unknown>; } catch { return { raw: response.body }; } };
  return { status: response.statusCode, body: parse() };
}
