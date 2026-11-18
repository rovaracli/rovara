// DEC 254zzz84 (1): the company's per-step AI models through Cloud's handler (agent-models-routes.ts). The pretend Code keeps two companies and applies Code's rules
// (core-host/agent-model-routes.ts): any member reads the setting and the gateway's list for THEIR company; an owner or admin changes one step from that list, revision-checked.
// Cloud must pass the person's own token, never let the browser name a company, refuse a member's change first (Code not asked), forward only checked members, check and project
// Code's answers, and answer refusals in its fixed words.
import { describe, expect, it } from "vitest";
import {
  AGENT_MODELS_WORDS, CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, agentModelsChange, agentModelsView, createCloudHandler, modelNameOf, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const LEAK = "SENSITIVE-CODE-DETAIL";
const START = Date.parse("2026-11-18T12:00:00.000Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const id = (name: string) => (name.startsWith("claude-") ? { provider: "anthropic", modelId: name } : { provider: "amazon-bedrock", modelId: name });

interface Person { id: string; company?: string; role?: "owner" | "admin" | "member" }
const PEOPLE: Record<string, Person> = {
  ada: { id: "d".repeat(64), company: A, role: "owner" },
  cal: { id: "c".repeat(64), company: A, role: "member" },
  bea: { id: "e".repeat(64), company: B, role: "admin" },
  nob: { id: "6".repeat(64) },
};
const OFFERED: Record<string, string[]> = { [A]: ["claude-sonnet-5-5", "qwen.qwen3-coder-480b-a35b-v1:0", "zai.glm-5"], [B]: ["claude-haiku-5-5"] };
const DEFAULT = "claude-sonnet-5-5";
const STAGES = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
const GROUP: Record<string, string[]> = { understand: ["understand", "plan"], plan: ["understand", "plan"], code_review: ["code_review", "security_review"], security_review: ["code_review", "security_review"] };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Override = (call: CodeCall, person: Person) => Response | undefined;

function setUp(override: Override = () => undefined) {
  const calls: CodeCall[] = [];
  const byToken = new Map<string, Person>();
  const settings = new Map<string, { revision: number; steps: Record<string, string> }>();
  const page = (company: string) => {
    const own = settings.get(company) ?? { revision: 0, steps: {} };
    return {
      state: {
        version: 1, revision: own.revision, reviewDefault: "install-model", runLimit: { enforced: false }, install: id(DEFAULT), models: [],
        steps: STAGES.map((stage) => ({ stage, setting: own.steps[stage] === undefined ? null : { model: id(own.steps[stage]) }, effective: { model: id(own.steps[stage] ?? DEFAULT), thinkingLevel: null, reason: own.steps[stage] === undefined ? "BUILTIN_DEFAULT" : "COMPANY_DEFAULT", sameModelAsChecked: false } })),
      },
      offered: { version: 1, models: OFFERED[company]!.map((model) => ({ model })) },
    };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    const person = byToken.get((call.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return json(401, {});
    if (url.pathname === "/v1/dev/access") {
      return json(200, { developerId: person.id, displayName: "Someone", administrator: false, ...(person.company === undefined ? {} : { companyId: person.company, companyRole: person.role }), projects: [], notices: [] });
    }
    const replaced = override(call, person);
    if (replaced !== undefined) return replaced;
    if (url.pathname !== "/v1/app/agent-models" || person.company === undefined) return json(404, { error: { code: "NOT_FOUND", message: `route not found ${LEAK}` } });
    // Code's broker may add its trace id to an answer: Cloud sets it aside.
    if (call.method === "GET") return json(200, { ...page(person.company), requestId: "r-1" });
    if (person.role !== "owner" && person.role !== "admin") return json(403, { error: { code: "FORBIDDEN", message: `Only an owner ${LEAK}` } });
    const body = call.body as { action: string; stage: string; choice?: { model: { provider: string; modelId: string } }; expectedRevision: number };
    const own = settings.get(person.company) ?? { revision: 0, steps: {} };
    if (body.expectedRevision !== own.revision) return json(409, { error: { code: "CHANGE_STALE", message: `${LEAK} stale` } });
    const name = body.choice?.model.modelId;
    if (body.action === "set" && (name === undefined || !OFFERED[person.company]!.includes(name))) return json(400, { error: { code: "CONFIG_INVALID", message: `${String(name)} is not offered ${LEAK}` } });
    const steps = { ...own.steps };
    for (const stage of GROUP[body.stage] ?? [body.stage]) { if (body.action === "clear") delete steps[stage]; else steps[stage] = name!; }
    settings.set(person.company, { revision: own.revision + 1, steps });
    return json(200, { ok: true, revision: own.revision + 1, lessSafe: [] });
  }) as typeof fetch;
  const sessions = new LocalSessionStore(undefined, { now: () => START, environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store: sessions, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(START), audit: new LocalCloudAuditStore(undefined, {}), company: { store: new LocalCompanyStore(), log: () => undefined },
  });
  let tokens = 0;
  const as = async (who: string) => {
    const person = PEOPLE[who]!; tokens += 1;
    const nowS = Math.floor(START / 1000);
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: person.id, iat: nowS, exp: nowS + 3600, jti: String(tokens) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    // The stored sign-in names company A, owner, for everyone: Cloud must use Code's live answer.
    await sessions.create(cookie, { accessToken: token, refreshToken: `r-${cookie}`, csrf: "csrf", signedInAt: new Date(START).toISOString(), access: { developerId: person.id, displayName: "Someone", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } });
    return { headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": "csrf", "content-type": "application/json" }, token };
  };
  const send = async (method: string, target: string, who: { headers: Record<string, string> }, body?: unknown, extra: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...who.headers, ...extra }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = (await handler(request))!;
    return { status: answered.status, body: JSON.parse(answered.body) as Record<string, unknown> & { error?: { code: string; message: string } }, text: answered.body };
  };
  const codeCalls = (method?: string) => calls.filter((call) => call.path === "/v1/app/agent-models" && (method === undefined || call.method === method));
  return { as, send, calls, codeCalls, settings };
}
const PATH = "/v1/web/org/agent-models";
type Steps = Array<{ stage: string; setting: string | null; effective: { model: string; companyDefault: boolean } | null }>;

describe("the company's per-step AI models", () => {
  it("any member reads every step and their own company's offered list; the company is never the browser's", async () => {
    const w = setUp();
    const cal = await w.as("cal");
    const read = await w.send("GET", `${PATH}?company=${B}`, cal, undefined, { "x-rovara-company": B });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ revision: 0, offered: OFFERED[A], canChange: false });
    const steps = read.body["steps"] as Steps;
    expect(steps.map((step) => step.stage)).toEqual(STAGES);
    expect(steps.every((step) => step.setting === null && step.effective?.model === DEFAULT && step.effective.companyDefault)).toBe(true);
    expect(w.codeCalls()).toEqual([expect.objectContaining({ method: "GET", search: "", authorization: `Bearer ${cal.token}` })]);
    for (const call of w.calls) expect(JSON.stringify(call.headers)).not.toContain(B);
    expect((await w.send("GET", PATH, await w.as("ada"))).body).toMatchObject({ canChange: true });
  });

  it("a plain member's change is refused by Cloud, and Code is not asked", async () => {
    const w = setUp();
    const refused = await w.send("POST", PATH, await w.as("cal"), { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0 });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: AGENT_MODELS_WORDS.notAdmin } } });
    expect(w.codeCalls("POST")).toEqual([]);
    expect(w.settings.size).toBe(0);
  });

  it("an owner sets one step from their list: Code gets the checked change only, as the owner; company B is untouched", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    const saved = await w.send("POST", `${PATH}?company=${B}`, ada, { action: "set", stage: "build", model: "qwen.qwen3-coder-480b-a35b-v1:0", expectedRevision: 0 }, { "x-rovara-company": B });
    expect(saved).toMatchObject({ status: 200, body: { ok: true, revision: 1 } });
    expect(w.codeCalls("POST")).toEqual([expect.objectContaining({ authorization: `Bearer ${ada.token}`, search: "", body: { action: "set", stage: "build", choice: { model: { provider: "amazon-bedrock", modelId: "qwen.qwen3-coder-480b-a35b-v1:0" } }, expectedRevision: 0 } })]);
    const steps = (await w.send("GET", PATH, ada)).body["steps"] as Steps;
    expect(steps.find((step) => step.stage === "build")).toMatchObject({ setting: "qwen.qwen3-coder-480b-a35b-v1:0", effective: { model: "qwen.qwen3-coder-480b-a35b-v1:0", companyDefault: false } });
    expect(steps.find((step) => step.stage === "plan")).toMatchObject({ setting: null, effective: { model: DEFAULT, companyDefault: true } });
    expect(w.settings.has(B)).toBe(false);
    const bea = await w.as("bea");
    expect(((await w.send("GET", PATH, bea)).body["steps"] as Steps).every((step) => step.setting === null)).toBe(true);
    // B's admin can't pick A's model: B's own list decides at Code, and Code's words never reach the app.
    const other = await w.send("POST", PATH, bea, { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0 });
    expect(other).toMatchObject({ status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: AGENT_MODELS_WORDS.notOffered } } });
    expect(other.text).not.toContain(LEAK);
    expect(other.text).not.toContain("zai.glm-5");
  });

  it("clears a step (back to the company's model)", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    await w.send("POST", PATH, ada, { action: "set", stage: "plan", model: "zai.glm-5", expectedRevision: 0 });
    const cleared = await w.send("POST", PATH, ada, { action: "clear", stage: "plan", expectedRevision: 1 });
    expect(cleared).toMatchObject({ status: 200, body: { ok: true, revision: 2 } });
    expect(w.codeCalls("POST").at(-1)?.body).toEqual({ action: "clear", stage: "plan", expectedRevision: 1 });
  });

  it("a stale revision is refused in Cloud's words", async () => {
    const w = setUp();
    const r = await w.send("POST", PATH, await w.as("ada"), { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 4 });
    expect(r).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE", message: AGENT_MODELS_WORDS.stale } } });
    expect(r.text).not.toContain(LEAK);
  });

  it("any body that is not one checked change is refused before Code, without echoing it", async () => {
    const w = setUp();
    const ada = await w.as("ada");
    for (const body of [
      { action: "set", stage: "build", model: "<script>", expectedRevision: 0 }, { action: "set", stage: "deploy", model: "zai.glm-5", expectedRevision: 0 },
      { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: -1 }, { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0, company: B },
      { action: "set", stage: "build", expectedRevision: 0 }, { action: "clear", stage: "build", model: "zai.glm-5", expectedRevision: 0 }, { action: "review-default", value: "install-model", expectedRevision: 0 },
      { action: "set", stage: "build", model: { provider: "openai", modelId: "x" }, expectedRevision: 0 }, null, [], {}, { action: "set", stage: "build", model: "a".repeat(129), expectedRevision: 0 },
    ]) {
      const r = await w.send("POST", PATH, ada, body);
      expect(r).toMatchObject({ status: 400, body: { error: { message: AGENT_MODELS_WORDS.invalid } } });
      expect(r.text).not.toContain("<script>");
    }
    expect(w.codeCalls("POST")).toEqual([]);
  });

  it("Code's refusals and failures reach the app as Cloud's fixed words", async () => {
    const cases: Array<[number, unknown, string]> = [
      [404, { error: { code: "NOT_FOUND", message: LEAK } }, AGENT_MODELS_WORDS.notYet],
      [403, { error: { code: "REAUTH_REQUIRED", message: LEAK } }, AGENT_MODELS_WORDS.stepUp],
      [403, { error: { code: "FORBIDDEN", message: "This change needs a different person to confirm it, and this install has no second person. It was not made." } }, AGENT_MODELS_WORDS.secondPerson],
      [400, { error: { code: "CONFIG_INVALID", message: "A checking step must use a different model than the step it checks. Choose another model." } }, AGENT_MODELS_WORDS.sameModel],
      [503, { error: { code: "RUNTIME_UNAVAILABLE", message: "The models Rovara's AI offers this company could not be read just now, so no model was chosen." } }, AGENT_MODELS_WORDS.listUnreadable],
      [503, { error: { code: "RUNTIME_UNAVAILABLE", message: LEAK } }, AGENT_MODELS_WORDS.unavailable],
      [500, { error: { code: "X", message: LEAK } }, AGENT_MODELS_WORDS.unavailable],
    ];
    for (const [status, body, words] of cases) {
      const w = setUp((call) => (call.path === "/v1/app/agent-models" ? json(status, body) : undefined));
      const ada = await w.as("ada");
      for (const r of [await w.send("GET", PATH, ada), await w.send("POST", PATH, ada, { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0 })]) {
        expect(r.body.error?.message).toBe(words);
        expect(r.text).not.toContain(LEAK);
      }
    }
  });

  it("an answer from Code that is not the page is 'couldn't be read', never half drawn", async () => {
    for (const bad of [{}, { state: {}, offered: {} }, { state: { revision: 0, steps: [] }, offered: { version: 1, models: [] } }, { state: { revision: 0, steps: [{ stage: "deploy" }] }, offered: { version: 1, models: [{ model: "x" }] } }, { extra: 1, state: { revision: 0, steps: [] }, offered: { version: 1, models: [{ model: "x" }] } },
      { state: { revision: 0, steps: [{ stage: "build", setting: null, effective: { model: id("x"), reason: "SOMETHING_ELSE" } }] }, offered: { version: 1, models: [{ model: "x" }] } }]) {
      const w = setUp((call) => (call.path === "/v1/app/agent-models" ? json(200, bad) : undefined));
      expect((await w.send("GET", PATH, await w.as("ada"))).body.error?.message).toBe(AGENT_MODELS_WORDS.unavailable);
    }
    const ok = setUp((call) => (call.path === "/v1/app/agent-models" && call.method === "POST" ? json(200, { ok: false }) : undefined));
    expect((await ok.send("POST", PATH, await ok.as("ada"), { action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0 })).body.error?.message).toBe(AGENT_MODELS_WORDS.unavailable);
  });

  it("a person with no company is refused before Code", async () => {
    const w = setUp();
    const r = await w.send("GET", PATH, await w.as("nob"));
    expect(r.status).toBe(403);
    expect(w.codeCalls()).toEqual([]);
  });
});

