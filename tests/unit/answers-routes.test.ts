/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// Lead 4 slice J3: the smart Just answer's web door and the start box's suggestion through Cloud's handler, answered from Code's J1 answer service and its start-suggest route as the signed-in person.
// The pretend Code keeps two companies and three projects and applies Code's rule (a role on THAT project, in the project's own company; an owner or admin reads every project of their company).
// Cloud must: be OFF unless the deployment says so (no Code call), pass the person's own token, put the project only into Code's path, forward only known body fields with `channel: "web"` it sets itself,
// rebuild Code's answers field by field, refuse an answer that does not read, and answer refusals in fixed words (no echo of input or of Code's text).
import { describe, expect, it } from "vitest";
import {
  ANSWERS_ANSWERS, ANSWERS_WORDS, CodeClient, LocalSessionStore, LocalWorkSessionStore, answerObject, createCloudHandler, suggestObject, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import {
  ANSWERS_WORDS as APP_WORDS, ANSWER_WORDS, ANSWER_SOURCES_MAX, AnswerResponseSchema, START_SUGGEST_WORDS, START_SMALL_TALK_WORDS, StartSuggestResponseSchema,
} from "../../packages/contracts/src/app-answers.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64), PAM = "b".repeat(64), BOB = "c".repeat(64), NOB = "d".repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const SHA = "a".repeat(40);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ADA, company: A, role: "owner", grants: {} },
  "pam-token": { id: PAM, company: A, role: "member", grants: { payments: "developer" } },
  "bob-token": { id: BOB, company: B, role: "admin", grants: {} },
  "nob-token": { id: NOB, grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, billing: A, ledger: B };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

const goodAnswer = (extra: Record<string, unknown> = {}) => ({
  answerId: "a1234567890", threadId: "t-1234", outcome: "answered", text: "Refunds last 30 days. [1]", unconfirmed: [], wikiPages: [{ pageId: "billing", title: "billing" }],
  sources: [{ n: 1, repo: "web", path: "src/refund.ts", line: 3, lineEnd: 9, commit: SHA }], action: { kind: "quick_task", label: "Start a Quick task", title: "Change the refund window" }, ...extra,
});
const NOT_SET_UP = { threadId: "t-1234", outcome: "not_set_up", text: "", honesty: ANSWER_WORDS.notSetUp, unconfirmed: [], sources: [], wikiPages: [] };

function setUp(options: { enabled?: boolean; override?: Override } = {}) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
    calls.push(call);
    const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    }
    const replaced = options.override?.(call, person);
    if (replaced !== undefined) return replaced;
    const match = /^\/v1\/app\/projects\/([^/]+)\/(answers|code\/suggest)$/u.exec(url.pathname);
    if (match === null || call.method !== "POST") return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const project = decodeURIComponent(match[1]!);
    const admin = person.role === "owner" || person.role === "admin";
    if (person.company === undefined || PROJECTS[project] !== person.company || (!admin && person.grants[project] === undefined)) return json(404, { error: { code: "NOT_FOUND", message: `project not found ${LEAK}` } });
    return match[2] === "answers" ? json(200, goodAnswer()) : json(200, { kind: "small_change", classifier: "ok", pick: "quick" });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)), ...(options.enabled === false ? {} : { answersEnabled: true }),
  });
  const cookies = new Map<string, { cookie: string; "x-rovara-csrf": string }>();
  const as = async (token: string) => {
    const known = cookies.get(token);
    if (known !== undefined) return known;
    const person = PEOPLE[token] ?? { id: "f".repeat(64), grants: {} };
    // The stored sign-in names company A as owner for everyone: Cloud must use Code's live answer, never this.
    const access = { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    const made = { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
    cookies.set(token, made);
    return made;
  };
  const send = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body), text: answered!.body };
  };
  const codeCalls = () => calls.filter((call) => call.path !== "/v1/dev/access");
  return { as, send, calls, codeCalls };
}
const ASK = "/v1/web/projects/payments/answers", SUGGEST = "/v1/web/projects/payments/code/suggest";
const ask = (extra: Record<string, unknown> = {}) => ({ requestId: "request-0001", question: "How long do refunds last?", ...extra });
const text = (extra: Record<string, unknown> = {}) => ({ requestId: "request-0001", text: "Fix the typo in the README", ...extra });
const err = (answer: { body: any }) => answer.body.error as { code: string; message: string };
const fixed = (key: keyof typeof ANSWERS_ANSWERS) => ({ status: ANSWERS_ANSWERS[key].status, error: (ANSWERS_ANSWERS[key].body as { error: unknown }).error });
const asFixed = (answer: { status: number; body: any }) => ({ status: answer.status, error: err(answer) });

