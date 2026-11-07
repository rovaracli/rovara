// v1.2 learning loop, B3: the React routes for Remember and Forget (design 6.2), and the task page API's two new paths. Bodies are strict (I3): standing, author and stage are never read from a request.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { rememberTaskComment } from "../../packages/broker/src/learning/capture-comment.js";
import { LEARNING_PATH, routeLearning } from "../../packages/broker/src/learning/routes.js";
import { TASK_PAGE_API, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { DEV_ISSUER } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { PRIYA, PROJECT, RETRY_TEXT, SAM, learningItems, learningTask, seedComment, seedPerson } from "../support/learning-page.js";

const ORIGIN = new URL(DEV_ISSUER).origin;
const CSRF = "c".repeat(43);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const taskId = "11111111-1111-4111-8111-111111111111";
const commentId = "33333333-3333-4333-8333-333333333333";
const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: "d".repeat(64), sessionId: SESSION_ID, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };

describe("task page API: Remember and Forget paths", () => {
  const cookies = `__Host-agentx_review_session=${SESSION_ID}; __Host-agentx_review_csrf=${CSRF}`;
  const post = (path: string, body: unknown, headers: Record<string, string | undefined> = {}): AdaptedHttpRequest => ({
    method: "POST", path, requestId: "r", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { origin: ORIGIN, cookie: cookies, "x-agentx-csrf": CSRF, "content-type": "application/json", ...headers },
  });
  const rememberPath = `/review/${taskId}/task/api/comments/${commentId}/remember`;
  const forgetPath = `/review/${taskId}/task/api/comments/${commentId}/forget`;
  function deps(overrides: Partial<TaskWebApiDependencies> = {}) {
    const calls: Array<{ name: string; who: DeveloperCaller; taskId: string; commentId: string }> = [];
    const base = {
      origin: DEV_ISSUER, authenticateSession: async (id: string) => (id === SESSION_ID ? caller : undefined),
      rememberComment: async (who: DeveloperCaller, task: string, comment: string) => { calls.push({ name: "remember", who, taskId: task, commentId: comment }); return { correction: { id: "c1", standing: "member" as const, stage: "plan" } }; },
      forgetComment: async (who: DeveloperCaller, task: string, comment: string) => { calls.push({ name: "forget", who, taskId: task, commentId: comment }); return { forgotten: true as const }; },
    } as unknown as TaskWebApiDependencies;
    return { calls, deps: { ...base, ...overrides } };
  }
  const run = async (d: TaskWebApiDependencies, request: AdaptedHttpRequest) => {
    const response = await createTaskWebApi(d)(request, new URL(`${ORIGIN}${request.path}`));
    return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
  };

  it("the paths belong to the task page API", () => {
    expect(TASK_PAGE_API.test(rememberPath)).toBe(true);
    expect(TASK_PAGE_API.test(forgetPath)).toBe(true);
    expect(TASK_PAGE_API.test(`/review/${taskId}/task/api/comments/${commentId}/other`)).toBe(false);
  });

  it("Remember and Forget reach the dependency with the session's caller, the task and the comment", async () => {
    const { calls, deps: d } = deps();
    const remembered = await run(d, post(rememberPath, {}));
    expect(remembered.statusCode).toBe(200);
    expect(remembered.json).toEqual({ correction: { id: "c1", standing: "member", stage: "plan" } });
    const forgotten = await run(d, post(forgetPath, {}));
    expect(forgotten.json).toEqual({ forgotten: true });
    expect(calls).toEqual([{ name: "remember", who: caller, taskId, commentId }, { name: "forget", who: caller, taskId, commentId }]);
  });

  it.each([
    ["standing", { standing: "member" }], ["author", { author: "x" }], ["stage", { stage: "build" }], ["text", { text: "Use the helper" }], ["an array", []], ["not JSON", "{"],
  ])("I3: %s in the body is refused and nothing is called", async (_label, body) => {
    const { calls, deps: d } = deps();
    for (const path of [rememberPath, forgetPath]) expect((await run(d, post(path, body))).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("needs the same origin, the CSRF header and a session, and answers 405 to a GET", async () => {
    const { calls, deps: d } = deps();
    expect((await run(d, post(rememberPath, {}, { origin: "https://evil.example" }))).statusCode).toBe(403);
    expect((await run(d, post(rememberPath, {}, { "x-agentx-csrf": "d".repeat(43) }))).statusCode).toBe(403);
    expect((await run(d, post(rememberPath, {}, { cookie: "" }))).statusCode).toBe(401);
    expect((await run(d, { method: "GET", path: rememberPath, requestId: "r", headers: { cookie: cookies } })).statusCode).toBe(405);
    expect(calls).toEqual([]);
  });

  it("is not found where the dependency is not wired", async () => {
    const { rememberComment: _remember, forgetComment: _forget, ...unwired } = deps().deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    const d: TaskWebApiDependencies = unwired;
    expect((await run(d, post(rememberPath, {}))).statusCode).toBe(404);
    expect((await run(d, post(forgetPath, {}))).statusCode).toBe(404);
  });

  it("answers a refusal in the page's words", async () => {
    const refuse = (pageReason: string, code: string) => async () => { throw Object.assign(new Error("no"), { code, pageReason }); };
    const forbidden = await run(deps({ rememberComment: refuse("not_allowed", "FORBIDDEN") }).deps, post(rememberPath, {}));
    expect([forbidden.statusCode, forbidden.json.error]).toEqual([403, "not_allowed"]);
    const slow = await run(deps({ rememberComment: refuse("slow_down", "TASK_BUSY") }).deps, post(rememberPath, {}));
    expect(slow.statusCode).toBe(429);
    const hidden = await run(deps({ forgetComment: refuse("", "TASK_NOT_FOUND") }).deps, post(forgetPath, {}));
    expect(hidden.statusCode).toBe(404);
  });
});

describe("React routes: /v1/app/projects/{p}/learning/remember and corrections/{id}/forget", () => {
  function routeDeps() {
    const fixture = learningTask();
    seedPerson(fixture.db, PRIYA, "contributor");
    seedPerson(fixture.db, SAM, "contributor");
    const projectFor = vi.fn(async (_who: DeveloperCaller, raw: string) => {
      if (raw !== PROJECT) throw Object.assign(new Error("PROJECT_NOT_FOUND: no such project"), { code: "PROJECT_NOT_FOUND" });
      return { name: PROJECT, role: "contributor" as const };
    });
    return { fixture, deps: { task: fixture.deps, projectFor } };
  }
  const call = (deps: ReturnType<typeof routeDeps>["deps"], who: DeveloperCaller, method: string, path: string, body: unknown) =>
    routeLearning(deps, who, method, new URL(`${ORIGIN}${path}`), () => body);
  const rememberUrl = `/v1/app/projects/${PROJECT}/learning/remember`;

  it("the path pattern covers the learning routes of a project", () => {
    expect(LEARNING_PATH.exec(rememberUrl)?.[1]).toBe(PROJECT);
    expect(LEARNING_PATH.test("/v1/app/projects/payments/playbook")).toBe(false);
  });

  it("Remember answers as the task page does", async () => {
    const { fixture, deps } = routeDeps();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const viaPage = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    const answer = await call(deps, PRIYA, "POST", rememberUrl, { requestId: randomUUID(), taskId: fixture.taskId, commentId: comment.commentId });
    expect(answer instanceof StatusReply ? answer.body : answer).toEqual(viaPage);
    expect(learningItems(fixture.db).filter((item) => String(item.sk).startsWith("CORRECTION#"))).toHaveLength(1);
  });

  it.each([["standing", { standing: "member" }], ["author", { author: SAM.developerId }], ["stage", { stage: "build" }]])("I3: %s in the body is refused and nothing is stored", async (_label, extra) => {
    const { fixture, deps } = routeDeps();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    await expect(call(deps, PRIYA, "POST", rememberUrl, { requestId: randomUUID(), taskId: fixture.taskId, commentId: comment.commentId, ...extra })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(learningItems(fixture.db)).toEqual([]);
  });

  it("refuses a task of another project, and a project the caller cannot see", async () => {
    const { fixture, deps } = routeDeps();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const body = { requestId: randomUUID(), taskId: fixture.taskId, commentId: comment.commentId };
    await expect(call(deps, PRIYA, "POST", "/v1/app/projects/web/learning/remember", body)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
    fixture.db.set({ ...record, project: "web" });
    await expect(call(deps, PRIYA, "POST", rememberUrl, body)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(learningItems(fixture.db)).toEqual([]);
  });

  it("Forget by correction id removes it, for the person who remembered it; another contributor is refused", async () => {
    const { fixture, deps } = routeDeps();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const { correction } = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    const url = `/v1/app/projects/${PROJECT}/learning/corrections/${correction.id}/forget`;
    seedPerson(fixture.db, { ...SAM, developerId: "7".repeat(64) }, "contributor");
    await expect(call(deps, { ...SAM, developerId: "7".repeat(64) }, "POST", url, { requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(learningItems(fixture.db).filter((item) => String(item.sk).startsWith("CORRECTION#"))).toHaveLength(1);
    const forgotten = await call(deps, PRIYA, "POST", url, { requestId: randomUUID() });
    expect(forgotten instanceof StatusReply ? forgotten.body : forgotten).toEqual({ forgotten: true });
    expect(learningItems(fixture.db).filter((item) => String(item.sk).startsWith("CORRECTION#"))).toEqual([]);
  });

  it("does not handle a path or method it does not own", async () => {
    const { deps } = routeDeps();
    expect(await call(deps, PRIYA, "GET", rememberUrl, {})).toBeUndefined();
    expect(await call(deps, PRIYA, "POST", `/v1/app/projects/${PROJECT}/learning/unknown`, {})).toBeUndefined();
  });
});
