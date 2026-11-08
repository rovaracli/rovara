// OWNER DECISION 18 follow-up (UX2C-LATER): Retry review of a PR feedback review that did not finish, from the task page's feedback view. The app route (POST /v1/app/tasks/{id}/workflow/feedback-retry)
// calls the SAME `retryTaskWorkflowFeedbackReview` the Slack button does: only the owner retries; a teammate, a viewer and another company read "Review not found." exactly as a missing task; a
// digest the review no longer has reads "This review changed."; a second press changes nothing (`started: false`); the owner's press starts the review again and the proposal arrives.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, SLACK_MAYA, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, type Developer } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../../support/slack-broker.js";
import { browserRequests } from "../../support/browser-session.js";
import { feedbackCriticReply } from "../../support/faux-scripts.js";
import { reviewerHangs } from "../../support/model-fixtures.js";
import { PLAN, atPlanReview, editsOrFix } from "../../support/workflow-e2e-journeys.js";
import { cardDecision } from "../../support/card-decision.js";
import { taskPeopleDirectory } from "../../support/task-people-directory.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import { FEEDBACK_REVIEW_RETRY_BUSY } from "../../../packages/broker/src/aws/developer-tasks.js";
import { FEEDBACK_CHANGED, FEEDBACK_NOT_FOUND } from "../../../packages/broker/src/aws/developer-routes/plan-panel.js";

const OWNER: Developer = { ...SLACK_MAYA };
const SAM: Developer = { developerId: developerIdForSlackUser("U0SAMLEE01"), name: "Sam Lee", provider: "slack", sessionId: "s-sam-07d", slackUserId: "U0SAMLEE01" };
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

