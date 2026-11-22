/// <reference lib="dom" />
// This Node handler test also imports the browser Work reader and its session-safety dependency.
// The Cloud<->Code shape mismatches the 2026-11-18 audit found (audit-cloud-20261118 items 2, 3, 5, 7, 8b, 8c, 9, 10b, 12a, 12b, 12d): each Cloud route here reads Code's REAL
// answer (tests/fixtures/code-answers.ts, produced by Code's own handler code) through Cloud's real handler, so a Cloud reader that drifts from what Code sends fails here.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, buildAnswer, createCloudHandler, newSessionId, withoutTraceId, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";
import { workPlan } from "../../packages/cloud-server/src/work-reads.js";
import { CORE_TASK_ROUTES, renamed } from "../fixtures/code-core-task-routes.js";
import { ProjectSetupChecklistSchema, SetupAgentViewSchema, SetupConfirmReplySchema, TestEnvironmentStateSchema } from "../../packages/contracts/src/web.js";
import { readPlan, readTaskList, workRow } from "../../packages/ui/src/api/work.js";
import {
  ENGINE_MODEL_READ, ENGINE_MODEL_SAVED, LEARNING_MODEL_CLEARED, LEARNING_MODEL_NONE_OFFERED, LEARNING_MODEL_READ_INSTALL, LEARNING_MODEL_SAVED, LESSON_MEASURE, SETUP_AGENT_WITH_PROMPT_LOCATIONS, SETUP_EVAL_NONE_ANSWER, SETUP_STATUS_FAILED_WITH_TABS, SETUP_STATUS_NO_EVALS,
  TEST_ENVIRONMENT_HOSTED, WIKI_UPKEEP_PAUSED, archiveOutcome, archivePreview, devAnswer, restoreOutcome, restorePreview, takeOwnershipPending, taskListRow, taskPlanAnswer,
} from "../fixtures/code-answers.js";
import { wikiSetupBuildView } from "../support/wiki-setup-fixture.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const ME = "d".repeat(64), OTHER = "e".repeat(64);
type Obj = Record<string, unknown>;

interface Call { method: string; path: string; search: string; body: unknown }
type Code = (call: Call) => Response | undefined;

