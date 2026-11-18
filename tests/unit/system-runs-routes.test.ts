/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the tests break a plain JSON answer on purpose */
// L4-P3 (owner 2026-11-17): the company's one control over nightly upkeep through Cloud's handler, passed to Code's `GET`/`PUT /v1/app/company/system-runs` as the signed-in person. Only a company owner or admin
// uses it (the role is Code's access check now, never the stored sign-in): anyone else gets one fixed 403 and Code is not asked. ALLOWING needs Code's fresh step-up (Cloud answers it with the code
// `REAUTH_REQUIRED` in Cloud's words, which the app turns into the sign-in step); WITHDRAWING asks for none. Cloud forwards exactly a request id and the choice, rebuilds the answer, and never echoes Code's text.
// Mutants (each killed by the named test, run by hand): S1 role check dropped; S2 stored sign-in role used; S3 extra body field forwarded; S4 query forwarded; S5 REAUTH_REQUIRED not kept (answered as "not allowed");
// S6 Code's step-up words passed on; S7 a withdrawal asks for a step-up in Cloud; S8 Code's answer passed unrebuilt; S9 contradictory answer accepted; S10 unknown-route 404 not "not yet"; S11 Code's text echoed;
// S12 log names what the person wrote; S13 company or person in Code's body or path.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeClient, LocalSessionStore, LocalWorkSessionStore, WIKI_SETUP_ANSWERS, createCloudHandler, systemRunsAnswer, systemRunsBody, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { WIKI_SETUP_SENTENCES, WIKI_SETUP_WORDS as APP_WORDS, SystemRunsBodySchema, SystemRunsViewSchema, SYSTEM_RUNS_PATH } from "../../packages/contracts/src/app-wiki-setup.js";
import { WIKI_SETUP_WORDS } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ID = (c: string) => c.repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const RID = "11111111-1111-4111-8111-111111111111";
const NEEDS_SIGN_IN = "Rovara's automatic runs are allowed right after you confirm it's you on the sign-in page: a tool that holds an API token cannot allow them. Confirm it's you, then try again within a few minutes.";
const NOT_ALLOWED = "Only company owners and admins can see or change whether Rovara's automatic runs are allowed for the company.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member"; fresh?: boolean }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ID("a"), company: A, role: "owner", fresh: true },
  "mel-token": { id: ID("e"), company: A, role: "admin", fresh: false },
  "pam-token": { id: ID("b"), company: A, role: "member", fresh: true },
  "bob-token": { id: ID("c"), company: B, role: "admin", fresh: true },
  "nob-token": { id: ID("d"), fresh: true },
};
interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const consent = new Map<string, boolean>();
  const logs: string[] = [];
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
    if (url.pathname !== "/v1/app/company/system-runs") return err(404, "NOT_FOUND", "route not found");
    // Code's rule: a live company owner or admin; the company is the caller's; allowing needs a fresh step-up, withdrawing does not.
    if (person.company === undefined || (person.role !== "owner" && person.role !== "admin")) return err(403, "FORBIDDEN", `${NOT_ALLOWED} ${LEAK}`);
    const view = () => ({ available: true, allowed: consent.get(person.company!) === true, systemRunsOn: consent.get(person.company!) === true });
    if (call.method === "GET") return json(200, view());
    const body = call.body as { requestId: string; allowed: boolean };
    if (body.allowed && person.fresh !== true) return err(403, "REAUTH_REQUIRED", NEEDS_SIGN_IN);
    consent.set(person.company, body.allowed);
    return json(200, view());
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
  const systemCalls = () => calls.filter((call) => call.path === "/v1/app/company/system-runs");
  return { as, send, calls, systemCalls, consent, logs };
}
const PATH = "/v1/web/company/system-runs";
const error = (answer: { body: any }) => answer.body.error as { code: string; message: string };
const asRefusal = (answer: { status: number; body: any }) => ({ status: answer.status, error: error(answer) });
const refusal = (key: keyof typeof WIKI_SETUP_ANSWERS) => ({ status: WIKI_SETUP_ANSWERS[key].status, error: (WIKI_SETUP_ANSWERS[key].body as { error: unknown }).error });
afterEach(() => { vi.restoreAllMocks(); });