/** A task whose draft pull request got one review comment and whose first PR feedback review timed out: the failed review waits for Maya's Retry. */
async function failedReviewWaiting() {
  const directory = taskPeopleDirectory([SAM]);
  let calls = 0;
  const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true, workerTimeouts: { feedbackReviewMs: 200 },
    taskPeople: { changesEnabled: true, checkTaskPerson: directory.check, taskPersonProof: directory.proof, taskPeopleDisplayRead: directory.display, developers: [SAM] },
    model: { plan: PLAN, edits: editsOrFix, feedback: (prompt) => (++calls === 1 ? reviewerHangs : feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" })) } });
  await atPlanReview(e2e);
  const shim = { db: e2e.db, handler: e2e.handler, orgOf: async () => undefined };
  expect((await cardDecision(shim, OWNER, e2e.taskId())).status).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  const pullRequest = e2e.github.pullRequests[0]!;
  expect(await e2e.githubWebhook(pullRequest.number, { comment: e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.") })).toBe(200);
  await e2e.settle();
  return { e2e, web: browserRequests(shim) };
}
const started = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
const path = (e2e: WorkflowE2E, suffix: string) => `/v1/app/tasks/${e2e.taskId()}/workflow/${suffix}`;
type Failed = { reportStatus: string; reviewDigest: string; revision: number };

describe("Suite 7d: Retry review of a PR feedback review on the task page (OWNER DECISION 18 follow-up)", () => {
  const switched = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { if (switched === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = switched; });

  it("only the owner retries: a teammate reads as a missing review; a stale digest and a bad body are refused; the owner's press reviews again, and a second press changes nothing", async () => {
    const { e2e, web } = await failedReviewWaiting();
    const read = await web(OWNER, "GET", path(e2e, "feedback"));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const failed = read.body.review as Failed;
    expect(failed.reportStatus).not.toBe("COMPLETE");
    const retry = (who: Developer, body: unknown, task = e2e.taskId()) => web(who, "POST", `/v1/app/tasks/${task}/workflow/feedback-retry`, body);
    // Not the owner: exactly what a missing task reads.
    const missing = await retry(OWNER, { reviewDigest: failed.reviewDigest }, randomUUID());
    expect([missing.status, JSON.stringify(missing.body)]).toEqual([404, expect.stringContaining(FEEDBACK_NOT_FOUND)]);
    const teammate = await retry(SAM, { reviewDigest: failed.reviewDigest });
    expect([teammate.status, teammate.body]).toEqual([missing.status, missing.body]);
    const revision = e2e.workflow().revision;
    // A digest this review never had, and bodies the strict schema refuses.
    const stale = await retry(OWNER, { reviewDigest: "f".repeat(64) });
    expect([stale.status, JSON.stringify(stale.body)]).toEqual([409, expect.stringContaining(FEEDBACK_CHANGED)]);
    for (const bad of [{}, { reviewDigest: "nope" }, { reviewDigest: failed.reviewDigest, actorId: "someone" }]) expect((await retry(OWNER, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(e2e.workflow().revision).toBe(revision);
    // The owner's press starts the review again; the answer is only whether it started.
    const retried = await retry(OWNER, { reviewDigest: failed.reviewDigest });
    expect([retried.status, started(retried.body)]).toEqual([200, { started: true }]);
    await e2e.settle();
    const after = (await web(OWNER, "GET", path(e2e, "feedback"))).body.review as Failed & { findings: unknown[]; status: string };
    // A finished review carries its findings and no failed-report status.
    expect([after.status, after.reportStatus]).toEqual(["PENDING", undefined]);
    expect(after.findings.length).toBeGreaterThan(0);
    // The same press again (a double click, a second tab): nothing starts and nothing changes.
    const revisionAfter = e2e.workflow().revision;
    const again = await retry(OWNER, { reviewDigest: failed.reviewDigest });
    expect([again.status, started(again.body)]).toEqual([200, { started: false }]);
    expect(e2e.workflow().revision).toBe(revisionAfter);
  }, 180_000);

  it("a viewer, and the owner of a task recorded under another company, read as a missing review and retry nothing", async () => {
    const { e2e, web } = await failedReviewWaiting();
    const failed = (await web(OWNER, "GET", path(e2e, "feedback"))).body.review as Failed;
    await e2e.click("agentx_task_people");
    await e2e.submitView({ task_person: { person: { selected_user: SAM.slackUserId } }, task_role: { role: { selected_option: { value: "viewer" } } } });
    await e2e.settle();
    const body = { reviewDigest: failed.reviewDigest };
    const missing = await web(SAM, "POST", `/v1/app/tasks/${randomUUID()}/workflow/feedback-retry`, body);
    const viewer = await web(SAM, "POST", path(e2e, "feedback-retry"), body);
    expect([viewer.status, viewer.body]).toEqual([missing.status, missing.body]);
    const revision = e2e.workflow().revision;
    e2e.db.set({ ...e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!, orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    const real = await web(OWNER, "POST", path(e2e, "feedback-retry"), body);
    const none = await web(OWNER, "POST", `/v1/app/tasks/${randomUUID()}/workflow/feedback-retry`, body);
    expect([real.status, real.body]).toEqual([none.status, none.body]);
    expect(e2e.workflow().revision).toBe(revision);
  }, 180_000);

  it("a workspace that is busy refuses the retry with the busy words, changes nothing, and the same press works once it is idle", async () => {
    const { e2e, web } = await failedReviewWaiting();
    const failed = (await web(OWNER, "GET", path(e2e, "feedback"))).body.review as Failed;
    const workspaceKey = `WORKSPACE#${String((e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META") as { workspaceId: string }).workspaceId)}`;
    const idle = e2e.db.get(workspaceKey, "META")!;
    e2e.db.set({ ...idle, status: "BUSY" });
    const revision = e2e.workflow().revision;
    const busy = await web(OWNER, "POST", path(e2e, "feedback-retry"), { reviewDigest: failed.reviewDigest });
    expect([busy.status, JSON.stringify(busy.body)]).toEqual([400, expect.stringContaining(FEEDBACK_REVIEW_RETRY_BUSY)]);
    expect(e2e.workflow().revision).toBe(revision);
    e2e.db.set(idle);
    const retried = await web(OWNER, "POST", path(e2e, "feedback-retry"), { reviewDigest: failed.reviewDigest });
    expect([retried.status, started(retried.body)]).toEqual([200, { started: true }]);
  }, 180_000);
});
