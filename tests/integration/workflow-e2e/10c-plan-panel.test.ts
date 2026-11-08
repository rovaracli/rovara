// Suite 10c (OWNER DECISION 18, PLAN-PANEL-NOW): the plan is read, discussed and decided in one place on the task page. The old review page's comment writes moved to app routes that call the
// SAME server functions (createPageComment with Ask, editPageComment, deletePageComment, setPageSuggestion) with the same checks; these are the old page's tests (10-page-auth.test.ts), moved:
// who may write (owner, teammate, viewer, another company as a missing task), stale revisions, strict bodies and the rate limits (a token's refusal: tests/contract/plan-panel-routes.test.ts). With the cards on (dk=1) the
// old links forward to the task page with the document's panel open; with them off the old pages are unchanged (10-page-auth.test.ts still passes).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, SLACK_MAYA, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, OMAR, type Developer } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../../support/slack-broker.js";
import { browserRequests } from "../../support/browser-session.js";
import { PAGE_ORIGIN, signInToReview, type PageReader } from "../../support/page-browser.js";
import { cardDecision } from "../../support/card-decision.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import { taskPeopleDirectory } from "../../support/task-people-directory.js";
import type { SlackRequestQueue } from "../../../packages/broker/src/developer/page-comments.js";

/** The Slack service's request queue as the broker sends to it: what an Ask queued. */
function recordingQueue(): SlackRequestQueue & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: async (message) => { sent.push(message); } };
}

const OWNER: Developer = { ...SLACK_MAYA };
/** A teammate in the project's Slack channel, known by the developer ID "Sign in with Slack" gives them. */
const SAM: Developer = { developerId: developerIdForSlackUser("U0SAMLEE01"), name: "Sam Lee", provider: "slack", sessionId: "s-sam-10c", slackUserId: "U0SAMLEE01" };
/** Someone signed in with company sign-in: no Slack identity, not in the channel. */
const OUTSIDER: Developer = { ...OMAR, provider: "oidc" };
const SLOW_DOWN = "You've posted a lot in the last 10 minutes. Try again in a few minutes.";

const PLAN = planDocument({
  title: "Show a retry banner",
  why: [{ text: "People miss that a payment failed. They pay twice.", author: "Maya" }],
  claims: [
    { id: "1", text: "Add a retry banner to greeting.ts." },
    { id: "2", text: "The banner sits on the page.", children: [{ id: "2.1", text: "It is placed near the pay button." }] },
  ],
  decisions: [{
    id: "d1", claimId: "2.1", question: "Where does the banner go?",
    options: [{ id: "above", label: "Above", consequence: "Seen first." }, { id: "below", label: "Below", consequence: "Less in the way." }],
    recommended: "below",
  }],
});
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export const banner = 'Retry';\n" }];
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

/** A Quick task whose coding plan waits for Maya, with sessions (so it has a task page in Rovara). */
async function waitingPlan(options: { people?: boolean; queue?: SlackRequestQueue } = {}) {
  const directory = taskPeopleDirectory([SAM]);
  const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true, model: { plan: planAnswer(PLAN), edits: EDITS }, ...(options.queue === undefined ? {} : { slackRequestQueue: options.queue }),
    ...(options.people === true ? { taskPeople: { changesEnabled: true, checkTaskPerson: directory.check, taskPersonProof: directory.proof, taskPeopleDisplayRead: directory.display, developers: [SAM] } } : {}) });
  expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  const shim = { db: e2e.db, handler: e2e.handler, orgOf: async () => undefined };
  return { e2e, web: browserRequests(shim), shim };
}

const base = (e2e: WorkflowE2E) => `/v1/app/tasks/${e2e.taskId()}`;
/** A comment as the panel posts it, on the coding plan's v1. */
const commentBody = (target: { kind: "document" } | { kind: "claim"; id: string } | { kind: "decision"; id: string }, text: string, extra: Record<string, unknown> = {}) =>
  ({ requestId: randomUUID(), document: "plan", version: 1, target, text, ask: false, ...extra });
