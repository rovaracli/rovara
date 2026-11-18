// L4-EGR: GET /v1/web/org/egress-addresses through Cloud's real handler (egress-addresses-routes.ts) against a pretend Rovara Code with two companies. Cloud must pass the person's own
// token, never let the browser name a company, refuse a plain member first (Code not asked), check Code's answer strictly, and answer every refusal in fixed words. Both companies see
// the SAME addresses (they belong to the install).
import { describe, expect, it } from "vitest";
import {
  CodeClient, EGRESS_ANSWERS, EGRESS_WORDS, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, egressAddressesView, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const ADDRESSES = ["44.235.136.195", "44.226.134.187"];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member" }
const PEOPLE: Record<string, Person> = {
  ada: { id: "d".repeat(64), company: A, role: "owner" },
  cal: { id: "c".repeat(64), company: A, role: "member" },
  bea: { id: "e".repeat(64), company: B, role: "admin" },
  bob: { id: "b".repeat(64), company: B, role: "member" },
  nob: { id: "6".repeat(64) },
};
interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const clock = { at: START };
  const calls: CodeCall[] = [];
  const byToken = new Map<string, Person>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const person = byToken.get((call.authorization ?? "").replace(/^Bearer /u, ""));
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    }
    const replaced = override(call);
    if (replaced !== undefined) return replaced;
    if (url.pathname === "/v1/dev/company/egress-addresses") {
      if (person.company === undefined) return json(401, { error: { code: "AUTH_REQUIRED", message: LEAK } });
      if (person.role !== "owner" && person.role !== "admin") return json(403, { error: { code: "FORBIDDEN", message: "Only a company owner or admin can see Rovara's outbound addresses." } });
      // Code's json() adds the request's own id to every object body.
      return json(200, { addresses: ADDRESSES, requestId: "9f1c2b7e-3d4a-4e5f-8a6b-0c1d2e3f4a5b" });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store: sessions, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(clock.at), audit: new LocalCloudAuditStore(undefined, {}), company: { store: new LocalCompanyStore(), log: () => undefined },
  });
  let tokens = 0;
  /** Signs `who` in. The stored sign-in names company A for everyone: Cloud must use Code's live answer. */
  const as = async (who: string) => {
    const person = PEOPLE[who]!; tokens += 1;
    const nowS = Math.floor(clock.at / 1000);
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: person.id, iat: nowS, exp: nowS + 3600, jti: String(tokens) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, refreshToken: `r-${cookie}`, csrf: "csrf", signedInAt: new Date(clock.at).toISOString(), access: { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } });
    return { headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": "csrf", "content-type": "application/json" }, token };
  };
  const send = async (method: string, target: string, who: { headers: Record<string, string> }, body?: unknown, extra: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...who.headers, ...extra }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = (await handler(request))!;
    return { status: answered.status, body: JSON.parse(answered.body) as Record<string, unknown> & { error?: { code: string; message: string } }, text: answered.body };
  };
  const codeCalls = (path: string, method?: string) => calls.filter((call) => call.path.startsWith(path) && (method === undefined || call.method === method));
  return { as, send, calls, codeCalls };
}
const PATH = "/v1/web/org/egress-addresses";
const CODE_PATH = "/v1/dev/company/egress-addresses";

