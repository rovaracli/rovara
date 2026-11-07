// Suite 10b: the task page with the decision cards on (OWNER DECISION 7): read-only, every write refused with 410, its decisions made on the task page's card with the same authority.
// With the cards off the page decides as before (10-page-auth.test.ts).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, OMAR, type Developer } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../../support/slack-broker.js";
import { PAGE_ORIGIN, openTaskPage, signInToReview, type PageReader } from "../../support/page-browser.js";
import { cardDecision, reviewPagePost } from "../../support/card-decision.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import type { SlackRequestQueue } from "../../../packages/broker/src/developer/page-comments.js";

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
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export const banner = 'Retry';\n" }];
/** Maya and Sam are in the project's channel; nobody else is. */
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

const codingRuns = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT");

/** A Quick task whose coding plan waits for Maya. */
async function waitingPlan(options: { plan?: string | ((latestUserText: string) => string); queue?: SlackRequestQueue } = {}) {
  const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true, ...(options.queue === undefined ? {} : { slackRequestQueue: options.queue }),
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

/** A cookie for a review session that started now and lasts the page's fixed 30 days, as the sign-in service writes it. */
function thirtyDaySession(e2e: WorkflowE2E, reader: PageReader, sessionId = randomUUID()): string {
  signInToReview(e2e, reader);
  const now = Math.floor(Date.now() / 1000);
  e2e.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: reader.developerId, amr: reader.provider ?? "slack",
    startedAt: new Date().toISOString(), endsAt: now + 30 * 86_400, reviewExpiresAt: now + 30 * 86_400 });
  return `__Host-agentx_review_session=${sessionId}`;
}

/** A comment as the page's script posts it, on the coding plan's v1. */
const commentBody = (target: { kind: "document" } | { kind: "claim"; id: string }, text: string, parentId?: string) =>
  ({ requestId: randomUUID(), document: "plan", version: 1, target, ...(parentId === undefined ? {} : { parentId }), text, ask: false });

const peopleComments = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "person")
  .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));

describe("Suite 10b: the read-only page, decision cards on", () => {
  describe("the read-only page (OWNER DECISION 7)", () => {
    const cards = process.env.DECISION_CARDS_ENABLED;
    beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
    afterEach(() => { if (cards === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = cards; });
    const withCards = async (work: () => Promise<void>) => { await work(); };
    const asDeveloper = (who: PageReader): Developer => ({ developerId: who.developerId, name: who.name, provider: "slack", sessionId: `s-${who.developerId.slice(0, 8)}`, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }) });
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

    it("10.2 who sees what: the owner is sent to the task page to decide, a teammate reads and comments, anyone else can't tell the task exists, and nobody decides here", async () => {
      const e2e = await waitingPlan();
      // OWNER DECISION 18: the page forwards everyone who may read it to the task page, with the coding plan's panel open.
      // (Where it forwards, and that only a known document reaches the location, is 10c-plan-panel.test.ts.)
      for (const who of [OWNER, SAM]) expect((await openTaskPage(e2e, who, { search: "?doc=coding-plan", scripts: false })).status, who.name).toBe(302);
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
      // OWNER DECISION 18: a finished task's old link forwards to its task page too (nothing is decided there either).
      for (const who of [OWNER, SAM]) expect((await openTaskPage(e2e, who, { search: "?doc=coding-plan", scripts: false })).status, who.name).toBe(302);
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
        // The panel's comment list shows both sent with the approval.
        const listed = await (await import("../../support/browser-session.js")).browserRequests(shim(e2e))(asDeveloper(SAM), "GET", `/v1/app/tasks/${e2e.taskId()}/comments`);
        expect((listed.body.comments as Array<{ sent: boolean }>).map((comment) => comment.sent)).toEqual([true, true]);
      });
    }, 120_000);
  });
});