describe("the words and the contract", () => {
  it("Cloud's new sentences are the same in the server and in the app's contracts and are among the sentences the app shows", () => {
    expect({ ...WIKI_SETUP_WORDS }).toEqual({ ...APP_WORDS });
    for (const key of ["needsSignIn", "systemRunsNotAllowed"] as const) expect(WIKI_SETUP_SENTENCES.has(APP_WORDS[key])).toBe(true);
    expect(SYSTEM_RUNS_PATH).toBe("/v1/app/company/system-runs");
  });
});

describe("who uses the control", () => {
  // MUTANT S1 (role check dropped) and S2 (the stored sign-in's role used): a member, a person with no company, or anyone Code names another way is refused here without Code being asked.
  it("an owner and an administrator read it as the strict app schema; a member and a person with no company get one fixed 403 and Code is not asked for the control", async () => {
    const s = setUp();
    for (const token of ["ada-token", "mel-token"]) {
      const answer = await s.send("GET", PATH, await s.as(token));
      expect(answer.status).toBe(200);
      expect(SystemRunsViewSchema.parse(answer.body)).toEqual({ available: true, allowed: false, systemRunsOn: false });
    }
    const asked = s.systemCalls().length;
    for (const token of ["pam-token"]) {
      for (const answer of [await s.send("GET", PATH, await s.as(token)), await s.send("PUT", PATH, await s.as(token), { requestId: RID, allowed: false })]) expect(asRefusal(answer)).toEqual(refusal("systemRunsNotAllowed"));
    }
    expect(s.systemCalls()).toHaveLength(asked);
    const nobody = await s.send("GET", PATH, await s.as("nob-token"));
    expect(nobody.status).toBe(403);
    expect(s.systemCalls()).toHaveLength(asked);
    expect(s.calls.every((call) => !call.path.includes("company/system-runs") || call.authorization !== "Bearer pam-token")).toBe(true);
  });
});

describe("allowing needs Code's fresh step-up; withdrawing needs none", () => {
  it("allowing with a fresh step-up works and Code is sent exactly the id and the choice", async () => {
    const s = setUp();
    const answer = await s.send("PUT", PATH, await s.as("ada-token"), { requestId: RID, allowed: true });
    expect(answer.status).toBe(200);
    expect(SystemRunsViewSchema.parse(answer.body)).toEqual({ available: true, allowed: true, systemRunsOn: true });
    const put = s.systemCalls().find((call) => call.method === "PUT")!;
    // MUTANT S13: a company or person in Code's body or path.
    expect(put.body).toEqual({ requestId: RID, allowed: true });
    expect(put.path).toBe("/v1/app/company/system-runs");
    expect(put.search).toBe("");
    expect(put.authorization).toBe("Bearer ada-token");
    expect(s.consent.get(A)).toBe(true);
  });

  // MUTANT S5 (REAUTH_REQUIRED not kept) and S6 (Code's words passed on).
  it("without a fresh step-up Code says REAUTH_REQUIRED: Cloud answers 403 with the same code in Cloud's own sentence, which the app turns into the sign-in step", async () => {
    const s = setUp();
    const answer = await s.send("PUT", PATH, await s.as("mel-token"), { requestId: RID, allowed: true });
    expect(asRefusal(answer)).toEqual(refusal("needsSignIn"));
    expect(error(answer)).toEqual({ code: "REAUTH_REQUIRED", message: APP_WORDS.needsSignIn });
    expect(answer.text).not.toContain("API token");
    expect(s.consent.get(A)).toBeUndefined();
  });

  it("a REAUTH_REQUIRED that is not Code's exact sentence is not read as the step-up (Cloud's 'not allowed' instead)", async () => {
    const s = setUp((call) => (call.method === "PUT" ? err(403, "REAUTH_REQUIRED", `other ${LEAK}`) : undefined));
    const answer = await s.send("PUT", PATH, await s.as("ada-token"), { requestId: RID, allowed: true });
    expect(asRefusal(answer)).toEqual(refusal("systemRunsNotAllowed"));
    expect(answer.text).not.toContain(LEAK);
  });

  // MUTANT S7: Cloud asks for a step-up on a withdrawal (here: a person whose step-up is stale is refused by Cloud itself).
  it("withdrawing needs none: an admin whose step-up is stale withdraws, and Cloud sends the same two fields", async () => {
    const s = setUp();
    await s.send("PUT", PATH, await s.as("ada-token"), { requestId: RID, allowed: true });
    const mel = await s.as("mel-token");
    const answer = await s.send("PUT", PATH, mel, { requestId: "22222222-2222-4222-8222-222222222222", allowed: false });
    expect(answer.status).toBe(200);
    expect(SystemRunsViewSchema.parse(answer.body)).toEqual({ available: true, allowed: false, systemRunsOn: false });
    expect(s.systemCalls().filter((call) => call.method === "PUT").at(-1)!.body).toEqual({ requestId: "22222222-2222-4222-8222-222222222222", allowed: false });
    expect(s.logs.at(-1)).toBe(JSON.stringify({ event: "cloud.system_runs", action: "withdrawn" }));
  });
});

