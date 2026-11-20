/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- answers are parsed JSON read field by field */
// Lead 4 slice W6: the wiki panel on the setup page through Cloud's handler, passed to Code as the signed-in person (W0's file map, W4's build controls, and the nightly upkeep seam).
// Code decides who may; the pretend Code below applies W4's rule (a company owner or admin, or the project's administrator, manages; any role on the project reads; anyone else, another company's project or a
// project of the company the person has no role on is the same 404 "project not found"; a reader's change is 403). Cloud must: pass the person's own token, put only the project of the path into Code's path,
// rebuild each body from known fields (a company, limit, commit, goal or role in it is refused before Code is asked), rebuild every answer, let NO dollar figure, task id or commit through, answer refusals
// in fixed words (Code's own only when they are exactly one of the known list), and never log what the person wrote.
// Mutants (each killed by the named test, run by hand): M1 project in Code's path (every route); M2 extra body field forwarded (bodies); M3 notes unbounded; M4 chip ids unbounded/duplicates; M5 requestId not a uuid;
// M6 budgetCents/spentCents/taskId passed (no dollars); M7 payer not checked; M8 unknown sentence passed (sentences); M9 forecast price accepted (map); M10 map for another project accepted (map);
// M11 Code's text echoed on refusal (failures); M12 query forwarded; M13 unknown-route 404 not "not yet"; M14 Code's unknown code/status passed (failures); M15 upkeep refusal words passed from Code; M16 log carries the notes.
// L4-W6b (the consent step of the upkeep switch, Code L4-P2; each killed by the named test in "the upkeep consent step"): R1 extra body field forwarded (PUT body); R2 allowSystemRuns not checked to be a boolean; R3 allowSystemRuns false with on true
// forwarded; R4 Code's extra answer fields passed (rebuild); R5 cap.monthlyUsd not range-checked; R6 null cap turned into a number; R7 Code's consent words passed on instead of Cloud's; R8 NOT_AVAILABLE_HERE read as a fault;
// R9 canEnableSystemRuns invented when Code omits it; R10 allowSystemRuns added to a plain switch; R11 the log says what the person chose, not just the action; R12 another company's project forwarded.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, WIKI_SETUP_ANSWERS, WIKI_SETUP_CODE_WORDS, WIKI_SETUP_WORDS, buildAnswer, createCloudHandler, mapViewAnswer, wikiSetupRefusal, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import {
  WIKI_SETUP_CODE_WORDS as APP_CODE_WORDS, WIKI_SETUP_SENTENCES, WIKI_SETUP_WORDS as APP_WORDS, WikiSetupBuildSchema, WikiSetupDeleteAnswerSchema, WikiSetupMapViewSchema, WikiSetupUpkeepSchema,
} from "../../packages/contracts/src/app-wiki-setup.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ID = (c: string) => c.repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const RID = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer" | "viewer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ID("a"), company: A, role: "owner", grants: {} },
  "mia-token": { id: ID("2"), company: A, role: "member", grants: { payments: "administrator" } },
  "pam-token": { id: ID("b"), company: A, role: "member", grants: { payments: "developer" } },
  "bob-token": { id: ID("c"), company: B, role: "admin", grants: {} },
  "nob-token": { id: ID("d"), grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, billing: A, ledger: B };
const standing = (person: Person, project: string): "manage" | "view" | undefined => {
  if (person.company === undefined || PROJECTS[project] !== person.company) return undefined;
  if (person.role === "owner" || person.role === "admin" || person.grants[project] === "administrator") return "manage";
  return person.grants[project] === undefined ? undefined : "view";
};

// What Code answers, in W4's and W0's shapes. The dollar members, the task id and the commits are there on purpose: Cloud must not pass them.
const buildView = (canManage: boolean, extra: Record<string, unknown> = {}) => ({
  status: "stopped", limits: { pages: 300, budgetCents: 2_500, wallClockMin: 180, pageReserveCents: 100 }, taskId: "task-secret-id-0001", startedAt: "2026-11-17T10:00:00.000Z", stop: "stopped_by_person",
  message: WIKI_SETUP_CODE_WORDS.stopped_by_person, summary: { pagesPlanned: 40, pagesWritten: 12, pagesKeptFromEarlier: 0, claimsKept: 80, claimsDropped: 3, spentCents: 617 }, canContinue: true, payer: "project",
  stoppedBy: { name: "Mia", at: "2026-11-17T10:30:00.000Z" }, canManage, aiKey: "connected", agents: { on: false }, wiki: { pages: 12, refreshPages: 2 }, ...extra,
});
const mapOf = (project: string, extra: Record<string, unknown> = {}) => ({
  version: 1, project, computedAt: "2026-11-17T09:00:00.000Z", complete: true, repositoriesOmitted: 0,
  repositories: [{
    name: "web", url: "https://github.com/example/web", status: "ok", branch: "main", commit: "a".repeat(40), files: 1200, skipped: { generated: 4, vendored: 9, lockfiles: 1, assets: 30, secret: 2 }, languages: [{ language: "TypeScript", files: 900, percent: 75 }],
    areas: [{ path: "src/billing", files: 120, kind: "source", commits: 40, rank: 1 }], testFolders: ["tests"], skippedFolders: ["dist/", "vendor/"], activity: { status: "ok", days: 90 }, pages: { repository: 1, modules: 20, modulesCapped: false },
  }],
  chips: [{ id: "write-first-src-billing", kind: "write_first", repo: "web", path: "src/billing", label: "Write these first? src/billing", defaultOn: false }, { id: "skip-generated-dist", kind: "skip_generated", repo: "web", path: "dist/", label: "Skip? dist/", defaultOn: true }],
  forecast: { repositories: 1, files: 1200, pages: 24, pagesCapped: false, complete: true, price: "not_priced_yet" }, limits: { activityDays: 90, modulePagesPerRepository: 40, pagesPerProject: 300, areasPerRepository: 40 }, ...extra,
});

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;
function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    const match = /^\/v1\/app\/projects\/([^/]+)\/(wiki-map|wiki-build(?:\/(?:continue|stop|refresh|agents|delete))?|upkeep)$/u.exec(url.pathname);
    if (match === null) return err(404, "NOT_FOUND", "route not found");
    const project = decodeURIComponent(match[1]!), how = standing(person, project);
    if (how === undefined) return err(404, "NOT_FOUND", `project not found ${LEAK}`);
    const tail = match[2]!;
    if (call.method !== "GET" && how !== "manage") return err(403, "FORBIDDEN", tail === "wiki-map" ? WIKI_SETUP_CODE_WORDS.mapNotAllowed : WIKI_SETUP_CODE_WORDS.notAllowed);
    if (tail === "wiki-map") return json(200, { status: "ready", canManage: how === "manage", map: mapOf(project) });
    if (tail === "upkeep") return json(200, { enabled: call.method === "PUT" ? (call.body as any).on : false, canManage: how === "manage" });
    if (tail === "wiki-build/delete") return json(200, { deleted: true, message: WIKI_SETUP_CODE_WORDS.deleted, view: buildView(true, { status: "none", wiki: { pages: 0, refreshPages: 0 } }) });
    return json(200, buildView(how === "manage"));
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const sessions = new Map<string, Record<string, string>>();
  const as = async (token: string): Promise<Record<string, string>> => {
    const known = sessions.get(token);
    if (known !== undefined) return known;
    const person = PEOPLE[token] ?? { id: "f".repeat(64), grants: {} };
    // The stored sign-in names company A as owner for everyone: Cloud must use Code's live answer, never this.
    const access = { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    const headers = { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
    sessions.set(token, headers);
    return headers;
  };
  const send = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body), text: answered!.body };
  };
  return { as, send, calls, codeCalls: () => calls.filter((call) => call.path !== "/v1/dev/access"), store };
}
const error = (answer: { body: any }) => answer.body.error as { code: string; message: string };
const asRefusal = (answer: { status: number; body: any }) => ({ status: answer.status, error: error(answer) });
const refusal = (key: keyof typeof WIKI_SETUP_ANSWERS) => ({ status: WIKI_SETUP_ANSWERS[key].status, error: (WIKI_SETUP_ANSWERS[key].body as { error: unknown }).error });
const P = (project: string, tail: string) => `/v1/web/projects/${project}/${tail}`;
const POSTS: Array<[string, string, Record<string, unknown>]> = [
  ["wiki-build", "wiki-build", { requestId: RID, notes: "Billing is the core.", chipsOn: ["skip-generated-dist"] }],
  ["wiki-build/continue", "wiki-build/continue", { requestId: RID }],
  ["wiki-build/stop", "wiki-build/stop", { requestId: RID }],
  ["wiki-build/refresh", "wiki-build/refresh", { requestId: RID }],
  ["wiki-build/agents", "wiki-build/agents", { requestId: RID, on: true }],
];
afterEach(() => { vi.restoreAllMocks(); });

