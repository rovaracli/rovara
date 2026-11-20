// DEC 254zzz63 (Code #1075): the company's lessons LEARNING model routes through Cloud's handler (learning-model-routes.ts), with two companies.
//
// The pretend Code keeps two companies and applies Code's rules (any member reads; an owner or admin sets a Claude model from the gateway's live list for THEIR company; null puts the
// install default back). Its views and refusals are Code's REAL answers (tests/fixtures/code-answers.ts, generated from #1075's tree): a test below holds the pretend Code to them, so it
// cannot drift into a friendlier Code than the real one. Cloud must pass the person's own token, never let the browser name a company, refuse first where it can (Code not asked), forward
// only the checked member, check Code's answers, and answer refusals in its fixed words.
import { describe, expect, it } from "vitest";
import {
  CodeClient, LEARNING_MODEL_ANSWERS, LEARNING_MODEL_WORDS, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, learningModelView,
  type CloudRequest,
} from "../../packages/cloud-server/src/index.js";
import {
  LEARNING_MODEL_CLEARED, LEARNING_MODEL_DEFAULT_NOT_OFFERED, LEARNING_MODEL_INSTALL_BROKEN, LEARNING_MODEL_NONE_OFFERED, LEARNING_MODEL_OTHER_COMPANY_READ, LEARNING_MODEL_OTHER_COMPANY_SAVED,
  LEARNING_MODEL_READ_INSTALL, LEARNING_MODEL_REFUSALS, LEARNING_MODEL_SAVED, devAnswer,
} from "../fixtures/code-answers.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5", HAIKU_4 = "claude-haiku-4-5";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member" }
const PEOPLE: Record<string, Person> = {
  ada: { id: "d".repeat(64), company: A, role: "owner" },
  cal: { id: "c".repeat(64), company: A, role: "member" },
  amy: { id: "a".repeat(64), company: A, role: "admin" },
  bea: { id: "e".repeat(64), company: B, role: "admin" },
  nob: { id: "6".repeat(64) },
};
/** What each company's gateway offers it, Claude models only (Code leaves the others out). */
const LISTS: Record<string, string[]> = { [A]: [SONNET, HAIKU], [B]: [HAIKU_4, SONNET] };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined, lists: Record<string, string[]> = LISTS) {
  const clock = { at: START };
  const calls: CodeCall[] = [];
  const byToken = new Map<string, Person>();
  const chosen = new Map<string, string>();
  const view = (company: string) => {
    const own = chosen.get(company), model = own ?? HAIKU, offered = lists[company]!;
    return { model, source: own === undefined ? "install" : "company", offered, preselect: offered.includes(model) ? model : offered[0] ?? null };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const person = byToken.get((call.authorization ?? "").replace(/^Bearer /u, ""));
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, devAnswer({ developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] }));
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    if (url.pathname !== "/v1/dev/company/learning-model") return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const refusal = (r: { status: number; body: unknown }) => json(r.status, devAnswer(r.body as object));
    if (person.company === undefined) return refusal(LEARNING_MODEL_REFUSALS.signedOut);
    if (call.method === "GET") return json(200, devAnswer(view(person.company)));
    if (person.role !== "owner" && person.role !== "admin") return refusal(LEARNING_MODEL_REFUSALS.member);
    const body = call.body as Record<string, unknown> | undefined;
    const model = body?.["model"];
    if (body === undefined || Object.keys(body).length !== 1 || !(model === null || (typeof model === "string" && /^claude-/u.test(model)))) return refusal(LEARNING_MODEL_REFUSALS.bodyInvalid);
    if (model !== null && !lists[person.company]!.includes(model)) return refusal(LEARNING_MODEL_REFUSALS.notOffered);
    if (model === null) chosen.delete(person.company); else chosen.set(person.company, model);
    return json(200, devAnswer(view(person.company)));
  }) as typeof fetch;
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store: sessions, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(clock.at), audit: new LocalCloudAuditStore(undefined, {}), company: { store: new LocalCompanyStore(), log: () => undefined },
  });
  let tokens = 0;
  /** Signs `who` in. The stored sign-in names company A, owner, for everyone: Cloud must use Code's live answer, never this. */
  const as = async (who: string) => {
    const person = PEOPLE[who]!; tokens += 1;
    const nowS = Math.floor(clock.at / 1000);
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: person.id, iat: nowS, exp: nowS + 3600, jti: String(tokens) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, refreshToken: `r-${cookie}`, csrf: "csrf", signedInAt: new Date(clock.at).toISOString(), access: { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } });
    return { headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": "csrf", "content-type": "application/json" }, token };
  };
  const send = async (method: string, target: string, who: { headers: Record<string, string> }, body?: unknown, extra: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...who.headers, ...extra }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = (await handler(request))!;
    return { status: answered.status, body: JSON.parse(answered.body) as Record<string, unknown> & { error?: { code: string; message: string } }, text: answered.body };
  };
  const codeCalls = (method?: string) => calls.filter((call) => call.path === CODE_PATH && (method === undefined || call.method === method));
  return { as, send, calls, codeCalls, chosen };
}
const PATH = "/v1/web/org/learning-model";
const CODE_PATH = "/v1/dev/company/learning-model";

