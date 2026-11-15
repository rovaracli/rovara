// The Work page's reads on Cloud (packages/cloud-server/src/work-reads.ts), run end to end on the fake Code: sign in, then read the list, one task's plan,
// proof index, events and comments. Each answer keeps only what the page draws, and a task the person may not read is Code's own 404.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { WORK_READS, WORK_TASKS_MAX, workPlan, workTask } from "../../packages/cloud-server/src/work-reads.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { TASK_IDS, startFakeCode, type FakeCode } from "../support/fake-code.js";

let fake: FakeCode;
interface Answer<T> { status: number; body: T }
interface TaskBody { taskId: string; workflow?: { stage?: string; state?: string }; pullRequests?: Array<{ number?: number; state?: string }> }
interface PlanBody { requirements: Array<{ criteria: Array<{ id: string }> }>; tasks: unknown[]; questions: Array<{ questionId: string }>; content?: unknown; summary: { headline?: string } }
interface ProofBody { items: Array<Record<string, unknown>> }
interface EventsBody { events: Array<Record<string, unknown>> }
let call: <T>(target: string) => Promise<Answer<T>>;
beforeAll(async () => {
  fake = await startFakeCode();
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const send = async (method: string, target: string, cookie?: string) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: cookie === undefined ? {} : { cookie } };
    const answer = await handler(request);
    return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
  };
  const start = await send("GET", "/v1/auth/browser/authorize?return_to=/app");
  const toCode = await fetch(start.headers["location"]!, { redirect: "manual" });
  const back = new URL(toCode.headers.get("location")!);
  const finished = await send("GET", `${back.pathname}${back.search}`);
  const cookie = finished.headers["set-cookie"]!.split(";")[0]!;
  call = async <T>(target: string) => { const answer = await send("GET", `/v1/web${target}`, cookie);return { status: answer.status, body: answer.body as T }; };
});
afterAll(async () => { await fake.close(); });

describe("the Work page's reads", () => {
  it("lists the person's tasks with the workflow stage, state and pull requests", async () => {
    const { status, body } = await call<{ tasks: TaskBody[] }>("/sessions");
    expect(status).toBe(200);
    const byId = new Map(body.tasks.map((task) => [task.taskId, task]));
    expect(byId.size).toBe(5);
    expect(byId.get(TASK_IDS.planReview)?.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(byId.get(TASK_IDS.pullRequest)?.pullRequests?.[0]).toMatchObject({ number: 42, state: "open" });
    // Only the fields the page draws: no events, files or artifacts.
    expect(Object.keys(byId.get(TASK_IDS.running) ?? {}).sort()).toEqual(["createdAt", "project", "status", "taskId", "title", "updatedAt", "workflow", "pullRequests"].sort());
  });

  it("reads one task's plan with its structured spec, without the raw document", async () => {
    const { status, body } = await call<PlanBody>(`/tasks/${TASK_IDS.planReview}/documents/plan`);
    expect(status).toBe(200);
    expect(body.requirements[0]?.criteria[0]).toMatchObject({ id: "R1.1" });
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.questions[0]).toMatchObject({ questionId: "Q1" });
    expect(body.content).toBeUndefined();
    expect(body.summary.headline).toBeTruthy();
  });

  it("reads the proof index, the events and the comments", async () => {
    const proof = await call<ProofBody>(`/tasks/${TASK_IDS.planReview}/evidence`);
    expect(proof.body.items[0]).toMatchObject({ title: "Unit tests", verdict: "pass", criterionIds: ["R1.1"] });
    const events = await call<EventsBody>(`/tasks/${TASK_IDS.planReview}/events`);
    expect(events.body.events[1]).toMatchObject({ seq: 2, taskItemId: "T2", attempt: 1 });
    const comments = await call<{ comments: unknown[] }>(`/tasks/${TASK_IDS.planReview}/comments`);
    expect(comments.body).toEqual({ comments: [] });
  });

  it("answers Code's refusal for a task that is not there, and refuses a path that is not a task id", async () => {
    expect((await call<unknown>("/tasks/99999999-9999-4999-8999-999999999999/documents/plan")).status).toBe(404);
    expect((await call<unknown>("/tasks/not-a-task/evidence")).status).toBe(501);
    expect((await call<unknown>(`/tasks/${TASK_IDS.planReview}/documents/other`)).status).toBe(501);
  });

  it("keeps only the fields the page draws and bounds the list", () => {
    expect(workTask({ taskId: "t", title: "x".repeat(400), project: "web", status: "RUNNING", events: [1, 2], secret: "no", createdAt: "a", updatedAt: "b" })).toEqual({ taskId: "t", title: "x".repeat(300), project: "web", status: "RUNNING", pullRequests: [], createdAt: "a", updatedAt: "b" });
    expect(workTask({ title: "no id", project: "web" })).toBeUndefined();
    expect(workTask("nope")).toBeUndefined();
    expect(workPlan("not an object")).toEqual({});
    expect(workPlan({ summary: { headline: 5, checks: ["a", 3] }, requirements: "x", content: { raw: 1 } })).toEqual({ summary: { checks: ["a"] } });
    expect(WORK_TASKS_MAX).toBe(100);
  });
});

