// Lead 3 B1 (DEC 254t b): GET /org/spend-limits and PUT /org/spend-limits/projects/{p} | /people/{id}. Company admins only (reads too); a fresh
// step-up ONLY when a change raises what a project or person may spend (removing an override counts when the default is higher, and no limit is
// the highest); a write conditional on what was read; every change audited; fixed words that never echo the request; two companies never meet.
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, SPEND_LIMITS_MAX, SPEND_LIMIT_KINDS, createCloudHandler, defaultCompanySettings,
  type CloudRequest, type SpendLimit, type SpendLimitBasis, type SpendLimitKind,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const DEV = { ada: "d".repeat(64), ann: "f".repeat(64), pam: "a".repeat(64), bea: "e".repeat(64), zed: "9".repeat(64) } as const;
type Role = "owner" | "admin" | "member";
/** `administrator` is Code's INSTALL administrator flag: it plays no part (a company's owners and admins are by company role). */
interface Person { developerId: string; name: string; administrator: boolean; companyId: string; companyRole: Role }
const PEOPLE: Record<string, Person> = {
  ada: { developerId: DEV.ada, name: "Ada", administrator: false, companyId: A, companyRole: "owner" },
  ann: { developerId: DEV.ann, name: "Ann", administrator: false, companyId: A, companyRole: "admin" },
  pam: { developerId: DEV.pam, name: "Pam", administrator: false, companyId: A, companyRole: "member" },
  ins: { developerId: "8".repeat(64), name: "Ines", administrator: true, companyId: A, companyRole: "member" },
  bea: { developerId: DEV.bea, name: "Bea", administrator: false, companyId: B, companyRole: "owner" },
  /** Code names no company that reads for this person. */
  nomad: { developerId: "6".repeat(64), name: "Nomad", administrator: true, companyId: "not-a-company", companyRole: "owner" },
};
/** Everyone Code lists in each company: the signed-in people, DEV.zed (a member of A only), and one person removed from A. */
const GONE = "7".repeat(64);
const LISTED: Record<string, Array<Record<string, unknown>>> = {
  [A]: [
    ...["ada", "ann", "pam", "ins"].map((who) => ({ personId: PEOPLE[who]!.developerId, companyId: A, name: PEOPLE[who]!.name, role: PEOPLE[who]!.companyRole })),
    { personId: DEV.zed, companyId: A, name: "Zed", role: "member" }, { personId: GONE, companyId: A, name: "Gone", role: "member", revokedAt: "2026-11-01T00:00:00.000Z" },
  ],
  [B]: [{ personId: DEV.bea, companyId: B, name: "Bea", role: "owner" }],
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

function world(options: { provisional?: (company: string, month: string) => Promise<number | undefined>; company?: boolean; codeProject?: "ok" | "outage"; members?: "ok" | "outage" | "pages" | "foreign" | "garbled"; pageSize?: number } = {}) {
  const clock = { at: START }; let tokens = 0;
  const nowS = () => Math.floor(clock.at / 1000);
  const byToken = new Map<string, Person>();
  const codeCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const person = byToken.get(((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return new Response("{}", { status: 401 });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/dev/access") return reply(200, { developerId: person.developerId, displayName: person.name, administrator: person.administrator, companyId: person.companyId, companyRole: person.companyRole, projects: [], notices: [] });
    if (url.pathname === "/v1/dev/company/members") {
      codeCalls.push(`GET ${url.pathname}`);
      if (options.members === "outage") return reply(500, { error: { code: "X", message: "secret outage text" } });
      if (options.members === "garbled") return reply(200, { members: "nope", more: false });
      const all = options.members === "foreign" ? [{ ...LISTED[person.companyId]![0]!, companyId: person.companyId === A ? B : A }] : LISTED[person.companyId] ?? [];
      const size = Math.min(options.pageSize ?? 100, Number(url.searchParams.get("limit") ?? "100"));
      const from = Number(url.searchParams.get("cursor")?.replace(/^c/u, "") ?? "0");
      const page = all.slice(from, from + size);
      return reply(200, { members: page, more: from + size < all.length, ...(from + size < all.length ? { cursor: `c${String(from + size)}` } : {}) });
    }
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
    ...(options.company === false ? {} : { company: { store: companies, ...(options.provisional === undefined ? {} : { peopleSpend: { monthSpend: async () => new Map<string, number>(), provisionalTotal: options.provisional } }), log: (event: Record<string, unknown>) => { logs.push(JSON.stringify(event)); } } }),
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
    // These tests are about the limits themselves, so by default one admin may loosen (the company's default rules, which ask for a second admin, have their own tests).
    s.decisions = [];
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
    await w.seed(A, "project_month", "web", 5 * MICROS); await w.seed(A, "person_month", DEV.pam, 7 * MICROS); await w.seed(B, "project_month", "web", 9 * MICROS); await w.seed(B, "person_month", DEV.pam, 11 * MICROS);
    const a = await w.call(await w.signIn("ada", 30), "GET", PATH);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      companyId: A, canChange: true, defaults: { companyMonthlyUsd: 100, memberMonthlyUsd: 20, projectMonthlyUsd: 30, taskUsd: 2 },
      projects: [{ id: "web", monthlyUsd: 5, version: 1 }], people: [{ id: DEV.pam, monthlyUsd: 7, version: 1 }], partial: false, max: { projects: SPEND_LIMITS_MAX.project_month, people: SPEND_LIMITS_MAX.person_month },
    });
    const b = await w.call(await w.signIn("bea", 30), "GET", PATH);
    expect(b.body).toMatchObject({ companyId: B, projects: [{ id: "web", monthlyUsd: 9 }], people: [{ id: DEV.pam, monthlyUsd: 11 }] });
    expect(JSON.stringify(a.body)).not.toContain(B);
    expect(JSON.stringify(b.body)).not.toContain(A);
  });

  it("a plain member sees nothing and changes nothing (reads too), and nothing is written", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 5 * MICROS);
    // A plain member, and a person who is Code's install administrator but only a member of the company: neither is a company admin.
    for (const who of ["pam", "ins"]) {
      const cookie = await w.signIn(who, 30);
      for (const [method, path, body] of [["GET", PATH, undefined], ["PUT", project("web"), put(1, 1)], ["PUT", project("api"), put(0, 1)], ["PUT", person(DEV.pam), put(0, 1)]] as const) {
        const answer = await w.call(cookie, method, path, body);
        expect(answer.status, `${who} ${method} ${path}`).toBe(403);
        expect(answer.body.error?.code).toBe("FORBIDDEN");
      }
    }
    expect((await stored(w, "project_month", "web"))?.version).toBe(1);
    expect(await stored(w, "project_month", "api")).toBeUndefined();
    expect(await stored(w, "person_month", DEV.pam)).toBeUndefined();
    expect(await w.auditRows(A)).toEqual([]);
  });

  it("has no route when this Cloud has no company backend, and refuses a write without the CSRF token", async () => {
    const off = world({ company: false });
    // No route here: the table's own "not on Code yet" answer, with nothing of this feature in it.
    expect((await off.call(await off.signIn("ada", 30), "GET", PATH)).status).toBe(501);
    const w = await READY();
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", project("web"), put(0, 1), "wrong")).status).toBe(403);
    expect(await stored(w, "project_month", "web")).toBeUndefined();
  });

  it("the path's ids are strict: a project name or person id that is not in the token format is no route (the table's own 501)", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    for (const path of [project("Web"), project("web/../x"), project("-web"), person("abc"), person("G".repeat(64)), person("1".repeat(65)), `${PATH}/teams/web`]) {
      expect((await w.call(ada, "PUT", path, put(0, 1))).status, path).toBe(501);
    }
    expect((await w.companies.spendLimits(A)).limits.project_month).toEqual([]);
  });
});

