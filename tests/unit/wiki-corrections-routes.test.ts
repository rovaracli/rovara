/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- answers are parsed JSON read field by field */
// Lead 4 slice C1: the wiki's corrections through Cloud's handler, passed to Code as the signed-in person. Code decides who may; the pretend Code below applies the same rule (a role on THAT project, in
// the project's own company; an owner or admin of the company is a maintainer of every project). Cloud must: pass the person's own token, put only the project, page and note of the path into Code's path,
// rebuild the body from known fields (an author, role, company or approval in it is refused before Code is asked), rebuild every answer for THIS project and page, answer refusals in fixed words
// (Code's own only when they are exactly one of the known list), and never log what the person wrote.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, WIKI_CORRECTION_ANSWERS, WIKI_CORRECTION_WORDS, createCloudHandler, wikiCorrectionRefusal, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import {
  WIKI_CORRECTION_LIMITS, WIKI_CORRECTION_SENTENCES, WIKI_CORRECTION_WORDS as APP_WORDS, WikiCorrectionsResponseSchema, WikiDisputedResponseSchema, WikiMarkedResponseSchema, WikiNoteAddedResponseSchema,
  AnswerGapsResponseSchema, WikiNoteAcknowledgedResponseSchema, WikiNoteApprovedResponseSchema, WikiNoteDeletedResponseSchema, WikiResolvedResponseSchema, WikiSuggestedResponseSchema,
} from "../../packages/contracts/src/app-wiki-corrections.js";
import { WIKI_WORDS } from "../../packages/contracts/src/app-wiki.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ID = (c: string) => c.repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer" | "viewer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ID("a"), company: A, role: "owner", grants: {} },
  "mia-token": { id: ID("2"), company: A, role: "member", grants: { payments: "administrator" } },
  "pam-token": { id: ID("b"), company: A, role: "member", grants: { payments: "developer" } },
  "vic-token": { id: ID("1"), company: A, role: "member", grants: { payments: "viewer" } },
  "bob-token": { id: ID("c"), company: B, role: "admin", grants: {} },
  "nob-token": { id: ID("d"), grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, billing: A, ledger: B };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;
const roleOf = (person: Person, project: string): "maintainer" | "contributor" | "viewer" | undefined => {
  if (person.company === undefined || PROJECTS[project] !== person.company) return undefined;
  if (person.role === "owner" || person.role === "admin") return "maintainer";
  const grant = person.grants[project];
  return grant === "administrator" ? "maintainer" : grant === "developer" ? "contributor" : grant === "viewer" ? "viewer" : undefined;
};

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
    const match = /^\/v1\/app\/projects\/([^/]+)\/wiki\/(?:pages\/([^/]+)\/(corrections|notes|flags)(?:\/([^/]+)\/(approve|delete|suggest-lesson|acknowledge)|\/(resolve))?|(disputed|gaps))$/u.exec(url.pathname);
    if (match === null) return err(404, "NOT_FOUND", "route not found");
    const project = decodeURIComponent(match[1]!), role = roleOf(person, project);
    if (role === undefined) return err(404, "NOT_FOUND", `project not found ${LEAK}`);
    const page = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (match[7] === "gaps") return role === "maintainer" ? json(200, { project, more: false, items: [{ topic: "How do refunds work", kind: "partly", people: 2, questions: 3, lastAskedAt: "2026-11-17", asker: "Pam", [LEAK]: LEAK }] }) : err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer);
    if (match[5] === "acknowledge") return role === "viewer" ? err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsWorkingRole) : json(200, { noteId: decodeURIComponent(match[4]!), acknowledged: true });
    if (match[7] !== undefined) return role === "maintainer" ? json(200, { project, more: false, items: [{ flagId: "flag0001", pageId: "overview", pageTitle: "Overview", claimId: "c0001", claimText: "A claim", markedBy: "Pam", markedAt: "2026-11-17T10:00:00.000Z", reason: "It moved" }] }) : err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer);
    if (match[3] === "corrections") return json(200, { project, pageId: page, you: { role, addNote: role !== "viewer", markWrong: role !== "viewer", approveNotes: role === "maintainer", resolveMarks: role === "maintainer", seeDisputed: role === "maintainer" }, notes: [{ noteId: "note0001", mine: false, canDelete: role === "maintainer", canApprove: role === "maintainer", canSuggestLesson: false, mayBeOutOfDate: false }] });
    if (role === "viewer") return err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsWorkingRole);
    if (match[3] === "notes" && match[4] === undefined) return json(200, { note: { noteId: "note0002", text: (call.body as any).text, author: "Pam", createdAt: "2026-11-17T10:00:00.000Z", approval: "pending", ...((call.body as any).file === undefined ? {} : { file: (call.body as any).file }) } });
    if (match[5] === "approve") return role === "maintainer" ? json(200, { noteId: decodeURIComponent(match[4]!), approval: "approved" }) : err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer);
    if (match[5] === "delete") return json(200, { deleted: true });
    if (match[5] === "suggest-lesson") return json(200, { state: "proposed", lessonId: "wn_abcdefabcdefabcdefabcdef" });
    if (match[3] === "flags" && match[6] === "resolve") return role === "maintainer" ? json(200, { resolved: 2 }) : err(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer);
    return json(200, { flagId: "flag0002", pageId: page, ...((call.body as any)?.claimId === undefined ? {} : { claimId: (call.body as any).claimId }) });
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
  return { as, send, calls, codeCalls: () => calls.filter((call) => call.path !== "/v1/dev/access") };
}
const error = (answer: { body: any }) => answer.body.error as { code: string; message: string };
const PAGE = "/v1/web/projects/payments/wiki/pages/overview";
const NOTE = `${PAGE}/notes/note0001`;
afterEach(() => { vi.restoreAllMocks(); });

