// L4-D2 (DEC 254z b; Code #899): the setup approval through Cloud's handler: the run's read carries the waiting candidate (`apply`), and "Use this setup" (confirm), Discard and
// Approve or Reject (decide) are forwarded to Code as the signed-in person. The pretend Code keeps TWO companies and TWO projects, each with its own waiting candidate, and applies Code's
// rules (a project's managers confirm and discard; no step-up (owner DEC 254zzz73); low and medium risk need a maintainer, high a company owner or admin; a stale digest or revision is refused;
// another company's project reads as "project not found"). Cloud must: pass the person's own token, put the project only into Code's path, forward only checked bodies, rebuild every answer
// from known fields, never say Code's or the browser's own text, and add no rule of its own that could widen Code's.
import { describe, expect, it, vi } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, SETUP_APPROVAL_CODE_WORDS, SETUP_APPROVAL_WORDS, SETUP_CHECKLIST_WORDS, applyAnswer, confirmBody, confirmLogDetails, createCloudHandler, decideBody, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { SetupAgentViewSchema, SetupConfirmReplySchema, SetupDecideReplySchema, SetupDiscardReplySchema } from "../../packages/contracts/src/setup-agent-web.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const UUID1 = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", UUID2 = "6f9d0c1e-2b3a-4c5d-8e7f-001122334466";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grants: Record<string, "administrator" | "developer">; fresh?: boolean }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: "a".repeat(64), company: A, role: "owner", grants: {}, fresh: true },
  "ada-stale-token": { id: "a".repeat(64), company: A, role: "owner", grants: {} },
  "pia-token": { id: "e".repeat(64), company: A, role: "member", grants: { payments: "administrator" }, fresh: true },
  "pam-token": { id: "b".repeat(64), company: A, role: "member", grants: { payments: "developer" }, fresh: true },
  "bob-token": { id: "c".repeat(64), company: B, role: "admin", grants: {}, fresh: true },
  "nob-token": { id: "d".repeat(64), grants: {} },
};
const digestOf = (company: string, project: string) => (company === A ? "a" : "b").repeat(32) + (project === "payments" ? "1" : "2").repeat(32);

interface Candidate { check: "checking" | "ready" | "failed"; risk: "low" | "medium" | "high"; revision: number; decided?: string }
const key = (company: string, project: string) => `${company}/${project}`;

