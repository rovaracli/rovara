/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the tests read Cloud's JSON answers and break a plain JSON body at a path */
// The Cost and time report's Cloud routes (Feature A, slice A3): GET /v1/app/org/report and GET /v1/app/org/report/features/{id}, through Cloud's handler against a
// pretend Rovara Code. Company owner or admin only; the company is Code's live access answer; Cloud reads Code's one-row-per-task report, groups it, and sends whole cents.
import { describe, expect, it } from "vitest";
import { readCostReport, readFeatureDetail, reportCsv, featureCsv } from "../../packages/ui/src/api/admin-report.js";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { CODE_REPORT_FEATURES_PATH, CODE_REPORT_TASKS_PATH, REPORT_PAGES_MAX, REPORT_ROWS_MAX, REPORT_WORDS, allocateCents, plainHttpsLink, readRow } from "../../packages/cloud-server/src/report-routes.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), GRACE = "f".repeat(64), BOB = "b".repeat(64);
const ACME = "org_acme0000000000000000", GLOBEX = "org_globex00000000000000";
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Code's ids: a task is a uuid, a feature is `ft_` and 20 hex characters. */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F1 = FT("1"), F2 = FT("2"), F9 = FT("9"), FA = FT("a"), FG = FT("b");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface CodeRow { [field: string]: unknown }
/** One of Code's rows as the design's A5 names it (v0: no wait split, no send-backs). */
const row = (n: number, over: CodeRow = {}): CodeRow => ({
  taskId: uuidOf(n), project: "web", title: `Task ${String(n)}`, origin: "web", path: "full", state: "merged", startedAt: iso(NOW - 10 * DAY), firstPrAt: iso(NOW - 9 * DAY), endedAt: iso(NOW - 8 * DAY),
  prsOpened: 1, prsMerged: 1, prLinks: [`https://github.com/acme/web/pull/${String(n)}`], costMicros: 1_000_000, currency: "USD", unpricedCalls: 0, ...over,
});
const feat = (id: string, source = "chosen") => ({ id, source });

interface Company { rows: CodeRow[]; features?: unknown; featuresStatus?: number; pageSize?: number; failTasks?: number; /** The `to` the first call carried; later calls must carry it again. */ cursorTo?: string }
interface Call { path: string; search: URLSearchParams; authorization: string | undefined }

function setUp(companies: Record<string, Company>, over: { tasks?: (call: Call) => Response | undefined; access?: () => Response | undefined } = {}) {
  const calls: Call[] = [];
  const roleOf: Record<string, { id: string; role: string; company: string }> = {
    "ada-token": { id: ADA, role: "admin", company: ACME }, "owner-token": { id: ADA, role: "owner", company: ACME }, "grace-token": { id: GRACE, role: "member", company: ACME },
    "bob-token": { id: BOB, role: "admin", company: GLOBEX },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    const who = roleOf[(authorization ?? "").replace("Bearer ", "")];
    if (url.pathname === "/v1/dev/access" && over.access?.() !== undefined) return over.access()!;
    if (url.pathname === "/v1/dev/access") return who === undefined ? json(401, {}) : json(200, { developerId: who.id, displayName: "x", administrator: false, companyId: who.company, companyRole: who.role, projects: [], notices: [] });
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (who === undefined) return json(401, {});
    const company = companies[who.company]!;
    const call = { path: url.pathname, search: url.searchParams, authorization };
    if (url.pathname === CODE_REPORT_TASKS_PATH) {
      calls.push(call);
      const special = over.tasks?.(call);
      if (special !== undefined) return special;
      // Code names the company from the token and returns that company's rows only; a page is `pageSize` rows and a numeric cursor.
      // Code takes exactly one of `from` (an instant with milliseconds) and `cursor`; the cursor is bound to `to` and the other filters.
      const from = url.searchParams.get("from"), cursor = url.searchParams.get("cursor");
      if ((from === null) === (cursor === null) || (from !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(from))) return json(400, { error: { code: "CONFIG_INVALID", message: "the report query is not valid" } });
      if (cursor !== null && (url.searchParams.get("to") ?? "") !== (company.cursorTo ?? "")) return json(400, { error: { code: "CONFIG_INVALID", message: "cursor does not match" } });
      const size = company.pageSize ?? 200, start = Number(cursor ?? "0");
      const page = company.rows.slice(start, start + size);
      const more = start + size < company.rows.length;
      return json(200, { tasks: page, next: String(more ? start + size : company.rows.length), hasMore: more, skipped: 0, unreadable: 0 });
    }
    if (url.pathname === CODE_REPORT_FEATURES_PATH) {
      calls.push(call);
      return company.featuresStatus === undefined ? json(200, { features: company.features ?? [] }) : json(company.featuresStatus, { error: { code: "X", message: "secret detail" } });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "rovara", name: "Rovara", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(NOW) });
  const cookies = new Map<string, string>();
  const signIn = async (token: string) => {
    if (cookies.has(token)) return cookies.get(token)!;
    const session: CodeSession = { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: iso(NOW), access: { developerId: ADA, displayName: "x", administrator: false, projects: [], notices: [] } };
    await store.create(`cookie-${token}`, session);
    cookies.set(token, `rovara_cloud_session=cookie-${token}`);
    return cookies.get(token)!;
  };
  const get = async (target: string, token?: string, headers: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const cookie = token === undefined ? undefined : await signIn(token);
    const request: CloudRequest = { method: "GET", path: url.pathname, query: url.searchParams, headers: { ...(cookie === undefined ? {} : { cookie }), ...headers } };
    const answer = await handler(request);
    return { status: answer!.status, text: answer!.body, body: JSON.parse(answer!.body) };
  };
  return { get, calls, taskCalls: () => calls.filter((call) => call.path === CODE_REPORT_TASKS_PATH) };
}

