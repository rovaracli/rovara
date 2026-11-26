// Guided onboarding PR 17 (DEC 254n item 3): a project's archive and restore through Cloud's handler, preview first, answered from Code
// (PrepLabsAI/Rovara #839) as the signed-in person. The pretend Code here keeps two companies and applies Code's rule (a live company owner or
// admin, or the project's admin, may change; a project user sees the preview with no action; anyone else, another company included, "project not
// found"). Cloud must: pass the person's own token, put the project only into Code's path, never let the browser name or pin a company, forward
// only a checked body with its acknowledgement, check Code's answers, and answer refusals in its fixed words.
import { describe, expect, it } from "vitest";
import { CodeClient, LIFECYCLE_ANSWERS, LIFECYCLE_WORDS, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { PROJECT_LIFECYCLE_WORDS } from "../../packages/contracts/src/project-lifecycle.js";
import { ReviewedProjectArchiveOutcomeReaderSchema, ReviewedProjectArchivePreviewReaderSchema } from "../../packages/contracts/src/reviewed-project-archive.js";
import { ReviewedProjectRestoreOutcomeReaderSchema, ReviewedProjectRestorePreviewReaderSchema } from "../../packages/contracts/src/reviewed-project-restore.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64), PAM = "b".repeat(64), BOB = "c".repeat(64), NOB = "d".repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REQUEST_ID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";

interface Person { company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person & { id: string }> = {
  "ada-token": { id: ADA, company: A, role: "owner", grants: {} },
  "pam-token": { id: PAM, company: A, role: "member", grants: { payments: "developer" } },
  "bob-token": { id: BOB, company: B, role: "admin", grants: {} },
  "nob-token": { id: NOB, grants: {} },
};
const PROJECTS: Record<string, string> = { payments: A, ledger: B };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall) => Response | undefined;

/** A small pretend Code applying #839's rule; `override` replaces its answer for a test. */
function setUp(override: Override = () => undefined, accessAnswer?: () => Response) {
  const calls: CodeCall[] = [];
  const state: Record<string, { status: "active" | "archived"; revision: number; receipts: Map<string, unknown> }> = {
    payments: { status: "active", revision: 0, receipts: new Map() }, ledger: { status: "active", revision: 0, receipts: new Map() },
  };
  const preview = (kind: "archive" | "restore", project: string, manage: boolean) => {
    const s = state[project]!;
    return {
      orgId: PROJECTS[project], project, status: s.status, expectedRevision: s.revision, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z",
      ...(kind === "restore" ? { prerequisites: "not_required" } : {}),
      access: { actions: manage && s.status === (kind === "archive" ? "active" : "archived") ? [kind] : [] },
      impact: kind === "archive" ? { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 2, slackChannelsStayLinked: true, deletesNothing: true } : { allowsNewWork: true, linkedSlackChannels: 2 },
    };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const token = (call.authorization ?? "").replace(/^Bearer /u, "");
    const person = PEOPLE[token];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access" && accessAnswer !== undefined) return accessAnswer();
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: Object.entries(person.grants).map(([name, access]) => ({ name, access })), notices: [] });
    }
    const replaced = override(call);
    if (replaced !== undefined) return replaced;
    const match = /^\/v1\/dev\/client\/projects\/([^/]+)\/(archive-preview|archive|restore-preview|restore)$/u.exec(url.pathname);
    if (match === null) return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const project = decodeURIComponent(match[1]!), action = match[2]!;
    // Code's rule: the project's own company only; owners/admins and project admins manage; a project user views; anyone else: not found.
    if (person.company === undefined || PROJECTS[project] !== person.company) return json(404, { error: { code: "NOT_FOUND", message: "project not found", leak: LEAK } });
    const grant = person.grants[project];
    const manage = person.role === "owner" || person.role === "admin" || grant === "administrator";
    if (!manage && grant !== "developer") return json(404, { error: { code: "NOT_FOUND", message: "project not found" } });
    if (action === "archive-preview") return json(200, preview("archive", project, manage));
    if (action === "restore-preview") return json(200, preview("restore", project, manage));
    const kind = action as "archive" | "restore";
    const body = call.body as Record<string, unknown>;
    const ack = kind === "archive" ? "acknowledgeNewWorkStops" : "acknowledgeNewWorkAllowed";
    if (body[ack] !== true) return json(400, { error: { code: "CONFIG_INVALID", message: "the request is not valid" } });
    if (!manage) return json(403, { error: { code: "FORBIDDEN", message: `${LEAK} Only company owners and admins` } });
    const s = state[project]!;
    const earlier = s.receipts.get(body["requestId"] as string);
    if (earlier !== undefined) return json(200, { ...(earlier as object), replayed: true });
    if (body["expectedOrgId"] !== person.company || body["expectedRevision"] !== s.revision || s.status !== (kind === "archive" ? "active" : "archived")) {
      return json(409, { error: { code: "CHANGE_STALE", message: `${LEAK} stale` } });
    }
    s.status = kind === "archive" ? "archived" : "active"; s.revision += 1;
    const receipt = { project, status: s.status, revision: s.revision, projectRevision: 3, [kind === "archive" ? "archivedAt" : "restoredAt"]: "2026-11-17T10:01:00.000Z", egressReconciliation: "pending" };
    const outcome = { receipt, replayed: false, current: preview(kind, project, manage), effects: kind === "archive" ? { egress: "not_attempted", archiveHook: "not_configured" } : { egress: "not_attempted" } };
    s.receipts.set(body["requestId"] as string, outcome);
    return json(200, outcome);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const as = async (token: string) => {
    const person = PEOPLE[token]!;
    // The stored sign-in names company A for everyone: Cloud must use Code's live answer, never this.
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
  const lifecycleCalls = () => calls.filter((call) => call.path.startsWith("/v1/dev/client/projects/"));
  return { as, send, calls, lifecycleCalls, state };
}
const change = (extra: Record<string, unknown> = {}) => ({ requestId: REQUEST_ID, expectedOrgId: A, expectedRevision: 0, expectedProjectRevision: 3, acknowledgeNewWorkStops: true, ...extra });
const restoreChange = (extra: Record<string, unknown> = {}) => ({ requestId: REQUEST_ID, expectedRevision: 1, expectedProjectRevision: 3, acknowledgeNewWorkAllowed: true, ...extra });
const words = (answer: { body: unknown }) => (answer.body as { error: { code: string; message: string } }).error;