describe("which company, and who is an admin", () => {
  it("a company owner and a company admin both may; Code naming no company that reads is refused, and no deployment-wide company stands in", async () => {
    const w = await READY();
    for (const who of ["ada", "ann"]) expect((await w.call(await w.signIn(who, 30), "GET", PATH)).status, who).toBe(200);
    const nomad = await w.signIn("nomad", 30);
    for (const [method, path, body] of [["GET", PATH, undefined], ["PUT", project("web"), put(0, 1)]] as const) {
      const answer = await w.call(nomad, method, path, body);
      expect(answer.status).toBe(403);
      expect(answer.body.error?.code).toBe("NO_COMPANY");
    }
    expect(await stored(w, "project_month", "web")).toBeUndefined();
  });
});

describe("a person's limit names a member of the company", () => {
  it("a person Code lists in the company may be given one; one it does not list, a removed one, and another company's person are refused (nothing written)", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", person(DEV.zed), put(0, 1))).status).toBe(200);
    for (const stranger of [GONE, DEV.bea, "5".repeat(64)]) {
      const answer = await w.call(ada, "PUT", person(stranger), put(0, 1));
      expect(answer.status, stranger).toBe(404);
      expect(answer.body.error?.message).toBe("That person isn't in your company.");
      expect(answer.raw).not.toContain(stranger);
      expect(await stored(w, "person_month", stranger)).toBeUndefined();
    }
    // The same person id is a member of company B's list only when B's Code says so.
    expect((await w.call(await w.signIn("bea", 30), "PUT", person(DEV.zed), put(0, 1))).status).toBe(404);
  });

  it("finds a person on a later page of Code's list, and stops asking once found", async () => {
    const w = world({ members: "pages", pageSize: 2 }); await w.settings(A, {});
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", person(DEV.zed), put(0, 1))).status).toBe(200);
    expect(w.codeCalls.filter((c) => c.endsWith("/members")).length).toBe(3);
    const before = w.codeCalls.length;
    expect((await w.call(ada, "PUT", person(DEV.ada), put(0, 1))).status).toBe(200);
    expect(w.codeCalls.slice(before).filter((c) => c.endsWith("/members")).length).toBe(1);
  });

  it("a list that does not read, belongs to another company, or fails answers 503 in fixed words, not 'not a member', and writes nothing", async () => {
    for (const members of ["outage", "garbled", "foreign"] as const) {
      const w = world({ members }); await w.settings(A, {});
      const answer = await w.call(await w.signIn("ada", 30), "PUT", person(DEV.zed), put(0, 1));
      expect(answer.status, members).toBe(503);
      expect(answer.raw).not.toContain("secret outage text");
      expect(await stored(w, "person_month", DEV.zed)).toBeUndefined();
    }
  });

  it("removing a person's limit does not ask Code (an ex-member's limit can still be cleaned up), and a lowering of one that is not listed is refused", async () => {
    const w = await READY(); await w.seed(A, "person_month", GONE, 5 * MICROS);
    const ada = await w.signIn("ada", 30);
    const before = w.codeCalls.length;
    expect((await w.call(ada, "PUT", person(GONE), put(1, null))).status).toBe(200);
    expect(w.codeCalls.slice(before)).toEqual([]);
    await w.seed(A, "person_month", GONE, 5 * MICROS);
    expect((await w.call(ada, "PUT", person(GONE), put(1, 1))).status).toBe(404);
  });
});

