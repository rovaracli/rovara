// Lead 3 B1 (DEC 254t b): GET /org/spend-limits and PUT /org/spend-limits/projects/{p} | /people/{id}. Company admins only (reads too); a fresh
// step-up ONLY when a change raises what a project or person may spend (removing an override counts when the default is higher, and no limit is
// the highest); a write conditional on what was read; every change audited; fixed words that never echo the request; two companies never meet.
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, SPEND_LIMITS_MAX, createCloudHandler, defaultCompanySettings,
  type CloudRequest, type SpendLimit, type SpendLimitBasis, type SpendLimitKind,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const DEV = { ada: "d".repeat(64), ann: "f".repeat(64), pam: "a".repeat(64), bea: "e".repeat(64), zed: "9".repeat(64) } as const;
interface Person { developerId: string; name: string; administrator: boolean; companyId: string }
const PEOPLE: Record<string, Person> = {
  ada: { developerId: DEV.ada, name: "Ada", administrator: true, companyId: A },
  ann: { developerId: DEV.ann, name: "Ann", administrator: true, companyId: A },
  pam: { developerId: DEV.pam, name: "Pam", administrator: false, companyId: A },
  bea: { developerId: DEV.bea, name: "Bea", administrator: true, companyId: B },
};
/** The projects Code knows in each company (both have "web"). */
const PROJECTS: Record<string, string[]> = { [A]: ["web", "api"], [B]: ["web", "billing"] };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const MICROS = 1_000_000;

class Racing extends LocalCompanyStore {
  /** Runs once, right after the override was read for a decision (a change that races it). */
  afterRead: (() => Promise<void>) | undefined;
  override async spendLimit(companyId: string, kind: SpendLimitKind, id: string) {
    const read = await super.spendLimit(companyId, kind, id);
    const hook = this.afterRead; this.afterRead = undefined;
    if (hook !== undefined) await hook();
    return read;
  }
  /** Makes the next write or read fail with text that must never reach an answer. */
  breakWith: string | undefined;
  override async putSpendLimit(limit: Omit<SpendLimit, "version">, basis: SpendLimitBasis) { if (this.breakWith !== undefined) throw new Error(this.breakWith); return super.putSpendLimit(limit, basis); }
  override async removeSpendLimit(companyId: string, kind: SpendLimitKind, id: string, basis: SpendLimitBasis) { if (this.breakWith !== undefined) throw new Error(this.breakWith); return super.removeSpendLimit(companyId, kind, id, basis); }
}

