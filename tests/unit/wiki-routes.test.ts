/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the tests break a plain JSON answer at a path, which a typed answer would not allow */
// Lead 4 slice W5: the project Wiki tab's three reads through Cloud's handler, answered from Code's wiki read routes (slice W2) as the signed-in person.
// The pretend Code keeps two companies and three projects and applies Code's rule (a role on THAT project, in the project's own company; a company owner or admin
// reads every project of their company): `billing` is a second project of company A that "pam" has no role on, and `ledger` belongs to company B.
// Cloud must: pass the person's own token, put the project and page id only into Code's path, forward nothing else, rebuild Code's
// answers field by field for THIS project and page, refuse an answer that does not read, and answer refusals in fixed words (no echo of input or of Code's text).
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, WIKI_ANSWERS, WIKI_WORDS, createCloudHandler, indexAnswer, pageAnswer, sourcesAnswer, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import {
  WIKI_COMMIT_PATTERN, WIKI_ID_PATTERN, WIKI_LIMITS, WIKI_PAGE_ID_PATTERN, WIKI_PAGE_NOT_FOUND, WIKI_PROJECT_NOT_FOUND, WIKI_PROJECT_PATTERN, WIKI_TRUST_LINE, WIKI_UNAVAILABLE, WIKI_WORDS as APP_WORDS,
  WikiIndexResponseSchema, WikiPageResponseSchema, WikiSourcesResponseSchema,
} from "../../packages/contracts/src/app-wiki.js";
import { wikiIndex, wikiPage, wikiSources } from "../support/wiki-fixture.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64), PAM = "b".repeat(64), BOB = "c".repeat(64), NOB = "d".repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ADA, company: A, role: "owner", grants: {} },
  "pam-token": { id: PAM, company: A, role: "member", grants: { payments: "developer" } },
  "bob-token": { id: BOB, company: B, role: "admin", grants: {} },
  "nob-token": { id: NOB, grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, billing: A, ledger: B };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string> }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers };
    calls.push(call);
    const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    const match = /^\/v1\/app\/projects\/([^/]+)\/wiki(?:\/pages\/([^/]+)(\/sources)?)?$/u.exec(url.pathname);
    if (match === null) return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const project = decodeURIComponent(match[1]!);
    const admin = person.role === "owner" || person.role === "admin";
    if (person.company === undefined || PROJECTS[project] !== person.company || (!admin && person.grants[project] === undefined)) return json(404, { error: { code: "NOT_FOUND", message: `project not found ${LEAK}` } });
    if (match[2] === undefined) return json(200, wikiIndex(project));
    const id = decodeURIComponent(match[2]);
    const one = match[3] === undefined ? wikiPage(project, id) : wikiSources(project, id);
    return one === undefined ? json(404, { error: { code: "NOT_FOUND", message: `page not found ${LEAK}` } }) : json(200, one);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const as = async (token: string) => {
    const person = PEOPLE[token] ?? { id: "f".repeat(64), grants: {} };
    // The stored sign-in names company A as owner for everyone: Cloud must use Code's live answer, never this.
    const access = { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: string, target: string, headers: Record<string, string>) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown, text: answered!.body };
  };
  const codeCalls = () => calls.filter((call) => call.path !== "/v1/dev/access");
  return { as, send, calls, codeCalls, store };
}
const words = (answer: { body: unknown }) => (answer.body as { error: { code: string; message: string } }).error;
const refusal = (key: keyof typeof WIKI_ANSWERS) => ({ status: WIKI_ANSWERS[key].status, error: (WIKI_ANSWERS[key].body as { error: unknown }).error });
const asRefusal = (answer: { status: number; body: unknown }) => ({ status: answer.status, error: words(answer) });
const INDEX = "/v1/web/projects/payments/wiki", PAGE = "/v1/web/projects/payments/wiki/pages/beacon-api--billing", SOURCES = PAGE + "/sources";
const onIndex = (answerFor: (project: string) => unknown) => (call: CodeCall) => (/\/wiki$/u.test(call.path) ? json(200, answerFor(decodeURIComponent(call.path.split("/")[4]!))) : undefined);
const onPage = (answerFor: (project: string) => unknown) => (call: CodeCall) => (/\/wiki\/pages\/[^/]+$/u.test(call.path) ? json(200, answerFor(decodeURIComponent(call.path.split("/")[4]!))) : undefined);
const onSources = (answerFor: (project: string) => unknown) => (call: CodeCall) => (/\/sources$/u.test(call.path) ? json(200, answerFor(decodeURIComponent(call.path.split("/")[4]!))) : undefined);
const clone = <T,>(value: T) => structuredClone(value) as unknown as Record<string, any>;


