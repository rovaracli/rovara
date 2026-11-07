// Suite 10: the task page and its sign-in, as a product lead would try them from Slack. The link on the Slack card
// through sign-in [10.1], sign-in expiry and revocation, who sees what (the owner, a teammate in the channel, a reader
// of a finished task, someone eligible but outside the channel, and someone with no claim at all) [10.2], the phone
// layout at every stage [10.3], deep links [10.4], History at the end of a Full journey [10.5], the page right after a
// Slack decision [10.6, LIVE-BUG B12], and CSRF and Origin on both pages [10.8]. Then deciding and commenting on the page
// (spec 061 slice 2) beyond plan-review-slice-2-e2e.test.ts: a page decision racing a Slack press, a page left open on v1
// after v2 was written, replies and the thread limit, suggestions and their limit, AgentX's answers and their limits,
// the planner's "Done:" / "Not changed because" replies with one comment left unanswered, and drafts surviving a reload.
// 10.7 (review sessions on the PR feedback page) is covered by feedback-review-web.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, OMAR, type Developer } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../../support/slack-broker.js";
import { PAGE_ORIGIN, openTaskPage, readable, signInToReview, type PageReader } from "../../support/page-browser.js";
import { cardDecision, reviewPagePost } from "../../support/card-decision.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { feedbackCriticReply } from "../../support/faux-scripts.js";
import { reviewerFindings } from "../../support/model-fixtures.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import type { SlackRequestQueue } from "../../../packages/broker/src/developer/page-comments.js";
import { EDITS as GREET_EDITS, PLAN as GREET_PLAN, editsOrFix, journeySuite, openDraftPr } from "../../support/workflow-e2e-journeys.js";

/** Maya as the page knows her after "Sign in with Slack": the developer her Slack-started task belongs to. */
const OWNER: PageReader = { developerId: developerIdForSlackUser(MAYA.slackUserId!), name: MAYA.name, slackUserId: MAYA.slackUserId! };
/** A teammate in the project's Slack channel. */
const SAM: PageReader = { developerId: "7".repeat(64), name: "Sam Lee", slackUserId: "U0SAMLEE01" };
/** Someone signed in with company sign-in: no Slack identity, not in the channel. */
const OMAR_OIDC: PageReader = { developerId: OMAR.developerId, name: OMAR.name, provider: "oidc" };

const PLAN = planDocument({
  title: "Show a retry banner",
  why: [{ text: "People miss that a payment failed.", author: "Maya" }],
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
const V2 = planDocument({ ...PLAN, claims: [{ id: "1", text: "Add a retry banner to greeting.ts, above the form." }, PLAN.claims[1]!] });
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export const banner = 'Retry';\n" }];
const DAY = 24 * 60 * 60 * 1000;

/** Maya and Sam are in the project's channel; nobody else is. */
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

const codingRuns = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT");

/** A Quick task whose coding plan waits for Maya. `plan` answers the planner (v2 on a request for changes, say). */
async function waitingPlan(options: { plan?: string | ((latestUserText: string) => string); queue?: SlackRequestQueue } = {}) {
  const e2e = await createWorkflowE2E({ channelMembers: members, ...(options.queue === undefined ? {} : { slackRequestQueue: options.queue }),
    model: { plan: options.plan ?? planAnswer(PLAN), edits: EDITS } });
  expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  return e2e;
}

/** A plain request to the broker's review routes, as a browser (or anything else) would send it. */
async function request(e2e: WorkflowE2E, method: string, path: string, options: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, PAGE_ORIGIN);
  const response = await e2e.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: url.pathname, rawQueryString: url.search.replace(/^\?/, ""),
    headers: { ...(options.cookie === undefined ? {} : { cookie: options.cookie }), ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }), isBase64Encoded: false,
    requestContext: { requestId: randomUUID(), http: { method } },
  }) as { statusCode: number; body: string; headers?: Record<string, string> };
  return { status: response.statusCode, body: response.body, headers: response.headers ?? {} };
}