describe("the fixed words and limits", () => {
  it("are the same in Cloud's server and in the app's contracts, and the contract mirrors Code's (J1 b40976f3e)", () => {
    expect({ ...ANSWERS_WORDS }).toEqual({ ...APP_WORDS });
    expect(ANSWER_WORDS.notSetUp).toBe("Answers are not set up here yet.");
    expect(ANSWER_WORDS.taskButton).toBe("Start a Quick task");
    expect(ANSWER_WORDS.projectNotFound).toBe("project not found");
    expect(ANSWER_WORDS.limitReached).toBe("This project has reached its spending limit for now.");
    expect(ANSWER_WORDS.rate).toBe("You've asked a lot of questions lately. Try again a little later.");
    expect(START_SUGGEST_WORDS.rate).toBe("You've asked for a lot of suggestions lately. Try again a little later.");
    expect(ANSWER_SOURCES_MAX).toBe(8);
    expect(Object.keys(START_SMALL_TALK_WORDS)).toEqual(["greeting", "thanks", "help", "ack"]);
  });
});

describe("off unless the deployment says so (DEC 254z-amend2)", () => {
  it("both routes say 'not available on this Rovara yet' and never ask Code; the nav says no Ask box", async () => {
    const w = setUp({ enabled: false });
    for (const [path, body] of [[ASK, ask()], [SUGGEST, text()]] as const) {
      const res = await w.send("POST", path, await w.as("pam-token"), body);
      expect(asFixed(res)).toEqual(fixed("notYet"));
    }
    expect(w.calls).toEqual([]);
  });

  it("the nav reports the setting: on when set, off when not", async () => {
    for (const enabled of [true, false]) {
      const w = setUp({ enabled });
      const res = await w.send("GET", "/v1/web/nav", await w.as("pam-token"));
      expect(res.body.features.answers).toBe(enabled);
    }
  });
});

describe("asking", () => {
  it("a person with a role asks: Code gets their own token, the project only in its path, and a body Cloud rebuilt with channel 'web'", async () => {
    const w = setUp();
    const res = await w.send("POST", ASK, { ...await w.as("pam-token"), "x-rovara-company": B }, ask({ threadId: "t-1234", context: "Task: Fix refunds" }));
    expect(res.status).toBe(200);
    expect(AnswerResponseSchema.parse(res.body)).toMatchObject({ outcome: "answered", sources: [{ n: 1, repo: "web" }], action: { label: "Start a Quick task" } });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/answers", search: "", authorization: "Bearer pam-token",
      body: { requestId: "request-0001", question: "How long do refunds last?", channel: "web", threadId: "t-1234", context: "Task: Fix refunds" } })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("a company owner asks about every project of their company", async () => {
    const w = setUp();
    expect((await w.send("POST", "/v1/web/projects/billing/answers", await w.as("ada-token"), ask())).status).toBe(200);
  });

  it("two projects of one company: a person with a role on payments only is refused billing in fixed words that name nothing", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/billing/answers", await w.as("pam-token"), ask());
    expect(asFixed(res)).toEqual(fixed("notFound"));
    expect(res.text).not.toContain(LEAK);
    expect(res.text).not.toContain("billing");
  });

  it("two companies: another company's project is refused for an owner and a member; a person in no company never reaches Code's answers", async () => {
    const w = setUp();
    for (const token of ["ada-token", "pam-token"]) {
      const res = await w.send("POST", "/v1/web/projects/ledger/answers", await w.as(token), ask());
      expect(asFixed(res)).toEqual(fixed("notFound"));
      expect(res.text).not.toContain(LEAK);
    }
    expect(asFixed(await w.send("POST", ASK, await w.as("bob-token"), ask()))).toEqual(fixed("notFound"));
    const before = w.codeCalls().length;
    const none = await w.send("POST", ASK, await w.as("nob-token"), ask());
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(w.codeCalls().length).toBe(before);
  });

  it("a malformed project name is refused without asking Code", async () => {
    const w = setUp();
    for (const name of ["Payments", "pay..ments", "-x", "a".repeat(80)]) expect(asFixed(await w.send("POST", `/v1/web/projects/${name}/answers`, await w.as("pam-token"), ask()))).toEqual(fixed("notFound"));
    expect(w.codeCalls()).toEqual([]);
  });

  it("the browser cannot name a company, a person or a channel, and a bad body never reaches Code", async () => {
    const w = setUp();
    const headers = await w.as("pam-token");
    for (const body of [ask({ channel: "slack" }), ask({ company: B }), ask({ personId: ADA }), ask({ requestId: "short" }), ask({ question: "" }), ask({ question: "x".repeat(1_001) }), ask({ question: "a\u0000b" }),
      ask({ threadId: "bad thread" }), ask({ context: "a‮b" }), ask({ context: "x".repeat(301) }), "[]", "null", { question: "no request id" }]) {
      expect(asFixed(await w.send("POST", ASK, headers, body))).toEqual(fixed("invalid"));
    }
    expect(asFixed(await w.send("POST", ASK + "?x=1", headers, ask()))).toEqual(fixed("invalid"));
    // A body that is not JSON at all is the handler's own 400 before any route runs.
    expect((await w.send("POST", ASK, headers, "not json")).status).toBe(400);
    expect(w.codeCalls()).toEqual([]);
  });

  it("'not set up' is a real answer: 200, the fixed words, no action", async () => {
    const w = setUp({ override: (call) => (/\/answers$/u.test(call.path) ? json(200, NOT_SET_UP) : undefined) });
    const res = await w.send("POST", ASK, await w.as("pam-token"), ask());
    expect(res.status).toBe(200);
    expect(AnswerResponseSchema.parse(res.body)).toMatchObject({ outcome: "not_set_up", honesty: ANSWER_WORDS.notSetUp, text: "", sources: [] });
    expect(res.body.action).toBeUndefined();
  });
});