describe("the pretend Code is held to Code's real answers", () => {
  it("gives exactly what Code's own handler gave for the same scenarios", async () => {
    const a = setUp();
    const ada = await a.as("ada");
    const read = await a.send("GET", PATH, ada);
    expect(read.body).toEqual({ ...LEARNING_MODEL_READ_INSTALL, canChange: true });
    expect((await a.send("PUT", PATH, ada, { model: SONNET })).body).toEqual({ ...LEARNING_MODEL_SAVED, canChange: true });
    expect((await a.send("PUT", PATH, ada, { model: null })).body).toEqual({ ...LEARNING_MODEL_CLEARED, canChange: true });
    const b = setUp(undefined, { [A]: [SONNET], [B]: [] });
    expect((await b.send("GET", PATH, await b.as("ada"))).body).toEqual({ ...LEARNING_MODEL_DEFAULT_NOT_OFFERED, canChange: true });
    expect((await b.send("GET", PATH, await b.as("bea"))).body).toEqual({ ...LEARNING_MODEL_NONE_OFFERED, canChange: true });
    const c = setUp();
    const bea = await c.as("bea");
    expect((await c.send("GET", PATH, bea)).body).toEqual({ ...LEARNING_MODEL_OTHER_COMPANY_READ, canChange: true });
    expect((await c.send("PUT", PATH, bea, { model: HAIKU_4 })).body).toEqual({ ...LEARNING_MODEL_OTHER_COMPANY_SAVED, canChange: true });
  });
});