describe("the fixed words and limits", () => {
  it("are the same in Cloud's server and in the app's contracts, and the contract mirrors W2's (07cd73a5f)", () => {
    expect({ ...WIKI_WORDS }).toEqual({ ...APP_WORDS });
    expect(WIKI_PROJECT_NOT_FOUND).toBe("project not found");
    expect(WIKI_PAGE_NOT_FOUND).toBe("That wiki page is not there.");
    expect(WIKI_UNAVAILABLE).toBe("The project wiki could not be read just now. Try again.");
    expect(WIKI_TRUST_LINE).toBe("Written by Rovara from the code. It can be wrong. The code is the truth.");
    expect(WIKI_PAGE_ID_PATTERN.source).toBe("^[a-z0-9][a-z0-9-]{0,119}$");
    expect(WIKI_PROJECT_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,62}$");
    expect(WIKI_ID_PATTERN.source).toBe("^[A-Za-z0-9_-]{4,64}$");
    expect(WIKI_COMMIT_PATTERN.source).toBe("^(?:[a-f0-9]{40}|[a-f0-9]{64})$");
    expect(WIKI_LIMITS).toMatchObject({ pagesPerProject: 300, blocksPerPage: 120, claimsPerPage: 80, citationsPerClaim: 3, claimsPerBlock: 12, reposPerPage: 20, notesPerPage: 50 });
  });
});