function setUp(options: { risk?: "low" | "medium" | "high"; check?: "checking" | "ready" | "failed"; applyExtra?: Record<string, unknown>; override?: (path: string, method: string, body: unknown, person: Person) => Response | undefined } = {}) {
  const calls: Array<{ method: string; path: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }> = [];
  // Company A holds `payments` and `ledger`; company B holds ITS OWN `payments`: the same name, another project.
  const candidates = new Map<string, Candidate>([
    [key(A, "payments"), { check: options.check ?? "ready", risk: options.risk ?? "low", revision: 4 }],
    [key(A, "ledger"), { check: "ready", risk: "low", revision: 7 }],
    [key(B, "payments"), { check: "ready", risk: "medium", revision: 9 }],
  ]);
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
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: Object.entries(person.grants).map(([name, access]) => ({ name, access })), notices: [] });
    }
    const replaced = options.override?.(url.pathname, method, body, person);
    if (replaced !== undefined) return replaced;
    const match = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(confirm|discard|decide))?$/u.exec(url.pathname);
    if (match === null) return err(404, "NOT_FOUND", "route not found");
    const project = decodeURIComponent(match[1]!), tail = match[2];
    const mine = person.company === undefined ? undefined : candidates.get(key(person.company, project));
    // Only the company's own projects exist for the person (Code's live membership); another company's, or a missing one, is the same 404.
    if (person.company === undefined || (project !== "payments" && project !== "ledger") || (person.company === B && project !== "payments")) return err(404, "NOT_FOUND", `project not found ${LEAK}`);
    const grant = person.grants[project];
    const manage = person.role === "owner" || person.role === "admin" || grant === "administrator";
    if (!manage && grant === undefined) return err(404, "NOT_FOUND", "project not found");
    const view = () => ({
      status: "ready", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: manage,
      ...(mine === undefined || mine.decided !== undefined ? {} : {
        apply: {
          candidateRevision: mine.revision, baseRevision: mine.revision - 1, setup: ["npm ci"], readiness: ["npm test"], check: { status: mine.check, ...(mine.check === "failed" ? { failedStep: "npm test" } : {}) },
          risk: mine.risk, changes: [{ area: "setup_commands", risk: "low" }, ...(mine.risk === "high" ? [{ area: "websites", risk: "high" }] : [])], approver: mine.risk === "high" ? "admin" : "maintainer",
          canApprove: mine.check === "ready" && (mine.risk === "high" ? person.role !== "member" : manage), canReject: mine.check === "ready" && manage,
          ...(mine.check === "ready" ? { approval: { requestId: `setup-${digestOf(person.company!, project).slice(0, 40)}-${String(mine.revision)}`, revision: mine.revision, artifactDigest: digestOf(person.company!, project), kind: "setup", risk: mine.risk, secret: LEAK } } : {}),
          secret: LEAK, ...options.applyExtra,
        },
      }),
    });
    if (tail === undefined) return json(200, view());
    if (!manage) return err(403, "FORBIDDEN", `${LEAK} not allowed`);
    if (tail === "confirm") {
      if (mine !== undefined && mine.decided === undefined) return err(409, "WORKSPACE_BUSY", "Another setup is waiting for your approval. Approve or reject it, or discard it, first.");
      return json(200, { digest: digestOf(person.company, project), used: ["setup-1"], unchecked: [], left: [{ id: "tests-2", reason: "unverified", note: LEAK }], candidateRevision: 5, proved: false, next: "check", secret: LEAK });
    }
    if (tail === "discard") {
      const had = mine !== undefined && mine.decided === undefined;
      if (had) mine.decided = "discarded";
      return json(200, { discarded: had });
    }
    // decide: the live risk rule, then the binding (no step-up since owner DEC 254zzz73).
    if (mine === undefined || mine.decided !== undefined) return err(409, "CHANGE_STALE", "There is no setup waiting for a decision. Open the project's setup again.");
    const asked = body as { outcome: string; seen: { revision: number; artifactDigest: string } };
    if (mine.risk === "high" && asked.outcome === "approve" && person.role === "member") return err(403, "FORBIDDEN", "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.");
    if (mine.check !== "ready" || asked.seen.artifactDigest !== digestOf(person.company, project) || asked.seen.revision !== mine.revision) return err(409, "CHANGE_STALE", `${LEAK} moved`);
    mine.decided = asked.outcome;
    return json(200, { project, decision: asked.outcome === "approve" ? "approved" : "rejected", risk: mine.risk, revision: mine.revision, replayed: false, secret: LEAK });
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
  return { as, send, calls, codeCalls, candidates };
}
const errorOf = (answer: { body: unknown }) => (answer.body as { error: { code: string; message: string } }).error;
const W = SETUP_APPROVAL_WORDS;
const seenOf = (company: string, project: string, revision: number) => ({ revision, artifactDigest: digestOf(company, project) });
const decision = (company: string, project: string, revision: number, outcome: "approve" | "reject" = "approve", extra: Record<string, unknown> = {}) => ({
  requestId: `setup-${digestOf(company, project).slice(0, 40)}-${String(revision)}`, outcome, seen: seenOf(company, project, revision), ...extra,
});

