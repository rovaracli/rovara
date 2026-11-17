/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the tests read Cloud's JSON answers and break a plain JSON body at a path */
// The Cost and time report's Cloud routes (Feature A, slice A3): GET /v1/app/org/report and GET /v1/app/org/report/features/{id}, through Cloud's handler against a
// pretend Rovara Code. Company owner or admin only; the company is Code's live access answer; Cloud reads Code's one-row-per-task report, groups it, and sends whole cents.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { CODE_REPORT_FEATURES_PATH, CODE_REPORT_TASKS_PATH, REPORT_PAGES_MAX, REPORT_WORDS, allocateCents, plainHttpsLink, readRow } from "../../packages/cloud-server/src/report-routes.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), GRACE = "f".repeat(64), BOB = "b".repeat(64);
const ACME = "org_acme0000000000000000", GLOBEX = "org_globex00000000000000";
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface CodeRow { [field: string]: unknown }
/** One of Code's rows as the design's A5 names it (v0: no wait split, no send-backs). */
const row = (n: number, over: CodeRow = {}): CodeRow => ({
  taskId: `task_${String(n).padStart(4, "0")}`, project: "web", title: `Task ${String(n)}`, origin: "web", path: "full", state: "merged", startedAt: iso(NOW - 10 * DAY), firstPrAt: iso(NOW - 9 * DAY), endedAt: iso(NOW - 8 * DAY),
  prsOpened: 1, prsMerged: 1, prLinks: [`https://github.com/acme/web/pull/${String(n)}`], costMicros: 1_000_000, currency: "USD", unpricedCalls: 0, ...over,
});
const feat = (id: string, source = "chosen") => ({ id, source });

interface Company { rows: CodeRow[]; features?: unknown; featuresStatus?: number; pageSize?: number; failTasks?: number }
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
      const size = company.pageSize ?? 200, start = Number(url.searchParams.get("cursor") ?? "0");
      const page = company.rows.slice(start, start + size);
      return json(200, { tasks: page, ...(start + size < company.rows.length ? { next: String(start + size) } : {}) });
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
  const acmeRows = [row(1, { title: "Acme checkout", project: "acme-web", feature: feat("feat_acme") })];
  const globexRows = [row(2, { title: "Globex secret plan", project: "globex-api", feature: feat("feat_globex"), costMicros: 7_000_000 })];
  const world = () => setUp({
    [ACME]: { rows: acmeRows, features: [{ id: "feat_acme", name: "Acme feature", state: "open" }] },
    [GLOBEX]: { rows: globexRows, features: [{ id: "feat_globex", name: "Globex feature", state: "open" }] },
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
      expect([...call.search.keys()].every((key) => ["from", "to", "project", "cursor", "limit"].includes(key))).toBe(true);
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
    const other = await w.get(FEATURE("feat_globex"), "ada-token"), missing = await w.get(FEATURE("feat_nothing"), "ada-token");
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(other.body).toEqual(REPORT_WORDS.notFound.body);
    expect((await w.get(FEATURE("feat_acme"), "ada-token")).status).toBe(200);
  });
});

