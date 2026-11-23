// Cloud's PR feedback routes (CLOUD-HALF "Private app implementation"): Code's feedback read, decision and retry, passed on as the person with the body
// checked against Code's own request schemas. Code decides who may (owner or explicitly authorized co-owner), the bindings, the selection and the money.
import { readFileSync } from "node:fs";
import { WorkflowFeedbackFindingsDecisionRequestSchema } from "@agentx/contracts";
import { expect, it, vi } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { feedbackChoice, sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { companyScopedWork, LocalWorkSessionStore } from "../../packages/cloud-server/src/work-sessions.js";

const id = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111", owner = "a".repeat(64), other = "b".repeat(64), digest = "1".repeat(64);
const record = { sessionId: id, taskId, project: "payments", owner: { developerId: owner, name: "Priya" }, startedBy: { developerId: owner, name: "Priya" }, createdAt: "2026-11-22T00:00:00Z", revision: 1, companyId: "acme" };
const task = (workflow: object = {}): CodeTask => ({ taskId, title: "Add refunds endpoint", project: "payments", status: "SUCCEEDED", createdAt: record.createdAt, updatedAt: record.createdAt, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 7, feedbackReview: { status: "PENDING" }, ...workflow } } as CodeTask);
const keep = { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: 7, reviewDigest: digest, proposalDigest: "2".repeat(64), bundleDigests: ["3".repeat(64)], decision: "DISMISS", selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." };

async function setup(options: { path: string; method: "GET" | "POST"; body?: unknown; answer?: unknown; failure?: CodeError; company?: string; who?: string; coOwner?: boolean } ) {
 const store = new LocalWorkSessionStore();await store.put(record);
 const json = vi.fn(async (_session: unknown, path: string, init?: { method?: string }) => {
  if (path.endsWith("/people")) return { view: { revision: 1, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "33333333-3333-4333-8333-333333333333", name: "Ana", role: options.coOwner ? "owner" : "viewer", effectiveRole: options.coOwner ? "owner" : "viewer", you: true }] } };
  if (path.includes("/workflow/feedback") || init?.method === "POST") { if (options.failure !== undefined) throw options.failure;return options.answer; }
  return { task: task() };
 });
 const context = { client: { json }, session: { access: { developerId: options.who ?? owner, displayName: "Priya" } }, params: [id], body: options.body, work: companyScopedWork(store, () => options.company ?? "acme"), presence: { viewing: async () => [] }, now: () => new Date(record.createdAt), origin: "https://cloud.example.test" } as unknown as RouteContext;
 const route = ROUTES.filter(r => r.method === options.method && r.path.test(options.path));expect(route).toHaveLength(1);
 const code = () => json.mock.calls.filter(([, path]) => path.includes("/workflow/feedback"));
 return { json, code, act: async () => { try { return await route[0]!.answer(context); } catch (error) { if (error instanceof CodeError) return { status: error.status, body: error.body };throw error; } } };
}