describe("step-up: only when a limit goes up", () => {
  it("lowering a project's limit needs no step-up (a new override under the default, and a lower amount than the current override)", async () => {
    const w = await READY(); const ada = await w.signIn("ada");
    const first = await w.call(ada, "PUT", project("web"), put(0, 10));
    expect(first.status).toBe(200);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1, updatedBy: DEV.ada });
    const lower = await w.call(ada, "PUT", project("web"), put(1, 4.5));
    expect(lower.status).toBe(200);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 4_500_000, version: 2 });
  });

  it("raising needs a fresh step-up: none, an old one and a fresh one (the refused ones change nothing)", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    for (const age of [undefined, 3600, 601]) {
      const answer = await w.call(await w.signIn("ada", age), "PUT", project("web"), put(1, 25));
      expect(answer.status, String(age)).toBe(403);
      expect(answer.body.error?.code).toBe("STEP_UP_REQUIRED");
      expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1 });
    }
    const fresh = await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 25));
    expect(fresh.status).toBe(200);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 25 * MICROS, version: 2 });
  });

  it("a new override above the company default is a raise; at or below it is not", async () => {
    const w = await READY(); // project default $30, member default $20
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(0, 31))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(bare, "PUT", person(DEV.pam), put(0, 21))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(bare, "PUT", project("web"), put(0, 30))).status).toBe(200);
    expect((await w.call(bare, "PUT", person(DEV.pam), put(0, 0))).status).toBe(200);
    expect(await stored(w, "person_month", DEV.pam)).toMatchObject({ monthlyUsdMicros: 0 });
  });

  it("removing an override is a raise when the default is higher (step-up), lowering when the default is lower (none), and a raise when there is no default limit", async () => {
    const w = await READY(); // project default $30
    await w.seed(A, "project_month", "web", 10 * MICROS); await w.seed(A, "project_month", "api", 50 * MICROS);
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(1, null))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect(await stored(w, "project_month", "web")).toBeDefined();
    expect((await w.call(bare, "PUT", project("api"), put(1, null))).status).toBe(200);
    expect(await stored(w, "project_month", "api")).toBeUndefined();
    expect((await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, null))).status).toBe(200);
    expect(await stored(w, "project_month", "web")).toBeUndefined();
    // No default limit at all: no limit is the highest, so removing an override raises, and setting one lowers.
    const open = await READY(); await open.settings(A, { project: null, member: null });
    await open.seed(A, "project_month", "web", 10 * MICROS);
    expect((await open.call(await open.signIn("ada"), "PUT", project("web"), put(1, null))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await open.call(await open.signIn("ada"), "PUT", project("api"), put(0, 999_999))).status).toBe(200);
    expect((await open.call(await open.signIn("ada", 30), "PUT", project("web"), put(1, null))).status).toBe(200);
  });

  it("an unchanged limit writes nothing (no new version, no audit record)", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", project("web"), put(1, 10))).status).toBe(200);
    expect((await w.call(bare, "PUT", project("api"), put(0, null))).status).toBe(200);
    expect(await stored(w, "project_month", "web")).toMatchObject({ version: 1 });
    expect(await stored(w, "project_month", "api")).toBeUndefined();
    expect(await w.auditRows(A)).toEqual([]);
  });

  it("the company's own rules apply to a raise: a company that forbids loosening cannot raise a limit (lowering still works), and its sign-in window is its own", async () => {
    const w = await READY();
    await w.settings(A, {}, (s) => { s.decisions = [{ what: "setting.loosen", allow: false }]; });
    await w.seed(A, "project_month", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 5);
    const raise = await w.call(ada, "PUT", project("web"), put(1, 25));
    expect(raise.status).toBe(403);
    expect(raise.body.error?.code).toBe("FORBIDDEN");
    expect((await stored(w, "project_month", "web"))?.monthlyUsdMicros).toBe(10 * MICROS);
    expect((await w.call(ada, "PUT", project("web"), put(1, 5))).status).toBe(200);
    // A short sign-in window: a step-up older than it is refused.
    const short = await READY(); await short.settings(A, {}, (s) => { s.freshSignInSeconds = 60; });
    await short.seed(A, "project_month", "web", 10 * MICROS);
    expect((await short.call(await short.signIn("ada", 120), "PUT", project("web"), put(1, 25))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await short.call(await short.signIn("ada", 30), "PUT", project("web"), put(1, 25))).status).toBe(200);
  });
});