describe("Rovara's outbound addresses, for company owners and admins", () => {
  it("an owner reads them as themselves, with their own token, and the browser never names a company", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    const read = await w.send("GET", `${PATH}?company=${B}&orgId=${B}`, ada, undefined, { "x-rovara-company": B });
    expect(read).toMatchObject({ status: 200, body: { addresses: ADDRESSES } });
    expect(w.codeCalls(CODE_PATH)).toEqual([expect.objectContaining({ method: "GET", search: "", authorization: `Bearer ${ada.token}` })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers) + call.search).not.toContain(B);
  });

  it("two companies read the SAME addresses: A's owner and B's admin", async () => {
    const w = setUp();
    const first = await w.send("GET", PATH, await w.as("ada"));
    const second = await w.send("GET", PATH, await w.as("bea"));
    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual({ addresses: ADDRESSES });
  });

  it("passes Code's real answer, which carries its own requestId, as exactly { addresses } (the id is dropped, never forwarded)", async () => {
    const w = setUp();
    const read = await w.send("GET", PATH, await w.as("ada"));
    expect(read).toMatchObject({ status: 200, body: { addresses: ADDRESSES } });
    expect(Object.keys(read.body)).toEqual(["addresses"]);
    expect(read.text).not.toContain("requestId");
  });

  it("a plain member of either company is refused by Cloud in fixed words, and Code is not asked", async () => {
    for (const who of ["cal", "bob"]) {
      const w = setUp();
      const member = await w.as(who);
      const refused = await w.send("GET", PATH, member);
      expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: EGRESS_WORDS.notAdmin } } });
      expect(w.codeCalls(CODE_PATH)).toEqual([]);
      expect(refused.text).not.toMatch(/44\.235|44\.226/u);
    }
  });

  it("someone Code names no company for is refused before Code's route", async () => {
    const w = setUp();
    const r = await w.send("GET", PATH, await w.as("nob"));
    expect(r.body).toMatchObject({ error: { code: "NO_COMPANY" } });
    expect(w.codeCalls(CODE_PATH)).toEqual([]);
  });

  it("answers only GET (no write is possible)", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect([method, [404, 405, 501].includes((await w.send(method, PATH, ada, {})).status)]).toEqual([method, true]);
    expect(w.codeCalls(CODE_PATH)).toEqual([]);
  });

  it("Code's refusals and failures become fixed sentences; nothing of Code's text leaks", async () => {
    const cases: Array<[Response, unknown]> = [
      [json(404, { error: { code: "NOT_FOUND", message: LEAK } }), EGRESS_ANSWERS.notYet.body],
      [json(403, { error: { code: "FORBIDDEN", message: LEAK } }), EGRESS_ANSWERS.notAdmin.body],
      [json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }), EGRESS_ANSWERS.unavailable.body],
      [json(500, { error: { code: "X", message: LEAK } }), EGRESS_ANSWERS.unavailable.body],
      [json(200, { addresses: [LEAK] }), EGRESS_ANSWERS.unavailable.body],
      [json(200, { addresses: ["10.0.0.1"] }), EGRESS_ANSWERS.unavailable.body],
      [json(200, { addresses: ADDRESSES, company: LEAK }), EGRESS_ANSWERS.unavailable.body],
    ];
    for (const [response, expected] of cases) {
      const w = setUp((call) => (call.path === CODE_PATH ? response.clone() : undefined));
      const r = await w.send("GET", PATH, await w.as("ada"));
      expect(r.body).toEqual(expected);
      expect(r.text).not.toContain(LEAK);
    }
  });

  it("an install with no addresses yet reads an empty list, which is a real answer", async () => {
    const w = setUp((call) => (call.path === CODE_PATH ? json(200, { addresses: [] }) : undefined));
    expect(await w.send("GET", PATH, await w.as("ada"))).toMatchObject({ status: 200, body: { addresses: [] } });
  });
});

describe("Code's answer is checked", () => {
  it("passes a list of up to four distinct public addresses, and refuses anything else", () => {
    expect(egressAddressesView({ addresses: [] })).toEqual({ addresses: [] });
    expect(egressAddressesView({ addresses: ADDRESSES })).toEqual({ addresses: ADDRESSES });
    expect(egressAddressesView({ addresses: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"] })).toBeDefined();
    expect(egressAddressesView({ addresses: ADDRESSES, requestId: "9f1c2b7e-3d4a-4e5f-8a6b-0c1d2e3f4a5b" })).toEqual({ addresses: ADDRESSES });
    for (const bad of [
      { addresses: ADDRESSES, requestId: 7 }, { addresses: ADDRESSES, requestId: "has a space" }, { addresses: ADDRESSES, requestId: "x".repeat(200) }, { addresses: ADDRESSES, requestId: LEAK + "<" },
      undefined, null, [], "x", {}, { addresses: "44.235.136.195" }, { addresses: [1] }, { addresses: ["1.1.1.1", "1.1.1.1"] }, { addresses: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"] },
      { addresses: ["44.235.136.256"] }, { addresses: ["044.235.136.195"] }, { addresses: ["44.235.136.195 "] }, { addresses: ["44.235.136.195/32"] }, { addresses: ["::1"] },
      { addresses: ["10.1.2.3"] }, { addresses: ["127.0.0.1"] }, { addresses: ["169.254.169.254"] }, { addresses: ["100.64.0.1"] }, { addresses: ["192.168.0.1"] }, { addresses: ["172.16.0.1"] },
      { addresses: ADDRESSES, extra: 1 }, { ...{ addresses: ADDRESSES }, __proto__: { x: 1 } },
    ]) expect(egressAddressesView(bad), JSON.stringify(bad)).toBeUndefined();
  });
});
