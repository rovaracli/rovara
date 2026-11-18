// The Work page's reads on Cloud (packages/cloud-server/src/work-reads.ts), run end to end on the fake Code: sign in, then read the list, one task's plan,
// proof index, events and comments. Each answer keeps only what the page draws, and a task the person may not read is Code's own 404.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { WORK_READS, WORK_TASKS_MAX, workPlan, workTask } from "../../packages/cloud-server/src/work-reads.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { PRIYA, SAM, TASK_IDS, startFakeCode, type FakeCode, type Person } from "../support/fake-code.js";

let fake: FakeCode;
interface Answer<T> { status: number; body: T }
interface TaskBody { taskId: string; workflow?: { stage?: string; state?: string }; pullRequests?: Array<{ number?: number; state?: string }> }
interface PlanBody { requirements: Array<{ criteria: Array<{ id: string }> }>; tasks: unknown[]; questions: Array<{ questionId: string }>; content?: unknown; summary: { headline?: string } }
interface ProofBody { items: Array<Record<string, unknown>> }
interface EventsBody { events: Array<Record<string, unknown>> }
let call: <T>(target: string) => Promise<Answer<T>>;
/** Signs in as `person` (the fake Code has no login page) and answers a caller bound to that person's own session. */
let signInAs: (person: Person) => Promise<<T>(target: string) => Promise<Answer<T>>>;
const control = async (body: Record<string, unknown>): Promise<{ taskId?: string }> => await (await fetch(`${fake.url}/__fake/involved`, { method: "POST", body: JSON.stringify(body) })).json() as { taskId?: string };
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
  signInAs = async (person) => {
    fake.setPerson(person);
    const start = await send("GET", "/v1/auth/browser/authorize?return_to=/app");
    const toCode = await fetch(start.headers["location"]!, { redirect: "manual" });
    const back = new URL(toCode.headers.get("location")!);
    const finished = await send("GET", `${back.pathname}${back.search}`);
    const cookie = finished.headers["set-cookie"]!.split(";")[0]!;
    return async <T>(target: string) => { const answer = await send("GET", `/v1/web${target}`, cookie);return { status: answer.status, body: answer.body as T }; };
  };
  call = await signInAs(PRIYA);
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
    // K0b: the round of Understand's questions comes from Code's workflow.intent.rounds, and nothing else of the intent.
    expect(workTask({ taskId: "t", title: "x", project: "web", workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2, intent: { rounds: 1, assessment: { kind: "questions", questions: [{ id: "q1", text: "secret?" }] } } }, createdAt: "a", updatedAt: "b" })?.["workflow"])
      .toEqual({ stage: "UNDERSTAND", state: "WAITING", revision: 2, round: 1 });
    expect(workTask({ taskId: "t", title: "x", project: "web", workflow: { stage: "UNDERSTAND", intent: { rounds: "1" } }, createdAt: "a", updatedAt: "b" })?.["workflow"]).toEqual({ stage: "UNDERSTAND" });
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