describe("a raise follows the company's rules for a loosening", () => {
  const SECOND_PERSON = "Raising this limit needs a second admin under your company's rules. Ask an owner to change the rules, or raise the company default in Company settings.";
  const withRules = async (decisions: Array<Record<string, unknown>>) => {
    const w = world(); await w.settings(A, {}, (s) => { s.decisions = decisions as never; });
    await w.seed(A, "project_month", "web", 10 * MICROS); await w.seed(A, "person_month", DEV.pam, 5 * MICROS);
    return w;
  };
  const mustRefuse = async (w: Awaited<ReturnType<typeof withRules>>, cookie: string) => {
    for (const [path, version] of [[project("web"), 1], [person(DEV.pam), 1]] as const) {
      const answer = await w.call(cookie, "PUT", path, put(version, 500));
      expect(answer.status, path).toBe(403);
      expect(answer.body.error?.code).toBe("SECOND_PERSON_REQUIRED");
      expect(answer.body.error?.message).toBe(SECOND_PERSON);
    }
    expect((await stored(w, "project_month", "web"))?.monthlyUsdMicros).toBe(10 * MICROS);
    expect((await stored(w, "person_month", DEV.pam))?.monthlyUsdMicros).toBe(5 * MICROS);
    expect(await w.auditRows(A)).toEqual([]);
  };

  it("the company's DEFAULT rules (a second person for a loosening) refuse a raise here, with a fresh step-up, and a removal that raises; lowering still works", async () => {
    const w = world(); await w.signIn("ada"); // the stock defaults, not the test helper's
    const settings = defaultCompanySettings();
    settings.budgets = { ...settings.budgets, companyMonthlyUsdMicros: 100 * MICROS, memberMonthlyUsdMicros: 20 * MICROS, projectMonthlyUsdMicros: 30 * MICROS };
    await w.companies.putSettings(A, settings, 0, DEV.ada, "2026-11-17T12:00:00.000Z");
    expect(settings.decisions).toEqual([{ what: "setting.loosen", secondPerson: true }]);
    await w.seed(A, "project_month", "web", 10 * MICROS); await w.seed(A, "person_month", DEV.pam, 5 * MICROS);
    const fresh = await w.signIn("ada", 5);
    await mustRefuse(w, fresh);
    // Removing the override raises it to the $30 default: refused too. Lowering is not a loosening.
    expect((await w.call(fresh, "PUT", project("web"), put(1, null))).body.error?.code).toBe("SECOND_PERSON_REQUIRED");
    expect((await w.call(fresh, "PUT", project("web"), put(1, 4))).status).toBe(200);
    expect((await w.call(await w.signIn("ada"), "PUT", person(DEV.pam), put(1, 1))).status).toBe(200);
  });

  it("two approvals (minApprovers 2) refuse a raise here too", async () => {
    const w = await withRules([{ what: "setting.loosen", minApprovers: 2 }]);
    await mustRefuse(w, await w.signIn("ada", 5));
  });

  it("rules that let a single admin loosen allow the raise (with the step-up), so the refusal is the rule's and nothing else's", async () => {
    for (const decisions of [[], [{ what: "setting.loosen" }], [{ what: "setting.loosen", secondPerson: false }], [{ what: "setting.loosen", minApprovers: 1 }]]) {
      const w = await withRules(decisions);
      expect((await w.call(await w.signIn("ann"), "PUT", project("web"), put(1, 500))).body.error?.code, JSON.stringify(decisions)).toBe("STEP_UP_REQUIRED");
      expect((await w.call(await w.signIn("ann", 5), "PUT", project("web"), put(1, 500))).status, JSON.stringify(decisions)).toBe(200);
      expect((await w.call(await w.signIn("ann", 5), "PUT", person(DEV.pam), put(1, 500))).status, JSON.stringify(decisions)).toBe(200);
    }
  });

  it("a rule that names deciders is enforced: an admin who is not a decider is refused, a decider may raise", async () => {
    const w = await withRules([{ what: "setting.loosen", deciders: [DEV.ada] }]);
    const ann = await w.signIn("ann", 5);
    for (const [path, version] of [[project("web"), 1], [person(DEV.pam), 1]] as const) {
      const answer = await w.call(ann, "PUT", path, put(version, 500));
      expect(answer.status, path).toBe(403);
      expect(answer.body.error?.message).toBe("Your company's rules don't allow raising a limit.");
    }
    expect((await stored(w, "project_month", "web"))?.monthlyUsdMicros).toBe(10 * MICROS);
    // The decider, with a fresh step-up, may; and lowering needs no decider.
    const ada = await w.signIn("ada", 5);
    expect((await w.call(ada, "PUT", project("web"), put(1, 500))).status).toBe(200);
    expect((await w.call(ann, "PUT", project("web"), put(2, 1))).status).toBe(200);
  });
});