describe("any member reads, an owner or admin changes", () => {
  it("a member reads as themselves (Code's real answer, canChange false); the company is never the browser's", async () => {
    const w = setUp();
    const cal = await w.as("cal");
    const read = await w.send("GET", `${PATH}?company=${B}&orgId=${B}`, cal, undefined, { "x-rovara-company": B });
    expect(read).toMatchObject({ status: 200, body: { ...LEARNING_MODEL_READ_INSTALL, canChange: false } });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "GET", search: "", authorization: `Bearer ${cal.token}` })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("a member's change is refused by Cloud in its fixed words, and Code is not asked", async () => {
    const w = setUp();
    const cal = await w.as("cal");
    for (const body of [{ model: SONNET }, { model: null }, { junk: 1 }]) {
      expect(await w.send("PUT", PATH, cal, body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: LEARNING_MODEL_WORDS.notAdmin } } });
    }
    expect(w.codeCalls("PUT")).toEqual([]);
    expect(w.chosen.size).toBe(0);
  });

  it("an owner and an admin each save a model from their company's list: Code gets exactly { model } with their own token", async () => {
    const w = setUp();
    const ada = await w.as("ada"), amy = await w.as("amy");
    const saved = await w.send("PUT", `${PATH}?company=${B}`, ada, { model: SONNET }, { "x-rovara-company": B });
    expect(saved).toMatchObject({ status: 200, body: { ...LEARNING_MODEL_SAVED, canChange: true } });
    expect(w.codeCalls("PUT")).toEqual([expect.objectContaining({ body: { model: SONNET }, authorization: `Bearer ${ada.token}`, search: "" })]);
    expect((await w.send("PUT", PATH, amy, { model: null })).body).toEqual({ ...LEARNING_MODEL_CLEARED, canChange: true });
    expect(w.codeCalls("PUT")[1]).toMatchObject({ body: { model: null }, authorization: `Bearer ${amy.token}` });
    expect(w.chosen.size).toBe(0);
  });

  it("a model that is not one id, or any other body, is refused before Code, without echoing it", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    for (const body of [{ model: "<script>x" }, { model: "" }, { model: 7 }, { model: SONNET, company: B }, { model: SONNET, source: "company" }, {}, null, [], { model: "x".repeat(2000) }, { model: "a".repeat(129) }]) {
      const r = await w.send("PUT", PATH, ada, body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual(LEARNING_MODEL_ANSWERS.invalid.body);
    }
    expect(w.codeCalls("PUT")).toEqual([]);
  });

  it("someone Code names no company for is refused before Code's learning-model route", async () => {
    const w = setUp();
    const nob = await w.as("nob");
    for (const method of ["GET", "PUT"]) expect((await w.send(method, PATH, nob, method === "PUT" ? { model: SONNET } : undefined)).body).toMatchObject({ error: { code: "NO_COMPANY" } });
    expect(w.codeCalls()).toEqual([]);
  });
});

describe("two companies", () => {
  it("A's choice never shows in B; B's admin cannot pick what B's own list lacks, whatever A holds; a company named by the browser changes nothing", async () => {
    const w = setUp();
    const ada = await w.as("ada"), bea = await w.as("bea");
    await w.send("PUT", PATH, ada, { model: HAIKU });
    expect(w.chosen.get(A)).toBe(HAIKU);
    expect((await w.send("GET", PATH, bea)).body).toEqual({ ...LEARNING_MODEL_OTHER_COMPANY_READ, canChange: true });
    const refused = await w.send("PUT", `${PATH}?company=${A}`, bea, { model: HAIKU }, { "x-rovara-company": A });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: LEARNING_MODEL_WORDS.notOffered } } });
    expect(w.chosen.has(B)).toBe(false);
    expect(w.chosen.get(A)).toBe(HAIKU);
    expect((await w.send("GET", PATH, ada)).body).toMatchObject({ model: HAIKU, source: "company", offered: LISTS[A] });
    expect((await w.send("PUT", PATH, bea, { model: HAIKU_4 })).body).toMatchObject({ source: "company", model: HAIKU_4, offered: LISTS[B] });
    expect(w.chosen.get(A)).toBe(HAIKU);
  });
});