/** The browser calls /v1/web/..., which Cloud answers as /v1/app/... in its route table. */
const REPORT = "/v1/web/org/report";
const FEATURE = (id: string) => `/v1/web/org/report/features/${id}`;

describe("who may read the cost report", () => {
  const world = () => setUp({ [ACME]: { rows: [row(1)] }, [GLOBEX]: { rows: [] } });
  it("needs a sign-in", async () => {
    const w = world();
    expect((await w.get(REPORT)).status).toBe(401);
    expect(w.taskCalls()).toHaveLength(0);
  });
  it("refuses a plain member in fixed words without asking Code for a row", async () => {
    const w = world();
    const answer = await w.get(REPORT, "grace-token");
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual(REPORT_WORDS.notAdmin.body);
    expect(w.taskCalls()).toHaveLength(0);
    expect((await w.get(FEATURE("none"), "grace-token")).status).toBe(403);
    expect(w.taskCalls()).toHaveLength(0);
  });
  it("answers a company admin and a company owner, as the person with their own token", async () => {
    const w = world();
    expect((await w.get(REPORT, "ada-token")).status).toBe(200);
    expect((await w.get(REPORT, "owner-token")).status).toBe(200);
    expect(w.taskCalls().map((call) => call.authorization)).toEqual(["Bearer ada-token", "Bearer owner-token"]);
  });
  it("words Code's own refusal as the same fixed sentence and never echoes what Code said", async () => {
    const w = setUp({ [ACME]: { rows: [] } }, { tasks: () => json(403, { error: { code: "FORBIDDEN", message: "leaky detail about org_globex" } }) });
    const answer = await w.get(REPORT, "ada-token");
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual(REPORT_WORDS.notAdmin.body);
    expect(answer.text).not.toContain("leaky");
  });
  it("words a failure of Code's own access check as fixed sentences too, never what Code said", async () => {
    const down = setUp({ [ACME]: { rows: [] } }, { access: () => json(500, { error: { code: "X", message: "leaky access detail org_globex" } }) });
    const a = await down.get(REPORT, "ada-token");
    expect(a.status).toBe(503);
    expect(a.body).toEqual(REPORT_WORDS.unavailable.body);
    expect(a.text).not.toContain("leaky");
    const refusedAccess = setUp({ [ACME]: { rows: [] } }, { access: () => json(403, { error: { code: "FORBIDDEN", message: "leaky refusal" } }) });
    const b = await refusedAccess.get(REPORT, "ada-token");
    expect(b.body).toEqual(REPORT_WORDS.notAdmin.body);
    expect(down.taskCalls()).toHaveLength(0);
  });
  it("sends a person whose Code sign-in has ended to sign in again", async () => {
    const w = setUp({ [ACME]: { rows: [] } }, { tasks: () => json(401, {}) });
    const answer = await w.get(REPORT, "ada-token");
    expect(answer.status).toBe(401);
    expect(answer.body.error.code).toBe("AUTH_REQUIRED");
  });
  it("says 'not connected' (501) while Code does not serve the report, and 503 for any other failure of Code", async () => {
    const off = setUp({ [ACME]: { rows: [] } }, { tasks: () => json(404, { error: { code: "NOT_FOUND", message: "no such route org_x" } }) });
    const a = await off.get(REPORT, "ada-token");
    expect([a.status, a.body.error.code]).toEqual([501, "NOT_ON_CODE_YET"]);
    expect(a.text).not.toContain("org_x");
    const down = setUp({ [ACME]: { rows: [] } }, { tasks: () => json(500, { error: { message: "stack trace at /srv/code.js" } }) });
    const b = await down.get(REPORT, "ada-token");
    expect(b.status).toBe(503);
    expect(b.text).not.toContain("stack trace");
  });
});