describe("the fixed words", () => {
  it("are the same in Cloud's server and in the app's contracts (the app shows only these)", () => {
    expect({ ...LIFECYCLE_WORDS }).toEqual({ ...PROJECT_LIFECYCLE_WORDS });
  });
});

describe("previews", () => {
  it("an owner's archive preview: Code gets the person's own token and the project only in its path; the preview and its impact pass through", async () => {
    const w = setUp();
    const res = await w.send("GET", "/v1/web/projects/payments/archive-preview?company=org_bbbbbbbbbbbbbbbbbbbb&orgId=org_bbbbbbbbbbbbbbbbbbbb", { ...await w.as("ada-token"), "x-rovara-company": B });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orgId: A, project: "payments", status: "active", access: { actions: ["archive"] }, impact: { linkedSlackChannels: 2, deletesNothing: true } });
    expect(w.lifecycleCalls()).toEqual([expect.objectContaining({ method: "GET", path: "/v1/dev/client/projects/payments/archive-preview", search: "", authorization: "Bearer ada-token" })]);
    // Nothing the browser sent names a company to Code: no query, no header.
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("a project user (plain member) gets the preview with no action, and the lifecycle read offers none", async () => {
    const w = setUp();
    const headers = await w.as("pam-token");
    expect((await w.send("GET", "/v1/web/projects/payments/archive-preview", headers)).body).toMatchObject({ access: { actions: [] } });
    expect((await w.send("GET", "/v1/web/projects/payments/lifecycle", headers)).body).toEqual({ status: "active", actions: [] });
    // Archived: the member is offered no restore either.
    w.state["payments"]!.status = "archived";
    expect((await w.send("GET", "/v1/web/projects/payments/restore-preview", headers)).body).toMatchObject({ access: { actions: [] } });
    expect((await w.send("GET", "/v1/web/projects/payments/lifecycle", headers)).body).toEqual({ status: "archived", actions: [] });
  });

  it("the lifecycle read: active -> archive for a manager; archived -> asks the restore preview -> restore", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    expect((await w.send("GET", "/v1/web/projects/payments/lifecycle", headers)).body).toEqual({ status: "active", actions: ["archive"] });
    w.state["payments"]!.status = "archived";
    expect((await w.send("GET", "/v1/web/projects/payments/lifecycle", headers)).body).toEqual({ status: "archived", actions: ["restore"] });
    expect(w.lifecycleCalls().map((call) => call.path)).toEqual([
      "/v1/dev/client/projects/payments/archive-preview", "/v1/dev/client/projects/payments/archive-preview", "/v1/dev/client/projects/payments/restore-preview",
    ]);
  });

  it("a restore preview with prerequisites not_required (what Code answers) passes", async () => {
    const w = setUp();
    w.state["payments"]!.status = "archived";
    const res = await w.send("GET", "/v1/web/projects/payments/restore-preview", await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ prerequisites: "not_required", access: { actions: ["restore"] }, impact: { allowsNewWork: true } });
  });
});