describe("an answer that does not read is refused whole", () => {
  const bad = (name: string, answer: Record<string, unknown>) => it(name, async () => {
    const w = setUp({ override: (call) => (/\/answers$/u.test(call.path) ? json(200, answer) : undefined) });
    const res = await w.send("POST", ASK, await w.as("pam-token"), ask());
    expect(asFixed(res)).toEqual(fixed("unavailable"));
    expect(res.text).not.toContain("CANARY");
  });
  bad("an extra field", goodAnswer({ cost: 12, CANARY: 1 }));
  bad("a marker that names no source", goodAnswer({ text: "Refunds last 30 days. [2] CANARY" }));
  bad("sources not numbered 1..n", goodAnswer({ sources: [{ n: 2, repo: "web", path: "src/refund.ts", line: 3, commit: SHA }] }));
  bad("a source at a commit that is not one", goodAnswer({ sources: [{ n: 1, repo: "web", path: "src/refund.ts", line: 3, commit: "main" }] }));
  bad("a source path that climbs out", goodAnswer({ sources: [{ n: 1, repo: "web", path: "../etc/passwd", line: 3, commit: SHA }] }));
  bad("a button whose words are the model's", goodAnswer({ action: { kind: "quick_task", label: "Delete everything CANARY", title: "x" } }));
  bad("an action on 'not set up'", { ...NOT_SET_UP, action: { kind: "quick_task", label: "Start a Quick task", title: "x" } });
  bad("text on 'not found'", goodAnswer({ outcome: "not_found" }));
  bad("an unknown outcome", goodAnswer({ outcome: "certain" }));
  bad("control characters in the text", goodAnswer({ text: "a\u0000b [1]" }));
  bad("an answer id that is not one", goodAnswer({ answerId: "a b" }));
  bad("too many sources", goodAnswer({ sources: Array.from({ length: 9 }, (_, i) => ({ n: i + 1, repo: "web", path: "src/a.ts", line: 1, commit: SHA })), text: "x" }));
  it("rebuilds only known fields and keeps the fixed action", () => {
    const rebuilt = answerObject(goodAnswer()) as any;
    expect(Object.keys(rebuilt).sort()).toEqual(["action", "answerId", "outcome", "sources", "text", "threadId", "unconfirmed", "wikiPages"]);
    expect(rebuilt.action).toEqual({ kind: "quick_task", label: "Start a Quick task", title: "Change the refund window" });
  });
});

describe("refusals are Cloud's fixed words", () => {
  const refuse = (status: number, message: string, code = "X") => (call: CodeCall) => (/\/(answers|suggest)$/u.test(call.path) ? json(status, { error: { code, message } }) : undefined);
  it.each([
    [404, "route not found", "NOT_FOUND", "notYet"], [404, "That is not on the core engine on this install yet.", "NOT_FOUND", "notYet"], [404, `project not found ${LEAK}`, "NOT_FOUND", "notFound"], [403, `no ${LEAK}`, "FORBIDDEN", "forbidden"], [400, `bad ${LEAK}`, "CONFIG_INVALID", "invalid"],
    [429, ANSWER_WORDS.limitReached, "TOO_MANY_REQUESTS", "limitReached"], [429, `slow ${LEAK}`, "TOO_MANY_REQUESTS", "rate"], [500, `boom ${LEAK}`, "X", "unavailable"], [503, `down ${LEAK}`, "RUNTIME_UNAVAILABLE", "unavailable"],
  ] as const)("Code %i %s becomes the fixed '%s'", async (status, message, code, key) => {
    const w = setUp({ override: refuse(status, message, code) });
    const res = await w.send("POST", ASK, await w.as("pam-token"), ask(), );
    expect(asFixed(res)).toEqual(fixed(key));
    expect(res.text).not.toContain(LEAK);
    expect(res.text).not.toContain("request-0001");
    expect(res.text).not.toContain("refunds");
  });
});

