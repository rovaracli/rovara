// Web task channel K5: Cloud's inbox routes (`GET /v1/app/inbox`, `POST /v1/app/inbox/read`), answered from Rovara Code's in-app inbox (C7) as the signed-in
// person. A fake Code stands in for C7 (the shapes in core-host/inbox-routes.ts on Code's pr/wtc-inbox): the company and the person come from the sign-in
// alone, bodies and queries are checked at runtime, Code's refusals pass through, a Code with no inbox answers one fixed sentence, and every write needs
// the CSRF header like every other write.
import { beforeEach, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { codeSessionIdOf, forgetPlacedRows } from "../../packages/cloud-server/src/inbox-routes.js";
import { InboxPageSchema, InboxReadResponseSchema, INBOX_NOT_AVAILABLE_TEXT, ProjectNoticesSchema } from "../../packages/contracts/src/app-inbox.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), CAL = "c".repeat(64), BEA = "b".repeat(64);
const TASK_A = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", TASK_B = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466", TASK_C = "8b9d0c1e-2b3a-4c5d-8e7f-001122334477";
const REQ = "33333333-3333-4333-8333-333333333333";
const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa", COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SES_A = "ses_aaaaaaaaaaaaaaaaaaaa", SES_B = "ses_bbbbbbbbbbbbbbbbbbbb", SES_B_STALE = "ses_cccccccccccccccccccc";
const AT = 1_763_380_800_000;

interface Who { developerId: string; name: string; company: "A" | "B"; token: string }
const WHO: Record<string, Who> = {
  "ada-code": { developerId: ADA, name: "Ada", company: "A", token: "ada-access" },
  "cal-code": { developerId: CAL, name: "Cal", company: "A", token: "cal-access" },
  "bea-code": { developerId: BEA, name: "Bea", company: "B", token: "bea-access" },
};
/** The tasks of the fake Code: which company each belongs to. */
const TASKS: Record<string, "A" | "B"> = { [TASK_A]: "A", [TASK_B]: "B", [TASK_C]: "A" };
interface Call { method: string; path: string; token: string; body?: string }
type Mode = "ok" | "404" | "501" | "403" | "garbage-page" | "garbage-row" | "bad-cursor" | "bad-unread" | "huge-unread" | "long-title" | "foreign-id" | "huge-page";

beforeEach(() => { forgetPlacedRows(); });

const row = (taskId: string, kind: string, extra: Record<string, unknown> = {}) => {
  const sessionId = codeSessionIdOf(taskId);
  return { id: `${sessionId}.${kind}.${String(AT)}`, sessionId, kind, title: `Task ${taskId.slice(0, 4)}`, status: "Needs you now.", link: "https://evil.example.test/steal", at: new Date(AT).toISOString(), read: false, ...extra };
};

/** A fake Code with two companies. Each person has their own rows; Code never shows a row of another person. */
function fakeCode() {
  const calls: Call[] = [];
  const rows: Record<string, unknown[]> = {
    [ADA]: [row(TASK_A, "needs_you"), row(TASK_C, "ready", { read: true })],
    [CAL]: [row(TASK_C, "needs_you")],
    [BEA]: [row(TASK_B, "failed")],
  };
  // L4-U5b: the project notices Code keeps in each person's own inbox (an admin told by neither chat nor email). Code shows a person only their own.
  const notices: Record<string, unknown[]> = {
    [ADA]: [{ id: `setup_broken.${String(AT)}.payments`, kind: "setup_broken", project: "payments", status: "Setup needs repair. The project's setup stopped working after recent code changes (setup: npm ci - exit 1). Fix setup on the setup page.", at: new Date(AT).toISOString(), link: "https://evil.example.test/steal" },
      { id: `upkeep_paused.${String(AT - 1000)}.payments`, kind: "upkeep_paused", project: "payments", status: "Nightly upkeep is paused: this month's upkeep limit is used up.", at: new Date(AT - 1000).toISOString() }],
    [BEA]: [{ id: `setup_broken.${String(AT)}.billing`, kind: "setup_broken", project: "billing", status: "Setup needs repair.", at: new Date(AT).toISOString() }],
  };
  const flags = { notice: "ok" as "ok" | "404" | "501" | "403" | "garbage" | "bad-item" | "foreign-id" | "bad-kind" | "new-kind" | "long-status" | "huge" | "bad-project", mode: "ok" as Mode, sessionRead: "ok" as "ok" | "404" | "wrong-task" | "garbage" | "not-task" | "403" | "429" | "503", marked: 1 as unknown };
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
    calls.push({ method, path: url.pathname + url.search, token: me.token, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const session = /^\/v1\/app\/sessions\/(ses_[0-9a-z]{20})$/u.exec(url.pathname);
    if (session !== null && method === "GET") {
      const taskId = Object.keys(TASKS).find((id) => codeSessionIdOf(id) === session[1]);
      // Code shows a session only to a person of the task's company.
      if (flags.sessionRead === "404" || taskId === undefined || TASKS[taskId] !== me.company) return refuse(404, "NOT_FOUND", "There is no such session.");
      if (flags.sessionRead === "403" || flags.sessionRead === "429" || flags.sessionRead === "503") return refuse(Number(flags.sessionRead), "REFUSED", "no");
      if (flags.sessionRead === "not-task") return respond(200, { session: { sessionId: session[1], body: { kind: "chain", task: { taskId } } } });
      if (flags.sessionRead === "garbage") return respond(200, { session: { sessionId: session[1], body: { kind: "task", task: { taskId: "not-a-uuid" } } } });
      return respond(200, { session: { sessionId: session[1], body: { kind: "task", task: { taskId: flags.sessionRead === "wrong-task" ? TASK_B : taskId } } } });
    }
    if (url.pathname === "/v1/app/inbox/project-notices") {
      if (flags.notice === "404") return refuse(404, "NOT_FOUND", "route not found");
      if (flags.notice === "501") return refuse(501, "NOT_ON_CORE_ENGINE", "Not here");
      if (flags.notice === "403") return refuse(403, "FORBIDDEN", "Your access ended.");
      const own = notices[me.developerId] ?? [];
      const first = own[0] as Record<string, unknown> | undefined;
      if (flags.notice === "garbage") return respond(200, { items: "nope" });
      if (flags.notice === "bad-item") return respond(200, { items: [{ id: "x" }] });
      if (flags.notice === "foreign-id") return respond(200, { items: [{ ...first, id: `setup_broken.${String(AT)}.other` }] });
      if (flags.notice === "bad-kind") return respond(200, { items: [{ ...first, kind: "Not A Kind!" }] });
      if (flags.notice === "new-kind") return respond(200, { items: [{ ...first, kind: "billing_paused", id: `billing_paused.${String(AT)}.payments` }] });
      if (flags.notice === "long-status") return respond(200, { items: [{ ...first, status: "s".repeat(501) }] });
      if (flags.notice === "bad-project") return respond(200, { items: [{ ...first, project: "../x", id: `setup_broken.${String(AT)}.../x` }] });
      if (flags.notice === "huge") return respond(200, { items: Array.from({ length: 51 }, () => first) });
      return respond(200, { items: own });
    }
    if (url.pathname === "/v1/app/inbox" || url.pathname === "/v1/app/inbox/read") {
      if (flags.mode === "404") return refuse(404, "NOT_FOUND", "That is not on the core engine on this install yet.");
      if (flags.mode === "501") return refuse(501, "NOT_ON_CORE_ENGINE", "Not here");
      if (flags.mode === "403") return refuse(403, "FORBIDDEN", "Your access to the inbox ended.");
      if (url.pathname === "/v1/app/inbox/read") return respond(200, { marked: flags.marked });
      const own = rows[me.developerId] ?? [];
      if (flags.mode === "garbage-page") return respond(200, { items: "nope" });
      if (flags.mode === "garbage-row") return respond(200, { items: [{ id: "x" }] });
      if (flags.mode === "long-title") return respond(200, { items: [row(TASK_A, "needs_you", { title: "t".repeat(201) })] });
      if (flags.mode === "foreign-id") return respond(200, { items: [row(TASK_A, "needs_you", { id: `ses_zzzzzzzzzzzzzzzzzzzz.needs_you.${String(AT)}` })] });
      if (flags.mode === "huge-page") return respond(200, { items: Array.from({ length: 51 }, () => row(TASK_A, "needs_you")) });
      const limit = Number(url.searchParams.get("limit") ?? "20");
      return respond(200, {
        items: own.slice(0, limit),
        ...(flags.mode === "bad-cursor" ? { nextCursor: "has spaces!" } : own.length > limit ? { nextCursor: "c3VyZQ" } : {}),
        ...(flags.mode === "bad-unread" ? { unread: -1 } : flags.mode === "huge-unread" ? { unread: 1001 } : url.searchParams.get("cursor") === null ? { unread: own.filter((item) => (item as { read: boolean }).read === false).length } : {}),
      });
    }
    return refuse(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  return { fetchImpl, calls, flags, rows, inboxCalls: () => calls.filter((call) => call.path.startsWith("/v1/app/inbox") && !call.path.startsWith("/v1/app/inbox/project-notices")), noticeCalls: () => calls.filter((call) => call.path.startsWith("/v1/app/inbox/project-notices")), sessionCalls: () => calls.filter((call) => call.path.startsWith("/v1/app/sessions/")) };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "tasks:read", fetch: code.fetchImpl });
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date("2026-11-17T12:00:00.000Z") });
  const call = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown; rawBody?: string } = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = {
      method, path: url.pathname, query: url.searchParams,
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
    };
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
  const session = (sessionId: string, taskId: string, owner: { developerId: string; name: string }, companyId?: string) =>
    work.put({ sessionId, taskId, project: "payments", startedBy: owner, owner, createdAt: "2026-11-17T10:00:00.000Z", revision: 1, ...(companyId === undefined ? {} : { companyId }) });
  return { code, work, call, signIn, session };
}

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const base = async () => {
  const context = setUp();
  await context.session(SES_A, TASK_A, { developerId: ADA, name: "Ada" }, COMPANY_A);
  await context.session(SES_B, TASK_B, { developerId: BEA, name: "Bea" }, COMPANY_B);
  const ada = await context.signIn("ada-code");
  const cal = await context.signIn("cal-code");
  const bea = await context.signIn("bea-code");
  return { ...context, ada, cal, bea };
};
const readBody = (extra: Record<string, unknown> = {}) => ({ requestId: REQ, ids: [`${codeSessionIdOf(TASK_A)}.needs_you.${String(AT)}`], ...extra });
const UNREADABLE = { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent an inbox answer Cloud couldn't read." } };
const NOT_AVAILABLE = { error: { code: "NOT_ON_CODE_YET", message: INBOX_NOT_AVAILABLE_TEXT } };
const BAD = { error: { code: "CONFIG_INVALID", message: "That request isn't in the shape this page sends." } };

describe("Code's session id of a task", () => {
  it("is the id Code computes (golden: the same values Code's taskSessionId gives)", () => {
    expect(codeSessionIdOf(TASK_A)).toBe("ses_564811026ed1a8a5d4d4");
    expect(codeSessionIdOf(TASK_B)).toBe("ses_790c42d109472b78e059");
  });
});

describe("Inbox: reading", () => {
  it("answers the person's own rows from Code as the person, each with where it opens, and nothing Code sent beyond the fields the app draws", async () => {
    const { call, ada, code } = await base();
    const answer = await call("GET", "/v1/web/inbox", ada);
    expect(answer.status).toBe(200);
    const page = InboxPageSchema.parse(json(answer));
    expect(page.unread).toBe(1);
    // The task Ada started in Cloud opens on Cloud's own session; the task another person started opens by the task's id (K2).
    expect(page.items.map((item) => [item.kind, item.open, item.read])).toEqual([["needs_you", `/s/${SES_A}`, false], ["ready", `/t/${TASK_C}`, true]]);
    expect(answer.body).not.toContain("evil.example.test");
    expect(answer.body).not.toContain("link");
    expect(code.inboxCalls()).toEqual([{ method: "GET", path: "/v1/app/inbox?limit=20", token: "ada-access" }]);
    // Only the one row Cloud has no session for was read from Code, as Ada.
    expect(code.sessionCalls()).toEqual([{ method: "GET", path: `/v1/app/sessions/${codeSessionIdOf(TASK_C)}`, token: "ada-access" }]);
  });

  it("sends Code only the limit and the cursor: a person, company or any other member in the query never reaches Code", async () => {
    const { call, ada, code } = await base();
    const answer = await call("GET", `/v1/web/inbox?limit=5&cursor=abc_-9&developerId=${BEA}&companyId=${COMPANY_B}&orgId=${COMPANY_B}&personId=x&as=${BEA}`, ada);
    expect(answer.status).toBe(200);
    expect(code.inboxCalls()).toEqual([{ method: "GET", path: "/v1/app/inbox?limit=5&cursor=abc_-9", token: "ada-access" }]);
  });

  it("refuses a limit or a cursor that is not what the page sends, with fixed words and no call to Code", async () => {
    const { call, ada, code } = await base();
    for (const query of ["limit=0", "limit=51", "limit=abc", "limit=-1", "limit=1e1", "limit=1.5", "limit=100", "limit=", `cursor=${"a".repeat(201)}`, "cursor=has%20space", "cursor=a/b", "cursor=", "cursor=%3Cscript%3E"]) {
      const answer = await call("GET", `/v1/web/inbox?${query}`, ada);
      expect(answer.status, query).toBe(400);
      expect(json(answer), query).toEqual(BAD);
    }
    expect(code.inboxCalls()).toEqual([]);
  });

  it("shows each person only their own rows, never another person's or another company's", async () => {
    const { call, ada, cal, bea, code } = await base();
    const forBea = InboxPageSchema.parse(json(await call("GET", "/v1/web/inbox", bea)));
    expect(forBea.items.map((item) => item.open)).toEqual([`/s/${SES_B}`]);
    const forCal = InboxPageSchema.parse(json(await call("GET", "/v1/web/inbox", cal)));
    expect(forCal.items).toHaveLength(1);
    expect(forCal.items[0]!.open).toBe(`/t/${TASK_C}`);
    // Each call carried its own person's token and nobody else's.
    expect(code.inboxCalls().map((entry) => entry.token)).toEqual(["bea-access", "cal-access"]);
    expect(JSON.stringify(forBea)).not.toContain(codeSessionIdOf(TASK_A));
    void ada;
  });

  it("places a row only on a session of the person's own company: a session stamped with another company is not used", async () => {
    const context = setUp();
    // Only a stale record of Bea's task, stamped with company A: Bea is in company B, so it must not place her row.
    await context.session(SES_B_STALE, TASK_B, { developerId: BEA, name: "Bea" }, COMPANY_A);
    const bea = await context.signIn("bea-code");
    const page = InboxPageSchema.parse(json(await context.call("GET", "/v1/web/inbox", bea)));
    expect(page.items.map((item) => item.open)).toEqual([`/t/${TASK_B}`]);
    // The stale record placed nothing, so the row's session was read from Code.
    expect(context.code.sessionCalls()).toHaveLength(1);
  });

  it("opens a row by its task's id, read from Code's session of the task, when Cloud has no session for it", async () => {
    const { call, cal, code } = await base();
    const page = InboxPageSchema.parse(json(await call("GET", "/v1/web/inbox", cal)));
    expect(page.items[0]!.open).toBe(`/t/${TASK_C}`);
    expect(code.sessionCalls()).toEqual([{ method: "GET", path: `/v1/app/sessions/${codeSessionIdOf(TASK_C)}`, token: "cal-access" }]);
  });

  it("leaves a row out when Code will not show its session, or answers a task that is not that session's, keeping the rest", async () => {
    for (const mode of ["404", "wrong-task", "garbage", "not-task", "403", "429", "503"] as const) {
      const { call, ada, code } = await base();
      code.flags.sessionRead = mode;
      const page = InboxPageSchema.parse(json(await call("GET", "/v1/web/inbox", ada)));
      // The placed row (Ada's own session) stays; the one Cloud cannot place is left out.
      expect(page.items.map((item) => item.open), mode).toEqual([`/s/${SES_A}`]);
    }
  });

  it("refuses a row whose own fields are not what Code sends, each field on its own", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["kind with capitals", { kind: "Needs_You" }], ["kind too long", { kind: "a".repeat(21) }], ["kind not text", { kind: 3 }], ["session id", { sessionId: "ses_short" }],
      ["empty title", { title: "" }], ["title not text", { title: 5 }], ["status too long", { status: "s".repeat(301) }], ["status not text", { status: null }],
      ["read not a flag", { read: "no" }], ["time not a time", { at: "yesterday" }], ["time missing", { at: undefined }],
    ];
    for (const [name, patch] of bad) {
      const { call, ada, code } = await base();
      code.rows[ADA] = [row(TASK_A, "needs_you", patch)];
      const answer = await call("GET", "/v1/web/inbox", ada);
      expect(answer.status, name).toBe(502);
      expect(json(answer), name).toEqual(UNREADABLE);
    }
  });

  it("passes on a kind a newer Code adds, so one new kind never fails the page (the app reads it as a plain update)", async () => {
    const { call, ada, code } = await base();
    code.rows[ADA] = [row(TASK_A, "mentioned")];
    const answer = await call("GET", "/v1/web/inbox", ada);
    expect(answer.status).toBe(200);
    expect((json(answer)["items"] as Array<{ kind: string }>)[0]!.kind).toBe("mentioned");
  });

  it("does not read Code's session again on the next poll for a row it has placed", async () => {
    const { call, cal, code } = await base();
    await call("GET", "/v1/web/inbox", cal);
    await call("GET", "/v1/web/inbox", cal);
    expect(code.sessionCalls()).toHaveLength(1);
  });

  it("does not use one person's placed rows for another person", async () => {
    const { call, ada, cal, code } = await base();
    await call("GET", "/v1/web/inbox", cal);
    await call("GET", "/v1/web/inbox", ada);
    // Cal's placement of TASK_C is not Ada's: Ada's own read is made.
    expect(code.sessionCalls().map((entry) => entry.token)).toEqual(["cal-access", "ada-access"]);
  });

  it("still places rows by their task's id when Cloud's own sessions cannot be read", async () => {
    const { call, ada, work } = await base();
    work.startedBy = () => Promise.reject(new Error("store down"));
    const page = InboxPageSchema.parse(json(await call("GET", "/v1/web/inbox", ada)));
    expect(page.items.map((item) => item.open)).toEqual([`/t/${TASK_A}`, `/t/${TASK_C}`]);
  });

  it("carries Code's cursor and unread count and nothing else", async () => {
    const { call, ada } = await base();
    const first = json(await call("GET", "/v1/web/inbox?limit=1", ada));
    expect(first["nextCursor"]).toBe("c3VyZQ");
    expect(first["unread"]).toBe(1);
    const later = json(await call("GET", "/v1/web/inbox?limit=1&cursor=c3VyZQ", ada));
    expect(later).not.toHaveProperty("unread");
  });

  it("says the inbox is not available when Code answers 404 or 501, in one fixed sentence that names no cause", async () => {
    for (const mode of ["404", "501"] as const) {
      const { call, ada, code } = await base();
      code.flags.mode = mode;
      const answer = await call("GET", "/v1/web/inbox", ada);
      expect(answer.status, mode).toBe(501);
      expect(json(answer), mode).toEqual(NOT_AVAILABLE);
      expect(answer.body).not.toContain("core engine");
      expect(answer.body).not.toContain("Not here");
    }
  });

  it("passes any other refusal of Code on as Code worded it", async () => {
    const { call, ada, code } = await base();
    code.flags.mode = "403";
    const answer = await call("GET", "/v1/web/inbox", ada);
    expect(answer.status).toBe(403);
    expect(json(answer)).toEqual({ error: { code: "FORBIDDEN", message: "Your access to the inbox ended." } });
  });

  it("refuses an answer Code sends in a shape it does not know, with fixed words and no echo", async () => {
    for (const mode of ["garbage-page", "garbage-row", "bad-cursor", "bad-unread", "huge-unread", "long-title", "foreign-id", "huge-page"] as const) {
      const { call, ada, code } = await base();
      code.flags.mode = mode;
      const answer = await call("GET", "/v1/web/inbox", ada);
      expect(answer.status, mode).toBe(502);
      expect(json(answer), mode).toEqual(UNREADABLE);
    }
  });

  it("answers a person who is not signed in with the sign-in refusal and asks Code nothing", async () => {
    const { call, code } = await base();
    expect((await call("GET", "/v1/web/inbox", {})).status).toBe(401);
    expect((await call("POST", "/v1/web/inbox/read", { body: readBody() })).status).toBe(401);
    expect(code.inboxCalls()).toEqual([]);
  });
});