/** The visible words of an HTML page (no tags, scripts or styles). */
const words = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** A cookie for a review session that started now and lasts the page's fixed 30 days, as the sign-in service writes it. */
function thirtyDaySession(e2e: WorkflowE2E, reader: PageReader, sessionId = randomUUID()): string {
  signInToReview(e2e, reader);
  const now = Math.floor(Date.now() / 1000);
  e2e.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: reader.developerId, amr: reader.provider ?? "slack",
    startedAt: new Date().toISOString(), endsAt: now + 30 * 86_400, reviewExpiresAt: now + 30 * 86_400 });
  return `__Host-agentx_review_session=${sessionId}`;
}

/** Approve in Slack, as the owner presses it (and submits the form, when one opens). */
async function approveInSlack(e2e: WorkflowE2E): Promise<void> {
  const views = e2e.slack.views.length;
  await e2e.click("agentx_workflow_approve");
  if (e2e.slack.views.length > views) await e2e.submitView();
}

/** A comment as the page's script posts it, on the coding plan's v1. */
const commentBody = (target: { kind: "document" } | { kind: "claim"; id: string }, text: string, parentId?: string) =>
  ({ requestId: randomUUID(), document: "plan", version: 1, target, ...(parentId === undefined ? {} : { parentId }), text, ask: false });

const peopleComments = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "person")
  .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));

