// Decision journey slice 3b: outside approvers decide on the card. A run_limit spend request that needs a project maintainer (the outsider here: Ben) is an `approve_request` card for exactly the people the
// confirmation page lets decide it, with its checks (a signed-in browser, a sign-in within the last 10 minutes, the decider's live authority), and the old confirmation link sends a browser to the card.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema } from "@agentx/contracts";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { MAYA } from "../support/developer-task-broker.js";
import { BEN, PREPARED, setup, type World } from "../support/spend-world.js";
import { browserRequests } from "../support/browser-session.js";
import { runCostKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

/** Maya's Quick task, its plan approved by Maya (a member, through the plan review page's tick): blocked on its $20 run limit, which asks a project maintainer (Ben). */
async function blocked(): Promise<{ w: World; taskId: string; requestId: string }> {
  const w = await setup();
  for (let index = 0; index < 5; index += 1) {
    const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3_600_000).toISOString();
    w.db.set({ ...runCostKey(TEST_ORG, "payments", "rovara-code", "QUICK", endedAt, `task-quick-${String(index)}`), entityType: "RUN_COST", orgId: TEST_ORG, project: "payments", agentId: "rovara-code", path: "QUICK", taskId: `task-quick-${String(index)}`, endedAt, costUsd: 10 });
  }
  const started = await w.api(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = w.meta(taskId).workspaceId;
  const planning = (): string => String(w.operations(workspaceId).filter((item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED").at(-1)!.id);
  await w.finish(workspaceId, String(w.operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  await w.artifact(workspaceId, planning(), "plan.md", planAnswer(planDocument()));
  await w.finish(workspaceId, planning(), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const workflow = w.meta(taskId).workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
  // With the cards off (set per test below), the token approval behaves as it always did and blocks on the limit.
  delete process.env.DECISION_CARDS_ENABLED;
  const approved = await w.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: workflow.artifacts.at(-1)!.sha256 });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  process.env.DECISION_CARDS_ENABLED = "1";
  const request = w.requestOf(taskId, "run_limit")[0]!;
  expect(request.approverIds).toContain(BEN.developerId);
  return { w, taskId, requestId: request.spendRequestId };
}

type Card = { id: string; kind: string; risk: string; taskId?: string; actions: Array<{ kind: string; href: string; label: string }> };
const cardsOf = async (web: ReturnType<typeof browserRequests>, who: Parameters<ReturnType<typeof browserRequests>>[0]) => {
  const list = await web(who, "GET", "/v1/app/decisions");
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const { requestId: _requestId, ...body } = list.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the harness's own field
  const view = DecisionCardsViewSchema.parse(body);
  return { cards: view.cards as Card[], digests: view.digests, details: view.details, raw: list.body };
};

describe("slice 3b: an outside approval is decided on its card", () => {
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });

  it("is a card only for the people who may decide it, opens a card-only page, and carries only the confirmation page's own facts", async () => {
    const { w, taskId, requestId } = await blocked();
    const web = browserRequests(w);
    const ben = await cardsOf(web, BEN);
    const card = ben.cards.find((candidate) => candidate.id === `approve_request:${requestId}`);
    expect(card, "the maintainer who may decide it has the card").toBeDefined();
    expect(card).toMatchObject({ kind: "approve_request", risk: "high", taskId });
    expect(card!.actions).toEqual([
      { kind: "open", label: "Open", href: `/app/decisions/approve_request/${requestId}`, method: "GET" },
      { kind: "reject", label: "Decline", href: `/v1/app/decisions/approve_request/${requestId}/reject`, method: "POST" },
    ]);
    // Only the card's own words and the request's facts: nothing of the task's plan, conversation or code.
    expect(JSON.stringify(ben.details[card!.id])).toContain("$20");
    expect(JSON.stringify(ben.raw)).not.toContain("Payments that fail with a timeout are retried.");
    // The requester may not decide her own request: no card, and a press is "no longer waiting".
    const maya = await cardsOf(web, MAYA);
    expect(maya.cards.some((candidate) => candidate.id === card!.id)).toBe(false);
    expect((await web(MAYA, "POST", `/v1/app/decisions/approve_request/${requestId}/approve`, { requestId: randomUUID(), shownDigest: ben.digests[card!.id]! })).status).toBe(404);
  });

  it("approves only from a signed-in browser after a recent sign-in, then once: a token is refused, a stale sign-in asks again, a changed card is stale, a replay is the first answer", async () => {
    const { w, requestId } = await blocked();
    const web = browserRequests(w);
    const { cards, digests } = await cardsOf(web, BEN);
    const id = `approve_request:${requestId}`;
    const path = `/v1/app/decisions/approve_request/${requestId}/approve`;
    expect(cards.some((card) => card.id === id)).toBe(true);
    // A token (an AI tool) never decides it.
    expect((await w.dev(BEN, "POST", path, { requestId: randomUUID(), shownDigest: digests[id]! })).status).toBe(403);
    // A sign-in that is not recent: REAUTH_REQUIRED, said on the card.
    const stale = await web(BEN, "POST", path, { requestId: randomUUID(), shownDigest: digests[id]! }, 20 * 60_000);
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
    // What was shown must be what is true now.
    expect((await web(BEN, "POST", path, { requestId: randomUUID(), shownDigest: "f".repeat(64) })).status).toBe(409);
    expect(w.requestOf(w.requests()[0]!.taskId!, "run_limit")[0]).toMatchObject({ status: "PENDING" });
    const pressId = randomUUID();
    const approved = await web(BEN, "POST", path, { requestId: pressId, shownDigest: digests[id]! });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ cardId: id, outcome: "approved" });
    expect(w.requests().find((record) => record.spendRequestId === requestId)).toMatchObject({ status: "APPROVED" });
    // The same press again answers what it first did; the card is gone.
    expect((await web(BEN, "POST", path, { requestId: pressId, shownDigest: digests[id]! })).body).toMatchObject({ cardId: id, outcome: "approved" });
    expect((await cardsOf(web, BEN)).cards.some((card) => card.id === id)).toBe(false);
  });

  it("declines on the card with the same checks", async () => {
    const { w, requestId } = await blocked();
    const web = browserRequests(w);
    const path = `/v1/app/decisions/approve_request/${requestId}/reject`;
    expect((await w.dev(BEN, "POST", path, { requestId: randomUUID(), reason: "other" })).status).toBe(403);
    expect((await web(BEN, "POST", path, { requestId: randomUUID(), reason: "other" }, 20 * 60_000)).body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
    const declined = await web(BEN, "POST", path, { requestId: randomUUID(), reason: "other" });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(w.requests().find((record) => record.spendRequestId === requestId)).toMatchObject({ status: "DENIED" });
  });

  it("the old confirmation link sends a browser to the card while the cards are on (kept one release); with them off it is the page as before", async () => {
    const context = {} as never;
    const request = { method: "GET", headers: {}, body: undefined } as never;
    const url = new URL("https://cell.example/v1/app/approve/spr_aaaaaaaaaaaaaaaaaaaa");
    const redirected = await routeDecidePage(context, request, url);
    expect(redirected).toMatchObject({ statusCode: 302, headers: { location: "/app/decisions/approve_request/spr_aaaaaaaaaaaaaaaaaaaa" } });
    delete process.env.DECISION_CARDS_ENABLED;
    // With the cards off the page works as it always did (here, with no decide session, it goes on to sign in): never to a card that is not there.
    const before = await routeDecidePage(context, request, url).catch(() => undefined);
    expect((before as { headers?: { location?: string } } | undefined)?.headers?.location ?? "").not.toContain("/app/decisions/");
  });
});