describe("two companies", () => {
  const acmeRows = [row(1, { title: "Acme checkout", project: "acme-web", feature: feat(FA) })];
  const globexRows = [row(2, { title: "Globex secret plan", project: "globex-api", feature: feat(FG), costMicros: 7_000_000 })];
  const world = () => setUp({
    [ACME]: { rows: acmeRows, features: [{ id: FA, name: "Acme feature", state: "open" }] },
    [GLOBEX]: { rows: globexRows, features: [{ id: FG, name: "Globex feature", state: "open" }] },
  });
  it("shows each company only its own rows and never the other's names", async () => {
    const w = world();
    const acme = await w.get(REPORT, "ada-token"), globex = await w.get(REPORT, "bob-token");
    expect(acme.text).toContain("Acme feature");
    expect(acme.text).not.toMatch(/globex|Globex/u);
    expect(globex.text).toContain("Globex feature");
    expect(globex.text).not.toMatch(/acme|Acme/u);
    expect(acme.body.totals.costCents).toBe(100);
    expect(globex.body.totals.costCents).toBe(700);
  });
  it("takes the company from Code's access answer only: a company in the query, a header or a cookie changes nothing and is never forwarded", async () => {
    const w = world();
    const answer = await w.get(`${REPORT}?company=${GLOBEX}&orgId=${GLOBEX}&person=${BOB}`, "ada-token", { "x-rovara-company": GLOBEX, "x-company-id": GLOBEX });
    expect(answer.status).toBe(200);
    expect(answer.text).not.toMatch(/Globex/u);
    for (const call of w.calls) {
      expect([...call.search.keys()].every((key) => ["from", "to", "project", "origin", "state", "path", "cursor", "limit"].includes(key))).toBe(true);
      expect(call.search.toString()).not.toContain(GLOBEX);
    }
  });
  it("refuses the whole answer when a row names another company, and says nothing of it", async () => {
    const w = setUp({ [ACME]: { rows: [row(1), row(2, { companyId: GLOBEX, title: "Globex leak" })] } });
    const answer = await w.get(REPORT, "ada-token");
    expect(answer.status).toBe(502);
    expect(answer.text).not.toContain("Globex");
  });
  it("accepts a row that names the caller's own company", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { companyId: ACME })] } });
    expect((await w.get(REPORT, "ada-token")).status).toBe(200);
  });
  it("a feature of another company is the same 404 as a missing one", async () => {
    const w = world();
    const other = await w.get(FEATURE(FG), "ada-token"), missing = await w.get(FEATURE(FT("c")), "ada-token");
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(other.body).toEqual(REPORT_WORDS.notFound.body);
    expect((await w.get(FEATURE(FA), "ada-token")).status).toBe(200);
  });
});