describe("the fixed words and limits", () => {
  it("are the same in Cloud's server and in the app's contracts", () => {
    expect({ ...WIKI_SETUP_CODE_WORDS }).toEqual({ ...APP_CODE_WORDS });
    expect({ ...WIKI_SETUP_WORDS }).toEqual({ ...APP_WORDS });
    expect(WIKI_SETUP_SENTENCES.size).toBe(Object.keys(APP_CODE_WORDS).length + Object.keys(APP_WORDS).length);
  });
});

describe("every route passes the person's own token, to Code's own path, with the project only in the path (M1, M12)", () => {
  it("reads: the file map, the build state and the upkeep switch; the answers read in the app's schemas", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    const map = await w.send("GET", P("payments", "wiki-map"), headers);
    expect(map.status).toBe(200);
    expect(WikiSetupMapViewSchema.parse(map.body)).toMatchObject({ status: "ready", canManage: true });
    const build = await w.send("GET", P("payments", "wiki-build"), headers);
    expect(WikiSetupBuildSchema.parse(build.body)).toMatchObject({ status: "stopped", canManage: true, agents: { on: false }, wiki: { pages: 12, refreshPages: 2 } });
    const upkeep = await w.send("GET", P("payments", "upkeep"), headers);
    expect(WikiSetupUpkeepSchema.parse(upkeep.body)).toEqual({ enabled: false, canManage: true });
    expect(w.codeCalls().map((call) => `${call.method} ${call.path} ${call.search}|${call.authorization}`)).toEqual([
      "GET /v1/app/projects/payments/wiki-map |Bearer mia-token", "GET /v1/app/projects/payments/wiki-build |Bearer mia-token", "GET /v1/app/projects/payments/upkeep |Bearer mia-token",
    ]);
  });

  it("changes: each body reaches Code rebuilt, to its own path, and the answer reads in the app's schema", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    for (const [path, , body] of POSTS) {
      const res = await w.send("POST", P("payments", path), headers, body);
      expect(res.status, path).toBe(200);
      expect(WikiSetupBuildSchema.parse(res.body), path).toMatchObject({ canManage: true });
    }
    const made = await w.send("POST", P("payments", "wiki-map"), headers, {});
    expect(WikiSetupMapViewSchema.parse(made.body)).toMatchObject({ status: "ready" });
    const deleted = await w.send("POST", P("payments", "wiki-build/delete"), headers, { requestId: RID });
    expect(WikiSetupDeleteAnswerSchema.parse(deleted.body)).toMatchObject({ deleted: true, message: WIKI_SETUP_CODE_WORDS.deleted, view: { status: "none" } });
    const switched = await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: true });
    expect(WikiSetupUpkeepSchema.parse(switched.body)).toEqual({ enabled: true, canManage: true });
    // Build, Continue and Refresh now first read the state as the person (L4-CW: so a person who may not start is never told anything about the company's AI); only the changes are listed here.
    const sent = w.codeCalls().filter((call) => call.method !== "GET");
    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      ...POSTS.map(([, codePath]) => `POST /v1/app/projects/payments/${codePath}`), "POST /v1/app/projects/payments/wiki-map", "POST /v1/app/projects/payments/wiki-build/delete", "PUT /v1/app/projects/payments/upkeep",
    ]);
    expect(sent.every((call) => call.authorization === "Bearer mia-token")).toBe(true);
    expect(sent[0]!.body).toEqual({ requestId: RID, notes: "Billing is the core.", chipsOn: ["skip-generated-dist"] });
    expect(sent[4]!.body).toEqual({ requestId: RID, on: true });
    expect(sent[5]!.body).toEqual({});
  });

  it("a query is never forwarded: it is refused without asking Code", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    for (const path of ["wiki-map?x=1", "wiki-build?company=b", "upkeep?a=b"]) expect(asRefusal(await w.send("GET", P("payments", path), headers)), path).toEqual(refusal("invalid"));
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("a project name that does not read is a refusal without asking Code", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    for (const name of ["Payments", "pay_ments", "-x"]) expect(asRefusal(await w.send("GET", P(name, "wiki-build"), headers)), name).toEqual(refusal("notFound"));
    expect(w.codeCalls()).toHaveLength(0);
  });
});

