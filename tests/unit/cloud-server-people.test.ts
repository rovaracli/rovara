// Web task channel K3: Cloud's People routes on a session (`/v1/app/sessions/{ses}/people...`), answered from Rovara Code's task People routes as the
// signed-in person. A fake Code stands in for C3/C4 (planned contracts): the task id comes from Cloud's own session record, bodies are checked at
// runtime, Code's refusals pass through unchanged, and every write needs the CSRF header like every other write.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { SessionPeopleChangeResponseSchema, SessionPeopleCandidatesResponseSchema, SessionPeopleResponseSchema } from "../../packages/contracts/src/app-session-people.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), CAL = "c".repeat(64), BEA = "b".repeat(64), DAN = "d".repeat(64);
const TASK_A = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", TASK_B = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466";
const PERSON_CAL = "11111111-1111-4111-8111-111111111111", PERSON_ADA = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa", COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SES_A = "ses_aaaaaaaaaaaaaaaaaaaa", SES_B = "ses_bbbbbbbbbbbbbbbbbbbb", SES_NONE = "ses_zzzzzzzzzzzzzzzzzzzz";

interface Who { developerId: string; name: string; company: string; token: string }
const WHO: Record<string, Who> = {
  "ada-code": { developerId: ADA, name: "Ada", company: "A", token: "ada-access" },
  "cal-code": { developerId: CAL, name: "Cal", company: "A", token: "cal-access" },
  "bea-code": { developerId: BEA, name: "Bea", company: "B", token: "bea-access" },
};
interface Call { method: string; path: string; token: string; body?: string }

