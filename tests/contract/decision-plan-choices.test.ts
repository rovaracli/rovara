// OWNER DECISION 7 items 1 to 5 and 9 (suggestions shown): what the old review page could decide about a requirements or coding plan now lives on the plan's decision card on the task page, and goes
// through the same workflow decision (`decideTaskWorkflow`) Slack, MCP and the old page used: the person's answers to the document's questions, the optional checks to run, the open comments sent with
// Approve or Request changes, and a free note. The card shows those choices (and the work breakdown Approve binds to); the route refuses them on any other kind; the workflow decision checks each one.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commentKey } from "../../packages/broker/src/developer/page-comments.js";
import { DECISION_COMMENTS_MAX, PAGE_NOTE_MAX_CHARS } from "../../packages/contracts/src/task-comments.js";
import { DECISION_PLAN_COMMENTS_MAX, DECISION_PLAN_NOTE_MAX, DecisionApproveBodySchema, planChoicesProblem } from "../../packages/contracts/src/decision-card-tabs.js";
import { browserRequests } from "../support/browser-session.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });

type Card = { id: string; kind: string; risk: string };
type Choices = { questions: Array<{ id: string; question: string; recommended: string; options: Array<{ id: string; label: string }>; suggested?: Array<{ optionId: string; name: string }> }>; optionalChecks: Array<{ id: string; selected: boolean }>; openComments: Array<{ id: string; excerpt: string }> };

async function world() {
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
  const web = browserRequests(h);
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: { revision: number; stage: string; state: string; reviewPhase?: string; artifacts: Array<{ sha256: string; version: number; type: string }>; decisions: Array<Record<string, unknown>> } };
  const operationWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => String(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter(predicate).at(-1)!.id);
  const planned = async (path: "QUICK" | "FULL" = "QUICK") => {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: path });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(meta(taskId).workspaceId);
    await h.finish(workspaceId, operationWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const planning = operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    await h.artifact(workspaceId, planning, "plan.md", planAnswer(planDocument()));
    await h.finish(workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    return taskId;
  };
  /** A person comment, open on the waiting document, as the old review page stored it. */
  const comment = (taskId: string, text: string, who: Developer = OMAR) => {
    const workflow = meta(taskId).workflow, artifact = workflow.artifacts.at(-1)!;
    const commentId = randomUUID();
    h.db.set({ ...commentKey(taskId, commentId), entityType: "TASK_COMMENT", schemaVersion: 1, taskId, commentId, document: artifact.type, version: artifact.version, target: { kind: "document" },
      author: { kind: "person", developerId: who.developerId, name: who.name, owner: who === MAYA }, text, createdAt: new Date().toISOString(), rev: 1 });
    return commentId;
  };
  const cardOf = async (taskId: string, who: Developer = MAYA) => {
    const list = await web(who, "GET", "/v1/app/decisions");
    const card = ((list.body.cards ?? []) as Card[]).find((candidate) => candidate.id.endsWith(`:${taskId}`));
    if (card === undefined) return undefined;
    return { card, digest: (list.body.digests as Record<string, string>)[card.id]!, choices: ((list.body.choices ?? {}) as Record<string, Choices>)[card.id] };
  };
  /** Opens the evidence of a medium card (its server-side friction), then answers the path of one of its actions. */
  const press = async (taskId: string, action: "approve" | "request-changes", body: Record<string, unknown>, who: Developer = MAYA) => {
    const shown = (await cardOf(taskId, who))!;
    const base = `/v1/app/decisions/${shown.card.id.replace(":", "/")}`;
    if (shown.card.risk === "medium") expect((await web(who, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: shown.digest })).status).toBe(200);
    return web(who, "POST", `${base}/${action}`, { requestId: randomUUID(), shownDigest: shown.digest, ...body });
  };
  return { h, web, meta, planned, comment, cardOf, press };
}