describe("who may: Code decides, Cloud passes its words (two projects, two companies)", () => {
  it("a project administrator and the company owner manage; a reader reads and a reader's change is Code's 403 in its fixed words", async () => {
    const w = setUp();
    const pam = await w.as("pam-token"), ada = await w.as("ada-token");
    expect((await w.send("GET", P("payments", "wiki-build"), pam)).body).toMatchObject({ canManage: false });
    expect((await w.send("GET", P("billing", "wiki-build"), ada)).body).toMatchObject({ canManage: true });
    for (const [path, , body] of POSTS) {
      const res = await w.send("POST", P("payments", path), pam, body);
      expect({ status: res.status, message: error(res).message }, path).toEqual({ status: 403, message: WIKI_SETUP_CODE_WORDS.notAllowed });
    }
    const map = await w.send("POST", P("payments", "wiki-map"), pam, {});
    expect({ status: map.status, message: error(map).message }).toEqual({ status: 403, message: WIKI_SETUP_CODE_WORDS.mapNotAllowed });
    const up = await w.send("PUT", P("payments", "upkeep"), pam, { requestId: RID, on: true });
    expect(asRefusal(up)).toEqual(refusal("upkeepNotAllowed"));
  });

  it("a person with a role on payments only learns nothing about billing; another company's project reads the same fixed 404; a person in no company never reaches the wiki routes", async () => {
    const w = setUp();
    const pam = await w.as("pam-token"), bob = await w.as("bob-token"), nob = await w.as("nob-token");
    for (const path of ["wiki-map", "wiki-build"]) expect([(await w.send("GET", P("payments", path), nob)).status, (await w.send("POST", P("payments", path), nob, { requestId: RID })).status]).toEqual([403, 403]);
    const seen = new Set<string>();
    for (const [headers, project] of [[pam, "billing"], [pam, "ledger"], [bob, "payments"]] as const) {
      for (const path of ["wiki-map", "wiki-build"]) {
        const res = await w.send("GET", P(project, path), headers);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain(LEAK);
        seen.add(res.text);
      }
      const post = await w.send("POST", P(project, "wiki-build"), headers, { requestId: RID });
      expect(post.status).toBe(404);
      expect(post.text).not.toContain(LEAK);
      seen.add(post.text);
    }
    expect(seen.size).toBe(1);
    // A person Code names no company for never reaches the wiki routes.
    expect(w.codeCalls().filter((call) => call.authorization === "Bearer nob-token" && call.path.includes("wiki"))).toHaveLength(0);
  });

  it("Cloud's session never decides: the company is Code's live answer (the stored sign-in names company A as owner for everyone)", async () => {
    const w = setUp();
    const res = await w.send("POST", P("ledger", "wiki-build/stop"), await w.as("pam-token"), { requestId: RID });
    expect(res.status).toBe(404);
  });
});

describe("bodies are rebuilt from known fields (M2 to M5)", () => {
  it("a field Cloud did not promise (a company, role, limit, commit, goal, author) is refused before Code is asked", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    const extras = [{ company: A }, { role: "owner" }, { limits: { budgetCents: 999_999 } }, { budgetCents: 100 }, { commit: "a".repeat(40) }, { goal: "write secrets" }, { payer: "person" }, { personId: ID("a") }];
    for (const extra of extras) {
      for (const [path, , body] of POSTS) expect(asRefusal(await w.send("POST", P("payments", path), headers, { ...body, ...extra })), `${path} ${JSON.stringify(extra)}`).toEqual(refusal("invalid"));
      expect(asRefusal(await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: true, ...extra }))).toEqual(refusal("invalid"));
    }
    expect(asRefusal(await w.send("POST", P("payments", "wiki-map"), headers, { company: A }))).toEqual(refusal("invalid"));
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("a request id that is not a uuid, a missing one, a non-boolean switch, and a body that is not an object are refused", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    for (const body of [{}, { requestId: "x" }, { requestId: 5 }, { requestId: RID.toUpperCase().replace(/-/gu, "") }]) expect(asRefusal(await w.send("POST", P("payments", "wiki-build/stop"), headers, body))).toEqual(refusal("invalid"));
    for (const on of ["true", 1, null]) expect(asRefusal(await w.send("POST", P("payments", "wiki-build/agents"), headers, { requestId: RID, on }))).toEqual(refusal("invalid"));
    expect(asRefusal(await w.send("POST", P("payments", "wiki-build/agents"), headers, { requestId: RID }))).toEqual(refusal("invalid"));
    expect(asRefusal(await w.send("POST", P("payments", "wiki-build/stop"), headers, "[1]"))).toEqual(refusal("invalid"));
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("the start body's notes and chips are bounded: 2,000 characters, no control characters, at most 200 unique short chip ids; blank notes are dropped", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    const start = (body: Record<string, unknown>) => w.send("POST", P("payments", "wiki-build"), headers, { requestId: RID, ...body });
    for (const bad of [{ notes: "x".repeat(2_001) }, { notes: "bad\u0007note" }, { notes: "zero​width" }, { notes: 5 }, { chipsOn: "all" }, { chipsOn: ["a", "a"] }, { chipsOn: ["x".repeat(81)] }, { chipsOn: Array.from({ length: 201 }, (_, i) => `c${String(i)}`) }, { chipsOn: [5] }, { chipsOn: ["bad\nid"] }]) {
      expect(asRefusal(await start(bad)), JSON.stringify(bad).slice(0, 60)).toEqual(refusal("invalid"));
    }
    expect(w.codeCalls()).toHaveLength(0);
    expect((await start({ notes: "x".repeat(2_000), chipsOn: Array.from({ length: 200 }, (_, i) => `c${String(i)}`) })).status).toBe(200);
    expect((await start({ notes: "  \n " })).status).toBe(200);
    expect((await start({ notes: "two\nlines" })).status).toBe(200);
    const sent = w.codeCalls().filter((call) => call.method !== "GET").map((call) => call.body as any);
    expect(sent[1]).toEqual({ requestId: RID });
    expect(sent[2].notes).toBe("two\nlines");
  });
});

