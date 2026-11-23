// SETUP-WIKI-CLOUD-FIXES (a): a website a setup run asked for is allowed or refused through Cloud (Code's host-decide), as the signed-in person. Code's authority check (a live company owner or admin) stays the only gate:
// Cloud must pass the person's OWN token, put the project only into Code's path, forward only the checked body, rebuild the answer, say Code's refusal in fixed words (a Code 403 reaches the app as a 403), never
// replay a write whose outcome is unknown, and add no rule of its own. (b): the project's overview, detail and list say what Code's real checklist says about the setup, so "Setup needs attention" can clear.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, SETUP_HOST_WORDS, SETUP_CHECKLIST_WORDS, SETUP_APPROVAL_WORDS, createCloudHandler, hostDecideBody, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { SetupHostDecideReplySchema, SetupJournalReplySchema } from "../../packages/contracts/src/setup-agent-web.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const HOST = "registry.npmjs.org";
const DIGEST = "ab".repeat(32);
const REQUEST_ID = `host-${"c".repeat(40)}`;

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer"> }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: "a".repeat(64), company: A, role: "owner", grants: {} },
  "pia-token": { id: "e".repeat(64), company: A, role: "member", grants: { payments: "administrator" } },
  "pam-token": { id: "b".repeat(64), company: A, role: "member", grants: { payments: "developer" } },
  "bob-token": { id: "c".repeat(64), company: B, role: "admin", grants: {} },
};

type ChecklistRun = { state: string; status: string; approval: string; check?: { status: string; failedStep?: string } };
interface Options {
  asks?: unknown[]; override?: (path: string, method: string, body: unknown, person: Person) => Response | undefined | Promise<Response | undefined>; run?: ChecklistRun | "unreadable" | "refused";
}
function setUp(options: Options = {}) {
  const calls: Array<{ method: string; path: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }> = [];
  let open = true;
  const run: ChecklistRun = options.run === undefined || typeof options.run === "string" ? { state: "needs_you", status: "none", approval: "none" } : options.run;
  const checklist = (project: string) => ({
    project, viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 1, total: 8, percent: 12, nextRequired: "setupRun" },
    repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
    setupRun: run,
    evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
    slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", hasTask: false, canStart: false },
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, authorization: headers["authorization"], headers, body });
    const person = PEOPLE[(headers["authorization"] ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: Object.entries(person.grants).map(([name, access]) => ({ name, access })).concat(person.role === "owner" || person.role === "admin" ? [{ name: "payments", access: "administrator" }] : []), notices: [] });
    }
    const replaced = await options.override?.(url.pathname, method, body, person);
    if (replaced !== undefined) return replaced;
    if (url.pathname === "/v1/dev/client/projects/payments/setup-status") {
      if (options.run === "unreadable") return json(200, { project: "payments", nonsense: true });
      if (options.run === "refused") return err(500, "INTERNAL", LEAK);
      return json(200, checklist("payments"));
    }
    if (url.pathname === "/v1/dev/client/projects/payments") return json(200, { name: "payments", latestRevision: 3, repositories: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] });
    const journal = /^\/v1\/app\/projects\/payments\/setup-agent\/journal$/u.exec(url.pathname);
    if (journal !== null) return json(200, { status: "ready", entries: [], hostAsks: options.asks ?? [{ host: HOST, status: "open", canDecide: person.role !== "member", approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } }], secret: LEAK });
    if (url.pathname === "/v1/app/projects/payments/setup-agent/host-decide" && method === "POST") {
      if (person.role === "member") return err(403, "FORBIDDEN", "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.");
      const asked = body as { host: string; outcome: string; requestId: string; seen: { revision: number; artifactDigest: string } };
      if (!open || asked.requestId !== REQUEST_ID || asked.seen.artifactDigest !== DIGEST) return err(409, "CHANGE_STALE", `${LEAK} moved`);
      open = false;
      return json(200, { project: "payments", host: asked.host, decision: asked.outcome === "approve" ? "approved" : "refused", replayed: false, secret: LEAK });
    }
    return err(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const signedIn = new Map<string, Record<string, string>>();
  const as = async (token: string) => {
    const known = signedIn.get(token);
    if (known !== undefined) return known;
    const person = PEOPLE[token] ?? { id: "f".repeat(64), grants: {} };
    // The stored sign-in names company A as owner for everyone: Cloud must use Code's live answer, never this.
    const access = { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    const headers = { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
    signedIn.set(token, headers);
    return headers;
  };
  const send = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown, text: answered!.body };
  };
  const codeCalls = () => calls.filter((call) => call.path !== "/v1/dev/access");
  return { as, send, calls, codeCalls };
}
const errorOf = (answer: { body: unknown }) => (answer.body as { error: { code: string; message: string } }).error;
const DECIDE = "/v1/web/projects/payments/setup-agent/host-decide";
const body = (extra: Record<string, unknown> = {}) => ({ requestId: REQUEST_ID, host: HOST, outcome: "approve", seen: { revision: 1, artifactDigest: DIGEST }, ...extra });

