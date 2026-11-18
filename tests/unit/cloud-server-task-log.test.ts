// L4-B5: Cloud's "Decisions and answers" route (`/v1/web/sessions/{ses}/log`), answered from Rovara Code's task log as the signed-in person. A fake Code with two companies stands in: the task id comes from Cloud's own
// session record, the Code session id comes from Code's own task read (never from the browser), Code's refusals pass through, and only the questions, answers and decisions reach the page, in the fields it reads.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { projectLog } from "../../packages/cloud-server/src/task-log-routes.js";
import { SessionLogResponseSchema } from "../../packages/contracts/src/app-session-log.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), BEA = "b".repeat(64), CAL = "c".repeat(64);
const TASK_A = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", TASK_B = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466", TASK_OLD = "8b9d0c1e-2b3a-4c5d-8e7f-001122334477";
const CODE_SES_A = "ses_codeaaaaaaaaaaaaaaaa", CODE_SES_B = "ses_codebbbbbbbbbbbbbbbb";
const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa", COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SES_A = "ses_aaaaaaaaaaaaaaaaaaaa", SES_B = "ses_bbbbbbbbbbbbbbbbbbbb", SES_OLD = "ses_oooooooooooooooooooo", SES_NONE = "ses_zzzzzzzzzzzzzzzzzzzz";
const AT = "2026-11-17T10:02:00.000Z";

interface Who { developerId: string; name: string; company: string; token: string }
const WHO: Record<string, Who> = {
  "ada-code": { developerId: ADA, name: "Ada", company: "A", token: "ada-access" },
  "cal-code": { developerId: CAL, name: "Cal", company: "A", token: "cal-access" },
  "bea-code": { developerId: BEA, name: "Bea", company: "B", token: "bea-access" },
};
interface Call { method: string; path: string; token: string }

const answerEntry = (over: Record<string, unknown> = {}) => ({ key: "answer:r1:q1", at: AT, kind: "answer", questionId: "q1", round: 1, text: "20,000", by: "Ana Ruiz", surface: "linear", ...over });
const questionEntry = (over: Record<string, unknown> = {}) => ({ key: "question:r1:q1", at: "2026-11-17T10:01:00.000Z", kind: "question", questionId: "q1", round: 1, text: "Cap value?", choices: ["20,000", "50,000"], ...over });
const approvalEntry = (over: Record<string, unknown> = {}) => ({ key: "approval:abc", at: "2026-11-17T10:03:00.000Z", kind: "approval", what: "plan", outcome: "approved", code: "abababab", revision: 1, by: "Nick P.", surface: "web", ...over });