describe("the report", () => {
  const rows = [
    row(1, { feature: feat(F1), project: "web", costMicros: 212_340_000 }),
    row(2, { feature: feat(F1, "tracker"), project: "api", state: "open", endedAt: undefined, firstPrAt: undefined, prsOpened: 0, prsMerged: 0, costMicros: 3_333_333, unpricedCalls: 3, startedAt: iso(NOW - 2 * DAY) }),
    row(3, { feature: feat(F2), project: "web", costMicros: 5_555_555 }),
    row(4, { project: "web", costMicros: 1_111_111, origin: "slack", path: "quick", state: "closed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined }),
    row(5, { project: "api", state: "failed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined, costMicros: 2_000_000, origin: "linear" }),
  ];
  const features = [{ id: F1, name: "Checkout v2", state: "open" }, { id: F2, name: "Search", state: "done" }];
  const world = () => setUp({ [ACME]: { rows, features } });

  it("adds up in integer cents, and every table's rows add up to its total exactly", async () => {
    const { body } = await setUp({ [ACME]: { rows, features } }).get(REPORT, "ada-token");
    const total = rows.reduce((sum, r) => sum + (r["costMicros"] as number), 0);
    expect(body.totals.costCents).toBe(Math.round(total / 10_000));
    for (const table of [body.byFeature, body.byProject] as Array<Array<{ costCents: number }>>) {
      expect(table.every((g) => Number.isInteger(g.costCents))).toBe(true);
      expect(table.reduce((sum, g) => sum + g.costCents, 0)).toBe(body.totals.costCents);
    }
    expect(body.totals.tasks).toBe(5);
    expect(body.totals.prsMerged).toBe(2);
    expect(body.totals.costPerMergedCents).toBe(Math.round(total / 2 / 10_000));
  });
  it("sorts by cost, highest first, with No feature always last and carrying its own numbers", async () => {
    const { body } = await world().get(REPORT, "ada-token");
    expect(body.byFeature.map((g: { name: string }) => g.name)).toEqual(["Checkout v2", "Search", "No feature"]);
    const none = body.byFeature.at(-1);
    expect(none).toMatchObject({ key: "none", tasks: 2, prsMerged: 0 });
    expect(none.state).toBeUndefined();
    // Even when No feature is the dearest group it stays last.
    const dear = await setUp({ [ACME]: { rows: [row(1, { costMicros: 9_000_000 }), row(2, { costMicros: 1_000_000, feature: feat(F2) })], features } }).get(REPORT, "ada-token");
    expect(dear.body.byFeature.map((g: { key: string }) => g.key)).toEqual([F2, "none"]);
  });
  it("leaves No feature out when every task has a feature, and names an unknown feature 'Unnamed feature'", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { feature: feat(F9) })], features: [] } });
    const { body } = await w.get(REPORT, "ada-token");
    expect(body.byFeature).toHaveLength(1);
    expect(body.byFeature[0].name).toBe("Unnamed feature");
  });
  it("still answers, with unnamed features, when Code has no features route", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { feature: feat(F1) })], featuresStatus: 404 } });
    const { status, body, text } = await w.get(REPORT, "ada-token");
    expect(status).toBe(200);
    expect(body.byFeature[0].name).toBe("Unnamed feature");
    expect(text).not.toContain("secret detail");
  });
  it("never shows an unpriced call as nothing: the calls are counted and the cost is marked a floor", async () => {
    const { body } = await world().get(REPORT, "ada-token");
    const checkout = body.byFeature.find((g: { key: string }) => g.key === F1);
    expect(checkout).toMatchObject({ unpricedCalls: 3, costIsFloor: true });
    expect(body.byFeature.find((g: { key: string }) => g.key === F2)).toMatchObject({ unpricedCalls: 0, costIsFloor: false });
    expect(body.totals).toMatchObject({ unpricedCalls: 3, costIsFloor: true });
    const zero = await setUp({ [ACME]: { rows: [row(1, { costMicros: 0, unpricedCalls: 2 })] } }).get(REPORT, "ada-token");
    expect(zero.body.totals).toMatchObject({ costCents: 0, costIsFloor: true, unpricedCalls: 2 });
  });
  it("has no cost per merged pull request when nothing merged", async () => {
    const { body } = await setUp({ [ACME]: { rows: [row(1, { state: "open", prsMerged: 0, endedAt: undefined })] } }).get(REPORT, "ada-token");
    expect(body.totals).not.toHaveProperty("costPerMergedCents");
  });
  it("works out end to end, 'so far' for open work, and the median from request to pull request", async () => {
    const { body } = await world().get(REPORT, "ada-token");
    const checkout = body.byFeature.find((g: { key: string }) => g.key === F1);
    // First start 10 days ago; an open task keeps it running to now.
    expect(checkout.endToEndMs).toBe(10 * DAY);
    expect(checkout.endToEndSoFar).toBe(true);
    const search = body.byFeature.find((g: { key: string }) => g.key === F2);
    expect(search.endToEndMs).toBe(2 * DAY);
    expect(search.endToEndSoFar).toBe(false);
    // Tasks 1, 3 opened a PR a day after they started.
    expect(body.totals.medianRequestToPrMs).toBe(DAY);
    // A closed task with no end time has no end to end (never a guess).
    const unknown = await setUp({ [ACME]: { rows: [row(1, { state: "closed", endedAt: undefined })] } }).get(REPORT, "ada-token");
    expect(unknown.body.totals).not.toHaveProperty("endToEndMs");
  });
  it("takes the median of distinct times (the middle of three, the mean of the middle two of four) and skips tasks with no pull request", async () => {
    const at = (days: number, over: CodeRow = {}) => row(Math.floor(Math.random() * 1e6), { startedAt: iso(NOW - 20 * DAY), firstPrAt: iso(NOW - 20 * DAY + days * DAY), ...over });
    let n = 0;
    const mk = (days: number | undefined) => ({ ...at(1), taskId: uuidOf(900 + n++), ...(days === undefined ? { firstPrAt: undefined, prsOpened: 0, prsMerged: 0, state: "closed" } : { firstPrAt: iso(NOW - 20 * DAY + days * DAY) }) });
    const three = await setUp({ [ACME]: { rows: [mk(10), mk(1), mk(3), mk(undefined)] } }).get(REPORT, "ada-token");
    expect(three.body.totals.medianRequestToPrMs).toBe(3 * DAY);
    const four = await setUp({ [ACME]: { rows: [mk(10), mk(1), mk(3), mk(2)] } }).get(REPORT, "ada-token");
    expect(four.body.totals.medianRequestToPrMs).toBe(2.5 * DAY);
    const none = await setUp({ [ACME]: { rows: [mk(undefined)] } }).get(REPORT, "ada-token");
    expect(none.body.totals).not.toHaveProperty("medianRequestToPrMs");
  });
  it("groups by project too, and lists the projects for the filter", async () => {
    const { body } = await world().get(REPORT, "ada-token");
    expect(body.byProject.map((g: { name: string }) => g.name)).toEqual(["web", "api"]);
    expect(body.projects).toEqual(["api", "web"]);
  });
  it("filters: all six go to Code, and Cloud applies origin, path and state again (closed takes failed)", async () => {
    const w = world();
    await w.get(`${REPORT}?from=2026-11-01&to=2026-11-30T23:59:59Z&project=web`, "ada-token");
    expect(w.taskCalls()[0]!.search.get("from")).toBe("2026-11-01T00:00:00.000Z");
    expect(w.taskCalls()[0]!.search.get("to")).toBe("2026-11-30T23:59:59.000Z");
    expect(w.taskCalls()[0]!.search.get("project")).toBe("web");
    await w.get(`${REPORT}?origin=slack&state=open&path=quick`, "ada-token");
    expect(["origin", "state", "path"].map((name) => w.taskCalls()[1]!.search.get(name))).toEqual(["slack", "open", "quick"]);
    expect((await w.get(`${REPORT}?origin=slack`, "ada-token")).body.totals.tasks).toBe(1);
    expect((await w.get(`${REPORT}?path=quick`, "ada-token")).body.totals.tasks).toBe(1);
    expect((await w.get(`${REPORT}?state=closed`, "ada-token")).body.totals.tasks).toBe(2);
    expect((await w.get(`${REPORT}?state=open`, "ada-token")).body.totals.tasks).toBe(1);
    expect((await w.get(`${REPORT}?state=merged`, "ada-token")).body.totals.tasks).toBe(2);
  });
  it("refuses a filter the page does not offer in fixed words that echo nothing", async () => {
    const w = world();
    for (const bad of ["origin=carrier-pigeon", "state=failed", "path=x", "from=yesterday", "to=2026-13-45", "from=2026-11-02&to=2026-11-01", "project=a%00b", "origin=web&origin=slack", "project="]) {
      const answer = await w.get(`${REPORT}?${bad}`, "ada-token");
      expect(answer.status, bad).toBe(400);
      expect(answer.body).toEqual(REPORT_WORDS.badFilter.body);
    }
    expect(w.taskCalls()).toHaveLength(0);
  });
  it("carries no person and no wait split: the requester, other fields and an unknown extra never reach the page", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { requesterId: "c".repeat(64), requesterName: "Dev Ann", waitingPeopleMs: 5, sendBacksPeople: 2, workingMs: 9, secretNote: "leaky" })] } });
    for (const target of [REPORT, FEATURE("none")]) {
      const { text } = await w.get(target, "ada-token");
      for (const word of ["requester", "Dev Ann", "c".repeat(64), "waiting", "sendBack", "workingMs", "leaky", "mergedCount", "person"]) expect(text, `${target} ${word}`).not.toContain(word);
    }
  });
});