function world(options: { company?: boolean; codeProject?: "ok" | "outage" } = {}) {
  const clock = { at: START }; let tokens = 0;
  const nowS = () => Math.floor(clock.at / 1000);
  const byToken = new Map<string, Person>();
  const codeCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const person = byToken.get(((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return new Response("{}", { status: 401 });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/dev/access") return reply(200, { developerId: person.developerId, displayName: person.name, administrator: person.administrator, companyId: person.companyId, projects: [], notices: [] });
    const project = /^\/v1\/dev\/client\/projects\/([^/]+)$/u.exec(url.pathname);
    if (project !== null) {
      codeCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (options.codeProject === "outage") return reply(500, { error: { code: "X", message: "secret outage text" } });
      return PROJECTS[person.companyId]?.includes(decodeURIComponent(project[1]!)) === true ? reply(200, { name: decodeURIComponent(project[1]!), latestRevision: 1, access: "administrator", repositories: [] }) : reply(404, { error: { code: "NOT_FOUND", message: "no" } });
    }
    return reply(404, {});
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const audit = new LocalCloudAuditStore(undefined, {});
  const companies = new Racing();
  const logs: string[] = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(clock.at), log: (event) => { logs.push(JSON.stringify(event)); }, audit,
    ...(options.company === false ? {} : { company: { store: companies, log: (event: Record<string, unknown>) => { logs.push(JSON.stringify(event)); } } }),
  });
  const signIn = async (who: string, stepUpAge?: number) => {
    const person = PEOPLE[who]!; tokens += 1;
    const token = `${b64({ alg: "RS256", typ: "JWT", kid: "code" })}.${b64({ sub: person.developerId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens), ...(stepUpAge === undefined ? {} : { step_up_at: nowS() - stepUpAge, step_up_amr: "passkey" }) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.developerId, displayName: person.name, administrator: person.administrator, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock.at).toISOString() });
    return cookie;
  };
  const call = async (cookie: string, method: string, path: string, body?: unknown, csrf = `csrf-${cookie}`) => {
    const request: CloudRequest = { method, path: `/v1/web${path}`, query: new URLSearchParams(), headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } }, raw: answer.body };
  };
  /** Saves the company's settings with these budgets (and any other change), as an admin would have. */
  const settings = async (companyId: string, budgets: { company?: number | null; member?: number | null; project?: number | null; task?: number | null }, more: (s: ReturnType<typeof defaultCompanySettings>) => void = () => undefined) => {
    const s = defaultCompanySettings();
    s.budgets = { companyMonthlyUsdMicros: budgets.company === undefined ? 100 * MICROS : budgets.company, memberMonthlyUsdMicros: budgets.member === undefined ? 20 * MICROS : budgets.member, projectMonthlyUsdMicros: budgets.project === undefined ? 30 * MICROS : budgets.project, taskUsdMicros: budgets.task === undefined ? 2 * MICROS : budgets.task, learningMonthlyUsdMicros: 1 };
    more(s);
    const current = await companies.settings(companyId);
    await companies.putSettings(companyId, s, current?.version ?? 0, DEV.ada, new Date(clock.at).toISOString());
  };
  const seed = async (companyId: string, kind: SpendLimitKind, id: string, micros: number) => {
    const settingsVersion = (await companies.settings(companyId))?.version ?? 0;
    const have = await companies.spendLimit(companyId, kind, id);
    await companies.putSpendLimit({ companyId, kind, id, monthlyUsdMicros: micros, updatedAt: new Date(clock.at).toISOString(), updatedBy: DEV.ada }, { override: have === undefined ? undefined : { version: have.version, monthlyUsdMicros: have.monthlyUsdMicros }, settingsVersion });
  };
  const auditRows = async (companyId: string) => (await audit.read(companyId, { max: 100 })).rows.filter((r) => r.action === "company.budget.changed");
  return { companies, audit, logs, codeCalls, clock, signIn, call, settings, seed, auditRows };
}
type World = ReturnType<typeof world>;
const put = (expectedVersion: number, monthlyUsd: unknown) => ({ expectedVersion, monthlyUsd });
const PATH = "/org/spend-limits";
const project = (id: string) => `${PATH}/projects/${id}`;
const person = (id: string) => `${PATH}/people/${id}`;
const READY = async () => { const w = world(); await w.settings(A, {}); await w.settings(B, {}); return w; };
const stored = (w: World, kind: SpendLimitKind, id: string, companyId = A) => w.companies.spendLimit(companyId, kind, id);

describe("who may see and change spending limits", () => {
  it("a company admin reads the defaults and the overrides; each company sees only its own", async () => {
    const w = await READY();
    await w.seed(A, "project", "web", 5 * MICROS); await w.seed(A, "person", DEV.pam, 7 * MICROS); await w.seed(B, "project", "web", 9 * MICROS); await w.seed(B, "person", DEV.pam, 11 * MICROS);
    const a = await w.call(await w.signIn("ada", 30), "GET", PATH);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      companyId: A, canChange: true, defaults: { companyMonthlyUsd: 100, memberMonthlyUsd: 20, projectMonthlyUsd: 30, taskUsd: 2 },
      projects: [{ id: "web", monthlyUsd: 5, version: 1 }], people: [{ id: DEV.pam, monthlyUsd: 7, version: 1 }], partial: false, max: { projects: SPEND_LIMITS_MAX.project, people: SPEND_LIMITS_MAX.person },
    });
    const b = await w.call(await w.signIn("bea", 30), "GET", PATH);
    expect(b.body).toMatchObject({ companyId: B, projects: [{ id: "web", monthlyUsd: 9 }], people: [{ id: DEV.pam, monthlyUsd: 11 }] });
    expect(JSON.stringify(a.body)).not.toContain(B);
    expect(JSON.stringify(b.body)).not.toContain(A);
  });

  it("a plain member sees nothing and changes nothing (reads too), and nothing is written", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 5 * MICROS);
    const pam = await w.signIn("pam", 30);
    for (const [method, path, body] of [["GET", PATH, undefined], ["PUT", project("web"), put(1, 1)], ["PUT", project("api"), put(0, 1)], ["PUT", person(DEV.pam), put(0, 1)]] as const) {
      const answer = await w.call(pam, method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body.error?.code).toBe("FORBIDDEN");
    }
    expect((await stored(w, "project", "web"))?.version).toBe(1);
    expect(await stored(w, "project", "api")).toBeUndefined();
    expect(await stored(w, "person", DEV.pam)).toBeUndefined();
    expect(await w.auditRows(A)).toEqual([]);
  });

  it("has no route when this Cloud has no company backend, and refuses a write without the CSRF token", async () => {
    const off = world({ company: false });
    // No route here: the table's own "not on Code yet" answer, with nothing of this feature in it.
    expect((await off.call(await off.signIn("ada", 30), "GET", PATH)).status).toBe(501);
    const w = await READY();
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", project("web"), put(0, 1), "wrong")).status).toBe(403);
    expect(await stored(w, "project", "web")).toBeUndefined();
  });

  it("the path's ids are strict: a project name or person id that is not in the token format is no route (the table's own 501)", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    for (const path of [project("Web"), project("web/../x"), project("-web"), person("abc"), person("G".repeat(64)), person("1".repeat(65)), `${PATH}/teams/web`]) {
      expect((await w.call(ada, "PUT", path, put(0, 1))).status, path).toBe(501);
    }
    expect((await w.companies.spendLimits(A)).projects).toEqual([]);
  });
});

describe("step-up: only when a limit goes up", () => {
  it("lowering a project's limit needs no step-up (a new override under the default, and a lower amount than the current override)", async () => {
    const w = await READY(); const ada = await w.signIn("ada");
    const first = await w.call(ada, "PUT", project("web"), put(0, 10));
    expect(first.status).toBe(200);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1, updatedBy: DEV.ada });
    const lower = await w.call(ada, "PUT", project("web"), put(1, 4.5));
    expect(lower.status).toBe(200);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 4_500_000, version: 2 });
  });

  it("raising needs a fresh step-up: none, an old one and a fresh one (the refused ones change nothing)", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    for (const age of [undefined, 3600, 601]) {
      const answer = await w.call(await w.signIn("ada", age), "PUT", project("web"), put(1, 25));
      expect(answer.status, String(age)).toBe(403);
      expect(answer.body.error?.code).toBe("STEP_UP_REQUIRED");
      expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1 });
    }
    const fresh = await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 25));
    expect(fresh.status).toBe(200);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 25 * MICROS, version: 2 });
  });

  it("a new override above the company default is a raise; at or below it is not", async () => {
    const w = await READY(); // project default $30, member default $20
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(0, 31))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(bare, "PUT", person(DEV.pam), put(0, 21))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(bare, "PUT", project("web"), put(0, 30))).status).toBe(200);
    expect((await w.call(bare, "PUT", person(DEV.pam), put(0, 0))).status).toBe(200);
    expect(await stored(w, "person", DEV.pam)).toMatchObject({ monthlyUsdMicros: 0 });
  });

  it("removing an override is a raise when the default is higher (step-up), lowering when the default is lower (none), and a raise when there is no default limit", async () => {
    const w = await READY(); // project default $30
    await w.seed(A, "project", "web", 10 * MICROS); await w.seed(A, "project", "api", 50 * MICROS);
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(1, null))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect(await stored(w, "project", "web")).toBeDefined();
    expect((await w.call(bare, "PUT", project("api"), put(1, null))).status).toBe(200);
    expect(await stored(w, "project", "api")).toBeUndefined();
    expect((await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, null))).status).toBe(200);
    expect(await stored(w, "project", "web")).toBeUndefined();
    // No default limit at all: no limit is the highest, so removing an override raises, and setting one lowers.
    const open = await READY(); await open.settings(A, { project: null, member: null });
    await open.seed(A, "project", "web", 10 * MICROS);
    expect((await open.call(await open.signIn("ada"), "PUT", project("web"), put(1, null))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await open.call(await open.signIn("ada"), "PUT", project("api"), put(0, 999_999))).status).toBe(200);
    expect((await open.call(await open.signIn("ada", 30), "PUT", project("web"), put(1, null))).status).toBe(200);
  });

  it("an unchanged limit writes nothing (no new version, no audit record)", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(1, 10))).status).toBe(200);
    expect((await w.call(bare, "PUT", project("api"), put(0, null))).status).toBe(200);
    expect(await stored(w, "project", "web")).toMatchObject({ version: 1 });
    expect(await stored(w, "project", "api")).toBeUndefined();
    expect(await w.auditRows(A)).toEqual([]);
  });

  it("the company's own rules apply to a raise: a company that forbids loosening cannot raise a limit (lowering still works), and its sign-in window is its own", async () => {
    const w = await READY();
    await w.settings(A, {}, (s) => { s.decisions = [{ what: "setting.loosen", allow: false }]; });
    await w.seed(A, "project", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 5);
    const raise = await w.call(ada, "PUT", project("web"), put(1, 25));
    expect(raise.status).toBe(403);
    expect(raise.body.error?.code).toBe("FORBIDDEN");
    expect((await stored(w, "project", "web"))?.monthlyUsdMicros).toBe(10 * MICROS);
    expect((await w.call(ada, "PUT", project("web"), put(1, 5))).status).toBe(200);
    // A short sign-in window: a step-up older than it is refused.
    const short = await READY(); await short.settings(A, {}, (s) => { s.freshSignInSeconds = 60; });
    await short.seed(A, "project", "web", 10 * MICROS);
    expect((await short.call(await short.signIn("ada", 120), "PUT", project("web"), put(1, 25))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await short.call(await short.signIn("ada", 30), "PUT", project("web"), put(1, 25))).status).toBe(200);
  });
});

describe("a write is decided on a fresh read and conditional on it", () => {
  it("a stale expectedVersion conflicts (409), for a new override too, and changes nothing", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 30);
    for (const version of [0, 2, 7]) {
      const answer = await w.call(ada, "PUT", project("web"), put(version, 1));
      expect(answer.status, String(version)).toBe(409);
      expect(answer.body.error?.code).toBe("CONFLICT");
    }
    expect((await w.call(ada, "PUT", project("api"), put(3, 1))).status).toBe(409);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1 });
    expect(await stored(w, "project", "api")).toBeUndefined();
  });

  it("two admins changing the same limit at once: one wins, the other conflicts", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    const [one, two] = await Promise.all([
      w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 3)),
      w.call(await w.signIn("ann", 30), "PUT", project("web"), put(1, 4)),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((await stored(w, "project", "web"))?.version).toBe(2);
    expect(await w.auditRows(A)).toHaveLength(1);
  });

  it("an override changed between the read and the write (the version moved) is refused, not overwritten", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    w.companies.afterRead = () => w.seed(A, "project", "web", 2 * MICROS);
    const answer = await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 4));
    expect(answer.status).toBe(409);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 2 * MICROS, version: 2 });
  });

  it("the company default raised between the read and the write refuses a removal that was judged a lowering", async () => {
    const w = await READY(); // project default $30, override $50: removing it LOWERS (no step-up needed)
    await w.seed(A, "project", "web", 50 * MICROS);
    w.companies.afterRead = () => w.settings(A, { project: 500 });
    const answer = await w.call(await w.signIn("ada"), "PUT", project("web"), put(1, null));
    expect(answer.status).toBe(409);
    expect(await stored(w, "project", "web")).toMatchObject({ monthlyUsdMicros: 50 * MICROS });
  });
});

describe("two companies never meet", () => {
  it("one company's admin writes only its own rows, whatever project name or person id it uses", async () => {
    const w = await READY();
    expect((await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(0, 3))).status).toBe(200);
    expect((await w.call(await w.signIn("bea", 30), "PUT", project("web"), put(0, 4))).status).toBe(200);
    expect((await w.call(await w.signIn("ada", 30), "PUT", person(DEV.zed), put(0, 5))).status).toBe(200);
    expect(await stored(w, "project", "web", A)).toMatchObject({ companyId: A, monthlyUsdMicros: 3 * MICROS });
    expect(await stored(w, "project", "web", B)).toMatchObject({ companyId: B, monthlyUsdMicros: 4 * MICROS });
    expect(await stored(w, "person", DEV.zed, B)).toBeUndefined();
    expect((await w.auditRows(A)).map((r) => r.subject).sort()).toEqual([`spend_limit:person:${DEV.zed}`, "spend_limit:project:web"]);
    expect((await w.auditRows(B)).map((r) => r.subject)).toEqual(["spend_limit:project:web"]);
    // B's version is B's own: A's version (1) does not stand for B's.
    expect((await w.call(await w.signIn("bea", 30), "PUT", project("web"), put(0, 6))).status).toBe(409);
  });

  it("a project Code does not know in the admin's company is refused even when another company has it", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    const answer = await w.call(ada, "PUT", project("billing"), put(0, 1));
    expect(answer.status).toBe(404);
    expect(answer.body.error?.code).toBe("NOT_FOUND");
    expect(await stored(w, "project", "billing", A)).toBeUndefined();
    expect(await stored(w, "project", "billing", B)).toBeUndefined();
  });
});

describe("fail closed, in fixed words", () => {
  it("a stored limit or company settings that do not read answer 503 and change nothing", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    w.companies.corruptSpendLimit(A, "project", "web");
    const ada = await w.signIn("ada", 30);
    for (const [method, path, body] of [["GET", PATH, undefined], ["PUT", project("web"), put(1, 3)], ["PUT", project("web"), put(1, null)]] as const) {
      const answer = await w.call(ada, method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(503);
      expect(answer.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
    }
    const none = world(); // company settings whose saved row does not read
    const dead = await none.signIn("ada", 30);
    await none.companies.putSettings(A, { ...defaultCompanySettings(), websiteCeiling: { mode: "bogus" } as never }, 0, DEV.ada, "2026-11-17T12:00:00.000Z");
    expect((await none.call(dead, "GET", PATH)).status).toBe(503);
    expect((await none.call(dead, "PUT", project("web"), put(0, 1))).status).toBe(503);
    expect(await stored(none, "project", "web")).toBeUndefined();
  });

  it("a failed write answers 503 with fixed words; the cause's text and the request never appear in any answer or log line", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    w.companies.breakWith = "table cloud-companies exploded SECRET-CAUSE";
    const answer = await w.call(ada, "PUT", project("web"), put(0, 12.34));
    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
    for (const text of [answer.raw, ...w.logs]) for (const secret of ["SECRET-CAUSE", "exploded", "12.34", "cloud-companies", "web"]) expect(text, secret).not.toContain(secret);
    expect(await stored(w, "project", "web")).toBeUndefined();
  });

  it("Code's answer about the project: unknown is 404, an outage is 503, and Code's own words never reach the answer", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    const unknown = await w.call(ada, "PUT", project("nope"), put(0, 1));
    expect(unknown.status).toBe(404);
    expect(unknown.raw).not.toContain("nope");
    const out = world({ codeProject: "outage" }); await out.settings(A, {});
    const answer = await out.call(await out.signIn("ada", 30), "PUT", project("web"), put(0, 1));
    expect(answer.status).toBe(503);
    expect(answer.raw).not.toContain("secret outage text");
    expect(await stored(out, "project", "web")).toBeUndefined();
  });

  it("removing a limit does not ask Code about the project (a deleted project's limit can still be cleaned up), and a person's is never checked", async () => {
    const w = await READY(); await w.seed(A, "project", "gone", 5 * MICROS);
    const ada = await w.signIn("ada", 30);
    const before = w.codeCalls.length;
    expect((await w.call(ada, "PUT", project("gone"), put(1, null))).status).toBe(200);
    expect((await w.call(ada, "PUT", person(DEV.zed), put(0, 1))).status).toBe(200);
    expect(w.codeCalls.slice(before)).toEqual([]);
    expect(await stored(w, "project", "gone")).toBeUndefined();
  });

  it("refuses amounts and bodies that are not exact, in the same words, and writes nothing", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    const bad: unknown[] = [put(0, -1), put(0, 1_000_000.01), put(0, 1_000_001), put(0, 1.234), put(0, "5"), put(0, true), put(0, [5]), put(0, { a: 1 }), put(0, undefined),
      put(-1, 1), put(1.5, 1), put(Number.MAX_SAFE_INTEGER + 1, 1), put("0" as never, 1), { monthlyUsd: 1 }, { expectedVersion: 0 }, { expectedVersion: 0, monthlyUsd: 1, extra: 1 }, [0, 1], "x", null];
    for (const body of bad) {
      const answer = await w.call(ada, "PUT", project("web"), body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error?.code).toBe("CONFIG_INVALID");
      // The same sentence whatever was wrong, and none of it echoed.
      expect(answer.body.error?.message).toBe("Send the amount in dollars, from 0 to 1,000,000 with at most two decimals, or null to remove the limit.");
    }
    const big = await w.call(ada, "PUT", project("web"), { expectedVersion: 0, monthlyUsd: 1, note: "x".repeat(5_000) });
    expect(big.status).toBe(413);
    expect(await stored(w, "project", "web")).toBeUndefined();
    // The ceiling itself and zero are fine.
    expect((await w.call(ada, "PUT", project("web"), put(0, 0))).status).toBe(200);
    expect((await w.call(ada, "PUT", project("api"), put(0, 1_000_000))).status).toBe(200);
  });

  it("at most SPEND_LIMITS_MAX overrides of a kind: the next new one is refused (existing ones still change), and the list says it is partial", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    for (let i = 0; i < SPEND_LIMITS_MAX.person; i++) await w.seed(A, "person", i.toString(16).padStart(64, "0"), MICROS);
    const refused = await w.call(ada, "PUT", person(DEV.zed), put(0, 1));
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe("There are too many limits of this kind. Remove some first.");
    expect(await stored(w, "person", DEV.zed)).toBeUndefined();
    const first = "0".repeat(64);
    expect((await w.call(ada, "PUT", person(first), put(1, 0.5))).status).toBe(200);
    expect((await w.call(ada, "PUT", project("web"), put(0, 1))).status).toBe(200);
    // One more person row beyond the bound (as a race could leave): the list is bounded and partial.
    await w.seed(A, "person", DEV.zed, MICROS);
    const listed = await w.call(ada, "GET", PATH);
    expect((listed.body.people as unknown[]).length).toBe(SPEND_LIMITS_MAX.person);
    expect(listed.body.partial).toBe(true);
  });
});

describe("every change is audited", () => {
  it("records who, what and which way, in fixed words, in the company's own audit", async () => {
    const w = await READY(); await w.seed(A, "project", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", project("web"), put(1, 25));
    await w.call(ada, "PUT", project("web"), put(2, 5));
    await w.call(ada, "PUT", project("web"), put(3, null));
    await w.call(ada, "PUT", person(DEV.pam), put(0, 2));
    const rows = await w.auditRows(A);
    expect(rows.map((r) => [r.subject, r.detail, r.outcome, r.actor.developerId, r.via, r.project]).sort()).toEqual([
      [`spend_limit:person:${DEV.pam}`, "lowered", "ok", DEV.ada, "web", undefined],
      ["spend_limit:project:web", "lowered", "ok", DEV.ada, "web", "web"],
      ["spend_limit:project:web", "raised", "ok", DEV.ada, "web", "web"],
      ["spend_limit:project:web", "removed", "ok", DEV.ada, "web", "web"],
    ].sort());
    expect(await w.auditRows(B)).toEqual([]);
  });

  it("a refused change leaves no record, and a failed audit write does not undo the change", async () => {
    const w = await READY(); const ada = await w.signIn("ada");
    await w.seed(A, "project", "web", 10 * MICROS);
    await w.call(ada, "PUT", project("web"), put(1, 25));
    expect(await w.auditRows(A)).toEqual([]);
    const failing = world(); await failing.settings(A, {});
    (failing.audit as unknown as { append: () => Promise<never> }).append = () => Promise.reject(new Error("audit store down"));
    const answer = await failing.call(await failing.signIn("ada", 30), "PUT", project("web"), put(0, 2));
    expect(answer.status).toBe(200);
    expect(await stored(failing, "project", "web")).toMatchObject({ monthlyUsdMicros: 2 * MICROS });
    expect(failing.logs.join("\n") + answer.raw).not.toContain("audit store down");
  });
});

describe("the company default is still PUT /org/settings", () => {
  it("raising a default there needs a step-up like any settings write; this route never writes the default", async () => {
    const w = await READY();
    const current = await w.companies.settings(A);
    const next = { ...(current!.settings as ReturnType<typeof defaultCompanySettings>) };
    next.budgets = { ...next.budgets, projectMonthlyUsdMicros: 999 * MICROS };
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", "/org/settings", { expectedVersion: current!.version, settings: next })).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.companies.settings(A))?.version).toBe(current!.version);
    // Nothing in this route's own PUT body can name a default.
    expect((await w.call(await w.signIn("ada", 30), "PUT", project("web"), { expectedVersion: 0, monthlyUsd: 1, defaults: { projectMonthlyUsd: 999 } })).status).toBe(400);
  });
});