describe("the report", () => {
  const rows = [
    row(1, { feature: feat("f1"), project: "web", costMicros: 212_340_000 }),
    row(2, { feature: feat("f1", "tracker"), project: "api", state: "open", endedAt: undefined, firstPrAt: undefined, prsOpened: 0, prsMerged: 0, costMicros: 3_333_333, unpricedCalls: 3, startedAt: iso(NOW - 2 * DAY) }),
    row(3, { feature: feat("f2"), project: "web", costMicros: 5_555_555 }),
    row(4, { project: "web", costMicros: 1_111_111, origin: "slack", path: "quick", state: "closed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined }),
    row(5, { project: "api", state: "failed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined, costMicros: 2_000_000, origin: "linear" }),
  ];
  const features = [{ id: "f1", name: "Checkout v2", state: "open" }, { id: "f2", name: "Search", state: "done" }];
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
    const dear = await setUp({ [ACME]: { rows: [row(1, { costMicros: 9_000_000 }), row(2, { costMicros: 1_000_000, feature: feat("f2") })], features } }).get(REPORT, "ada-token");
    expect(dear.body.byFeature.map((g: { key: string }) => g.key)).toEqual(["f2", "none"]);
  });
  it("leaves No feature out when every task has a feature, and names an unknown feature 'Unnamed feature'", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { feature: feat("f9") })], features: [] } });
    const { body } = await w.get(REPORT, "ada-token");
    expect(body.byFeature).toHaveLength(1);
    expect(body.byFeature[0].name).toBe("Unnamed feature");
  });
  it("still answers, with unnamed features, when Code has no features route", async () => {
    const w = setUp({ [ACME]: { rows: [row(1, { feature: feat("f1") })], featuresStatus: 404 } });
    const { status, body, text } = await w.get(REPORT, "ada-token");
    expect(status).toBe(200);
    expect(body.byFeature[0].name).toBe("Unnamed feature");
    expect(text).not.toContain("secret detail");
  });
  it("never shows an unpriced call as nothing: the calls are counted and the cost is marked a floor", async () => {
    const { body } = await world().get(REPORT, "ada-token");
    const checkout = body.byFeature.find((g: { key: string }) => g.key === "f1");
    expect(checkout).toMatchObject({ unpricedCalls: 3, costIsFloor: true });
    expect(body.byFeature.find((g: { key: string }) => g.key === "f2")).toMatchObject({ unpricedCalls: 0, costIsFloor: false });
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
    const checkout = body.byFeature.find((g: { key: string }) => g.key === "f1");
    // First start 10 days ago; an open task keeps it running to now.
    expect(checkout.endToEndMs).toBe(10 * DAY);
    expect(checkout.endToEndSoFar).toBe(true);
    const search = body.byFeature.find((g: { key: string }) => g.key === "f2");
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
    const mk = (days: number | undefined) => ({ ...at(1), taskId: `task_m${String(n++)}`, ...(days === undefined ? { firstPrAt: undefined, prsOpened: 0, prsMerged: 0, state: "closed" } : { firstPrAt: iso(NOW - 20 * DAY + days * DAY) }) });
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
  it("filters: the range and project go to Code, origin, path and state are Cloud's (closed takes failed)", async () => {
    const w = world();
    await w.get(`${REPORT}?from=2026-11-01&to=2026-11-30T23:59:59Z&project=web`, "ada-token");
    expect(w.taskCalls()[0]!.search.get("from")).toBe("2026-11-01");
    expect(w.taskCalls()[0]!.search.get("project")).toBe("web");
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
  it("refuses the whole answer for one unreadable row, in fixed words with nothing of the row", async () => {
    for (const bad of [{ origin: "carrier-pigeon" }, { state: "weird" }, { currency: "EUR" }, { costMicros: -1 }, { costMicros: 1.5 }, { costMicros: 2_000_000_000_000 }, { prsMerged: "1" }, { startedAt: "soon" }, { path: "slow" }, { taskId: "x y" }, { feature: { id: "none", source: "chosen" } }, { feature: { id: "ok", source: "magic" } }, { endedAt: "later" }]) {
      const w = setUp({ [ACME]: { rows: [row(1), row(2, { ...bad, title: "SECRET-TITLE" })] } });
      const answer = await w.get(REPORT, "ada-token");
      expect(answer.status, JSON.stringify(bad)).toBe(502);
      expect(answer.body).toEqual(REPORT_WORDS.unreadable.body);
      expect(answer.text).not.toContain("SECRET-TITLE");
    }
  });
  it("refuses a body that is not a list of tasks, a duplicate task and a cursor that does not move", async () => {
    expect((await setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: "no" }) }).get(REPORT, "ada-token")).status).toBe(502);
    expect((await setUp({ [ACME]: { rows: [row(1), row(1)] } }).get(REPORT, "ada-token")).status).toBe(502);
    expect((await setUp({ [ACME]: { rows: [] } }, { tasks: () => json(200, { tasks: [row(1)], next: "same" }) }).get(REPORT, "ada-token")).status).toBe(502);
  });
  it("makes titles inert and short, keeps only plain https links, and shows a project name as text", () => {
    const parsed = readRow(row(1, { title: "A‮\u0000B  <b>x</b> " + "z".repeat(300), prLinks: ["https://github.com/a/b/pull/1", "http://insecure.example/x", "javascript:alert(1)", "https://user:pw@evil.example/x", "https://has space.example/x"] }), ACME)!;
    expect(parsed.title.length).toBeLessThanOrEqual(120);
    expect(parsed.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(parsed.prLinks).toEqual(["https://github.com/a/b/pull/1"]);
    expect(plainHttpsLink("https://localhost/x")).toBeUndefined();
  });
  it("reads every page, and refuses a range with more pages than the limit instead of returning part of it", async () => {
    const many = Array.from({ length: 450 }, (_, n) => row(n + 1));
    const ok = await setUp({ [ACME]: { rows: many, pageSize: 200 } }).get(REPORT, "ada-token");
    expect(ok.body.totals.tasks).toBe(450);
    const exactly = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_PAGES_MAX * 2 }, (_, n) => row(n + 1)), pageSize: 2 } }).get(REPORT, "ada-token");
    expect(exactly.status).toBe(200);
    expect(exactly.body.totals.tasks).toBe(REPORT_PAGES_MAX * 2);
    const one = await setUp({ [ACME]: { rows: Array.from({ length: REPORT_PAGES_MAX * 2 + 1 }, (_, n) => row(n + 1)), pageSize: 2 } }).get(REPORT, "ada-token");
    expect(one.status).toBe(422);
    const big = await setUp({ [ACME]: { rows: Array.from({ length: (REPORT_PAGES_MAX + 2) * 2 }, (_, n) => row(n + 1)), pageSize: 2 } }, {}).get(REPORT, "ada-token");
    // pageSize 2 gives more pages than the limit: whole-range refusal.
    expect(big.status).toBe(422);
    expect(big.body).toEqual(REPORT_WORDS.tooLarge.body);
  });
});