describe("a write is decided on a fresh read and conditional on it", () => {
  it("a stale expectedVersion conflicts (409), for a new override too, and changes nothing", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 30);
    for (const version of [0, 2, 7]) {
      const answer = await w.call(ada, "PUT", project("web"), put(version, 1));
      expect(answer.status, String(version)).toBe(409);
      expect(answer.body.error?.code).toBe("CONFLICT");
    }
    expect((await w.call(ada, "PUT", project("api"), put(3, 1))).status).toBe(409);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 10 * MICROS, version: 1 });
    expect(await stored(w, "project_month", "api")).toBeUndefined();
  });

  it("two admins changing the same limit at once: one wins, the other conflicts", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    const [one, two] = await Promise.all([
      w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 3)),
      w.call(await w.signIn("ann", 30), "PUT", project("web"), put(1, 4)),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((await stored(w, "project_month", "web"))?.version).toBe(2);
    expect(await w.auditRows(A)).toHaveLength(1);
  });

  it("an override changed between the read and the write (the version moved) is refused, not overwritten", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    w.companies.afterRead = () => w.seed(A, "project_month", "web", 2 * MICROS);
    const answer = await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(1, 4));
    expect(answer.status).toBe(409);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 2 * MICROS, version: 2 });
  });

  it("the company default raised between the read and the write refuses a removal that was judged a lowering", async () => {
    const w = await READY(); // project default $30, override $50: removing it LOWERS (no step-up needed)
    await w.seed(A, "project_month", "web", 50 * MICROS);
    w.companies.afterRead = () => w.settings(A, { project: 500 });
    const answer = await w.call(await w.signIn("ada"), "PUT", project("web"), put(1, null));
    expect(answer.status).toBe(409);
    expect(await stored(w, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 50 * MICROS });
  });
});

describe("two companies never meet", () => {
  it("one company's admin writes only its own rows, whatever project name or person id it uses", async () => {
    const w = await READY();
    expect((await w.call(await w.signIn("ada", 30), "PUT", project("web"), put(0, 3))).status).toBe(200);
    expect((await w.call(await w.signIn("bea", 30), "PUT", project("web"), put(0, 4))).status).toBe(200);
    expect((await w.call(await w.signIn("ada", 30), "PUT", person(DEV.zed), put(0, 5))).status).toBe(200);
    expect(await stored(w, "project_month", "web", A)).toMatchObject({ companyId: A, monthlyUsdMicros: 3 * MICROS });
    expect(await stored(w, "project_month", "web", B)).toMatchObject({ companyId: B, monthlyUsdMicros: 4 * MICROS });
    expect(await stored(w, "person_month", DEV.zed, B)).toBeUndefined();
    expect((await w.auditRows(A)).map((r) => r.subject).sort()).toEqual([`spend_limit:person_month:${DEV.zed}`, "spend_limit:project_month:web"]);
    expect((await w.auditRows(B)).map((r) => r.subject)).toEqual(["spend_limit:project_month:web"]);
    // B's version is B's own: A's version (1) does not stand for B's.
    expect((await w.call(await w.signIn("bea", 30), "PUT", project("web"), put(0, 6))).status).toBe(409);
  });

  it("a project Code does not know in the admin's company is refused even when another company has it", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    const answer = await w.call(ada, "PUT", project("billing"), put(0, 1));
    expect(answer.status).toBe(404);
    expect(answer.body.error?.code).toBe("NOT_FOUND");
    expect(await stored(w, "project_month", "billing", A)).toBeUndefined();
    expect(await stored(w, "project_month", "billing", B)).toBeUndefined();
  });
});

