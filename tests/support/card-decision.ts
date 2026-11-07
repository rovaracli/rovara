// OWNER DECISION 7: a plan is decided on its decision card on the task page (the old review page is read-only). This is the card's own door, as the app presses it: a signed-in browser (the app's
// cookie and CSRF), the card listed for this person, its evidence opened first when it is medium (the server's friction), then Approve or Request changes with the digest shown. A run limit is
// acknowledged only from a signed-in browser, never through a token's `/v1/dev/.../workflow/decision`, so tests that approve with the limit shown go through here.
import { randomUUID } from "node:crypto";
import { browserRequests } from "./browser-session.js";
import { DEV_ISSUER, type Developer } from "./developer-task-broker.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

interface CardHarness {
  db: FakeDynamoDb;
  orgOf(who: Developer): Promise<unknown>;
  handler(event: Record<string, unknown>): Promise<{ statusCode: number; body: string }>;
}

/** What the card sends besides the digest: the run limit shown, the answers, checks, comments and note; `decision: "REQUEST_CHANGES"` sends the document back with `reason`. */
export interface CardDecisionBody {
  decision?: "APPROVE" | "REQUEST_CHANGES";
  reason?: string;
  acknowledgedRunLimitUsd?: number;
  answers?: Array<{ decisionId: string; optionId: string; opened: boolean }>;
  selectedOptionalCheckIds?: string[];
  includedCommentIds?: string[];
  note?: string;
}

/** Decides the task's requirements or coding plan card as `who`, with the cards switched on for the call; `authAgoMs` is how long ago they signed in. Answers the status and the parsed body. */
export async function cardDecision(h: CardHarness, who: Developer, taskId: string, body: CardDecisionBody = {}, authAgoMs = 0): Promise<{ status: number; body: Record<string, unknown> }> {
  const before = process.env.DECISION_CARDS_ENABLED;
  process.env.DECISION_CARDS_ENABLED = "1";
  try {
    const web = browserRequests(h);
    const list = await web(who, "GET", "/v1/app/decisions", undefined, authAgoMs);
    const card = ((list.body.cards ?? []) as Array<{ id: string; risk: string }>).find((candidate) => candidate.id === `approve_plan:${taskId}` || candidate.id === `approve_requirements:${taskId}`);
    if (card === undefined) return { status: 404, body: { error: "no card" } };
    const digest = (list.body.digests as Record<string, string>)[card.id]!;
    const base = `/v1/app/decisions/${card.id.replace(":", "/")}`;
    if (card.risk === "medium") {
      const opened = await web(who, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest }, authAgoMs);
      if (opened.status !== 200) return opened;
    }
    const { decision, reason, ...fields } = body;
    if (decision === "REQUEST_CHANGES") {
      return await web(who, "POST", `${base}/request-changes`, { requestId: randomUUID(), shownDigest: digest, reason: reason ?? fields.note ?? "Please change this.", ...(fields.includedCommentIds === undefined ? {} : { includedCommentIds: fields.includedCommentIds }) }, authAgoMs);
    }
    // `return await`: the cards switch must still be on while the request runs (the finally below turns it off).
    return await web(who, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest, ...fields }, authAgoMs);
  } finally {
    if (before === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before;
  }
}

/** A write to the old review page's API (`/review/<task>/task/api/<endpoint>`), as its script sent it: the review cookie and its CSRF pair. OWNER DECISION 7: the page is read-only, so this answers 410. */
export async function reviewPagePost(h: CardHarness, who: Developer, taskId: string, endpoint: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  await h.orgOf(who);
  const id = randomUUID();
  h.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600, authTime: new Date().toISOString() });
  const response = await h.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task/api/${endpoint}`, rawQueryString: "",
    headers: { host: new URL(DEV_ISSUER).host, cookie: `__Host-agentx_review_session=${id}; __Host-agentx_review_csrf=${"c".repeat(43)}`, origin: new URL(DEV_ISSUER).origin, "x-agentx-csrf": "c".repeat(43), "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), ...body }), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  });
  const parse = (): Record<string, unknown> => { try { return JSON.parse(response.body) as Record<string, unknown>; } catch { return { raw: response.body }; } };
  return { status: response.statusCode, body: parse() };
}
