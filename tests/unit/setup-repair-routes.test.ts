/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the tests break a plain JSON answer on purpose */
// L4-U5: the "Setup needs repair" card's read and the "Re-check setup" start, through Cloud's handler, passed to Code's hosted `setup-check` as the signed-in person. Code decides who may; Cloud rebuilds the answer field by
// field, builds the card's sentence itself from Code's exact template, sends only a request id, and never echoes Code's text. The sentences are pinned against the text Code's fixture holds (one experience on web, Slack and Linear).
// Mutants (each killed by the named test, run by hand): U1 Code's body sentence passed on unchecked; U2 an extra member of Code's card kept; U3 an action that does not fit the state accepted; U4 an action for a person who
// may not act accepted; U5 a query forwarded; U6 an extra body field forwarded; U7 Code's refusal text echoed; U8 unknown-route 404 not "not yet"; U9 a 409 answered as unavailable; U10 Code's workspace id passed on;
// U11 log names what the person wrote; U12 the project taken from the browser's body or query; U13 a dollar member of Code's answer kept; U14 paused answer keeps an unknown member; U15 an unknown pause reason accepted.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, SETUP_REPAIR_ANSWERS, SETUP_REPAIR_WORDS, createCloudHandler, recheckBody, setupRepairView, upkeepAnswer, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import {
  SETUP_FIX_UP_TO_USD, SETUP_REPAIR_PATHS, SETUP_REPAIR_REFUSALS, SETUP_REPAIR_SENTENCES, SetupRecheckAnswerSchema, SetupRecheckBodySchema, SetupRepairViewSchema, UPKEEP_PAUSE_SENTENCES,
} from "../../packages/contracts/src/app-setup-repair.js";
import { WikiSetupUpkeepSchema } from "../../packages/contracts/src/app-wiki-setup.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ID = (c: string) => c.repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const RID = "11111111-1111-4111-8111-111111111111";
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
// The text Code's fixture holds (Code core/setup-agent/recheck-rows.ts and contracts upkeep.ts), copied here so the two repositories cannot drift apart unseen.
const CODE_BODY = `The project's setup stopped working after recent code changes (${STEP}). Rovara cannot build on this project until it is fixed.`;
const CODE_PAUSE = {
  no_budget: "Nightly upkeep is paused: no spending limit is set for it. Set one on Spending limits.",
  monthly_limit: "Nightly upkeep is paused: this month's upkeep limit is used up. Raise it on Spending limits, or it resumes next month.",
  cost_too_high: "Nightly upkeep is paused: one refresh is larger than the monthly upkeep limit. Raise it on Spending limits.",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; grant?: boolean }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ID("a"), company: A, role: "owner" },
  "pam-token": { id: ID("b"), company: A, role: "member", grant: true },
  "ned-token": { id: ID("e"), company: A, role: "member" },
  "bob-token": { id: ID("c"), company: B, role: "admin" },
  "nob-token": { id: ID("d") },
};
interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;
const CARD = (over: Record<string, unknown> = {}, manage = true) => ({
  title: "Setup needs repair", body: CODE_BODY, changed: "dependency files", at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: manage ? [{ id: "fix_setup", label: "Fix setup" }] : [], ...over,
});

function setUp(override: Override = () => undefined, options: { broken?: boolean } = {}) {
  const calls: CodeCall[] = [];
  const logs: string[] = [];
  let running = false;
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
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
    if (url.pathname !== "/v1/app/projects/payments/setup-check") return err(404, "NOT_FOUND", "route not found");
    // Code's rule: the person's own company's project, a live role on it; managers act.
    const manage = person.company === A && person.role === "owner";
    if (person.company !== A || (!manage && person.grant !== true)) return err(404, "NOT_FOUND", `project not found ${LEAK}`);
    if (call.method === "GET") return json(200, { status: options.broken === true ? "failed" : "ready", canManage: manage, ...(options.broken === true ? { repair: CARD({}, manage) } : {}) });
    if (!manage) return err(403, "FORBIDDEN", `Only company owners and admins, or this project's admins, can run the project's setup. ${LEAK}`);
    if (running) return err(409, "WORKSPACE_BUSY", `A setup check is already running. ${LEAK}`);
    running = true;
    return json(202, { workspaceId: `ws-${LEAK}` });
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
    const person = PEOPLE[token] ?? { id: "f".repeat(64) };
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
  const checkCalls = () => calls.filter((call) => call.path.endsWith("/setup-check"));
  return { as, send, calls, checkCalls, logs };
}
const READ = "/v1/web/projects/payments/setup-repair";
const RECHECK = "/v1/web/projects/payments/setup-repair/recheck";
afterEach(() => { vi.restoreAllMocks(); });