describe("the body and the query are rebuilt, never passed on", () => {
  // MUTANT S3 and S4.
  it("an extra field, a malformed body, a non-boolean choice, a bad id and any query are refused 400 without asking Code", async () => {
    const s = setUp();
    const ada = await s.as("ada-token");
    const before = s.systemCalls().length;
    for (const body of [{ requestId: RID, allowed: true, company: A }, { requestId: RID, allowed: true, on: true }, { requestId: RID }, { allowed: true }, { requestId: RID, allowed: "yes" }, { requestId: "nope", allowed: true }, [], { requestId: RID, allowed: true, extra: undefined, x: 1 }]) {
      expect(asRefusal(await s.send("PUT", PATH, ada, body)), JSON.stringify(body)).toEqual(refusal("invalid"));
    }
    // Text that is not JSON never reaches the route (the handler's own 400).
    expect((await s.send("PUT", PATH, ada, "{not json")).status).toBe(400);
    expect(asRefusal(await s.send("PUT", `${PATH}?company=${B}`, ada, { requestId: RID, allowed: true }))).toEqual(refusal("invalid"));
    expect(asRefusal(await s.send("GET", `${PATH}?x=1`, ada))).toEqual(refusal("invalid"));
    expect(s.systemCalls()).toHaveLength(before);
  });

  it("systemRunsBody keeps exactly the id and the choice, and agrees with the app's own body schema", () => {
    expect(systemRunsBody({ requestId: RID, allowed: false })).toEqual({ requestId: RID, allowed: false });
    expect(systemRunsBody({ requestId: RID, allowed: false, x: 1 })).toBeUndefined();
    expect(SystemRunsBodySchema.safeParse({ requestId: RID, allowed: false, x: 1 }).success).toBe(false);
    expect(SystemRunsBodySchema.safeParse({ requestId: RID, allowed: false }).success).toBe(true);
  });
});

