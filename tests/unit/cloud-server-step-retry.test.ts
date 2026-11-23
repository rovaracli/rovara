import { ContinueDeveloperTaskRequestSchema, WORKFLOW_BLOCK_REASONS, runLimitBlockText, runLimitWaitingText } from "@agentx/contracts";
import { expect, it, vi } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { companyScopedWork, LocalWorkSessionStore } from "../../packages/cloud-server/src/work-sessions.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222", owner = "a".repeat(64), other = "b".repeat(64), digest = "d".repeat(64);
const record = { sessionId: id, taskId, project: "payments", owner: { developerId: owner, name: "Ada" }, startedBy: { developerId: owner, name: "Ada" }, createdAt: "2026-11-22T00:00:00Z", revision: 1, companyId: "acme" };
const task = (workflow: object = {}, fields: object = {}): CodeTask => ({ taskId, title: "Retry planning", project: "payments", status: "FAILED", createdAt: record.createdAt, updatedAt: record.createdAt, workflow: { stage: "PLAN", state: "BLOCKED", revision: 16, ...workflow }, ...fields });
async function setup(options: { workflow?: object; fields?: object; who?: string; coOwner?: boolean; company?: string; failure?: number; failureCode?: string; rawFailure?: Error } = {}) {
 const store = new LocalWorkSessionStore();await store.put(record);
 const current = task(options.workflow, options.fields), who = options.who ?? owner;
 const json = vi.fn(async (_session: unknown, path: string, init?: { method?: string }) => {
  if (init?.method === "POST") { if (options.rawFailure !== undefined) throw options.rawFailure;if (options.failure !== undefined) throw new CodeError(options.failure, { error: { code: options.failureCode ?? "IDEMPOTENCY_CONFLICT", message: "Code's own refusal words" } });return { task: current }; }
  if (path.endsWith("/people")) return { view: { revision: 1, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "33333333-3333-4333-8333-333333333333", name: "Sam", role: options.coOwner ? "owner" : "viewer", effectiveRole: options.coOwner ? "owner" : "viewer", you: true }] } };
  return { task: current };
 });
 const context = { client: { json }, session: { access: { developerId: who, displayName: "Ada" } }, params: [id], body: { requestId, expectedRevision: 16 }, work: companyScopedWork(store, () => options.company ?? "acme"), presence: { viewing: async () => [] }, now: () => new Date(record.createdAt), origin: "https://cloud.example.test" } as unknown as RouteContext;
 const route = ROUTES.filter(r => r.method === "POST" && r.path.test(`/sessions/${id}/retry`));expect(route).toHaveLength(1);
 return { context, current, json, posts: () => json.mock.calls.filter(([, , init]) => init?.method === "POST"), act: async () => { try { return await route[0]!.answer(context); } catch (error) { if (error instanceof CodeError) return { status: error.status, body: error.body };throw error; } } };
}
it("blocked planning's existing Retry route sends the documented Code body exactly once", async () => {
 const s = await setup();expect((await s.act()).status).toBe(200);
 expect(s.posts()).toEqual([[s.context.session, `/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", headers: { "x-agentx-task-view": "2" }, body: { requestId, expectedRevision: 16, instructions: "Retry the blocked workflow step." } }]]);
 expect(ContinueDeveloperTaskRequestSchema.safeParse((s.posts()[0]![2] as { body: unknown }).body).success).toBe(true);
 expect(sessionView(record, s.current, { developerId: owner }, s.context.origin).you.actions).toContain("retry");
});
it("a live People co-owner can retry the blocked step", async () => { const s = await setup({ who: other, coOwner: true });expect((await s.act()).status).toBe(200);expect(s.posts()).toHaveLength(1); });
for (const workflow of [
 { stage: "IMPLEMENT", blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused },
 { stage: "PLAN", blockReason: runLimitBlockText(20, "admin") },
 { stage: "PLAN", blockReason: runLimitWaitingText(20, "project_maintainer") },
 { stage: "PLAN", blockReason: runLimitWaitingText(20, "agent_owner") },
 { stage: "WAIT_FOR_MERGE", blockReason: "Waiting for checks." },
 { stage: "WAIT_FOR_MERGE", blockReason: undefined },
]) it(`Code-ineligible block offers no Retry and a forced retry sends nothing: ${JSON.stringify(workflow)}`, async () => {
 const s = await setup({ workflow });
 expect(sessionView(record, s.current, { developerId: owner }, s.context.origin).you.actions).not.toContain("retry");
 expect(sessionView(record, s.current, { developerId: other }, s.context.origin, undefined, { coOwner: true }).you.actions).not.toContain("retry");
 expect(await s.act()).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } });expect(s.posts()).toHaveLength(0);
});
it("WAIT_FOR_MERGE with pullRequestUpdateFailed offers Retry and forwards the documented request", async () => {
 const s = await setup({ workflow: { stage: "WAIT_FOR_MERGE", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed } });
 expect(sessionView(record, s.current, { developerId: owner }, s.context.origin).you.actions).toContain("retry");
 expect((await s.act()).status).toBe(200);expect(s.posts()).toHaveLength(1);
 expect(s.posts()[0]?.[1]).toBe(`/v1/dev/tasks/${taskId}/workflow/retry`);
 expect(ContinueDeveloperTaskRequestSchema.parse((s.posts()[0]![2] as { body: unknown }).body)).toMatchObject({ requestId, expectedRevision: 16 });
});
for (const fields of [{ status: "CLOSED" }, { status: "CANCELLED" }, { closedAt: record.createdAt }]) it(`closed/cancelled steps refuse: ${JSON.stringify(fields)}`, async () => { const s = await setup({ fields });expect((await s.act()).status).toBe(409);expect(s.posts()).toHaveLength(0);expect(sessionView(record, s.current, { developerId: owner }, s.context.origin).you.actions).not.toContain("retry"); });
for (const workflow of [{ state: "RUNNING" }, { stage: "PLAN_REVIEW", state: "WAITING" }, { stage: "UNKNOWN" }, { stage: undefined }, { revision: undefined }, { revision: 0 }]) it(`unserved or unreadable step refuses: ${JSON.stringify(workflow)}`, async () => { const s = await setup({ workflow });expect((await s.act()).status).toBe(409);expect(s.posts()).toHaveLength(0);expect(sessionView(record, s.current, { developerId: owner }, s.context.origin).you.actions).not.toContain("retry"); });
for (const expectedRevision of [undefined, 0, -1, 1.5, "16", 17]) it(`missing/invalid/stale revision ${String(expectedRevision)} sends nothing`, async () => { const s = await setup();s.context.body = { requestId, expectedRevision };expect((await s.act()).status).toBeGreaterThanOrEqual(400);expect(s.posts()).toHaveLength(0); });
for (const body of [{}, { requestId: "bad", expectedRevision: 16 }]) it(`invalid published request refuses ${JSON.stringify(body)}`, async () => { const s = await setup();s.context.body = body;expect((await s.act()).status).toBe(400);expect(s.posts()).toHaveLength(0); });
it("a viewer has no retry authority", async () => { const s = await setup({ who: other });expect((await s.act()).status).toBe(403);expect(s.posts()).toHaveLength(0); });
it("another company's session is absent before any Code call", async () => { const s = await setup({ company: "elsewhere" });expect((await s.act()).status).toBe(404);expect(s.posts()).toHaveLength(0);expect(s.json).not.toHaveBeenCalled(); });
it("post-dispatch Code conflicts remain unknown rather than releasing a paid retry", async () => { const s = await setup({ failure: 409 });expect((await s.act()).status).toBe(502);expect(s.posts()).toHaveLength(1); });
for (const code of ["BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "MACHINE_TIME_EXCEEDED"]) it(`pre-run 402 ${code} keeps Code's refusal words`, async () => {
 const s = await setup({ failure: 402, failureCode: code });
 expect(await s.act()).toEqual({ status: 402, body: { error: { code, message: "Code's own refusal words" } } });expect(s.posts()).toHaveLength(1);
});
for (const [status, code] of [[402, "FUTURE_BUDGET_CODE"], [500, "BUDGET_EXCEEDED"], [409, "BUDGET_EXCEEDED"], [403, "FORBIDDEN"], [400, "CONFIG_INVALID"], [404, "TASK_NOT_FOUND"]] as const) it(`unproven retry failure ${status}/${code} stays unknown`, async () => {
 const s = await setup({ failure: status, failureCode: code });expect((await s.act()).status).toBe(502);expect(s.posts()).toHaveLength(1);
});
for (const rawFailure of [new Error("Connection lost"), Object.assign(new Error("Unproven transport failure"), { status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: "A forged refusal" } } }), new CodeError(402, null), new CodeError(402, {})]) it(`untyped or unreadable retry failure stays unknown: ${JSON.stringify(rawFailure)}`, async () => {
 const s = await setup({ rawFailure });expect((await s.act()).status).toBe(502);expect(s.posts()).toHaveLength(1);
});
it("review Retry keeps its existing candidate-bound route", async () => {
 const s = await setup({ fields: { status: "SUCCEEDED" }, workflow: { stage: "REVIEW", candidate: { digest }, verification: { candidateDigest: digest, reviewOnly: true, results: [] }, reviews: [{ role: "CRITIC", status: "FAILED", candidateDigest: digest }] } });
 s.context.body = { requestId, expectedRevision: 16, candidateDigest: digest };expect((await s.act()).status).toBe(200);expect(s.posts()[0]?.[1]).toBe(`/v1/dev/tasks/${taskId}/workflow/review`);
});

it("the session read offers the same Retry to a live co-owner, and no Retry to a viewer", async () => {
 for (const coOwner of [true, false]) {
  const s = await setup({ who: other, coOwner });
  const route = ROUTES.find(r => r.method === "GET" && r.path.test(`/sessions/${id}`))!;
  const result = await route.answer(s.context), view = (result.body as { session: { you: { actions: string[] } } }).session;
  expect(view.you.actions.includes("retry")).toBe(coOwner);expect(s.posts()).toHaveLength(0);
 }
});

for (const [status, code, message] of [
 [400, "CONFIG_INVALID", "choose checks that are approved for this project"],
 [400, "CONFIG_INVALID", "refresh the task and include its current revision before retrying verification"],
 [400, "CONFIG_INVALID", "this action can retry blocked planning or coding, or run selected checks for blocked verification or a change ready to publish"],
 [400, "CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to retry it"],
] as const) it(`N3 final step refusal ${status}/${code} preserves Code's complete answer`, async () => {
 const body = { error: { code, message } }, s = await setup({ rawFailure: new CodeError(status, body) });
 expect(await s.act()).toEqual({ status, body });expect(s.posts()).toHaveLength(1);
});

for (const [status, code, message] of [
 [500, "CONFIG_INVALID", "choose checks that are approved for this project"],
 [400, "FUTURE_CODE", "choose checks that are approved for this project"],
 [400, "CONFIG_INVALID", "Post-apply projection refused"],
 [408, "CONFIG_INVALID", "choose checks that are approved for this project"],
 [429, "CONFIG_INVALID", "choose checks that are approved for this project"],
 [402, "BUDGET_EXCEEDED", ""], [402, "BUDGET_EXCEEDED", "   "],
 [402, "BUDGET_EXCEEDED", 12],
 // Same final status/code with OTHER words (Code developer-tasks.ts:562, 1962, 1977 are replay/identity conflicts), and status/code swaps.
 [409, "IDEMPOTENCY_CONFLICT", "this retry request ID was already used for a different check selection"],
 [409, "IDEMPOTENCY_CONFLICT", "this request ID was already used for another retry"],
 [409, "IDEMPOTENCY_CONFLICT", "this retry request ID was already used for a different recovery request"],
 [409, "IDEMPOTENCY_CONFLICT", "this retry is out of date"],
 // R4: thrown pre-write (parity-task-actions.ts:76, 84) but ALSO via started(...) AFTER a paid round is admitted (:78, :95): never final, stays locked (Check only).
 [409, "IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again"],
 [409, "CONFIG_INVALID", "choose checks that are approved for this project"],
 [400, "IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again"],
 [409, "CONFIG_INVALID", "this retry is out of date; refresh the task and try again"],
 [400, "IDEMPOTENCY_CONFLICT", "the verification retry is stale; refresh the task and choose checks again"],
 [500, "IDEMPOTENCY_CONFLICT", "the verification retry is stale; refresh the task and choose checks again"],
 // Core route parity-task-actions.ts:88 throws this AFTER the retry committed: never final, stays locked (Check only).
 [409, "IDEMPOTENCY_CONFLICT", "the verification retry is stale; refresh the task and choose checks again"],
] as const) it(`N3 unproven or unreadable refusal ${status}/${code}/${String(message)} remains unknown`, async () => {
 const s = await setup({ rawFailure: new CodeError(status, { error: { code, message } }) });
 expect((await s.act()).status).toBe(502);expect(s.posts()).toHaveLength(1);
});