describe("the fixed words and limits", () => {
  it("are the same in Cloud's server and in the app's contracts", () => {
    expect({ ...WIKI_CORRECTION_WORDS }).toEqual({ ...APP_WORDS });
    expect(WIKI_CORRECTION_SENTENCES.size).toBe(Object.keys(APP_WORDS).length);
    expect(WIKI_CORRECTION_LIMITS).toMatchObject({ noteChars: 2_000, reasonChars: 500, notesPerPage: 50, disputed: 100 });
  });
});

describe("B17: questions the wiki could not answer, and acknowledging a note", () => {
  const GAPS = "/v1/web/projects/payments/wiki/gaps";
  it("a maintainer reads the topics (no asker, nothing else of Code's), as their own token, to Code's own path", async () => {
    const w = setUp();
    const read = await w.send("GET", GAPS, await w.as("mia-token"));
    expect(AnswerGapsResponseSchema.parse(read.body)).toEqual({ project: "payments", more: false, items: [{ topic: "How do refunds work", kind: "partly", people: 2, questions: 3, lastAskedAt: "2026-11-17" }] });
    expect(read.text).not.toContain("Pam");
    expect(read.text).not.toContain(LEAK);
    expect(w.codeCalls().map((c) => [c.method, c.path, c.search, c.authorization])).toEqual([["GET", "/v1/app/projects/payments/wiki/gaps", "", "Bearer mia-token"]]);
  });
  it("a contributor is refused in the maintainer words, a person off the project and another company's maintainer get the one 404, and a query is refused before Code", async () => {
    const w = setUp();
    expect(error(await w.send("GET", GAPS, await w.as("pam-token"))).message).toBe(WIKI_CORRECTION_WORDS.needsMaintainer);
    const other = await w.send("GET", "/v1/web/projects/billing/wiki/gaps", await w.as("pam-token"));
    expect({ status: other.status, error: error(other) }).toEqual({ status: 404, error: { code: "NOT_FOUND", message: WIKI_WORDS.notFound } });
    expect(other.text).not.toContain(LEAK);
    expect((await w.send("GET", GAPS, await w.as("bob-token"))).status).toBe(404);
    const before = w.codeCalls().length;
    expect((await w.send("GET", `${GAPS}?x=1`, await w.as("mia-token"))).status).toBe(400);
    expect(w.codeCalls()).toHaveLength(before);
  });
  it("an answer for another project, a bad kind, a count of zero or a time instead of a day is refused whole", async () => {
    const one = { topic: "t", kind: "partly", people: 1, questions: 1, lastAskedAt: "2026-11-17" };
    for (const answer of [{ project: "ledger", more: false, items: [] }, { project: "payments", more: false, items: [{ ...one, kind: "weird" }] }, { project: "payments", more: false, items: [{ ...one, people: 0 }] }, { project: "payments", more: false, items: [{ ...one, lastAskedAt: "2026-11-17T10:00:00Z" }] }, { project: "payments", items: [] }]) {
      const w = setUp((call) => (call.path.endsWith("/gaps") ? json(200, answer) : undefined));
      expect((await w.send("GET", GAPS, await w.as("mia-token"))).status).toBe(503);
    }
  });
  it("acknowledge goes to Code's note path as the person, with no body, and answers the one note; a viewer gets Code's working-role words", async () => {
    const w = setUp();
    expect(WikiNoteAcknowledgedResponseSchema.parse((await w.send("POST", `${NOTE}/acknowledge`, await w.as("pam-token"), {})).body)).toEqual({ noteId: "note0001", acknowledged: true });
    expect(w.codeCalls().map((c) => [c.method, c.path, c.authorization, c.body])).toEqual([["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/acknowledge", "Bearer pam-token", {}]]);
    expect(error(await w.send("POST", `${NOTE}/acknowledge`, await w.as("vic-token"), {})).message).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
    const bad = setUp((call) => (call.path.endsWith("/acknowledge") ? json(200, { noteId: "other000", acknowledged: true }) : undefined));
    expect((await bad.send("POST", `${NOTE}/acknowledge`, await bad.as("pam-token"), {})).status).toBe(503);
    const before = w.codeCalls().length;
    expect((await w.send("POST", `${NOTE}/acknowledge`, await w.as("pam-token"), { extra: 1 })).status).toBe(400);
    expect(w.codeCalls()).toHaveLength(before);
  });
});

