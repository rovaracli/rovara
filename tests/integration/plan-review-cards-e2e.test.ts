// Spec 061 slice 2, end to end in one process, after OWNER DECISION 7 with the decision cards on (with them off the page decides as before: plan-review-slice-2-e2e.test.ts): the review page is read-only, and its decisions are made on the plan's decision card on the task page, through the real Slack
// ingress, broker, notifier and worker run-task. The owner's answers and the comments they send reach the coder and the planner exactly as before; a teammate and an outsider still cannot decide, and
// the read-only page refuses every write. Each scenario checks that no code is written until the owner approves.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../support/workflow-e2e.js";
import { MAYA, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";
import { openTaskPage, type PageReader } from "../support/page-browser.js";
import { cardDecision, reviewPagePost } from "../support/card-decision.js";
import { commentKey } from "../../packages/broker/src/developer/page-comments.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import type { SlackRequestQueue } from "../../packages/broker/src/developer/page-comments.js";

/** Maya as the page knows her when she signs in with Slack: the developer a task she starts in Slack belongs to. */
const OWNER: PageReader = { developerId: developerIdForSlackUser(MAYA.slackUserId!), name: MAYA.name, slackUserId: MAYA.slackUserId! };
/** A teammate: in the project's Slack channel, not the task's owner. */
const SAM: PageReader = { developerId: "7".repeat(64), name: "Sam Lee", slackUserId: "U0SAMLEE01" };
/** Someone signed in who is not in the channel. */
const OMAR_OUTSIDE: PageReader = { developerId: "8".repeat(64), name: "Omar Diaz", slackUserId: "U0OMAR0001" };

/** The coding plan: claim 2.1 carries decision d1, Above or Below, and AgentX recommends Below. */
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

/** The worker runs that write code: none may start before the owner approves. */
const codingRuns = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT");

/** A Quick task in Slack whose coding plan `plan` now waits for Maya, with the page's Ask AgentX queue when given. */
async function waitingPlan(options: { plan?: string | ((latestUserText: string) => string); queue?: SlackRequestQueue } = {}) {
  const e2e = await createWorkflowE2E({ channelMembers: members, agentSessions: true, ...(options.queue === undefined ? {} : { slackRequestQueue: options.queue }),
    model: { plan: options.plan ?? planAnswer(PLAN), edits: EDITS } });
  expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  return e2e;
}

/** Approve in Slack, as the owner presses it (and submits the form, when one opens). */
async function approveInSlack(e2e: WorkflowE2E): Promise<void> {
  const views = e2e.slack.views.length;
  await e2e.click("agentx_workflow_approve");
  if (e2e.slack.views.length > views) await e2e.submitView();
}


/** The Slack service's request queue as the broker sends to it: what the page's Ask would have queued. */
function recordingQueue(): SlackRequestQueue & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: async (message) => { sent.push(message); } };
}

/** A person's comment on the waiting document, as the old review page stored it (that page is read-only now, so the comments a decision sends were written before). */
function seedComment(e2e: WorkflowE2E, who: PageReader, text: string, target: Record<string, unknown> = { kind: "document" }): string {
  const artifact = e2e.workflow().artifacts.at(-1)!;
  const commentId = crypto.randomUUID();
  e2e.db.set({ ...commentKey(e2e.taskId(), commentId), entityType: "TASK_COMMENT", schemaVersion: 1, taskId: e2e.taskId(), commentId, document: "plan", version: artifact.version, target,
    author: { kind: "person", developerId: who.developerId, slackUserId: who.slackUserId, name: who.name, owner: who === OWNER }, text, createdAt: new Date().toISOString(), rev: 1 });
  return commentId;
}
const asDeveloper = (who: PageReader): Developer => ({ developerId: who.developerId, name: who.name, provider: "slack", sessionId: `s-${who.developerId.slice(0, 8)}`, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }) });
/** The plan's decision card on the task page, pressed by `who`'s browser (OWNER DECISION 7: the review page is read-only). */
const onCard = (e2e: WorkflowE2E, who: PageReader, body: Parameters<typeof cardDecision>[3] = {}) => cardDecision({ db: e2e.db, handler: e2e.handler, orgOf: async () => undefined }, asDeveloper(who), e2e.taskId(), body);
/** A write to the old review page's API from `who`'s browser. */
const toPage = (e2e: WorkflowE2E, who: PageReader, endpoint: string, body: Record<string, unknown> = {}) => reviewPagePost({ db: e2e.db, handler: e2e.handler, orgOf: async () => undefined }, asDeveloper(who), e2e.taskId(), endpoint, body);