describe("two companies", () => {
  for (const [who, project] of [["ada-token", "ledger"], ["bob-token", "payments"]] as const) {
    for (const [method, path, body] of [["GET", "archive-preview", undefined], ["GET", "restore-preview", undefined], ["GET", "lifecycle", undefined], ["POST", "reviewed-archive", change({ expectedOrgId: undefined })], ["POST", "reviewed-restore", restoreChange()]] as const) {
      it(`${who.split("-")[0]} cannot ${method} ${path} of the other company's ${project}: Code's 404 is one fixed sentence`, async () => {
        const w = setUp();
        const res = await w.send(method, `/v1/web/projects/${project}/${path}`, await w.as(who), body);
        expect(res).toMatchObject({ status: 404, body: LIFECYCLE_ANSWERS.notFound.body });
        expect(res.text).not.toContain(LEAK);
        expect(w.state[project]!.status).toBe("active");
      });
    }
  }

  it("a person in company A can never pin company B: the browser's B is stale, and Code is not asked", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", await w.as("ada-token"), change({ expectedOrgId: B }));
    expect(res).toMatchObject({ status: 409, body: LIFECYCLE_ANSWERS.stale.body });
    expect(w.lifecycleCalls()).toEqual([]);
  });

  it("a company pin comes only from Code's access answer: forwarded even when the browser sends none", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", await w.as("ada-token"), change({ expectedOrgId: undefined }));
    expect(res.status).toBe(200);
    expect(w.lifecycleCalls()[0]!.body).toEqual({ requestId: REQUEST_ID, expectedOrgId: A, expectedRevision: 0, expectedProjectRevision: 3, acknowledgeNewWorkStops: true });
  });

  it("Code's answer for another company than the person's is never passed on", async () => {
    const w = setUp((call) => call.path.endsWith("/archive-preview") ? json(200, { orgId: B, project: "payments", status: "active", expectedRevision: 0, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z", access: { actions: ["archive"] } }) : undefined);
    const res = await w.send("GET", "/v1/web/projects/payments/archive-preview", await w.as("ada-token"));
    expect(res).toMatchObject({ status: 503, body: LIFECYCLE_ANSWERS.unavailable.body });
    expect(res.text).not.toContain(B);
  });

  const base = (kind: "archive" | "restore") => ({ orgId: A, project: "payments", status: kind === "archive" ? "active" : "archived", expectedRevision: 0, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z", ...(kind === "restore" ? { prerequisites: "not_required" } : {}), access: { actions: [kind] } });
  for (const kind of ["archive", "restore"] as const) {
    for (const [what, twist] of [["another project", { project: "ledger" }], ["another company", { orgId: B }], ["the other action", { access: { actions: [kind === "archive" ? "restore" : "archive"] } }], ["an extra member", { leak: LEAK }]] as const) {
      it(`a ${kind} preview naming ${what} is never passed on (preview and lifecycle read)`, async () => {
        const w = setUp((call) => call.path.endsWith(`/${kind}-preview`) ? json(200, { ...base(kind), ...twist }) : call.path.endsWith("/archive-preview") ? json(200, { ...base("archive"), status: "archived", access: { actions: [] } }) : undefined);
        const headers = await w.as("ada-token");
        for (const path of [`${kind}-preview`, "lifecycle"]) {
          const res = await w.send("GET", `/v1/web/projects/payments/${path}`, headers);
          expect(res).toMatchObject({ status: 503, body: LIFECYCLE_ANSWERS.unavailable.body });
          expect(res.text).not.toContain(LEAK);
          expect(res.text).not.toContain("ledger");
        }
      });
    }
  }

  it("a change without the sign-in's CSRF value is refused by the handler, and Code is not asked", async () => {
    const w = setUp();
    const { cookie } = await w.as("ada-token");
    const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", { cookie }, change());
    expect(res.status).toBe(403);
    expect(words(res).code).toBe("CSRF_INVALID");
    expect(w.lifecycleCalls()).toEqual([]);
  });

  it("Code's access check failing reaches the app in Cloud's fixed words, never Code's text", async () => {
    const w = setUp(undefined, () => json(500, { error: { code: "INTERNAL", message: LEAK } }));
    const res = await w.send("GET", "/v1/web/projects/payments/archive-preview", await w.as("ada-token"));
    expect(res).toMatchObject({ status: 503, body: LIFECYCLE_ANSWERS.unavailable.body });
    expect(res.text).not.toContain(LEAK);
    expect(w.lifecycleCalls()).toEqual([]);
  });

  it("a person Code names no company for gets NO_COMPANY, and Code's lifecycle routes are not asked", async () => {
    const w = setUp();
    const headers = await w.as("nob-token");
    for (const path of ["archive-preview", "lifecycle"]) expect((await w.send("GET", `/v1/web/projects/payments/${path}`, headers)).status).toBe(403);
    expect((await w.send("POST", "/v1/web/projects/payments/reviewed-archive", headers, change())).status).toBe(403);
    expect(w.lifecycleCalls()).toEqual([]);
  });
});

describe("changes", () => {
  it("archive then restore by an owner; each forwarded body is rebuilt from the checked fields; a repeat answers replayed", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    const archived = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", headers, change());
    expect(archived).toMatchObject({ status: 200, body: { replayed: false, receipt: { status: "archived", revision: 1 } } });
    const again = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", headers, change());
    expect(again).toMatchObject({ status: 200, body: { replayed: true } });
    const restored = await w.send("POST", "/v1/web/projects/payments/reviewed-restore", headers, restoreChange({ requestId: "7f9d0c1e-2b3a-4c5d-8e7f-001122334455" }));
    expect(restored).toMatchObject({ status: 200, body: { replayed: false, receipt: { status: "active", revision: 2 } } });
    expect(w.lifecycleCalls().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/dev/client/projects/payments/archive", "POST /v1/dev/client/projects/payments/archive", "POST /v1/dev/client/projects/payments/restore",
    ]);
    expect(w.lifecycleCalls()[2]!.body).toEqual({ requestId: "7f9d0c1e-2b3a-4c5d-8e7f-001122334455", expectedOrgId: A, expectedRevision: 1, expectedProjectRevision: 3, acknowledgeNewWorkAllowed: true });
  });

  it("a plain member's change: Code's 403 in Cloud's fixed words, nothing changed", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", await w.as("pam-token"), change());
    expect(res).toMatchObject({ status: 403, body: LIFECYCLE_ANSWERS.notAllowed.body });
    expect(res.text).not.toContain(LEAK);
    expect(w.state["payments"]!.status).toBe("active");
  });

  it("the stale preview flow: a change on an old revision is 409 CHANGE_STALE in fixed words; a fresh preview then a change succeeds", async () => {
    const w = setUp();
    const headers = await w.as("ada-token");
    w.state["payments"]!.revision = 4; // someone changed it after this person's preview
    const stale = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", headers, change());
    expect(stale).toMatchObject({ status: 409, body: LIFECYCLE_ANSWERS.stale.body });
    expect(stale.text).not.toContain(LEAK);
    const fresh = await w.send("GET", "/v1/web/projects/payments/archive-preview", headers);
    const revision = (fresh.body as { expectedRevision: number }).expectedRevision;
    expect(revision).toBe(4);
    expect((await w.send("POST", "/v1/web/projects/payments/reviewed-archive", headers, change({ requestId: "8f9d0c1e-2b3a-4c5d-8e7f-001122334455", expectedRevision: revision }))).status).toBe(200);
  });

  const bad: Array<[string, unknown]> = [
    ["no acknowledgement", change({ acknowledgeNewWorkStops: undefined })],
    ["a false acknowledgement", change({ acknowledgeNewWorkStops: false })],
    ["a string acknowledgement", change({ acknowledgeNewWorkStops: "true" })],
    ["the restore acknowledgement on an archive", { ...change({ acknowledgeNewWorkStops: undefined }), acknowledgeNewWorkAllowed: true }],
    ["an extra member (company)", change({ company: B })],
    ["an extra member (orgId)", change({ orgId: B })],
    ["an extra member (project)", change({ project: "ledger" })],
    ["an extra member (personId)", change({ personId: BOB })],
    ["a request id that isn't a UUID", change({ requestId: `${LEAK}` })],
    ["a negative revision", change({ expectedRevision: -1 })],
    ["a project revision of 0", change({ expectedProjectRevision: 0 })],
    ["a fractional revision", change({ expectedRevision: 0.5 })],
    ["a company pin that isn't a company id", change({ expectedOrgId: LEAK })],
    ["an array", [change()]],
    ["a string", "\"archive\""],
    ["null", "null"],
  ];
  for (const [what, body] of bad) {
    it(`refuses ${what} in fixed words, without asking Code`, async () => {
      const w = setUp();
      const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", await w.as("ada-token"), body);
      expect(res).toMatchObject({ status: 400, body: LIFECYCLE_ANSWERS.invalid.body });
      expect(res.text).not.toContain(LEAK);
      expect(w.lifecycleCalls()).toEqual([]);
    });
  }

  it("refuses a restore without its own acknowledgement (the archive one doesn't count)", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/reviewed-restore", await w.as("ada-token"), { ...restoreChange({ acknowledgeNewWorkAllowed: undefined }), acknowledgeNewWorkStops: true });
    expect(res).toMatchObject({ status: 400, body: LIFECYCLE_ANSWERS.invalid.body });
    expect(w.lifecycleCalls()).toEqual([]);
  });

  for (const name of ["Payments", "-x", "a".repeat(64), "pay%2Fments", "pay..ments"]) {
    it(`a path that can't be a project name (${name.slice(0, 12)}) is not found without asking Code`, async () => {
      const w = setUp();
      const res = await w.send("GET", `/v1/web/projects/${name}/archive-preview`, await w.as("ada-token"));
      expect([404, 501]).toContain(res.status);
      expect(w.lifecycleCalls()).toEqual([]);
    });
  }

  it("an outcome that doesn't read as this change is unconfirmed (503), never passed on", async () => {
    for (const twist of [{ extra: LEAK }, { receipt: { project: "ledger" } }, { current: { orgId: B } }]) {
      const w = setUp((call) => {
        if (call.method !== "POST") return undefined;
        const ok = { receipt: { project: "payments", status: "archived", revision: 1, projectRevision: 3, archivedAt: "2026-11-17T10:01:00.000Z", egressReconciliation: "pending" }, replayed: false,
          current: { orgId: A, project: "payments", status: "archived", expectedRevision: 1, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:01:00.000Z", access: { actions: [] } }, effects: { egress: "not_attempted", archiveHook: "not_configured" } };
        const merged = { ...ok, ...("extra" in twist ? twist : {}), receipt: { ...ok.receipt, ...("receipt" in twist ? twist.receipt : {}) }, current: { ...ok.current, ...("current" in twist ? twist.current : {}) } };
        return json(200, merged);
      });
      const res = await w.send("POST", "/v1/web/projects/payments/reviewed-archive", await w.as("ada-token"), change());
      expect(res).toMatchObject({ status: 503, body: LIFECYCLE_ANSWERS.unavailable.body });
      expect(res.text).not.toContain(LEAK);
    }
  });
});

describe("Code's refusals in Cloud's fixed words", () => {
  const cases: Array<[string, Response, { status: number; body: unknown }]> = [
    ["the unknown-route 404 (Code without #839)", json(404, { error: { code: "NOT_FOUND", message: "route not found" } }), LIFECYCLE_ANSWERS.notYet],
    ["another 404", json(404, { error: { code: "NOT_FOUND", message: LEAK } }), LIFECYCLE_ANSWERS.notFound],
    ["a 400", json(400, { error: { code: "CONFIG_INVALID", message: LEAK } }), LIFECYCLE_ANSWERS.invalid],
    ["a 403", json(403, { error: { code: "FORBIDDEN", message: LEAK } }), LIFECYCLE_ANSWERS.notAllowed],
    ["a 409", json(409, { error: { code: "CHANGE_STALE", message: LEAK } }), LIFECYCLE_ANSWERS.stale],
    ["the not-on-the-engine 503", json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LIFECYCLE_WORDS.notOnEngine } }), LIFECYCLE_ANSWERS.notOnEngine],
    ["another 503", json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }), LIFECYCLE_ANSWERS.unavailable],
    ["a 500", json(500, { error: { code: "INTERNAL", message: LEAK } }), LIFECYCLE_ANSWERS.unavailable],
    ["a 418 with no body", new Response("", { status: 418 }), LIFECYCLE_ANSWERS.unavailable],
  ];
  for (const [what, response, expected] of cases) {
    for (const [method, path, body] of [["GET", "archive-preview", undefined], ["POST", "reviewed-archive", change()], ["GET", "lifecycle", undefined]] as const) {
      it(`${what} on ${method} ${path}`, async () => {
        const w = setUp(() => response.clone());
        const res = await w.send(method, `/v1/web/projects/payments/${path}`, await w.as("ada-token"), body);
        expect({ status: res.status, body: res.body }).toEqual({ status: expected.status, body: expected.body });
        expect(res.text).not.toContain(LEAK);
        expect(words(res).message).toBe(words(expected).message);
      });
    }
  }
});