describe("no dollar figure, task id or commit reaches the app (M6, M7)", () => {
  it("positive control: Code sent them; the answer carries none of them, on every route that answers the build state", async () => {
    const w = setUp();
    const headers = await w.as("mia-token");
    const answers = [await w.send("GET", P("payments", "wiki-build"), headers), ...(await Promise.all(POSTS.map(([path, , body]) => w.send("POST", P("payments", path), headers, body))))];
    const deleted = await w.send("POST", P("payments", "wiki-build/delete"), headers, { requestId: RID });
    for (const answer of [...answers, deleted]) {
      expect(answer.status).toBe(200);
      for (const word of ["budgetCents", "spentCents", "pageReserveCents", "wallClockMin", "taskId", "task-secret-id", "payer", "617", "2500"]) expect(answer.text, word).not.toContain(word);
      expect(answer.body.limits ?? answer.body.view?.limits).toEqual({ pages: 300 });
    }
    const raw = buildView(true);
    expect(JSON.stringify(raw)).toContain("spentCents");
  });

  it("the file map carries pages and no price, commit, branch, address, language list or area list; a forecast that carries a price is refused", async () => {
    const w = setUp();
    const map = await w.send("GET", P("payments", "wiki-map"), await w.as("mia-token"));
    for (const word of ["price", "commit", "branch", "https://", "languages", "areas", "testFolders", "limits"]) expect(map.text, word).not.toContain(word);
    expect(map.body.map.forecast).toEqual({ repositories: 1, files: 1200, pages: 24, pagesCapped: false, complete: true });
    const priced = setUp((call) => (call.path.endsWith("/wiki-map") ? json(200, { status: "ready", canManage: true, map: mapOf("payments", { forecast: { repositories: 1, files: 1200, pages: 24, pagesCapped: false, complete: true, price: "$4 to $9" } }) }) : undefined));
    expect(asRefusal(await priced.send("GET", P("payments", "wiki-map"), await priced.as("ada-token")))).toEqual(refusal("unavailable"));
  });
});

describe("an answer that does not read is not shown at all, whatever else it says (M7 to M10)", () => {
  const bad: Array<[string, (view: Record<string, any>) => Record<string, any>]> = [
    ["payer is a person", (v) => ({ ...v, payer: "person" })], ["no payer", (v) => { const { payer, ...rest } = v; void payer; return rest; }], ["unknown status", (v) => ({ ...v, status: "paused" })], ["unknown end word", (v) => ({ ...v, stop: "angry" })],
    ["a sentence Code never fixed", (v) => ({ ...v, message: `Pay now ${LEAK}` })], ["a different connect-key sentence", (v) => ({ ...v, connectKey: "Send your key here" })], ["unknown ai key state", (v) => ({ ...v, aiKey: "maybe" })],
    ["limits off", (v) => ({ ...v, limits: { ...v["limits"], pages: 301 } })], ["page counts negative", (v) => ({ ...v, wiki: { pages: -1, refreshPages: 0 } })], ["summary not whole", (v) => ({ ...v, summary: { ...v["summary"], claimsKept: 1.5 } })],
    ["spend not a number", (v) => ({ ...v, summary: { ...v["summary"], spentCents: "free" } })], ["canManage missing", (v) => { const { canManage, ...rest } = v; void canManage; return rest; }], ["agents.on not boolean", (v) => ({ ...v, agents: { on: "yes" } })], ["startedAt not a time", (v) => ({ ...v, startedAt: "yesterday" })],
    ["stoppedBy time is not a time", (v) => ({ ...v, stoppedBy: { name: "Mia", at: "soon" } })],
    ["a control character in the stopper's name is display only: read as a former member", (v) => ({ ...v, stoppedBy: { name: "Mia\u0007", at: "2026-11-17T10:30:00.000Z" } })],
  ];
  it.each(bad)("the build state: %s", async (label, change) => {
    const w = setUp((call) => (call.path.endsWith("/wiki-build") && call.method === "GET" ? json(200, change(buildView(true))) : undefined));
    const res = await w.send("GET", P("payments", "wiki-build"), await w.as("mia-token"));
    if (label.startsWith("a control character")) {
      expect(res.body.stoppedBy.name).toBe("a former member");
      return;
    }
    expect(asRefusal(res), label).toEqual(refusal("unavailable"));
    expect(res.text).not.toContain(LEAK);
  });

  it("the file map: another project, a chip id twice, a partial repository without its words, a hostile path, a missing field", async () => {
    const maps: Array<Record<string, any>> = [
      mapOf("billing"), mapOf("payments", { chips: [mapOf("payments").chips[0], mapOf("payments").chips[0]] }),
      mapOf("payments", { repositories: [{ ...mapOf("payments").repositories[0], status: "partial" }] }), mapOf("payments", { repositories: [{ ...mapOf("payments").repositories[0], skippedFolders: ["bad\nfolder"] }] }),
      mapOf("payments", { repositories: [{ ...mapOf("payments").repositories[0], skipped: { generated: 1 } }] }), mapOf("payments", { computedAt: "now" }),
      mapOf("payments", { chips: [{ ...mapOf("payments").chips[0], kind: "write_everything" }] }), mapOf("payments", { complete: "yes" }),
    ];
    for (const [index, map] of maps.entries()) {
      const w = setUp((call) => (call.path.endsWith("/wiki-map") ? json(200, { status: "ready", canManage: true, map }) : undefined));
      expect(asRefusal(await w.send("GET", P("payments", "wiki-map"), await w.as("ada-token"))), `map ${String(index)}`).toEqual(refusal("unavailable"));
    }
    const none = setUp((call) => (call.path.endsWith("/wiki-map") ? json(200, { status: "none", canManage: false }) : undefined));
    expect((await none.send("GET", P("payments", "wiki-map"), await none.as("ada-token"))).body).toEqual({ status: "none", canManage: false });
    const hidden = setUp((call) => (call.path.endsWith("/wiki-map") ? json(200, { status: "none", canManage: true, map: mapOf("payments") }) : undefined));
    expect(asRefusal(await hidden.send("GET", P("payments", "wiki-map"), await hidden.as("ada-token")))).toEqual(refusal("unavailable"));
  });

  it("drops fields Code did not promise, at every level, and the delete answer must say its fixed sentence", async () => {
    const w = setUp((call) => (call.path.endsWith("/wiki-build") ? json(200, buildView(true, { sneaky: LEAK, summary: { pagesPlanned: 1, pagesWritten: 1, pagesKeptFromEarlier: 0, claimsKept: 1, claimsDropped: 0, spentCents: 5, sneaky: LEAK }, agents: { on: true, sneaky: LEAK } })) : undefined));
    const res = await w.send("GET", P("payments", "wiki-build"), await w.as("mia-token"));
    expect(res.text).not.toContain(LEAK);
    expect(WikiSetupBuildSchema.parse(res.body).agents.on).toBe(true);
    const wrong = setUp((call) => (call.path.endsWith("/delete") ? json(200, { deleted: true, message: `Gone ${LEAK}`, view: buildView(true) }) : undefined));
    expect(asRefusal(await wrong.send("POST", P("payments", "wiki-build/delete"), await wrong.as("mia-token"), { requestId: RID }))).toEqual(refusal("unavailable"));
  });

  it("the rebuild keeps a Code answer that reads, unchanged, for each status", () => {
    for (const status of ["none", "running", "built", "stopped"]) {
      const out = buildAnswer(buildView(true, { status }));
      expect(WikiSetupBuildSchema.parse(out).status).toBe(status);
    }
    expect(mapViewAnswer({ status: "ready", canManage: false, map: mapOf("payments") }, "payments")).toMatchObject({ status: "ready", canManage: false });
  });
});