describe("a feature's page", () => {
  const rows = [
    row(1, { feature: feat("f1", "tracker"), title: "Pay with card", startedAt: iso(NOW - 5 * DAY), firstPrAt: iso(NOW - 4 * DAY), endedAt: iso(NOW - 3 * DAY), costMicros: 2_500_000 }),
    row(2, { feature: feat("f1", "tracker"), title: "Pay with wallet", startedAt: iso(NOW - 3 * DAY), state: "open", endedAt: undefined, firstPrAt: undefined, prsMerged: 0, prsOpened: 0, costMicros: 1_250_000 }),
    row(3, { feature: feat("f1", "confirmed_at_plan"), title: "Refunds", startedAt: iso(NOW - 4 * DAY), firstPrAt: iso(NOW - 3 * DAY), endedAt: iso(NOW - 2 * DAY), costMicros: 1_000_000, origin: "slack" }),
    row(4, { title: "Loose task", feature: undefined }),
  ];
  const features = [{ id: "f1", name: "Checkout v2", state: "open", trackerLink: { tracker: "linear", id: "CHK", url: "https://linear.app/acme/project/chk" } }];
  const world = () => setUp({ [ACME]: { rows, features } });
  it("lists the feature's tasks newest first with the four numbers, how they got here, and a tracker link", async () => {
    const { status, body } = await world().get(FEATURE("f1"), "ada-token");
    expect(status).toBe(200);
    expect(body.feature).toMatchObject({ id: "f1", name: "Checkout v2", state: "open", none: false, trackerLink: { tracker: "linear", id: "CHK", url: "https://linear.app/acme/project/chk" } });
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
    expect((await w.get(FEATURE("f1"), "ada-token")).body.tasks).toEqual([]);
    expect((await w.get(FEATURE("nope"), "ada-token")).status).toBe(404);
    // An id that is not an id never reaches Code (the route does not match).
    expect((await w.get("/v1/web/org/report/features/a%2Fb", "ada-token")).status).toBe(501);
  });
});

describe("allocating cents", () => {
  it("keeps whole cents summing to the total's cents", () => {
    for (const list of [[333_333, 333_333, 333_334], [4_999, 4_999, 4_999], [0, 0], [], [10_000, 5_000, 5_000, 5_000]]) {
      const cents = allocateCents(list);
      expect(cents.every(Number.isInteger)).toBe(true);
      expect(cents.reduce((a, b) => a + b, 0)).toBe(Math.round(list.reduce((a, b) => a + b, 0) / 10_000));
    }
  });
});