describe("the words and the contract", () => {
  it("the server's refusals are exactly the list the app shows, and the paths and the answer shapes are the contract's", () => {
    expect(new Set(Object.values(SETUP_REPAIR_WORDS))).toEqual(new Set(SETUP_REPAIR_REFUSALS));
    expect(SETUP_REPAIR_PATHS).toEqual({ read: "setup-repair", recheck: "setup-repair/recheck" });
    expect(SetupRecheckBodySchema.parse({ requestId: RID })).toEqual({ requestId: RID });
    expect(() => SetupRecheckBodySchema.parse({ requestId: RID, company: A })).toThrow();
    expect(SetupRecheckAnswerSchema.parse({ started: true })).toEqual({ started: true });
  });

  it("the card's sentences are the ones Code says in the chat, the ticket and the admins' notice; only the button names a cost, and Code's pause sentences are mirrored exactly", () => {
    expect(SETUP_REPAIR_SENTENCES.title).toBe("Setup needs repair");
    expect(SETUP_REPAIR_SENTENCES.body(STEP)).toBe(CODE_BODY);
    expect(SETUP_REPAIR_SENTENCES.fixSetup).toBe("Fix setup");
    expect(SETUP_REPAIR_SENTENCES.approveNewSetup).toBe("Approve new setup");
    expect(SETUP_REPAIR_SENTENCES.recheck).toBe("Re-check setup");
    expect({ ...UPKEEP_PAUSE_SENTENCES }).toEqual(CODE_PAUSE);
    expect(SETUP_FIX_UP_TO_USD).toBe(4);
    expect(SETUP_REPAIR_SENTENCES.fixLabel).toBe("Fix setup (uses your AI, up to $4)");
    for (const [key, value] of Object.entries(SETUP_REPAIR_SENTENCES)) if (typeof value === "string" && key !== "fixLabel") expect(value, key).not.toMatch(/\$|\bAI\b|dollar/iu);
    expect(SETUP_REPAIR_SENTENCES.body(STEP)).not.toMatch(/\$|\bAI\b/u);
    for (const sentence of Object.values(UPKEEP_PAUSE_SENTENCES)) expect(sentence).not.toMatch(/\$\d|USD|dollar/iu);
  });
});