describe("OWNER DECISION 7: a plan's choices on its decision card", () => {
  it("keeps the contract's limits equal to the workflow decision's own", () => {
    expect(DECISION_PLAN_COMMENTS_MAX).toBe(DECISION_COMMENTS_MAX);
    expect(DECISION_PLAN_NOTE_MAX).toBe(PAGE_NOTE_MAX_CHARS);
    const base = { requestId: randomUUID(), shownDigest: "a".repeat(64) };
    expect(DecisionApproveBodySchema.safeParse({ ...base, note: "Two lines\nof note" }).success).toBe(true);
    expect(DecisionApproveBodySchema.safeParse({ ...base, note: "hidden​mark" }).success).toBe(false);
    expect(DecisionApproveBodySchema.safeParse({ ...base, answers: [{ decisionId: "d1", optionId: "five", opened: true }, { decisionId: "d1", optionId: "three", opened: true }] }).success, "each question once").toBe(false);
    // The plan fields belong to the requirements and coding plan cards only, optional checks to the coding plan only: refused, never dropped.
    expect(planChoicesProblem("merge", { note: "x" })).toBe("note: this card takes no note");
    expect(planChoicesProblem("approve_design", { includedCommentIds: [] })).toBe("includedCommentIds: this card takes no includedCommentIds");
    expect(planChoicesProblem("approve_requirements", { selectedOptionalCheckIds: ["lint"] })).toBe("selectedOptionalCheckIds: only a coding plan has optional checks");
    expect(planChoicesProblem("approve_plan", { answers: [], selectedOptionalCheckIds: [], includedCommentIds: [], note: "x" })).toBeUndefined();
    expect(planChoicesProblem("merge", {})).toBeUndefined();
  });

  it("shows the plan's questions, AgentX's answer, the suggestions on this version and the open comments, in the card's digest", async () => {
    const t = await world();
    const taskId = await t.planned();
    const before = (await t.cardOf(taskId))!;
    expect(before.card.kind).toBe("approve_plan");
    expect(before.choices?.questions).toEqual([{ id: "d1", question: "How many times should a payment be retried?", recommended: "three", options: [{ id: "three", label: "Three times" }, { id: "five", label: "Five times" }] }]);
    expect(before.choices?.openComments).toEqual([]);
    const commentId = t.comment(taskId, "Please keep the old export too.");
    const workflow = t.meta(taskId).workflow, artifact = workflow.artifacts.at(-1)!;
    t.h.db.set({ pk: `DEVTASK#${taskId}`, sk: `SUGGEST#plan#d1#${OMAR.developerId}`, entityType: "TASK_SUGGESTION", document: "plan", decisionId: "d1", developerId: OMAR.developerId, optionId: "five", name: OMAR.name, artifactSha256: artifact.sha256, version: artifact.version, at: new Date().toISOString(), rev: 1 });
    const after = (await t.cardOf(taskId))!;
    expect(after.choices?.openComments).toEqual([{ id: commentId, excerpt: "Please keep the old export too." }]);
    expect(after.choices?.questions[0]?.suggested).toEqual([{ optionId: "five", name: OMAR.name }]);
    expect(after.digest, "a new comment changes what is shown").not.toBe(before.digest);
    // Someone else never sees the owner's card, nor its choices.
    seedMembership(t.h.db, OMAR.developerId, { orgId: TEST_ORG, role: "member" });
    expect(await t.cardOf(taskId, OMAR)).toBeUndefined();
  });

  it("approves with the person's answers, the comments they kept and a note, through the one workflow decision", async () => {
    const t = await world();
    const taskId = await t.planned();
    const kept = t.comment(taskId, "Keep the old export too.");
    const left = t.comment(taskId, "Maybe later: rename the queue.");
    const approved = await t.press(taskId, "approve", { answers: [{ decisionId: "d1", optionId: "five", opened: true }], includedCommentIds: [kept], note: "Five is what support asked for." });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const decision = t.meta(taskId).workflow.decisions.at(-1)!;
    expect(decision).toMatchObject({ decision: "APPROVE", reason: "Five is what support asked for.", answerOverrides: [expect.objectContaining({ decisionId: "d1", optionId: "five" })], commentsIncluded: 1 });
    expect(t.meta(taskId).workflow.stage).toBe("IMPLEMENT");
    // The kept comment is locked to the decision; the one left out stays open for the next version.
    expect(t.h.db.get(commentKey(taskId, kept).pk, commentKey(taskId, kept).sk)).toMatchObject({ lockedBy: { decision: "APPROVE" } });
    expect(t.h.db.get(commentKey(taskId, left).pk, commentKey(taskId, left).sk)?.lockedBy).toBeUndefined();
    const detail = t.h.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("DECISION#"));
    expect(detail).toMatchObject([{ includedCommentIds: [kept], note: "Five is what support asked for." }]);
  });

  it("refuses an answer the document does not offer, and a comment that is not open: nothing is decided", async () => {
    const t = await world();
    const taskId = await t.planned();
    const wrong = await t.press(taskId, "approve", { answers: [{ decisionId: "d1", optionId: "seven", opened: true }] });
    expect(wrong.status, JSON.stringify(wrong.body)).toBeGreaterThanOrEqual(400);
    const unknown = await t.press(taskId, "approve", { includedCommentIds: [randomUUID()] });
    expect(unknown.status, JSON.stringify(unknown.body)).toBeGreaterThanOrEqual(400);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", decisions: [] });
    // Positive control: the plain approval goes on.
    expect((await t.press(taskId, "approve", {})).status).toBe(200);
  });

  it("sends the document back with the reason and the review comments the person kept", async () => {
    const t = await world();
    const taskId = await t.planned();
    const kept = t.comment(taskId, "The retry must not double-charge.");
    const sent = await t.press(taskId, "request-changes", { reason: "Handle the double charge.", includedCommentIds: [kept] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(t.meta(taskId).workflow.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Handle the double charge.", commentsIncluded: 1 });
    expect(t.h.db.get(commentKey(taskId, kept).pk, commentKey(taskId, kept).sk)).toMatchObject({ lockedBy: { decision: "REQUEST_CHANGES" } });
  });

  it("refuses optional checks on a requirements card before anything is decided, and takes its note", async () => {
    const t = await world();
    const taskId = await t.planned("FULL");
    expect(t.meta(taskId).workflow).toMatchObject({ reviewPhase: "REQUIREMENTS" });
    const checks = await t.press(taskId, "approve", { selectedOptionalCheckIds: ["lint"] });
    expect(checks.status).toBe(400);
    expect(JSON.stringify(checks.body)).toContain("only a coding plan has optional checks");
    expect(t.meta(taskId).workflow.decisions).toEqual([]);
    // A requirements card takes answers and a note.
    const approved = await t.press(taskId, "approve", { note: "Requirements look right." });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(t.meta(taskId).workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE", reason: "Requirements look right." });
  });
});