describe("the page list", () => {
  it("a person with a role on the project reads it: Code gets their own token and the project only in its path; the answer reads in the app's schema", async () => {
    const w = setUp();
    const res = await w.send("GET", INDEX, { ...await w.as("pam-token"), "x-rovara-company": B });
    expect(res.status).toBe(200);
    const index = WikiIndexResponseSchema.parse(res.body);
    expect(index).toMatchObject({ project: "payments", state: "ready" });
    expect(index.pages.map((page) => page.pageId)).toContain("beacon-api--billing");
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "GET", path: "/v1/app/projects/payments/wiki", search: "", authorization: "Bearer pam-token" })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("a company owner reads every project of their company", async () => {
    const w = setUp();
    const res = await w.send("GET", "/v1/web/projects/billing/wiki", await w.as("ada-token"));
    expect(WikiIndexResponseSchema.parse(res.body)).toMatchObject({ project: "billing" });
  });

  it("two projects of one company: a person with a role on payments only is refused billing, in fixed words that name nothing", async () => {
    const w = setUp();
    const res = await w.send("GET", "/v1/web/projects/billing/wiki", await w.as("pam-token"));
    expect(asRefusal(res)).toEqual(refusal("notFound"));
    expect(res.text).not.toContain(LEAK);
    expect(res.text).not.toContain("billing");
  });

  it("two companies: another company's project is refused for both an owner and a member; a person in no company never reaches Code's wiki", async () => {
    const w = setUp();
    for (const token of ["ada-token", "pam-token"]) {
      const res = await w.send("GET", "/v1/web/projects/ledger/wiki", await w.as(token));
      expect(asRefusal(res)).toEqual(refusal("notFound"));
      expect(res.text).not.toContain(LEAK);
    }
    expect(asRefusal(await w.send("GET", INDEX, await w.as("bob-token")))).toEqual(refusal("notFound"));
    const before = w.codeCalls().length;
    const nob = await w.as("nob-token");
    for (const target of [INDEX, PAGE, SOURCES]) {
      const nobody = await w.send("GET", target, nob);
      expect(nobody.status, target).toBe(403);
      expect(words(nobody).code).toBe("NO_COMPANY");
    }
    expect(w.codeCalls()).toHaveLength(before);
  });

  it("a project name that doesn't read is refused without asking Code, and so is any query", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    expect(asRefusal(await w.send("GET", "/v1/web/projects/Bad..Name/wiki", ada))).toEqual(refusal("notFound"));
    expect(asRefusal(await w.send("GET", "/v1/web/projects/..%2Fledger/wiki", ada))).toEqual(refusal("notFound"));
    expect(asRefusal(await w.send("GET", INDEX + "?project=ledger", ada))).toEqual(refusal("invalid"));
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("an answer for another project, or with a field off, is not shown at all", async () => {
    const good = clone(wikiIndex("payments"));
    const withPage = (change: (page: Record<string, any>) => void) => { const index = clone(good); change(index["pages"][0]); return index; };
    const answers: unknown[] = [
      wikiIndex("ledger"),
      { ...good, state: "weird" },
      withPage((p) => { p["pageId"] = "../x"; }),
      { ...good, pages: [good["pages"][0], good["pages"][0]] },
      withPage((p) => { p["title"] = "bad\u0007title"; }),
      withPage((p) => { p["title"] = "hid\u202Eden"; }),
      withPage((p) => { p["title"] = "line\nbreak"; }),
      withPage((p) => { p["claims"] = { found: -1, changed: 0 }; }),
      withPage((p) => { p["kind"] = "other"; }),
      withPage((p) => { p["writtenAt"] = "yesterday"; }),
      withPage((p) => { p["repos"] = [{ repo: "r", commit: "abc1234" }]; }),
      withPage((p) => { p["flagged"] = "yes"; }),
      { ...good, pages: Array.from({ length: 301 }, (_, n) => ({ ...good["pages"][0], pageId: `page-${String(n)}` })) },
      { ...good, lastBuild: { buildId: "x", kind: "first", state: "done", startedAt: "2026-11-17T00:00:00.000Z" } },
      [good],
    ];
    for (const answer of answers) {
      const w = setUp(onIndex(() => answer));
      expect(asRefusal(await w.send("GET", INDEX, await w.as("ada-token"))), JSON.stringify(answer).slice(0, 60)).toEqual(refusal("unavailable"));
    }
  });

  it("drops fields Code did not promise, at every level", async () => {
    const good = clone(wikiIndex("payments"));
    const w = setUp(onIndex(() => ({ ...good, secret: LEAK, pages: [{ ...good["pages"][0], hidden: LEAK, claims: { ...good["pages"][0].claims, x: LEAK } }], lastBuild: { ...good["lastBuild"], leak: LEAK } })));
    const res = await w.send("GET", INDEX, await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
  });

  it("the rebuild keeps a Code answer that reads, unchanged (ready, and the empty and building states)", () => {
    for (const state of ["ready", "none", "building", "stopped"] as const) {
      const value = wikiIndex("payments", { state });
      expect(indexAnswer(value, "payments"), state).toEqual(value);
      WikiIndexResponseSchema.parse(indexAnswer(value, "payments"));
    }
  });
});

describe("one page", () => {
  it("reads in the app's schema, and Code gets the project and the page id only in its path", async () => {
    const w = setUp();
    const res = await w.send("GET", PAGE, await w.as("pam-token"));
    expect(res.status).toBe(200);
    const page = WikiPageResponseSchema.parse(res.body);
    expect(page).toMatchObject({ project: "payments", page: { pageId: "beacon-api--billing", kind: "module" }, trustLine: WIKI_TRUST_LINE });
    expect(page.page.claims.length).toBeGreaterThan(0);
    expect(w.codeCalls()).toEqual([expect.objectContaining({ path: "/v1/app/projects/payments/wiki/pages/beacon-api--billing", search: "", authorization: "Bearer pam-token" })]);
  });

  it("the rebuild keeps every fixture page that reads, unchanged", () => {
    for (const entry of wikiIndex("payments").pages) {
      const value = wikiPage("payments", entry.pageId)!;
      expect(pageAnswer(value, "payments", entry.pageId), entry.pageId).toEqual(value);
    }
  });

  it("a page of another project is not shown: Code's refusal and an answer naming another project or page both read as fixed words", async () => {
    const w = setUp();
    const pam = await w.as("pam-token");
    for (const target of ["/v1/web/projects/billing/wiki/pages/overview", "/v1/web/projects/ledger/wiki/pages/overview"]) {
      const res = await w.send("GET", target, pam);
      expect(asRefusal(res)).toEqual(refusal("noPage"));
      expect(res.text).not.toContain(LEAK);
      expect(res.text).not.toMatch(/billing|ledger/u);
    }
    for (const answer of [wikiPage("ledger", "beacon-api--billing"), wikiPage("payments", "overview")]) {
      const bad = setUp(onPage(() => answer));
      expect(asRefusal(await bad.send("GET", PAGE, await bad.as("ada-token")))).toEqual(refusal("unavailable"));
    }
  });

  it("a page id that isn't a slug is refused without asking Code", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    for (const id of ["Overview", "a%2Fb", "-x", "x".repeat(121), "a.b", "a%20b", "overview%00", "A", "a_b"]) {
      expect(asRefusal(await w.send("GET", `/v1/web/projects/payments/wiki/pages/${id}`, ada)), id).toEqual(refusal("invalid"));
      expect(asRefusal(await w.send("GET", `/v1/web/projects/payments/wiki/pages/${id}/sources`, ada)), id + " sources").toEqual(refusal("invalid"));
    }
    expect(asRefusal(await w.send("GET", PAGE + "?x=1", ada))).toEqual(refusal("invalid"));
    expect(asRefusal(await w.send("GET", SOURCES + "?x=1", ada))).toEqual(refusal("invalid"));
    // A dot-segment is folded away by the address parser; it names no wiki route, so it never reaches Code either.
    for (const id of ["..", "%2e%2e"]) expect((await w.send("GET", `/v1/web/projects/payments/wiki/pages/${id}`, ada)).status, id).toBeGreaterThanOrEqual(400);
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("an unknown page is one fixed sentence that does not echo the id", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    for (const tail of ["", "/sources"]) {
      const res = await w.send("GET", "/v1/web/projects/payments/wiki/pages/nothing-here" + tail, headers);
      expect(asRefusal(res)).toEqual(refusal("noPage"));
      expect(res.text).not.toContain("nothing-here");
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("an answer that does not read is not shown at all (hostile text, a claim the page lacks, a citation at another commit, bad lines)", async () => {
    const mutate: Array<[string, (page: Record<string, any>) => void]> = [
      ["control character in a paragraph", (p) => { p.page.blocks[1].text = "x\u0000y"; }],
      ["hidden direction character", (p) => { p.page.blocks[1].text = "x\u202Ey"; }],
      ["a heading with a newline", (p) => { p.page.blocks[0].text = "x\ny"; }],
      ["unknown block", (p) => { p.page.blocks[1] = { kind: "script", blockId: "scrp1" }; }],
      ["paragraph names a claim the page lacks", (p) => { p.page.blocks[1].claimIds.push("c-missing"); }],
      ["duplicate block id", (p) => { p.page.blocks[2].blockId = p.page.blocks[1].blockId; }],
      ["too many claims per paragraph", (p) => { p.page.blocks[1].claimIds = Array(13).fill(p.page.claims[0].claimId); }],
      ["duplicate claim id", (p) => { p.page.claims.push({ ...p.page.claims[0] }); }],
      ["claim with no citation", (p) => { p.page.claims[0].citations = []; }],
      ["claim with four citations", (p) => { p.page.claims[0].citations = Array(4).fill(p.page.claims[0].citations[0]); }],
      ["citation at another commit", (p) => { p.page.claims[0].citations[0].commit = "f".repeat(40); }],
      ["citation to a repo the page is not about", (p) => { p.page.claims[0].citations[0].repo = "elsewhere"; }],
      ["citation path walks up", (p) => { p.page.claims[0].citations[0].path = "../../etc/passwd"; }],
      ["citation path is absolute", (p) => { p.page.claims[0].citations[0].path = "/etc/passwd"; }],
      ["lineEnd before line", (p) => { p.page.claims[0].citations[0].lineEnd = 1; }],
      ["line zero", (p) => { p.page.claims[0].citations[0].line = 0; }],
      ["bad source word", (p) => { p.page.claims[0].source = "verified"; }],
      ["short commit", (p) => { p.page.repos[0].commit = "abc1234"; p.page.claims.forEach((c: any) => { c.citations[0].commit = "abc1234"; }); }],
      ["claim text with a control character", (p) => { p.page.claims[0].text = "x\u0007"; }],
      ["too many notes", (p) => { p.notes = Array.from({ length: 51 }, (_, n) => ({ ...p.notes[0], noteId: `note-${String(n)}-xx` })); }],
      ["note with a hidden character", (p) => { p.notes[0].text = "a\u202Eb"; }],
      ["note approval word", (p) => { p.notes[0].approval = "maybe"; }],
      ["note file walks up", (p) => { p.notes[1].file.path = "../x"; }],
      ["wrong trust line", (p) => { p.trustLine = "Verified by Rovara."; }],
      ["negative flags", (p) => { p.openFlags = -1; }],
      ["page kind", (p) => { p.page.kind = "secrets"; }],
      ["no repos", (p) => { p.page.repos = []; }],
      ["no repos and no claims", (p) => { p.page.repos = []; p.page.claims = []; p.page.blocks = [p.page.blocks[0]]; }],
    ];
    for (const [name, change] of mutate) {
      const page = clone(wikiPage("payments", "beacon-api--billing")!);
      change(page);
      const w = setUp(onPage(() => page));
      expect(asRefusal(await w.send("GET", PAGE, await w.as("ada-token"))), name).toEqual(refusal("unavailable"));
    }
  });

  it("a note author's name is display only: an unreadable or very long name reads as 'a former member' or is kept (up to 200), and never refuses the page", async () => {
    const page = clone(wikiPage("payments", "beacon-api--billing")!);
    page.notes[0].author = "Zo\u200Dë";
    page.notes[1].author = "n".repeat(150);
    const w = setUp(onPage(() => page));
    const res = await w.send("GET", PAGE, await w.as("ada-token"));
    expect(res.status).toBe(200);
    const notes = (res.body as { notes: Array<{ author: string }> }).notes;
    expect(notes[0]!.author).toBe("a former member");
    expect(notes[1]!.author).toBe("n".repeat(150));
    expect(res.text).not.toContain("\u200D");
    page.notes[1].author = "n".repeat(201);
    const long = setUp(onPage(() => page));
    expect(((await long.send("GET", PAGE, await long.as("ada-token"))).body as { notes: Array<{ author: string }> }).notes[1]!.author).toBe("a former member");
  });

  it("drops fields Code did not promise, in a page (a quote included: no quote reaches the app)", async () => {
    const page = clone(wikiPage("payments", "overview")!);
    page.secret = LEAK;
    page.page.blocks[1].extra = LEAK;
    page.page.claims[0].citations[0].quote = LEAK;
    page.page.claims[0].quote = LEAK;
    const w = setUp(onPage(() => page));
    const res = await w.send("GET", "/v1/web/projects/payments/wiki/pages/overview", await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
  });
});

describe("a page's cited files", () => {
  it("reads in the app's schema, with Code's path", async () => {
    const w = setUp();
    const res = await w.send("GET", SOURCES, await w.as("pam-token"));
    expect(res.status).toBe(200);
    expect(WikiSourcesResponseSchema.parse(res.body)).toMatchObject({ project: "payments", pageId: "beacon-api--billing" });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ path: "/v1/app/projects/payments/wiki/pages/beacon-api--billing/sources", search: "", authorization: "Bearer pam-token" })]);
  });

  it("a heavily cited file (240 ranges, the most W2 allows) still reads", async () => {
    const value = clone(wikiSources("payments", "beacon-api--billing")!);
    value["files"][0].ranges = Array(240).fill({ line: 1 });
    const w = setUp(onSources(() => value));
    expect((await w.send("GET", SOURCES, await w.as("ada-token"))).status).toBe(200);
  });

  it("another project or company is refused in fixed words", async () => {
    const w = setUp();
    for (const [token, project] of [["pam-token", "billing"], ["ada-token", "ledger"]] as const) {
      const res = await w.send("GET", `/v1/web/projects/${project}/wiki/pages/overview/sources`, await w.as(token));
      expect(asRefusal(res)).toEqual(refusal("noPage"));
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("an answer for another project or page, or with a field off, is not shown", async () => {
    const good = clone(wikiSources("payments", "beacon-api--billing")!);
    const change = (fn: (value: Record<string, any>) => void) => { const v = clone(good); fn(v); return v; };
    for (const answer of [
      wikiSources("ledger", "beacon-api--billing"), wikiSources("payments", "overview"),
      change((v) => { v["files"][0].path = "../x"; }), change((v) => { v["files"][0].commit = "abc"; }), change((v) => { v["files"][0].ranges = [{ line: 5, lineEnd: 1 }]; }),
      change((v) => { v["files"][0].ranges = Array(241).fill({ line: 1 }); }), change((v) => { v["files"][0].claimIds = ["bad id"]; }), change((v) => { v["files"] = Array(241).fill(v["files"][0]); }),
    ]) {
      const w = setUp(onSources(() => answer));
      expect(asRefusal(await w.send("GET", SOURCES, await w.as("ada-token"))), JSON.stringify(answer).slice(0, 50)).toEqual(refusal("unavailable"));
    }
  });

  it("the rebuild keeps a Code answer that reads, unchanged", () => {
    const value = wikiSources("payments", "beacon-api--billing")!;
    expect(sourcesAnswer(value, "payments", "beacon-api--billing")).toEqual(value);
  });
});

describe("Code's failures", () => {
  it("Code's unknown-route 404 reads 'not on this Rovara yet'; its other refusals and failures read fixed words, never Code's text", async () => {
    for (const target of [INDEX, PAGE, SOURCES]) {
      const notServed = setUp((call) => (call.path.includes("/wiki") ? json(404, { error: { code: "NOT_FOUND", message: "route not found" } }) : undefined));
      const headers = await notServed.as("ada-token");
      const res = await notServed.send("GET", target, headers);
      expect(asRefusal(res), target).toEqual(refusal("notYet"));
      expect(res.status).toBe(501);
    }
    const table: Array<[number, keyof typeof WIKI_ANSWERS]> = [[403, "forbidden"], [400, "invalid"], [409, "unavailable"], [500, "unavailable"], [503, "unavailable"]];
    for (const [status, key] of table) {
      const w = setUp((call) => (call.path.includes("/wiki") ? json(status, { error: { code: "X", message: LEAK } }) : undefined));
      const headers = await w.as("ada-token");
      for (const target of [INDEX, PAGE, SOURCES]) {
        const res = await w.send("GET", target, headers);
        expect(asRefusal(res), `${String(status)} ${target}`).toEqual(refusal(key));
        expect(res.text).not.toContain(LEAK);
      }
    }
  });

  it("a Code body that is not JSON is 'couldn't be read', not a crash", async () => {
    const w = setUp((call) => (call.path.endsWith("/wiki") ? new Response("<html>oops " + LEAK + "</html>", { status: 200, headers: { "content-type": "text/html" } }) : undefined));
    const res = await w.send("GET", INDEX, await w.as("ada-token"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(LEAK);
  });

  it("signs the person out (401, the session deleted) when Code refuses the token and it can't be refreshed, on every wiki route", async () => {
    for (const target of [INDEX, PAGE, SOURCES]) {
      const w = setUp((call) => (call.path.startsWith("/v1/app/projects/") ? json(401, { error: { code: "AUTH_REQUIRED", message: LEAK } }) : undefined));
      const res = await w.send("GET", target, await w.as("ada-token"));
      expect(res.status, target).toBe(401);
      expect(res.text).not.toContain(LEAK);
      expect(await w.store.get("cookie-ada-token"), target).toBeUndefined();
    }
  });

  it("the routes only read: a change method is not a wiki route", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await w.send(method, INDEX, headers);
      expect([404, 405, 501], method).toContain(res.status);
    }
    expect(w.codeCalls()).toHaveLength(0);
  });
});