describe("allowing or refusing a website a setup run asked for", () => {
  it("forwards only the checked body to Code's host-decide as the person (their own token), the project only in the path; the answer is rebuilt and reads in the app's schema", async () => {
    const w = setUp();
    const headers = { ...await w.as("ada-token"), "x-rovara-company": B };
    const res = await w.send("POST", DECIDE + "?company=" + B, headers, body({ reason: "needed for installs" }));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    expect(res.body).toEqual({ project: "payments", host: HOST, decision: "approved", replayed: false });
    expect(SetupHostDecideReplySchema.parse(res.body)).toMatchObject({ decision: "approved" });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/setup-agent/host-decide", authorization: "Bearer ada-token", body: body({ reason: "needed for installs" }) })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("a refusal is the other answer: reject says refused", async () => {
    const w = setUp();
    const res = await w.send("POST", DECIDE, await w.as("ada-token"), body({ outcome: "reject" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project: "payments", host: HOST, decision: "refused", replayed: false });
  });

  it("Code's 403 reaches the app as a 403 in the fixed words; Cloud adds no authority check of its own (a project admin who is not a company admin is asked of Code, and Code says no)", async () => {
    const w = setUp();
    const res = await w.send("POST", DECIDE, await w.as("pia-token"), body());
    expect(res.status).toBe(403);
    expect(errorOf(res)).toEqual({ code: "FORBIDDEN", message: SETUP_HOST_WORDS.cannotDecide });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/setup-agent/host-decide", authorization: "Bearer pia-token" })]);
  });

  it("another company's person reaches only their own company's project: Code's 404 is 'project not found', never Code's text", async () => {
    const w = setUp({ override: (path, _method, _body, person) => (path.endsWith("/host-decide") && person.company === B ? err(404, "NOT_FOUND", `project not found ${LEAK}`) : undefined) });
    const res = await w.send("POST", DECIDE, await w.as("bob-token"), body());
    expect(res.status).toBe(404);
    expect(errorOf(res)).toEqual({ code: "NOT_FOUND", message: SETUP_CHECKLIST_WORDS.notFound });
    expect(res.text).not.toContain(LEAK);
  });

  it("refuses a body that is not exactly the checked one, without asking Code", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const bad: unknown[] = [
      {}, body({ requestId: "setup-abc" }), body({ requestId: "host-" }), body({ host: "Registry.NPMJS.org" }), body({ host: "localhost" }), body({ host: "a b.com" }), body({ outcome: "allow" }), body({ seen: { revision: 0, artifactDigest: DIGEST } }),
      body({ seen: { revision: 1, artifactDigest: "ABC" } }), body({ seen: { revision: 1, artifactDigest: DIGEST, extra: 1 } }), body({ company: B }), body({ reason: "x".repeat(501) }), body({ reason: "a\u0000b" }), [], null, '"text"',
    ];
    for (const one of bad) {
      const res = await w.send("POST", DECIDE, ada, one);
      expect(res.status, JSON.stringify(one)).toBe(400);
      expect(errorOf(res).code).toBe("CONFIG_INVALID");
    }
    expect(w.codeCalls()).toEqual([]);
    expect(hostDecideBody(body())).toBeDefined();
    expect(hostDecideBody(body({ extra: true }))).toBeUndefined();
  });

  it("an ask that moved or already closed is a 409 in fixed words; an unknown route on Code is 'not on this Rovara yet'", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const moved = await w.send("POST", DECIDE, ada, body({ seen: { revision: 1, artifactDigest: "cd".repeat(32) } }));
    expect(moved.status).toBe(409);
    expect(errorOf(moved)).toEqual({ code: "CHANGE_STALE", message: SETUP_HOST_WORDS.notWaiting });
    expect(moved.text).not.toContain(LEAK);
    const gone = setUp({ override: (path) => (path.endsWith("/host-decide") ? err(404, "NOT_FOUND", "route not found") : undefined) });
    const old = await gone.send("POST", DECIDE, await gone.as("ada-token"), body());
    expect(old.status).toBe(501);
    expect(errorOf(old)).toEqual({ code: "NOT_ON_CODE_YET", message: SETUP_HOST_WORDS.notYet });
  });

  it("a Code sentence is passed on only when it is exactly a fixed one; a double send of the same id is Code's replay, shown as the same answer", async () => {
    const said = setUp({ override: (path) => (path.endsWith("/host-decide") ? err(409, "CHANGE_STALE", "That website is not waiting for a decision any more. Open the project's setup again.") : undefined) });
    const res = await said.send("POST", DECIDE, await said.as("ada-token"), body());
    expect(errorOf(res).message).toBe(SETUP_HOST_WORDS.notWaiting);
    const replay = setUp({ override: (path) => (path.endsWith("/host-decide") ? json(200, { project: "payments", host: HOST, decision: "approved", replayed: true }) : undefined) });
    const again = await replay.send("POST", DECIDE, await replay.as("ada-token"), body());
    expect(again.body).toEqual({ project: "payments", host: HOST, decision: "approved", replayed: true });
    const conflict = setUp({ override: (path) => (path.endsWith("/host-decide") ? err(409, "IDEMPOTENCY_CONFLICT", LEAK) : undefined) });
    const reused = await conflict.send("POST", DECIDE, await conflict.as("ada-token"), body());
    expect(errorOf(reused)).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: SETUP_APPROVAL_WORDS.conflict });
  });

  it("a Code answer that does not match what was asked is unreadable: the wrong host, the wrong decision, another project, a missing replayed flag", async () => {
    const wrong: Array<Record<string, unknown>> = [
      { project: "payments", host: "evil.example.com", decision: "approved", replayed: false }, { project: "payments", host: HOST, decision: "refused", replayed: false },
      { project: "ledger", host: HOST, decision: "approved", replayed: false }, { project: "payments", host: HOST, decision: "approved" }, { project: "payments", host: HOST, decision: "maybe", replayed: false },
    ];
    for (const answer of wrong) {
      const w = setUp({ override: (path) => (path.endsWith("/host-decide") ? json(200, answer) : undefined) });
      const res = await w.send("POST", DECIDE, await w.as("ada-token"), body());
      expect(res.status, JSON.stringify(answer)).toBe(503);
      expect(errorOf(res).message).toBe(SETUP_CHECKLIST_WORDS.unavailable);
    }
  });

  it("an unknown outcome (the sign-in token was refused after the write was sent) is said as unknown, and the write is sent ONCE (never replayed blind)", async () => {
    const w = setUp({ override: (path, method) => { if (path.endsWith("/host-decide") && method === "POST") return json(401, {}); return undefined; } });
    const res = await w.send("POST", DECIDE, await w.as("ada-token"), body());
    expect(res.status).toBe(503);
    expect(errorOf(res).message).toContain("outcome is unknown");
    expect(w.codeCalls().filter((call) => call.path.endsWith("/host-decide"))).toHaveLength(1);
  });
});

