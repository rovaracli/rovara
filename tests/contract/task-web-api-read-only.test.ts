// The task page's JSON API: OWNER DECISION 7: with the decision cards on (`readOnly`) the page is read-only, so every write it made is refused (410) with where the task is decided now; its reads, and the one write Slack's People flow
// links to (a People request's confirmation: same origin, the CSRF header matching its cookie, the session, JSON only and a strict body), answer as before. A reader who may not see the task cannot tell it exists.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { TASK_PAGE_READ_ONLY_MESSAGE, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { DEV_ISSUER, MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { pagePlan } from "../support/page-tasks.js";
import { planAnswer } from "../support/plan-documents.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";
import { cardDecision } from "../support/card-decision.js";
import { TEST_ORG } from "../support/orgs.js";

const ORIGIN = new URL(DEV_ISSUER).origin;
const taskId = "11111111-1111-4111-8111-111111111111";
const CSRF = "c".repeat(43);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: "d".repeat(64), sessionId: SESSION_ID, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
const cookies = (csrf: string | null = CSRF) => `__Host-agentx_review_session=${SESSION_ID}${csrf === null ? "" : `; __Host-agentx_review_csrf=${csrf}`}`;

function fakeDeps(overrides: Partial<TaskWebApiDependencies> = {}): TaskWebApiDependencies & { calls: Array<{ name: string; caller: DeveloperCaller; input?: unknown }> } {
  const calls: Array<{ name: string; caller: DeveloperCaller; input?: unknown }> = [];
  return {
    calls,
    origin: DEV_ISSUER,
    authenticateSession: async (sessionId) => (sessionId === SESSION_ID ? caller : undefined),
    taskState: async (who) => { calls.push({ name: "state", caller: who }); return { revision: 4, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }], commentSeq: 2,
      canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: false, canTakeOwnership: false }; },
    listComments: async (who) => { calls.push({ name: "comments", caller: who }); return { comments: [] }; },
    getPeopleRequest: async (who, _taskId, requestId) => { calls.push({ name: "peopleRequest", caller: who, input: requestId }); return { status: "PENDING", requestId, confirmationUrl: "https://x.example/c", expiresAt: "2026-11-07T10:00:00.000Z" }; },
    confirmPeopleRequest: async (who, _taskId, requestId) => { calls.push({ name: "confirm", caller: who, input: requestId }); return { status: "COMMITTED", view: {} as never }; },
    taskPagePath: async () => "/app/sessions/ses_0123456789abcdefghij",
    readOnly: true,
    createComment: async (who, _taskId, input) => { calls.push({ name: "createComment", caller: who, input }); return { comment: {} as never }; },
    editComment: async (who, _taskId, input) => { calls.push({ name: "editComment", caller: who, input }); return { comment: {} as never }; },
    deleteComment: async (who, _taskId, input) => { calls.push({ name: "deleteComment", caller: who, input }); return { comment: {} as never }; },
    setSuggestion: async (who, _taskId, input) => { calls.push({ name: "setSuggestion", caller: who, input }); return {}; },
    decide: async (who, _taskId, input) => { calls.push({ name: "decide", caller: who, input }); return { revision: 5 }; },
    ...overrides,
  };
}

const commentBody = { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "Above reads better.", ask: false };
const PEOPLE_REQUEST = "33333333-3333-4333-8333-333333333333";

function post(path: string, body: unknown, headers: Record<string, string | undefined> = {}): AdaptedHttpRequest {
  return {
    method: "POST", path, requestId: "r", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { origin: ORIGIN, cookie: cookies(), "x-agentx-csrf": CSRF, "content-type": "application/json", ...headers },
  };
}
const get = (path: string, cookie: string = cookies()): AdaptedHttpRequest => ({ method: "GET", path, requestId: "r", headers: { cookie } });
const api = (suffix: string) => `/review/${taskId}/task/api/${suffix}`;
const confirmPath = api(`people/requests/${PEOPLE_REQUEST}/confirm`);
const call = async (deps: TaskWebApiDependencies, request: AdaptedHttpRequest) => {
  const response = await createTaskWebApi(deps)(request, new URL(`${ORIGIN}${request.path}`));
  return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
};