describe("every route passes the person's own token, to Code's own path", () => {
  it("each of the eight, with only the path's project, page and note and a rebuilt body", async () => {
    const w = setUp();
    const h = await w.as("pam-token");
    expect(WikiCorrectionsResponseSchema.parse((await w.send("GET", `${PAGE}/corrections`, h)).body).you).toMatchObject({ role: "contributor", addNote: true, approveNotes: false });
    expect(WikiNoteAddedResponseSchema.parse((await w.send("POST", `${PAGE}/notes`, h, { text: "Billing runs nightly.", file: { repo: "web", path: "src/a.ts" } })).body).note).toMatchObject({ approval: "pending", author: "Pam" });
    expect(WikiMarkedResponseSchema.parse((await w.send("POST", `${PAGE}/flags`, h, { claimId: "c0001", reason: "It moved" })).body)).toMatchObject({ claimId: "c0001" });
    expect(WikiSuggestedResponseSchema.parse((await w.send("POST", `${NOTE}/suggest-lesson`, h, {})).body).state).toBe("proposed");
    expect(WikiNoteDeletedResponseSchema.parse((await w.send("POST", `${NOTE}/delete`, h)).body)).toEqual({ deleted: true });
    const m = await w.as("mia-token");
    expect(WikiNoteApprovedResponseSchema.parse((await w.send("POST", `${NOTE}/approve`, m, {})).body)).toEqual({ noteId: "note0001", approval: "approved" });
    expect(WikiResolvedResponseSchema.parse((await w.send("POST", `${PAGE}/flags/resolve`, m, {})).body)).toEqual({ resolved: 2 });
    expect(WikiDisputedResponseSchema.parse((await w.send("GET", "/v1/web/projects/payments/wiki/disputed", m)).body).items[0]).toMatchObject({ reason: "It moved", markedBy: "Pam" });
    expect(w.codeCalls().map((c) => [c.method, c.path, c.authorization])).toEqual([
      ["GET", "/v1/app/projects/payments/wiki/pages/overview/corrections", "Bearer pam-token"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes", "Bearer pam-token"],
      ["POST", "/v1/app/projects/payments/wiki/pages/overview/flags", "Bearer pam-token"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/suggest-lesson", "Bearer pam-token"],
      ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/delete", "Bearer pam-token"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/approve", "Bearer mia-token"],
      ["POST", "/v1/app/projects/payments/wiki/pages/overview/flags/resolve", "Bearer mia-token"], ["GET", "/v1/app/projects/payments/wiki/disputed", "Bearer mia-token"],
    ]);
    expect(w.codeCalls().map((c) => c.body)).toEqual([undefined, { text: "Billing runs nightly.", file: { repo: "web", path: "src/a.ts" } }, { claimId: "c0001", reason: "It moved" }, {}, {}, {}, {}, undefined]);
    for (const call of w.calls) expect(call.search).toBe("");
  });
});

describe("what Cloud refuses before asking Code", () => {
  it("a body that names an author, a role, a company, an approval or anything else is refused and Code is not asked", async () => {
    const w = setUp();
    const h = await w.as("pam-token");
    for (const [path, body] of [
      [`${PAGE}/notes`, { text: "hi", authorId: "x" }], [`${PAGE}/notes`, { text: "hi", approval: { state: "approved" } }], [`${PAGE}/notes`, { text: "hi", role: "maintainer" }], [`${PAGE}/notes`, { text: "hi", file: { repo: "web", path: "../x", extra: 1 } }],
      [`${PAGE}/notes`, {}], [`${PAGE}/notes`, { text: "   " }], [`${PAGE}/notes`, { text: "x".repeat(2_001) }], [`${PAGE}/notes`, { text: "bad\u0000" }], [`${PAGE}/notes`, { text: "hi", file: { repo: "web", path: "/etc/passwd" } }],
      [`${PAGE}/flags`, { by: { kind: "person", personId: "x" } }], [`${PAGE}/flags`, { claimId: "a#b" }], [`${PAGE}/flags`, { reason: "" }], [`${PAGE}/flags`, { reason: "x".repeat(501) }], [`${PAGE}/flags`, { state: "resolved" }],
      [`${NOTE}/approve`, { by: "ada" }], [`${NOTE}/delete`, { all: true }], [`${NOTE}/suggest-lesson`, { title: "x" }], [`${PAGE}/flags/resolve`, { all: true }],
    ] as const) {
      const res = await w.send("POST", path, h, body);
      expect({ status: res.status, error: error(res) }, JSON.stringify(body).slice(0, 50)).toEqual({ status: 400, error: { code: "CONFIG_INVALID", message: WIKI_CORRECTION_WORDS.badRequest } });
    }
    expect(w.codeCalls()).toEqual([]);
  });

  it("a malformed project, page or note id, or any query, is refused without asking Code", async () => {
    const w = setUp();
    const h = await w.as("pam-token");
    for (const [method, path] of [
      ["POST", "/v1/web/projects/Payments/wiki/pages/overview/notes"], ["POST", "/v1/web/projects/payments/wiki/pages/BAD%3Cb%3E/notes"], ["POST", `${PAGE}/notes/a%23b/approve`], ["POST", `${PAGE}/notes/abc/approve`],
      ["GET", "/v1/web/projects/payments/wiki/pages/BAD%2F/corrections"], ["GET", `${PAGE}/corrections?x=1`], ["GET", "/v1/web/projects/payments/wiki/disputed?x=1"],
    ] as const) {
      const res = await w.send(method, path, h, method === "POST" ? (path.endsWith("/notes") ? { text: "hi" } : {}) : undefined);
      expect([400, 404], `${method} ${path}`).toContain(res.status);
    }
    expect(w.codeCalls()).toEqual([]);
  });

  it("an unsigned request never reaches Code; a method with no route is not served", async () => {
    const w = setUp();
    const res = await w.send("POST", `${PAGE}/notes`, {}, { text: "hi" });
    expect([401, 403]).toContain(res.status);
    expect(w.codeCalls()).toEqual([]);
    for (const [method, path] of [["DELETE", NOTE], ["PUT", `${PAGE}/notes`], ["GET", `${PAGE}/notes`], ["POST", `${PAGE}/corrections`]] as const) {
      expect((await w.send(method, path, await w.as("pam-token"))).status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(w.codeCalls()).toEqual([]);
  });
});

describe("Code decides who may; its refusals reach the app in fixed words", () => {
  it("a viewer's write and a contributor's approval are refused with Code's own fixed sentences and status", async () => {
    const w = setUp();
    const viewer = await w.send("POST", `${PAGE}/notes`, await w.as("vic-token"), { text: "hi" });
    expect({ status: viewer.status, error: error(viewer) }).toEqual({ status: 403, error: { code: "FORBIDDEN", message: WIKI_CORRECTION_WORDS.needsWorkingRole } });
    const contributor = await w.send("POST", `${NOTE}/approve`, await w.as("pam-token"), {});
    expect({ status: contributor.status, error: error(contributor) }).toEqual({ status: 403, error: { code: "FORBIDDEN", message: WIKI_CORRECTION_WORDS.needsMaintainer } });
    const disputed = await w.send("GET", "/v1/web/projects/payments/wiki/disputed", await w.as("pam-token"));
    expect(error(disputed).message).toBe(WIKI_CORRECTION_WORDS.needsMaintainer);
  });

  it("no role, another project of the company, another company: the project's 404, with nothing of Code's detail", async () => {
    const w = setUp();
    for (const [token, path] of [["pam-token", "/v1/web/projects/billing/wiki/pages/overview/notes"], ["bob-token", PAGE + "/notes"], ["pam-token", "/v1/web/projects/ledger/wiki/pages/overview/notes"]] as const) {
      const res = await w.send("POST", path, await w.as(token), { text: "hi" });
      expect({ status: res.status, error: error(res) }, `${token} ${path}`).toEqual({ status: 404, error: { code: "NOT_FOUND", message: WIKI_WORDS.notFound } });
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("an owner of the company is a maintainer of every project of it; the pretend Code's role answer is Code's own, never Cloud's guess", async () => {
    const w = setUp();
    expect((await w.send("GET", "/v1/web/projects/billing/wiki/pages/overview/corrections", await w.as("ada-token"))).body.you).toMatchObject({ role: "maintainer", approveNotes: true });
  });

  it("any other text of Code's, an unknown code, or an odd status is Cloud's own words; an unwired Code reads 'not on this Rovara yet'", async () => {
    const w = setUp((call) => (call.path.endsWith("/notes") ? err(409, "WHATEVER", `a cause ${LEAK}`) : call.path.endsWith("/flags") ? err(403, "FORBIDDEN", `secret ${LEAK}`) : call.path.endsWith("/delete") ? err(404, "NOT_FOUND", "route not found") : undefined));
    const h = await w.as("pam-token");
    for (const [path, expected] of [[`${PAGE}/notes`, 503], [`${PAGE}/flags`, 503], [`${NOTE}/delete`, 501]] as const) {
      const res = await w.send("POST", path, h, path.endsWith("/delete") ? undefined : path.endsWith("/flags") ? {} : { text: "hi" });
      expect(res.status, path).toBe(expected);
      expect(res.text).not.toContain(LEAK);
    }
    expect(wikiCorrectionRefusal(new CodeError(404, { error: { code: "NOT_FOUND", message: "route not found" } }))).toEqual(WIKI_CORRECTION_ANSWERS.notYet);
    expect(wikiCorrectionRefusal(new CodeError(404, { error: { code: "NOT_FOUND", message: "other" } }))).toEqual(WIKI_CORRECTION_ANSWERS.notFound);
    expect(wikiCorrectionRefusal(new CodeError(500, undefined))).toEqual(WIKI_CORRECTION_ANSWERS.unavailable);
    expect(wikiCorrectionRefusal(new CodeError(403, { error: { code: "FORBIDDEN", message: WIKI_CORRECTION_WORDS.noteNotYours } })).body).toEqual({ error: { code: "FORBIDDEN", message: WIKI_CORRECTION_WORDS.noteNotYours } });
  });
});

describe("an answer that does not read is refused whole", () => {
  it("an answer for another project or page, an unknown field type, a role Cloud does not know, or too many notes", async () => {
    const good = { project: "payments", pageId: "overview", you: { role: "maintainer", addNote: true, markWrong: true, approveNotes: true, resolveMarks: true, seeDisputed: true }, notes: [] };
    const bad: unknown[] = [
      { ...good, project: "billing" }, { ...good, pageId: "other" }, { ...good, you: { ...good.you, role: "owner" } }, { ...good, you: { ...good.you, addNote: "yes" } }, { ...good, notes: Array.from({ length: 51 }, (_, i) => ({ noteId: `note${String(i).padStart(4, "0")}`, mine: false, canDelete: false, canApprove: false, canSuggestLesson: false, mayBeOutOfDate: false })) },
      { ...good, notes: [{ noteId: "note0001", mine: false, canDelete: false, canApprove: false, canSuggestLesson: false, mayBeOutOfDate: false }, { noteId: "note0001", mine: false, canDelete: false, canApprove: false, canSuggestLesson: false, mayBeOutOfDate: false }] }, "text",
    ];
    for (const one of bad) {
      const w = setUp((call) => (call.path.endsWith("/corrections") ? json(200, one) : undefined));
      const res = await w.send("GET", `${PAGE}/corrections`, await w.as("pam-token"));
      expect({ status: res.status, message: error(res).message }, JSON.stringify(one).slice(0, 60)).toEqual({ status: 503, message: WIKI_CORRECTION_WORDS.unavailable });
    }
    const w = setUp((call) => (call.path.endsWith("/flags") ? json(200, { flagId: "flag0002", pageId: "other" }) : call.path.endsWith("/approve") ? json(200, { noteId: "note9999", approval: "approved" }) : call.path.endsWith("/disputed") ? json(200, { project: "billing", more: false, items: [] }) : undefined));
    expect(error(await w.send("POST", `${PAGE}/flags`, await w.as("pam-token"), {})).message).toBe(WIKI_CORRECTION_WORDS.unavailable);
    expect(error(await w.send("POST", `${NOTE}/approve`, await w.as("mia-token"), {})).message).toBe(WIKI_CORRECTION_WORDS.unavailable);
    expect(error(await w.send("GET", "/v1/web/projects/payments/wiki/disputed", await w.as("mia-token"))).message).toBe(WIKI_CORRECTION_WORDS.unavailable);
  });

  it("an author name that does not read is shown as 'a former member', never a refusal of the answer", async () => {
    const w = setUp((call) => (call.path.endsWith("/notes") ? json(200, { note: { noteId: "note0002", text: "hi", author: "bad\u0000name", createdAt: "2026-11-17T10:00:00.000Z", approval: "pending" } }) : undefined));
    expect((await w.send("POST", `${PAGE}/notes`, await w.as("pam-token"), { text: "hi" })).body.note.author).toBe("a former member");
  });
});

describe("what is logged", () => {
  it("the action and the project, never the note, the reason or the page", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const w = setUp();
    const h = await w.as("pam-token");
    await w.send("POST", `${PAGE}/notes`, h, { text: "NOTE-CANARY words" });
    await w.send("POST", `${PAGE}/flags`, h, { reason: "REASON-CANARY" });
    const mine = lines.filter((line) => line.includes("cloud.wiki_correction"));
    expect(mine.map((line) => JSON.parse(line))).toEqual([{ event: "cloud.wiki_correction", action: "add_note", project: "payments" }, { event: "cloud.wiki_correction", action: "mark_wrong", project: "payments" }]);
    expect(lines.join("\n")).not.toMatch(/CANARY/u);
  });
});