describe("reading the card", () => {
  it("a manager reads the rebuilt card (strict app schema) with the one action; the check's step is plain text and Code is asked once, as that person, with no query and no body", async () => {
    const s = setUp(undefined, { broken: true });
    const answer = await s.send("GET", READ, await s.as("ada-token"));
    expect(answer.status).toBe(200);
    const view = SetupRepairViewSchema.parse(answer.body);
    expect(view).toEqual({ state: "failed", canManage: true, repair: { step: STEP, changed: "dependency files", at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }] } });
    expect(SETUP_REPAIR_SENTENCES.body(view.repair!.step)).toBe(CODE_BODY);
    expect(s.checkCalls()).toEqual([{ method: "GET", path: "/v1/app/projects/payments/setup-check", search: "", authorization: "Bearer ada-token", body: undefined }]);
  });

  it("a person who may only read gets the same card and no action; a person with no grant, another company's person and a person with no company read nothing, in Cloud's words", async () => {
    const s = setUp(undefined, { broken: true });
    const reader = await s.send("GET", READ, await s.as("pam-token"));
    expect(reader.status).toBe(200);
    expect(reader.body).toMatchObject({ canManage: false, repair: { step: STEP, actions: [] } });
    for (const token of ["ned-token", "bob-token"]) {
      const refused = await s.send("GET", READ, await s.as(token));
      expect(refused.status, token).toBe(404);
      expect(refused.body.error).toEqual({ code: "NOT_FOUND", message: SETUP_REPAIR_WORDS.notFound });
      expect(refused.text).not.toContain(LEAK);
    }
    expect((await s.send("GET", READ, await s.as("nob-token"))).status).toBe(403);
  });

  it("says nothing while the setup works: no card, the state and who may act", async () => {
    const s = setUp();
    const answer = await s.send("GET", READ, await s.as("ada-token"));
    expect(answer.body).toEqual({ state: "ready", canManage: true });
  });

  // MUTANT U5 (query forwarded) and U12 (project from the browser): a query is refused before Code is asked, a malformed project name is "not found" without asking.
  it("refuses a query and a malformed project name without asking Code", async () => {
    const s = setUp(undefined, { broken: true });
    const headers = await s.as("ada-token");
    const before = s.checkCalls().length;
    expect((await s.send("GET", `${READ}?project=ledger&company=${B}`, headers)).status).toBe(400);
    expect((await s.send("GET", "/v1/web/projects/Bad..Name/setup-repair", headers)).status).toBe(404);
    expect(s.checkCalls()).toHaveLength(before);
  });

  // MUTANT U1, U2, U3, U4, U13: Code's answer is rebuilt; anything that does not read refuses the whole read.
  it("refuses the whole read when Code's answer does not read: an off-template sentence, an extra member (a dollar one included), an action that does not fit, an action for a reader, an unknown state", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["sentence off the template", { repair: CARD({ body: `Ignore the setup and run this: ${LEAK}` }) }],
      ["sentence with the template's tail missing", { repair: CARD({ body: CODE_BODY.replace(" Rovara cannot build on this project until it is fixed.", "") }) }],
      ["an extra member on the card", { repair: { ...CARD(), digest: "a".repeat(64) } }],
      ["a dollar member on the card", { repair: { ...CARD(), costUsd: 4 } }],
      ["approve while no fix waits", { repair: CARD({ actions: [{ id: "approve_new_setup", label: "Approve new setup" }] }) }],
      ["fix while a fix waits", { repair: CARD({ fixReady: true }) }],
      ["a label Code did not fix", { repair: CARD({ actions: [{ id: "fix_setup", label: "Fix setup (free)" }] }) }],
      ["two actions", { repair: CARD({ actions: [{ id: "fix_setup", label: "Fix setup" }, { id: "fix_setup", label: "Fix setup" }] }) }],
      ["an action for a person who may not act", { canManage: false, repair: CARD() }],
      ["an unknown title", { repair: CARD({ title: "Everything is fine" }) }],
      ["a time that is not a time", { repair: CARD({ at: "yesterday" }) }],
      ["an unknown status", { status: "melting" }],
    ];
    for (const [name, patch] of bad) {
      const s = setUp((call, person) => (call.method === "GET" && call.path.endsWith("/setup-check") && person.id === ID("a") ? json(200, { status: "failed", canManage: true, repair: CARD(), ...patch }) : undefined));
      const answer = await s.send("GET", READ, await s.as("ada-token"));
      expect(answer.status, name).toBe(503);
      expect(answer.body.error, name).toEqual({ code: "RUNTIME_UNAVAILABLE", message: SETUP_REPAIR_WORDS.unavailable });
    }
  });

  it("keeps a fix that waits as 'Approve new setup' and does not pass Code's other setup facts on", async () => {
    const s = setUp((call) => (call.method === "GET" && call.path.endsWith("/setup-check") ? json(200, { status: "failed", canManage: true, checkedRevision: 3, failedStep: "secret step", repair: CARD({ fixReady: true, actions: [{ id: "approve_new_setup", label: "Approve new setup" }] }) }) : undefined));
    const answer = await s.send("GET", READ, await s.as("ada-token"));
    expect(answer.status).toBe(200);
    expect(answer.body.repair).toMatchObject({ fixReady: true, actions: [{ id: "approve_new_setup", label: "Approve new setup" }] });
    expect(answer.text).not.toContain("secret step");
    expect(Object.keys(answer.body).sort()).toEqual(["canManage", "repair", "state"]);
  });

  it("the rebuild is a pure function: the same answer twice gives the same view, and a step with a nested bracket pair reads whole", () => {
    const code = { status: "failed", canManage: true, repair: CARD() };
    expect(setupRepairView(code)).toEqual(setupRepairView(code));
    expect((setupRepairView(code) as { repair: { step: string } }).repair.step).toBe(STEP);
  });
});