describe("the run's journal carries each open ask's decision binding", () => {
  it("passes canDecide and the binding of an open ask; a person Code says may not decide is told so; the answer reads in the app's schema", async () => {
    const w = setUp();
    const owner = await w.send("GET", "/v1/web/projects/payments/setup-agent/journal", await w.as("ada-token"));
    expect(owner.status).toBe(200);
    const read = SetupJournalReplySchema.parse(owner.body);
    expect(read.hostAsks[0]).toMatchObject({ host: HOST, status: "open", canDecide: true, approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } });
    const member = await w.send("GET", "/v1/web/projects/payments/setup-agent/journal", await w.as("pam-token"));
    expect(SetupJournalReplySchema.parse(member.body).hostAsks[0]).toMatchObject({ canDecide: false });
  });

  it("refuses a journal whose ask is off: a bad host, an unknown state, a non-boolean canDecide, a binding on a closed ask or with another kind", async () => {
    const bad: unknown[] = [
      { host: "not a host", status: "open" }, { host: HOST, status: "waiting" }, { host: HOST, status: "open", canDecide: "yes" },
      { host: HOST, status: "approved", approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } },
      { host: HOST, status: "open", approval: { requestId: "setup-abc", revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } },
      { host: HOST, status: "open", approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: DIGEST, kind: "setup", risk: "high" } },
      { host: HOST, status: "open", approval: { requestId: REQUEST_ID, revision: 0, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } },
      { host: HOST, status: "open", approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: "xyz", kind: "setup_host", risk: "high" } },
    ];
    for (const ask of bad) {
      const w = setUp({ asks: [ask] });
      const res = await w.send("GET", "/v1/web/projects/payments/setup-agent/journal", await w.as("ada-token"));
      expect(res.status, JSON.stringify(ask)).toBe(503);
    }
  });
});

