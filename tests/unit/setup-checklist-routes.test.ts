// Guided onboarding PR 9: the project checklist read, its "Set up later" change and the hosted setup run through Cloud's handler, answered from Code
// (#841 setup-status, #844 setup-agent) as the signed-in person. The pretend Code keeps two companies and applies Code's rules (any member of the company
// reads the checklist; a company owner/admin or the project's admin sets rows aside and manages the run; a project user reads the run; anyone else,
// another company included, "project not found"). Cloud must: pass the person's own token, put the project only into Code's path, forward only checked
// bodies and queries, rebuild Code's checklist from known fields, and answer refusals in its fixed words.
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, SETUP_CHECKLIST_ANSWERS, SETUP_CHECKLIST_WORDS, checklistAnswer, createCloudHandler, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { ProjectSetupChecklistSchema, SETUP_CHECKLIST_WORDS as APP_WORDS } from "../../packages/contracts/src/project-setup-status.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64), PAM = "b".repeat(64), BOB = "c".repeat(64), NOB = "d".repeat(64), PIA = "e".repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const REQUEST_ID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ADA, company: A, role: "owner", grants: {} },
  "pam-token": { id: PAM, company: A, role: "member", grants: { payments: "developer" } },
  "pia-token": { id: PIA, company: A, role: "member", grants: { payments: "administrator" } },
  "bob-token": { id: BOB, company: B, role: "admin", grants: {} },
  "nob-token": { id: NOB, grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, ledger: B };

function checklist(project: string, extra: Record<string, unknown> = {}) {
  return {
    project,
    viewer: { companyRole: "owner", projectAdmin: false, canSkip: true },
    progress: { done: 3, total: 8, percent: 38, nextRequired: "setupRun" },
    repos: { state: "done", count: 1, items: [{ name: "payments", fullName: "acme/payments", defaultBranch: "main" }] },
    setupRun: { state: "failed", status: "failed", approval: "none", startedAt: "2026-11-17T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "failed", failure: "A test command failed.", failedCommand: { n: 2, command: "npm test", exitCode: 1, timedOut: false, lastLines: ["FAIL x", ""] } },
    evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" },
    aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
    slackChannel: { state: "skipped", channels: [] },
    linear: { state: "optional", team: null },
    invites: { state: "optional" },
    firstTask: { state: "needs_you", hasTask: false, canStart: false },
    ...extra,
  };
}

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const runs: Record<string, "none" | "running" | "failed"> = { payments: "none", ledger: "none" };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: Object.entries(person.grants).map(([name, access]) => ({ name, access })), notices: [] });
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    const status = /^\/v1\/dev\/client\/projects\/([^/]+)\/setup-status(\/skips)?$/u.exec(url.pathname);
    const run = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal))?$/u.exec(url.pathname);
    const match = status ?? run;
    if (match === null) return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const project = decodeURIComponent(match[1]!);
    if (person.company === undefined || PROJECTS[project] !== person.company) return json(404, { error: { code: "NOT_FOUND", message: `project not found ${LEAK}` } });
    const grant = person.grants[project];
    const manage = person.role === "owner" || person.role === "admin" || grant === "administrator";
    if (status !== null) {
      if (status[2] === undefined) return json(200, checklist(project, { viewer: { companyRole: person.role, projectAdmin: grant === "administrator", canSkip: manage } }));
      if (!manage) return json(403, { error: { code: "FORBIDDEN", message: `${LEAK} no` } });
      const body = call.body as { row: string; skipped: boolean };
      return json(200, { project, row: body.row, skipped: body.skipped, skippedRows: body.skipped ? [body.row] : [] });
    }
    if (!manage && grant === undefined) return json(404, { error: { code: "NOT_FOUND", message: "project not found" } });
    const view = () => ({ status: runs[project], basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: manage });
    if (call.method === "GET" && run![2] === undefined) return json(200, view());
    if (call.method === "GET") return json(200, { status: runs[project], entries: [], hostAsks: [] });
    if (!manage) return json(403, { error: { code: "FORBIDDEN", message: `${LEAK} not allowed` } });
    if (run![2] === undefined) {
      if (runs[project] === "running") return json(409, { error: { code: "WORKSPACE_BUSY", message: `${LEAK} busy` } });
      runs[project] = "running";
      return json(202, view());
    }
    runs[project] = "failed";
    return json(202, view());
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
  const send = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown, text: answered!.body };
  };
  const codeCalls = () => calls.filter((call) => call.path !== "/v1/dev/access");
  return { as, send, calls, codeCalls, runs, store };
}
const words = (answer: { body: unknown }) => (answer.body as { error: { code: string; message: string } }).error;
const refusal = (key: keyof typeof SETUP_CHECKLIST_ANSWERS) => ({ status: SETUP_CHECKLIST_ANSWERS[key].status, error: (SETUP_CHECKLIST_ANSWERS[key].body as { error: unknown }).error });
const asRefusal = (answer: { status: number; body: unknown }) => ({ status: answer.status, error: words(answer) });