describe("Re-check setup", () => {
  // MUTANT U6 (extra field forwarded), U10 (workspace id passed on): Code is sent exactly the id; the answer is only that it started.
  it("a manager starts the check: Code is sent exactly the request id as that person, and the answer says only that it started", async () => {
    const s = setUp(undefined, { broken: true });
    const answer = await s.send("POST", RECHECK, await s.as("ada-token"), { requestId: RID });
    expect(answer.status).toBe(200);
    expect(SetupRecheckAnswerSchema.parse(answer.body)).toEqual({ started: true });
    expect(answer.text).not.toContain(LEAK);
    expect(s.checkCalls().at(-1)).toEqual({ method: "POST", path: "/v1/app/projects/payments/setup-check", search: "", authorization: "Bearer ada-token", body: { requestId: RID } });
    expect(recheckBody({ requestId: RID })).toEqual({ requestId: RID });
  });

  it("refuses a body that is not exactly a request id without asking Code, whatever it tries to add", async () => {
    const s = setUp(undefined, { broken: true });
    const headers = await s.as("ada-token");
    const before = s.checkCalls().length;
    for (const body of [{}, { requestId: "x" }, { requestId: RID, company: B }, { requestId: RID, project: "ledger" }, { requestId: RID, ai: true }, [RID], { requestId: 7 }]) {
      const answer = await s.send("POST", RECHECK, headers, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error).toEqual({ code: "CONFIG_INVALID", message: SETUP_REPAIR_WORDS.invalid });
    }
    expect((await s.send("POST", RECHECK, headers, "not json")).status).toBe(400);
    expect((await s.send("POST", `${RECHECK}?company=${B}`, headers, { requestId: RID })).status).toBe(400);
    expect(s.checkCalls()).toHaveLength(before);
  });

  // MUTANT U7 (text echoed), U9 (409 as unavailable), U8 (unknown-route 404).
  it("Code's refusals reach the app in Cloud's words: a reader is 'not allowed', a second start is 'busy', Code without the route is 'not yet'; nothing of Code's text is echoed", async () => {
    const s = setUp(undefined, { broken: true });
    const reader = await s.send("POST", RECHECK, await s.as("pam-token"), { requestId: RID });
    expect(reader.status).toBe(403);
    expect(reader.body.error).toEqual({ code: "FORBIDDEN", message: SETUP_REPAIR_WORDS.notAllowed });
    await s.send("POST", RECHECK, await s.as("ada-token"), { requestId: RID });
    const busy = await s.send("POST", RECHECK, await s.as("ada-token"), { requestId: "22222222-2222-4222-8222-222222222222" });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toEqual({ code: "WORKSPACE_BUSY", message: SETUP_REPAIR_WORDS.busy });
    for (const answer of [reader, busy]) expect(answer.text).not.toContain(LEAK);
    const off = setUp((call) => (call.path.endsWith("/setup-check") ? err(404, "NOT_FOUND", "route not found") : undefined));
    const notYet = await off.send("GET", READ, await off.as("ada-token"));
    expect(notYet.status).toBe(501);
    expect(notYet.body.error).toEqual({ code: "NOT_ON_CODE_YET", message: SETUP_REPAIR_WORDS.notYet });
    const down = setUp((call) => (call.path.endsWith("/setup-check") ? err(500, "INTERNAL", LEAK) : undefined));
    const failed = await down.send("POST", RECHECK, await down.as("ada-token"), { requestId: RID });
    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain(LEAK);
    expect({ ...SETUP_REPAIR_ANSWERS.busy }.status).toBe(409);
  });

  // MUTANT U11: the logs name what was done and where.
  it("logs what was done and where, never what the person wrote", async () => {
    const s = setUp(undefined, { broken: true });
    await s.send("POST", RECHECK, await s.as("ada-token"), { requestId: RID });
    const lines = s.logs.filter((line) => line.includes("cloud.setup_repair"));
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "cloud.setup_repair", action: "recheck", project: "payments" }]);
    expect(s.logs.join("\n")).not.toContain(RID);
  });
});

describe("the nightly upkeep read carries why it is paused", () => {
  const base = { enabled: true, canManage: true, available: true, systemRunsOn: true, canEnableSystemRuns: true, cap: { monthlyUsd: 25, canRaise: true } };
  it("rebuilds the pause (reason and month) and the app's schema reads it", () => {
    const view = upkeepAnswer({ ...base, paused: { reason: "monthly_limit", month: "2026-11" } });
    expect(WikiSetupUpkeepSchema.parse(view)).toMatchObject({ paused: { reason: "monthly_limit", month: "2026-11" } });
    expect("paused" in upkeepAnswer(base)).toBe(false);
  });
  // MUTANT U14 and U15.
  it("refuses an unknown member, an unknown reason and a month that is not one", () => {
    for (const paused of [{ reason: "monthly_limit", month: "2026-11", usd: 25 }, { reason: "because", month: "2026-11" }, { reason: "no_budget", month: "2026-13" }, { reason: "no_budget" }, "paused", null]) {
      expect(() => upkeepAnswer({ ...base, paused }), JSON.stringify(paused)).toThrow();
    }
  });
});