/** Cloud's real handler over a pretend Code that answers `code` (and Code's access check: the caller is `role` of company A, administering `grants`). */
function setUp(code: Code, options: { role?: "owner" | "admin" | "member"; grants?: Record<string, "administrator" | "developer"> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, search: url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === "/v1/dev/access") {
      return json(200, devAnswer({ developerId: ME, displayName: "Ada", administrator: false, companyId: A, companyRole: options.role ?? "owner", projects: Object.entries(options.grants ?? {}).map(([name, access]) => ({ name, access })), notices: [] }));
    }
    return code(call) ?? json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const sessions = new LocalSessionStore(undefined, { now: () => START, environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store: sessions, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(START), audit: new LocalCloudAuditStore(undefined, {}), company: { store: new LocalCompanyStore(), log: () => undefined },
  });
  const nowS = Math.floor(START / 1000);
  const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: ME, iat: nowS, exp: nowS + 3600, jti: "1", step_up_at: nowS - 10, step_up_amr: "passkey" })}.c2ln`;
  const ready = sessions.create("cookie-1", { accessToken: token, refreshToken: "r-1", csrf: "csrf", signedInAt: new Date(START).toISOString(), access: { developerId: ME, displayName: "Ada", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } });
  const send = async (method: string, target: string, body?: unknown) => {
    await ready;
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { cookie: "rovara_cloud_session=cookie-1", "x-rovara-csrf": "csrf", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answered = (await handler(request))!;
    return { status: answered.status, body: JSON.parse(answered.body) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  return { send, calls, work };
}

describe("Code's broker trace id is set aside once (audit items 2 and 3)", () => {
  it("only a /v1/dev answer's top-level string requestId goes; nothing else is touched", () => {
    expect(withoutTraceId("/v1/dev/company/engine-model", devAnswer(ENGINE_MODEL_READ))).toEqual(ENGINE_MODEL_READ);
    const app = { status: "none", requestId: "kept" };
    expect(withoutTraceId("/v1/app/projects/p/setup-agent", app)).toBe(app);
    const nested = { change: { status: "PENDING", requestId: randomUUID() } };
    expect(withoutTraceId("/v1/dev/tasks/t/people/take-ownership", nested)).toBe(nested);
    const list = [{ requestId: "x" }];
    expect(withoutTraceId("/v1/dev/tasks", list)).toBe(list);
    expect(withoutTraceId("/v1/dev/x", { requestId: 7, a: 1 })).toEqual({ requestId: 7, a: 1 });
  });

  it("the company engine-model card reads Code's real read and save answers", async () => {
    const w = setUp((call) => call.path === "/v1/dev/company/engine-model" ? json(200, devAnswer(call.method === "GET" ? ENGINE_MODEL_READ : ENGINE_MODEL_SAVED)) : undefined);
    expect(await w.send("GET", "/v1/web/org/engine-model")).toEqual({ status: 200, body: { ...ENGINE_MODEL_READ, canChange: true } });
    expect(await w.send("PUT", "/v1/web/org/engine-model", { model: "zai.glm-5" })).toEqual({ status: 200, body: { ...ENGINE_MODEL_SAVED, canChange: true } });
  });

  it("the company lessons learning-model card reads Code's real read, save, clear and no-Claude-model answers (DEC 254zzz63)", async () => {
    let next: Record<string, unknown> = LEARNING_MODEL_READ_INSTALL;
    const w = setUp((call) => call.path === "/v1/dev/company/learning-model" ? json(200, devAnswer(next as object)) : undefined);
    expect(await w.send("GET", "/v1/web/org/learning-model")).toEqual({ status: 200, body: { ...LEARNING_MODEL_READ_INSTALL, canChange: true } });
    next = LEARNING_MODEL_SAVED;
    expect(await w.send("PUT", "/v1/web/org/learning-model", { model: "claude-sonnet-5-5" })).toEqual({ status: 200, body: { ...LEARNING_MODEL_SAVED, canChange: true } });
    next = LEARNING_MODEL_CLEARED;
    expect(await w.send("PUT", "/v1/web/org/learning-model", { model: null })).toEqual({ status: 200, body: { ...LEARNING_MODEL_CLEARED, canChange: true } });
    next = LEARNING_MODEL_NONE_OFFERED;
    expect(await w.send("GET", "/v1/web/org/learning-model")).toEqual({ status: 200, body: { ...LEARNING_MODEL_NONE_OFFERED, canChange: true } });
  });

  it("archive and restore: the previews, the lifecycle read and both outcomes read Code's real answers", async () => {
    let archived = false;
    const w = setUp((call) => {
      const at = /^\/v1\/dev\/client\/projects\/alpha\/(archive-preview|archive|restore-preview|restore)$/u.exec(call.path)?.[1];
      if (at === "archive-preview") return json(200, devAnswer(archived ? { ...archiveOutcome(A, "alpha").current } : archivePreview(A, "alpha")));
      if (at === "restore-preview") return json(200, devAnswer(archived ? restorePreview(A, "alpha") : { ...restoreOutcome(A, "alpha").current }));
      if (at === "archive") { archived = true; return json(200, devAnswer(archiveOutcome(A, "alpha"))); }
      if (at === "restore") { archived = false; return json(200, devAnswer(restoreOutcome(A, "alpha"))); }
      return undefined;
    });
    const preview = await w.send("GET", "/v1/web/projects/alpha/archive-preview");
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ project: "alpha", status: "active", expectedRevision: 0, access: { actions: ["archive"] } });
    expect((await w.send("GET", "/v1/web/projects/alpha/lifecycle")).status).toBe(200);
    const archive = await w.send("POST", "/v1/web/projects/alpha/reviewed-archive", { requestId: randomUUID(), expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true, expectedOrgId: A });
    expect(archive.status).toBe(200);
    expect(JSON.stringify(archive.body)).not.toContain("requestId");
    const again = await w.send("GET", "/v1/web/projects/alpha/restore-preview");
    expect(again.body).toMatchObject({ status: "archived", access: { actions: ["restore"] } });
    expect((await w.send("POST", "/v1/web/projects/alpha/reviewed-restore", { requestId: randomUUID(), expectedRevision: 1, expectedProjectRevision: 1, acknowledgeNewWorkAllowed: true, expectedOrgId: A })).status).toBe(200);
  });
});

const TASK = "8b579b4b-eaa7-4bf2-87bc-0123456789ab";
describe("the Plan/Spec tab reads Code's {plan:{...}} answer (audit item 5)", () => {
  it("the headline, checks, claims as requirements and decisions as questions come from Code's plan; nothing Code did not send is made up", async () => {
    const w = setUp((call) => call.path === `/v1/dev/tasks/${TASK}/plan` ? json(200, devAnswer(taskPlanAnswer(TASK))) : undefined);
    const answer = await w.send("GET", `/v1/web/tasks/${TASK}/documents/plan`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      taskId: TASK, document: "plan", version: 1, approved: false, current: true,
      summary: { headline: "Retry failed payments", checks: ["Unit tests"] },
      requirements: [
        { id: "1", title: "Payments that fail with a timeout are retried.", criteria: [{ id: "1.1", when: "", then: "The retry waits longer each time.", taskIds: [] }] },
        { id: "2", title: "A payment is never charged twice.", criteria: [{ id: "2", when: "", then: "A payment is never charged twice.", taskIds: [] }] },
      ],
      questions: [{ questionId: "d1", text: "How many times should a payment be retried?", options: [{ optionId: "three", label: "Three times" }, { optionId: "five", label: "Five times" }], criterionId: "1.1", defaultOptionId: "three" }],
    });
    // The page's own reader draws it: a headline, the checks, two requirements and one question.
    const plan = readPlan(answer.body);
    expect(plan).toMatchObject({ headline: "Retry failed payments", checks: ["Unit tests"], estimate: undefined, runLimitUsd: undefined, tasks: [] });
    expect(plan.requirements.flatMap((one) => one.criteria.map((criterion) => criterion.id))).toEqual(["1.1", "2"]);
    expect(plan.questions[0]?.defaultOptionId).toBe("three");
  });

  it("a decision on any claim Code allows (a parent, or a third-level claim) is asked beside the criterion that claim is shown under", () => {
    const base = taskPlanAnswer(TASK);
    const content = { ...base.plan.content, claims: [{ id: "1", text: "Parent.", children: [{ id: "1.1", text: "Child.", children: [{ id: "1.1.1", text: "Grandchild." }] }, { id: "1.2", text: "Second." }] }], decisions: [
      { id: "d1", claimId: "1", question: "Q1?", options: [{ id: "a", label: "A", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "a" },
      { id: "d2", claimId: "1.1.1", question: "Q2?", options: [{ id: "a", label: "A", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "b" },
      { id: "d3", claimId: "1.2", question: "Q3?", options: [{ id: "a", label: "A", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "a" },
      { id: "d4", claimId: "9", question: "Q4?", options: [{ id: "a", label: "A", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "a" },
    ] };
    const plan = workPlan({ plan: { ...base.plan, content } });
    expect((plan["questions"] as Array<{ criterionId?: string }>).map((question) => question.criterionId)).toEqual(["1.1", "1.1", "1.2", undefined]);
  });

  it("an answer that is not Code's plan shape (the old flat one) shows nothing, never a half-read plan", async () => {
    const w = setUp((call) => call.path === `/v1/dev/tasks/${TASK}/plan` ? json(200, devAnswer({ headline: "flat", requirements: [{ id: "R1" }] })) : undefined);
    expect((await w.send("GET", `/v1/web/tasks/${TASK}/documents/plan`)).body).toEqual({});
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("the Work list and Home rows (audit item 7)", () => {
  // Code #1045 item 5: one detailed list read (`?detail=1`) gives each row its stage, pull requests, cost and limit. A RUNNING row missing its run uses the existing task reader;
  // closed and starting rows need no per-task reads. The rows are Code's real ones (tests/fixtures/code-core-task-routes.json `list`).
  const L = CORE_TASK_ROUTES.list;
  const coreRow = (taskId: string) => renamed((L.detailed.body["tasks"] as Obj[])[0]!, [[L.taskId, taskId]]);
  const plainCoreRow = (taskId: string) => renamed((L.plain.body["tasks"] as Obj[])[0]!, [[L.taskId, taskId]]);
  const workflowlessRow = (taskId: string) => renamed((L.workflowDetailed.body["tasks"] as Obj[])[0]!, [[L.workflowTaskId, taskId]]);

  it("one detailed list read per page, with a task read only for a running row missing its run; each row carries Code's stage, pull requests, cost and limit", async () => {
    const page1 = [coreRow(id(1)), ...Array.from({ length: 49 }, (_, n) => taskListRow(id(n + 2), { status: "CLOSED" }))];
    const page2 = [workflowlessRow(id(51))];
    const w = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer(new URLSearchParams(call.search).get("cursor") === null ? { tasks: page1, nextCursor: "c2" } : { tasks: page2 })) : undefined);
    const answer = await w.send("GET", "/v1/web/sessions");
    expect(answer.status).toBe(200);
    const tasks = answer.body["tasks"] as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(51);
    expect(w.calls.filter((call) => call.path === "/v1/dev/tasks").map((call) => [new URLSearchParams(call.search).get("detail"), new URLSearchParams(call.search).get("limit")])).toEqual([["1", "50"], ["1", "50"]]);
    expect(w.calls.filter((call) => /^\/v1\/dev\/tasks\/[0-9a-f-]{36}/u.test(call.path))).toEqual([
      { method: "GET", path: `/v1/dev/tasks/${id(1)}`, search: "?events=0", body: undefined },
    ]);
    // Code's upper-case pull request state is the task view's lower-case word, which the app reads.
    expect(tasks[0]).toMatchObject({ workflow: { stage: "PLAN", state: "RUNNING", revision: 1, path: "QUICK" }, pullRequests: [{ repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", state: "open" }], spent: { usd: 1.25 }, runLimit: { limitUsd: 7.5 } });
    expect(tasks[0]).not.toHaveProperty("detail");
    expect(tasks[50]).toMatchObject({ status: "STARTING", spent: { usd: 0.42 } });
    expect(tasks[50]).not.toHaveProperty("runLimit");
    const rows = readTaskList(answer.body);
    expect(rows[0]).toMatchObject({ spentUsd: 1.25, runLimitUsd: 7.5 });
    expect(workRow(rows[0]!, undefined, new Date(START))).toMatchObject({ group: "run" });
  });

  it("a pull request state Code does not name (UNKNOWN) says nothing; a merged one is the app's 'merged'", async () => {
    const row = { ...coreRow(id(1)), pullRequests: [{ repository: "demo", number: 1, url: "https://github.com/example/demo/pull/1", state: "UNKNOWN" }, { repository: "demo", number: 2, url: "https://github.com/example/demo/pull/2", state: "MERGED" }] };
    const w = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer({ tasks: [row] })) : undefined);
    const tasks = (await w.send("GET", "/v1/web/sessions")).body["tasks"] as Array<{ pullRequests: Obj[] }>;
    expect(tasks[0]!.pullRequests).toEqual([{ repository: "demo", number: 1, url: "https://github.com/example/demo/pull/1" }, { repository: "demo", number: 2, url: "https://github.com/example/demo/pull/2", state: "merged" }]);
  });

  it("a Code without the detailed list answers its plain rows: an open SUCCEEDED row is never 'Finished' (unread); a closed one says so; a detailed row with no workflow is a plain task's", async () => {
    const plain = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer({ tasks: [{ ...plainCoreRow(id(1)), status: "SUCCEEDED" }, taskListRow(id(2), { status: "CLOSED" })] })) : undefined);
    const plainTasks = (await plain.send("GET", "/v1/web/sessions")).body["tasks"] as Array<Record<string, unknown>>;
    expect(plainTasks[0]).toMatchObject({ detail: "unread" });
    expect(plainTasks[1]).not.toHaveProperty("detail");
    const rows = readTaskList({ tasks: plainTasks });
    expect(workRow(rows[0]!, undefined, new Date(START))).toMatchObject({ group: "run", line: "Open it to see its step" });
    // Code served the detail: a plain task (no workflow) that succeeded is finished.
    const served = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer({ tasks: [{ ...workflowlessRow(id(3)), status: "SUCCEEDED" }] })) : undefined);
    const servedRows = readTaskList((await served.send("GET", "/v1/web/sessions")).body);
    expect(workRow(servedRows[0]!, undefined, new Date(START))).toMatchObject({ group: "done", line: "Finished" });
    // A SUCCEEDED row with no detail at all in a served list (Code could not read its detail): never "Finished".
    const bare = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer({ tasks: [coreRow(id(4)), { ...plainCoreRow(id(5)), status: "SUCCEEDED" }] })) : undefined);
    const bareTasks = (await bare.send("GET", "/v1/web/sessions")).body["tasks"] as Array<Record<string, unknown>>;
    expect(bareTasks[1]).toMatchObject({ detail: "unread" });
    expect(bareTasks[0]).not.toHaveProperty("detail");
  });

  it("another company's caller: Code lists none of the task, and Cloud adds nothing", async () => {
    const w = setUp((call) => call.path === "/v1/dev/tasks" ? json(200, devAnswer(L.omarDetailed.body)) : undefined);
    expect((await w.send("GET", "/v1/web/sessions")).body).toEqual({ tasks: [] });
  });

  it("take-over: Code's PENDING answer keeps the old owner and asks the person to confirm on Code's page", async () => {
    const requestId = randomUUID();
    const w = setUp((call) => {
      if (call.path === `/v1/dev/tasks/${TASK}/people/take-ownership`) return json(200, devAnswer(takeOwnershipPending(TASK, requestId)));
      return undefined;
    });
    const sessionId = newSessionId();
    await w.work.put({ sessionId, taskId: TASK, project: "payments", startedBy: { developerId: OTHER, name: "Ben" }, owner: { developerId: OTHER, name: "Ben" }, createdAt: new Date(START).toISOString(), revision: 1, companyId: A });
    const answer = await w.send("POST", `/v1/web/sessions/${sessionId}/take-over`, { requestId, expectedPeopleRevision: 4 });
    expect(answer).toEqual({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: `${CODE}/review/${TASK}/task/people/confirm/${requestId}`, changes: ["Make you the owner of this task"] } });
    expect((await w.work.get(sessionId))?.owner.developerId).toBe(OTHER);
  });

  it("once Code names the reader as the owner (they confirmed), the session names them", async () => {
    const w = setUp((call) => call.path === `/v1/dev/tasks/${TASK}` ? json(200, devAnswer({ task: { ...taskListRow(TASK, { status: "RUNNING" }), owner: { developerId: ME, name: "Ada" } } })) : undefined);
    const sessionId = newSessionId();
    await w.work.put({ sessionId, taskId: TASK, project: "payments", startedBy: { developerId: OTHER, name: "Ben" }, owner: { developerId: OTHER, name: "Ben" }, createdAt: new Date(START).toISOString(), revision: 1, companyId: A });
    const read = await w.send("GET", `/v1/web/sessions/${sessionId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ session: { you: { owner: true } } });
    expect((await w.work.get(sessionId))?.owner).toEqual({ developerId: ME, name: "Ada" });
  });

  it("Code naming someone else as owner never moves the session to the reader", async () => {
    const w = setUp((call) => call.path === `/v1/dev/tasks/${TASK}` ? json(200, devAnswer({ task: { ...taskListRow(TASK, { status: "RUNNING" }), owner: { developerId: "f".repeat(64), name: "Cal" } } })) : undefined);
    const sessionId = newSessionId();
    await w.work.put({ sessionId, taskId: TASK, project: "payments", startedBy: { developerId: OTHER, name: "Ben" }, owner: { developerId: OTHER, name: "Ben" }, createdAt: new Date(START).toISOString(), revision: 1, companyId: A });
    await w.send("GET", `/v1/web/sessions/${sessionId}`);
    expect((await w.work.get(sessionId))?.owner.developerId).toBe(OTHER);
  });
});

