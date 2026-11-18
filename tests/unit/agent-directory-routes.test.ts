/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- the tests break a plain JSON answer on purpose */
// Lead 4 L4-MF3: the company-wide agent directory through Cloud's handler, answered from Code's `GET /v1/app/agents` as the signed-in person. Only a company owner or administrator reads it
// (the role is Code's access check now, never the stored sign-in): anyone else gets one fixed 403 and Code is not asked for the directory. Cloud forwards only `scope`, rebuilds each agent from
// known fields, refuses an answer that does not read (never a shorter list), and answers Code's refusals in fixed words (no echo of the browser's input or of Code's text).
import { describe, expect, it } from "vitest";
import {
  AGENT_DIRECTORY_ANSWERS, AGENT_DIRECTORY_LIMIT, AGENT_DIRECTORY_WORDS, AGENT_LIMITS, CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, directoryAnswer, type CloudRequest, type CodeSession,
} from "../../packages/cloud-server/src/index.js";
import { AgentDirectoryResponseSchema, AgentViewSchema } from "../../packages/contracts/src/agent-web-views.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64), PAM = "b".repeat(64), BOB = "c".repeat(64), NOB = "d".repeat(64), MEL = "e".repeat(64);
const LEAK = "SENSITIVE-CODE-DETAIL";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member" }
const PEOPLE: Record<string, Person> = {
  "ada-token": { id: ADA, company: A, role: "owner" },
  "mel-token": { id: MEL, company: A, role: "admin" },
  "pam-token": { id: PAM, company: A, role: "member" },
  "bob-token": { id: BOB, company: B, role: "admin" },
  "nob-token": { id: NOB },
};
const BUILTINS = ["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"];
const builtin = (agentId: string) => ({ agentId, name: agentId, description: "A built-in.", builtin: true, access: "manage", status: "active", currentVersion: 1, pinnedVersion: 1, latestVersion: 1 });
const custom = (company: string, n: number, owner: string) => ({
  agentId: `agt_${company === A ? "a" : "b"}${String(n).padStart(19, "0")}`, name: `Agent ${company === A ? "A" : "B"}${n}`, description: "Custom.", builtin: false, access: "manage", status: "active",
  owner: { kind: "member", developerId: owner }, latestVersion: 0, draftRevision: 1, createdBy: owner, createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z", needsLaterConnectors: "Can't run on hosted yet.",
});
const AGENTS: Record<string, unknown[]> = {
  [A]: [...BUILTINS.map(builtin), custom(A, 1, ADA), custom(A, 2, PAM)],
  [B]: [...BUILTINS.map(builtin), custom(B, 1, BOB)],
};

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"] };
    calls.push(call);
    const person = PEOPLE[(call.authorization ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    if (url.pathname !== "/v1/app/agents") return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
    // Code's rule: a live company owner or administrator only; the company is the caller's.
    if (person.company === undefined || (person.role !== "owner" && person.role !== "admin")) return json(403, { error: { code: "FORBIDDEN", message: `Only an owner ${LEAK}` } });
    const scope = url.searchParams.get("scope") ?? "all";
    const all = AGENTS[person.company]!;
    const wanted = scope === "builtin" ? all.filter((a: any) => a.builtin) : scope === "mine" ? all.filter((a: any) => a.owner?.developerId === person.id) : scope === "shared" ? [] : all;
    return json(200, { agents: wanted });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const as = async (token: string) => {
    const person = PEOPLE[token] ?? { id: "f".repeat(64) };
    // The stored sign-in names company A as owner for everyone: Cloud must use Code's live answer, never this.
    const access = { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: string, target: string, headers: Record<string, string>) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body), text: answered!.body };
  };
  const directoryCalls = () => calls.filter((call) => call.path === "/v1/app/agents");
  return { as, send, calls, directoryCalls };
}
const PATH = "/v1/web/agents";