describe("the run's read carries the waiting candidate", () => {
  it("is rebuilt from known fields at every level and reads in the app's schema; the approval binding is passed whole, the rest of Code's extras are not", async () => {
    const w = setUp({ applyExtra: { nested: { token: LEAK } } });
    const res = await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("ada-token"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    const view = SetupAgentViewSchema.parse(res.body);
    expect(view.apply).toMatchObject({ candidateRevision: 4, risk: "low", approver: "maintainer", canApprove: true, canReject: true, check: { status: "ready" }, approval: { revision: 4, artifactDigest: digestOf(A, "payments"), kind: "setup" } });
    expect(Object.keys(view.apply!).sort()).toEqual(["approval", "approver", "baseRevision", "canApprove", "canReject", "candidateRevision", "changes", "check", "readiness", "risk", "setup"]);
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "GET", path: "/v1/app/projects/payments/setup-agent", authorization: "Bearer ada-token" })]);
  });

  it("a reader sees the candidate but is told they cannot decide; a check that failed or is running offers no approval binding", async () => {
    const reader = setUp();
    const read = await reader.send("GET", "/v1/web/projects/payments/setup-agent", await reader.as("pam-token"));
    expect(SetupAgentViewSchema.parse(read.body).canManage).toBe(false);
    for (const check of ["checking", "failed"] as const) {
      const w = setUp({ check });
      const res = await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("ada-token"));
      const apply = SetupAgentViewSchema.parse(res.body).apply!;
      expect(apply.check.status).toBe(check);
      expect(apply.approval).toBeUndefined();
      expect(apply.canApprove).toBe(false);
    }
  });

  it("says nothing of an apply when Code sends none, and refuses a read whose apply is off (never a card with a guessed risk or approver)", async () => {
    const w = setUp();
    w.candidates.get(key(A, "payments"))!.decided = "approve";
    const none = await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("ada-token"));
    expect(none.status).toBe(200);
    expect(none.body).not.toHaveProperty("apply");
    const bad: Array<Record<string, unknown>> = [
      { risk: "extreme" }, { risk: LEAK }, { approver: "everyone" }, { canApprove: "yes" }, { canReject: 1 }, { candidateRevision: 0 }, { baseRevision: -1 }, { setup: "npm ci" }, { setup: ["x".repeat(2_001)] }, { readiness: Array(65).fill("npm test") },
      { check: { status: "weird" } }, { check: { status: "failed", failedStep: 5 } }, { check: "ready" }, { changes: [{ area: "secrets", risk: "low" }] }, { changes: [{ area: "websites", risk: "bad" }] }, { changes: Array(17).fill({ area: "other", risk: "high" }) },
      { approval: { requestId: "task-1234", revision: 4, artifactDigest: digestOf(A, "payments"), kind: "setup", risk: "low" } }, { approval: { requestId: "setup-abc", revision: 4, artifactDigest: "ABC", kind: "setup", risk: "low" } },
      { approval: { requestId: "setup-abc", revision: 0, artifactDigest: digestOf(A, "payments"), kind: "setup", risk: "low" } }, { approval: { requestId: "setup-abc", revision: 4, artifactDigest: digestOf(A, "payments"), kind: "task", risk: "low" } },
    ];
    for (const override of bad) {
      const v = setUp({ applyExtra: override });
      const res = await v.send("GET", "/v1/web/projects/payments/setup-agent", await v.as("ada-token"));
      expect(res.status, JSON.stringify(override)).toBe(503);
      expect(errorOf(res)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: SETUP_CHECKLIST_WORDS.unavailable });
      expect(res.text).not.toContain(LEAK);
    }
    const base = { candidateRevision: 2, baseRevision: 1, setup: ["a"], readiness: ["b"], check: { status: "ready" }, risk: "low", changes: [{ area: "setup_commands", risk: "low" }], approver: "maintainer", canApprove: true, canReject: true };
    expect(applyAnswer({ ...base, usedWithoutMatch: ["a"] })).toMatchObject({ usedWithoutMatch: ["a"] });
    expect(applyAnswer(base)).not.toHaveProperty("usedWithoutMatch");
    expect(applyAnswer({ ...base, usedWithoutMatch: [] })).not.toHaveProperty("usedWithoutMatch");
    expect(() => applyAnswer({ ...base, usedWithoutMatch: "a" })).toThrow();
    expect(() => applyAnswer({ ...base, usedWithoutMatch: [""] })).toThrow();
    expect(() => applyAnswer([])).toThrow();
    expect(() => applyAnswer(null)).toThrow();
  });
});

