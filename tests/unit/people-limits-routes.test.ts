// Lead 4 slice A6 (cost report design, Feature A6 and decision D2): GET /org/people-limits, the admin's "People and limits" read. Each current member's
// spend this month against their limit (their own override, else the company default), sorted by NAME only, optionally narrowed to one project's people.
// Company owners and admins only (the company and the person come from Code's access check, never from the request). No quality number, no ranking, no
// merged count: the answer has no field to build one from. Money is whole cents. Fixed words that never echo what the request or a lower layer said.
import { describe, expect, it } from "vitest";
import { CORE_TASK_ROUTES } from "../fixtures/code-core-task-routes.js";
import {
  CodeClient, DynamoGatewayMeterReader, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, PEOPLE_LIMITS_WORDS, createCloudHandler, defaultCompanySettings,
  type CloudRequest, type PersonSpendReader, type SpendLimitKind,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const DEV = { ada: "d".repeat(64), ann: "f".repeat(64), pam: "a".repeat(64), bea: "e".repeat(64), zed: "9".repeat(64), mo: "1".repeat(64), al: "2".repeat(64) } as const;
type Role = "owner" | "admin" | "member";
interface Person { developerId: string; name: string; administrator: boolean; companyId: string; companyRole: Role }
const PEOPLE: Record<string, Person> = {
  ada: { developerId: DEV.ada, name: "Ada", administrator: false, companyId: A, companyRole: "owner" },
  ann: { developerId: DEV.ann, name: "Ann", administrator: false, companyId: A, companyRole: "admin" },
  pam: { developerId: DEV.pam, name: "Pam", administrator: false, companyId: A, companyRole: "member" },
  ins: { developerId: "8".repeat(64), name: "Ines", administrator: true, companyId: A, companyRole: "member" },
  bea: { developerId: DEV.bea, name: "Bea", administrator: false, companyId: B, companyRole: "owner" },
  nomad: { developerId: "6".repeat(64), name: "Nomad", administrator: true, companyId: "not-a-company", companyRole: "owner" },
};
const GONE = "7".repeat(64);
/** Company A lists people out of name order on purpose (Zed first, Al last): neither the list order nor the spend order is the answer's order. */
const LISTED: Record<string, Array<Record<string, unknown>>> = {
  [A]: [
    { personId: DEV.zed, companyId: A, name: "Zed", role: "member" },
    ...["ada", "ann", "pam", "ins"].map((who) => ({ personId: PEOPLE[who]!.developerId, companyId: A, name: PEOPLE[who]!.name, role: PEOPLE[who]!.companyRole })),
    { personId: DEV.mo, companyId: A, name: "mo", role: "member" },
    { personId: GONE, companyId: A, name: "Gone", role: "member", revokedAt: "2026-11-01T00:00:00.000Z" },
    { personId: DEV.al, companyId: A, name: "Al", role: "member" },
  ],
  [B]: [{ personId: DEV.bea, companyId: B, name: "Bea", role: "owner" }, { personId: DEV.pam, companyId: B, name: "Pam of B", role: "member" }],
};
/** Who Code lists on each project (the project "web" of A includes DEV.bea, who is not in A: Code would not, but the answer must not trust it). */
const PROJECT_PEOPLE: Record<string, Record<string, string[]>> = {
  [A]: { web: [DEV.ada, DEV.pam, DEV.al, DEV.bea], api: [DEV.zed], empty: [] },
  [B]: { web: [DEV.bea], billing: [DEV.bea] },
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const MICROS = 1_000_000;

/** The gateway's person-month rows as the reader returns them. Every ask is recorded. */
class FakeSpend implements PersonSpendReader {
  readonly rows = new Map<string, number>();
  readonly asked: Array<{ companyId: string; month: string; personIds: string[] }> = [];
  breakWith: string | undefined;
  set(companyId: string, month: string, personId: string, micros: number) { this.rows.set(`${companyId}|${month}|${personId}`, micros); }
  async monthSpend(companyId: string, month: string, personIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    this.asked.push({ companyId, month, personIds: [...personIds] });
    if (this.breakWith !== undefined) throw new Error(this.breakWith);
    const found = new Map<string, number>();
    for (const id of personIds) { const row = this.rows.get(`${companyId}|${month}|${id}`); if (row !== undefined) found.set(id, row); }
    return found;
  }
}

function world(options: { company?: boolean; spend?: boolean; members?: "ok" | "outage" | "foreign" | "garbled" | "pages"; project?: "ok" | "outage" | "garbled" | "refused" } = {}) {
  const clock = { at: START }; let tokens = 0;
  const nowS = () => Math.floor(clock.at / 1000);
  const byToken = new Map<string, Person>();
  const codeCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const person = byToken.get(((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return new Response("{}", { status: 401 });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/dev/access") {
      return reply(200, { developerId: person.developerId, displayName: person.name, administrator: person.administrator, companyId: person.companyId, companyRole: person.companyRole, projects: Object.keys(PROJECT_PEOPLE[person.companyId] ?? {}).map((name) => ({ name, access: "developer" })), notices: [] });
    }
    if (url.pathname === "/v1/dev/company/members") {
      codeCalls.push(`GET ${url.pathname}`);
      if (options.members === "outage") return reply(500, { error: { code: "X", message: "secret outage text" } });
      if (options.members === "garbled") return reply(200, { members: "nope", more: false });
      const all = options.members === "foreign" ? [{ ...LISTED[person.companyId]![0]!, companyId: person.companyId === A ? B : A }] : LISTED[person.companyId] ?? [];
      const size = Math.min(options.members === "pages" ? 2 : 100, Number(url.searchParams.get("limit") ?? "100"));
      const from = Number(url.searchParams.get("cursor")?.replace(/^c/u, "") ?? "0");
      const page = all.slice(from, from + size);
      return reply(200, { members: page, more: from + size < all.length, ...(from + size < all.length ? { cursor: `c${String(from + size)}` } : {}) });
    }
    const members = /^\/v1\/dev\/client\/projects\/([^/]+)\/members$/u.exec(url.pathname);
    if (members !== null) {
      codeCalls.push(`GET ${url.pathname}`);
      if (options.project === "outage") return reply(500, { error: { code: "X", message: "secret outage text" } });
      // Code #1022's real refusal of this person for the project's members (tests/fixtures/code-core-task-routes.json `members`).
      if (options.project === "refused") return reply(CORE_TASK_ROUTES.members.memberRefused.status, CORE_TASK_ROUTES.members.memberRefused.body);
      const who = PROJECT_PEOPLE[person.companyId]?.[decodeURIComponent(members[1]!)];
      if (who === undefined) return reply(404, { error: { code: "NOT_FOUND", message: "no" } });
      if (options.project === "garbled") return reply(200, { members: "nope" });
      return reply(200, { members: who.map((developerId) => ({ developerId, name: "x", role: "developer" })) });
    }
    return reply(404, {});
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const companies = new LocalCompanyStore();
  const spend = new FakeSpend();
  const logs: string[] = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(clock.at), log: (event) => { logs.push(JSON.stringify(event)); }, audit: new LocalCloudAuditStore(undefined, {}),
    ...(options.company === false ? {} : { company: { store: companies, ...(options.spend === false ? {} : { peopleSpend: spend }) } }),
  });
  const signIn = async (who: string) => {
    const person = PEOPLE[who]!; tokens += 1;
    const token = `${b64({ alg: "RS256", typ: "JWT", kid: "code" })}.${b64({ sub: person.developerId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.developerId, displayName: person.name, administrator: person.administrator, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock.at).toISOString() });
    return cookie;
  };
  const call = async (cookie: string | undefined, path: string, extraHeaders: Record<string, string> = {}) => {
    const [pathname, search = ""] = path.split("?");
    const request: CloudRequest = { method: "GET", path: `/v1/web${pathname}`, query: new URLSearchParams(search), headers: { ...(cookie === undefined ? {} : { cookie: `rovara_cloud_session=${cookie}` }), "content-type": "application/json", ...extraHeaders } };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Body, raw: answer.body };
  };
  const settings = async (companyId: string, member: number | null = 20) => {
    const s = defaultCompanySettings();
    s.decisions = [];
    s.budgets = { companyMonthlyUsdMicros: 100 * MICROS, memberMonthlyUsdMicros: member === null ? null : member * MICROS, projectMonthlyUsdMicros: 30 * MICROS, taskUsdMicros: 2 * MICROS, learningMonthlyUsdMicros: 1 };
    const current = await companies.settings(companyId);
    await companies.putSettings(companyId, s, current?.version ?? 0, DEV.ada, new Date(clock.at).toISOString());
  };
  const override = async (companyId: string, personId: string, micros: number, kind: SpendLimitKind = "person_month") => {
    const settingsVersion = (await companies.settings(companyId))?.version ?? 0;
    const have = await companies.spendLimit(companyId, kind, personId);
    await companies.putSpendLimit({ companyId, kind, id: personId, monthlyUsdMicros: micros, updatedAt: new Date(clock.at).toISOString(), updatedBy: DEV.ada }, { override: have === undefined ? undefined : { version: have.version, monthlyUsdMicros: have.monthlyUsdMicros }, settingsVersion });
  };
  return { companies, logs, codeCalls, clock, spend, signIn, call, settings, override };
}
interface PersonRow { developerId: string; name: string; spentCents: number; limitCents: number | null; limitSource: string }
interface Body { error?: { code: string; message: string }; month?: string; project?: string; projects?: string[]; people?: PersonRow[]; [key: string]: unknown }
const PATH = "/org/people-limits";
const READY = async (options: Parameters<typeof world>[0] = {}) => { const w = world(options); await w.settings(A); await w.settings(B); return w; };
const names = (body: Body) => (body["people"] as Array<{ name: string }>).map((row) => row.name);
const ROW_KEYS = ["developerId", "limitCents", "limitSource", "name", "spentCents"];

describe("who may read People and limits", () => {
  it("a company owner and a company admin read it; a plain member, an install administrator who is only a member, and a person with no company get a fixed refusal", async () => {
    const w = await READY();
    for (const who of ["ada", "ann"]) expect((await w.call(await w.signIn(who), PATH)).status, who).toBe(200);
    for (const who of ["pam", "ins"]) {
      const answer = await w.call(await w.signIn(who), PATH);
      expect(answer.status, who).toBe(403);
      expect(answer.body.error).toEqual({ code: "FORBIDDEN", message: PEOPLE_LIMITS_WORDS.forbidden.body.error.message });
      expect(answer.raw).not.toMatch(/Zed|Ada|spentCents/u);
    }
    expect((await w.call(await w.signIn("nomad"), PATH)).body.error?.code).toBe("NO_COMPANY");
    // Refused callers never reach the gateway's meter.
    expect(w.spend.asked.length).toBe(2);
  });
  it("needs a signed-in session", async () => {
    const w = await READY();
    expect((await w.call(undefined, PATH)).status).toBe(401);
    expect(w.spend.asked).toEqual([]);
  });
  it("answers 501 to an admin, and 403 to a member, when this Cloud has no company backend or no gateway meter reader (nothing of the feature in the answer)", async () => {
    const off = world({ company: false }); const none = world({ spend: false });
    await none.settings(A);
    for (const w of [off, none]) {
      const answer = await w.call(await w.signIn("ada"), PATH);
      expect(answer.status).toBe(501);
      expect(answer.body.error?.code).toBe("NOT_ON_CODE_YET");
      expect(answer.raw).not.toMatch(/Zed|spentCents|people/u);
    }
    // A plain member is refused as a member on that path too: they learn nothing, not even that the feature is off.
    for (const w of [off, none]) {
      const answer = await w.call(await w.signIn("pam"), PATH);
      expect(answer.status).toBe(403);
      expect(answer.body.error?.code).toBe("FORBIDDEN");
    }
  });
  it("the company comes only from Code's access check: a company id, an organisation header or a person in the query is refused, not used", async () => {
    const w = await READY();
    const cookie = await w.signIn("ada");
    for (const query of [`company=${B}`, `org=${B}`, `companyId=${B}`, `person=${DEV.bea}`, `month=2026-01`, "project=web&project=api", "limit=5"]) {
      const answer = await w.call(cookie, `${PATH}?${query}`);
      expect(answer.status, query).toBe(400);
      expect(answer.body.error?.code).toBe("CONFIG_INVALID");
    }
    const header = await w.call(cookie, PATH, { "x-rovara-company": B, "x-company-id": B, "x-org-id": B });
    expect(header.status).toBe(200);
    expect(w.spend.asked.every((ask) => ask.companyId === A)).toBe(true);
    expect(JSON.stringify(header.body)).not.toContain("Bea");
  });
});

describe("the rows", () => {
  it("lists every current member by name only (case-insensitively), not removed people, not in the order of Code's list or of the spend", async () => {
    const w = await READY();
    // Spend runs opposite to the names: the biggest spender is last by name.
    w.spend.set(A, "2026-11", DEV.al, 1 * MICROS); w.spend.set(A, "2026-11", DEV.zed, 19 * MICROS); w.spend.set(A, "2026-11", DEV.ada, 5 * MICROS);
    const answer = await w.call(await w.signIn("ada"), PATH);
    expect(names(answer.body)).toEqual(["Ada", "Al", "Ann", "Ines", "mo", "Pam", "Zed"]);
    expect(answer.raw).not.toContain("Gone");
    expect(answer.body["month"]).toBe("2026-11");
  });
  it("each row has exactly these five fields: no merged count, task count, speed, quality, rank or total, here or anywhere in the answer", async () => {
    const w = await READY(); w.spend.set(A, "2026-11", DEV.ada, 3 * MICROS);
    const answer = await w.call(await w.signIn("ada"), PATH);
    for (const row of answer.body["people"]!) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(Object.keys(answer.body).sort()).toEqual(["month", "people", "projects"]);
    expect(answer.raw).not.toMatch(/merged|tasks|speed|quality|rank|score|total|count|email|role/iu);
  });
  it("spend and limits are whole cents: spend rounds up (never understated), a limit rounds down, none are fractions", async () => {
    const w = await READY();
    w.spend.set(A, "2026-11", DEV.ada, 1_234_567); w.spend.set(A, "2026-11", DEV.ann, 10_000); w.spend.set(A, "2026-11", DEV.pam, 1);
    await w.override(A, DEV.ann, 12_500_000);
    const rows = Object.fromEntries(((await w.call(await w.signIn("ada"), PATH)).body["people"] as PersonRow[]).map((row) => [row["name"], row]));
    expect(rows["Ada"]).toMatchObject({ spentCents: 124, limitCents: 2000, limitSource: "company_default" });
    expect(rows["Ann"]).toMatchObject({ spentCents: 1, limitCents: 1250, limitSource: "own" });
    expect(rows["Pam"]).toMatchObject({ spentCents: 1 });
    expect(rows["Zed"]).toMatchObject({ spentCents: 0 });
    for (const row of Object.values(rows)) { expect(Number.isInteger(row["spentCents"])).toBe(true); expect(row["limitCents"] === null || Number.isInteger(row["limitCents"])).toBe(true); }
    // A default that is not a whole number of cents is cut down to a cent.
    const odd = await READY();
    const s = defaultCompanySettings(); s.decisions = []; s.budgets = { companyMonthlyUsdMicros: 100 * MICROS, memberMonthlyUsdMicros: 20_009_999, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: 1 };
    await odd.companies.putSettings(A, s, (await odd.companies.settings(A))!.version, DEV.ada, new Date(odd.clock.at).toISOString());
    expect(((await odd.call(await odd.signIn("ada"), PATH)).body["people"] as PersonRow[])[0]!["limitCents"]).toBe(2000);
  });
  it("a person's own override wins over the company default; no default and no override says so; an override of zero is a limit of zero", async () => {
    const w = await READY();
    await w.override(A, DEV.zed, 0);
    const rows = Object.fromEntries(((await w.call(await w.signIn("ada"), PATH)).body["people"] as PersonRow[]).map((row) => [row["name"], row]));
    expect(rows["Zed"]).toMatchObject({ limitCents: 0, limitSource: "own" });
    expect(rows["Pam"]).toMatchObject({ limitCents: 2000, limitSource: "company_default" });
    const none = await READY(); await none.settings(A, null); await none.override(A, DEV.pam, 7 * MICROS);
    const bare = Object.fromEntries(((await none.call(await none.signIn("ada"), PATH)).body["people"] as PersonRow[]).map((row) => [row["name"], row]));
    expect(bare["Pam"]).toMatchObject({ limitCents: 700, limitSource: "own" });
    expect(bare["Zed"]).toMatchObject({ limitCents: null, limitSource: "none" });
  });
  it("a project override (a different kind) never becomes a person's limit", async () => {
    const w = await READY(); await w.override(A, "web", 1 * MICROS, "project_month");
    const rows = (await w.call(await w.signIn("ada"), PATH)).body["people"] as PersonRow[];
    expect(rows.every((row) => row["limitSource"] === "company_default")).toBe(true);
  });
  it("reads the month the clock is in (UTC), and a new month starts from the new month's rows", async () => {
    const w = await READY();
    w.spend.set(A, "2026-11", DEV.ada, 2 * MICROS); w.spend.set(A, "2026-12", DEV.ada, 9 * MICROS);
    w.clock.at = Date.parse("2026-11-30T23:59:59.000Z");
    expect(((await w.call(await w.signIn("ada"), PATH)).body["people"] as PersonRow[])[0]!["spentCents"]).toBe(200);
    w.clock.at = Date.parse("2026-12-01T00:00:00.000Z");
    const next = await w.call(await w.signIn("ada"), PATH);
    expect(next.body["month"]).toBe("2026-12");
    expect((next.body["people"] as PersonRow[])[0]!["spentCents"]).toBe(900);
  });
  it("reads every page of Code's member list", async () => {
    const w = world({ members: "pages" }); await w.settings(A);
    expect(names((await w.call(await w.signIn("ada"), PATH)).body)).toEqual(["Ada", "Al", "Ann", "Ines", "mo", "Pam", "Zed"]);
  });
});

describe("the project filter", () => {
  it("lists the projects the person may use, and narrows the people to that project's, still by name", async () => {
    const w = await READY(); w.spend.set(A, "2026-11", DEV.pam, 4 * MICROS);
    const all = await w.call(await w.signIn("ada"), PATH);
    expect(all.body["projects"]).toEqual(["api", "empty", "web"]);
    const web = await w.call(await w.signIn("ada"), `${PATH}?project=web`);
    // DEV.bea is on A's web project in Code's answer but is not a member of A: she is never shown, and never asked of the meter.
    expect(names(web.body)).toEqual(["Ada", "Al", "Pam"]);
    expect(web.raw).not.toContain("Bea");
    expect(w.spend.asked.at(-1)!.personIds.sort()).toEqual([DEV.ada, DEV.al, DEV.pam].sort());
    expect(Object.keys(web.body).sort()).toEqual(["month", "people", "project", "projects"]);
    expect(web.body["project"]).toBe("web");
  });
  it("says the person's spend is their whole month, not the project's: the rows are the same ones with or without the filter", async () => {
    const w = await READY(); w.spend.set(A, "2026-11", DEV.pam, 4 * MICROS);
    const cookie = await w.signIn("ada");
    const whole = ((await w.call(cookie, PATH)).body["people"] as PersonRow[]).find((row) => row["name"] === "Pam");
    const narrow = ((await w.call(cookie, `${PATH}?project=web`)).body["people"] as PersonRow[]).find((row) => row["name"] === "Pam");
    expect(narrow).toEqual(whole);
  });
  it("a project with nobody on it is an empty list, not an error", async () => {
    const w = await READY();
    const answer = await w.call(await w.signIn("ada"), `${PATH}?project=empty`);
    expect(answer.status).toBe(200);
    expect(answer.body["people"]).toEqual([]);
  });
  it("a project Code does not know, or one that belongs to another company, is one fixed not-found that echoes nothing; a bad name never reaches Code", async () => {
    const w = await READY();
    const cookie = await w.signIn("ada");
    for (const project of ["billing", "nope"]) {
      const answer = await w.call(cookie, `${PATH}?project=${project}`);
      expect(answer.status, project).toBe(404);
      expect(answer.body.error).toEqual({ code: "NOT_FOUND", message: PEOPLE_LIMITS_WORDS.projectNotFound.body.error.message });
      expect(answer.raw).not.toContain(project);
    }
    const before = w.codeCalls.length;
    for (const project of ["..%2Fx", "Web", "web%20x", "", "a".repeat(64)]) expect((await w.call(cookie, `${PATH}?project=${project}`)).status, project).toBe(400);
    expect(w.codeCalls.length).toBe(before);
  });
});

describe("Code's own refusal of a project's members (Code #1022)", () => {
  it("is said in Code's fixed words as a refusal, never as 'that project doesn't exist'; nothing else of the answer passes", async () => {
    const w = await READY({ project: "refused" });
    const answer = await w.call(await w.signIn("ada"), `${PATH}?project=web`);
    expect(CORE_TASK_ROUTES.members.memberRefused.body).toEqual({ error: { code: "FORBIDDEN", message: "Only a company owner or admin, or the project's admin, can see and change its members." } });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toEqual(PEOPLE_LIMITS_WORDS.membersNotAllowed.body.error);
    expect(answer.body.error).toEqual(CORE_TASK_ROUTES.members.memberRefused.body["error"]);
    expect(answer.body.error?.message).not.toBe(PEOPLE_LIMITS_WORDS.projectNotFound.body.error.message);
  });
});

describe("two companies never meet", () => {
  it("each company's admin sees only their own people, their own overrides and their own meter rows, even for the same person id", async () => {
    const w = await READY();
    // DEV.pam is a member of both companies (a test fixture; in life ids are not shared): the numbers must come from the caller's company only.
    w.spend.set(A, "2026-11", DEV.pam, 4 * MICROS); w.spend.set(B, "2026-11", DEV.pam, 77 * MICROS); w.spend.set(B, "2026-11", DEV.bea, 8 * MICROS);
    await w.override(A, DEV.pam, 6 * MICROS); await w.override(B, DEV.pam, 66 * MICROS);
    const a = await w.call(await w.signIn("ada"), PATH);
    const b = await w.call(await w.signIn("bea"), PATH);
    expect(names(b.body)).toEqual(["Bea", "Pam of B"]);
    expect((a.body["people"] as PersonRow[]).find((row) => row["developerId"] === DEV.pam)).toMatchObject({ name: "Pam", spentCents: 400, limitCents: 600 });
    expect((b.body["people"] as PersonRow[]).find((row) => row["developerId"] === DEV.pam)).toMatchObject({ name: "Pam of B", spentCents: 7700, limitCents: 6600 });
    expect(a.raw).not.toMatch(/Bea|Pam of B|7700|6600/u);
    expect(b.raw).not.toMatch(/Zed|Ada|"Pam"/u);
    expect(w.spend.asked.map((ask) => ask.companyId)).toEqual([A, B]);
    expect(w.spend.asked[0]!.personIds).not.toContain(DEV.bea);
  });
  it("a member row Code files under another company refuses the whole list (never a part of it)", async () => {
    const w = world({ members: "foreign" }); await w.settings(A);
    const answer = await w.call(await w.signIn("ada"), PATH);
    expect(answer.status).toBe(503);
    expect(answer.raw).not.toMatch(/Zed|spentCents/u);
    expect(w.spend.asked).toEqual([]);
  });
});

describe("fail closed, in fixed words", () => {
  const leaks = (raw: string) => expect(raw).not.toMatch(/secret|outage|meter text|store text|stack/iu);
  it("Code's member list failing or garbled refuses the whole answer", async () => {
    for (const members of ["outage", "garbled"] as const) {
      const w = world({ members }); await w.settings(A);
      const answer = await w.call(await w.signIn("ada"), PATH);
      expect(answer.status, members).toBe(503);
      expect(answer.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
      leaks(answer.raw);
    }
  });
  it("Code's project list failing or garbled refuses the whole answer, never shows the unfiltered list", async () => {
    for (const project of ["outage", "garbled"] as const) {
      const w = world({ project }); await w.settings(A);
      const answer = await w.call(await w.signIn("ada"), `${PATH}?project=web`);
      expect(answer.status, project).toBe(503);
      expect(answer.raw).not.toMatch(/Zed|spentCents/u);
      leaks(answer.raw);
    }
  });
  it("a meter that cannot be read refuses the whole answer: no row is drawn as $0, and nothing the meter said reaches the answer", async () => {
    const w = await READY(); w.spend.breakWith = "secret meter text";
    const answer = await w.call(await w.signIn("ada"), PATH);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: PEOPLE_LIMITS_WORDS.spendUnreadable.body.error.message });
    leaks(answer.raw);
    expect(answer.raw).not.toMatch(/Zed|spentCents/u);
  });
  it("settings that do not read, or more overrides than the list holds, refuse the whole answer (a limit is never guessed)", async () => {
    // A saved row that is another company's (or does not validate) is not read as settings.
    const none = await READY();
    const realSettings = none.companies.settings.bind(none.companies);
    none.companies.settings = async (companyId: string) => { const row = await realSettings(companyId); return row === undefined ? row : { ...row, companyId: B }; };
    expect((await none.call(await none.signIn("ada"), PATH)).status).toBe(503);
    // No saved settings at all is the company default (no limit), not a refusal.
    const fresh = world(); expect((await fresh.call(await fresh.signIn("ada"), PATH)).status).toBe(200);
    const w = await READY();
    const real = w.companies.spendLimits.bind(w.companies);
    w.companies.spendLimits = async (companyId: string) => ({ ...(await real(companyId)), partial: true });
    expect((await w.call(await w.signIn("ada"), PATH)).status).toBe(503);
    const broken = await READY();
    broken.companies.spendLimits = async () => { throw new Error("secret store text"); };
    const answer = await broken.call(await broken.signIn("ada"), PATH);
    expect(answer.status).toBe(503);
    leaks(answer.raw);
  });
  it("an override stored under another company's name is not used", async () => {
    const w = await READY();
    const real = w.companies.spendLimits.bind(w.companies);
    w.companies.spendLimits = async (companyId: string) => {
      const list = await real(companyId);
      return { ...list, limits: { ...list.limits, person_month: [{ companyId: B, kind: "person_month" as const, id: DEV.pam, monthlyUsdMicros: 1, version: 1, updatedAt: "x", updatedBy: "y" }] } };
    };
    expect((await w.call(await w.signIn("ada"), PATH)).status).toBe(503);
  });
  it("a meter that answers for people it was not asked about does not add them to the answer", async () => {
    const w = await READY();
    w.spend.monthSpend = async () => new Map([[DEV.pam, 5 * MICROS], [DEV.bea, 99 * MICROS], ["not-an-id", 1]]);
    const answer = await w.call(await w.signIn("ada"), PATH);
    expect(answer.status).toBe(200);
    expect(answer.raw).not.toContain("Bea");
    expect((answer.body["people"] as PersonRow[]).find((row) => row["name"] === "Pam")).toMatchObject({ spentCents: 500 });
  });
  it("a meter amount that is not a whole non-negative number refuses the whole answer", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const w = await READY();
      w.spend.monthSpend = async () => new Map([[DEV.pam, bad]]);
      expect((await w.call(await w.signIn("ada"), PATH)).status, String(bad)).toBe(503);
    }
  });
});


it("shows spending unavailable through the route when the meter issuer has no verified partition", async () => {
  const w = world();
  await w.settings(A);
  const reader = new DynamoGatewayMeterReader({ send: async () => ({ Responses: { meter: [] } }) } as never, "meter", "https://wrong.example/v1/auth");
  w.spend.monthSpend = (company, month, ids) => reader.monthSpend(company, month, ids);
  const result = await w.call(await w.signIn("ada"), "/org/people-limits");
  expect(result.status).toBe(503);
  expect(result.body).toEqual(PEOPLE_LIMITS_WORDS.spendUnreadable.body);
  expect(result.raw).not.toContain("spentCents");
});