describe("Code's refusals and failures become fixed sentences; nothing of Code's text leaks", () => {
  const R = LEARNING_MODEL_REFUSALS;
  const cases: Array<[string, Response, unknown]> = [
    ["404 not wired (real)", json(R.notWired.status, devAnswer(R.notWired.body)), LEARNING_MODEL_ANSWERS.notYet.body],
    ["503 list (real)", json(R.listUnavailable.status, devAnswer(R.listUnavailable.body)), LEARNING_MODEL_ANSWERS.listUnreadable.body],
    ["503 setting (real)", json(R.settingUnavailable.status, devAnswer(R.settingUnavailable.body)), LEARNING_MODEL_ANSWERS.settingUnavailable.body],
    ["403 (real)", json(R.member.status, devAnswer(R.member.body)), LEARNING_MODEL_ANSWERS.notAdmin.body],
    ["400 not offered (real)", json(R.notOffered.status, devAnswer(R.notOffered.body)), LEARNING_MODEL_ANSWERS.notOffered.body],
    ["400 body (real)", json(R.bodyInvalid.status, devAnswer(R.bodyInvalid.body)), LEARNING_MODEL_ANSWERS.invalid.body],
    ["503 other", json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }), LEARNING_MODEL_ANSWERS.unavailable.body],
    ["400 other", json(400, { error: { code: "CONFIG_INVALID", message: LEAK } }), LEARNING_MODEL_ANSWERS.invalid.body],
    ["403 other", json(403, { error: { code: "FORBIDDEN", message: LEAK } }), LEARNING_MODEL_ANSWERS.notAdmin.body],
    ["500", json(500, { error: { code: "X", message: LEAK } }), LEARNING_MODEL_ANSWERS.unavailable.body],
    ["200 that is not the view", json(200, { model: LEAK, source: "company", offered: ["a"], preselect: LEAK }), LEARNING_MODEL_ANSWERS.unavailable.body],
  ];
  it.each(cases)("%s", async (_name, response, expected) => {
    const w = setUp((call) => (call.path === CODE_PATH ? response.clone() : undefined));
    const ada = await w.as("ada");
    for (const method of ["GET", "PUT"]) {
      const r = await w.send(method, PATH, ada, method === "PUT" ? { model: SONNET } : undefined);
      expect(r.body).toEqual(expected);
      expect(r.text).not.toContain(LEAK);
    }
  });

  it("a read's route 401 after the access POST answers sign-in-ended when renewal ends the sign-in", async () => {
    const w = setUp((call) => (call.path === CODE_PATH ? json(401, {}) : undefined));
    const ada = await w.as("ada");
    const r = await w.send("GET", PATH, ada);
    expect(r.status).toBe(401);
  });
});

describe("Code's learning-model answer is checked", () => {
  it("passes Code's real answers through, including no Claude model offered and a broken install default", () => {
    // The real "no Claude model offered" answer with no default either: not a Code scenario, but the same rule (model null, nothing offered, nothing to preselect).
    expect(learningModelView({ model: null, source: "install", offered: [], preselect: null })).toEqual({ model: null, source: "install", offered: [], preselect: null });
    for (const real of [LEARNING_MODEL_READ_INSTALL, LEARNING_MODEL_SAVED, LEARNING_MODEL_CLEARED, LEARNING_MODEL_DEFAULT_NOT_OFFERED, LEARNING_MODEL_NONE_OFFERED, LEARNING_MODEL_INSTALL_BROKEN, LEARNING_MODEL_OTHER_COMPANY_READ]) {
      expect(learningModelView(JSON.parse(JSON.stringify(real)))).toEqual(real);
    }
  });
  it("refuses anything else", () => {
    const good = { model: SONNET, source: "company", offered: [HAIKU, SONNET], preselect: SONNET };
    expect(learningModelView(good)).toEqual(good);
    for (const bad of [
      { ...good, extra: 1 }, { ...good, source: "other" }, { ...good, offered: [HAIKU, HAIKU] }, { ...good, offered: ["<b>"] }, { ...good, preselect: HAIKU }, { ...good, preselect: null },
      { ...good, preselect: "zzz" }, { ...good, model: 3 }, { ...good, model: "<x>" }, { ...good, offered: [HAIKU, 5] }, { ...good, offered: "x" },
      { model: HAIKU, source: "install", offered: [], preselect: HAIKU }, { model: HAIKU, source: "install", offered: [SONNET], preselect: null }, { model: HAIKU, source: "install", offered: [SONNET], preselect: HAIKU },
      { ...good, offered: Array.from({ length: 201 }, (_, i) => `m${String(i)}`), preselect: "m0" }, { model: SONNET, source: "company", offered: [] }, null, [], "x",
    ]) expect(learningModelView(bad)).toBeUndefined();
    expect(learningModelView({ model: "a", source: "company", offered: Array.from({ length: 200 }, (_, i) => `m${String(i)}`), preselect: "m0" })).toBeDefined();
  });
});