describe("Use this setup (confirm)", () => {
  it("forwards only the checked body as the person, with the project only in Code's path; the answer is rebuilt and reads in the app's schema", async () => {
    const w = setUp();
    w.candidates.get(key(A, "payments"))!.decided = "approve";
    const headers = { ...await w.as("pia-token"), "x-rovara-company": B };
    const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm?company=" + B, headers, { requestId: UUID1, expectedRevision: 3, itemIds: ["setup-1"] });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    expect(SetupConfirmReplySchema.parse(res.body)).toMatchObject({ digest: digestOf(A, "payments"), used: ["setup-1"], left: [{ id: "tests-2", reason: "unverified" }], candidateRevision: 5, next: "check" });
    expect(res.body).toEqual({ digest: digestOf(A, "payments"), used: ["setup-1"], unchecked: [], left: [{ id: "tests-2", reason: "unverified" }], candidateRevision: 5, proved: false, next: "check" });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/setup-agent/confirm", authorization: "Bearer pia-token", body: { requestId: UUID1, expectedRevision: 3, itemIds: ["setup-1"] } })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
  });

  it("forwards useAnyway to Code and logs which ticked rows did not match the code (ids and count only), and nothing extra when none", async () => {
    const w = setUp();
    w.candidates.get(key(A, "payments"))!.decided = "approve";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const headers = { ...await w.as("pia-token"), "x-rovara-company": B };
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm?company=" + B, headers, { requestId: UUID1, expectedRevision: 3, itemIds: ["setup-1", "tests-2"], useAnyway: ["tests-2"] });
      expect(res.status).toBe(200);
      expect(w.codeCalls()).toEqual([expect.objectContaining({ body: { requestId: UUID1, expectedRevision: 3, itemIds: ["setup-1", "tests-2"], useAnyway: ["tests-2"] } })]);
      expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["event"] === "cloud.setup_confirm")).toEqual([{ event: "cloud.setup_confirm", project: "payments", useAnyway: ["tests-2"], useAnywayCount: "1" }]);
    } finally { spy.mockRestore(); }
    expect(confirmLogDetails({})).toEqual({});
    expect(confirmLogDetails({ useAnyway: [] })).toEqual({});
    expect(confirmLogDetails({ useAnyway: ["a,b", "c"] })).toEqual({ useAnyway: ["a,b", "c"], useAnywayCount: "2" });
  });

  it("refuses a body that is not exactly the checked one, without asking Code", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const bodies: unknown[] = [
      {}, { requestId: UUID1 }, { expectedRevision: 1 }, { requestId: "not-a-uuid", expectedRevision: 1 }, { requestId: UUID1, expectedRevision: -1 }, { requestId: UUID1, expectedRevision: 1.5 }, { requestId: UUID1, expectedRevision: "1" },
      { requestId: UUID1, expectedRevision: 1, company: B }, { requestId: UUID1, expectedRevision: 1, itemIds: "setup-1" }, { requestId: UUID1, expectedRevision: 1, itemIds: [1] }, { requestId: UUID1, expectedRevision: 1, itemIds: [""] },
      { requestId: UUID1, expectedRevision: 1, itemIds: Array(129).fill("a") }, [], null, '"text"',
    ];
    for (const body of bodies) {
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", ada, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).message).toBe(SETUP_CHECKLIST_WORDS.invalid);
    }
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0 })).toEqual({ requestId: UUID1, expectedRevision: 0 });
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0, itemIds: ["a", "b"], useAnyway: ["a"] })).toEqual({ requestId: UUID1, expectedRevision: 0, itemIds: ["a", "b"], useAnyway: ["a"] });
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0, useAnyway: "a" })).toBeUndefined();
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0, useAnyway: [""] })).toBeUndefined();
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0, useAnyway: Array.from({ length: 129 }, (_, i) => `i${String(i)}`) })).toBeUndefined();
    expect(confirmBody({ requestId: UUID1, expectedRevision: 0, other: 1 })).toBeUndefined();
    expect(w.codeCalls()).toHaveLength(0);
  });

  // L4-T5: Code's sentences for a waiting setup are passed on only when exactly one of the fixed ones; the old false "Decide it, or discard it, first." is not.
  it("passes on each of Code's L4-T5 sentences for a waiting setup and the new no-test sentence, and drops the old false one", () => {
    for (const words of [
      "Another setup is waiting for your approval. Approve or reject it, or discard it, first.",
      "Another setup is still being checked on a fresh machine. Wait for the check to finish, or discard it, first.",
      "Another setup can't be approved: its check on a fresh machine did not pass. Discard it, then use this one.",
      "Another setup is waiting. If its check passed, approve or reject it; otherwise discard it. Then use this one.",
    ]) expect(SETUP_APPROVAL_CODE_WORDS).toContain(words);
    expect(SETUP_APPROVAL_CODE_WORDS).toContain("The setup has no test command to prove, so there is nothing to use yet. Add a test command to the project's setup, or run the setup again.");
    expect(SETUP_APPROVAL_CODE_WORDS).not.toContain("Another setup is waiting for your approval. Decide it, or discard it, first.");
  });

  it("answers Code's refusals in fixed words: a reader, a waiting candidate, an old revision, an answer Cloud cannot read; never Code's own text", async () => {
    const w = setUp();
    const reader = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", await w.as("pam-token"), { requestId: UUID1, expectedRevision: 3 });
    expect(reader.status).toBe(403);
    expect(errorOf(reader)).toEqual({ code: "FORBIDDEN", message: SETUP_CHECKLIST_WORDS.runNotAllowed });
    const waiting = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", await w.as("ada-token"), { requestId: UUID1, expectedRevision: 3 });
    expect(waiting.status).toBe(409);
    expect(errorOf(waiting)).toEqual({ code: "WORKSPACE_BUSY", message: "Another setup is waiting for your approval. Approve or reject it, or discard it, first." });
    expect(SETUP_APPROVAL_CODE_WORDS).toContain(errorOf(waiting).message);
    const cases: Array<[Response, number, string, string]> = [
      [err(409, "PROJECT_REVISION_MISMATCH", "Rovara found this setup for an earlier version of the project's settings. Set the project up again."), 409, "PROJECT_REVISION_MISMATCH", "Rovara found this setup for an earlier version of the project's settings. Set the project up again."],
      [err(409, "PROJECT_REVISION_MISMATCH", LEAK), 409, "CHANGE_STALE", SETUP_CHECKLIST_WORDS.stale],
      [err(409, "WORKSPACE_BUSY", LEAK), 409, "WORKSPACE_BUSY", SETUP_CHECKLIST_WORDS.busy],
      // L4-T5: each sentence Code now says for a waiting setup is passed on; the old one, which offered a decision that did not exist, is not.
      [err(409, "WORKSPACE_BUSY", "Another setup is still being checked on a fresh machine. Wait for the check to finish, or discard it, first."), 409, "WORKSPACE_BUSY", "Another setup is still being checked on a fresh machine. Wait for the check to finish, or discard it, first."],
      [err(409, "WORKSPACE_BUSY", "Another setup can't be approved: its check on a fresh machine did not pass. Discard it, then use this one."), 409, "WORKSPACE_BUSY", "Another setup can't be approved: its check on a fresh machine did not pass. Discard it, then use this one."],
      [err(409, "WORKSPACE_BUSY", "Another setup is waiting. If its check passed, approve or reject it; otherwise discard it. Then use this one."), 409, "WORKSPACE_BUSY", "Another setup is waiting. If its check passed, approve or reject it; otherwise discard it. Then use this one."],
      [err(409, "WORKSPACE_BUSY", "Another setup is waiting for your approval. Decide it, or discard it, first."), 409, "WORKSPACE_BUSY", SETUP_CHECKLIST_WORDS.busy],
      [err(400, "CONFIG_INVALID", "The setup has no test command to prove, so there is nothing to use yet. Add a test command to the project's setup, or run the setup again."), 400, "CONFIG_INVALID", "The setup has no test command to prove, so there is nothing to use yet. Add a test command to the project's setup, or run the setup again."],
      [err(409, "WORKSPACE_BUSY", "Another setup is waiting for your approval. Approve or reject it, or discard it, first."), 409, "WORKSPACE_BUSY", "Another setup is waiting for your approval. Approve or reject it, or discard it, first."],
      [err(500, "PROJECT_REVISION_MISMATCH", "Rovara found this setup for an earlier version of the project's settings. Set the project up again."), 503, "RUNTIME_UNAVAILABLE", SETUP_CHECKLIST_WORDS.unavailable],
      [err(400, "CONFIG_INVALID", "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup."), 400, "CONFIG_INVALID", "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup."],
      [err(400, "CONFIG_INVALID", LEAK), 400, "CONFIG_INVALID", SETUP_CHECKLIST_WORDS.invalid],
      [err(500, "X", LEAK), 503, "RUNTIME_UNAVAILABLE", SETUP_CHECKLIST_WORDS.unavailable],
      [err(404, "NOT_FOUND", "route not found"), 501, "NOT_ON_CODE_YET", SETUP_CHECKLIST_WORDS.runNotYet],
      [err(404, "NOT_FOUND", "Approving a project's setup isn't available on this install yet."), 501, "NOT_ON_CODE_YET", W.approvalNotYet],
      [err(404, "NOT_FOUND", LEAK), 404, "NOT_FOUND", SETUP_CHECKLIST_WORDS.notFound],
    ];
    for (const [replaced, status, code, message] of cases) {
      const v = setUp({ override: (path) => path.endsWith("/confirm") ? replaced.clone() : undefined });
      const res = await v.send("POST", "/v1/web/projects/payments/setup-agent/confirm", await v.as("ada-token"), { requestId: UUID1, expectedRevision: 3 });
      expect({ status: res.status, ...errorOf(res) }).toEqual({ status, code, message });
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("a confirm answer that is not readable is refused whole", async () => {
    const answers: unknown[] = [{ digest: "x", used: [], unchecked: [], left: [], proved: false, next: "check" }, { digest: digestOf(A, "payments"), used: [], unchecked: [], left: [{ id: "a", reason: LEAK }], proved: false, next: "check" },
      { digest: digestOf(A, "payments"), used: [], unchecked: [], left: [], proved: "no", next: "check" }, { digest: digestOf(A, "payments"), used: [], unchecked: [], left: [], proved: false, next: "apply" }, [], "ok"];
    for (const answer of answers) {
      const w = setUp({ override: (path) => path.endsWith("/confirm") ? json(200, answer) : undefined });
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/confirm", await w.as("ada-token"), { requestId: UUID1, expectedRevision: 3 });
      expect(res.status).toBe(503);
      expect(res.text).not.toContain(LEAK);
    }
  });
});

describe("Discard", () => {
  it("forwards only the request id as the person and answers whether something was dropped", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/discard", await w.as("pia-token"), { requestId: UUID1 });
    expect(res.status).toBe(200);
    expect(SetupDiscardReplySchema.parse(res.body)).toEqual({ discarded: true });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ path: "/v1/app/projects/payments/setup-agent/discard", authorization: "Bearer pia-token", body: { requestId: UUID1 } })]);
    const again = await w.send("POST", "/v1/web/projects/payments/setup-agent/discard", await w.as("pia-token"), { requestId: UUID2 });
    expect(again.body).toEqual({ discarded: false });
    for (const body of [{}, { requestId: "x" }, { requestId: UUID1, extra: 1 }]) expect((await w.send("POST", "/v1/web/projects/payments/setup-agent/discard", await w.as("pia-token"), body)).status).toBe(400);
  });

  it("a reader is refused in fixed words, and an answer that is not a boolean is refused whole", async () => {
    const w = setUp();
    const reader = await w.send("POST", "/v1/web/projects/payments/setup-agent/discard", await w.as("pam-token"), { requestId: UUID1 });
    expect(errorOf(reader)).toEqual({ code: "FORBIDDEN", message: SETUP_CHECKLIST_WORDS.runNotAllowed });
    expect(reader.text).not.toContain(LEAK);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
    const odd = setUp({ override: (path) => path.endsWith("/discard") ? json(200, { discarded: LEAK }) : undefined });
    expect((await odd.send("POST", "/v1/web/projects/payments/setup-agent/discard", await odd.as("ada-token"), { requestId: UUID1 })).status).toBe(503);
  });
});