describe("what Code sent, read strictly", () => {
  it("counts invalid rows separately, preserving valid tasks without exposing invalid text", async () => {
    for (const bad of [{ origin: "carrier-pigeon" }, { state: "weird" }, { costMicros: -1 }, { costMicros: 1.5 }, { costMicros: 2_000_000_000_000 }, { prsMerged: "1" }, { startedAt: "soon" }, { path: "slow" }, { taskId: "x y" }, { feature: { id: "none", source: "chosen" } }, { feature: { id: "ok", source: "magic" } }, { endedAt: "later" }]) {
      const w = setUp({ [ACME]: { rows: [row(1), row(2, { ...bad, title: "SECRET-TITLE" })] } });
      const answer = await w.get(REPORT, "ada-token");
      expect(answer.status, JSON.stringify(bad)).toBe(200);
      expect(answer.body).toMatchObject({ unreadableTasks: 1, totals: { tasks: 1, costCents: 100, costIsFloor: true } });
      expect(answer.text).not.toContain("SECRET-TITLE");
    }
  });
  it("refuses a body that is not a list of tasks, a duplicate task and a cursor that does not move", async () => {
    expect((await setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: "no" }) }).get(REPORT, "ada-token")).status).toBe(502);
    expect((await setUp({ [ACME]: { rows: [row(1), row(1)] } }).get(REPORT, "ada-token")).status).toBe(502);
    let served = 0; // a different task each call, so only the cursor check can stop it
    expect((await setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: [row(++served)], next: "same", hasMore: true }) }).get(REPORT, "ada-token")).status).toBe(502);
  });
  it("makes titles inert and short, keeps only plain https links, and shows a project name as text", () => {
    const parsed = readRow(row(1, { title: "A‮\u0000B  <b>x</b> " + "z".repeat(300), prLinks: ["https://github.com/a/b/pull/1", "http://insecure.example/x", "javascript:alert(1)", "https://user:pw" + String.fromCharCode(64) + "evil.example/x", "https://has space.example/x"] }), ACME)!;
    expect(parsed.title.length).toBeLessThanOrEqual(120);
    expect(parsed.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(parsed.prLinks).toEqual(["https://github.com/a/b/pull/1"]);
    expect(plainHttpsLink("https://localhost/x")).toBeUndefined();
  });
  it("reads every call of Code's cursor, and refuses a range with more rows or more calls than the limits instead of returning part of it", async () => {
    const many = Array.from({ length: 450 }, (_, n) => row(n + 1));
    const ok = await setUp({ [ACME]: { rows: many, pageSize: 200 } }).get(REPORT, "ada-token");
    expect(ok.body.totals.tasks).toBe(450);
    const exactly = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_PAGES_MAX * 2 }, (_, n) => row(n + 1)), pageSize: 2 } }).get(REPORT, "ada-token");
    expect(exactly.status).toBe(200);
    expect(exactly.body.totals.tasks).toBe(REPORT_PAGES_MAX * 2);
    const one = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_PAGES_MAX * 2 + 1 }, (_, n) => row(n + 1)), pageSize: 2 } }).get(REPORT, "ada-token");
    expect([one.status, one.body]).toEqual([422, REPORT_WORDS.tooLarge.body]);
    const edge = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_ROWS_MAX }, (_, n) => row(n + 1)) } }).get(REPORT, "ada-token");
    expect(edge.body.totals.tasks).toBe(REPORT_ROWS_MAX);
    const over = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_ROWS_MAX + 1 }, (_, n) => row(n + 1)) } }).get(REPORT, "ada-token");
    expect([over.status, over.body]).toEqual([422, REPORT_WORDS.tooLarge.body]);
  });
  it("asks Code the way its cursor needs: `from` on the first call only, the cursor and the filters it is bound to on every later one, and a start for All time", async () => {
    const many = Array.from({ length: 450 }, (_, n) => row(n + 1));
    const w = setUp({ [ACME]: { rows: many, pageSize: 200, cursorTo: "2026-11-30T23:59:59.000Z" } });
    const answer = await w.get(`${REPORT}?from=2026-11-01&to=2026-11-30T23:59:59Z&project=web&origin=web`, "ada-token");
    expect(answer.status).toBe(200);
    expect(answer.body.totals.tasks).toBe(450);
    const calls = w.taskCalls();
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => [call.search.has("from"), call.search.has("cursor")])).toEqual([[true, false], [false, true], [false, true]]);
    for (const call of calls) expect(["to", "project", "origin"].map((name) => call.search.get(name))).toEqual(["2026-11-30T23:59:59.000Z", "web", "web"]);
    // All time has no `from` of its own: the first call gets a floor so Code accepts it, and later calls still carry the cursor alone.
    const all = setUp({ [ACME]: { rows: many, pageSize: 200 } });
    expect((await all.get(REPORT, "ada-token")).body.totals.tasks).toBe(450);
    expect(all.taskCalls()[0]!.search.get("from")).toBe("1970-01-01T00:00:00.000Z");
    expect(all.taskCalls()[1]!.search.has("from")).toBe(false);
  });
  it("goes on past a call that gave no rows while Code says there is more, and stops at hasMore false", async () => {
    let at = 0;
    const w = setUp({ [ACME]: { rows: [] } }, { tasks: () => { at += 1; return at < 3 ? json(200, { tasks: [], next: `c${String(at)}`, hasMore: true, skipped: 0, unreadable: 0 }) : json(200, { tasks: [row(1)], next: "end", hasMore: false, skipped: 0, unreadable: 0 }); } });
    const answer = await w.get(REPORT, "ada-token");
    expect(answer.body.totals.tasks).toBe(1);
    expect(w.taskCalls().map((call) => call.search.get("cursor"))).toEqual([null, "c1", "c2"]);
  });
  it("says how many tasks Code could not read instead of hiding them, and ignores Code's count of other companies' rows", async () => {
    const w = setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: [row(1)], next: "n", hasMore: false, skipped: 4, unreadable: 2 }) });
    const answer = await w.get(REPORT, "ada-token");
    expect(answer.body.unreadableTasks).toBe(2);
    expect(answer.body.totals.tasks).toBe(1);
    expect(answer.text).not.toContain("skipped");
    const clean = await setUp({ [ACME]: { rows: [row(1)] } }).get(REPORT, "ada-token");
    expect(clean.body).not.toHaveProperty("unreadableTasks");
    const bad = await setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: [], next: "n", hasMore: false, unreadable: -1 }) }).get(REPORT, "ada-token");
    expect(bad.status).toBe(502);
  });
  it("reads Code's real row: no path, no currency when nothing was recorded, the 'other' origin, and sends the other filters to Code", async () => {
    const bare = row(1, { path: undefined, currency: undefined, costMicros: 0, unpricedCalls: 0, origin: "other", prLinks: [] });
    const w = setUp({ [ACME]: { rows: [bare] } });
    const answer = await w.get(`${REPORT}?origin=other&state=merged`, "ada-token");
    expect(answer.status).toBe(200);
    expect(answer.body.totals).toMatchObject({ tasks: 1, costCents: 0, costIsFloor: false });
    expect([...w.taskCalls()[0]!.search.keys()].sort()).toEqual(["from", "limit", "origin", "state"]);
    // A cost with no currency is not a cost Cloud can read; merged cannot exceed opened.
    expect((await setUp({ [ACME]: { rows: [row(1, { currency: undefined, costMicros: 5 })] } }).get(REPORT, "ada-token")).body.unreadableTasks).toBe(1);
    expect((await setUp({ [ACME]: { rows: [row(1, { prsOpened: 1, prsMerged: 2 })] } }).get(REPORT, "ada-token")).body.unreadableTasks).toBe(1);
  });
});