describe("who reads the directory", () => {
  it("an owner and an administrator read it; the answer parses with the app's strict directory schema", async () => {
    const s = setUp();
    for (const token of ["ada-token", "mel-token"]) {
      const answer = await s.send("GET", `${PATH}?scope=all`, await s.as(token));
      expect(answer.status, token).toBe(200);
      expect(AgentDirectoryResponseSchema.safeParse(answer.body).success).toBe(true);
      expect(answer.body.agents).toHaveLength(8);
    }
  });

  it("a member gets one fixed 403 and Code is never asked for the directory, whatever the stored sign-in says (it says owner)", async () => {
    const s = setUp();
    const headers = await s.as("pam-token");
    for (const target of [PATH, `${PATH}?scope=all`, `${PATH}?scope=mine`, `${PATH}?scope=nonsense`, `${PATH}?project=payments`]) {
      const answer = await s.send("GET", target, headers);
      expect(answer.status, target).toBe(403);
      expect(answer.body).toEqual(AGENT_DIRECTORY_ANSWERS.forbidden.body);
      expect(answer.body.error.message).toBe(AGENT_DIRECTORY_WORDS.forbidden);
    }
    expect(s.directoryCalls()).toEqual([]);
  });

  it("a person Code names no company for is refused as having no company; Code is not asked for the directory", async () => {
    const s = setUp();
    const answer = await s.send("GET", PATH, await s.as("nob-token"));
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe("NO_COMPANY");
    expect(s.directoryCalls()).toEqual([]);
  });

  it("an owner who is demoted is refused on the next read (the role is Code's answer each time)", async () => {
    const s = setUp();
    const headers = await s.as("mel-token");
    expect((await s.send("GET", PATH, headers)).status).toBe(200);
    PEOPLE["mel-token"]!.role = "member";
    try { expect((await s.send("GET", PATH, headers)).status).toBe(403); } finally { PEOPLE["mel-token"]!.role = "admin"; }
  });

  it("two companies: each administrator reads only what Code answers for their own company", async () => {
    const s = setUp();
    const a = await s.send("GET", PATH, await s.as("ada-token")), b = await s.send("GET", PATH, await s.as("bob-token"));
    expect(a.text).toContain("Agent A1");
    expect(a.text).not.toContain("Agent B1");
    expect(b.text).toContain("Agent B1");
    expect(b.text).not.toContain("Agent A1");
    expect(b.text).not.toContain(ADA);
  });
});

describe("what Cloud asks Code", () => {
  it("passes the person's own token and only `scope` (default all); never a company, a person or any other query", async () => {
    const s = setUp();
    const headers = await s.as("ada-token");
    await s.send("GET", PATH, headers);
    for (const scope of ["all", "mine", "shared", "builtin"]) await s.send("GET", `${PATH}?scope=${scope}`, headers);
    expect(s.directoryCalls().map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      "GET /v1/app/agents?scope=all", "GET /v1/app/agents?scope=all", "GET /v1/app/agents?scope=mine", "GET /v1/app/agents?scope=shared", "GET /v1/app/agents?scope=builtin",
    ]);
    expect(new Set(s.directoryCalls().map((call) => call.authorization))).toEqual(new Set(["Bearer ada-token"]));
  });

  it("refuses an unknown or repeated scope, or another parameter, without asking Code; a project's list is not served", async () => {
    const s = setUp();
    const headers = await s.as("ada-token");
    for (const target of [`${PATH}?scope=nonsense`, `${PATH}?scope=ALL`, `${PATH}?scope=mine&scope=all`, `${PATH}?scope=all&company=${B}`, `${PATH}?q=x`]) {
      const answer = await s.send("GET", target, headers);
      expect(answer.status, target).toBe(400);
      expect(answer.body).toEqual(AGENT_DIRECTORY_ANSWERS.invalid.body);
      expect(answer.text).not.toContain(B);
    }
    for (const target of [`${PATH}?project=payments`, `${PATH}?scope=all&project=payments`]) {
      const answer = await s.send("GET", target, headers);
      expect(answer.status, target).toBe(501);
      expect(answer.body).toEqual(AGENT_DIRECTORY_ANSWERS.projectNotHere.body);
    }
    expect(s.directoryCalls()).toEqual([]);
  });

  it("only GET is the directory's; other methods are not routed to Code", async () => {
    const s = setUp();
    const headers = await s.as("ada-token");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await s.send(method, PATH, headers);
      expect([404, 405, 501], method).toContain(answer.status);
    }
    expect(s.directoryCalls()).toEqual([]);
  });
});