it("GET feedback passes Code's { review } on unchanged, as the person", async () => {
 const review = { taskId, revision: 7, status: "PENDING", reportStatus: "FAILED", reviewDigest: digest, bundleDigests: ["3".repeat(64)] };
 const s = await setup({ method: "GET", path: `/sessions/${id}/feedback`, answer: { review } });
 expect(await s.act()).toEqual({ status: 200, body: { review } });
 expect(s.code()).toEqual([[expect.anything(), `/v1/dev/tasks/${taskId}/workflow/feedback`, { headers: { "x-agentx-task-view": "2" } }]]);
});
it("GET feedback refuses an answer about another task, and keeps Code's own refusal (collecting is Code's 404)", async () => {
 expect((await (await setup({ method: "GET", path: `/sessions/${id}/feedback`, answer: { review: { taskId: "99999999-9999-4999-8999-999999999999" } } })).act()).status).toBe(502);
 expect((await (await setup({ method: "GET", path: `/sessions/${id}/feedback`, answer: {} })).act()).status).toBe(502);
 const missing = await setup({ method: "GET", path: `/sessions/${id}/feedback`, failure: new CodeError(404, { error: { code: "NOT_FOUND", message: "PR feedback review not found" } }) });
 expect(await missing.act()).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "PR feedback review not found" } } });
});
it("another company's session is absent before any Code call", async () => {
 for (const [method, path, body] of [["GET", `/sessions/${id}/feedback`, undefined], ["POST", `/sessions/${id}/feedback-decision`, keep], ["POST", `/sessions/${id}/feedback-retry`, { reviewDigest: digest }]] as const) {
  const s = await setup({ method, path, body, company: "elsewhere" });
  expect((await s.act()).status).toBe(404);expect(s.json).not.toHaveBeenCalled();
 }
});
it("POST feedback-decision sends exactly the checked body and answers the session Code's returned task makes", async () => {
 const s = await setup({ method: "POST", path: `/sessions/${id}/feedback-decision`, body: keep, answer: { task: task({ feedbackReview: { status: "DISMISSED" }, revision: 8 }) } });
 const result = await s.act();
 expect(result.status).toBe(200);
 expect(s.code()).toEqual([[expect.anything(), `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, { method: "POST", headers: { "x-agentx-task-view": "2" }, body: keep }]]);
 expect(WorkflowFeedbackFindingsDecisionRequestSchema.parse((s.code()[0]![2] as { body: unknown }).body)).toEqual(keep);
 expect((result.body as { session: { body: { task: { workflow: { revision: number } } } } }).session.body.task.workflow.revision).toBe(8);
});
it("POST feedback-decision refuses a malformed or extended body without asking Code", async () => {
 for (const body of [undefined, {}, { ...keep, extra: 1 }, { ...keep, ownerNote: undefined }, { ...keep, decision: "APPROVE" }, { ...keep, bundleDigests: [] }, { ...keep, selectedFindingIds: Array.from({ length: 129 }, (_, index) => "f" + String(index)), decision: "APPROVE", ownerNote: undefined }]) {
  const s = await setup({ method: "POST", path: `/sessions/${id}/feedback-decision`, body });
  expect((await s.act()).status).toBe(400);expect(s.code()).toHaveLength(0);
 }
});
it("POST feedback-decision keeps Code's refusal and refuses an answer about another task", async () => {
 const refused = await setup({ method: "POST", path: `/sessions/${id}/feedback-decision`, body: keep, failure: new CodeError(400, { error: { code: "CONFIG_INVALID", message: "The feedback changed since this card; a new review is starting." } }) });
 expect(await refused.act()).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "The feedback changed since this card; a new review is starting." } } });
 const wrong = await setup({ method: "POST", path: `/sessions/${id}/feedback-decision`, body: keep, answer: { task: { ...task(), taskId: "99999999-9999-4999-8999-999999999999" } } });
 expect((await wrong.act()).status).toBe(502);
});
it("POST feedback-retry sends exactly { reviewDigest } and answers { session, started }", async () => {
 for (const started of [true, false]) {
  const s = await setup({ method: "POST", path: `/sessions/${id}/feedback-retry`, body: { reviewDigest: digest }, answer: { task: task(), started } });
  const result = await s.act();
  expect(result.status).toBe(200);expect((result.body as { started: boolean }).started).toBe(started);
  expect(s.code()).toEqual([[expect.anything(), `/v1/dev/tasks/${taskId}/workflow/feedback-retry`, { method: "POST", headers: { "x-agentx-task-view": "2" }, body: { reviewDigest: digest } }]]);
 }
 for (const answer of [{ task: task() }, { task: task(), started: "yes" }]) expect((await (await setup({ method: "POST", path: `/sessions/${id}/feedback-retry`, body: { reviewDigest: digest }, answer })).act()).status).toBe(502);
 for (const body of [{}, { reviewDigest: "x" }, { reviewDigest: digest, requestId: "22222222-2222-4222-8222-222222222222" }]) {
  const s = await setup({ method: "POST", path: `/sessions/${id}/feedback-retry`, body });
  expect((await s.act()).status).toBe(400);expect(s.code()).toHaveLength(0);
 }
});
it("a live co-owner is offered the choice while a feedback review waits; a viewer is not", async () => {
 expect(feedbackChoice(task())).toBe(true);
 expect(feedbackChoice(task({ feedbackReview: { status: "COLLECTING" } }))).toBe(false);
 expect(feedbackChoice(task({ feedbackReview: { status: "APPROVED" }, fixSource: "feedback", stage: "VERIFY", state: "BLOCKED" }))).toBe(true);
 expect(feedbackChoice(task({ feedbackReview: { status: "APPROVED" }, fixSource: "conflict", stage: "VERIFY", state: "BLOCKED" }))).toBe(false);
 for (const coOwner of [true, false]) {
  const s = await setup({ method: "GET", path: `/sessions/${id}`, who: other, coOwner });
  const view = ((await s.act()).body as { session: { you: { coOwner?: boolean } } }).session;
  expect(view.you.coOwner === true).toBe(coOwner);
 }
 expect(sessionView(record, task(), { developerId: other }, "https://cloud.example.test").you.coOwner).toBeUndefined();
});

// Controller ruling 2026-11-23: a live co-owner sees the money strip exactly as the owner does, from the versioned money Code served; only a read Code gave no money shows none.
it("a live co-owner is shown the money Code served; someone who is neither owner nor co-owner is not; a read without money shows none; legacy figures stay hidden", () => {
 const sample = (JSON.parse(readFileSync(new URL("../../contracts/shared/task-money.v1.json", import.meta.url), "utf8")) as { examples: Array<Record<string, unknown>> }).examples[0]!;
 const withMoney = { ...task(), money: { ...sample, taskId }, spent: { usd: 999 }, runEstimate: { lowUsd: 4.37, highUsd: 10.19 } } as unknown as CodeTask;
 const viewer = { developerId: other }, view = (t: CodeTask, extras: { coOwner?: boolean }) => sessionView(record, t, viewer, "https://cloud.example.test", undefined, extras);
 expect(view(withMoney, { coOwner: true }).money).toMatchObject({ taskId });
 expect(view(withMoney, {}).money).toBeUndefined();
 expect(view(task(), { coOwner: true }).money).toBeUndefined();
 expect(view({ ...withMoney, money: { ...sample, taskId: "99999999-9999-4999-8999-999999999999" } }, { coOwner: true }).money).toBeUndefined();
 const shown = JSON.stringify(view(withMoney, { coOwner: true }));
 expect(shown).not.toContain("999");expect(shown).not.toContain("4.37");
 expect(sessionView(record, withMoney, { developerId: owner }, "https://cloud.example.test").money).toMatchObject({ taskId });
});