describe("a feature's page", () => {
  const rows = [
    row(1, { feature: feat(F1, "tracker"), title: "Pay with card", startedAt: iso(NOW - 5 * DAY), firstPrAt: iso(NOW - 4 * DAY), endedAt: iso(NOW - 3 * DAY), costMicros: 2_500_000 }),
    row(2, { feature: feat(F1, "tracker"), title: "Pay with wallet", startedAt: iso(NOW - 3 * DAY), state: "open", endedAt: undefined, firstPrAt: undefined, prsMerged: 0, prsOpened: 0, costMicros: 1_250_000 }),
    row(3, { feature: feat(F1, "confirmed_at_plan"), title: "Refunds", startedAt: iso(NOW - 4 * DAY), firstPrAt: iso(NOW - 3 * DAY), endedAt: iso(NOW - 2 * DAY), costMicros: 1_000_000, origin: "slack" }),
    row(4, { title: "Loose task", feature: undefined }),
  ];
  const features = [{ id: F1, name: "Checkout v2", state: "open", trackerLink: { tracker: "linear", id: "CHK", url: "https://linear.app/acme/project/chk" } }];
  const world = () => setUp({ [ACME]: { rows, features } });
  it("lists the feature's tasks newest first with the four numbers, how they got here, and a tracker link", async () => {
    const { status, body } = await world().get(FEATURE(F1), "ada-token");
    expect(status).toBe(200);
    expect(body.feature).toMatchObject({ id: F1, name: "Checkout v2", state: "open", none: false, trackerLink: { tracker: "linear", id: "CHK", url: "https://linear.app/acme/project/chk" } });
    expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(["Pay with wallet", "Refunds", "Pay with card"]);
    expect(body.totals).toMatchObject({ tasks: 3, prsMerged: 2, costCents: 475 });
    expect(body.tasks.reduce((sum: number, t: { costCents: number }) => sum + t.costCents, 0)).toBe(body.totals.costCents);
    expect(body.sources).toEqual([{ source: "tracker", count: 2 }, { source: "confirmed_at_plan", count: 1 }]);
    expect(body.tasks[0]).toMatchObject({ state: "open", wallMs: 3 * DAY, wallSoFar: true });
    expect(body.tasks[2]).toMatchObject({ state: "merged", wallMs: 2 * DAY });
    expect(body.tasks[2]).not.toHaveProperty("wallSoFar");
    expect(body.tasksTotal).toBe(3);
  });
  it("shows the tasks with no feature under the id 'none'", async () => {
    const { body } = await world().get(FEATURE("none"), "ada-token");
    expect(body.feature).toMatchObject({ id: "none", name: "No feature", none: true });
    expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(["Loose task"]);
  });
  it("gives a feature with no tasks in the range an empty page, and a made-up id the fixed 404", async () => {
    const w = setUp({ [ACME]: { rows: [], features } });
    expect((await w.get(FEATURE(F1), "ada-token")).body.tasks).toEqual([]);
    expect((await w.get(FEATURE("nope"), "ada-token")).status).toBe(404);
    // An id that is not an id never reaches Code (the route does not match).
    expect((await w.get("/v1/web/org/report/features/a%2Fb", "ada-token")).status).toBe(501);
  });
});