describe("fail closed, in fixed words", () => {
  it("a stored limit or company settings that do not read answer 503 and change nothing", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    w.companies.corruptSpendLimit(A, "project_month", "web");
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
    expect(await stored(none, "project_month", "web")).toBeUndefined();
  });

  it("a failed write answers 503 with fixed words; the cause's text and the request never appear in any answer or log line", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    w.companies.breakWith = "table cloud-companies exploded SECRET-CAUSE";
    const answer = await w.call(ada, "PUT", project("web"), put(0, 12.34));
    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
    for (const text of [answer.raw, ...w.logs]) for (const secret of ["SECRET-CAUSE", "exploded", "12.34", "cloud-companies", "web"]) expect(text, secret).not.toContain(secret);
    expect(await stored(w, "project_month", "web")).toBeUndefined();
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
    expect(await stored(out, "project_month", "web")).toBeUndefined();
  });

  it("removing a limit does not ask Code about the project (a deleted project's limit can still be cleaned up)", async () => {
    const w = await READY(); await w.seed(A, "project_month", "gone", 5 * MICROS);
    const ada = await w.signIn("ada", 30);
    const before = w.codeCalls.length;
    expect((await w.call(ada, "PUT", project("gone"), put(1, null))).status).toBe(200);
    expect(w.codeCalls.slice(before)).toEqual([]);
    expect(await stored(w, "project_month", "gone")).toBeUndefined();
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
    expect(await stored(w, "project_month", "web")).toBeUndefined();
    // The ceiling itself and zero are fine.
    expect((await w.call(ada, "PUT", project("web"), put(0, 0))).status).toBe(200);
    expect((await w.call(ada, "PUT", project("api"), put(0, 1_000_000))).status).toBe(200);
  });

  it("at most SPEND_LIMITS_MAX overrides of a kind: the next new one is refused (existing ones still change), and the list says it is partial", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    for (let i = 1; i < SPEND_LIMITS_MAX.person_month; i++) await w.seed(A, "person_month", i.toString(16).padStart(64, "0"), MICROS);
    await w.seed(A, "person_month", DEV.pam, MICROS);
    const refused = await w.call(ada, "PUT", person(DEV.zed), put(0, 1));
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe("There are too many limits of this kind. Remove some first.");
    expect(await stored(w, "person_month", DEV.zed)).toBeUndefined();
    expect((await w.call(ada, "PUT", person(DEV.pam), put(1, 0.5))).status).toBe(200);
    expect((await w.call(ada, "PUT", project("web"), put(0, 1))).status).toBe(200);
    // One more person row beyond the bound (as a race could leave): the list is bounded and partial.
    await w.seed(A, "person_month", DEV.zed, MICROS);
    const listed = await w.call(ada, "GET", PATH);
    expect((listed.body.people as unknown[]).length).toBe(SPEND_LIMITS_MAX.person_month);
    expect(listed.body.partial).toBe(true);
  });
});