describe("task page API (OWNER DECISION 7: read-only)", () => {
  it("OWNER DECISION 17: refuses every DECISION write with 410, the words and the task page's path, calls nothing, and logs only its code", async () => {
    const logged: Array<Record<string, string>> = [];
    const deps = fakeDeps({ log: (entry) => { logged.push(entry); } });
    const id = randomUUID();
    void id;
    const writes: Array<[string, unknown]> = [
      ["decision", { requestId: randomUUID(), expectedRevision: 4, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] }],
      ["retry", { requestId: randomUUID(), expectedRevision: 4 }], ["revise-plan", { requestId: randomUUID(), expectedRevision: 4 }],
      ["spec/retry", { requestId: randomUUID(), expectedRevision: 4 }], ["spec/replan", { requestId: randomUUID(), expectedRevision: 4 }],
      // OWNER DECISION 18 (review M1): one place means one place: comments, Ask, replies, edits, deletes, suggestions, Remember and People proposals are refused too.
      ["comments", commentBody], ["comments", { ...commentBody, requestId: randomUUID(), ask: true }], [`comments/${randomUUID()}/edit`, { rev: 1, text: "x" }], [`comments/${randomUUID()}/delete`, { rev: 1 }],
      [`comments/${randomUUID()}/remember`, {}], ["suggestions", { document: "plan", decisionId: "d1", optionId: "above" }],
      ["people/role", { requestId: randomUUID(), expectedPeopleRevision: 1, personId: randomUUID(), role: "viewer" }], ["people/take-ownership", { requestId: randomUUID(), expectedPeopleRevision: 1 }],
    ];
    for (const [suffix, body] of writes) {
      for (const request of [post(api(suffix), body), post(api(suffix), "{not json"), post(api(suffix), body, { origin: "https://evil.example" })]) {
        const answer = await call(deps, request);
        expect(answer.statusCode, suffix).toBe(410);
        expect(answer.json, suffix).toEqual({ error: "read_only", message: TASK_PAGE_READ_ONLY_MESSAGE, taskPage: "/app/sessions/ses_0123456789abcdefghij" });
      }
    }
    expect(deps.calls).toEqual([]);
    expect(logged.every((entry) => entry["code"] === "READ_ONLY" && entry["event"] === "task_page.refused")).toBe(true);
    expect(JSON.stringify(logged)).not.toMatch(/Above reads better|Maya/);
    // A signed-out request is told to sign in, before anything else; methods are still enforced.
    expect((await call(deps, post(api("comments"), commentBody, { cookie: undefined }))).statusCode).toBe(401);
    expect((await call(deps, { ...get(api("state")), method: "POST", headers: post(api("state"), {}).headers })).statusCode).toBe(405);
    expect((await call(deps, { ...get(api("decision")), method: "PUT" })).statusCode).toBe(405);
    // Follow-up R1: with no task page to point to (someone who may not read the task, or a task with no session), nothing is refused here: the write reaches its own function, which checks
    // who may as it always did (these fakes accept; the broker-level tests below pin the real refusals).
    for (const noPage of [async () => { throw Object.assign(new Error("no"), { code: "TASK_NOT_FOUND" }); }, async () => undefined, async () => "/app/projects/demo"]) {
      const through = fakeDeps({ taskPagePath: noPage });
      expect((await call(through, post(api("comments"), commentBody))).statusCode).toBe(201);
      expect((await call(through, post(api(`comments/${randomUUID()}/remember`), {}))).statusCode).not.toBe(410);
    }
  });

  it("OWNER DECISION 18 (review M1): no comment, reply, suggestion or Ask is written here with the cards on; with them off the same requests write as before", async () => {
    const created: unknown[] = [], suggested: unknown[] = [];
    const writers = { createComment: async (who: unknown, _task: unknown, input: unknown) => { created.push([who, input]); return { comment: {} as never }; },
      setSuggestion: async (who: unknown, _task: unknown, input: unknown) => { suggested.push([who, input]); return {}; } };
    const on = fakeDeps(writers);
    for (const [suffix, body] of [["comments", commentBody], ["comments", { ...commentBody, requestId: randomUUID(), parentId: randomUUID(), ask: true }], ["suggestions", { document: "plan", decisionId: "d1", optionId: "above" }]] as const) {
      expect((await call(on, post(api(suffix), body))).statusCode, suffix).toBe(410);
    }
    expect([created, suggested]).toEqual([[], []]);
    // dk=0: the page is fully writable, under its own CSRF and origin rules.
    const off = fakeDeps({ ...writers, readOnly: false });
    expect((await call(off, post(api("comments"), commentBody))).statusCode).toBe(201);
    expect((await call(off, post(api("suggestions"), { document: "plan", decisionId: "d1", optionId: "above" }))).statusCode).toBe(200);
    expect((await call(off, post(api("comments"), commentBody, { origin: "https://evil.example" }))).statusCode).toBe(403);
    expect(created).toEqual([[caller, commentBody]]);
    expect(suggested).toHaveLength(1);
  });

  it("the one write left, a People request's confirmation, needs same origin, the CSRF header and its cookie", async () => {
    const deps = fakeDeps();
    const body = { requestId: PEOPLE_REQUEST };
    for (const request of [
      post(confirmPath, body, { "x-agentx-csrf": undefined }), post(confirmPath, body, { "x-agentx-csrf": "d".repeat(43) }), post(confirmPath, body, { cookie: cookies(null) }),
      post(confirmPath, body, { cookie: cookies("short"), "x-agentx-csrf": "short" }), post(confirmPath, body, { origin: undefined }), post(confirmPath, body, { origin: "null" }), post(confirmPath, body, { origin: "https://evil.example" }),
    ]) {
      const answer = await call(deps, request);
      expect(answer.statusCode).toBe(403);
      expect(answer.json).toEqual({ error: "request_refused" });
    }
    expect(deps.calls).toEqual([]);
    const accepted = await call(deps, post(confirmPath, body));
    expect(accepted.statusCode).toBe(200);
    expect(deps.calls.map((entry) => [entry.name, entry.caller, entry.input])).toEqual([["peopleRequest", caller, PEOPLE_REQUEST], ["confirm", caller, PEOPLE_REQUEST]]);
  });

  it("the confirmation takes JSON only, at most 16 KB, and a body naming exactly its own request", async () => {
    const deps = fakeDeps();
    expect((await call(deps, post(confirmPath, { requestId: PEOPLE_REQUEST }, { "content-type": "text/plain" }))).statusCode).toBe(400);
    expect((await call(deps, post(confirmPath, "{not json"))).statusCode).toBe(400);
    expect((await call(deps, post(confirmPath, { requestId: PEOPLE_REQUEST, pad: "x".repeat(16_400) }))).statusCode).toBe(400);
    expect((await call(deps, post(confirmPath, { requestId: randomUUID() }))).statusCode).toBe(400);
    expect((await call(deps, post(confirmPath, { requestId: PEOPLE_REQUEST, role: "owner" }))).statusCode).toBe(400);
    expect(deps.calls).toEqual([]);
  });

  it("maps a confirmation's refusal to its status: a hidden task as not found, anything else as unavailable", async () => {
    const thrower = (error: Record<string, unknown>) => fakeDeps({ confirmPeopleRequest: async () => { throw Object.assign(new Error("refused"), error); } });
    const hidden = await call(thrower({ code: "TASK_NOT_FOUND" }), post(confirmPath, { requestId: PEOPLE_REQUEST }));
    expect([hidden.statusCode, hidden.json]).toEqual([404, { error: "not_found", message: "You don't have access to this task." }]);
    const other = await call(thrower({ code: "SOMETHING_ELSE", message: "workflow revision digest" }), post(confirmPath, { requestId: PEOPLE_REQUEST }));
    expect(other.statusCode).toBe(503);
    expect(other.body).not.toMatch(/workflow|revision|digest/);
  });
});