// Row 3672 (L4-CR3): the feature page's total is the feature's own row in the table (same allocation, so the two never differ by a cent).
describe("a feature's page total is its row in the table, to the cent", () => {
  // Two features of half a cent each (the table gives the one cent of their 1-cent total to the first by largest remainder; rounding each on its own would give both a cent), a third with
  // thirds, and a task with no feature.
  const rows = [
    row(1, { feature: feat(F1), costMicros: 5_000 }),
    row(2, { feature: feat(F2), costMicros: 5_000 }),
    row(3, { feature: feat(FA), costMicros: 333_333 }),
    row(4, { feature: feat(FA), costMicros: 333_333 }),
    row(5, { feature: feat(FA), costMicros: 333_334 }),
    row(6, { feature: undefined, costMicros: 4_999 }),
    row(7, { feature: undefined, costMicros: 4_999 }),
    row(8, { feature: undefined, costMicros: 4_999 }),
  ];
  const features = [{ id: F1, name: "One", state: "open" }, { id: F2, name: "Two", state: "open" }, { id: FA, name: "Thirds", state: "open" }];
  const world = () => setUp({ [ACME]: { rows, features } });

  it("matches the table row for every feature and for No feature, on the same 1-cent split", async () => {
    const w = world();
    const { body: report } = await w.get(REPORT, "ada-token");
    const table = report.byFeature as Array<{ key: string; costCents: number }>;
    // The fixture really splits a cent: the table rows are not each feature's own rounding.
    expect(table.find((g) => g.key === F1)!.costCents).not.toBe(table.find((g) => g.key === F2)!.costCents);
    for (const group of table) {
      const { body: detail } = await w.get(FEATURE(group.key === "none" ? "none" : group.key), "ada-token");
      expect(detail.totals.costCents, `feature ${group.key}`).toBe(group.costCents);
    }
  });

  it("gives the half-cent features their table cents (1 and 0), not a cent each", async () => {
    const w = world();
    expect((await w.get(FEATURE(F1), "ada-token")).body.totals.costCents).toBe(1);
    expect((await w.get(FEATURE(F2), "ada-token")).body.totals.costCents).toBe(0);
  });

  it("keeps the shown tasks' cents adding up to the page total", async () => {
    const w = world();
    for (const id of [F1, F2, FA, "none"]) {
      const { body } = await w.get(FEATURE(id), "ada-token");
      expect(body.tasks.reduce((sum: number, t: { costCents: number }) => sum + t.costCents, 0), id).toBe(body.totals.costCents);
    }
  });

  it("still agrees with the table under a filter (both use the filtered rows)", async () => {
    // One task of the thirds feature is closed, so the filter really changes the row set (and the thirds' cents).
    const filtered = rows.map((r, at) => (at === 3 ? { ...r, state: "closed", prsMerged: 0, prsOpened: 0 } : r));
    const w = setUp({ [ACME]: { rows: filtered, features } });
    const query = "?state=merged";
    const { body: report } = await w.get(REPORT + query, "ada-token");
    for (const group of report.byFeature as Array<{ key: string; costCents: number }>) {
      expect((await w.get(FEATURE(group.key) + query, "ada-token")).body.totals.costCents).toBe(group.costCents);
    }
  });

  it("gives a feature with no task in the range zero cents, and leaves the other pages alone", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { feature: feat(F1), costMicros: 5_000 })], features } });
    expect((await w.get(FEATURE(F2), "ada-token")).body.totals.costCents).toBe(0);
    expect((await w.get(FEATURE(F1), "ada-token")).body.totals.costCents).toBe(1);
  });

  it("shows one company's page the cents of its own table only (a second company's rows change nothing)", async () => {
    const other = [row(21, { feature: feat(F1), costMicros: 9_999_999 }), row(22, { feature: feat(F2), costMicros: 5_000 })];
    const w = setUp({ [ACME]: { rows, features }, [GLOBEX]: { rows: other, features } });
    expect((await w.get(FEATURE(F1), "ada-token")).body.totals.costCents).toBe(1);
    expect((await w.get(FEATURE(F2), "ada-token")).body.totals.costCents).toBe(0);
  });
});