describe("the projection", () => {
  it("names a model the way the gateway does, and refuses a provider that does not match the name", () => {
    expect(modelNameOf({ provider: "anthropic", modelId: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(modelNameOf({ provider: "amazon-bedrock", modelId: "zai.glm-5" })).toBe("zai.glm-5");
    expect(modelNameOf({ provider: "amazon-bedrock", modelId: "claude-opus-5-5" })).toBeUndefined();
    expect(modelNameOf({ provider: "anthropic", modelId: "zai.glm-5" })).toBeUndefined();
    expect(modelNameOf({ provider: "anthropic", modelId: "claude-opus-5-5", extra: 1 })).toBeUndefined();
  });
  it("keeps a step's price when Code knows it, and refuses a price that is not an amount", () => {
    const page = (price: unknown) => ({ state: { revision: 3, steps: [{ stage: "build", setting: null, effective: { model: id("zai.glm-5"), reason: "INSTALL_MODEL", priceUsdPerMillion: price } }] }, offered: { version: 1, models: [{ model: "zai.glm-5" }] } });
    expect(agentModelsView(page({ input: 1, output: 3.2, source: "catalog" }))?.steps[0]?.effective).toEqual({ model: "zai.glm-5", companyDefault: true, priceUsdPerMillion: { input: 1, output: 3.2 } });
    expect(agentModelsView(page({ input: -1, output: 3 }))).toBeUndefined();
    expect(agentModelsView(page(undefined))?.steps[0]?.effective).toEqual({ model: "zai.glm-5", companyDefault: true });
    expect(agentModelsView(page("free"))).toBeUndefined();
  });
  it("a set change becomes Code's model identity", () => {
    expect(agentModelsChange({ action: "set", stage: "plan", model: "claude-fable-5-2", expectedRevision: 2 })).toEqual({ action: "set", stage: "plan", choice: { model: { provider: "anthropic", modelId: "claude-fable-5-2" } }, expectedRevision: 2 });
  });
});
