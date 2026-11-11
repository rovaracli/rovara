// OWNER DECISION 18 (c), review I2: the PR feedback decision moved from the old `/review/<task>` page to the task page's feedback view. Its app route (POST /v1/app/tasks/{id}/workflow/feedback-decision)
// calls the same `submitWorkflowFeedbackDecision`, so the old page's rules hold there: only the owner decides; a teammate, a viewer and another company read "Review not found." exactly as a missing
// task; a stale digest reads "This review changed."; a body over 16 KB is refused; the answer is only the status and the next step. Approve starts the fix, as from Slack.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@rovara-code/contracts";
import { createWorkflowE2E, SLACK_MAYA, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, type Developer } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../../support/slack-broker.js";
import { browserRequests } from "../../support/browser-session.js";
import { feedbackCriticReply } from "../../support/faux-scripts.js";
import { PLAN, atPlanReview, editsOrFix } from "../../support/workflow-e2e-journeys.js";
import { cardDecision } from "../../support/card-decision.js";
import { taskPeopleDirectory } from "../../support/task-people-directory.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import { FEEDBACK_CHANGED, FEEDBACK_NOT_FOUND } from "../../../packages/broker/src/aws/developer-routes/plan-panel.js";

const OWNER: Developer = { ...SLACK_MAYA };
const SAM: Developer = { developerId: developerIdForSlackUser("U0SAMLEE01"), name: "Sam Lee", provider: "slack", sessionId: "s-sam-07c", slackUserId: "U0SAMLEE01" };
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

/** A task whose draft pull request got one review comment, and whose PR feedback review now waits for Maya. */
async function feedbackWaiting() {
  const directory = taskPeopleDirectory([SAM]);
  const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true,
    taskPeople: { changesEnabled: true, checkTaskPerson: directory.check, taskPersonProof: directory.proof, taskPeopleDisplayRead: directory.display, developers: [SAM] },
    model: { plan: PLAN, edits: editsOrFix, feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
  // With the cards on the plan is approved on its card (Slack's Approve opens Rovara for it), then coding, checks, reviews and the draft pull request.
  await atPlanReview(e2e);
  const shim = { db: e2e.db, handler: e2e.handler, orgOf: async () => undefined };
  const approved = await cardDecision(shim, OWNER, e2e.taskId());
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  const pullRequest = e2e.github.pullRequests[0]!;
  const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
  expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
  await e2e.settle();
  expect(e2e.workflow().feedbackReview?.status).toBe("PENDING");
  return { e2e, web: browserRequests({ db: e2e.db, handler: e2e.handler, orgOf: async () => undefined }) };
}
const path = (e2e: WorkflowE2E, suffix: string) => `/v1/app/tasks/${e2e.taskId()}/workflow/${suffix}`;
type Review = { revision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; recommendedFindingIds: string[] };
const decision = (review: Review, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
  bundleDigests: review.bundleDigests, decision: "APPROVE", selectedFindingIds: review.recommendedFindingIds, ...extra });

describe("Suite 7c: the PR feedback decision on the task page (OWNER DECISION 18)", () => {
  const switched = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { if (switched === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = switched; });

  it("only the owner decides: a teammate, a viewer and another company read exactly as a missing review; stale and oversized bodies are refused; the owner's Approve starts the fix", async () => {
    const { e2e, web } = await feedbackWaiting();
    const read = await web(OWNER, "GET", path(e2e, "feedback"));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const review = read.body.review as Review;
    expect(review.recommendedFindingIds.length).toBeGreaterThan(0);
    const missing = await web(OWNER, "POST", `/v1/app/tasks/${randomUUID()}/workflow/feedback-decision`, decision(review));
    expect([missing.status, JSON.stringify(missing.body)]).toEqual([404, expect.stringContaining(FEEDBACK_NOT_FOUND)]);
    // A teammate in the channel: the owner rule, answered as the old page did.
    const teammate = await web(SAM, "POST", path(e2e, "feedback-decision"), decision(review));
    expect([teammate.status, teammate.body]).toEqual([missing.status, missing.body]);
    expect((await web(SAM, "GET", path(e2e, "feedback"))).status).toBe(404);
    // Stale: a digest the review no longer has.
    const stale = await web(OWNER, "POST", path(e2e, "feedback-decision"), decision(review, { reviewDigest: "f".repeat(64) }));
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain(FEEDBACK_CHANGED);
    // Over 16 KB, and a body the strict schema refuses.
    const big = await web(OWNER, "POST", path(e2e, "feedback-decision"), decision(review, { ownerNote: "x".repeat(17_000) }));
    expect([big.status, JSON.stringify(big.body).includes("That is too long to send.")]).toEqual([400, true]);
    expect((await web(OWNER, "POST", path(e2e, "feedback-decision"), decision(review, { actorId: "someone" }))).status).toBe(400);
    expect(e2e.workflow().feedbackDecisions).toBeUndefined();
    // The owner approves: only the status and the next step come back, and the fix starts.
    const approved = await web(OWNER, "POST", path(e2e, "feedback-decision"), decision(review));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    expect(Object.keys(approved.body).filter((key) => key !== "requestId").sort()).toEqual(["nextAction", "status"]);
    await e2e.settle();
    expect(e2e.workflow().feedbackDecisions?.at(-1)).toMatchObject({ decision: "APPROVE", selectedFindingIds: review.recommendedFindingIds });
  }, 180_000);

  it("a viewer, and the owner of a task recorded under another company, read as a missing review and decide nothing", async () => {
    const { e2e, web } = await feedbackWaiting();
    const review = (await web(OWNER, "GET", path(e2e, "feedback"))).body.review as Review;
    await e2e.click("agentx_task_people");
    await e2e.submitView({ task_person: { person: { selected_user: SAM.slackUserId } }, task_role: { role: { selected_option: { value: "viewer" } } } });
    await e2e.settle();
    const missing = await web(SAM, "POST", `/v1/app/tasks/${randomUUID()}/workflow/feedback-decision`, decision(review));
    const viewer = await web(SAM, "POST", path(e2e, "feedback-decision"), decision(review));
    expect([viewer.status, viewer.body]).toEqual([missing.status, missing.body]);
    e2e.db.set({ ...e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!, orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    for (const [method, suffix, body] of [["GET", "feedback", undefined], ["POST", "feedback-decision", decision(review)]] as const) {
      const real = await web(OWNER, method, path(e2e, suffix), body);
      const none = await web(OWNER, method, `/v1/app/tasks/${randomUUID()}/workflow/${suffix}`, body);
      expect([real.status, real.body], suffix).toEqual([none.status, none.body]);
    }
    expect(e2e.workflow().feedbackDecisions).toBeUndefined();
  }, 180_000);
});