describe("every change is audited", () => {
  it("records who, what and which way, in fixed words, in the company's own audit", async () => {
    const w = await READY(); await w.seed(A, "project_month", "web", 10 * MICROS);
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", project("web"), put(1, 25));
    await w.call(ada, "PUT", project("web"), put(2, 5));
    await w.call(ada, "PUT", project("web"), put(3, null));
    await w.call(ada, "PUT", person(DEV.pam), put(0, 2));
    const rows = await w.auditRows(A);
    expect(rows.map((r) => [r.subject, r.detail, r.outcome, r.actor.developerId, r.via, r.project]).sort()).toEqual([
      [`spend_limit:person_month:${DEV.pam}`, "lowered from=20000000 to=2000000", "ok", DEV.ada, "web", undefined],
      ["spend_limit:project_month:web", "lowered from=25000000 to=5000000", "ok", DEV.ada, "web", "web"],
      ["spend_limit:project_month:web", "raised from=10000000 to=25000000", "ok", DEV.ada, "web", "web"],
      // The override was $5 and the default is $30: removing it RAISED the limit, and the record says so.
      ["spend_limit:project_month:web", "removed_raised from=5000000 to=30000000", "ok", DEV.ada, "web", "web"],
    ].sort());
    expect(await w.auditRows(B)).toEqual([]);
  });

  it("says whether a removal raised or lowered the limit, and writes 'none' for no limit", async () => {
    const w = await READY(); // project default $30
    await w.seed(A, "project_month", "web", 50 * MICROS); await w.seed(A, "project_month", "api", 10 * MICROS);
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", project("web"), put(1, null));
    await w.call(ada, "PUT", project("api"), put(1, null));
    const open = await READY(); await open.settings(A, { project: null });
    await open.seed(A, "project_month", "web", 7 * MICROS);
    await open.call(await open.signIn("ada", 30), "PUT", project("web"), put(1, null));
    expect((await w.auditRows(A)).map((r) => [r.subject, r.detail]).sort()).toEqual([
      ["spend_limit:project_month:api", "removed_raised from=10000000 to=30000000"],
      ["spend_limit:project_month:web", "removed_lowered from=50000000 to=30000000"],
    ]);
    expect((await open.auditRows(A)).map((r) => r.detail)).toEqual(["removed_raised from=7000000 to=none"]);
  });

  it("a refused change leaves no record, and a failed audit write does not undo the change", async () => {
    const w = await READY(); const ada = await w.signIn("ada");
    await w.seed(A, "project_month", "web", 10 * MICROS);
    await w.call(ada, "PUT", project("web"), put(1, 25));
    expect(await w.auditRows(A)).toEqual([]);
    const failing = world(); await failing.settings(A, {});
    (failing.audit as unknown as { append: () => Promise<never> }).append = () => Promise.reject(new Error("audit store down"));
    const answer = await failing.call(await failing.signIn("ada", 30), "PUT", project("web"), put(0, 2));
    expect(answer.status).toBe(200);
    expect(await stored(failing, "project_month", "web")).toMatchObject({ monthlyUsdMicros: 2 * MICROS });
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

// A new kind is an entry in SPEND_LIMIT_KINDS; this walks every entry through the routes the same way (the ids come from the kind's scope).
describe("every kind in the table, through the routes", () => {
  const ID = { project: "api", person: DEV.zed, company: A } as const;
  for (const def of SPEND_LIMIT_KINDS) {
    const id = ID[def.scope];
    const path = `${PATH}/${def.segment}/${id}`;
    describe(`kind ${def.kind}`, () => {
      it("has its PUT route (strict id), lists its rows and bound under its own members, and keeps two companies apart", async () => {
        const w = await READY(); const ada = await w.signIn("ada", 30);
        expect((await w.call(ada, "PUT", path, put(0, 1))).status).toBe(200);
        expect((await w.call(ada, "PUT", `${PATH}/${def.segment}/${"Z".repeat(3)}`, put(0, 1))).status).toBe(501);
        const mine = await w.call(ada, "GET", PATH);
        expect((mine.body[def.listKey] as Array<{ id: string; monthlyUsd: number }>).map((r) => [r.id, r.monthlyUsd])).toEqual([[id, 1]]);
        expect((mine.body.max as Record<string, number>)[def.listKey]).toBe(def.max);
        // Every other kind's list is empty, and company B sees none of it.
        for (const other of SPEND_LIMIT_KINDS.filter((d) => d.kind !== def.kind)) expect(mine.body[other.listKey]).toEqual([]);
        const theirs = await w.call(await w.signIn("bea", 30), "GET", PATH);
        expect(theirs.body[def.listKey]).toEqual([]);
        expect(await w.companies.spendLimit(B, def.kind, id)).toBeUndefined();
        expect((await w.companies.spendLimit(A, def.kind, id))?.companyId).toBe(A);
      });

      it("needs a step-up to raise and none to lower, and a plain member is refused", async () => {
        const w = await READY();
        const bare = await w.signIn("ada");
        expect((await w.call(bare, "PUT", path, put(0, 1))).status).toBe(200);
        expect((await w.call(bare, "PUT", path, put(1, 1000))).body.error?.code).toBe("STEP_UP_REQUIRED");
        expect((await w.companies.spendLimit(A, def.kind, id))?.monthlyUsdMicros).toBe(MICROS);
        expect((await w.call(await w.signIn("ada", 30), "PUT", path, put(1, 1000))).status).toBe(200);
        expect((await w.call(bare, "PUT", path, put(2, 2))).status).toBe(200);
        const pam = await w.signIn("pam", 30);
        expect((await w.call(pam, "GET", PATH)).status).toBe(403);
        expect((await w.call(pam, "PUT", path, put(3, 1))).status).toBe(403);
      });

      it("is audited under its own name, and an item that does not read answers 503 and changes nothing", async () => {
        const w = await READY(); const ada = await w.signIn("ada", 30);
        await w.call(ada, "PUT", path, put(0, 3));
        expect((await w.auditRows(A)).map((r) => r.subject)).toEqual([`spend_limit:${def.kind}:${id}`]);
        w.companies.corruptSpendLimit(A, def.kind, id);
        expect((await w.call(ada, "GET", PATH)).status).toBe(503);
        expect((await w.call(ada, "PUT", path, put(1, 1))).status).toBe(503);
        expect((await w.call(ada, "PUT", path, put(1, null))).status).toBe(503);
      });

      it("takes its default from the company's budgets when no override exists (a raise is judged against it)", async () => {
        const w = await READY(); // project default $30, member default $20, task $2
        const fallback = def.defaultOf({ companyMonthlyUsdMicros: 100 * MICROS, memberMonthlyUsdMicros: 20 * MICROS, projectMonthlyUsdMicros: 30 * MICROS, taskUsdMicros: 2 * MICROS, learningMonthlyUsdMicros: 1 });
        const bare = await w.signIn("ada");
        if (fallback === null) { expect((await w.call(bare, "PUT", path, put(0, 999_999))).status).toBe(200); return; }
        expect((await w.call(bare, "PUT", path, put(0, fallback / MICROS + 1))).body.error?.code).toBe("STEP_UP_REQUIRED");
        expect((await w.call(bare, "PUT", path, put(0, fallback / MICROS))).status).toBe(200);
      });
    });
  }
});

// Lead 4 L4-E: the two gateway-enforced kinds (nightly upkeep per project, answers per company).
describe("the upkeep and answers limits", () => {
  const upkeep = (id: string) => `${PATH}/upkeep/${id}`;
  const answers = (id: string) => `${PATH}/answers/${id}`;
  it("the answer names each default (upkeep $25, answers $20) beside the company's budgets, and the company's own id", async () => {
    const w = await READY();
    const body = (await w.call(await w.signIn("ada", 30), "GET", PATH)).body as { companyId: string; defaults: Record<string, number | null>; max: Record<string, number> };
    expect(body.companyId).toBe(A);
    expect(body.defaults).toMatchObject({ upkeepMonthlyUsd: 25, answersMonthlyUsd: 20 });
    expect(body.max).toMatchObject({ upkeep: 200, answers: 1 });
  });
  it("an answers limit is the caller's own company's: another company's id (or any id) in the path is 404 and writes nothing, set or removed", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", answers(B), put(0, 1))).status).toBe(404);
    expect((await w.call(ada, "PUT", answers(B), put(0, null))).status).toBe(404);
    expect(await w.companies.spendLimit(B, "answers_month", B)).toBeUndefined();
    expect(await w.companies.spendLimit(A, "answers_month", B)).toBeUndefined();
    expect((await w.call(ada, "PUT", answers(A), put(0, 5))).status).toBe(200);
    expect((await w.companies.spendLimit(A, "answers_month", A))?.monthlyUsdMicros).toBe(5 * MICROS);
    // A second one cannot be added under another id (the bound is one), and company B sees none of A's.
    expect((await w.call(await w.signIn("bea", 30), "GET", PATH)).body.answers).toEqual([]);
  });
  it("$0 is allowed for both (no upkeep spend, no answers), lowering needs no step-up, and removing returns to the default", async () => {
    const w = await READY(); const bare = await w.signIn("ada");
    expect((await w.call(bare, "PUT", upkeep("api"), put(0, 0))).status).toBe(200);
    expect((await w.call(bare, "PUT", answers(A), put(0, 0))).status).toBe(200);
    expect((await w.companies.spendLimit(A, "upkeep_month", "api"))?.monthlyUsdMicros).toBe(0);
    // Raising back above the default needs the fresh step-up; removing (back to the default, $25) is a raise from $0, so it needs it too.
    expect((await w.call(bare, "PUT", upkeep("api"), put(1, null))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(await w.signIn("ada", 30), "PUT", upkeep("api"), put(1, null))).status).toBe(200);
    expect(await w.companies.spendLimit(A, "upkeep_month", "api")).toBeUndefined();
  });
  it("an upkeep limit names a project Code knows, and a project's upkeep and project limits are separate items", async () => {
    const w = await READY(); const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", upkeep("nosuchproject"), put(0, 1))).status).toBe(404);
    expect((await w.call(ada, "PUT", upkeep("api"), put(0, 7))).status).toBe(200);
    expect((await w.call(ada, "PUT", project("api"), put(0, 3))).status).toBe(200);
    expect((await w.companies.spendLimit(A, "upkeep_month", "api"))?.monthlyUsdMicros).toBe(7 * MICROS);
    expect((await w.companies.spendLimit(A, "project_month", "api"))?.monthlyUsdMicros).toBe(3 * MICROS);
  });
});


it("adds the company's optional gateway provisional total to the existing admin limits read", async () => {
  const reads: string[] = [];
  const w = world({ provisional: async (company, month) => { reads.push(`${company}/${month}`); return company === A ? 42 : 7; } });
  await w.settings(A, {}); await w.settings(B, {});
  expect((await w.call(await w.signIn("ada"), "GET", PATH)).body["provisionalMicros"]).toBe(42);
  expect((await w.call(await w.signIn("bea"), "GET", PATH)).body["provisionalMicros"]).toBe(7);
  expect((await w.call(await w.signIn("pam"), "GET", PATH)).status).toBe(403);
  expect(reads).toEqual([`${A}/2026-11`, `${B}/2026-11`]);
  const legacy = await READY();
  expect((await legacy.call(await legacy.signIn("ada"), "GET", PATH)).body).not.toHaveProperty("provisionalMicros");
  const broken = world({ provisional: async () => { throw new Error("private details"); } });
  await broken.settings(A, {});
  const refused = await broken.call(await broken.signIn("ada"), "GET", PATH);
  expect(refused.status).toBe(200);
  expect(refused.body).toHaveProperty("defaults");
  expect(refused.body).not.toHaveProperty("provisionalMicros");
  expect(refused.raw).not.toContain("private details");
});