const peopleComments = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "person")
  .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
/** A plain request to the broker's /review/ routes, as a browser sends it. */
async function reviewGet(e2e: WorkflowE2E, path: string, reader?: PageReader) {
  const url = new URL(path, PAGE_ORIGIN);
  let cookie: string | undefined;
  if (reader !== undefined) {
    cookie = `__Host-agentx_review_session=${signInToReview(e2e, reader)}`;
  }
  const response = await e2e.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: url.pathname, rawQueryString: url.search.replace(/^\?/, ""),
    headers: cookie === undefined ? {} : { cookie }, isBase64Encoded: false, requestContext: { requestId: randomUUID(), http: { method: "GET" } } }) as { statusCode: number; body: string; headers?: Record<string, string> };
  return { status: response.statusCode, body: response.body, location: response.headers?.location };
}
const reader = (who: Developer): PageReader => ({ developerId: who.developerId, name: who.name, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), ...(who.provider === "oidc" ? { provider: "oidc" as const } : {}) });

describe("Suite 10c: the plan panel on the task page (OWNER DECISION 18)", () => {
  // The panel's routes exist only with the decision cards on (18d); "with the cards off" below turns them off.
  const switched = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { if (switched === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = switched; });

  it("reads the current coding plan as the old page did: the owner may decide, a teammate may comment and suggest, another company reads exactly as a missing task, a token is refused", async () => {
    const { e2e, web } = await waitingPlan();
    const owner = await web(OWNER, "GET", `${base(e2e)}/documents/plan`);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    expect(owner.body).toMatchObject({ document: "plan", waiting: true, unverified: false, access: { canDecide: true, canComment: true },
      current: { version: 1, format: "structured", title: "Show a retry banner" } });
    const current = owner.body.current as { claims: Array<{ id: string; children?: Array<{ id: string }> }>; decisions: Array<{ id: string; recommended: string }> };
    expect(current.claims.map((claim) => claim.id)).toEqual(["1", "2"]);
    expect(current.claims[1]!.children?.map((claim) => claim.id)).toEqual(["2.1"]);
    expect(current.decisions).toMatchObject([{ id: "d1", recommended: "below" }]);
    const sam = await web(SAM, "GET", `${base(e2e)}/documents/plan`);
    expect(sam.status, JSON.stringify(sam.body)).toBe(200);
    expect(sam.body.access).toMatchObject({ canDecide: false, canComment: true, canSuggest: true });
    // Requirements this Quick task never wrote: no current version, nothing to show.
    expect((await web(OWNER, "GET", `${base(e2e)}/documents/requirements`)).body).toMatchObject({ document: "requirements", versions: [], waiting: false });
    const outsider = await web(OUTSIDER, "GET", `${base(e2e)}/documents/plan`);
    const missing = await web(OUTSIDER, "GET", `/v1/app/tasks/${randomUUID()}/documents/plan`);
    expect(outsider.status).toBeGreaterThanOrEqual(400);
    expect([outsider.status, outsider.body]).toEqual([missing.status, missing.body]);
    expect(JSON.stringify(outsider.body)).not.toContain("retry banner");
    // A document outside the fixed list is no route at all.
    expect((await web(OWNER, "GET", `${base(e2e)}/documents/secrets`)).status).toBe(404);
  }, 120_000);

  it("comments, replies, edits and deletes go through the old page's functions: the session is the author, a resend is the same comment, and each refusal is the old page's", async () => {
    const { e2e, web } = await waitingPlan();
    const first = commentBody({ kind: "claim", id: "2.1" }, "Above reads better on a phone.");
    const posted = await web(SAM, "POST", `${base(e2e)}/comments`, first);
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.comment).toMatchObject({ target: { kind: "claim", id: "2.1" }, author: { name: "Sam Lee", you: true, owner: false }, text: "Above reads better on a phone.", rev: 1 });
    const commentId = String((posted.body.comment as { id: string }).id);
    // The same request again is the same comment: nothing new is stored.
    expect((await web(SAM, "POST", `${base(e2e)}/comments`, first))).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(peopleComments(e2e)).toHaveLength(1);
    // Who wrote it is the session's, never the body's.
    expect((await web(SAM, "POST", `${base(e2e)}/comments`, { ...commentBody({ kind: "document" }, "Spoofed."), author: { name: "Maya" } })).status).toBe(400);
    const replied = await web(OWNER, "POST", `${base(e2e)}/comments`, commentBody({ kind: "claim", id: "2.1" }, "Good point.", { parentId: commentId }));
    expect(replied.status, JSON.stringify(replied.body)).toBe(201);
    expect(replied.body.comment).toMatchObject({ parentId: commentId, author: { owner: true, you: true } });
    // Edit: the author only, at the revision they saw, with a strict body.
    expect((await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/edit`, { rev: 1, text: "Above, near the pay button." }))).toMatchObject({ status: 200, body: { comment: { text: "Above, near the pay button.", edited: true, rev: 2 } } });
    const notHers = await web(OWNER, "POST", `${base(e2e)}/comments/${commentId}/edit`, { rev: 2, text: "Changed by the owner." });
    expect(notHers.status).toBe(403);
    expect(JSON.stringify(notHers.body)).toContain("Only the person who wrote a comment can change it.");
    const stale = await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/edit`, { rev: 1, text: "From an old tab." });
    expect(stale.status).toBe(409);
    expect((await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/edit`, { rev: 2, text: "x", commentId: randomUUID() })).status).toBe(400);
    expect(peopleComments(e2e).find((comment) => comment.commentId === commentId)).toMatchObject({ text: "Above, near the pay button.", rev: 2 });
    // Delete: the same rules.
    expect((await web(OWNER, "POST", `${base(e2e)}/comments/${commentId}/delete`, { rev: 2 })).status).toBe(403);
    expect((await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/delete`, { rev: 1 })).status).toBe(409);
    expect((await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/delete`, { rev: 2, reason: "x" })).status).toBe(400);
    expect((await web(SAM, "POST", `${base(e2e)}/comments/${commentId}/delete`, { rev: 2 }))).toMatchObject({ status: 200, body: { comment: { deleted: true } } });
    // Another company's person: the answer a missing task gets, for each write, and nothing is stored.
    for (const [path, body] of [["comments", commentBody({ kind: "document" }, "Hello.")], [`comments/${commentId}/edit`, { rev: 3, text: "x" }], [`comments/${commentId}/delete`, { rev: 3 }],
      ["suggestions", { document: "plan", decisionId: "d1", optionId: "above" }]] as const) {
      const real = await web(OUTSIDER, "POST", `${base(e2e)}/${path}`, body);
      const none = await web(OUTSIDER, "POST", `/v1/app/tasks/${randomUUID()}/${path}`, body);
      expect([real.status, real.body], path).toEqual([none.status, none.body]);
      expect(real.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(peopleComments(e2e).map((comment) => [comment.text, comment.deletedAt === undefined ? "kept" : "deleted"])).toEqual([["", "deleted"], ["Good point.", "kept"]]);
    expect(e2e.workflow().decisions).toEqual([]);
  }, 120_000);

  it("a task of another company answers every panel route exactly as a missing task, even for the person who started it, and nothing is written", async () => {
    const { e2e, web } = await waitingPlan();
    const meta = e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!;
    e2e.db.set({ ...meta, orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    for (const [method, path, body] of [["GET", "documents/plan", undefined], ["POST", "comments", commentBody({ kind: "document" }, "Hello.")],
      ["POST", `comments/${randomUUID()}/edit`, { rev: 1, text: "x" }], ["POST", `comments/${randomUUID()}/delete`, { rev: 1 }],
      ["POST", "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }], ["GET", "workflow/feedback", undefined]] as const) {
      for (const who of [OWNER, SAM]) {
        const real = await web(who, method, `${base(e2e)}/${path}`, body);
        const none = await web(who, method, `/v1/app/tasks/${randomUUID()}/${path}`, body);
        expect([real.status, real.body], `${who.name} ${path}`).toEqual([none.status, none.body]);
        expect(real.status, path).toBeGreaterThanOrEqual(400);
      }
    }
    expect(peopleComments(e2e)).toEqual([]);
  }, 120_000);

  it("Ask through the panel queues one answer per new comment: a resend asks nothing again, and past the hourly limit the comment posts with askRefused", async () => {
    const queue = recordingQueue();
    const { e2e, web } = await waitingPlan({ queue });
    const first = commentBody({ kind: "claim", id: "1" }, "Why a banner?", { ask: true });
    const asked = await web(SAM, "POST", `${base(e2e)}/comments`, first);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.comment).toMatchObject({ agentx: "answering" });
    expect(queue.sent).toHaveLength(1);
    // The same request again is the same comment, and Rovara is not asked twice.
    expect(await web(SAM, "POST", `${base(e2e)}/comments`, first)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(queue.sent).toHaveLength(1);
    // The owner asks too, on their own limit.
    expect((await web(OWNER, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "Is this the smallest change?", { ask: true }))).status).toBe(201);
    expect(queue.sent).toHaveLength(2);
    // Six questions an hour per person (AGENTX_ASK_RATE); the seventh posts as a comment with askRefused and queues nothing.
    for (let index = 0; index < 5; index += 1) expect((await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, `Question ${index + 2}?`, { ask: true }))).body.askRefused).toBeUndefined();
    expect(queue.sent).toHaveLength(7);
    const limited = await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "One too many?", { ask: true }));
    expect(limited.status, JSON.stringify(limited.body)).toBe(201);
    expect(limited.body.askRefused).toBe("limited");
    expect(queue.sent).toHaveLength(7);
    expect(peopleComments(e2e).map((comment) => comment.text)).toContain("One too many?");
  }, 120_000);

  it("refuses a body over 16 KB on every write, before any function runs, in the old page's words", async () => {
    const { e2e, web } = await waitingPlan();
    const big = "x".repeat(17_000);
    for (const [path, body] of [["comments", commentBody({ kind: "document" }, big)], [`comments/${randomUUID()}/edit`, { rev: 1, text: big }], [`comments/${randomUUID()}/delete`, { rev: 1, pad: big }],
      ["suggestions", { document: "plan", decisionId: "d1", optionId: big }], ["workflow/feedback-decision", { pad: big }]] as const) {
      const refused = await web(OWNER, "POST", `${base(e2e)}/${path}`, body);
      expect(refused.status, path).toBe(400);
      expect(JSON.stringify(refused.body), path).toContain("That is too long to send.");
    }
    expect(peopleComments(e2e)).toEqual([]);
  }, 120_000);

  it("with the cards off (dk=0) none of the panel's routes exists: each answers as an unknown path, and nothing is written", async () => {
    const { e2e, web } = await waitingPlan();
    process.env.DECISION_CARDS_ENABLED = "0";
    for (const [method, path, body] of [["GET", "documents/plan", undefined], ["POST", "comments", commentBody({ kind: "document" }, "Hello.")], ["POST", `comments/${randomUUID()}/edit`, { rev: 1, text: "x" }],
      ["POST", `comments/${randomUUID()}/delete`, { rev: 1 }], ["POST", "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }], ["GET", "workflow/feedback", undefined], ["POST", "workflow/feedback-decision", {}]] as const) {
      const off = await web(OWNER, method, `${base(e2e)}/${path}`, body);
      const unknown = await web(OWNER, method, `${base(e2e)}/no-such-path`, body);
      expect([off.status, off.body], path).toEqual([unknown.status, unknown.body]);
    }
    expect(peopleComments(e2e)).toEqual([]);
    expect((await web(OWNER, "GET", "/v1/app/nav")).body.features).not.toHaveProperty("decisionCards");
    // With them on, the app nav says so (read for someone whose nav is not cached yet: the nav is cached for a moment per person).
    process.env.DECISION_CARDS_ENABLED = "1";
    expect((await web(SAM, "GET", "/v1/app/nav")).body.features).toMatchObject({ decisionCards: true });
  }, 120_000);

  it("suggestions and their limits: a teammate suggests, the owner can't, and a flood of suggestions or comments is refused until ten minutes pass", async () => {
    const { e2e, web } = await waitingPlan();
    const owners = await web(OWNER, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" });
    expect(owners.status).toBe(403);
    expect(JSON.stringify(owners.body)).toContain("Owners answer decisions themselves; suggestions are for teammates.");
    expect((await web(SAM, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: "above", name: "Maya" })).status).toBe(400);
    for (let index = 0; index < 60; index += 1) {
      expect((await web(SAM, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: index % 2 === 0 ? "above" : "below" })).status).toBe(200);
    }
    const flooded = await web(SAM, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" });
    // TASK_BUSY with the old page's sentence (the app says 409 where the old page said 429).
    expect(flooded.status).toBe(409);
    expect(JSON.stringify(flooded.body)).toContain(SLOW_DOWN);
    const listed = await web(OWNER, "GET", `${base(e2e)}/comments`);
    expect(listed.body.suggestions).toEqual([{ document: "plan", decisionId: "d1", optionId: "below", name: "Sam Lee", you: false }]);
    e2e.clock.advance(10 * 60_000);
    expect((await web(SAM, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" })).status).toBe(200);
    for (let index = 0; index < 30; index += 1) expect((await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, `Thought ${index + 1}.`))).status).toBe(201);
    const refused = await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "One more."));
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(SLOW_DOWN);
    e2e.clock.advance(10 * 60_000);
    expect((await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "One more."))).status).toBe(201);
  }, 120_000);

  it("a viewer reads the plan but neither comments, asks nor suggests, by the same rule the old page used", async () => {
    const { e2e, web } = await waitingPlan({ people: true });
    await e2e.click("agentx_task_people");
    await e2e.submitView({ task_person: { person: { selected_user: SAM.slackUserId } }, task_role: { role: { selected_option: { value: "viewer" } } } });
    await e2e.settle();
    const read = await web(SAM, "GET", `${base(e2e)}/documents/plan`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.access).toEqual({ canComment: false, canSuggest: false, canDecide: false, canAsk: false });
    for (const ask of [false, true]) {
      const refused = await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "Can I?", { ask }));
      expect(refused.status, String(ask)).toBe(403);
    }
    expect((await web(SAM, "POST", `${base(e2e)}/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" })).status).toBe(403);
    expect(peopleComments(e2e)).toEqual([]);
  }, 120_000);

  it("the card shows the key facts from the plan itself: what is needed, what Rovara will do, the risk and why, the cost, and the open comments", async () => {
    const { e2e, web } = await waitingPlan();
    await web(SAM, "POST", `${base(e2e)}/comments`, commentBody({ kind: "document" }, "Keep the copy short."));
    const before = process.env.DECISION_CARDS_ENABLED;
    process.env.DECISION_CARDS_ENABLED = "1";
    try {
      const listed = await web(OWNER, "GET", "/v1/app/decisions");
      const id = `approve_plan:${e2e.taskId()}`;
      const card = (listed.body.cards as Array<{ id: string; risk: string; riskReasons: string[] }>).find((candidate) => candidate.id === id)!;
      expect(card.riskReasons.length).toBeGreaterThan(0);
      expect((listed.body.choices as Record<string, unknown>)[id]).toMatchObject({
        summary: { needed: "Show a retry banner: Show a retry banner when a payment fails", lines: ["Add a retry banner to greeting.ts.", "The banner sits on the page.", "It is placed near the pay button."] },
        openCommentCount: 1, openComments: [{ excerpt: "Keep the copy short." }],
      });
      // The same document gives the same card: the digest does not move between two reads.
      expect((await web(OWNER, "GET", "/v1/app/decisions")).body.digests).toEqual(listed.body.digests);
    } finally {
      if (before === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before;
    }
  }, 120_000);

  describe("old links with the cards on (dk=1)", () => {
    const cards = process.env.DECISION_CARDS_ENABLED;
    beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
    afterEach(() => { if (cards === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = cards; });

    it("/review/<id>/task forwards a reader to the task page with the document's panel open; nothing the link said but a known document reaches the location", async () => {
      const { e2e, shim } = await waitingPlan();
      const sessionId = String(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!.sessionId);
      expect(sessionId).toMatch(/^ses_[0-9a-z]{20}$/u);
      for (const [doc, panel] of [["coding-plan", "plan"], ["requirements", "requirements"], ["design", "design"], [undefined, "plan"], ["<script>", "plan"], ["plan%22onload", "plan"]] as const) {
        const page = await reviewGet(e2e, `/review/${e2e.taskId()}/task${doc === undefined ? "" : `?doc=${doc}&from=2`}`, reader(OWNER));
        expect([page.status, page.location], String(doc)).toEqual([302, `/app/sessions/${sessionId}?doc=${panel}`]);
      }
      // A teammate who may read is forwarded too; someone who may not is answered as before (never told where the task is).
      expect((await reviewGet(e2e, `/review/${e2e.taskId()}/task?doc=coding-plan`, reader(SAM))).status).toBe(302);
      const outsider = await reviewGet(e2e, `/review/${e2e.taskId()}/task?doc=coding-plan`, reader(OUTSIDER));
      expect(outsider.status).toBe(404);
      expect(outsider.location).toBeUndefined();
      // Signed out: to sign-in first, which comes back to the old link (and from there here).
      const signedOut = await reviewGet(e2e, `/review/${e2e.taskId()}/task?doc=coding-plan`);
      expect(signedOut.status).toBe(302);
      expect(signedOut.location).not.toContain("/app/sessions/");
      // The PR feedback page's link opens the task page's feedback view.
      const feedback = await reviewGet(e2e, `/review/${e2e.taskId()}`, reader(OWNER));
      expect([feedback.status, feedback.location]).toEqual([302, `/app/sessions/${sessionId}?view=feedback`]);
      expect((await reviewGet(e2e, `/review/${e2e.taskId()}`, reader(OUTSIDER))).location).toBeUndefined();
      // The card is still decided where it was: the same decide path (approve on the card).
      void shim;
    }, 120_000);

    it("with the cards off (dk=0) the old page is served as before", async () => {
      delete process.env.DECISION_CARDS_ENABLED;
      const { e2e } = await waitingPlan();
      const page = await reviewGet(e2e, `/review/${e2e.taskId()}/task?doc=coding-plan`, reader(OWNER));
      expect(page.status).toBe(200);
      expect(page.location).toBeUndefined();
      expect(page.body).toContain("Show a retry banner");
    }, 120_000);
  });

  it("Approve from the panel is the card's own approve: the same route, refused to a teammate, and one decision", async () => {
    const { e2e, shim } = await waitingPlan();
    expect((await cardDecision(shim, SAM, e2e.taskId())).status).toBe(404);
    const approved = await cardDecision(shim, OWNER, e2e.taskId(), { answers: [{ decisionId: "d1", optionId: "above", opened: true }] });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await e2e.settle();
    expect(e2e.workflow().decisions).toHaveLength(1);
  }, 120_000);
});