describe("Approve or Reject (decide)", () => {
  it("forwards exactly the binding the person saw, as the person; the answer is rebuilt and reads in the app's schema", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("pia-token"), decision(A, "payments", 4, "approve", { reason: "looks right" }));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LEAK);
    expect(SetupDecideReplySchema.parse(res.body)).toEqual({ project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false });
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/projects/payments/setup-agent/decide", authorization: "Bearer pia-token", body: decision(A, "payments", 4, "approve", { reason: "looks right" }) })]);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBe("approve");
  });

  it("Reject goes the same way, and a high-risk approval by a maintainer is Code's fixed words (a reject by the same person is allowed)", async () => {
    const w = setUp({ risk: "high" });
    const approve = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("pia-token"), decision(A, "payments", 4));
    expect(approve.status).toBe(403);
    expect(errorOf(approve)).toEqual({ code: "FORBIDDEN", message: expect.stringContaining("company owner or admin must approve") as unknown });
    expect(SETUP_APPROVAL_CODE_WORDS).toContain(errorOf(approve).message);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
    const reject = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("pia-token"), decision(A, "payments", 4, "reject"));
    expect(reject.status).toBe(200);
    expect(reject.body).toMatchObject({ decision: "rejected", risk: "high" });
    const owner = setUp({ risk: "high" });
    expect((await owner.send("POST", "/v1/web/projects/payments/setup-agent/decide", await owner.as("ada-token"), decision(A, "payments", 4))).body).toMatchObject({ decision: "approved" });
  });

  it("an owner whose sign-in carries no fresh step-up decides (owner DEC 254zzz73); the wrong role and the wrong company still decide nothing", async () => {
    const w = setUp({ risk: "high" });
    // Wrong role: a plain member who maintains nothing here; wrong company: B's admin on A's project (Code's not-found).
    const member = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("pam-token"), decision(A, "payments", 4));
    expect(member.status).toBe(403);
    const other = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("bob-token"), decision(A, "payments", 4));
    expect(other.status).not.toBe(200);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
    const old = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("ada-stale-token"), decision(A, "payments", 4));
    expect(old.body).toMatchObject({ decision: "approved" });
  });

  it("a refusal of a stale binding is fixed words with the same status; nothing is decided", async () => {
    const w = setUp();
    const stale = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("ada-token"), { ...decision(A, "payments", 4), seen: { revision: 4, artifactDigest: "f".repeat(64) } });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toEqual({ code: "CHANGE_STALE", message: W.stale });
    const moved = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("ada-token"), { ...decision(A, "payments", 4), seen: { revision: 5, artifactDigest: digestOf(A, "payments") } });
    expect(errorOf(moved)).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(stale.text + moved.text).not.toContain(LEAK);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
  });

  it("maps every Code refusal to a fixed sentence and never echoes Code's text", async () => {
    const cases: Array<[Response, number, string, string]> = [
      [err(403, "FORBIDDEN", "Only the project's maintainers, or a company owner or admin, can decide this setup."), 403, "FORBIDDEN", "Only the project's maintainers, or a company owner or admin, can decide this setup."],
      [err(403, "FORBIDDEN", LEAK), 403, "FORBIDDEN", W.cannotDecide],
      [err(403, "FORBIDDEN", "Your approval could not be proved just now, so nothing was decided. Try again."), 403, "FORBIDDEN", "Your approval could not be proved just now, so nothing was decided. Try again."],
      [err(403, "REAUTH_REQUIRED", LEAK), 403, "FORBIDDEN", W.cannotDecide],
      [err(409, "IDEMPOTENCY_CONFLICT", LEAK), 409, "IDEMPOTENCY_CONFLICT", W.conflict],
      [err(409, "CHANGE_STALE", "There is no setup waiting for a decision. Open the project's setup again."), 409, "CHANGE_STALE", "There is no setup waiting for a decision. Open the project's setup again."],
      [err(409, "CHANGE_STALE", LEAK), 409, "CHANGE_STALE", W.stale],
      [err(409, "SOMETHING_ELSE", LEAK), 409, "CHANGE_STALE", W.stale],
      [err(400, "CONFIG_INVALID", LEAK), 400, "CONFIG_INVALID", SETUP_CHECKLIST_WORDS.invalid],
      [err(503, "AUDIT_UNAVAILABLE", LEAK), 503, "AUDIT_UNAVAILABLE", W.audit],
      [err(503, "RUNTIME_UNAVAILABLE", LEAK), 503, "RUNTIME_UNAVAILABLE", SETUP_CHECKLIST_WORDS.unavailable],
      [err(404, "NOT_FOUND", "Approving a project's setup isn't available on this install yet."), 501, "NOT_ON_CODE_YET", W.approvalNotYet],
      [err(404, "NOT_FOUND", "route not found"), 501, "NOT_ON_CODE_YET", SETUP_CHECKLIST_WORDS.runNotYet],
      [err(404, "NOT_FOUND", LEAK), 404, "NOT_FOUND", SETUP_CHECKLIST_WORDS.notFound],
    ];
    for (const [replaced, status, code, message] of cases) {
      const w = setUp({ override: (path) => path.endsWith("/decide") ? replaced.clone() : undefined });
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("ada-token"), decision(A, "payments", 4));
      expect({ status: res.status, ...errorOf(res) }).toEqual({ status, code, message });
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("refuses a body that is not exactly the checked one, without asking Code", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const good = decision(A, "payments", 4);
    const bodies: unknown[] = [
      {}, { ...good, requestId: "task-123456" }, { ...good, requestId: "setup-" }, { ...good, requestId: `setup-${"a".repeat(123)}` }, { ...good, requestId: "setup-ab cd" }, { ...good, outcome: "maybe" }, { ...good, outcome: "APPROVE" },
      { requestId: good.requestId, outcome: "approve" }, { ...good, seen: { revision: 4 } }, { ...good, seen: { revision: 0, artifactDigest: digestOf(A, "payments") } }, { ...good, seen: { revision: 4, artifactDigest: "A".repeat(64) } },
      { ...good, seen: { revision: 4, artifactDigest: "a".repeat(63) } }, { ...good, seen: { ...good.seen, extra: 1 } }, { ...good, reason: "x".repeat(501) }, { ...good, reason: "bad\u0007" }, { ...good, reason: 5 }, { ...good, company: B },
      { ...good, personId: "e".repeat(64) }, [], null, '"text"',
    ];
    for (const body of bodies) {
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", ada, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).message).toBe(SETUP_CHECKLIST_WORDS.invalid);
    }
    expect(decideBody(good)).toEqual(good);
    expect(w.codeCalls()).toHaveLength(0);
  });

  it("a decide answer for another project, another decision than asked, or with a field off is refused whole (nothing is claimed that Code did not say)", async () => {
    const base = { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false };
    const answers: unknown[] = [{ ...base, project: "ledger" }, { ...base, decision: "rejected" }, { ...base, decision: LEAK }, { ...base, risk: "huge" }, { ...base, revision: 0 }, { ...base, replayed: "no" }, [], null];
    for (const answer of answers) {
      const w = setUp({ override: (path) => path.endsWith("/decide") ? json(200, answer) : undefined });
      const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("ada-token"), decision(A, "payments", 4));
      expect(res.status, JSON.stringify(answer)).toBe(503);
      expect(res.text).not.toContain(LEAK);
    }
  });

  it("a person who can only read the project is Code's refusal in fixed words and decides nothing", async () => {
    const w = setUp();
    const res = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("pam-token"), decision(A, "payments", 4));
    expect(res.status).toBe(403);
    expect(errorOf(res)).toEqual({ code: "FORBIDDEN", message: W.cannotDecide });
    expect(res.text).not.toContain(LEAK);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
  });
});