describe("the answer is rebuilt, and refused whole when it does not read", () => {
  const withAgents = (agents: unknown) => setUp((call) => (call.path === "/v1/app/agents" ? json(200, agents) : undefined));
  const refuse = async (agents: unknown) => {
    const s = withAgents(agents);
    const answer = await s.send("GET", PATH, await s.as("ada-token"));
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual(AGENT_DIRECTORY_ANSWERS.unavailable.body);
    return answer;
  };

  it("an unknown field is dropped, never passed on", async () => {
    const s = withAgents({ agents: [{ ...custom(A, 1, ADA), secretField: LEAK }], extra: LEAK });
    const answer = await s.send("GET", PATH, await s.as("ada-token"));
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(LEAK);
    expect(Object.keys(answer.body)).toEqual(["agents"]);
  });

  it("refuses: a status or access outside its set, a developer id that is not a hash, a bad id, a number out of bounds, a control character, a repeated id, too many agents, a body that is not an object", async () => {
    const good = custom(A, 1, ADA);
    for (const bad of [
      { ...good, status: "deleted" }, { ...good, access: "root" }, { ...good, owner: { kind: "member", developerId: "x" } }, { ...good, owner: { kind: "robot" } }, { ...good, agentId: "agt_short" },
      { ...good, latestVersion: -1 }, { ...good, monthlyBudgetUsd: -5 }, { ...good, monthlyBudgetUsd: 1e12 }, { ...good, name: "bad\u0000name" }, { ...good, name: "" }, { ...good, name: "x".repeat(AGENT_LIMITS.name + 1) },
      { ...good, createdAt: "yesterday" }, { ...good, builtin: "yes" }, { ...good, description: 5 }, { ...good, updateAvailable: { from: 0, to: 1 } }, { ...good, accountable: { developerId: "nope" } }, "not an agent", null,
    ]) await refuse({ agents: [bad] });
    await refuse({ agents: [good, good] });
    await refuse({ agents: Array.from({ length: AGENT_DIRECTORY_LIMIT + 1 }, (_, i) => custom(A, i, ADA)) });
    await refuse({ agents: "none" });
    await refuse([]);
    await refuse(null);
  });

  it("a refusal never carries the bad value", async () => {
    const answer = await refuse({ agents: [{ ...custom(A, 1, ADA), name: `bad\u0000${LEAK}` }] });
    expect(answer.text).not.toContain(LEAK);
  });

  it("keeps each field it knows: owner, budgets, accountable, versions, updateAvailable, extends, disabled", async () => {
    const full = { ...custom(A, 1, ADA), accountable: { developerId: BOB }, monthlyBudgetUsd: 20, maxPerRunUsd: 2.5, currentVersion: 2, pinnedVersion: 2, disabled: true, extends: { agentId: "rovara-code", version: 1 }, updateAvailable: { from: 1, to: 2 }, owner: { kind: "project", project: "payments" } };
    const s = withAgents({ agents: [full] });
    const answer = await s.send("GET", PATH, await s.as("ada-token"));
    expect(answer.status).toBe(200);
    expect(answer.body.agents[0]).toEqual(full);
    expect(AgentViewSchema.safeParse(answer.body.agents[0]).success).toBe(true);
    expect(directoryAnswer({ agents: [] })).toEqual({ agents: [] });
  });
});

describe("Code's refusals reach the app as fixed words", () => {
  const code = (status: number, body: unknown) => setUp((call) => (call.path === "/v1/app/agents" ? json(status, body) : undefined));
  it("403 -> forbidden; Code's exact unknown-route 404 -> not on Code yet; any other 404, 500 or 401 -> unavailable; 400 -> invalid; Code's text is never echoed", async () => {
    const cases: Array<[number, unknown, number, unknown]> = [
      [403, { error: { code: "FORBIDDEN", message: LEAK } }, 403, AGENT_DIRECTORY_ANSWERS.forbidden.body],
      [404, { error: { code: "NOT_FOUND", message: "route not found" } }, 501, AGENT_DIRECTORY_ANSWERS.notYet.body],
      [404, { error: { code: "NOT_FOUND", message: LEAK } }, 503, AGENT_DIRECTORY_ANSWERS.unavailable.body],
      [500, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }, 503, AGENT_DIRECTORY_ANSWERS.unavailable.body],
      [503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }, 503, AGENT_DIRECTORY_ANSWERS.unavailable.body],
      [400, { error: { code: "CONFIG_INVALID", message: LEAK } }, 400, AGENT_DIRECTORY_ANSWERS.invalid.body],
    ];
    for (const [status, body, expectStatus, expectBody] of cases) {
      const s = code(status, body);
      const answer = await s.send("GET", PATH, await s.as("ada-token"));
      expect([status, answer.status]).toEqual([status, expectStatus]);
      expect(answer.body).toEqual(expectBody);
      expect(answer.text).not.toContain(LEAK);
    }
  });
});
