// The Cloud<->Code shape mismatches the 2026-11-18 audit found (audit-cloud-20261118 items 2, 3, 5, 7, 8b, 8c, 9, 10b, 12a, 12b, 12d): each Cloud route here reads Code's REAL
// answer (tests/fixtures/code-answers.ts, produced by Code's own handler code) through Cloud's real handler, so a Cloud reader that drifts from what Code sends fails here.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, buildAnswer, createCloudHandler, newSessionId, withoutTraceId, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";
import { WORK_DETAILS_MAX, workPlan } from "../../packages/cloud-server/src/work-reads.js";
import { ProjectSetupChecklistSchema, SetupAgentViewSchema, SetupConfirmReplySchema, TestEnvironmentStateSchema } from "../../packages/contracts/src/web.js";
import { readPlan, readTaskList, workRow } from "../../packages/ui/src/api/work.js";
import {
  ENGINE_MODEL_READ, ENGINE_MODEL_SAVED, LESSON_MEASURE, SETUP_AGENT_WITH_PROMPT_LOCATIONS, SETUP_EVAL_NONE_ANSWER, SETUP_STATUS_FAILED_WITH_TABS, SETUP_STATUS_NO_EVALS,
  TEST_ENVIRONMENT_HOSTED, WIKI_UPKEEP_PAUSED, archiveOutcome, archivePreview, devAnswer, restoreOutcome, restorePreview, takeOwnershipPending, taskListRow, taskPlanAnswer,
} from "../fixtures/code-answers.js";
import { wikiSetupBuildView } from "../support/wiki-setup-fixture.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const ME = "d".repeat(64), OTHER = "e".repeat(64);

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
  it("pages past Code's first page, fills each open task from its own view, and a task between steps is never 'Finished'", async () => {
    const page1 = Array.from({ length: 50 }, (_, n) => taskListRow(id(n + 1), { status: n === 0 ? "SUCCEEDED" : "CLOSED" }));
    const page2 = [taskListRow(id(51), { status: "RUNNING" })];
    const w = setUp((call) => {
      if (call.path === "/v1/dev/tasks") return json(200, devAnswer(new URLSearchParams(call.search).get("cursor") === null ? { tasks: page1, nextCursor: "c2" } : { tasks: page2 }));
      const one = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})$/u.exec(call.path)?.[1];
      if (one === id(1)) return json(200, devAnswer({ task: { ...taskListRow(id(1)), workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 3 }, pullRequests: [{ repository: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", state: "open" }], spent: { usd: 1.25 }, runLimit: { limitUsd: 5 } } }));
      if (one === id(51)) return json(500, { error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } });
      return undefined;
    });
    const answer = await w.send("GET", "/v1/web/sessions");
    expect(answer.status).toBe(200);
    const tasks = answer.body["tasks"] as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(51);
    expect(w.calls.filter((call) => call.path === "/v1/dev/tasks").map((call) => new URLSearchParams(call.search).get("limit"))).toEqual(["50", "50"]);
    // Closed tasks are not read one by one.
    expect(w.calls.filter((call) => /^\/v1\/dev\/tasks\/[0-9a-f-]{36}$/u.test(call.path)).map((call) => call.path.slice(-12))).toEqual([id(1).slice(-12), id(51).slice(-12)]);
    expect(tasks[0]).toMatchObject({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" }, pullRequests: [{ number: 7 }], spent: { usd: 1.25 }, runLimit: { limitUsd: 5 } });
    expect(tasks[50]).toMatchObject({ status: "RUNNING", detail: "unread" });
    const rows = readTaskList(answer.body);
    const now = new Date(START);
    expect(workRow(rows[0]!, undefined, now)).toMatchObject({ group: "you", need: "Review spec", path: undefined });
    expect(rows[0]).toMatchObject({ spentUsd: 1.25, runLimitUsd: 5 });
  });

  it("a SUCCEEDED task whose own view could not be read is not shown as finished; one Code says has no workflow is", async () => {
    const w = setUp((call) => {
      if (call.path === "/v1/dev/tasks") return json(200, devAnswer({ tasks: [taskListRow(id(1)), taskListRow(id(2))] }));
      if (call.path === `/v1/dev/tasks/${id(1)}`) return json(403, { error: { code: "FORBIDDEN", message: "no" } });
      if (call.path === `/v1/dev/tasks/${id(2)}`) return json(200, devAnswer({ task: taskListRow(id(2)) }));
      return undefined;
    });
    const rows = readTaskList((await w.send("GET", "/v1/web/sessions")).body);
    const now = new Date(START);
    expect(workRow(rows[0]!, undefined, now)).toMatchObject({ group: "run", line: "Open it to see its step" });
    expect(workRow(rows[1]!, undefined, now)).toMatchObject({ group: "done", line: "Finished" });
  });

  it(`reads at most ${String(WORK_DETAILS_MAX)} task views per list; the rest are marked unread`, async () => {
    const w = setUp((call) => {
      if (call.path === "/v1/dev/tasks") return json(200, devAnswer({ tasks: Array.from({ length: 40 }, (_, n) => taskListRow(id(n + 1), { status: "RUNNING" })) }));
      const one = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})$/u.exec(call.path)?.[1];
      return one === undefined ? undefined : json(200, devAnswer({ task: { ...taskListRow(one, { status: "RUNNING" }), workflow: { stage: "IMPLEMENT", state: "RUNNING" } } }));
    });
    const tasks = (await w.send("GET", "/v1/web/sessions")).body["tasks"] as Array<Record<string, unknown>>;
    expect(w.calls.filter((call) => /^\/v1\/dev\/tasks\/[0-9a-f-]{36}$/u.test(call.path))).toHaveLength(WORK_DETAILS_MAX);
    expect(tasks.filter((task) => task["detail"] === "unread")).toHaveLength(40 - WORK_DETAILS_MAX);
  });

  it("take-over: Code's PENDING answer keeps the old owner and asks the person to confirm on Code's page", async () => {
    const requestId = randomUUID();
    const w = setUp((call) => {
      if (call.path === `/v1/dev/tasks/${TASK}/people` && call.method === "GET") return json(200, devAnswer({ view: { revision: 4 } }));
      if (call.path === `/v1/dev/tasks/${TASK}/people/take-ownership`) return json(200, devAnswer(takeOwnershipPending(TASK, requestId)));
      return undefined;
    });
    const sessionId = newSessionId();
    await w.work.put({ sessionId, taskId: TASK, project: "payments", startedBy: { developerId: OTHER, name: "Ben" }, owner: { developerId: OTHER, name: "Ben" }, createdAt: new Date(START).toISOString(), revision: 1, companyId: A });
    const answer = await w.send("POST", `/v1/web/sessions/${sessionId}/take-over`, { requestId });
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
    state = { ...TEST_ENVIRONMENT_HOSTED, approved: { revision: 3, digest: "b".repeat(64) }, proposal: { digest: "c".repeat(64) } };
    expect(((await w.send("GET", "/v1/web/projects/payments/test-environment")).body["draft"] as { notes: string[] }).notes).toEqual(["An approved test environment is in place (revision 3).", "A proposed test environment is waiting for review in Rovara Code.", TEST_ENVIRONMENT_HOSTED.testServicesUnavailable]);
    state = { ...TEST_ENVIRONMENT_HOSTED, enabled: false };
    expect((await w.send("GET", "/v1/web/projects/payments/test-environment")).status).toBe(404);
    // A field Code does not send, or a sentence that is not Code's fixed one, is refused whole: nothing of it reaches the page.
    for (const bad of [{ ...TEST_ENVIRONMENT_HOSTED, extra: 1 }, { ...TEST_ENVIRONMENT_HOSTED, testServicesUnavailable: "<b>LEAK</b>" }, { ...TEST_ENVIRONMENT_HOSTED, testServicesUnavailable: "Test services not available here: LEAK" }, { ...TEST_ENVIRONMENT_HOSTED, project: "other" }]) {
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