describe("two companies and two projects", () => {
  it("the same project name in two companies: each person reads and decides their own company's candidate only; the other company's stays waiting", async () => {
    const w = setUp();
    const ada = await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("ada-token"));
    const bob = await w.send("GET", "/v1/web/projects/payments/setup-agent", await w.as("bob-token"));
    expect(SetupAgentViewSchema.parse(ada.body).apply).toMatchObject({ candidateRevision: 4, risk: "low", approval: { artifactDigest: digestOf(A, "payments") } });
    expect(SetupAgentViewSchema.parse(bob.body).apply).toMatchObject({ candidateRevision: 9, risk: "medium", approval: { artifactDigest: digestOf(B, "payments") } });
    // Bob (company B) holds A's digest and revision: Code reads B's project, so it is stale, and A's candidate is untouched.
    const cross = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("bob-token"), decision(A, "payments", 4));
    expect(cross.status).toBe(409);
    expect(errorOf(cross)).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
    expect(w.candidates.get(key(B, "payments"))!.decided).toBeUndefined();
    const own = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("bob-token"), decision(B, "payments", 9, "reject"));
    expect(own.body).toMatchObject({ decision: "rejected", risk: "medium", revision: 9 });
    expect(w.candidates.get(key(B, "payments"))!.decided).toBe("reject");
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
  });

  it("another company's project (a name the person's company does not hold) reads as 'project not found' on every act, and no company is ever sent", async () => {
    const w = setUp();
    const bob = await w.as("bob-token");
    const bodies: Array<[string, unknown]> = [["confirm", { requestId: UUID1, expectedRevision: 1 }], ["discard", { requestId: UUID1 }], ["decide", decision(A, "ledger", 7)]];
    for (const [tail, body] of bodies) {
      const res = await w.send("POST", `/v1/web/projects/ledger/setup-agent/${tail}`, { ...bob, "x-rovara-company": A }, body);
      expect({ status: res.status, ...errorOf(res) }, tail).toEqual({ status: 404, code: "NOT_FOUND", message: SETUP_CHECKLIST_WORDS.notFound });
      expect(res.text).not.toContain(LEAK);
    }
    const read = await w.send("GET", "/v1/web/projects/ledger/setup-agent", bob);
    expect(read.status).toBe(404);
    expect(w.candidates.get(key(A, "ledger"))!.decided).toBeUndefined();
    for (const call of w.calls) expect(JSON.stringify(call.headers) + JSON.stringify(call.body ?? "")).not.toContain(A);
  });

  it("two projects of one company: a decision names one project only; the other project's digest is stale, and its candidate is untouched", async () => {
    const w = setUp();
    const ada = await w.as("ada-token");
    const wrong = await w.send("POST", "/v1/web/projects/ledger/setup-agent/decide", ada, decision(A, "payments", 4));
    expect(wrong.status).toBe(409);
    expect(errorOf(wrong)).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(w.candidates.get(key(A, "ledger"))!.decided).toBeUndefined();
    const right = await w.send("POST", "/v1/web/projects/ledger/setup-agent/decide", ada, decision(A, "ledger", 7));
    expect(right.body).toMatchObject({ project: "ledger", decision: "approved", revision: 7 });
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
    expect(w.codeCalls().map((call) => call.path)).toEqual(["/v1/app/projects/ledger/setup-agent/decide", "/v1/app/projects/ledger/setup-agent/decide"]);
  });

  it("a person in no company, a project name that does not read, and a call without the browser's sign-in never reach Code's project routes", async () => {
    const w = setUp();
    const nobody = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", await w.as("nob-token"), decision(A, "payments", 4));
    expect(nobody.status).toBe(403);
    expect(errorOf(nobody).code).toBe("NO_COMPANY");
    for (const name of ["Bad..Name", "-x", "a%2Fb", "p".repeat(64)]) {
      const res = await w.send("POST", `/v1/web/projects/${name}/setup-agent/decide`, await w.as("ada-token"), decision(A, "payments", 4));
      expect({ status: res.status, message: errorOf(res).message }, name).toEqual({ status: 404, message: SETUP_CHECKLIST_WORDS.notFound });
    }
    const noCookie = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", {}, decision(A, "payments", 4));
    expect([401, 403]).toContain(noCookie.status);
    const noCsrf = await w.send("POST", "/v1/web/projects/payments/setup-agent/decide", { cookie: (await w.as("ada-token")).cookie }, decision(A, "payments", 4));
    expect(noCsrf.status).toBe(403);
    expect(w.codeCalls()).toHaveLength(0);
    expect(w.candidates.get(key(A, "payments"))!.decided).toBeUndefined();
  });
});

describe("the sign-in ended", () => {
  it("keeps a dispatched approval unknown when Code refuses renewal, on every approval route", async () => {
    for (const tail of ["confirm", "discard", "decide"]) {
      const w = setUp({ override: (path) => path.startsWith("/v1/app/projects/") ? err(401, "AUTH_REQUIRED", LEAK) : undefined });
      const body = tail === "confirm" ? { requestId: UUID1, expectedRevision: 1 } : tail === "discard" ? { requestId: UUID1 } : decision(A, "payments", 4);
      const res = await w.send("POST", `/v1/web/projects/payments/setup-agent/${tail}`, await w.as("ada-token"), body);
      expect(res.status, tail).toBe(503);
      expect(res.text).toMatch(/outcome.*unknown.*check.*status/iu);
      expect(res.text).not.toContain(LEAK);
    }
  });
});