describe("task page API through the broker, with the decision cards on", () => {
  const cards = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { if (cards === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = cards; });
  const LEE: Developer = { developerId: "f".repeat(64), name: "Lee Park", provider: "slack", sessionId: "s-lee", slackUserId: "U0LEE0001" };
  const NIA: Developer = { developerId: "a".repeat(64), name: "Nia Fox", provider: "slack", sessionId: "s-nia", slackUserId: "U0NIA0001" };

  /** A shared task whose structured coding plan v1 waits for Maya; Lee is in the channel, Nia and Omar are not. */
  async function sharedTask(onMembership: () => void = () => undefined) {
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} }, channelMembers: async (request) => (onMembership(), {
      ok: true, memberOf: request.slackUserId === MAYA.slackUserId || request.slackUserId === LEE.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
    }) });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test", shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    const id = (started.body.task as { taskId: string }).taskId;
    const workspaceId = (harness.db.get(`DEVTASK#${id}`, "META") as { workspaceId: string }).workspaceId;
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const planning = operations().find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    const plan = pagePlan();
    delete plan.checks;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(plan));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflow = (harness.db.get(`DEVTASK#${id}`, "META") as { workflow: { revision: number; stage: string; artifacts: Array<{ sha256: string }> } }).workflow;
    expect(workflow.stage).toBe("PLAN_REVIEW");
    const sha256 = workflow.artifacts.at(-1)!.sha256;
    const revision = workflow.revision;
    for (const who of [MAYA, OMAR, LEE, NIA]) {
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
        ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const send = async (who: Developer, method: string, path: string, body?: unknown) => {
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider,
        startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
      const response = await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: path, rawQueryString: "",
        headers: {
          host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${CSRF}`,
          ...(method === "POST" ? { origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        requestContext: { requestId: randomUUID(), http: { method } },
      }) as { statusCode: number; headers: Record<string, string>; body: string };
      return { ...response, json: (() => { try { return JSON.parse(response.body) as Record<string, unknown>; } catch { return {}; } })() };
    };
    const decision = (extra: Record<string, unknown> = {}) => ({
      requestId: randomUUID(), expectedRevision: revision, artifactDigest: sha256, decision: "APPROVE",
      answers: [{ decisionId: "d1", optionId: "below", opened: false }], includedCommentIds: [], ...extra,
    });
    return { harness, id, sha256, revision, send, decision };
  }

  it("OWNER DECISION 18: nobody comments, suggests or decides on the page with the cards on (410, with where); the owner decides on the card", async () => {
    const t = await sharedTask();
    for (const [who, suffix, body] of [[LEE, "comments", { ...commentBody, requestId: randomUUID() }], [LEE, "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }],
      [MAYA, "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }], [LEE, "decision", t.decision()], [MAYA, "decision", t.decision()]] as const) {
      const refused = await t.send(who, "POST", `/review/${t.id}/task/api/${suffix}`, body);
      expect(refused.statusCode, `${who.name} ${suffix}`).toBe(410);
      expect(refused.json.taskPage, suffix).toMatch(/^\/app\/sessions\/ses_/u);
    }
    expect(t.harness.db.find((item) => item.entityType === "TASK_COMMENT")).toHaveLength(0);
    expect((t.harness.db.get(`DEVTASK#${t.id}`, "META") as { workflow: { revision: number } }).workflow.revision).toBe(t.revision);
    // The teammate has no card to decide it; the owner's card decides it, through the one workflow decision.
    expect((await cardDecision(t.harness, LEE, t.id)).status).toBe(404);
    const owner = await cardDecision(t.harness, MAYA, t.id, { answers: [{ decisionId: "d1", optionId: "above", opened: true }] });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    expect((t.harness.db.get(`DEVTASK#${t.id}`, "META") as { workflow: { revision: number; decisions: Array<{ decision: string; actorRole: string }> } }).workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE", actorRole: "TASK_OWNER" });
  });

  it("a reader without access cannot tell a task exists", async () => {
    const t = await sharedTask();
    const missing = randomUUID();
    for (const who of [NIA, OMAR]) {
      for (const [method, suffix, body] of [["GET", "state", undefined], ["GET", "comments", undefined], ["POST", "comments", { ...commentBody, requestId: randomUUID() }], ["POST", "decision", t.decision()]] as const) {
        const real = await t.send(who, method, `/review/${t.id}/task/api/${suffix}`, body);
        const none = await t.send(who, method, `/review/${missing}/task/api/${suffix}`, body);
        // A read is the not found a missing task gets; every write is the read-only refusal, without the task page's path (OWNER DECISION 7, 17 and 18): the same for a real task and a missing one.
        // Follow-up R1: someone who may not read the task has no task page to be pointed to, so a write reaches its function, which answers as a missing task.
        expect(real.statusCode, `${who.name} ${suffix}`).toBe(404);
        expect(real.body).toBe(none.body);
        expect(real.json).toEqual({ error: "not_found", message: "You don't have access to this task." });
        expect(real.body).not.toContain("Maya");
      }
    }
  });

  it("OWNER DECISION 18: the page forwards a reader to the task page with the document's panel open; nobody else learns where it is", async () => {
    const t = await sharedTask();
    const sessionId = String((t.harness.db.get(`DEVTASK#${t.id}`, "META") as { sessionId?: string }).sessionId);
    for (const who of [MAYA, LEE]) {
      const forwarded = await t.send(who, "GET", `/review/${t.id}/task`);
      expect([forwarded.statusCode, forwarded.headers.location], who.name).toEqual([302, `/app/sessions/${sessionId}?doc=plan`]);
    }
    const outsider = await t.send(NIA, "GET", `/review/${t.id}/task`);
    expect(outsider.statusCode).toBe(404);
    expect(outsider.headers.location).toBeUndefined();
  });

  it("Follow-up R1: a task with no task page in Rovara keeps its old page fully: its controls are drawn, and comments, suggestions and the decision write there, by the same rules", async () => {
    const t = await sharedTask();
    const { sessionId: _session, ...meta } = t.harness.db.get(`DEVTASK#${t.id}`, "META") as Record<string, unknown>;
    void _session;
    t.harness.db.set(meta);
    const owner = await t.send(MAYA, "GET", `/review/${t.id}/task`);
    expect(owner.statusCode).toBe(200);
    const island = JSON.parse(/<script type="application\/json" id="agentx-page-data">([\s\S]*?)<\/script>/u.exec(owner.body)![1]!) as { canDecide: boolean; canComment: boolean };
    expect(island).toMatchObject({ canDecide: true, canComment: true });
    expect(owner.body).toContain('id="decide-dialog"');
    const comment = await t.send(LEE, "POST", `/review/${t.id}/task/api/comments`, { ...commentBody, requestId: randomUUID() });
    expect(comment.statusCode, comment.body).toBe(201);
    expect((await t.send(LEE, "POST", `/review/${t.id}/task/api/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" })).statusCode).toBe(200);
    // The owner's suggestion is refused by the page's own rule (not a 410), and a reader without access still learns nothing.
    expect((await t.send(MAYA, "POST", `/review/${t.id}/task/api/suggestions`, { document: "plan", decisionId: "d1", optionId: "above" })).statusCode).toBe(403);
    const outsider = await t.send(NIA, "POST", `/review/${t.id}/task/api/comments`, { ...commentBody, requestId: randomUUID() });
    const missing = await t.send(NIA, "POST", `/review/${randomUUID()}/task/api/comments`, { ...commentBody, requestId: randomUUID() });
    expect([outsider.statusCode, outsider.body]).toEqual([404, missing.body]);
    // The decision goes to the same page decision as with the cards off.
    const decided = await t.send(MAYA, "POST", `/review/${t.id}/task/api/decision`, t.decision({ includedCommentIds: [] }));
    expect(decided.statusCode, decided.body).not.toBe(410);
    expect(t.harness.db.find((item) => item.entityType === "TASK_COMMENT")).toHaveLength(1);
  });

});