// LIFECYCLE-SERVER-INCARNATION: Code serves `expectedProjectIncarnation` on the preview, and inside `current` of the outcome, for a project that has an incarnation. Cloud's server refused
// the unknown member, so such a project's preview and outcome answered "unavailable" (503) here. It is accepted now, with Code's exact shape, and the check is strict otherwise.
describe("an incarnation on Code's preview and outcome passes through the server", () => {
  const preview = (kind: "archive" | "restore", extra: Record<string, unknown> = {}) => ({
    orgId: A, project: "payments", status: kind === "archive" ? "active" : "archived", expectedRevision: kind === "archive" ? 0 : 1, expectedProjectRevision: 3, expectedProjectIncarnation: 5, checkedAt: "2026-11-17T10:00:00.000Z",
    ...(kind === "restore" ? { prerequisites: "not_required" } : {}), access: { actions: [kind] }, ...extra,
  });
  const outcome = (kind: "archive" | "restore", current: Record<string, unknown>) => kind === "archive"
    ? { receipt: { project: "payments", status: "archived", revision: 1, projectRevision: 3, archivedAt: "2026-11-17T10:01:00.000Z", egressReconciliation: "pending" }, replayed: false, current, effects: { egress: "not_attempted", archiveHook: "not_configured" } }
    : { receipt: { project: "payments", status: "active", revision: 2, projectRevision: 3, restoredAt: "2026-11-17T10:01:00.000Z", egressReconciliation: "pending" }, replayed: false, current, effects: { egress: "not_attempted" } };
  const readers = { archive: [ReviewedProjectArchivePreviewReaderSchema, ReviewedProjectArchiveOutcomeReaderSchema], restore: [ReviewedProjectRestorePreviewReaderSchema, ReviewedProjectRestoreOutcomeReaderSchema] } as const;
  for (const kind of ["archive", "restore"] as const) {
    it(`${kind}: a preview and an outcome that name the incarnation are answered (not 503), and the app's readers keep it`, async () => {
      const w = setUp((call) => call.path.endsWith(`/${kind}-preview`) ? json(200, preview(kind)) : call.method === "POST" ? json(200, outcome(kind, preview(kind, { status: kind === "archive" ? "archived" : "active", access: { actions: [] } }))) : undefined);
      const headers = await w.as("ada-token");
      const seen = await w.send("GET", `/v1/web/projects/payments/${kind}-preview`, headers);
      expect(seen).toMatchObject({ status: 200, body: { expectedProjectIncarnation: 5 } });
      expect(readers[kind][0].parse(seen.body)).toMatchObject({ expectedProjectIncarnation: 5 });
      const done = await w.send("POST", `/v1/web/projects/payments/reviewed-${kind}`, headers, kind === "archive" ? change() : restoreChange());
      expect(done.status).toBe(200);
      expect(readers[kind][1].parse(done.body)).toMatchObject({ current: { expectedProjectIncarnation: 5 } });
    });
    it(`${kind}: a preview with no incarnation still passes, and one that is not a positive whole number, or an unknown member beside it, is still refused`, async () => {
      for (const [what, extra, ok] of [["none", {}, true], ["a string", { expectedProjectIncarnation: "5" }, false], ["0", { expectedProjectIncarnation: 0 }, false], ["a fraction", { expectedProjectIncarnation: 1.5 }, false], ["null", { expectedProjectIncarnation: null }, false], ["an unknown member", { somethingElse: 1 }, false]] as const) {
        const body = preview(kind, extra); if (what === "none") delete (body as Record<string, unknown>)["expectedProjectIncarnation"];
        const w = setUp((call) => call.path.endsWith(`/${kind}-preview`) ? json(200, body) : undefined);
        expect((await w.send("GET", `/v1/web/projects/payments/${kind}-preview`, await w.as("ada-token"))).status, what).toBe(ok ? 200 : 503);
      }
    });
  }
});