describe("the fixed words", () => {
  it("are the same in Cloud's server and in the app's contracts", () => {
    expect({ ...SETUP_CHECKLIST_WORDS }).toEqual({ ...APP_WORDS });
  });
});

describe("the checklist read", () => {
  it("a member reads their company's project: Code gets the person's own token and the project only in its path; the answer is rebuilt and reads in the app's schema", async () => {
    const w = setUp();
    const res = await w.send("GET", "/v1/web/projects/payments/setup-status?company=" + B, { ...await w.as("pam-token"), "x-rovara-company": B });
    expect(res.status).toBe(200);
    expect(ProjectSetupChecklistSchema.parse(res.body)).toMatchObject({ project: "payments", viewer: { companyRole: "member", canSkip: false }, setupRun: { state: "failed", failedCommand: { command: "npm test" } } });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "GET", path: "/v1/dev/client/projects/payments/setup-status", search: "", authorization: "Bearer pam-token" })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("drops fields Code did not promise, at every level", async () => {
    const w = setUp((call) => call.path.endsWith("/setup-status") ? json(200, { ...checklist("payments"), secret: LEAK, repos: { state: "done", count: 1, items: [{ name: "payments", defaultBranch: "main", token: LEAK }], extra: LEAK } }) : undefined);
    const res = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    expect((res.body as { repos: unknown }).repos).toEqual({ state: "done", count: 1, items: [{ name: "payments", defaultBranch: "main" }] });
  });

  it("passes a repository's access word (DEC 254zc(1): transferred or removed) on, and nothing else about it", async () => {
    const items = [{ name: "payments", fullName: "acme/payments", defaultBranch: "main", access: "transferred", why: LEAK }, { name: "ledger", fullName: "acme/ledger", defaultBranch: "main", access: "removed" }, { name: "docs", defaultBranch: "main" }];
    const w = setUp((call) => call.path.endsWith("/setup-status") ? json(200, { ...checklist("payments"), repos: { state: "done", count: 3, items } }) : undefined);
    const res = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    expect((res.body as { repos: { items: unknown } }).repos.items).toEqual([
      { name: "payments", fullName: "acme/payments", defaultBranch: "main", access: "transferred" }, { name: "ledger", fullName: "acme/ledger", defaultBranch: "main", access: "removed" }, { name: "docs", defaultBranch: "main" },
    ]);
    expect(ProjectSetupChecklistSchema.parse(res.body).repos.items[0]?.access).toBe("transferred");
  });

  it("a repository access word Code did not promise makes the whole checklist unreadable, and the words are never echoed", async () => {
    for (const access of [LEAK, "gone", "", 1, null, ["removed"]]) {
      const w = setUp((call) => call.path.endsWith("/setup-status") ? json(200, { ...checklist("payments"), repos: { state: "done", count: 1, items: [{ name: "payments", defaultBranch: "main", access }] } }) : undefined);
      const res = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("ada-token"));
      expect(asRefusal(res)).toEqual(refusal("unavailable"));
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("another company's project, a project name that doesn't read, and a person in no company are refused in fixed words (the last two never reach Code's project routes)", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const other = await w.send("GET", "/v1/web/projects/ledger/setup-status", ada);
    expect(asRefusal(other)).toEqual(refusal("notFound"));
    expect(other.text).not.toContain(LEAK);
    const bad = await w.send("GET", "/v1/web/projects/Bad..Name/setup-status", ada);
    expect(asRefusal(bad)).toEqual(refusal("notFound"));
    const nobody = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("nob-token"));
    expect(nobody.status).toBe(403);
    expect(words(nobody).code).toBe("NO_COMPANY");
    expect(w.codeCalls()).toHaveLength(1);
  });

  it("an answer for another project, or with a field off, is not shown at all", async () => {
    const answers = [
      checklist("ledger"),
      checklist("payments", { setupRun: { state: "weird", status: "none", approval: "none" } }),
      checklist("payments", { progress: { done: 9, total: 8, percent: 100, nextRequired: null } }),
      checklist("payments", { slackChannel: { state: "done", channels: [{ channelId: "C1\u0007" }] } }),
      checklist("payments", { setupRun: { state: "failed", status: "failed", approval: "none", failedCommand: { n: 1, command: "x", exitCode: 1, timedOut: false, lastLines: Array(21).fill("l") } } }),
      checklist("payments", { firstTask: { state: "done", hasTask: "yes", canStart: true } }),
      [checklist("payments")],
    ];
    for (const answer of answers) {
      const w = setUp((call) => call.path.endsWith("/setup-status") ? json(200, answer) : undefined);
      expect(asRefusal(await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("ada-token")))).toEqual(refusal("unavailable"));
    }
  });

  it("Code's unknown-route 404 reads 'not on this Rovara yet'; Code's other failures read fixed words", async () => {
    const notServed = setUp((call) => call.path.endsWith("/setup-status") ? json(404, { error: { code: "NOT_FOUND", message: "route not found" } }) : undefined);
    expect(asRefusal(await notServed.send("GET", "/v1/web/projects/payments/setup-status", await notServed.as("ada-token")))).toEqual(refusal("notYet"));
    for (const status of [403, 500, 503]) {
      const w = setUp((call) => call.path.endsWith("/setup-status") ? json(status, { error: { code: "X", message: LEAK } }) : undefined);
      const res = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("ada-token"));
      expect(asRefusal(res)).toEqual(refusal("unavailable"));
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("the rebuild keeps a Code answer that reads, unchanged", () => {
    const value = checklist("payments");
    expect(checklistAnswer(value, "payments")).toEqual(value);
  });
});

describe("an ended sign-in", () => {
  it("signs the person out (401, the session deleted) when Code refuses the token and it can't be refreshed, on every route", async () => {
    for (const [method, path, body] of [["GET", "/v1/web/projects/payments/setup-status"], ["GET", "/v1/web/projects/payments/setup-agent"], ["GET", "/v1/web/projects/payments/setup-agent/journal"], ["POST", "/v1/web/projects/payments/setup-agent", { requestId: REQUEST_ID }]] as const) {
      // Code's project route refuses the token (the access check still answers).
      const w = setUp((call) => call.path.startsWith("/v1/dev/client/projects/") || call.path.startsWith("/v1/app/projects/") ? json(401, { error: { code: "AUTH_REQUIRED", message: LEAK } }) : undefined);
      const res = await w.send(method, path, await w.as("ada-token"), body);
      expect(res.status, path).toBe(401);
      expect(res.text).not.toContain(LEAK);
      expect(await w.store.get("cookie-ada-token"), path).toBeUndefined();
    }
  });

  it("signs the person out when Code's access check itself refuses the token", async () => {
    const w = setUp();
    const res = await w.send("GET", "/v1/web/projects/payments/setup-status", await w.as("dead-token"));
    expect(res.status).toBe(401);
    expect(await w.store.get("cookie-dead-token")).toBeUndefined();
    expect(w.codeCalls().filter((call) => call.path.includes("/setup-status"))).toHaveLength(0);
  });
});

describe("Set up later", () => {
  it("a company owner and the project's admin set a row aside; Code gets exactly {row, skipped}", async () => {
    const w = setUp();
    for (const token of ["ada-token", "pia-token"]) {
      const res = await w.send("PUT", "/v1/web/projects/payments/setup-status/skips", await w.as(token), { row: "linear", skipped: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ project: "payments", row: "linear", skipped: true, skippedRows: ["linear"] });
    }
    expect(w.codeCalls().map((call) => call.body)).toEqual([{ row: "linear", skipped: true }, { row: "linear", skipped: true }]);
  });

  it("a project user is refused in Cloud's words; another company's project is not found", async () => {
    const w = setUp();
    const member = await w.send("PUT", "/v1/web/projects/payments/setup-status/skips", await w.as("pam-token"), { row: "invites", skipped: true });
    expect(asRefusal(member)).toEqual(refusal("skipNotAllowed"));
    expect(member.text).not.toContain(LEAK);
    expect(asRefusal(await w.send("PUT", "/v1/web/projects/ledger/setup-status/skips", await w.as("ada-token"), { row: "invites", skipped: true }))).toEqual(refusal("notFound"));
  });

  it("refuses a body that isn't exactly a skippable row and a flag, without asking Code", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    for (const body of [{ row: "setupRun", skipped: true }, { row: "linear" }, { row: "linear", skipped: "yes" }, { row: "linear", skipped: true, companyId: B }, []]) {
      expect(asRefusal(await w.send("PUT", "/v1/web/projects/payments/setup-status/skips", headers, body))).toEqual(refusal("invalid"));
    }
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("Code's 400 reads 'not valid', and any 409 reads 'changed' (only a run is ever 'busy')", async () => {
    const bad = setUp((call) => call.path.endsWith("/skips") ? json(400, { error: { code: "CONFIG_INVALID", message: LEAK } }) : undefined);
    expect(asRefusal(await bad.send("PUT", "/v1/web/projects/payments/setup-status/skips", await bad.as("ada-token"), { row: "linear", skipped: true }))).toEqual(refusal("invalid"));
    for (const code of ["CHANGE_STALE", "WORKSPACE_BUSY"]) {
      const w = setUp((call) => call.path.endsWith("/skips") ? json(409, { error: { code, message: LEAK } }) : undefined);
      expect(asRefusal(await w.send("PUT", "/v1/web/projects/payments/setup-status/skips", await w.as("ada-token"), { row: "linear", skipped: true }))).toEqual(refusal("stale"));
    }
  });

  it("an answer that doesn't confirm this change is not confirmed", async () => {
    for (const answer of [{ project: "ledger", row: "linear", skipped: true, skippedRows: [] }, { project: "payments", row: "invites", skipped: true, skippedRows: [] }, { project: "payments", row: "linear", skipped: false, skippedRows: [] }, { project: "payments", row: "linear", skipped: true, skippedRows: ["setupRun"] }]) {
      const w = setUp((call) => call.path.endsWith("/skips") ? json(200, answer) : undefined);
      expect(asRefusal(await w.send("PUT", "/v1/web/projects/payments/setup-status/skips", await w.as("ada-token"), { row: "linear", skipped: true }))).toEqual(refusal("unavailable"));
    }
  });
});

describe("the hosted setup run", () => {
  it("a project user reads the run (canManage false); a manager reads canManage true; Code gets Code's own /v1/app path", async () => {
    const w = setUp();
    expect((await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("pam-token"))).body).toMatchObject({ status: "none", canManage: false });
    expect((await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("pia-token"))).body).toMatchObject({ status: "none", canManage: true });
    expect(w.codeCalls().map((call) => call.path)).toEqual(["/v1/app/projects/payments/setup-agent", "/v1/app/projects/payments/setup-agent"]);
  });

  it("an owner starts (Code's 202 reads 200), a second start is busy in fixed words, and Stop stops; each body is exactly {requestId}", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    const started = await w.send("POST", "/v1/web/projects/payments/setup-agent", headers, { requestId: REQUEST_ID });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: "running", canManage: true });
    const again = await w.send("POST", "/v1/web/projects/payments/setup-agent", headers, { requestId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334466" });
    expect(asRefusal(again)).toEqual(refusal("busy"));
    expect(again.text).not.toContain(LEAK);
    expect((await w.send("POST", "/v1/web/projects/payments/setup-agent/stop", headers, { requestId: REQUEST_ID })).body).toMatchObject({ status: "failed" });
    expect(w.codeCalls().map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/v1/app/projects/payments/setup-agent", { requestId: REQUEST_ID }],
      ["POST", "/v1/app/projects/payments/setup-agent", { requestId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334466" }],
      ["POST", "/v1/app/projects/payments/setup-agent/stop", { requestId: REQUEST_ID }],
    ]);
  });

  it("a project user's start is refused in Cloud's words; another company's project is not found", async () => {
    const w = setUp();
    const member = await w.send("POST", "/v1/web/projects/payments/setup-agent", await w.as("pam-token"), { requestId: REQUEST_ID });
    expect(asRefusal(member)).toEqual(refusal("runNotAllowed"));
    expect(member.text).not.toContain(LEAK);
    const bob = await w.send("POST", "/v1/web/projects/payments/setup-agent", await w.as("bob-token"), { requestId: REQUEST_ID });
    expect(asRefusal(bob)).toEqual(refusal("notFound"));
    expect(bob.text).not.toContain(LEAK);
    expect(w.runs["payments"]).toBe("none");
  });

  it("refuses a start or stop body that isn't exactly a UUID request id (no limits, payer or goal from the browser), without asking Code", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    for (const body of [{}, { requestId: "nope" }, { requestId: REQUEST_ID, limits: { budgetCents: 2000 } }, { requestId: REQUEST_ID, text: "rm -rf /" }, [REQUEST_ID]]) {
      expect(asRefusal(await w.send("POST", "/v1/web/projects/payments/setup-agent", headers, body))).toEqual(refusal("invalid"));
      expect(asRefusal(await w.send("POST", "/v1/web/projects/payments/setup-agent/stop", headers, body))).toEqual(refusal("invalid"));
    }
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("Code's 503 'not available for this company' and its unknown route read Cloud's words; other failures read 'couldn't be read'", async () => {
    const off = setUp((call) => call.method === "POST" ? json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_CHECKLIST_WORDS.runUnavailable } }) : undefined);
    expect(asRefusal(await off.send("POST", "/v1/web/projects/payments/setup-agent", await off.as("ada-token"), { requestId: REQUEST_ID }))).toEqual(refusal("runUnavailable"));
    const notServed = setUp((call) => call.path.includes("/setup-agent") ? json(404, { error: { code: "NOT_FOUND", message: "route not found" } }) : undefined);
    expect(asRefusal(await notServed.send("GET", "/v1/web/projects/payments/setup-agent", await notServed.as("ada-token")))).toEqual(refusal("runNotYet"));
    const other = setUp((call) => call.method === "POST" ? json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }) : undefined);
    const res = await other.send("POST", "/v1/web/projects/payments/setup-agent", await other.as("ada-token"), { requestId: REQUEST_ID });
    expect(asRefusal(res)).toEqual(refusal("unavailable"));
    expect(res.text).not.toContain(LEAK);
  });

  it("an answer whose status is not a known word, or whose canManage is not a boolean, is not passed on", async () => {
    for (const answer of [{ status: "exploded" }, { status: "running", canManage: "yes" }, ["running"]]) {
      const w = setUp((call) => call.path.endsWith("/setup-agent") ? json(200, answer) : undefined);
      expect(asRefusal(await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("ada-token")))).toEqual(refusal("unavailable"));
    }
  });

  it("a journal answer that doesn't read (unknown status, too many entries, no host asks) is not passed on", async () => {
    for (const answer of [{ status: "exploded", entries: [], hostAsks: [] }, { status: "running", entries: Array(401).fill({}), hostAsks: [] }, { status: "running", entries: [] }, { status: "running", entries: [], hostAsks: Array(51).fill({}) }]) {
      const w = setUp((call) => call.path.endsWith("/journal") ? json(200, answer) : undefined);
      expect(asRefusal(await w.send("GET", "/v1/web/projects/payments/setup-agent/journal", await w.as("ada-token")))).toEqual(refusal("unavailable"));
    }
  });

  it("the journal forwards only `after` (0 to 400) and refuses any other query", async () => {
    const w = setUp();
    const headers = await w.as("pam-token");
    expect((await w.send("GET", "/v1/web/projects/payments/setup-agent/journal?after=12", headers)).body).toEqual({ status: "none", entries: [], hostAsks: [] });
    expect((await w.send("GET", "/v1/web/projects/payments/setup-agent/journal", headers)).status).toBe(200);
    for (const query of ["after=401", "after=-1", "after=01", "after=1&after=2", "after=1&company=" + B, "taskId=x"]) {
      expect(asRefusal(await w.send("GET", `/v1/web/projects/payments/setup-agent/journal?${query}`, headers))).toEqual(refusal("invalid"));
    }
    expect(w.codeCalls().map((call) => call.path + call.search)).toEqual(["/v1/app/projects/payments/setup-agent/journal?after=12", "/v1/app/projects/payments/setup-agent/journal"]);
  });
});