describe("Inbox: marking rows read", () => {
  it("sends Code exactly the request id and the ids, as the person, and answers how many Code marked", async () => {
    const { call, ada, code } = await base();
    const answer = await call("POST", "/v1/web/inbox/read", { ...ada, body: readBody() });
    expect(answer.status).toBe(200);
    expect(InboxReadResponseSchema.parse(json(answer))).toEqual({ marked: 1 });
    expect(code.inboxCalls()).toEqual([{ method: "POST", path: "/v1/app/inbox/read", token: "ada-access", body: JSON.stringify(readBody()) }]);
  });

  it("refuses a body with any member beyond requestId and ids (a person or company is never taken from the browser), asking Code nothing", async () => {
    const { call, ada, code } = await base();
    for (const extra of [{ developerId: BEA }, { companyId: COMPANY_B }, { orgId: COMPANY_B }, { personId: BEA }, { requestId2: REQ }]) {
      const answer = await call("POST", "/v1/web/inbox/read", { ...ada, body: readBody(extra) });
      expect(answer.status, JSON.stringify(extra)).toBe(400);
      expect(json(answer)).toEqual(BAD);
    }
    expect(code.inboxCalls()).toEqual([]);
  });

  it("refuses a body that is not the shape the page sends, asking Code nothing", async () => {
    const { call, ada, code } = await base();
    const good = `${codeSessionIdOf(TASK_A)}.needs_you.${String(AT)}`;
    const bodies: unknown[] = [
      { requestId: "not-a-uuid", ids: [good] }, { requestId: REQ }, { ids: [good] }, { requestId: REQ, ids: [] }, { requestId: REQ, ids: good },
      { requestId: REQ, ids: Array.from({ length: 51 }, () => good) }, { requestId: REQ, ids: [42] }, { requestId: REQ, ids: ["../etc/passwd"] },
      { requestId: REQ, ids: ["SES_AAAA.needs_you.1"] }, { requestId: REQ, ids: [`${good}x`] }, { requestId: REQ, ids: [`${"a".repeat(65)}.needs_you.1`] },
      { requestId: REQ, ids: [{ id: good }] }, [], "text", 7, null,
    ];
    for (const body of bodies) {
      const answer = await call("POST", "/v1/web/inbox/read", { ...ada, body });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(json(answer)).toEqual(BAD);
    }
    expect((await call("POST", "/v1/web/inbox/read", { ...ada, rawBody: "{not json" })).status).toBe(400);
    expect(code.inboxCalls()).toEqual([]);
  });

  it("accepts exactly 50 ids and refuses 51", async () => {
    const { call, ada, code } = await base();
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `${codeSessionIdOf(TASK_A)}.needs_you.${String(AT + index)}`);
    code.flags.marked = 50;
    expect((await call("POST", "/v1/web/inbox/read", { ...ada, body: { requestId: REQ, ids: ids(50) } })).status).toBe(200);
    expect((await call("POST", "/v1/web/inbox/read", { ...ada, body: { requestId: REQ, ids: ids(51) } })).status).toBe(400);
  });

  it("refuses every write without the CSRF header or with a wrong one, asking Code nothing", async () => {
    const { call, ada, code } = await base();
    const missing = await call("POST", "/v1/web/inbox/read", { cookie: ada.cookie, body: readBody() });
    expect(missing.status).toBe(403);
    expect(json(missing)).toEqual({ error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } });
    const wrong = await call("POST", "/v1/web/inbox/read", { cookie: ada.cookie, csrf: `${ada.csrf}x`, body: readBody() });
    expect(wrong.status).toBe(403);
    const other = await call("POST", "/v1/web/inbox/read", { cookie: ada.cookie, csrf: (await setUp().signIn("ada-code")).csrf, body: readBody() });
    expect(other.status).toBe(403);
    expect(code.inboxCalls()).toEqual([]);
  });

  it("says the inbox is not available when Code answers 404 or 501, and passes any other refusal of Code on", async () => {
    for (const mode of ["404", "501"] as const) {
      const { call, ada, code } = await base();
      code.flags.mode = mode;
      const answer = await call("POST", "/v1/web/inbox/read", { ...ada, body: readBody() });
      expect(answer.status, mode).toBe(501);
      expect(json(answer)).toEqual(NOT_AVAILABLE);
    }
    const { call, ada, code } = await base();
    code.flags.mode = "403";
    const refused = await call("POST", "/v1/web/inbox/read", { ...ada, body: readBody() });
    expect(refused.status).toBe(403);
    expect(json(refused)).toEqual({ error: { code: "FORBIDDEN", message: "Your access to the inbox ended." } });
  });

  it("refuses a count Code answers that is not a count, with fixed words", async () => {
    for (const marked of ["many", -1, 1.5, 51, undefined]) {
      const { call, ada, code } = await base();
      code.flags.marked = marked;
      const answer = await call("POST", "/v1/web/inbox/read", { ...ada, body: readBody() });
      expect(answer.status, String(marked)).toBe(502);
      expect(json(answer)).toEqual(UNREADABLE);
    }
  });
});