describe("setup (audit items 8b, 8c, 9, 10b)", () => {
  it("the checklist reads a failed run whose output lines hold TABs, as Code sends them; other control characters are still refused", async () => {
    let lastLines: readonly string[] = SETUP_STATUS_FAILED_WITH_TABS.setupRun.failedCommand.lastLines;
    const w = setUp((call) => call.path === "/v1/dev/client/projects/alpha/setup-status" ? json(200, devAnswer({ ...SETUP_STATUS_FAILED_WITH_TABS, setupRun: { ...SETUP_STATUS_FAILED_WITH_TABS.setupRun, failedCommand: { ...SETUP_STATUS_FAILED_WITH_TABS.setupRun.failedCommand, lastLines } } })) : undefined);
    const answer = await w.send("GET", "/v1/web/projects/alpha/setup-status");
    expect(answer.status).toBe(200);
    expect((answer.body["setupRun"] as { failedCommand: { lastLines: string[] } }).failedCommand.lastLines).toEqual(["FAIL src/a.test.ts", "\texpected 1 to be 2", "\tat src/a.test.ts:4:7"]);
    expect(ProjectSetupChecklistSchema.safeParse(answer.body).success).toBe(true);
    for (const bad of ["a\u0007b", "a\u001bb", "a​b", "a\nb"]) {
      lastLines = [bad];
      expect((await w.send("GET", "/v1/web/projects/alpha/setup-status")).status, JSON.stringify(bad)).toBe(503);
    }
  });

  it("the checklist reads Code's no_evals row; the 'no evals' choice goes to Code's eval-none route and reads its answer", async () => {
    const w = setUp((call) => {
      if (call.path === "/v1/dev/client/projects/alpha/setup-status") return json(200, devAnswer(SETUP_STATUS_NO_EVALS));
      if (call.path === "/v1/dev/client/projects/alpha/setup-status/eval-none" && call.method === "PUT") return json(200, devAnswer(SETUP_EVAL_NONE_ANSWER));
      return undefined;
    });
    const read = await w.send("GET", "/v1/web/projects/alpha/setup-status");
    expect(read.status).toBe(200);
    expect(read.body["evalConfirm"]).toEqual(SETUP_STATUS_NO_EVALS.evalConfirm);
    expect(ProjectSetupChecklistSchema.safeParse(read.body).success).toBe(true);
    expect(await w.send("PUT", "/v1/web/projects/alpha/setup-status/eval-none", { noEvals: true })).toEqual({ status: 200, body: SETUP_EVAL_NONE_ANSWER });
    expect(w.calls.find((call) => call.path.endsWith("/eval-none"))?.body).toEqual({ noEvals: true });
    // Only `{noEvals: boolean}` is forwarded; anything else is refused before Code is asked.
    for (const body of [{ noEvals: "yes" }, { noEvals: true, project: "beta" }, {}]) expect((await w.send("PUT", "/v1/web/projects/alpha/setup-status/eval-none", body)).status).toBe(400);
    expect(w.calls.filter((call) => call.path.endsWith("/eval-none"))).toHaveLength(1);
  });

  it("the setup-run read keeps a candidate that adds prompt locations (Code's real apply view), and the app's reader takes it", async () => {
    const w = setUp((call) => call.path === "/v1/app/projects/payments/setup-agent" ? json(200, SETUP_AGENT_WITH_PROMPT_LOCATIONS) : undefined);
    const answer = await w.send("GET", "/v1/web/projects/payments/setup-agent");
    expect(answer.status).toBe(200);
    expect(answer.body["apply"]).toMatchObject({ risk: "medium", changes: [{ area: "prompt_locations", risk: "medium" }], promptLocations: ["demo/deskbot/agent.py: function DeskAgent.build_contents"] });
    expect(SetupAgentViewSchema.safeParse(answer.body).success).toBe(true);
  });

  it("'Use this setup' takes up to Code's 128 item ids, and reads an answer of 128", async () => {
    const ids = Array.from({ length: 128 }, (_, n) => `setup:${String(n)}`);
    const reply = { digest: "a".repeat(64), used: ids, unchecked: [], left: [], candidateRevision: 2, proved: false, next: "check" };
    const w = setUp((call) => call.path === "/v1/app/projects/payments/setup-agent/confirm" ? json(200, reply) : undefined);
    const answer = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", { requestId: randomUUID(), expectedRevision: 1, itemIds: ids });
    expect(answer.status).toBe(200);
    expect(SetupConfirmReplySchema.safeParse(answer.body).success).toBe(true);
    expect((await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", { requestId: randomUUID(), expectedRevision: 1, itemIds: [...ids, "setup:129"] })).status).toBe(400);
  });

  it("the onboarding test environment section reads Code's hosted state through the new forwarder", async () => {
    let state: Record<string, unknown> = { ...TEST_ENVIRONMENT_HOSTED };
    const w = setUp((call) => call.path === "/v1/app/projects/payments/test-environment" && call.method === "GET" ? json(200, state) : undefined);
    const answer = await w.send("GET", "/v1/web/projects/payments/test-environment");
    expect(answer).toEqual({ status: 200, body: { draft: { status: "none", notes: [TEST_ENVIRONMENT_HOSTED.testServicesUnavailable], questions: [], pendingServices: [] } } });
    expect(TestEnvironmentStateSchema.safeParse(answer.body).success).toBe(true);
    // A proposal without its body (an older Code): one fixed line, nothing offered for approval.
    const realProposal = CORE_TASK_ROUTES.testenv.read.body["proposal"] as Obj;
    const withoutBody: Obj = { ...realProposal };
    delete withoutBody["environment"];
    state = { ...TEST_ENVIRONMENT_HOSTED, approved: { revision: 3, digest: "b".repeat(64) }, proposal: withoutBody };
    const older = (await w.send("GET", "/v1/web/projects/payments/test-environment")).body;
    expect((older["draft"] as { notes: string[] }).notes).toEqual(["An approved test environment is in place (revision 3).", "A proposed test environment is waiting for review in Rovara Code.", TEST_ENVIRONMENT_HOSTED.testServicesUnavailable]);
    expect(older).not.toHaveProperty("proposal");
    state = { ...TEST_ENVIRONMENT_HOSTED, enabled: false };
    expect((await w.send("GET", "/v1/web/projects/payments/test-environment")).status).toBe(404);
    // A field Code does not send, or a sentence that is not Code's fixed one, is refused whole: nothing of it reaches the page.
    for (const bad of [{ ...TEST_ENVIRONMENT_HOSTED, extra: 1 }, { ...TEST_ENVIRONMENT_HOSTED, testServicesUnavailable: "<b>LEAK</b>" }, { ...TEST_ENVIRONMENT_HOSTED, testServicesUnavailable: "Test services not available here: LEAK" }, { ...TEST_ENVIRONMENT_HOSTED, project: "other" },
      { ...TEST_ENVIRONMENT_HOSTED, proposal: { ...realProposal, extra: "LEAK" } }, { ...TEST_ENVIRONMENT_HOSTED, proposal: { ...realProposal, risk: "LEAK" } }, { ...TEST_ENVIRONMENT_HOSTED, proposal: { ...realProposal, digest: "LEAK" } }]) {
      state = bad;
      const refused = await w.send("GET", "/v1/web/projects/payments/test-environment");
      expect(refused.status).toBe(502);
      expect(JSON.stringify(refused.body)).not.toContain("LEAK");
    }
  });
});

describe("lessons measure, wiki build, spend limits (audit items 12a, 12b, 12d)", () => {
  it("the lessons measure reads Code's 'wired'", async () => {
    const w = setUp((call) => call.path === "/v1/dev/projects/payments/lessons/measure" ? json(200, devAnswer(LESSON_MEASURE)) : undefined, { grants: { payments: "administrator" } });
    const answer = await w.send("GET", "/v1/web/projects/payments/lessons/measure");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ revertDetection: "wired" });
  });

  it("the wiki-build panel reads a nightly refresh that paused at the upkeep limit", () => {
    const view = { ...wikiSetupBuildView({ status: "stopped", stop: "upkeep_paused", pages: 10, refreshPages: 2, agentsOn: true, aiKey: "connected", mapMade: true, planned: 12, written: 10, upkeepOn: true }, true), ...WIKI_UPKEEP_PAUSED };
    expect(buildAnswer(view)).toMatchObject({ status: "stopped", stop: "upkeep_paused", message: WIKI_UPKEEP_PAUSED.message });
  });

  it("a company owner or admin who is not the project's admin is offered the per-task limit change Code accepts from them; a plain member is not", async () => {
    const settings = { preset: null, overrides: {}, revision: 2, updatedAt: null, updatedBy: null, resolved: {}, values: { model_budget_usd: { value: 50, origin: "company limit" } }, clamped: [] };
    const code: Code = (call) => call.path === "/v1/dev/projects/payments/settings" ? json(200, devAnswer(settings)) : undefined;
    for (const role of ["owner", "admin"] as const) expect((await setUp(code, { role }).send("GET", "/v1/web/projects/payments/spend-limits")).body).toMatchObject({ canChange: true });
    expect((await setUp(code, { role: "member", grants: { payments: "developer" } }).send("GET", "/v1/web/projects/payments/spend-limits")).body).toMatchObject({ canChange: false });
    expect((await setUp(code, { role: "member", grants: { payments: "administrator" } }).send("GET", "/v1/web/projects/payments/spend-limits")).body).toMatchObject({ canChange: true });
  });
});