describe("the project's setup says what Code's real checklist says (it can clear)", () => {
  const overview = async (w: ReturnType<typeof setUp>) => ((await w.send("GET", "/v1/web/projects/payments/overview", await w.as("ada-token"))).body as { project: { setup: { status: string; failedStep?: string } } }).project.setup;
  const detail = async (w: ReturnType<typeof setUp>) => ((await w.send("GET", "/v1/web/projects/payments", await w.as("ada-token"))).body as { setup: { status: string } }).setup;
  const list = async (w: ReturnType<typeof setUp>) => ((await w.send("GET", "/v1/web/projects", await w.as("ada-token"))).body as { projects: Array<{ name: string; setup: { status: string } }> }).projects.find((project) => project.name === "payments")!.setup;

  it("an approved setup whose check is ready is READY in the overview, the detail and the list: the attention clears when Code says done", async () => {
    const w = setUp({ run: { state: "done", status: "ready", approval: "approved", check: { status: "ready" } } });
    expect(await overview(w)).toEqual({ status: "ready" });
    expect(await detail(w)).toEqual({ status: "ready" });
    expect(await list(w)).toEqual({ status: "ready" });
  });

  it("no approved setup yet, a proposal nobody used, or a failed run is unchecked (needs attention); a check going is checking; an approved setup whose check failed is failed with its step", async () => {
    expect(await overview(setUp())).toEqual({ status: "unchecked" });
    expect(await overview(setUp({ run: { state: "needs_you", status: "ready", approval: "none" } }))).toEqual({ status: "unchecked" });
    expect(await overview(setUp({ run: { state: "failed", status: "failed", approval: "none" } }))).toEqual({ status: "unchecked" });
    expect(await overview(setUp({ run: { state: "running", status: "ready", approval: "checking" } }))).toEqual({ status: "checking" });
    expect(await overview(setUp({ run: { state: "running", status: "ready", approval: "approved", check: { status: "checking" } } }))).toEqual({ status: "checking" });
    expect(await overview(setUp({ run: { state: "needs_you", status: "ready", approval: "approved", check: { status: "failed", failedStep: "npm test" } } }))).toEqual({ status: "failed", failedStep: "npm test" });
    // Ready needs BOTH Code's row done and its check ready: a row Code still calls Needs you is never shown as ready.
    expect(await overview(setUp({ run: { state: "needs_you", status: "ready", approval: "approved", check: { status: "ready" } } }))).toEqual({ status: "unchecked" });
    expect(await overview(setUp({ run: { state: "needs_you", status: "ready", approval: "approved", check: { status: "outdated" } } }))).toEqual({ status: "outdated" });
  });

  it("a checklist that cannot be read (a Code error, or an answer that does not read) is never ready: it is UNKNOWN (not needs-attention), and the project still opens", async () => {
    for (const run of ["refused", "unreadable"] as const) {
      const w = setUp({ run });
      expect(await overview(w)).toEqual({ status: "unknown" });
      expect(await detail(w)).toEqual({ status: "unknown" });
    }
  });

  it("a connection that fails on the checklist read (not a Code answer) is unknown too, and the project still opens", async () => {
    const w = setUp({ override: (path) => { if (path.endsWith("/setup-status")) throw new TypeError("connection lost"); return undefined; } });
    expect(await overview(w)).toEqual({ status: "unknown" });
    expect(await detail(w)).toEqual({ status: "unknown" });
  });

  it("REVIEW (lead 4 Opus): a sign-in that ended on the checklist read is NOT swallowed as unchecked: the overview signs the person out (never a 200 that keeps the page)", async () => {
    const w = setUp({ override: (path) => (path.endsWith("/setup-status") ? json(401, {}) : undefined) });
    const answered = await w.send("GET", "/v1/web/projects/payments/overview", await w.as("ada-token"));
    expect(answered.status).toBe(401);
    expect(answered.text).not.toContain("unchecked");
  });

  it("the checklist is read as the signed-in person (their own token, the project only in Code's path)", async () => {
    const w = setUp({ run: { state: "done", status: "ready", approval: "approved", check: { status: "ready" } } });
    await overview(w);
    expect(w.codeCalls().filter((call) => call.path.endsWith("/setup-status"))).toEqual([expect.objectContaining({ method: "GET", path: "/v1/dev/client/projects/payments/setup-status", authorization: "Bearer ada-token" })]);
  });
});
