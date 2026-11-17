// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the "AI and spending" step's Code-answered routes through Cloud's handler
// (ai-spend-routes.ts), and the step's whole save through the existing Cloud money routes, with two companies.
//
// The pretend Code here keeps two companies and applies Code's rules: the engine model (Code #835: any member reads, an owner or admin sets one
// from the gateway's live list for THEIR company) and a project's cost settings (Code's M4a: members of the project's company read, the project's
// administrator changes them with a fresh step-up, revision-checked, never above the company's limit). Cloud must pass the person's own token,
// never let the browser name a company, refuse first where it can (Code not asked), forward only checked members, check Code's answers, and
// answer refusals in its fixed words.
import { describe, expect, it } from "vitest";
import {
  AI_SPEND_ANSWERS, AI_SPEND_WORDS, CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, engineModelView,
  projectSettingsOf, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person> = {
  ada: { id: "d".repeat(64), company: A, role: "owner", grants: {} },
  pam: { id: "a".repeat(64), company: A, role: "member", grants: { payments: "administrator" } },
  cal: { id: "c".repeat(64), company: A, role: "member", grants: { payments: "developer" } },
  bea: { id: "e".repeat(64), company: B, role: "admin", grants: { ledger: "administrator" } },
  nob: { id: "6".repeat(64), grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, ledger: B };
const OFFERED: Record<string, string[]> = { [A]: ["zai.glm-4.7", "claude-sonnet-4-5"], [B]: ["zai.glm-4.6"] };
const INSTALL_MODEL = "zai.glm-4.6";
/** Company A's per-task limit at Code (a company bound): a project may not set more. */
const A_TASK_LIMIT_USD = 50;

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const clock = { at: START };
  const calls: CodeCall[] = [];
  const byToken = new Map<string, { person: Person; steppedUp: boolean }>();
  const models = new Map<string, string>();
  const settings = new Map<string, { overrides: Record<string, unknown>; revision: number }>([["payments", { overrides: { real_check: "their_ci_fix" }, revision: 2 }], ["ledger", { overrides: {}, revision: 0 }]]);
  const engineView = (company: string) => {
    const own = models.get(company), model = own ?? INSTALL_MODEL, offered = OFFERED[company]!;
    return { model, source: own === undefined ? "install" : "company", offered, preselect: offered.includes(model) ? model : offered[0] };
  };
  const settingsView = (project: string) => {
    const entry = settings.get(project)!;
    const own = entry.overrides["model_budget_usd"];
    return { preset: null, overrides: { ...entry.overrides }, revision: entry.revision, updatedAt: null, updatedBy: null, resolved: {}, values: { model_budget_usd: { value: typeof own === "number" ? own : A_TASK_LIMIT_USD, origin: "company limit" } }, clamped: [] };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const held = byToken.get((call.authorization ?? "").replace(/^Bearer /u, ""));
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (held === undefined) return json(401, {});
    const person = held.person;
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: Object.entries(person.grants).map(([name, access]) => ({ name, access })), notices: [] });
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    if (url.pathname === "/v1/dev/company/engine-model") {
      if (person.company === undefined) return json(401, { error: { code: "AUTH_REQUIRED", message: LEAK } });
      if (call.method === "GET") return json(200, engineView(person.company));
      if (person.role !== "owner" && person.role !== "admin") return json(403, { error: { code: "FORBIDDEN", message: "Only a company owner or admin can change the company's AI model." } });
      const model = (call.body as { model?: unknown } | undefined)?.model;
      if (model !== null && (typeof model !== "string" || !OFFERED[person.company]!.includes(model))) return json(400, { error: { code: "CONFIG_INVALID", message: "That model isn't offered to this company now. Pick one from the list." } });
      if (model === null) models.delete(person.company); else models.set(person.company, model);
      return json(200, engineView(person.company));
    }
    const match = /^\/v1\/dev\/projects\/([^/]+)\/settings$/u.exec(url.pathname);
    if (match === null) return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const project = decodeURIComponent(match[1]!);
    if (person.company === undefined || PROJECTS[project] !== person.company) return json(404, { error: { code: "NOT_FOUND", message: `project not found ${LEAK}` } });
    if (call.method === "GET") return json(200, settingsView(project));
    if (person.grants[project] !== "administrator") return json(403, { error: { code: "FORBIDDEN", message: `project administrator required ${LEAK}` } });
    const body = call.body as { expectedRevision: number; overrides: Record<string, unknown> };
    const entry = settings.get(project)!;
    if (body.expectedRevision !== entry.revision) return json(409, { error: { code: "PROJECT_REVISION_MISMATCH", message: `${LEAK} conflict` } });
    if (!held.steppedUp) return json(403, { error: { code: "REAUTH_REQUIRED", message: `${LEAK} step up` } });
    const asked = body.overrides["model_budget_usd"];
    if (typeof asked === "number" && asked > A_TASK_LIMIT_USD) return json(403, { error: { code: "FORBIDDEN", message: "model_budget_usd: company limit cannot be crossed" } });
    settings.set(project, { overrides: { ...body.overrides }, revision: entry.revision + 1 });
    return json(200, settingsView(project));
  }) as typeof fetch;
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
  const companies = new LocalCompanyStore();
  const audit = new LocalCloudAuditStore(undefined, {});
  const handler = createCloudHandler({
    client, store: sessions, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(clock.at), audit, company: { store: companies, log: () => undefined },
  });
  let tokens = 0;
  /** Signs `who` in; `stepUpAge` seconds ago they confirmed it's them (undefined: never). The stored sign-in names company A for everyone: Cloud must use Code's live answer. */
  const as = async (who: string, stepUpAge?: number) => {
    const person = PEOPLE[who]!; tokens += 1;
    const nowS = Math.floor(clock.at / 1000);
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: person.id, iat: nowS, exp: nowS + 3600, jti: String(tokens), ...(stepUpAge === undefined ? {} : { step_up_at: nowS - stepUpAge, step_up_amr: "passkey" }) })}.c2ln`;
    byToken.set(token, { person, steppedUp: stepUpAge !== undefined });
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
  const codeCalls = (path: string, method?: string) => calls.filter((call) => call.path.startsWith(path) && (method === undefined || call.method === method));
  return { as, send, calls, codeCalls, models, settings, companies, audit, clock };
}
const ENGINE = "/v1/web/org/engine-model";
const LIMITS = (project: string) => `/v1/web/projects/${project}/spend-limits`;
const CODE_ENGINE = "/v1/dev/company/engine-model";
const CODE_SETTINGS = "/v1/dev/projects/";

describe("the company's AI model", () => {
  it("any member reads it as themselves; only an owner or admin may change it; the company is never the browser's", async () => {
    const w = setUp();
    const cal = await w.as("cal");
    const read = await w.send("GET", `${ENGINE}?company=${B}&orgId=${B}`, cal, undefined, { "x-rovara-company": B });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ model: INSTALL_MODEL, source: "install", offered: OFFERED[A], preselect: "zai.glm-4.7", canChange: false });
    expect(w.codeCalls(CODE_ENGINE)).toEqual([expect.objectContaining({ method: "GET", search: "", authorization: `Bearer ${cal.token}` })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
    const ada = await w.as("ada");
    expect((await w.send("GET", ENGINE, ada)).body).toMatchObject({ canChange: true });
  });

  it("a plain member's change is refused by Cloud in Code's words, and Code is not asked", async () => {
    const w = setUp();
    const cal = await w.as("cal", 10);
    const refused = await w.send("PUT", ENGINE, cal, { model: "zai.glm-4.7" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: AI_SPEND_WORDS.notAdmin } } });
    expect(w.codeCalls(CODE_ENGINE, "PUT")).toEqual([]);
    expect(w.models.size).toBe(0);
  });

  it("an owner saves a model from their company's list: Code gets exactly { model } with the owner's token; company B's model and list are untouched", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    const saved = await w.send("PUT", `${ENGINE}?company=${B}`, ada, { model: "claude-sonnet-4-5" }, { "x-rovara-company": B });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ model: "claude-sonnet-4-5", source: "company", offered: OFFERED[A], preselect: "claude-sonnet-4-5", canChange: true });
    expect(w.codeCalls(CODE_ENGINE, "PUT")).toEqual([expect.objectContaining({ body: { model: "claude-sonnet-4-5" }, authorization: `Bearer ${ada.token}`, search: "" })]);
    expect(w.models.get(A)).toBe("claude-sonnet-4-5");
    expect(w.models.has(B)).toBe(false);
    const bea = await w.as("bea");
    expect((await w.send("GET", ENGINE, bea)).body).toEqual({ model: INSTALL_MODEL, source: "install", offered: OFFERED[B], preselect: INSTALL_MODEL, canChange: true });
    // B's admin can't pick A's model: B's own list decides at Code.
    const other = await w.send("PUT", ENGINE, bea, { model: "claude-sonnet-4-5" });
    expect(other).toMatchObject({ status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: AI_SPEND_WORDS.notOffered } } });
    expect(w.models.get(A)).toBe("claude-sonnet-4-5");
    expect(w.models.has(B)).toBe(false);
  });

  it("a model that is not one id, or any other body, is refused before Code, without echoing it", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    for (const body of [{ model: "<script>x" }, { model: "" }, { model: 7 }, { model: "zai.glm-4.7", company: B }, {}, null, [], { model: "x".repeat(2000) }, { model: "a".repeat(129) }]) {
      const r = await w.send("PUT", ENGINE, ada, body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual(AI_SPEND_ANSWERS.invalid.body);
    }
    expect(w.codeCalls(CODE_ENGINE, "PUT")).toEqual([]);
    // Clearing is Code's contract too (back to the install default).
    expect((await w.send("PUT", ENGINE, ada, { model: null })).body).toMatchObject({ source: "install" });
    expect(w.codeCalls(CODE_ENGINE, "PUT")[0]!.body).toEqual({ model: null });
  });

  it("Code's refusals and failures become fixed sentences; nothing of Code's text leaks", async () => {
    const cases: Array<[Response, unknown]> = [
      [json(404, { error: { code: "NOT_FOUND", message: "route not found" } }), AI_SPEND_ANSWERS.notYet.body],
      [json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "The AI models this company can use could not be read just now; nothing was changed. Try again in a moment." } }), AI_SPEND_ANSWERS.listUnreadable.body],
      [json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }), AI_SPEND_ANSWERS.unavailable.body],
      [json(400, { error: { code: "CONFIG_INVALID", message: LEAK } }), AI_SPEND_ANSWERS.invalid.body],
      [json(403, { error: { code: "FORBIDDEN", message: LEAK } }), AI_SPEND_ANSWERS.notAdmin.body],
      [json(500, { error: { code: "X", message: LEAK } }), AI_SPEND_ANSWERS.unavailable.body],
      [json(200, { model: LEAK, source: "company", offered: ["a"], preselect: LEAK }), AI_SPEND_ANSWERS.unavailable.body],
    ];
    for (const [response, expected] of cases) {
      const w = setUp((call) => (call.path === CODE_ENGINE ? response.clone() : undefined));
      const ada = await w.as("ada");
      for (const method of ["GET", "PUT"]) {
        const r = await w.send(method, ENGINE, ada, method === "PUT" ? { model: "zai.glm-4.7" } : undefined);
        expect(r.body).toEqual(expected);
        expect(r.text).not.toContain(LEAK);
      }
    }
  });

  it("someone Code names no company for is refused before Code's engine-model route", async () => {
    const w = setUp();
    const nob = await w.as("nob");
    for (const method of ["GET", "PUT"]) expect((await w.send(method, ENGINE, nob, method === "PUT" ? { model: "zai.glm-4.7" } : undefined)).body).toMatchObject({ error: { code: "NO_COMPANY" } });
    expect(w.codeCalls(CODE_ENGINE)).toEqual([]);
  });
});

describe("Code's engine-model answer is checked", () => {
  const good = { model: "b", source: "company", offered: ["a", "b"], preselect: "b" };
  it("passes Code's view through and refuses anything else", () => {
    expect(engineModelView(good)).toEqual(good);
    expect(engineModelView({ model: null, source: "install", offered: ["a"], preselect: "a" })).toBeDefined();
    expect(engineModelView({ model: "z", source: "install", offered: ["a", "b"], preselect: "a" })).toBeDefined();
    for (const bad of [
      { ...good, extra: 1 }, { ...good, source: "other" }, { ...good, offered: [] }, { ...good, offered: ["a", "a"] }, { ...good, offered: ["<b>"] },
      { ...good, preselect: "c" }, { ...good, preselect: "a" }, { model: "z", source: "install", offered: ["a", "b"], preselect: "b" }, { ...good, model: 3 },
      { ...good, offered: Array.from({ length: 201 }, (_, i) => `m${String(i)}`) }, null, [],
    ]) expect(engineModelView(bad)).toBeUndefined();
  });
  it("reads a project's per-task member strictly", () => {
    expect(projectSettingsOf({ revision: 1, overrides: {} })).toMatchObject({ revision: 1, perTaskUsd: undefined });
    expect(projectSettingsOf({ revision: 1, overrides: { model_budget_usd: null } })).toMatchObject({ perTaskUsd: null });
    for (const bad of [{ revision: -1, overrides: {} }, { revision: 1 }, { revision: 1, overrides: { model_budget_usd: "5" } }, { revision: 1, overrides: { model_budget_usd: -1 } }, { revision: 1.5, overrides: {} }, null]) {
      expect(projectSettingsOf(bad)).toBeUndefined();
    }
  });
});

describe("a project's per-task limit", () => {
  it("reads 'Same as company' with what applies; who may change it follows the person's live roles; another company's project is 'not found'", async () => {
    const w = setUp();
    const pam = await w.as("pam"), cal = await w.as("cal"), ada = await w.as("ada"), bea = await w.as("bea");
    expect((await w.send("GET", LIMITS("payments"), pam)).body).toEqual({ project: "payments", revision: 2, perTask: { sameAsCompany: true, usd: null }, appliedUsd: A_TASK_LIMIT_USD, canChange: true });
    expect((await w.send("GET", LIMITS("payments"), cal)).body).toMatchObject({ canChange: false });
    expect((await w.send("GET", LIMITS("payments"), ada)).body).toMatchObject({ canChange: true });
    const foreign = await w.send("GET", LIMITS("payments"), bea);
    expect(foreign).toMatchObject({ status: 404, body: AI_SPEND_ANSWERS.projectNotFound.body });
    expect(foreign.text).not.toContain(LEAK);
    const before = w.calls.length;
    expect((await w.send("GET", LIMITS("Payments"), pam)).body).toEqual(AI_SPEND_ANSWERS.projectNotFound.body);
    expect(w.calls.slice(before).filter((call) => call.path.startsWith(CODE_SETTINGS))).toEqual([]);
  });

  it("the project's admin sets its own limit: Cloud keeps every other override and names the revision read; 'Same as company' removes it again", async () => {
    const w = setUp();
    const pam = await w.as("pam", 10);
    const set = await w.send("PUT", `${LIMITS("payments")}?company=${B}`, pam, { expectedRevision: 2, perTaskUsd: 12.5 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ project: "payments", revision: 3, perTask: { sameAsCompany: false, usd: 12.5 }, appliedUsd: 12.5, canChange: true });
    const put = w.codeCalls(CODE_SETTINGS, "PUT");
    expect(put).toEqual([expect.objectContaining({ path: "/v1/dev/projects/payments/settings", search: "", authorization: `Bearer ${pam.token}`, body: { expectedRevision: 2, overrides: { real_check: "their_ci_fix", model_budget_usd: 12.5 } } })]);
    const same = await w.send("PUT", LIMITS("payments"), pam, { expectedRevision: 3, perTaskUsd: null });
    expect(same.body).toMatchObject({ revision: 4, perTask: { sameAsCompany: true, usd: null } });
    expect(w.settings.get("payments")).toEqual({ overrides: { real_check: "their_ci_fix" }, revision: 4 });
    // The same value again writes nothing.
    const writes = w.codeCalls(CODE_SETTINGS, "PUT").length;
    expect((await w.send("PUT", LIMITS("payments"), pam, { expectedRevision: 4, perTaskUsd: null })).status).toBe(200);
    expect(w.codeCalls(CODE_SETTINGS, "PUT")).toHaveLength(writes);
    // Company B's project is untouched.
    expect(w.settings.get("ledger")).toEqual({ overrides: {}, revision: 0 });
  });

  it("a plain project user is refused by Cloud (Code not asked); a company owner who isn't the project's admin is refused by Code; both in fixed words", async () => {
    const w = setUp();
    const cal = await w.as("cal", 10);
    expect((await w.send("PUT", LIMITS("payments"), cal, { expectedRevision: 2, perTaskUsd: 5 })).body).toEqual(AI_SPEND_ANSWERS.projectNotAllowed.body);
    expect(w.codeCalls(CODE_SETTINGS)).toEqual([]);
    const ada = await w.as("ada", 10);
    const r = await w.send("PUT", LIMITS("payments"), ada, { expectedRevision: 2, perTaskUsd: 5 });
    expect(r).toMatchObject({ status: 403, body: AI_SPEND_ANSWERS.projectNotAllowed.body });
    expect(r.text).not.toContain(LEAK);
    expect(w.settings.get("payments")!.revision).toBe(2);
    // Another company's admin: "not found", and nothing written.
    const bea = await w.as("bea", 10);
    const foreign = await w.send("PUT", LIMITS("payments"), bea, { expectedRevision: 2, perTaskUsd: 5 });
    expect(foreign).toMatchObject({ status: 404, body: AI_SPEND_ANSWERS.projectNotFound.body });
    expect(foreign.text).not.toContain(LEAK);
    expect(w.settings.get("payments")!.revision).toBe(2);
  });

  it("a moved revision is refused before anything is written; no step-up, above the company's limit and bad amounts get fixed sentences", async () => {
    const w = setUp();
    const pam = await w.as("pam", 10);
    expect((await w.send("PUT", LIMITS("payments"), pam, { expectedRevision: 1, perTaskUsd: 5 })).body).toEqual(AI_SPEND_ANSWERS.projectStale.body);
    expect(w.codeCalls(CODE_SETTINGS, "PUT")).toEqual([]);
    const above = await w.send("PUT", LIMITS("payments"), pam, { expectedRevision: 2, perTaskUsd: A_TASK_LIMIT_USD + 1 });
    expect(above.body).toEqual(AI_SPEND_ANSWERS.projectAboveCompany.body);
    const tired = await w.as("pam");
    const stepUp = await w.send("PUT", LIMITS("payments"), tired, { expectedRevision: 2, perTaskUsd: 5 });
    expect(stepUp).toMatchObject({ status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: AI_SPEND_WORDS.stepUp } } });
    expect(stepUp.text).not.toContain(LEAK);
    const writes = w.codeCalls(CODE_SETTINGS).length;
    for (const body of [{ expectedRevision: 2, perTaskUsd: 1.234 }, { expectedRevision: 2, perTaskUsd: -1 }, { expectedRevision: 2, perTaskUsd: 1_000_001 }, { expectedRevision: 2, perTaskUsd: "5" },
      { expectedRevision: 2, perTaskUsd: 5, overrides: { real_check: "sandbox_only" } }, { perTaskUsd: 5 }, { expectedRevision: -1, perTaskUsd: 5 }, { expectedRevision: 2, perTaskUsd: true }, null]) {
      const r = await w.send("PUT", LIMITS("payments"), pam, body);
      expect(r.body).toEqual(AI_SPEND_ANSWERS.projectInvalid.body);
    }
    expect(w.codeCalls(CODE_SETTINGS)).toHaveLength(writes);
    expect(w.settings.get("payments")).toEqual({ overrides: { real_check: "their_ci_fix" }, revision: 2 });
  });

  it("an unreadable Code answer and Code's failures are fixed sentences", async () => {
    for (const [response, expected] of [
      [json(200, { revision: "x", overrides: {} }), AI_SPEND_ANSWERS.projectUnavailable.body],
      [json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }), AI_SPEND_ANSWERS.projectUnavailable.body],
      [json(400, { error: { code: "CONFIG_INVALID", message: LEAK } }), AI_SPEND_ANSWERS.projectInvalid.body],
    ] as const) {
      const w = setUp((call) => (call.path.startsWith(CODE_SETTINGS) ? response.clone() : undefined));
      const pam = await w.as("pam", 10);
      for (const method of ["GET", "PUT"]) {
        const r = await w.send(method, LIMITS("payments"), pam, method === "PUT" ? { expectedRevision: 2, perTaskUsd: 5 } : undefined);
        expect(r.body).toEqual(expected);
        expect(r.text).not.toContain(LEAK);
      }
    }
  });
});

/** The company's saved monthly limit, as Cloud's store keeps it. */
async function capOf(w: ReturnType<typeof setUp>, company: string): Promise<unknown> {
  const read = await w.companies.settings(company) as { settings: { budgets: { companyMonthlyUsdMicros: unknown } } } | undefined;
  return read?.settings.budgets.companyMonthlyUsdMicros;
}

describe("the whole step's save, two companies", () => {
  /** What the step's one Save sends (packages/ui screens/setup/AiSpendStep.tsx): the monthly limit, the AI source, then ALWAYS the model. */
  async function saveStep(w: ReturnType<typeof setUp>, who: { headers: Record<string, string> }, choice: { capMicros: number; source: string; model: string }) {
    const read = await w.send("GET", "/v1/web/org/settings", who);
    const settings = read.body["settings"] as Record<string, unknown>;
    const budgets = { ...(settings["budgets"] as Record<string, unknown>), companyMonthlyUsdMicros: choice.capMicros, learningMonthlyUsdMicros: Math.min((settings["budgets"] as { learningMonthlyUsdMicros: number }).learningMonthlyUsdMicros, choice.capMicros) };
    const cap = await w.send("PUT", "/v1/web/org/settings", who, { expectedVersion: read.body["version"], settings: { ...settings, budgets } });
    const agentAi = await w.send("GET", "/v1/web/org/agent-ai", who);
    const source = await w.send("PUT", "/v1/web/org/agent-ai", who, { expectedVersion: agentAi.body["version"], source: choice.source });
    const model = await w.send("PUT", ENGINE, who, { model: choice.model });
    return { cap, source, model };
  }

  it("A's save writes A's limit, source and model only; B's stay as they were; members can't save any of it", async () => {
    const w = setUp();
    const ada = await w.as("ada", 10);
    const saved = await saveStep(w, ada, { capMicros: 500_000_000, source: "rovara", model: "zai.glm-4.7" });
    expect([saved.cap.status, saved.source.status, saved.model.status]).toEqual([200, 200, 200]);
    expect(await capOf(w, A)).toBe(500_000_000);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara" });
    // The preselected model is written explicitly, so the company no longer depends on the install default.
    expect(saved.model.body).toMatchObject({ model: "zai.glm-4.7", source: "company" });
    expect(w.models.get(A)).toBe("zai.glm-4.7");
    expect(await w.companies.settings(B)).toBeUndefined();
    expect(await w.companies.agentAi(B)).toBeUndefined();
    expect(w.models.has(B)).toBe(false);
    const bea = await w.as("bea", 10);
    const b = await saveStep(w, bea, { capMicros: 100_000_000, source: "anthropic_key", model: "zai.glm-4.6" });
    expect([b.cap.status, b.source.status, b.model.status]).toEqual([200, 200, 200]);
    expect(await capOf(w, A)).toBe(500_000_000);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara" });
    expect(w.models.get(A)).toBe("zai.glm-4.7");
    // Each company's reads are its own.
    expect((await w.send("GET", "/v1/web/org/budget-settings", ada)).body).toMatchObject({ orgId: A, orgMonthly: { microdollars: 500_000_000 } });
    expect((await w.send("GET", "/v1/web/org/budget-settings", bea)).body).toMatchObject({ orgId: B, orgMonthly: { microdollars: 100_000_000 } });
    // A plain member can read the model but save none of the three.
    const cal = await w.as("cal", 10);
    expect((await w.send("GET", ENGINE, cal)).status).toBe(200);
    expect((await w.send("GET", "/v1/web/org/settings", cal)).status).toBe(403);
    expect((await w.send("PUT", "/v1/web/org/agent-ai", cal, { expectedVersion: 1, source: "anthropic_key" })).status).toBe(403);
    expect((await w.send("PUT", ENGINE, cal, { model: "claude-sonnet-4-5" })).status).toBe(403);
    expect(w.models.get(A)).toBe("zai.glm-4.7");
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara" });
  });

  it("the money writes keep Cloud's own step-up check (an owner without a fresh step-up saves no limit and no source)", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    const saved = await saveStep(w, ada, { capMicros: 500_000_000, source: "rovara", model: "zai.glm-4.7" });
    expect(saved.cap.body.error?.code).toBe("STEP_UP_REQUIRED");
    expect(saved.source.body.error?.code).toBe("STEP_UP_REQUIRED");
    expect(await w.companies.settings(A)).toBeUndefined();
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });
});