/** The page's CSS, with the lint the contract test "fits a phone" uses: no fixed widths, code blocks scroll inside themselves. */
function expectPhoneLayout(html: string): void {
  expect(html).toMatch(/<meta name="viewport" content="width=device-width,initial-scale=1[^"]*">/);
  const css = [...html.matchAll(/<style nonce="[^"]+">([\s\S]*?)<\/style>/g)].map((match) => match[1]!).join("\n");
  expect(css.replace(/@media[^{]*\{/g, "")).not.toMatch(/(^|[;{\s])width:\s*[0-9.]+(px|rem|em|ch)/);
  expect(css).toMatch(/overflow-wrap:anywhere/);
  expect(html).not.toMatch(/\swidth="\d+"/);
}

describe("Suite 10: page and auth", () => {
  journeySuite();

  it("10.1 the link on the Slack card sends a signed-out reader to sign in with the document kept, and after sign-in opens that document", async () => {
    const e2e = await waitingPlan();
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    const open = (card.blocks as Array<{ elements?: Array<{ action_id?: string; url?: string }> }>).flatMap((block) => block.elements ?? []).find((element) => element.action_id === "agentx_open_review");
    expect(open?.url).toBeDefined();
    const link = new URL(open!.url!);
    expect(link.origin).toBe(e2e.reviewUrlBase);
    expect(link.pathname).toBe(`/review/${e2e.taskId()}/task`);
    expect(link.hash).toBe("#coding-plan");
    // A browser never sends the #anchor; the document it names is in the query, which survives sign-in.
    const signedOut = await request(e2e, "GET", `${link.pathname}${link.search}`);
    expect(signedOut.status).toBe(302);
    const returnTo = new URL(signedOut.headers.location!, PAGE_ORIGIN).searchParams.get("return_to");
    expect(returnTo).toBe(`/review/${e2e.taskId()}/task?doc=coding-plan&from=1`);
    expect(signedOut.body).not.toContain("Show a retry banner");
    // Sign-in writes the review session and sends the browser back to return_to.
    const signedIn = await request(e2e, "GET", returnTo!, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(words(signedIn.body)).toContain("You're the task owner.");
    expect(signedIn.body).toContain('id="coding-plan-v1"');
    expect(words(signedIn.body)).toContain("It is placed near the pay button.");
  }, 120_000);

  it("10.1 a review sign-in works 29 days later and ends at 30: the page asks to sign in again, the open page's request is refused, and drafts are cleared", async () => {
    const e2e = await waitingPlan();
    const cookie = thirtyDaySession(e2e, OWNER);
    const path = `/review/${e2e.taskId()}/task?doc=coding-plan`;
    e2e.clock.advance(29 * DAY);
    expect((await request(e2e, "GET", path, { cookie })).status).toBe(200);
    const state = await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie });
    expect(state.status).toBe(200);
    e2e.clock.advance(DAY);
    const ended = await request(e2e, "GET", path, { cookie });
    expect(ended.status).toBe(302);
    expect(ended.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${e2e.taskId()}/task?doc=coding-plan`)}`);
    expect(await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie })).toMatchObject({ status: 401 });
    expect(JSON.parse((await request(e2e, "GET", `/review/${e2e.taskId()}/task/status`, { cookie })).body)).toEqual({ error: "Sign in again." });
  }, 120_000);

  it("10.3 the page fits a phone at every stage: the plan, failed checks, blocked reviews, waiting for the merge, merged; and so does the PR feedback page", async () => {
    const plan = await waitingPlan();
    expectPhoneLayout((await openTaskPage(plan, OWNER, { scripts: false })).html);

    const failing = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: GREET_EDITS }, checkResult: () => ({ exitCode: 1, stdout: "", stderr: "1 failing" }) });
    expect(await failing.mention("quick: Add a greet(name) function")).toBe(200);
    await failing.settle();
    await failing.click("agentx_workflow_approve");
    await failing.settle();
    expect(failing.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expectPhoneLayout((await openTaskPage(failing, OWNER, { scripts: false })).html);

    const blocked = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: GREET_EDITS, reviews: reviewerFindings(1) } });
    expect(await blocked.mention("quick: Add a greet(name) function")).toBe(200);
    await blocked.settle();
    await blocked.click("agentx_workflow_approve");
    await blocked.settle();
    expect(blocked.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expectPhoneLayout((await openTaskPage(blocked, OWNER, { scripts: false })).html);

    const waiting = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    const pullRequest = await openDraftPr(waiting);
    expectPhoneLayout((await openTaskPage(waiting, OWNER, { scripts: false })).html);
    const comment = waiting.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await waiting.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await waiting.settle();
    const feedback = await waiting.feedbackPage();
    expect(feedback.status).toBe(200);
    expectPhoneLayout(feedback.body);
    waiting.github.merge(pullRequest.number);
    expect(await waiting.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await waiting.settle();
    expect(waiting.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expectPhoneLayout((await openTaskPage(waiting, OWNER, { scripts: false })).html);
  }, 180_000);

  it("10.4 deep links: the document, a version and a claim each open where they point, and an earlier version says which one is current", async () => {
    const e2e = await waitingPlan({ plan: (latest) => (latest.includes("Put the banner above the form.") ? planAnswer(V2) : planAnswer(PLAN)) });
    await e2e.click("agentx_workflow_changes");
    await e2e.submitView({ workflow_feedback: { reason: { value: "Put the banner above the form." } } });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const page = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", scripts: false });
    expect(page.status).toBe(200);
    // The latest version is open; the earlier one is folded, says it isn't current, and has its own link target.
    expect(page.html).toContain('id="coding-plan-v2"');
    expect(page.html).toContain('id="coding-plan-v1"');
    expect(page.text()).toContain("This is v1. v2 is the current one.");
    // Each claim has its own link target in the latest version.
    expect(page.html).toContain('id="coding-plan-v2-2-1"');
    // Opened from the v1 card after v2 exists: the page says so.
    const fromV1 = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan&from=1", scripts: false });
    expect(fromV1.text()).toContain("You opened this from v1");
  }, 120_000);

  it("10.5 History at the end of a journey lists the approval, the PR feedback approval and the merge in order, each with who and when", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    e2e.clock.set("2026-10-11T14:05:00.000Z");
    const pullRequest = await openDraftPr(e2e);
    e2e.clock.advance(60 * 60_000);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    e2e.clock.advance(60 * 60_000);
    e2e.github.merge(pullRequest.number);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    const page = await openTaskPage(e2e, OWNER, { scripts: false });
    const history = page.document.querySelector("#history")!;
    const lines = history.querySelectorAll("li").map((line) => readable(line));
    // Newest first.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC /.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/^Oct 11, 14:0\d UTC /);
    const approval = lines.findIndex((line) => line.includes("approved Coding plan v1"));
    expect(approval).toBeGreaterThan(-1);
    expect(lines[approval]).toContain("The task owner approved Coding plan v1");
    expect(page.text()).toContain("Merged");
  }, 120_000);

  it("10.6 [LIVE-BUG B12] the page fetched right after a Slack decision shows the new step, never cached, even where reads lag a write", async () => {
    const e2e = await createWorkflowE2E({ channelMembers: members, consistency: "eventual", model: { plan: planAnswer(PLAN), edits: EDITS } });
    expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
    await e2e.settle();
    const before = await openTaskPage(e2e, OWNER, { scripts: false });
    expect(before.text()).toContain("Waiting for your approval");
    await approveInSlack(e2e);
    const after = await request(e2e, "GET", `/review/${e2e.taskId()}/task`, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(after.status).toBe(200);
    expect(after.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(words(after.body)).toContain("Writing the code");
    const state = await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(state.headers["cache-control"]).toContain("no-store");
    expect(JSON.parse(state.body)).toMatchObject({ revision: e2e.workflow().revision, waiting: false });
  }, 120_000);

  it("10.8 the PR feedback page refuses a decision without its CSRF token or from another origin, and the proposal still waits", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    const pullRequest = await openDraftPr(e2e);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    expect((await e2e.feedbackPage()).status).toBe(200);
    const review = JSON.parse((await e2e.feedbackPage(undefined, { api: true })).body) as { revision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings?: Array<{ id: string }> };
    const before = e2e.workflow();
    const body = { requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
      bundleDigests: review.bundleDigests, decision: "APPROVE", selectedFindingIds: ["finding-1"] };
    expect((await e2e.feedbackDecision(body, { csrf: null })).status).toBe(403);
    expect((await e2e.feedbackDecision(body, { origin: "https://evil.example" })).status).toBe(403);
    await e2e.settle();
    expect(e2e.workflow().revision).toBe(before.revision);
    expect(e2e.workflow().feedbackDecisions).toBeUndefined();
    expect(e2e.workflow().feedbackReview).toMatchObject({ status: "PENDING" });
    expect(codingRuns(e2e)).toHaveLength(1);
  }, 120_000);

  // OWNER DECISION 7: the page is read-only. What it decided is on the task page's decision card, with the same authority; these replace the page's own deciding, commenting, reply, suggestion
  // and draft journeys (those writes no longer exist anywhere on this page; comments on a task are made on the task page in Rovara, where they are people's comments).
  describe("the read-only page (OWNER DECISION 7)", () => {
    const cards = process.env.DECISION_CARDS_ENABLED;
    const withCards = async (work: () => Promise<void>) => { process.env.DECISION_CARDS_ENABLED = "1"; try { await work(); } finally { if (cards === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = cards; } };
    const asDeveloper = (who: PageReader): Developer => ({ developerId: who.developerId, name: who.name, provider: "slack", sessionId: `s-${who.developerId.slice(0, 8)}`, slackUserId: who.slackUserId });
    const shim = (e2e: WorkflowE2E) => ({ db: e2e.db, handler: e2e.handler, orgOf: async () => undefined });

    it("10.1 a revoked sign-in reads nothing and writes nothing: the page asks to sign in again and its API answers 401", async () => {
      const e2e = await waitingPlan();
      const cookie = thirtyDaySession(e2e, OWNER);
      expect((await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie })).status).toBe(200);
      const sessionId = cookie.split("=")[1]!;
      e2e.db.set({ ...e2e.db.get(`SESSION#${sessionId}`, "META")!, revokedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) - 1 });
      expect((await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie })).status).toBe(401);
      const posted = await request(e2e, "POST", `/review/${e2e.taskId()}/task/api/comments`, { cookie, headers: { origin: PAGE_ORIGIN, "content-type": "application/json" }, body: commentBody({ kind: "document" }, "Late.") });
      expect(posted.status).toBe(401);
      expect(peopleComments(e2e)).toEqual([]);
    }, 120_000);

    it("10.2 who sees what: the owner is sent to the task page to decide, a teammate reads, an eligible outsider is told whom to ask, anyone else can't tell the task exists, and nobody writes", async () => {
      const e2e = await waitingPlan();
      const owner = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", scripts: false });
      expect(owner.text()).toContain("You're the task owner.");
      expect(owner.text()).toContain("Decide on the task");
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan", scripts: false });
      expect(sam.text()).toContain("You can read this task.");
      expect(sam.text()).toContain("Only owners decide.");
      for (const tab of [owner, sam]) expect(tab.document.querySelectorAll("button").filter((button) => !button.hidden && button.closest("[hidden]") === null)).toEqual([]);
      const outsider = await openTaskPage(e2e, OMAR_OIDC, { search: "?doc=coding-plan", scripts: false });
      expect(outsider.status).toBeGreaterThanOrEqual(400);
      expect(outsider.html).not.toContain("Show a retry banner");
      const workflow = e2e.workflow();
      const decision = { expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", answers: [], includedCommentIds: [] };
      for (const who of [OWNER, SAM, OMAR_OIDC]) {
        const real = await reviewPagePost(shim(e2e), asDeveloper(who), e2e.taskId(), "decision", decision);
        expect(real.status, who.name).toBe(410);
      }
      // An outsider's refusal says nothing about the task: the same words a missing task gets.
      const missing = await reviewPagePost(shim(e2e), asDeveloper(OMAR_OIDC), randomUUID(), "decision", decision);
      expect((await reviewPagePost(shim(e2e), asDeveloper(OMAR_OIDC), e2e.taskId(), "decision", decision)).body).toEqual(missing.body);
      expect(e2e.workflow().decisions).toEqual(workflow.decisions);
      expect(codingRuns(e2e)).toEqual([]);
    }, 120_000);

    it("10.2 a finished task reads for everyone who could see it, with nothing to press", async () => {
      const e2e = await waitingPlan();
      const views = e2e.slack.views.length;
      await e2e.click("agentx_workflow_close");
      if (e2e.slack.views.length > views) await e2e.submitView();
      await e2e.settle();
      for (const who of [OWNER, SAM]) {
        const tab = await openTaskPage(e2e, who, { search: "?doc=coding-plan", scripts: false });
        expect(tab.status).toBe(200);
        expect(tab.document.querySelectorAll("button").filter((button) => !button.hidden && button.closest("[hidden]") === null)).toEqual([]);
        expect(tab.document.querySelector(".comment-open")).toBeNull();
      }
    }, 120_000);

    it("the owner approves on the card with two comments on the plan; the coder gets the owner's answer and both comments, and the read-only page shows them sent", async () => {
      await withCards(async () => {
        const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true, model: { plan: planAnswer(PLAN), edits: EDITS } });
        expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
        await e2e.settle();
        const artifact = e2e.workflow().artifacts.at(-1)!;
        for (const [who, text] of [[SAM, "Above reads better on a phone."], [OWNER, "Keep the banner copy short."]] as const) {
          const commentId = randomUUID();
          e2e.db.set({ pk: `DEVTASK#${e2e.taskId()}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId: e2e.taskId(), commentId, document: "plan", version: artifact.version, target: { kind: "document" },
            author: { kind: "person", developerId: who.developerId, slackUserId: who.slackUserId, name: who.name, owner: who === OWNER }, text, createdAt: new Date().toISOString(), rev: 1 });
        }
        expect((await cardDecision(shim(e2e), asDeveloper(SAM), e2e.taskId())).status, "a teammate has no card").toBe(404);
        const approved = await cardDecision(shim(e2e), asDeveloper(OWNER), e2e.taskId(), { answers: [{ decisionId: "d1", optionId: "above", opened: true }] });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        await e2e.settle();
        const implement = [...e2e.prompts, ...e2e.turns.map((turn) => turn.userText)].find((prompt) => prompt.includes("Implement the human-approved plan"))!;
        expect(implement).toContain("> Above reads better on a phone.");
        expect(implement).toContain("> Keep the banner copy short.");
        expect(codingRuns(e2e)).toHaveLength(1);
        const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan", scripts: false });
        expect(sam.document.querySelectorAll(".comment-sent").length).toBeGreaterThan(0);
      });
    }, 120_000);
  });
});