describe("Code's failures (M11, M13, M14)", () => {
  it("Code's unknown-route 404 reads 'not on this Rovara yet' on every route; the upkeep seam has its own words", async () => {
    for (const [method, path, body] of [["GET", "wiki-map", undefined], ["POST", "wiki-map", {}], ["GET", "wiki-build", undefined], ...POSTS.map(([p, , b]) => ["POST", p, b] as const), ["POST", "wiki-build/delete", { requestId: RID }]] as const) {
      const w = setUp((call) => (call.path.includes("/wiki-") ? err(404, "NOT_FOUND", "route not found") : undefined));
      const res = await w.send(method, P("payments", path), await w.as("ada-token"), body);
      expect(asRefusal(res), `${method} ${path}`).toEqual(refusal("notYet"));
    }
    for (const [method, body] of [["GET", undefined], ["PUT", { requestId: RID, on: true }]] as const) {
      const w = setUp((call) => (call.path.endsWith("/upkeep") ? err(404, "NOT_FOUND", "route not found") : undefined));
      expect(asRefusal(await w.send(method, P("payments", "upkeep"), await w.as("ada-token"), body))).toEqual(refusal("upkeepNotYet"));
    }
  });

  it("Code's fixed sentences pass with their status and code; any other text, code or status reads Cloud's words and never Code's text", async () => {
    for (const [status, code, key] of [[409, "WORKSPACE_BUSY", "busy"], [402, "BUDGET_EXCEEDED", "raiseCap"], [503, "MODEL_PROXY_UNAVAILABLE", "connectKey"], [400, "CONFIG_INVALID", "noMap"], [409, "WORKSPACE_BUSY", "deleteWhileRunning"], [503, "AUDIT_UNAVAILABLE", "auditUnavailable"], [400, "CONFIG_INVALID", "nothingToRefresh"]] as const) {
      const w = setUp((call) => (call.path.includes("/wiki-build") ? err(status, code, WIKI_SETUP_CODE_WORDS[key]) : undefined));
      const res = await w.send("POST", P("payments", "wiki-build"), await w.as("mia-token"), { requestId: RID });
      expect({ status: res.status, code: error(res).code, message: error(res).message }, key).toEqual({ status, code, message: WIKI_SETUP_CODE_WORDS[key] });
    }
    const table: Array<[number, string, string, keyof typeof WIKI_SETUP_ANSWERS]> = [
      [403, "FORBIDDEN", LEAK, "notAllowed"], [400, "CONFIG_INVALID", LEAK, "invalid"], [404, "NOT_FOUND", LEAK, "notFound"], [409, "WORKSPACE_BUSY", LEAK, "unavailable"], [500, "X", LEAK, "unavailable"], [503, "RUNTIME_UNAVAILABLE", LEAK, "unavailable"],
      // A known sentence with a code or status Cloud does not pass is not passed either.
      [500, "FORBIDDEN", WIKI_SETUP_CODE_WORDS.busy, "unavailable"], [403, "SECRET_CODE", WIKI_SETUP_CODE_WORDS.busy, "notAllowed"],
    ];
    for (const [status, code, message, key] of table) {
      const w = setUp((call) => (call.path.includes("/wiki-build") ? err(status, code, message) : undefined));
      const res = await w.send("POST", P("payments", "wiki-build"), await w.as("mia-token"), { requestId: RID });
      expect(asRefusal(res), `${String(status)} ${code}`).toEqual(refusal(key));
      expect(res.text).not.toContain(LEAK);
    }
    const mapRefused = setUp((call) => (call.path.endsWith("/wiki-map") ? err(403, "FORBIDDEN", LEAK) : undefined));
    const refusedMap = await mapRefused.send("POST", P("payments", "wiki-map"), await mapRefused.as("mia-token"), {});
    expect({ status: refusedMap.status, message: error(refusedMap).message }).toEqual({ status: 403, message: WIKI_SETUP_CODE_WORDS.mapNotAllowed });
    expect(refusedMap.text).not.toContain(LEAK);
    const noStarter = setUp((call) => (call.path.endsWith("/wiki-build") && call.method === "POST" ? err(404, "NOT_FOUND", "building the wiki is not set up in this deployment") : undefined));
    expect(asRefusal(await noStarter.send("POST", P("payments", "wiki-build"), await noStarter.as("mia-token"), { requestId: RID }))).toEqual(refusal("notSetUp"));
  });

  it("the upkeep answer passes Code's `available` through when it is sent, and leaves it out when it is not (DEC 254zzl P0)", async () => {
    const yes = setUp((call) => (call.path.endsWith("/upkeep") ? json(200, { enabled: false, canManage: true, available: true }) : undefined));
    expect(WikiSetupUpkeepSchema.parse((await yes.send("GET", P("payments", "upkeep"), await yes.as("ada-token"))).body)).toEqual({ enabled: false, canManage: true, available: true });
    const no = setUp((call) => (call.path.endsWith("/upkeep") ? json(200, { enabled: false, canManage: true, available: false }) : undefined));
    expect(WikiSetupUpkeepSchema.parse((await no.send("GET", P("payments", "upkeep"), await no.as("ada-token"))).body)).toEqual({ enabled: false, canManage: true, available: false });
    const absent = setUp((call) => (call.path.endsWith("/upkeep") ? json(200, { enabled: false, canManage: true }) : undefined));
    expect((await absent.send("GET", P("payments", "upkeep"), await absent.as("ada-token"))).body).toEqual({ enabled: false, canManage: true });
  });

  it("the upkeep seam answers Cloud's own words for Code's refusals, never Code's text", async () => {
    for (const [status, key] of [[403, "upkeepNotAllowed"], [404, "notFound"], [400, "invalid"], [500, "upkeepUnavailable"], [409, "upkeepUnavailable"]] as const) {
      const w = setUp((call) => (call.path.endsWith("/upkeep") ? err(status, "X", LEAK) : undefined));
      const res = await w.send("PUT", P("payments", "upkeep"), await w.as("mia-token"), { requestId: RID, on: true });
      expect(asRefusal(res), String(status)).toEqual(refusal(key));
      expect(res.text).not.toContain(LEAK);
    }
    const odd = setUp((call) => (call.path.endsWith("/upkeep") ? json(200, { enabled: "yes", canManage: true }) : undefined));
    expect(asRefusal(await odd.send("GET", P("payments", "upkeep"), await odd.as("ada-token")))).toEqual(refusal("upkeepUnavailable"));
  });

  it("wikiSetupRefusal is a pure function of status and Code's fixed words", () => {
    expect(wikiSetupRefusal("build", new CodeError(404, { error: { code: "NOT_FOUND", message: "route not found" } })).status).toBe(501);
    expect(wikiSetupRefusal("build", new CodeError(500, "<html>" + LEAK)).status).toBe(503);
  });

  it("a Code body that is not JSON is 'couldn't be read', not a crash", async () => {
    const w = setUp((call) => (call.path.endsWith("/wiki-build") ? new Response("<html>oops " + LEAK + "</html>", { status: 200, headers: { "content-type": "text/html" } }) : undefined));
    const res = await w.send("GET", P("payments", "wiki-build"), await w.as("ada-token"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(LEAK);
  });

  it("a read answers sign-in-ended and a dispatched write stays unknown when renewal ends, on every route", async () => {
    for (const [method, path, body] of [["GET", "wiki-map", undefined], ["POST", "wiki-build", { requestId: RID }], ["GET", "upkeep", undefined]] as const) {
      const w = setUp((call) => (call.path.startsWith("/v1/app/projects/") ? json(401, { error: { code: "AUTH_REQUIRED", message: LEAK } }) : undefined));
      const res = await w.send(method, P("payments", path), await w.as("ada-token"), body);
      // The safety rule: a WRITE that reached Code before its 401 has an unknown outcome (503) and is sent exactly once;
      // if no write reached Code (only reads were sent), renewal ending the sign-in answers the ordinary sign-in-ended 401.
      const writes = w.codeCalls().filter((call) => call.method !== "GET" && call.method !== "HEAD" && !call.path.startsWith("/v1/auth/"));
      if (writes.length > 0) {
        expect(res.status, path).toBe(503);
        expect(res.text).toMatch(/outcome.*unknown.*check.*status/iu);
        expect(writes, path).toHaveLength(1);
      } else {
        expect(res.status, path).toBe(401);
      }
      expect(res.text).not.toContain(LEAK);
      expect(await w.store.get("cookie-ada-token"), path).toBeUndefined();
    }
  });
});

// ---- L4-W6b: the consent step -----------------------------------------------------------------------------------------------------------------------------------------------------------
const CODE_CONSENT = {
  notAllowed: "Only company owners and admins can allow or stop Rovara's automatic runs for the company.",
  needsConsent: "A company owner or admin has to allow Rovara's automatic runs for the company first.",
};
const VIEW = { enabled: false, canManage: true, available: true, systemRunsOn: false, canEnableSystemRuns: true, cap: { monthlyUsd: null, canRaise: true } };
const upkeepWorld = (answer: (call: CodeCall) => Response) => setUp((call) => (call.path.endsWith("/upkeep") ? answer(call) : undefined));
const putCalls = (w: ReturnType<typeof setUp>) => w.codeCalls().filter((call) => call.method === "PUT");

describe("the setup choice needs no step-up (L4-P3; owner DEC 254zzz73)", () => {
  const SIGN_IN = "Rovara's automatic runs are allowed right after you confirm it's you on the sign-in page: a tool that holds an API token cannot allow them. Confirm it's you, then try again within a few minutes.";
  // MUTANT T2: Code's sentence is passed on instead of Cloud's own.
  it("any 403 from Code on the setup PUT (whatever its code) is Cloud's 'not allowed' sentence, and nothing of Code's text", async () => {
    for (const code of ["REAUTH_REQUIRED", "FORBIDDEN"]) {
      for (const words of [SIGN_IN, LEAK]) {
        const w = setUp((call) => (call.path.endsWith("/upkeep") && call.method === "PUT" ? err(403, code, words) : undefined));
        const res = await w.send("PUT", P("payments", "upkeep"), await w.as("ada-token"), { requestId: RID, on: true, allowSystemRuns: true });
        expect(res.body.error).toEqual({ code: "FORBIDDEN", message: APP_WORDS.upkeepNotAllowed });
        expect(res.text).not.toContain("API token");
        expect(res.text).not.toContain(LEAK);
      }
    }
  });
});

// L4-CAPR: Code's new `spend` ({month, spentUsd, runs, unknownRuns}) passes through, rebuilt field by field, for a person who manages the project only. Mutants (each killed by the named test): S1 Code's extra
// spend members passed; S2 spend passed to a reader; S3 a bad spend (negative dollars, a bad month, fractional runs) passed on; S4 a missing spend invented; S5 spend members renamed or coerced.
describe("the upkeep spend pass-through (L4-CAPR)", () => {
  const SPEND = { month: "2026-11", spentUsd: 3.5, runs: 4, unknownRuns: 1 };
  it("passes the four members for a manager and nothing else Code adds (S1, S5)", async () => {
    const w = upkeepWorld(() => json(200, { ...VIEW, spend: { ...SPEND, taskId: "task-secret", ledger: "SECRET-LEDGER" } }));
    const res = await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.body.spend).toEqual(SPEND);
    expect(WikiSetupUpkeepSchema.parse(res.body)).toEqual(res.body);
    expect(res.text).not.toMatch(/SECRET|task-secret/u);
    // The PUT answer carries it the same way.
    const put = upkeepWorld(() => json(200, { ...VIEW, spend: SPEND }));
    expect((await put.send("PUT", P("payments", "upkeep"), await put.as("ada-token"), { requestId: RID, on: true })).body.spend).toEqual(SPEND);
  });
  it("zero spend and zero runs are real answers, not absent (S5)", async () => {
    const zero = { month: "2026-11", spentUsd: 0, runs: 0, unknownRuns: 0 };
    const w = upkeepWorld(() => json(200, { ...VIEW, spend: zero }));
    expect((await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"))).body.spend).toEqual(zero);
  });
  it("a reader never gets the spend, even if Code sent it (S2), and a reader's answer is otherwise as before", async () => {
    const w = upkeepWorld(() => json(200, { ...VIEW, canManage: false, spend: SPEND }));
    const res = await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect("spend" in res.body).toBe(false);
    expect(res.body).toEqual({ ...VIEW, canManage: false });
  });
  it("no spend from Code, none made up (S4)", async () => {
    const w = upkeepWorld(() => json(200, VIEW));
    expect("spend" in (await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"))).body).toBe(false);
  });
  it("a spend that does not read is 'couldn't be read', in fixed words (S3)", async () => {
    const bad: unknown[] = [
      null, "3.5", [], {}, { ...SPEND, spentUsd: -0.01 }, { ...SPEND, spentUsd: "3.5" }, { ...SPEND, spentUsd: 1e12 }, { ...SPEND, spentUsd: null }, { ...SPEND, month: "2026-13" }, { ...SPEND, month: "2026-00" }, { ...SPEND, month: "2026-1" }, { ...SPEND, month: 202611 },
      { ...SPEND, runs: 1.5 }, { ...SPEND, runs: -1 }, { ...SPEND, unknownRuns: "1" }, { ...SPEND, runs: undefined }, { month: SPEND.month, spentUsd: 1, runs: 1 },
    ];
    for (const one of bad) {
      const w = upkeepWorld(() => json(200, { ...VIEW, spend: one }));
      const res = await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"));
      expect(asRefusal(res), JSON.stringify(one)).toEqual(refusal("upkeepUnavailable"));
    }
  });
});

describe("the upkeep consent step (L4-W6b)", () => {
  it("GET rebuilds Code's answer field by field: the three new members pass, anything else Code adds does not (R4, R9)", async () => {
    const w = upkeepWorld(() => json(200, { ...VIEW, secretBalanceUsd: 4242, taskId: "task-secret", cap: { monthlyUsd: 25, canRaise: false, ledger: "SECRET-LEDGER" } }));
    const res = await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...VIEW, cap: { monthlyUsd: 25, canRaise: false } });
    expect(WikiSetupUpkeepSchema.parse(res.body)).toEqual(res.body);
    expect(res.text).not.toMatch(/SECRET|4242|task-secret/u);
    // Code omitting a member is not turned into an answer: nothing is invented (a Code without the consent step, L4-N1).
    const old = upkeepWorld(() => json(200, { enabled: true, canManage: true, available: true }));
    expect((await old.send("GET", P("payments", "upkeep"), await old.as("ada-token"))).body).toEqual({ enabled: true, canManage: true, available: true });
    const partial = upkeepWorld(() => json(200, { enabled: false, canManage: true, available: true, systemRunsOn: false }));
    const got = (await partial.send("GET", P("payments", "upkeep"), await partial.as("ada-token"))).body;
    expect(got).toEqual({ enabled: false, canManage: true, available: true, systemRunsOn: false });
    expect("canEnableSystemRuns" in got).toBe(false);
  });

  it("a null cap stays null (no number is made up) and a stated number passes as it is (R6)", async () => {
    const none = upkeepWorld(() => json(200, VIEW));
    expect((await none.send("GET", P("payments", "upkeep"), await none.as("ada-token"))).body.cap).toEqual({ monthlyUsd: null, canRaise: true });
    const zero = upkeepWorld(() => json(200, { ...VIEW, cap: { monthlyUsd: 0, canRaise: true } }));
    expect((await zero.send("GET", P("payments", "upkeep"), await zero.as("ada-token"))).body.cap).toEqual({ monthlyUsd: 0, canRaise: true });
  });

  it("an answer that does not read is 'couldn't be read', in fixed words (R5)", async () => {
    const bad: unknown[] = [
      { ...VIEW, systemRunsOn: "yes" }, { ...VIEW, canEnableSystemRuns: 1 }, { ...VIEW, cap: "25" }, { ...VIEW, cap: null }, { ...VIEW, cap: { monthlyUsd: -1, canRaise: true } },
      { ...VIEW, cap: { monthlyUsd: 1_000_001, canRaise: true } }, { ...VIEW, cap: { monthlyUsd: "25", canRaise: true } }, { ...VIEW, cap: { monthlyUsd: 25 } }, { ...VIEW, cap: { monthlyUsd: undefined, canRaise: true } },
      { ...VIEW, cap: [] },
    ];
    for (const one of bad) {
      const w = upkeepWorld(() => json(200, one));
      const res = await w.send("GET", P("payments", "upkeep"), await w.as("ada-token"));
      expect(asRefusal(res), JSON.stringify(one)).toEqual(refusal("upkeepUnavailable"));
    }
  });

  it("PUT sends Code the request id, the choice and, only when the page sent it, allowSystemRuns (R1, R10)", async () => {
    const w = upkeepWorld((call) => json(200, { ...VIEW, enabled: (call.body as any).on, systemRunsOn: true }));
    const headers = await w.as("ada-token");
    expect((await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: true, allowSystemRuns: true })).status).toBe(200);
    expect((await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: false })).status).toBe(200);
    expect((await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: false, allowSystemRuns: false })).status).toBe(200);
    expect(putCalls(w).map((call) => call.body)).toEqual([{ requestId: RID, on: true, allowSystemRuns: true }, { requestId: RID, on: false }, { requestId: RID, on: false, allowSystemRuns: false }]);
    expect(putCalls(w).map((call) => call.path)).toEqual(Array(3).fill("/v1/app/projects/payments/upkeep"));
  });

  it("PUT bodies outside the allow-list are refused before Code is asked (R1, R2, R3)", async () => {
    const w = upkeepWorld(() => json(200, VIEW));
    const headers = await w.as("ada-token");
    const refused: unknown[] = [
      { requestId: RID, on: true, allowSystemRuns: true, companyId: A }, { requestId: RID, on: true, monthlyUsd: 500 }, { requestId: RID, on: true, cap: { monthlyUsd: 500 } },
      { requestId: RID, on: true, allowSystemRuns: "yes" }, { requestId: RID, on: true, allowSystemRuns: 1 }, { requestId: RID, on: true, allowSystemRuns: null },
      { requestId: RID, on: true, allowSystemRuns: false }, { requestId: RID, allowSystemRuns: true }, { requestId: RID, on: "true" }, { on: true, allowSystemRuns: true },
      { requestId: "not-a-uuid", on: true }, [], '"text"', "null",
    ];
    for (const body of refused) {
      const res = await w.send("PUT", P("payments", "upkeep"), headers, body);
      expect(asRefusal(res), JSON.stringify(body)).toEqual(refusal("invalid"));
    }
    expect(putCalls(w)).toHaveLength(0);
    expect((await w.send("PUT", P("payments", "upkeep") + "?x=1", headers, { requestId: RID, on: true })).status).toBe(400);
    expect(putCalls(w)).toHaveLength(0);
  });

  it("Code's consent words (and 'not available here') become Cloud's own words; no other text of Code's gets through (R7, R8)", async () => {
    const cases: Array<[number, string, string, keyof typeof WIKI_SETUP_ANSWERS]> = [
      [403, "FORBIDDEN", CODE_CONSENT.needsConsent, "upkeepNeedsConsent"], [403, "FORBIDDEN", CODE_CONSENT.notAllowed, "upkeepConsentNotAllowed"], [403, "FORBIDDEN", LEAK, "upkeepNotAllowed"],
      [409, "NOT_AVAILABLE_HERE", "Nightly upkeep isn't available on this Rovara yet. " + LEAK, "upkeepNotYet"], [501, "NOT_AVAILABLE_HERE", LEAK, "upkeepNotYet"],
      [400, "CONFIG_INVALID", LEAK, "invalid"], [503, "RUNTIME_UNAVAILABLE", LEAK, "upkeepUnavailable"],
    ];
    for (const [status, code, message, key] of cases) {
      const w = upkeepWorld(() => err(status, code, message));
      const res = await w.send("PUT", P("payments", "upkeep"), await w.as("mia-token"), { requestId: RID, on: true });
      expect(asRefusal(res), `${status} ${code} ${message}`).toEqual(refusal(key));
      expect(res.text).not.toContain(LEAK);
    }
    // The consent words are Cloud's own and are known sentences of the panel (the page may show them).
    expect(WIKI_SETUP_SENTENCES.has(WIKI_SETUP_WORDS.upkeepNeedsConsent)).toBe(true);
    expect(WIKI_SETUP_SENTENCES.has(WIKI_SETUP_WORDS.upkeepConsentNotAllowed)).toBe(true);
    // The same words on a 403 from another status are not the consent step.
    const other = upkeepWorld(() => err(409, "FORBIDDEN", CODE_CONSENT.needsConsent));
    expect(asRefusal(await other.send("PUT", P("payments", "upkeep"), await other.as("mia-token"), { requestId: RID, on: true }))).toEqual(refusal("upkeepUnavailable"));
  });

  it("two companies: another company's person, or another company's project, is the same 404 and nothing of the consent crosses (R12)", async () => {
    const w = upkeepWorld((call) => {
      const project = /projects\/([^/]+)\//u.exec(call.path)![1]!;
      const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")]!;
      if (standing(person, project) === undefined) return err(404, "NOT_FOUND", `project not found ${LEAK}`);
      return json(200, { ...VIEW, enabled: call.method === "PUT" ? (call.body as any).on : false, systemRunsOn: call.method === "PUT" });
    });
    const body = { requestId: RID, on: true, allowSystemRuns: true };
    const ada = await w.as("ada-token"), bob = await w.as("bob-token");
    expect((await w.send("PUT", P("payments", "upkeep"), ada, body)).body.systemRunsOn).toBe(true);
    expect(asRefusal(await w.send("PUT", P("payments", "upkeep"), bob, body))).toEqual(refusal("notFound"));
    expect(asRefusal(await w.send("GET", P("payments", "upkeep"), bob))).toEqual(refusal("notFound"));
    expect(asRefusal(await w.send("PUT", P("ledger", "upkeep"), ada, body))).toEqual(refusal("notFound"));
    expect((await w.send("PUT", P("ledger", "upkeep"), bob, body)).status).toBe(200);
    // Each ask carried its own person's token and only the path's project.
    expect(w.codeCalls().map((call) => [call.method, call.path, call.authorization])).toEqual([
      ["PUT", "/v1/app/projects/payments/upkeep", "Bearer ada-token"], ["PUT", "/v1/app/projects/payments/upkeep", "Bearer bob-token"], ["GET", "/v1/app/projects/payments/upkeep", "Bearer bob-token"],
      ["PUT", "/v1/app/projects/ledger/upkeep", "Bearer ada-token"], ["PUT", "/v1/app/projects/ledger/upkeep", "Bearer bob-token"],
    ]);
    expect(JSON.stringify((await w.send("PUT", P("payments", "upkeep"), bob, body)).body)).not.toContain(LEAK);
  });

  it("the log says only that the setup step or the switch was used, and where (R11)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const w = upkeepWorld(() => json(200, VIEW));
    const headers = await w.as("ada-token");
    await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: true, allowSystemRuns: true });
    await w.send("PUT", P("payments", "upkeep"), headers, { requestId: RID, on: false });
    const mine = lines.filter((one) => one.includes("cloud.wiki_setup")).map((one) => JSON.parse(one));
    expect(mine).toEqual([{ event: "cloud.wiki_setup", action: "upkeep_setup", project: "payments" }, { event: "cloud.wiki_setup", action: "upkeep_switch", project: "payments" }]);
  });
});

describe("the logs say what was done, never what the person wrote (M16)", () => {
  it("one line per change: the action and the project; the notes, chips and request id are not in it", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const w = setUp();
    const headers = await w.as("mia-token");
    await w.send("POST", P("payments", "wiki-build"), headers, { requestId: RID, notes: "SECRET-NOTE-WORDS", chipsOn: ["skip-generated-dist"] });
    await w.send("GET", P("payments", "wiki-build"), headers);
    const mine = lines.filter((one) => one.includes("cloud.wiki_setup"));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]!)).toEqual({ event: "cloud.wiki_setup", action: "build", project: "payments" });
    expect(lines.join("\n")).not.toContain("SECRET-NOTE-WORDS");
    expect(lines.join("\n")).not.toContain(RID);
  });
});