/** A fake Code with two companies. Ada owns TASK_A (company A), Bea owns TASK_B (company B); Cal is a commenter on TASK_A. */
function fakeCode() {
  const calls: Call[] = [];
  const owners: Record<string, string> = { [TASK_A]: ADA, [TASK_B]: BEA };
  const peopleRevision: Record<string, number> = { [TASK_A]: 3, [TASK_B]: 5 };
  const flags = { commit: false, candidates: "ok" as "ok" | "404" | "501" | "huge" | "garbage", view: "ok" as "ok" | "garbage", confirmationUrl: undefined as string | undefined, changeRequestId: undefined as string | undefined };
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (status: number, code: string, message: string) => respond(status, { error: { code, message } });
  const viewOf = (taskId: string, me: Who) => ({
    revision: peopleRevision[taskId], orphaned: false, canManage: owners[taskId] === me.developerId, canTakeOwnership: owners[taskId] !== me.developerId,
    addPeopleUrl: "https://slack.example.test/invite",
    people: [
      { personId: PERSON_ADA, name: "Ada", role: owners[taskId] === ADA ? "owner" : "viewer", you: me.developerId === ADA, effectiveRole: owners[taskId] === ADA ? "owner" : "viewer", method: "github" },
      { personId: PERSON_CAL, name: "Cal", role: "commenter", you: me.developerId === CAL, effectiveRole: "commenter" },
    ],
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    if (url.pathname === "/v1/auth/token") {
      const form = new URLSearchParams(bodyText);
      const who = WHO[form.get("code") ?? ""];
      return who === undefined ? respond(400, { error: "invalid_grant" }) : respond(200, { access_token: who.token });
    }
    const me = Object.values(WHO).find((entry) => `Bearer ${entry.token}` === headers.authorization);
    if (me === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: me.developerId, displayName: me.name, administrator: false, companyId: me.company === "A" ? COMPANY_A : COMPANY_B, companyRole: "member", projects: [{ name: "payments", access: "developer" }], notices: [] });
    calls.push({ method, path: url.pathname, token: me.token, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const route = /^\/v1\/dev\/tasks\/([^/]+)\/people(?:\/([a-z-]+))?$/u.exec(url.pathname);
    if (route === null) return refuse(404, "NOT_FOUND", "route not found");
    const taskId = route[1]!;
    // Company boundary: a task of the other company is simply not there.
    const sameCompany = (taskId === TASK_A && me.company === "A") || (taskId === TASK_B && me.company === "B");
    if (!sameCompany) return refuse(404, "TASK_NOT_FOUND", `no task ${taskId} of yours`);
    const owner = owners[taskId] === me.developerId;
    const sub = route[2];
    if (sub === undefined && method === "GET") return respond(200, { view: flags.view === "garbage" ? { revision: "x" } : viewOf(taskId, me), requestId: "r" });
    if (sub === "candidates" && method === "GET") {
      if (!owner) return refuse(403, "TASK_ACCESS_DENIED", "Only a task owner can see who may be added");
      if (flags.candidates === "404") return refuse(404, "NOT_FOUND", "route not found");
      if (flags.candidates === "501") return refuse(501, "NOT_ON_CORE_ENGINE", "This isn't on the core engine");
      if (flags.candidates === "garbage") return respond(200, { candidates: { candidates: [{ developerId: "nope", name: "X" }], complete: true }, requestId: "r" });
      if (flags.candidates === "huge") return respond(200, { candidates: { candidates: Array.from({ length: 201 }, (_, index) => ({ developerId: index.toString(16).padStart(64, "0"), name: `P${String(index)}` })), complete: false }, requestId: "r" });
      return respond(200, { candidates: { candidates: [{ developerId: DAN, name: "Dan" }], complete: true }, requestId: "r" });
    }
    if (method === "POST" && (sub === "role" || sub === "add" || sub === "take-ownership")) {
      if (!owner && sub !== "take-ownership") return refuse(403, "TASK_ACCESS_DENIED", "Only a task owner can change who is on this task");
      const body = JSON.parse(bodyText) as { requestId: string; expectedPeopleRevision: number };
      if (body.expectedPeopleRevision !== peopleRevision[taskId]) return refuse(409, "CHANGE_STALE", "Task access changed before the role could be saved");
      if (flags.commit) {
        if (sub === "take-ownership") owners[taskId] = me.developerId;
        peopleRevision[taskId] = (peopleRevision[taskId] ?? 0) + 1;
        return respond(200, { change: { status: "COMMITTED", view: viewOf(taskId, me) }, requestId: "r" });
      }
      return respond(200, { change: { status: "PENDING", requestId: flags.changeRequestId ?? body.requestId, confirmationUrl: flags.confirmationUrl ?? `${CODE}/review/${taskId}/task/people/confirm/${body.requestId}`, expiresAt: "2026-11-17T13:00:00.000Z" }, requestId: "r" });
    }
    return refuse(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  return { fetchImpl, calls, flags, owners, peopleCalls: () => calls.filter((call) => call.path.includes("/people")) };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: code.fetchImpl });
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
  await context.session(SES_A, TASK_A, { developerId: ADA, name: "Ada" });
  await context.session(SES_B, TASK_B, { developerId: BEA, name: "Bea" });
  const ada = await context.signIn("ada-code");
  const cal = await context.signIn("cal-code");
  const bea = await context.signIn("bea-code");
  return { ...context, ada, cal, bea };
};
const roleBody = (extra: Record<string, unknown> = {}) => ({ requestId: REQ, expectedPeopleRevision: 3, personId: PERSON_CAL, role: "viewer", ...extra });
const addBody = (extra: Record<string, unknown> = {}) => ({ requestId: REQ, expectedPeopleRevision: 3, developerId: DAN, role: "commenter", ...extra });
const ownBody = (extra: Record<string, unknown> = {}) => ({ requestId: REQ, expectedPeopleRevision: 3, ...extra });
const path = (suffix: string, session = SES_A) => `/v1/web/sessions/${session}/people${suffix}`;

describe("People on a session: reading", () => {
  it("answers the list from Code as the person, with the task id from Cloud's own record, and keeps only the fields the app reads", async () => {
    const { call, ada, code } = await base();
    const answer = await call("GET", path(""), ada);
    expect(answer.status).toBe(200);
    const parsed = SessionPeopleResponseSchema.parse(json(answer));
    expect(parsed.people).toMatchObject({ revision: 3, canManage: true, canTakeOwnership: false });
    expect(parsed.people.people[0]).toMatchObject({ personId: PERSON_ADA, name: "Ada", role: "owner", you: true, method: "github" });
    expect(answer.body).not.toContain("slack.example.test");
    expect(code.peopleCalls()).toEqual([{ method: "GET", path: `/v1/dev/tasks/${TASK_A}/people`, token: "ada-access" }]);
  });

  it("answers an unknown session as not found and asks Code nothing", async () => {
    const { call, ada, code } = await base();
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/candidates", undefined], ["POST", "/role", roleBody()], ["POST", "/add", addBody()], ["POST", "/take-ownership", ownBody()]] as const) {
      const answer = await call(method, path(suffix, SES_NONE), { ...ada, ...(body === undefined ? {} : { body }) });
      expect(answer.status, `${method} ${suffix}`).toBe(404);
      expect(json(answer)).toEqual({ error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } });
    }
    expect(code.peopleCalls()).toEqual([]);
  });

  it("refuses a list Code answers in a shape it does not know, with fixed words and no echo", async () => {
    const { call, ada, code } = await base();
    code.flags.view = "garbage";
    const answer = await call("GET", path(""), ada);
    expect(answer.status).toBe(502);
    expect(json(answer)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent a People answer Cloud couldn't read." } });
  });

  it("does not take a task id from the browser: a task's own address is not a route, and a task id in a body is refused", async () => {
    const { call, ada, code } = await base();
    expect((await call("GET", `/v1/web/tasks/${TASK_A}/people`, ada)).status).toBe(501);
    expect((await call("POST", path("/role"), { ...ada, body: roleBody({ taskId: TASK_B }) })).status).toBe(400);
    expect((await call("POST", path("/take-ownership"), { ...ada, body: ownBody({ taskId: TASK_B }) })).status).toBe(400);
    expect((await call("POST", path("/add"), { ...ada, body: addBody({ taskId: TASK_B }) })).status).toBe(400);
    expect(code.peopleCalls()).toEqual([]);
  });

  it("lists the candidates the owner may add, passing Code's words, and keeps only names and opaque ids", async () => {
    const { call, ada, code } = await base();
    const answer = await call("GET", path("/candidates"), ada);
    expect(answer.status).toBe(200);
    expect(SessionPeopleCandidatesResponseSchema.parse(json(answer))).toEqual({ candidates: [{ developerId: DAN, name: "Dan" }], complete: true });
    expect(code.peopleCalls()).toEqual([{ method: "GET", path: `/v1/dev/tasks/${TASK_A}/people/candidates`, token: "ada-access" }]);
  });

  it("refuses candidates Code sends in a shape it does not know or over the limit of 200", async () => {
    const { call, ada, code } = await base();
    for (const mode of ["garbage", "huge"] as const) {
      code.flags.candidates = mode;
      const answer = await call("GET", path("/candidates"), ada);
      expect(answer.status, mode).toBe(502);
      expect(json(answer)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent a People answer Cloud couldn't read." } });
    }
  });

  it("passes Code's 404 and 501 for candidates on as Code sent them (a Code that does not serve the route yet)", async () => {
    const { call, ada, code } = await base();
    code.flags.candidates = "404";
    const missing = await call("GET", path("/candidates"), ada);
    expect(missing.status).toBe(404);
    expect(json(missing)).toEqual({ error: { code: "NOT_FOUND", message: "route not found" } });
    code.flags.candidates = "501";
    const notCore = await call("GET", path("/candidates"), ada);
    expect(notCore.status).toBe(501);
    expect(json(notCore)).toEqual({ error: { code: "NOT_ON_CORE_ENGINE", message: "This isn't on the core engine" } });
  });
});

describe("People on a session: changes", () => {
  it("forwards a role change to Code exactly, and answers a pending change with the address of Code's confirm page", async () => {
    const { call, ada, code } = await base();
    const answer = await call("POST", path("/role"), { ...ada, body: roleBody() });
    expect(answer.status).toBe(202);
    expect(SessionPeopleChangeResponseSchema.parse(json(answer))).toEqual({ status: "PENDING", requestId: REQ, confirmUrl: `${CODE}/review/${TASK_A}/task/people/confirm/${REQ}`, expiresAt: "2026-11-17T13:00:00.000Z" });
    const sent = code.peopleCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: `/v1/dev/tasks/${TASK_A}/people/role`, token: "ada-access" });
    expect(JSON.parse(sent[0]!.body!)).toEqual(roleBody());
  });

  it("answers a committed change with the list as it is now", async () => {
    const { call, ada, code } = await base();
    code.flags.commit = true;
    const answer = await call("POST", path("/role"), { ...ada, body: roleBody({ role: "denied" }) });
    expect(answer.status).toBe(200);
    expect(SessionPeopleChangeResponseSchema.parse(json(answer))).toMatchObject({ status: "COMMITTED", people: { revision: 4, canManage: true } });
    expect(answer.body).not.toContain("slack.example.test");
  });

  it("adds a person through Code's add route with the chosen candidate, role and the revision the page saw", async () => {
    const { call, ada, code } = await base();
    const answer = await call("POST", path("/add"), { ...ada, body: addBody({ role: "viewer" }) });
    expect(answer.status).toBe(202);
    const sent = code.peopleCalls();
    expect(sent[0]).toMatchObject({ method: "POST", path: `/v1/dev/tasks/${TASK_A}/people/add`, token: "ada-access" });
    expect(JSON.parse(sent[0]!.body!)).toEqual(addBody({ role: "viewer" }));
  });

  it("checks every body at runtime and sends Code nothing for a bad one, never echoing what was sent", async () => {
    const { call, ada, code } = await base();
    const secret = "echo-me-if-you-dare";
    const bad: Array<[string, unknown]> = [
      ["/role", roleBody({ role: "admin" })], ["/role", roleBody({ personId: "not-a-uuid" })], ["/role", roleBody({ requestId: 7 })], ["/role", { ...roleBody(), extra: secret }],
      ["/role", roleBody({ expectedPeopleRevision: 0 })], ["/role", roleBody({ expectedPeopleRevision: "3" })], ["/role", { requestId: REQ }], ["/role", [secret]], ["/role", secret],
      ["/add", addBody({ role: "denied" })], ["/add", addBody({ developerId: DAN.slice(1) })], ["/add", addBody({ developerId: secret })], ["/add", { ...addBody(), personId: PERSON_CAL }],
      ["/take-ownership", ownBody({ personId: PERSON_CAL })], ["/take-ownership", { expectedPeopleRevision: 3 }],
    ];
    for (const [suffix, body] of bad) {
      const answer = await call("POST", path(suffix), { ...ada, body });
      expect(answer.status, `${suffix} ${JSON.stringify(body)}`).toBe(400);
      expect(answer.body).not.toContain(secret);
      expect(json(answer)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
    const empty = await call("POST", path("/role"), ada);
    expect(empty.status).toBe(400);
    expect(code.peopleCalls()).toEqual([]);
  });

  it("refuses a change whose pending answer is not the one asked for (another request id), with fixed words", async () => {
    const { call, ada, code } = await base();
    code.flags.changeRequestId = "44444444-4444-4444-8444-444444444444";
    const answer = await call("POST", path("/role"), { ...ada, body: roleBody() });
    expect(answer.status).toBe(502);
    expect(json(answer)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent a People answer Cloud couldn't read." } });
  });

  it("builds the confirm address itself and never passes on an address Code names", async () => {
    const { call, ada, code } = await base();
    code.flags.confirmationUrl = "https://evil.example.test/steal";
    const answer = await call("POST", path("/role"), { ...ada, body: roleBody() });
    expect(answer.status).toBe(202);
    expect(answer.body).not.toContain("evil.example.test");
    expect(json(answer)["confirmUrl"]).toBe(`${CODE}/review/${TASK_A}/task/people/confirm/${REQ}`);
  });

  it("takes ownership: a committed take-over makes the person the session's owner, a pending one changes nothing in Cloud", async () => {
    const { call, cal, work, code } = await base();
    const pending = await call("POST", path("/take-ownership"), { ...cal, body: ownBody() });
    expect(pending.status).toBe(202);
    expect((await work.get(SES_A))?.owner.developerId).toBe(ADA);
    expect(JSON.parse(code.peopleCalls().at(-1)!.body!)).toEqual(ownBody());
    code.flags.commit = true;
    const done = await call("POST", path("/take-ownership"), { ...cal, body: ownBody() });
    expect(done.status).toBe(200);
    expect(SessionPeopleChangeResponseSchema.parse(json(done)).status).toBe("COMMITTED");
    expect(await work.get(SES_A)).toMatchObject({ owner: { developerId: CAL, name: "Cal" }, revision: 2 });
  });

  it("passes Code's refusals on unchanged (status and words), for a person who may not manage People", async () => {
    const { call, cal, code } = await base();
    const refusal = { error: { code: "TASK_ACCESS_DENIED", message: "Only a task owner can change who is on this task" } };
    for (const [suffix, body] of [["/role", roleBody()], ["/add", addBody()]] as const) {
      const answer = await call("POST", path(suffix), { ...cal, body });
      expect(answer.status).toBe(403);
      expect(json(answer)).toEqual(refusal);
    }
    const candidates = await call("GET", path("/candidates"), cal);
    expect(candidates.status).toBe(403);
    expect(json(candidates)).toEqual({ error: { code: "TASK_ACCESS_DENIED", message: "Only a task owner can see who may be added" } });
    expect(code.owners[TASK_A]).toBe(ADA);
  });

  it("passes a stale people revision on as Code worded it", async () => {
    const { call, ada } = await base();
    const answer = await call("POST", path("/role"), { ...ada, body: roleBody({ expectedPeopleRevision: 2 }) });
    expect(answer.status).toBe(409);
    expect(json(answer)).toEqual({ error: { code: "CHANGE_STALE", message: "Task access changed before the role could be saved" } });
  });
});

describe("People on a session: sign-in, CSRF and the company boundary", () => {
  it("refuses every write without the CSRF header or with a wrong one, and a read without a sign-in, asking Code nothing", async () => {
    const { call, ada, code } = await base();
    for (const [suffix, body] of [["/role", roleBody()], ["/add", addBody()], ["/take-ownership", ownBody()]] as const) {
      const missing = await call("POST", path(suffix), { cookie: ada.cookie, body });
      expect(missing.status, suffix).toBe(403);
      expect(json(missing)).toEqual({ error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } });
      const wrong = await call("POST", path(suffix), { cookie: ada.cookie, csrf: `${ada.csrf}x`, body });
      expect(wrong.status, suffix).toBe(403);
      const noSignIn = await call("POST", path(suffix), { csrf: ada.csrf, body });
      expect(noSignIn.status, suffix).toBe(401);
    }
    for (const suffix of ["", "/candidates"]) expect((await call("GET", path(suffix), {})).status).toBe(401);
    // One person's token is no use for another's cookie.
    const cross = await call("POST", path("/role"), { cookie: ada.cookie, csrf: (await setUp().signIn("ada-code")).csrf, body: roleBody() });
    expect(cross.status).toBe(403);
    expect(code.peopleCalls()).toEqual([]);
  });

  it("keeps two companies apart: company B's person gets Code's not-found for company A's session, reads and writes, and nothing of A's reaches them", async () => {
    const { call, bea, ada, work, code } = await base();
    const reads = [await call("GET", path(""), bea), await call("GET", path("/candidates"), bea)];
    const writes = [await call("POST", path("/role"), { ...bea, body: roleBody() }), await call("POST", path("/add"), { ...bea, body: addBody() }), await call("POST", path("/take-ownership"), { ...bea, body: ownBody() })];
    for (const answer of [...reads, ...writes]) {
      expect(answer.status).toBe(404);
      expect(json(answer)).toEqual({ error: { code: "TASK_NOT_FOUND", message: `no task ${TASK_A} of yours` } });
      expect(answer.body).not.toContain("Ada");
      expect(answer.body).not.toContain(PERSON_CAL);
    }
    // Positive control: the same calls reached Code, as Bea, and Code (not Cloud) refused them.
    expect(code.peopleCalls()).toHaveLength(5);
    expect(code.peopleCalls().every((entry) => entry.token === "bea-access" && entry.path.includes(TASK_A))).toBe(true);
    // Nothing changed in A: its owner, and Ada's own read still works.
    expect(code.owners[TASK_A]).toBe(ADA);
    expect((await work.get(SES_A))?.owner.developerId).toBe(ADA);
    expect((await call("GET", path(""), ada)).status).toBe(200);
    // And B's own session works for B and is not Ada's.
    expect((await call("GET", path("", SES_B), bea)).status).toBe(200);
    expect((await call("GET", path("", SES_B), ada)).status).toBe(404);
  });

  it("keeps Cloud's own company check too: a session stamped with company A is not found by company B's person on any People route, and Code is never asked", async () => {
    const context = setUp();
    await context.session(SES_A, TASK_A, { developerId: ADA, name: "Ada" }, COMPANY_A);
    const ada = await context.signIn("ada-code");
    const bea = await context.signIn("bea-code");
    const refused = { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } };
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/candidates", undefined], ["POST", "/role", roleBody()], ["POST", "/add", addBody()], ["POST", "/take-ownership", ownBody()]] as const) {
      const answer = await context.call(method, path(suffix), { ...bea, ...(body === undefined ? {} : { body }) });
      expect(answer.status, `${method} ${suffix}`).toBe(404);
      expect(json(answer)).toEqual(refused);
    }
    expect(context.code.peopleCalls()).toEqual([]);
    // Positive control: the owner's company reads and writes the same session, and the take-over keeps the session's company.
    expect((await context.call("GET", path(""), ada)).status).toBe(200);
    expect(context.code.peopleCalls()).toHaveLength(1);
    context.code.flags.commit = true;
    expect((await context.call("POST", path("/take-ownership"), { ...ada, body: ownBody() })).status).toBe(200);
    expect((await context.work.get(SES_A))?.companyId).toBe(COMPANY_A);
  });
});