/** A fake Code with two companies. Ada owns TASK_A (company A) and Cal may read it; Bea owns TASK_B (company B). TASK_OLD has no Code session. */
function fakeCode() {
  const calls: Call[] = [];
  const logs: Record<string, unknown> = {
    [CODE_SES_A]: { entries: [questionEntry(), answerEntry(), approvalEntry()] },
    [CODE_SES_B]: { entries: [answerEntry({ text: "from company B", by: "Bo" })] },
  };
  const flags = { log: "ok" as "ok" | "garbage" | "404" | "500", task: "ok" as "ok" | "badSession" | "garbage", calCanRead: true };
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (status: number, code: string, message: string) => respond(status, { error: { code, message } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    if (url.pathname === "/v1/auth/token") {
      const who = WHO[new URLSearchParams(bodyText).get("code") ?? ""];
      return who === undefined ? respond(400, { error: "invalid_grant" }) : respond(200, { access_token: who.token });
    }
    const me = Object.values(WHO).find((entry) => `Bearer ${entry.token}` === headers.authorization);
    if (me === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: me.developerId, displayName: me.name, administrator: false, companyId: me.company === "A" ? COMPANY_A : COMPANY_B, companyRole: "member", projects: [{ name: "payments", access: "developer" }], notices: [] });
    calls.push({ method, path: url.pathname + url.search, token: me.token });
    const task = /^\/v1\/dev\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (task !== null) {
      const taskId = task[1]!;
      const mine = (taskId === TASK_A && (me.developerId === ADA || (me.developerId === CAL && flags.calCanRead))) || (taskId === TASK_B && me.developerId === BEA) || (taskId === TASK_OLD && me.developerId === ADA);
      if (!mine) return refuse(404, "TASK_NOT_FOUND", `no task ${taskId} of yours`);
      if (flags.task === "garbage") return respond(200, { task: "nope" });
      const sessionId = taskId === TASK_A ? CODE_SES_A : taskId === TASK_B ? CODE_SES_B : undefined;
      return respond(200, { task: { taskId, title: "t", project: "payments", status: "RUNNING", createdAt: AT, updatedAt: AT, ...(flags.task === "badSession" ? { sessionId: "../../x" } : sessionId === undefined ? {} : { sessionId }) } });
    }
    const log = /^\/v1\/app\/sessions\/([^/]+)\/log$/u.exec(url.pathname);
    if (log !== null && method === "GET") {
      const sessionId = log[1]!;
      // Code's own reader gate and company boundary.
      const allowed = (sessionId === CODE_SES_A && (me.developerId === ADA || (me.developerId === CAL && flags.calCanRead))) || (sessionId === CODE_SES_B && me.developerId === BEA);
      if (!allowed || flags.log === "404") return refuse(404, "NOT_FOUND", "There is no such session.");
      if (flags.log === "500") return refuse(500, "RUNTIME_UNAVAILABLE", "down");
      return respond(200, flags.log === "garbage" ? { entries: "nope" } : logs[sessionId]);
    }
    return refuse(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  return { fetchImpl, calls, flags, logs };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "tasks:read", fetch: code.fetchImpl });
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date("2026-11-17T12:00:00.000Z") });
  const call = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) };
    return (await handler(request))!;
  };
  const signIn = async (who: "ada-code" | "cal-code" | "bea-code") => {
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=${who}&state=${state}`);
    const cookie = back.headers["set-cookie"]!.split(";")[0]!;
    const me = JSON.parse((await call("GET", "/v1/web/me", { cookie })).body) as { csrf: string };
    return { cookie, csrf: me.csrf };
  };
  const session = (sessionId: string, taskId: string, owner: { developerId: string; name: string }) => work.put({ sessionId, taskId, project: "payments", startedBy: owner, owner, createdAt: AT, revision: 1 });
  return { code, call, signIn, session };
}
type LogBody = { entries: Array<Record<string, unknown>>; error?: unknown };
const json = (response: { body: string }) => JSON.parse(response.body) as LogBody;
const base = async () => {
  const context = setUp();
  await context.session(SES_A, TASK_A, { developerId: ADA, name: "Ada" });
  await context.session(SES_B, TASK_B, { developerId: BEA, name: "Bea" });
  await context.session(SES_OLD, TASK_OLD, { developerId: ADA, name: "Ada" });
  return { ...context, ada: await context.signIn("ada-code"), cal: await context.signIn("cal-code"), bea: await context.signIn("bea-code") };
};
const path = (session = SES_A) => `/v1/web/sessions/${session}/log`;

describe("the decisions and answers of a session", () => {
  it("answers Code's log as the person, in the shape the app reads, asking Code for the session id its own task read named", async () => {
    const w = await base();
    const answer = await w.call("GET", path(), { cookie: w.ada.cookie });
    expect(answer.status).toBe(200);
    const body = json(answer);
    expect(SessionLogResponseSchema.parse(body).entries.map((entry) => entry.kind)).toEqual(["question", "answer", "approval"]);
    expect(w.code.calls.map((call) => call.path)).toEqual([`/v1/dev/tasks/${TASK_A}?events=0`, `/v1/app/sessions/${CODE_SES_A}/log`]);
    expect(w.code.calls.every((call) => call.token === "ada-access")).toBe(true);
  });

  it("keeps only the fields the app reads: an entry's extra members, the plan summary, the milestones and the pull requests are dropped", async () => {
    const w = await base();
    w.code.logs[CODE_SES_A] = { entries: [
      questionEntry({ secretField: "x" }), answerEntry({ orgId: COMPANY_A, taskId: TASK_A }), approvalEntry(),
      { key: "plan:r1", at: AT, kind: "plan_summary", revision: 1, needed: "n", lines: ["l"], risk: "low" }, { key: "status:started", at: AT, kind: "status", moment: "started" },
      { key: "pr:abc", at: AT, kind: "pr", urls: ["https://github.com/a/b/pull/1"] }, { key: "future:x", at: AT, kind: "future_kind", text: "later" },
    ] };
    const body = json(await w.call("GET", path(), { cookie: w.ada.cookie }));
    expect(body.entries).toHaveLength(3);
    expect(JSON.stringify(body)).not.toMatch(/secretField|orgId|taskId|plan:r1|pull\/1|future/u);
    expect(approvalEntryKeys(body.entries[2]!)).toEqual(["at", "by", "key", "kind", "outcome", "surface", "what"]);
  });

  it("leaves out an entry that does not read (bad key, time, surface, empty text, too long a list) and refuses a list that is not a list", async () => {
    const w = await base();
    w.code.logs[CODE_SES_A] = { entries: [answerEntry({ key: "bad key" }), answerEntry({ at: "yesterday" }), answerEntry({ at: "2026-02-31T10:00:00.000Z" }), answerEntry({ at: "2026-11-17T10:00:00+02:00" }), answerEntry({ surface: "carrier-pigeon" }), answerEntry({ text: "\u0007 " }), answerEntry({ by: "" }), answerEntry({ questionId: "../x" }), answerEntry({ round: -1 }), answerEntry({ key: "answer:r2:q1", text: "kept" })] };
    expect(json(await w.call("GET", path(), { cookie: w.ada.cookie })).entries).toHaveLength(1);
    w.code.flags.log = "garbage";
    const refused = await w.call("GET", path(), { cookie: w.ada.cookie });
    expect(refused.status).toBe(502);
    expect(refused.body).not.toContain("nope");
    expect(projectLog({ entries: Array.from({ length: 201 }, () => answerEntry()) })).toBeUndefined();
    expect(projectLog(null)).toBeUndefined();
    expect(projectLog({})).toBeUndefined();
  });

  it("makes every text one plain line and cuts it at the bound", async () => {
    const w = await base();
    w.code.logs[CODE_SES_A] = { entries: [answerEntry({ text: `line one\nline\u0007 two ${"x".repeat(900)}`, by: "Ana​ Ruiz" })] };
    const entry = json(await w.call("GET", path(), { cookie: w.ada.cookie })).entries[0]!;
    const text = entry["text"] as string;
    expect(text.includes("\n") || text.includes(String.fromCharCode(7))).toBe(false);
    expect([...text].length).toBeLessThanOrEqual(500);
    expect(entry["by"]).toBe("Ana Ruiz");
  });

  it("a task Code has no session for has an empty log, and asks Code for no log", async () => {
    const w = await base();
    const answer = await w.call("GET", path(SES_OLD), { cookie: w.ada.cookie });
    expect(json(answer)).toEqual({ entries: [] });
    expect(w.code.calls.some((call) => call.path.includes("/log"))).toBe(false);
  });

  it("a Code session id that is not one is refused in fixed words and nothing is asked of Code with it", async () => {
    const w = await base();
    w.code.flags.task = "badSession";
    const answer = await w.call("GET", path(), { cookie: w.ada.cookie });
    expect(answer.status).toBe(502);
    expect(w.code.calls.some((call) => call.path.includes("/log"))).toBe(false);
    w.code.flags.task = "garbage";
    expect((await w.call("GET", path(), { cookie: w.ada.cookie })).status).toBe(502);
  });
});

describe("who may read it: Code decides", () => {
  it("a reader Code lets read the task reads the log; one it does not gets Code's refusal and no log", async () => {
    const w = await base();
    expect((await w.call("GET", path(), { cookie: w.cal.cookie })).status).toBe(200);
    w.code.flags.calCanRead = false;
    w.code.calls.length = 0;
    const refused = await w.call("GET", path(), { cookie: w.cal.cookie });
    expect(refused.status).toBe(404);
    expect(json(refused)).toEqual({ error: { code: "TASK_NOT_FOUND", message: `no task ${TASK_A} of yours` } });
    expect(refused.body).not.toContain("Ana Ruiz");
    expect(w.code.calls.some((call) => call.path.includes("/log"))).toBe(false);
  });

  it("when Code refuses the log itself (its reader gate), the refusal reaches the page and nothing else does", async () => {
    const w = await base();
    w.code.flags.log = "404";
    const refused = await w.call("GET", path(), { cookie: w.ada.cookie });
    expect(refused.status).toBe(404);
    expect(json(refused)).toEqual({ error: { code: "NOT_FOUND", message: "There is no such session." } });
    expect(refused.body).not.toContain("Ana Ruiz");
  });

  it("two companies: a person of one company reads nothing of the other's session, and each reads its own log", async () => {
    const w = await base();
    const crossed = await w.call("GET", path(SES_B), { cookie: w.ada.cookie });
    expect(crossed.status).toBe(404);
    expect(crossed.body).not.toContain("from company B");
    const own = await w.call("GET", path(SES_B), { cookie: w.bea.cookie });
    expect(json(own).entries[0]!["text"]).toBe("from company B");
    expect(JSON.stringify(json(await w.call("GET", path(), { cookie: w.ada.cookie })))).not.toContain("from company B");
  });

  it("an unknown session is the session-not-found answer, and nothing is asked of Code", async () => {
    const w = await base();
    const answer = await w.call("GET", path(SES_NONE), { cookie: w.ada.cookie });
    expect(answer.status).toBe(404);
    expect(w.code.calls).toEqual([]);
  });

  it("needs a signed-in person, and only GET is served", async () => {
    const w = await base();
    expect((await w.call("GET", path())).status).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await w.call(method, path(), { cookie: w.ada.cookie, csrf: w.ada.csrf, body: {} });
      expect([404, 501], method).toContain(answer.status);
    }
    expect(w.code.calls.some((call) => call.path.includes("/log"))).toBe(false);
  });

  it("the Code session id is never taken from the request: a query or a path that names one changes nothing", async () => {
    const w = await base();
    const answer = await w.call("GET", `${path()}?session=${CODE_SES_B}&taskId=${TASK_B}`, { cookie: w.ada.cookie });
    expect(JSON.stringify(json(answer))).not.toContain("from company B");
    expect(w.code.calls.map((call) => call.path)).toEqual([`/v1/dev/tasks/${TASK_A}?events=0`, `/v1/app/sessions/${CODE_SES_A}/log`]);
  });
});

function approvalEntryKeys(entry: Record<string, unknown>): string[] { return Object.keys(entry).sort(); }