describe("the answer is rebuilt from three booleans and must read", () => {
  // MUTANT S8 and S9.
  it("Code's extra fields are dropped, and a non-boolean, a missing field or a contradiction refuses the whole read", async () => {
    const extra = setUp((call) => (call.path === "/v1/app/company/system-runs" ? json(200, { available: true, allowed: true, systemRunsOn: true, company: A, person: ID("a"), note: LEAK }) : undefined));
    const ok = await extra.send("GET", PATH, await extra.as("ada-token"));
    expect(ok.body).toEqual({ available: true, allowed: true, systemRunsOn: true });
    expect(ok.text).not.toContain(LEAK);
    for (const odd of [{ available: "yes", allowed: true, systemRunsOn: true }, { available: true, allowed: true }, { available: true, allowed: true, systemRunsOn: false }, { available: false, allowed: true, systemRunsOn: true }, [], null]) {
      const s = setUp((call) => (call.path === "/v1/app/company/system-runs" ? json(200, odd) : undefined));
      expect(asRefusal(await s.send("GET", PATH, await s.as("ada-token"))), JSON.stringify(odd)).toEqual(refusal("upkeepUnavailable"));
    }
    expect(() => systemRunsAnswer({ available: true, allowed: false, systemRunsOn: true })).toThrow();
  });
});

describe("Code's refusals are Cloud's fixed words", () => {
  // MUTANT S10 and S11.
  it("403 -> not allowed, unknown-route 404 and a ceiling that is off -> not yet, 400 -> invalid, anything else -> unavailable; Code's text never reaches the app", async () => {
    const cases: Array<[number, string, string, keyof typeof WIKI_SETUP_ANSWERS]> = [
      [403, "FORBIDDEN", LEAK, "systemRunsNotAllowed"], [403, "FORBIDDEN", NOT_ALLOWED, "systemRunsNotAllowed"], [404, "NOT_FOUND", "route not found", "upkeepNotYet"], [404, "NOT_AVAILABLE_HERE", LEAK, "upkeepNotYet"],
      [400, "CONFIG_INVALID", LEAK, "invalid"], [500, "X", LEAK, "upkeepUnavailable"], [409, "X", LEAK, "upkeepUnavailable"], [503, "RUNTIME_UNAVAILABLE", LEAK, "upkeepUnavailable"],
    ];
    for (const [status, code, message, key] of cases) {
      for (const [method, body] of [["GET", undefined], ["PUT", { requestId: RID, allowed: false }]] as const) {
        const s = setUp((call) => (call.path === "/v1/app/company/system-runs" ? err(status, code, message) : undefined));
        const answer = await s.send(method, PATH, await s.as("ada-token"), body);
        expect(asRefusal(answer), `${method} ${status} ${code}`).toEqual(refusal(key));
        expect(answer.text).not.toContain(LEAK);
      }
    }
  });
});

describe("two companies", () => {
  it("each company's owner reads and changes only their own setting, and nothing names a company to Code", async () => {
    const s = setUp();
    expect((await s.send("PUT", PATH, await s.as("ada-token"), { requestId: RID, allowed: true })).status).toBe(200);
    expect(s.consent.get(A)).toBe(true);
    expect(s.consent.get(B)).toBeUndefined();
    expect((await s.send("GET", PATH, await s.as("bob-token"))).body).toEqual({ available: true, allowed: false, systemRunsOn: false });
    expect((await s.send("PUT", PATH, await s.as("bob-token"), { requestId: RID, allowed: true })).status).toBe(200);
    expect((await s.send("PUT", PATH, await s.as("ada-token"), { requestId: "33333333-3333-4333-8333-333333333333", allowed: false })).status).toBe(200);
    expect(s.consent.get(A)).toBe(false);
    expect(s.consent.get(B)).toBe(true);
    for (const call of s.systemCalls()) { expect(JSON.stringify(call.body ?? {})).not.toMatch(/org_|developerId|role/u); expect(call.path + call.search).not.toContain("org_"); }
  });
});

describe("the log", () => {
  // MUTANT S12.
  it("says what was done, never what the person wrote", async () => {
    const s = setUp();
    await s.send("PUT", PATH, await s.as("ada-token"), { requestId: RID, allowed: true });
    expect(s.logs).toEqual([JSON.stringify({ event: "cloud.system_runs", action: "allowed" })]);
  });
});