describe("the start box's suggestion", () => {
  it("a person with a role gets the suggestion; Code gets the person's token and only requestId and text", async () => {
    const w = setUp();
    const res = await w.send("POST", SUGGEST, await w.as("pam-token"), text());
    expect(res.status).toBe(200);
    expect(StartSuggestResponseSchema.parse(res.body)).toEqual({ kind: "small_change", classifier: "ok", pick: "quick" });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/code/suggest", authorization: "Bearer pam-token", body: { requestId: "request-0001", text: "Fix the typo in the README" } })]);
  });

  it("no role, another project or company, and a bad body are refused in fixed words", async () => {
    const w = setUp();
    expect(asFixed(await w.send("POST", "/v1/web/projects/billing/code/suggest", await w.as("pam-token"), text()))).toEqual(fixed("notFound"));
    expect(asFixed(await w.send("POST", "/v1/web/projects/ledger/code/suggest", await w.as("ada-token"), text()))).toEqual(fixed("notFound"));
    const before = w.codeCalls().length;
    const headers = await w.as("pam-token");
    for (const body of [text({ extra: 1 }), text({ requestId: "x" }), text({ text: "" }), text({ text: "x".repeat(4_001) }), text({ text: "a\u0000b" })]) expect(asFixed(await w.send("POST", SUGGEST, headers, body))).toEqual(fixed("invalid"));
    expect(w.codeCalls().length).toBe(before + 0);
  });

  it("the 429 and 5xx of the suggestion are its own fixed words", async () => {
    for (const [status, key] of [[429, "suggestRate"], [503, "suggestUnavailable"]] as const) {
      const w = setUp({ override: (call) => (/suggest$/u.test(call.path) ? json(status, { error: { code: "X", message: LEAK } }) : undefined) });
      const res = await w.send("POST", SUGGEST, await w.as("pam-token"), text());
      expect(asFixed(res)).toEqual(fixed(key));
      expect(res.text).not.toContain(LEAK);
    }
  });

  it.each([
    [{ kind: "small_talk", classifier: "ok", pick: "answer", smallTalk: "greeting" }, true], [{ kind: "question", classifier: "ok", pick: "answer" }, true], [{ kind: "unclear", classifier: "ok", pick: "answer" }, true],
    [{ kind: "large_change", classifier: "ok", pick: "full" }, true], [{ kind: "unknown", classifier: "unavailable", pick: "answer" }, true], [{ kind: "unknown", classifier: "failed", pick: "answer" }, true],
    [{ kind: "small_talk", classifier: "ok", pick: "answer" }, false], [{ kind: "question", classifier: "ok", pick: "full" }, false], [{ kind: "large_change", classifier: "ok", pick: "quick" }, false],
    [{ kind: "unknown", classifier: "ok", pick: "answer" }, false], [{ kind: "unknown", classifier: "failed", pick: "quick" }, false], [{ kind: "question", classifier: "ok", pick: "answer", smallTalk: "help" }, false],
    [{ kind: "question", classifier: "failed", pick: "answer" }, false], [{ kind: "small_change", classifier: "ok", pick: "quick", reason: "CANARY" }, false], [{ kind: "deploy", classifier: "ok", pick: "quick" }, false],
  ] as const)("a suggestion %j reads: %s", (value, reads) => {
    if (reads) expect(suggestObject(value)).toMatchObject({ kind: value.kind, pick: value.pick });
    else expect(() => suggestObject(value)).toThrow();
  });
});

describe("starting from the start box names its path", () => {
  const start = async (body: Record<string, unknown>) => {
    const tasks: unknown[] = [];
    const w = setUp({ override: (call) => {
      if (call.method === "POST" && call.path === "/v1/dev/tasks") { tasks.push(call.body); return json(201, { task: { taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "t", status: "queued", workflow: null } }); }
      return undefined;
    } });
    const res = await w.send("POST", "/v1/web/projects/payments/code", await w.as("pam-token"), { requestId: "11111111-1111-4111-8111-111111111111", input: { text: "Fix it" }, ...body });
    return { res, tasks };
  };
  it("no path is Quick (as always), 'quick' is Quick, 'full' is Full, anything else is refused before Code", async () => {
    expect(((await start({})).tasks[0] as any)?.workflowPath).toBe("QUICK");
    expect(((await start({ path: "quick" })).tasks[0] as any)?.workflowPath).toBe("QUICK");
    expect(((await start({ path: "full" })).tasks[0] as any)?.workflowPath).toBe("FULL");
    for (const path of ["FULL", "deploy", 1, null, ""]) {
      const bad = await start({ path });
      expect(bad.res.status).toBe(400);
      expect(bad.tasks).toEqual([]);
    }
  });
});