describe("the task list and Cloud's sessions", () => {
  const listRoute = WORK_READS.find((route) => route.method === "GET" && route.path.test("/sessions"))!;
  const code = (tasks: unknown[]) => ({ json: async () => ({ tasks }) });
  const context = (tasks: unknown[], startedBy: () => Promise<Array<{ taskId: string; sessionId: string }>>) => ({ client: code(tasks), session: { access: { developerId: "d".repeat(64) } }, work: { startedBy } }) as unknown as RouteContext;
  const view = (taskId: string) => ({ taskId, title: "t", project: "web", status: "RUNNING", createdAt: "a", updatedAt: "b" });
  it("gives a task the person started in Cloud its session id, and no other task", async () => {
    const answer = await listRoute.answer(context([view("11111111-1111-4111-8111-111111111111"), view("22222222-2222-4222-8222-222222222222")], async () => [{ taskId: "22222222-2222-4222-8222-222222222222", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }]));
    const tasks = (answer.body as { tasks: Array<{ taskId: string; sessionId?: string }> }).tasks;
    expect(tasks.map((task) => task.sessionId)).toEqual([undefined, "ses_aaaaaaaaaaaaaaaaaaaa"]);
  });
  it("never gives a person the session a teammate started, with the real session store", async () => {
    const store = new LocalWorkSessionStore(), me = { developerId: "d".repeat(64), name: "Me" }, other = { developerId: "e".repeat(64), name: "Other" };
    const record = (sessionId: string, taskId: string, who: typeof me) => ({ sessionId, taskId, project: "web", startedBy: who, owner: who, createdAt: "2026-11-15T00:00:00.000Z", revision: 1 });
    await store.put(record("ses_aaaaaaaaaaaaaaaaaaaa", "11111111-1111-4111-8111-111111111111", me));
    await store.put(record("ses_bbbbbbbbbbbbbbbbbbbb", "22222222-2222-4222-8222-222222222222", other));
    const answer = await listRoute.answer({ client: code([view("11111111-1111-4111-8111-111111111111"), view("22222222-2222-4222-8222-222222222222")]), session: { access: { developerId: me.developerId } }, work: store } as unknown as RouteContext);
    expect((answer.body as { tasks: Array<{ sessionId?: string }> }).tasks.map((task) => task.sessionId)).toEqual(["ses_aaaaaaaaaaaaaaaaaaaa", undefined]);
  });
  it("still lists the tasks when the session store cannot be read", async () => {
    const answer = await listRoute.answer(context([view("11111111-1111-4111-8111-111111111111")], async () => { throw new Error("store down"); }));
    expect(answer.status).toBe(200);
    expect((answer.body as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(JSON.stringify(answer.body)).not.toContain("sessionId");
  });
});