describe("Inbox: project notices (L4-U5b)", () => {
  it("answers the person's own notices from Code as the person, newest first, with only the named fields (Code's link is never passed on)", async () => {
    const { call, ada, code } = await base();
    const answer = await call("GET", "/v1/web/inbox/project-notices", ada);
    expect(answer.status).toBe(200);
    const page = ProjectNoticesSchema.parse(json(answer));
    expect(page.items.map((item) => [item.kind, item.project])).toEqual([["setup_broken", "payments"], ["upkeep_paused", "payments"]]);
    expect(answer.body).not.toContain("evil.example.test");
    expect(answer.body).not.toContain("link");
    expect(code.noticeCalls()).toEqual([{ method: "GET", path: "/v1/app/inbox/project-notices", token: "ada-access" }]);
    expect(code.inboxCalls()).toEqual([]);
  });

  it("two companies: each person sees only what Code keeps for them (Bea reads her own company's, Ada never reads it, and Cal, who was told nothing, reads an empty list)", async () => {
    const { call, ada, bea, cal } = await base();
    expect((ProjectNoticesSchema.parse(json(await call("GET", "/v1/web/inbox/project-notices", bea))).items).map((item) => item.project)).toEqual(["billing"]);
    expect(ProjectNoticesSchema.parse(json(await call("GET", "/v1/web/inbox/project-notices", ada))).items.every((item) => item.project === "payments")).toBe(true);
    expect(json(await call("GET", "/v1/web/inbox/project-notices", cal))).toEqual({ items: [] });
  });

  it("sends Code nothing from the browser: no query is accepted and none reaches Code", async () => {
    const { call, ada, code } = await base();
    for (const query of ["developerId=" + BEA, "companyId=" + COMPANY_B, "project=billing", "limit=5"]) {
      const answer = await call("GET", `/v1/web/inbox/project-notices?${query}`, ada);
      expect(answer.status, query).toBe(400);
      expect(json(answer), query).toEqual(BAD);
    }
    expect(code.noticeCalls()).toEqual([]);
  });

  it("a Code with no such route or no inbox reads as nothing to show (never an error on the inbox page)", async () => {
    for (const mode of ["404", "501"] as const) {
      const { call, ada, code } = await base();
      code.flags.notice = mode;
      const answer = await call("GET", "/v1/web/inbox/project-notices", ada);
      expect(answer.status, mode).toBe(200);
      expect(json(answer), mode).toEqual({ items: [] });
    }
  });

  it("passes any other refusal on as Code worded it", async () => {
    const { call, ada, code } = await base();
    code.flags.notice = "403";
    const answer = await call("GET", "/v1/web/inbox/project-notices", ada);
    expect(answer.status).toBe(403);
    expect(json(answer)).toMatchObject({ error: { code: "FORBIDDEN", message: "Your access ended." } });
  });

  it.each(["garbage", "bad-item", "foreign-id", "bad-kind", "long-status", "huge", "bad-project"] as const)("an answer that is not the shape Cloud expects (%s) is one fixed sentence, never a partial list", async (mode) => {
    const { call, ada, code } = await base();
    code.flags.notice = mode;
    const answer = await call("GET", "/v1/web/inbox/project-notices", ada);
    expect(answer.status).toBe(502);
    expect(json(answer)).toEqual(UNREADABLE);
  });

  it("a kind a newer Code adds is passed on (the app reads it as a plain update), so one new kind never hides the list", async () => {
    const { call, ada, code } = await base();
    code.flags.notice = "new-kind";
    const answer = await call("GET", "/v1/web/inbox/project-notices", ada);
    expect(answer.status).toBe(200);
    expect((json(answer).items as Array<{ kind: string }>).map((item) => item.kind)).toEqual(["billing_paused"]);
  });

  it("needs a sign-in, and a write method is not served here", async () => {
    const { call, ada } = await base();
    expect((await call("GET", "/v1/web/inbox/project-notices")).status).toBe(401);
    const post = await call("POST", "/v1/web/inbox/project-notices", { ...ada, body: {} });
    expect(post.status).not.toBe(200);
  });
});