describe("allocating cents", () => {
  it("allocates to a target the caller names (the table's row), summing to exactly that", () => {
    expect(allocateCents([5_000, 5_000], 1)).toEqual([1, 0]);
    expect(allocateCents([5_000, 5_000], 0)).toEqual([0, 0]);
    expect(allocateCents([333_333, 333_333, 333_334], 100).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("keeps whole cents summing to the total's cents", () => {
    for (const list of [[333_333, 333_333, 333_334], [4_999, 4_999, 4_999], [0, 0], [], [10_000, 5_000, 5_000, 5_000]]) {
      const cents = allocateCents(list);
      expect(cents.every(Number.isInteger)).toBe(true);
      expect(cents.reduce((a, b) => a + b, 0)).toBe(Math.round(list.reduce((a, b) => a + b, 0) / 10_000));
    }
  });
});



describe("cost coverage across summary, detail and CSV", () => {
  it("keeps wholly unpriced tasks and foreign currencies separate from invalid rows", async () => {
    const rows = [row(1), row(2, { costMicros: 0, currency: undefined, unpricedCalls: 1 }), row(3, { costMicros: 9_000_000, currency: "EUR" }), row(4, { costMicros: -1 })];
    const w = setUp({ [ACME]: { rows } });
    const summary = await w.get(REPORT, "ada-token"), detail = await w.get(FEATURE("none"), "ada-token");
    expect(summary.status).toBe(200); expect(detail.status).toBe(200);
    const report = readCostReport.parse(summary.body), feature = readFeatureDetail.parse(detail.body);
    for (const result of [report, feature]) {
      expect(result.unreadableTasks).toBe(1);
      expect(result.totals).toMatchObject({ tasks: 3, costCents: 100, costIsFloor: true, pricedTasks: 1, foreignCurrencyTasks: 1, unpricedCalls: 1 });
    }
    expect(report.byFeature[0]).toMatchObject({ costCents: 100, pricedTasks: 1, foreignCurrencyTasks: 1 });
    expect(feature.tasks.find(t => t.taskId === rows[1]!["taskId"])).toMatchObject({ costCents: 0, costUnavailable: true });
    expect(feature.tasks.find(t => t.taskId === rows[2]!["taskId"])).toMatchObject({ costCents: 0, costUnavailable: true });
    expect(feature.tasks.reduce((sum, t) => sum + t.costCents, 0)).toBe(100);
    expect(reportCsv(report.byFeature, "feature", report.unreadableTasks)).toContain("Fully priced USD tasks,Foreign currency tasks");
    expect(reportCsv(report.byFeature, "feature", report.unreadableTasks)).toContain(",1,1,1\r\n");
    expect(featureCsv(feature.tasks, feature)).toContain(",1,1,1\r\n");
    expect(featureCsv(feature.tasks, feature).match(/Cost unavailable/gu)).toHaveLength(2);
    expect(readRow(row(5, { costMicros: 0, currency: undefined, unpricedCalls: 1 }), ACME)).toBeDefined();
  });
});
