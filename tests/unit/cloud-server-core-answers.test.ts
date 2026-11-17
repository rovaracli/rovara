// K0b: POST /v1/app/sessions/{ses}/answers through Cloud's handler. The owner's answers to the questions Understand asked go to Code's
// POST /v1/dev/tasks/{taskId}/answers (Rovara Code S3) as the signed-in person, for every task (Code answers a workflow task itself). The body is
// checked at runtime with Code's limits and only requestId, round and the answers are forwarded. The task id comes only from Cloud's own session
// record, never from the browser. Code decides who may answer (only the task's owners); its refusals reach the app unchanged.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession, type WorkSession } from "../../packages/cloud-server/src/index.js";
import { ANSWERS_MAX, ANSWER_TEXT_MAX, ANSWERS_REFUSED } from "../../packages/cloud-server/src/answers.js";
import { SessionResponseReaderSchema } from "../../packages/contracts/src/web.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const SAM = "b".repeat(64);
const EVE = "c".repeat(64);
const TASK = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const OTHER_TASK = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466";
const FORGED_SESSION = "ses_zzzzzzzzzzzzzzzzzzzz";
const CLOUD_SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const WEB = `/v1/web/sessions/${CLOUD_SESSION}/answers`;
const GOOD = { requestId: REQUEST_ID, round: 1, revision: 4, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "Only the README." }] };
/** What Cloud sends Code for GOOD: the revision is checked but not forwarded. */
const SENT = { requestId: REQUEST_ID, round: 1, answers: GOOD.answers };
const NOT_YOURS = { error: { code: "FORBIDDEN", message: "Only the task's owner can answer its questions." } };
const NOT_WAITING = { error: { code: "INTENT_NOT_WAITING", message: "This task isn't waiting for answers." } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface CodeCall { method: string; path: string; authorization: string | undefined; raw: string | undefined }
type Kind = "core" | "legacy";

function setUp(kind: Kind = "core") {
  const calls: CodeCall[] = [];
  let waiting = true;
  const view = () => ({
    taskId: TASK, title: "Fix the README typo", project: "payments", status: waiting ? "SUCCEEDED" : "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false,
    createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", events: [], changedFiles: [], artifacts: [], pullRequests: [], pageActions: [],
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, authorization: headers.authorization, raw: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    const token = call.authorization;
    // Eve belongs to another company: Code answers as for a task that does not exist.
    if (token === "Bearer eve-token") return json(404, { error: { code: "TASK_NOT_FOUND", message: "There is no such task." } });
    if (url.pathname === `/v1/dev/tasks/${TASK}` && call.method === "GET") return json(200, { task: view() });
    if (url.pathname === `/v1/dev/tasks/${TASK}/answers` && call.method === "POST") {
      // Sam can read the task but is not its owner: Code's own words (D5).
      if (token === "Bearer sam-token") return json(403, NOT_YOURS);
      // A workflow task never asks questions, and a core task answered once waits for nothing: Code's own words.
      if (kind === "legacy" || !waiting) return json(409, NOT_WAITING);
      waiting = false;
      return json(200, { task: view() });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const record: WorkSession = { sessionId: CLOUD_SESSION, taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-14T10:00:00.000Z", revision: 1 };
  const seed = async () => { await work.put({ ...record }); };
  const signIn = async (token: string, access: CodeSession["access"]) => {
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const post = async (target: string, body: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method: "POST", path: url.pathname, query: url.searchParams, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown };
  };
  const ada = () => signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
  const sam = () => signIn("sam-token", { developerId: SAM, displayName: "Sam", administrator: false, projects: [{ name: "payments", access: "developer" }], notices: [] });
  const eve = () => signIn("eve-token", { developerId: EVE, displayName: "Eve", administrator: false, projects: [], notices: [] });
  const sent = () => calls.filter((call) => call.method === "POST" && /\/answers$/u.test(call.path));
  const route = () => calls.map((call) => `${call.method} ${call.path}`);
  return { post, calls, seed, ada, sam, eve, sent, route };
}

describe("a task's answers go to Code's POST /v1/dev/tasks/{taskId}/answers", () => {
  it("reads the task, posts the checked answers under the task id of Cloud's own record, reads the task again, and answers the session", async () => {
    const w = setUp("core");
    await w.seed();
    const res = await w.post(WEB, GOOD, await w.ada());
    expect(res.status).toBe(200);
    expect(SessionResponseReaderSchema.parse(res.body).session).toMatchObject({ sessionId: CLOUD_SESSION, status: "running" });
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `POST /v1/dev/tasks/${TASK}/answers`, `GET /v1/dev/tasks/${TASK}`]);
    expect(w.sent()[0]!.authorization).toBe("Bearer ada-token");
    expect(JSON.parse(w.sent()[0]!.raw!)).toEqual(SENT);
  });

  it("forwards only requestId, round and the checked answers: the revision and unknown fields at the top and in an answer are dropped", async () => {
    const w = setUp("core");
    await w.seed();
    const body = {
      ...GOOD, by: { name: "Mallory" }, source: "mcp", taskId: OTHER_TASK, actorId: ADA, expectedRevision: 99,
      answers: [{ questionId: "q1", optionId: "b", by: "x", __proto__: { admin: true }, extra: 1 }, { questionId: "q2", text: "ok", optionId: "a" }],
    };
    const res = await w.post(WEB, body, await w.ada());
    expect(res.status).toBe(200);
    expect(JSON.parse(w.sent()[0]!.raw!)).toEqual({ requestId: REQUEST_ID, round: 1, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", optionId: "a", text: "ok" }] });
  });

  it("a body without the revision is taken (Code's stale-form guard is the round)", async () => {
    const w = setUp("core");
    await w.seed();
    expect((await w.post(WEB, SENT, await w.ada())).status).toBe(200);
    expect(JSON.parse(w.sent()[0]!.raw!)).toEqual(SENT);
  });

  it("never takes the task id (or a session id) from the request: path, query and body ids are ignored", async () => {
    const w = setUp("core");
    await w.seed();
    const body = { ...GOOD, sessionId: FORGED_SESSION, codeSessionId: FORGED_SESSION, taskId: OTHER_TASK, path: `/v1/dev/tasks/${OTHER_TASK}/answers` };
    const res = await w.post(`${WEB}?sessionId=${FORGED_SESSION}&taskId=${OTHER_TASK}`, body, await w.ada());
    expect(res.status).toBe(200);
    expect(w.sent().map((call) => call.path)).toEqual([`/v1/dev/tasks/${TASK}/answers`]);
    expect(w.calls.some((call) => call.path.includes(FORGED_SESSION) || call.path.includes(OTHER_TASK) || (call.raw ?? "").includes(FORGED_SESSION) || (call.raw ?? "").includes(OTHER_TASK))).toBe(false);
  });

  it("a session id Cloud does not hold reaches nothing", async () => {
    const w = setUp("core");
    await w.seed();
    expect((await w.post(`/v1/web/sessions/${FORGED_SESSION}/answers`, GOOD, await w.ada())).status).toBe(404);
    expect(w.calls).toHaveLength(0);
  });
});

describe("a workflow (legacy) task", () => {
  it("is forwarded like any task, and Code's own answer (nothing waits) reaches the app unchanged", async () => {
    const w = setUp("legacy");
    await w.seed();
    const res = await w.post(WEB, GOOD, await w.ada());
    expect(res).toEqual({ status: 409, body: NOT_WAITING });
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `POST /v1/dev/tasks/${TASK}/answers`]);
  });
});

describe("the body is checked at runtime with Code's limits and nothing reaches Code when it is wrong", () => {
  const ok = (answers: unknown) => ({ ...GOOD, answers });
  const cases: Array<[string, unknown, string]> = [
    ["no body", "", ANSWERS_REFUSED.body],
    ["null", null, ANSWERS_REFUSED.body],
    ["an array", [GOOD], ANSWERS_REFUSED.body],
    ["a string", '"x"', ANSWERS_REFUSED.body],
    ["no requestId", { ...GOOD, requestId: undefined }, ANSWERS_REFUSED.requestId],
    ["a requestId that is not a UUID", { ...GOOD, requestId: "not-a-uuid" }, ANSWERS_REFUSED.requestId],
    ["a numeric requestId", { ...GOOD, requestId: 7 }, ANSWERS_REFUSED.requestId],
    ["no round", { ...GOOD, round: undefined }, ANSWERS_REFUSED.round],
    ["round 0", { ...GOOD, round: 0 }, ANSWERS_REFUSED.round],
    ["a negative round", { ...GOOD, round: -1 }, ANSWERS_REFUSED.round],
    ["a fractional round", { ...GOOD, round: 1.5 }, ANSWERS_REFUSED.round],
    ["a string round", { ...GOOD, round: "1" }, ANSWERS_REFUSED.round],
    ["a huge round", { ...GOOD, round: 1e9 }, ANSWERS_REFUSED.round],
    ["a negative revision", { ...GOOD, revision: -1 }, ANSWERS_REFUSED.revision],
    ["a fractional revision", { ...GOOD, revision: 0.5 }, ANSWERS_REFUSED.revision],
    ["a string revision", { ...GOOD, revision: "4" }, ANSWERS_REFUSED.revision],
    ["a null revision", { ...GOOD, revision: null }, ANSWERS_REFUSED.revision],
    ["no answers", { ...GOOD, answers: undefined }, ANSWERS_REFUSED.list],
    ["empty answers", ok([]), ANSWERS_REFUSED.list],
    ["answers that are not a list", ok({ questionId: "q1", optionId: "a" }), ANSWERS_REFUSED.list],
    ["four answers", ok([1, 2, 3, 1].map((n) => ({ questionId: `q${String(n)}`, optionId: "a" }))), ANSWERS_REFUSED.list],
    ["an answer that is not an object", ok(["a"]), ANSWERS_REFUSED.answer],
    ["an answer with neither option nor text", ok([{ questionId: "q1" }]), ANSWERS_REFUSED.answer],
    ["an answer with no questionId", ok([{ optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["a numeric questionId", ok([{ questionId: 1, optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["questionId q4", ok([{ questionId: "q4", optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["questionId q0", ok([{ questionId: "q0", optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["questionId Q1", ok([{ questionId: "Q1", optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["a questionId with a slash", ok([{ questionId: "q1/../x", optionId: "a" }]), ANSWERS_REFUSED.answer],
    ["an optionId that is not a string", ok([{ questionId: "q1", optionId: 3 }]), ANSWERS_REFUSED.answer],
    ["optionId e", ok([{ questionId: "q1", optionId: "e" }]), ANSWERS_REFUSED.answer],
    ["optionId A", ok([{ questionId: "q1", optionId: "A" }]), ANSWERS_REFUSED.answer],
    ["an optionId with two letters", ok([{ questionId: "q1", optionId: "ab" }]), ANSWERS_REFUSED.answer],
    ["null text", ok([{ questionId: "q1", text: null }]), ANSWERS_REFUSED.text],
    ["empty text", ok([{ questionId: "q1", text: "" }]), ANSWERS_REFUSED.text],
    ["numeric text", ok([{ questionId: "q1", text: 5 }]), ANSWERS_REFUSED.text],
    ["text that is too long", ok([{ questionId: "q1", text: "x".repeat(ANSWER_TEXT_MAX + 1) }]), ANSWERS_REFUSED.text],
  ];
  it.each(cases)("%s: 400, fixed words, Code is only asked for the task", async (_name, body, message) => {
    const w = setUp("core");
    await w.seed();
    const res = await w.post(WEB, body, await w.ada());
    expect(res).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message } } });
    expect(w.sent()).toHaveLength(0);
  });

  it("the limits are Code's: three answers, q1 to q3, a to d, text of 2,000 characters go through; the refusal never echoes the input", async () => {
    expect(ANSWERS_MAX).toBe(3);
    expect(ANSWER_TEXT_MAX).toBe(2000);
    const w = setUp("core");
    await w.seed();
    const biggest = ok([{ questionId: "q1", optionId: "a", text: "x".repeat(ANSWER_TEXT_MAX) }, { questionId: "q2", optionId: "d" }, { questionId: "q3", text: "y" }]);
    expect((await w.post(WEB, biggest, await w.ada())).status).toBe(200);
    const w2 = setUp("core");
    await w2.seed();
    const secret = "my-private-note";
    const auth = await w2.ada();
    for (const body of [{ ...GOOD, round: secret }, ok([{ questionId: secret, optionId: "a" }]), ok([{ questionId: "q1", optionId: secret }]), ok([{ questionId: "q1", text: secret.repeat(400) }])]) {
      const refused = await w2.post(WEB, body, auth);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain(secret);
    }
  });
});

describe("Code decides who answers", () => {
  it("a person Code lets read the task but who is not its owner gets Code's refusal, unchanged; only the one refused answers call goes out", async () => {
    const w = setUp("core");
    await w.seed();
    const res = await w.post(WEB, GOOD, await w.sam());
    expect(res).toEqual({ status: 403, body: NOT_YOURS });
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `POST /v1/dev/tasks/${TASK}/answers`]);
  });

  it("a person of another company (Code answers the task read 404) gets Code's words; nothing else is forwarded, even with a bad body", async () => {
    const w = setUp("core");
    await w.seed();
    const auth = await w.eve();
    for (const body of [GOOD, { nope: true }]) {
      const res = await w.post(WEB, body, auth);
      expect(res).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "There is no such task." } } });
    }
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `GET /v1/dev/tasks/${TASK}`]);
  });

  it("Code's own conflict (nothing is waiting for answers) reaches the app unchanged", async () => {
    const w = setUp("core");
    await w.seed();
    const auth = await w.ada();
    expect((await w.post(WEB, GOOD, auth)).status).toBe(200);
    const again = await w.post(WEB, { ...GOOD, requestId: "44444444-4444-4444-8444-444444444444" }, auth);
    expect(again).toEqual({ status: 409, body: NOT_WAITING });
  });

  it("a session Cloud does not hold is Cloud's own 404, with no call to Code", async () => {
    const w = setUp("core");
    expect((await w.post(WEB, GOOD, await w.ada())).status).toBe(404);
    expect(w.calls).toHaveLength(0);
  });

  it("needs the CSRF token and a session", async () => {
    const w = setUp("core");
    await w.seed();
    expect((await w.post(WEB, GOOD)).status).toBe(401);
    expect((await w.post(WEB, GOOD, { cookie: (await w.ada()).cookie, "x-rovara-csrf": "wrong" })).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
});