describe("the Work page's involved tasks (web task channel K4)", () => {
  interface Involved { tasks: Array<{ taskId: string; title: string; project: string }> }
  const involvedCalls = () => fake.log.filter((entry) => entry.path === "/v1/dev/tasks" && entry.query.includes("involved")).map((entry) => entry.path + entry.query);

  it("lists the tasks Code says the person was added to, in the Work list's fields, from one call that carries nothing the browser sent", async () => {
    await control({ mode: "on" });
    const added = await control({ involve: true, as: "priya", title: "Migrate the invoices table" });
    const before = involvedCalls().length;
    const { status, body } = await call<Involved>(`/involved?company=other&taskId=${TASK_IDS.running}&limit=9999&cursor=x`);
    expect(status).toBe(200);
    expect(body.tasks.map((task) => task.taskId)).toEqual([added.taskId]);
    expect(body.tasks[0]).toMatchObject({ title: "Migrate the invoices table", project: "api" });
    // Exactly one call to Code, with Cloud's own fixed query: nothing of the browser's query reaches Code.
    expect(involvedCalls().slice(before)).toEqual(["/v1/dev/tasks?involved=1&limit=50"]);
    // The ordinary list does not carry it (it is not the person's own).
    const ordinary = await call<{ tasks: Array<{ taskId: string }> }>("/sessions");
    expect(ordinary.body.tasks.map((task) => task.taskId)).not.toContain(added.taskId);
  });

  it("keeps only the fields the page draws and drops what is not a task", async () => {
    await control({ mode: "on" });
    await control({ involve: true, as: "priya", title: "Fields only" });
    const { body } = await call<Involved>("/involved");
    expect(body.tasks.length).toBeGreaterThan(0);
    for (const task of body.tasks) expect(Object.keys(task).sort()).toEqual(["createdAt", "pullRequests", "project", "status", "taskId", "title", "updatedAt", "workflow"].sort());
  });

  it("shows each person only what Code lists for them: the person added sees it, the task's owner and a person nobody added see nothing of it", async () => {
    await control({ mode: "on" });
    const sam = await signInAs(SAM);
    const priya = await signInAs(PRIYA);
    // Sam is added to a task Priya owns.
    const added = await control({ involve: true, as: "sam", title: "Only for Sam" });
    expect(added.taskId).toBeDefined();
    expect((await sam<Involved>("/involved")).body.tasks.map((task) => task.taskId)).toEqual([added.taskId]);
    expect((await priya<Involved>("/involved")).body.tasks.map((task) => task.title)).not.toContain("Only for Sam");
    // Cloud forwards Code's per-person answer; Sam's list in the ordinary route stays Sam's own.
    expect((await sam<{ tasks: Array<{ taskId: string }> }>("/sessions")).body.tasks.map((task) => task.taskId)).not.toContain(added.taskId);
  });

  it.each([400, 404, 501])("shows nothing extra and no error when Code is not deployed yet and answers %i", async (code) => {
    await control({ mode: String(code) });
    const answer = await call<Involved>("/involved");
    expect(answer).toEqual({ status: 200, body: { tasks: [] } });
    await control({ mode: "on" });
  });

  it("never shows the person's own tasks as involved when an older Code answers the ordinary list to the involved query", async () => {
    await control({ mode: "old" });
    const answer = await call<Involved>("/involved");
    expect(answer).toEqual({ status: 200, body: { tasks: [] } });
    // The older Code did answer the ordinary list to that very call (the person's own five tasks were in it): Cloud asked, and showed none of it.
    const before = involvedCalls().length;
    await call<Involved>("/involved");
    expect(involvedCalls().length).toBe(before + 1);
    const ordinary = await call<{ tasks: unknown[] }>("/sessions");
    expect(ordinary.body.tasks.length).toBeGreaterThan(0);
    await control({ mode: "on" });
  });

  it("passes any other refusal of Code on as Code worded it (never an empty list that hides an outage)", async () => {
    await control({ mode: "500" });
    const answer = await call<unknown>("/involved");
    expect(answer.status).toBe(500);
    await control({ mode: "on" });
  });

  it("bounds the list to WORK_TASKS_MAX and keeps nothing from a body that is not the involved list or a task", () => {
    expect(WORK_TASKS_MAX).toBe(100);
    expect(workTask({ title: "no id", project: "api" })).toBeUndefined();
  });
});

describe("the proof index's failing tests (TE-A6) and Code's own access rule", () => {
  const evidenceRoute = WORK_READS.find((route) => route.method === "GET" && route.path.test(`/tasks/${TASK_IDS.planReview}/evidence`))!;
  const seen: string[] = [];
  const answerFrom = (body: unknown) => evidenceRoute.answer({ client: { json: async (_session: unknown, path: string) => { seen.push(path); return body; } }, session: { access: { developerId: "d".repeat(64) } }, params: [TASK_IDS.planReview], query: new URLSearchParams("company=other&developerId=x") } as unknown as RouteContext);
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ check: "pytest -q", test: `tests/a.test.ts::case ${String(index)}`, cause: "unknown (only weak evidence)" }));

  it("passes on the item ids and at most ten failing tests, counting the rest; one call, with nothing of the browser's query", async () => {
    seen.length = 0;
    const answer = await answerFrom({ taskId: TASK_IDS.planReview, items: [{ id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "fail", criterionIds: [] }], failures: rows(12), failuresNotListed: 5 });
    const body = answer.body as { items: Array<Record<string, unknown>>; failures: unknown[]; failuresNotListed: number };
    expect(body.items).toEqual([{ id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "fail", criterionIds: [] }]);
    expect(body.failures).toEqual(rows(10));
    expect(body.failuresNotListed).toBe(7);
    expect(seen).toEqual([`/v1/dev/tasks/${TASK_IDS.planReview}/evidence`]);
  });

  it("drops a failure that is not three strings, bounds each text, and adds no failures key when Code sent none (an older Code)", async () => {
    const odd = await answerFrom({ items: [], failures: [{ check: "c", test: 5, cause: "x" }, "text", null, { check: "c".repeat(400), test: "t".repeat(400), cause: "u".repeat(900) }], failuresNotListed: "3" });
    const body = odd.body as { failures: Array<{ check: string; test: string; cause: string }> };
    expect(body.failures).toHaveLength(1);
    expect([body.failures[0]!.check.length, body.failures[0]!.test.length, body.failures[0]!.cause.length]).toEqual([200, 300, 500]);
    expect(Object.keys(odd.body as object)).not.toContain("failuresNotListed");
    const older = await answerFrom({ taskId: TASK_IDS.planReview, items: [] });
    expect(older.body).toEqual({ taskId: TASK_IDS.planReview, items: [] });
  });

  it("a person Code does not let read the task gets Code's own 404, and nothing of the task's proof", async () => {
    const sam = await signInAs(SAM);
    const refused = await sam<{ error?: { code: string }; items?: unknown }>(`/tasks/${TASK_IDS.planReview}/evidence`);
    expect(refused.status).toBe(404);
    expect(refused.body.items).toBeUndefined();
    expect(JSON.stringify(refused.body)).not.toContain("Unit tests");
  });
});