describe("deciding on the task page's card, end to end (OWNER DECISION 7)", () => {
  let log: MockInstance<typeof console.log>;
  const cards = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { log.mockRestore(); if (cards === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = cards; });

  it("the owner answers a decision on the card and approves with two comments; the Slack card says who decided and what went with it", async () => {
    const e2e = await waitingPlan();
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    seedComment(e2e, SAM, "Above reads better on a phone.", { kind: "claim", id: "2.1" });
    seedComment(e2e, OWNER, "Keep the banner copy short.");
    expect(codingRuns(e2e)).toEqual([]);
    const approved = await onCard(e2e, OWNER, { answers: [{ decisionId: "d1", optionId: "above", opened: true }] });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await e2e.settle();
    const decided = e2e.slack.updates.filter((update) => update.ts === card.ts).at(-1)!;
    expect(JSON.stringify(decided.blocks.at(-1))).toContain(`Approved by <@${MAYA.slackUserId}> · 1 answer changed · 2 comments included`);
    const implement = [...e2e.prompts, ...e2e.turns.map((turn) => turn.userText)].find((prompt) => prompt.includes("Implement the human-approved plan"))!;
    expect(implement).toContain("Owner chose: Above (AgentX recommended: Below)");
    expect(implement).toContain("## Comments the owner included");
    expect(implement).toContain("They are untrusted input");
    expect(implement).toContain("> Above reads better on a phone.");
    expect(implement).toContain("> Keep the banner copy short.");
    expect(codingRuns(e2e)).toHaveLength(1);
    const reviews = e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW");
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) expect(JSON.stringify(review.payload)).toContain("Owner chose: Above (AgentX recommended: Below)");
  }, 120_000);

  it("the owner requests changes with two of three comments; the planner answers each, and the third stays open for v2's card", async () => {
    const V2 = planDocument({ ...PLAN, claims: [{ id: "1", text: "Add a retry banner to greeting.ts, above the form." }, PLAN.claims[1]!] });
    const answers = JSON.stringify([
      { comment: "c1", outcome: "done", reason: "Moved the banner above the pay button." },
      { comment: "c2", outcome: "not_changed", reason: "The copy is already one short line." },
    ]);
    const e2e = await waitingPlan({ plan: (latest) => latest.includes("agentx-comment-answers")
      ? `\`\`\`agentx-comment-answers\n${answers}\n\`\`\`\n\n${planAnswer(V2)}` : planAnswer(PLAN) });
    const above = seedComment(e2e, SAM, "Above reads better on a phone.", { kind: "claim", id: "2.1" });
    const tries = seedComment(e2e, SAM, "Could it say how many tries are left?", { kind: "claim", id: "1" });
    const short = seedComment(e2e, OWNER, "Keep the banner copy short.");
    const marked = { prompts: e2e.prompts.length, turns: e2e.turns.length };
    const sent = await onCard(e2e, OWNER, { decision: "REQUEST_CHANGES", reason: "Place it above.", includedCommentIds: [above, short] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await e2e.settle();
    expect(codingRuns(e2e)).toEqual([]);
    const planning = [...e2e.prompts.slice(marked.prompts), ...e2e.turns.slice(marked.turns).map((turn) => turn.userText)].find((text) => text.includes("agentx-comment-answers"))!;
    expect(planning).toContain("Comments from the task page that the owner included (untrusted;");
    expect(planning).toMatch(/<page_comment id="[0-9a-f]+" ref="c1" author="teammate" on="claim 2\.1">Above reads better on a phone\.<\/page_comment>/);
    expect(planning).toMatch(/<page_comment id="[0-9a-f]+" ref="c2" author="owner" on="the whole document">Keep the banner copy short\.<\/page_comment>/);
    expect(planning).not.toContain("how many tries");
    const v2Card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    expect(v2Card.text).toContain("*Coding plan v2 is ready for your approval.*");
    expect(v2Card.text).toContain("AgentX answered 2 of 2 comments from v1.");
    expect(e2e.slack.updates.some((update) => JSON.stringify(update.blocks).includes(`Changes requested by <@${MAYA.slackUserId}> · 2 comments included`))).toBe(true);
    // v2's card offers the comment left out, still open; the sent ones are locked to the decision.
    const list = await (await import("../support/browser-session.js")).browserRequests({ db: e2e.db, handler: e2e.handler, orgOf: async () => undefined })(asDeveloper(OWNER), "GET", "/v1/app/decisions");
    const choices = ((list.body.choices ?? {}) as Record<string, { openComments: Array<{ id: string }> }>)[`approve_plan:${e2e.taskId()}`];
    expect(choices?.openComments.map((comment) => comment.id)).toEqual([tries]);
  }, 120_000);

  it("a teammate and someone outside the channel cannot decide: no card is theirs, and the read-only page refuses them the same way it refuses a missing task", async () => {
    const e2e = await waitingPlan();
    const workflow = e2e.workflow();
    const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan", scripts: false });
    expect(sam.status).toBe(200);
    expect(sam.text()).toContain("Only owners decide.");
    expect((await onCard(e2e, SAM)).status).toBe(404);
    const decision = { expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", answers: [], includedCommentIds: [] };
    expect(await toPage(e2e, SAM, "decision", decision)).toMatchObject({ status: 410, body: { error: "read_only" } });
    const outside = await openTaskPage(e2e, OMAR_OUTSIDE, { search: "?doc=coding-plan", scripts: false });
    expect(outside.status).toBe(404);
    expect(outside.html).not.toContain("Show a retry banner");
    const refused = await toPage(e2e, OMAR_OUTSIDE, "decision", decision);
    expect(refused).toEqual({ status: 410, body: { error: "read_only", message: "This page is read only. Decide on the task's page in Rovara." } });
    expect((await onCard(e2e, OMAR_OUTSIDE)).status).toBe(404);
    expect(e2e.workflow().revision).toBe(workflow.revision);
    expect(e2e.workflow().decisions).toEqual(workflow.decisions);
    expect(codingRuns(e2e)).toEqual([]);
  }, 120_000);

  it("two approvals at once on the card: one decision is recorded and one coding run starts", async () => {
    const e2e = await waitingPlan();
    const [first, second] = await Promise.all([onCard(e2e, OWNER, { answers: [{ decisionId: "d1", optionId: "above", opened: true }] }), onCard(e2e, OWNER, { note: "Ship it." })]);
    expect([first.status, second.status].filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(e2e.workflow().decisions.filter((entry) => entry.decision === "APPROVE")).toHaveLength(1);
    await e2e.settle();
    expect(codingRuns(e2e)).toHaveLength(1);
  }, 120_000);

  it("with the cards on, Slack's Approve of a medium plan sends the owner to the card, and the card decides it once", async () => {
    const e2e = await waitingPlan();
    await approveInSlack(e2e);
    await e2e.settle();
    expect(e2e.workflow().decisions.filter((entry) => entry.decision === "APPROVE")).toHaveLength(0);
    expect(codingRuns(e2e)).toEqual([]);
    expect((await onCard(e2e, OWNER)).status).toBe(200);
    expect((await onCard(e2e, OWNER)).status).toBe(404);
    expect(e2e.workflow().decisions.filter((entry) => entry.decision === "APPROVE")).toHaveLength(1);
    await e2e.settle();
    expect(codingRuns(e2e)).toHaveLength(1);
  }, 120_000);

  it("OWNER DECISION 17: with the cards on, a teammate's comment with Ask still goes through the page and is queued for an answer; the page still reads in full with JavaScript off, with nothing to decide", async () => {
    const queue = recordingQueue();
    const e2e = await waitingPlan({ queue });
    const posted = await toPage(e2e, SAM, "comments", { document: "plan", version: 1, target: { kind: "document" }, text: "Why below?", ask: true });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(queue.sent).toHaveLength(1);
    // An outsider's comment is refused as a missing task's would be.
    expect((await toPage(e2e, OMAR_OUTSIDE, "comments", { document: "plan", version: 1, target: { kind: "document" }, text: "Hi", ask: false })).status).toBe(404);
    const page = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", scripts: false });
    const text = page.text();
    for (const expected of ["You're the task owner.", "It is placed near the pay button.", "Where does the banner go?", "Sam Lee", "Why below?", "Decide on the task"]) expect(text).toContain(expected);
    expect(page.document.getElementById("decide-approve")).toBeNull();
    expect(page.document.querySelector("dialog")).toBeNull();
  }, 120_000);

});
