// Lead 4 L4-CW item 1: the wiki build controls' "AI key" state on a hosted Rovara. Code's hosted wiki build cannot see the model gateway's per-company choice (it lives in Cloud's Companies table and the
// product key store), so Code answers `aiKey: "unknown"`. Cloud knows, so Cloud's wiki setup pass-through puts a YES/NO fact in that one member of its own answer, and refuses a start it knows would die.
// Rules proved here: the company is Code's LIVE answer (never the browser's, never the stored sign-in); only a person who manages the project is told (anyone else keeps "unknown" and costs no read);
// Code's own connected/missing is never overridden; a fact Cloud cannot read stays "unknown" (never "missing"); the answers carry only the enum and Code's fixed sentence (never a key, a provider, a
// source or a model); a start, continue or refresh that would die is refused before Code is asked, only for a person who may start it.
// Mutants (each killed by the named test, run by hand): M1 the fact is added for a person who only reads (viewer test); M2 the company is the stored sign-in's (two-company test); M3 the fact reads the
// first company's choice (two-company test); M4 an unreadable fact is "missing" (unreadable test); M5 Code's own answer is overridden (code-says test); M6 "rovara" counts as no key and an unavailable
// source counts as a key (matrix tests); M7 the refusal is answered to a person who may not start (viewer start test); M8 the refusal also stops stop/agents/delete (not-a-start test); M9 connectKey
// kept while connected / missing without it (state tests); M10 the refusal skips the manager check (viewer start test); M11 a provider, source or key reaches the answer (leak test); M12 the refusal ignores Code's own answer; M13 an unreadable fact refuses the start; M15 the company's choice is read before Code says who manages.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAiConnected } from "../../packages/cloud-server/src/agent-ai-presence.js";
import { WIKI_SETUP_CODE_WORDS } from "../../packages/cloud-server/src/index.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { A, B, world, write, type Person } from "./product-ai-world.js";

const RID = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CONNECT = WIKI_SETUP_CODE_WORDS.connectKey;

/** Code's wiki-build routes for project `web` (company A's and company B's own), W4's rule: a company owner/admin or the project's administrator manages; any role reads; its own `aiKey`. */
function codeRoutes(aiKey: "connected" | "missing" | "unknown" = "unknown") {
  const calls: string[] = [];
  const code = (call: { method: string; pathname: string }, person: Person): Response | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/wiki-build(?:\/(continue|stop|refresh|agents|delete))?$/u.exec(call.pathname);
    if (match === null) return undefined;
    calls.push(`${call.method} ${match[2] ?? "start-or-state"}`);
    const role = person.companyRole ?? (person.administrator ? "admin" : "member");
    const mine = person.projects.find((project) => project.name === match[1]);
    const manage = role === "owner" || role === "admin" || mine?.access === "administrator";
    if (!manage && mine === undefined) return json(404, { error: { code: "NOT_FOUND", message: "project not found" } });
    if (call.method !== "GET" && !manage) return json(403, { error: { code: "FORBIDDEN", message: WIKI_SETUP_CODE_WORDS.notAllowed } });
    const view = { status: "none", limits: { pages: 300, budgetCents: 2_500, wallClockMin: 180, pageReserveCents: 100 }, payer: "project", canManage: manage, aiKey, agents: { on: false }, wiki: { pages: 0, refreshPages: 0 }, ...(aiKey === "missing" ? { connectKey: CONNECT } : {}) };
    if (match[2] === "delete") return json(200, { deleted: true, message: WIKI_SETUP_CODE_WORDS.deleted, view });
    return json(call.method === "GET" ? 200 : 202, view);
  };
  return { code, calls };
}
const P = (tail = "") => `/projects/web/wiki-build${tail}`;
const raw = (answer: { raw: string }) => answer.raw;
const fakeKey = () => ["sk", "ant", randomBytes(16).toString("hex")].join("-");
/** Company A (admin Ada, project admin Pam, project developer Cal) and B (admin Bea, project admin Bob) on Code's fake. */
async function setUp(aiKey: "connected" | "missing" | "unknown" = "unknown") {
  const routes = codeRoutes(aiKey);
  const w = world({ company: true, code: routes.code });
  const cookies = { ada: await w.signIn("ada", 30), pam: await w.signIn("pam", 30), cal: await w.signIn("cal", 30), bea: await w.signIn("bea", 30), bob: await w.signIn("bob", 30) };
  return { w, cookies, calls: routes.calls };
}
// DEC 254zzz279 / R-1: no choice is now ready by default. Missing-AI permission/refusal controls must explicitly choose a disconnected own key.
const chooseMissing = async (w: Awaited<ReturnType<typeof setUp>>["w"], cookie: string) => {
  expect((await w.call(cookie, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "anthropic_key" })).status).toBe(200);
};
const chooseRovara = async (w: Awaited<ReturnType<typeof setUp>>["w"], cookie: string, version = 0) => w.call(cookie, "PUT", "/org/agent-ai", { expectedVersion: version, source: "rovara" });
const connectAnthropic = async (w: Awaited<ReturnType<typeof setUp>>["w"], cookie: string, key = fakeKey()) => { await w.call(cookie, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key })); return key; };
afterEach(() => { vi.restoreAllMocks(); });

describe("the fact itself (agentAiConnected): yes, no, or cannot tell", () => {
  type Ctx = Pick<RouteContext, "company" | "productAi">;
  const context = (source: string | undefined, extra: { anthropic?: boolean | "throws"; bedrock?: boolean | "throws"; noCompany?: boolean; noProductAi?: boolean; noBedrockBackend?: boolean } = {}) => {
    const sources = (provider: string, ok: boolean | "throws") => { if (ok === "throws") throw new Error("down"); return { sources: ok ? [{ provider, hasKey: true, available: true }] : [{ provider, hasKey: true, available: false }] }; };
    return {
      ...(extra.noCompany === true ? {} : { company: { store: { agentAi: async () => { if (source === "throws") throw new Error("down"); return source === undefined ? undefined : { source }; } } } }),
      ...(extra.noProductAi === true ? {} : {
        productAi: {
          issuer: "iss", ...(extra.noBedrockBackend === true ? {} : { bedrock: {} }),
          store: { view: async (_iss: string, _cid: string, owner: string) => owner === "_learning" ? sources("anthropic", extra.anthropic ?? false) : sources("bedrock", extra.bedrock ?? false) },
        },
      }),
    } as unknown as Ctx;
  };
  const ask = (c: Ctx) => agentAiConnected(c, A);

  it("Rovara's AI is connected; a saved own key or own Bedrock is connected only while it is available; no choice preserves own connections then uses Rovara AI (DEC 254zzz279 / R-1, M6)", async () => {
    expect(await ask(context("rovara"))).toBe(true);
    expect(await ask(context("anthropic_key", { anthropic: true }))).toBe(true);
    expect(await ask(context("anthropic_key", { anthropic: false }))).toBe(false);
    expect(await ask(context("bedrock_byo", { bedrock: true }))).toBe(true);
    expect(await ask(context("bedrock_byo", { bedrock: false }))).toBe(false);
    expect(await ask(context(undefined, { anthropic: true }))).toBe(true);
    // DEC 254zzz279 / R-1: nothing connected uses billed Rovara AI; an explicitly disconnected choice below still refuses.
    expect(await ask(context(undefined, { anthropic: false }))).toBe(true);
    // A key of the other kind does not count for the chosen source.
    expect(await ask(context("anthropic_key", { anthropic: false, bedrock: true }))).toBe(false);
    expect(await ask(context("bedrock_byo", { anthropic: true, bedrock: false }))).toBe(false);
  });

  it("cannot tell (null, never false) when Cloud has no company data, no product store, no Bedrock backend, an unreadable choice or store, or a source it does not know (M4)", async () => {
    expect(await ask(context("rovara", { noCompany: true }))).toBeNull();
    expect(await ask(context("anthropic_key", { noProductAi: true }))).toBeNull();
    expect(await ask(context(undefined, { noProductAi: true }))).toBeNull();
    expect(await ask(context("bedrock_byo", { noBedrockBackend: true, bedrock: true }))).toBeNull();
    expect(await ask(context("throws"))).toBeNull();
    expect(await ask(context("anthropic_key", { anthropic: "throws" }))).toBeNull();
    expect(await ask(context("bedrock_byo", { bedrock: "throws" }))).toBeNull();
    expect(await ask(context("some_future_source"))).toBeNull();
  });

  it("an unsaved source is unknown on required connection read failures, for either billing class (R-1)", async () => {
    for (const exempt of [false, true]) {
      for (const extra of [{ anthropic: "throws" }, { bedrock: "throws" }] as const) {
        const c = context(undefined, extra);
        c.company!.rovaraAiExempt = new Set(exempt ? [A] : []);
        expect(await ask(c)).toBeNull();
      }
    }
    // Anthropic wins without reading an irrelevant, broken Bedrock connection; absent Bedrock is not a read failure.
    expect(await ask(context(undefined, { anthropic: true, bedrock: "throws" }))).toBe(true);
    expect(await ask(context(undefined, { noBedrockBackend: true }))).toBe(true);
  });

  it("asks only for the company it is given, and answers a boolean or null, nothing else", async () => {
    const seen: string[] = [];
    const c = { company: { store: { agentAi: async (id: string) => { seen.push(id); return { source: "anthropic_key", apiKey: "ignored" }; } } }, productAi: { issuer: "iss", store: { view: async (_i: string, id: string) => { seen.push(id); return { sources: [{ provider: "anthropic", hasKey: true, available: true, secret: "x" }] }; } } } } as unknown as Ctx;
    expect(await agentAiConnected(c, B)).toBe(true);
    expect(seen).toEqual([B, B]);
  });
});

describe("the build state a person who manages the project sees", () => {
  it("connected when the company's AI is connected, missing (with Code's fixed sentence) when not; no connectKey while connected (M9)", async () => {
    const { w, cookies } = await setUp();
    // DEC 254zzz279 / R-1: no choice and nothing connected uses Rovara AI without writing a choice.
    const defaulted = await w.call(cookies.ada, "GET", P());
    expect(defaulted.body).toMatchObject({ aiKey: "connected" });
    expect(defaulted.body).not.toHaveProperty("connectKey");
    expect(await w.companies.agentAi(A)).toBeUndefined();
    await chooseMissing(w, cookies.ada);
    const none = await w.call(cookies.ada, "GET", P());
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ canManage: true, aiKey: "missing", connectKey: CONNECT });
    expect((await chooseRovara(w, cookies.ada, 1)).status).toBe(200);
    const yes = await w.call(cookies.ada, "GET", P());
    expect(yes.body).toMatchObject({ canManage: true, aiKey: "connected" });
    expect(Object.keys(yes.body)).not.toContain("connectKey");
    // The project's own administrator (not a company admin) is told too.
    expect((await w.call(cookies.pam, "GET", P())).body).toMatchObject({ canManage: true, aiKey: "connected" });
  });

  it("the company's own Anthropic key counts as connected, and the key, the provider and the source never reach any answer (M11)", async () => {
    const { w, cookies } = await setUp();
    const key = await connectAnthropic(w, cookies.ada);
    expect((await w.call(cookies.ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "anthropic_key" })).status).toBe(200);
    const answers = [
      await w.call(cookies.ada, "GET", P()),
      await w.call(cookies.ada, "POST", P(), { requestId: RID }),
      await w.call(cookies.ada, "POST", P("/continue"), { requestId: RID }),
      await w.call(cookies.ada, "POST", P("/delete"), { requestId: RID }),
    ];
    expect(answers[0]!.body).toMatchObject({ aiKey: "connected" });
    expect(answers[3]!.body).toMatchObject({ deleted: true, view: { aiKey: "connected" } });
    for (const answer of answers) {
      const text = raw(answer).toLowerCase();
      for (const word of [key.toLowerCase(), "anthropic", "bedrock", "vertex", "openai", "gemini", "anthropic_key", "bedrock_byo", "agent_ai", "sk-"]) expect(text).not.toContain(word);
    }
    // Positive control: the same answers do carry the fact (so the leak check ran on a body that names it).
    expect(raw(answers[0]!)).toContain('"aiKey":"connected"');
  });

  it("two companies: each manager is told about their own company only, from Code's live company (M2, M3)", async () => {
    const { w, cookies } = await setUp();
    await chooseRovara(w, cookies.ada);
    await chooseMissing(w, cookies.bea);
    expect((await w.call(cookies.ada, "GET", P())).body).toMatchObject({ aiKey: "connected" });
    expect((await w.call(cookies.bea, "GET", P())).body).toMatchObject({ aiKey: "missing", connectKey: CONNECT });
    expect((await w.call(cookies.bob, "GET", P())).body).toMatchObject({ aiKey: "missing" });
    // B connects theirs; A's choice and B's are separate rows.
    expect((await w.call(cookies.bea, "PUT", "/org/agent-ai", { expectedVersion: 1, source: "anthropic_key" })).status).toBe(200);
    expect((await w.call(cookies.bea, "GET", P())).body).toMatchObject({ aiKey: "missing" });
    await connectAnthropic(w, cookies.bea);
    expect((await w.call(cookies.bea, "GET", P())).body).toMatchObject({ aiKey: "connected" });
    expect((await w.companies.agentAi(A))).toMatchObject({ source: "rovara" });
    // A's own state did not move.
    expect((await w.call(cookies.ada, "GET", P())).body).toMatchObject({ aiKey: "connected" });
  });

  it("a person who only reads keeps Code's word and costs no read of the company's choice (M1)", async () => {
    const { w, cookies } = await setUp();
    await chooseRovara(w, cookies.ada);
    const read = vi.spyOn(w.companies, "agentAi");
    const viewer = await w.call(cookies.cal, "GET", P());
    expect(viewer.body).toMatchObject({ canManage: false, aiKey: "unknown" });
    expect(Object.keys(viewer.body)).not.toContain("connectKey");
    expect(read).not.toHaveBeenCalled();
    // Positive control: the manager's read does ask.
    expect((await w.call(cookies.ada, "GET", P())).body).toMatchObject({ aiKey: "connected" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("Code's own connected or missing is never overridden (M5)", async () => {
    for (const code of ["connected", "missing"] as const) {
      const { w, cookies } = await setUp(code);
      // Company A chose Rovara's AI (a fact of "connected"), Code says otherwise for "missing".
      await chooseRovara(w, cookies.ada);
      expect((await w.call(cookies.ada, "GET", P())).body).toMatchObject({ aiKey: code });
    }
  });

  it("a fact Cloud cannot read stays unknown, with no connectKey (M4)", async () => {
    const { w, cookies } = await setUp();
    vi.spyOn(w.companies, "agentAi").mockRejectedValue(new Error("table down"));
    const answer = await w.call(cookies.ada, "GET", P());
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ aiKey: "unknown" });
    expect(Object.keys(answer.body)).not.toContain("connectKey");
    expect(raw(answer)).not.toContain("table down");
  });

  it("a Cloud with no company data leaves Code's answer as it was", async () => {
    const routes = codeRoutes();
    const w = world({ code: routes.code });
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "GET", P())).body).toMatchObject({ canManage: true, aiKey: "unknown" });
  });
});

describe("a start that would die is refused before Code is asked, for a person who may start it", () => {
  const starts: Array<[string, string]> = [["", "start-or-state"], ["/continue", "continue"], ["/refresh", "refresh"]];

  it("build, continue and refresh with no AI connected: Code's own fixed sentence, 503, and nothing reaches Code but the read of the state (M10)", async () => {
    for (const [tail] of starts) {
      const { w, cookies, calls } = await setUp();
      await chooseMissing(w, cookies.ada);
      const answer = await w.call(cookies.ada, "POST", P(tail), { requestId: RID });
      expect(answer.status).toBe(503);
      expect(answer.body.error).toEqual({ code: "MODEL_PROXY_UNAVAILABLE", message: CONNECT });
      // Only the state read (GET) was asked of Code, never the POST that would start a task.
      expect(calls).toEqual(["GET start-or-state"]);
    }
  });

  it("with the AI connected the same three go through to Code and are answered with the fact", async () => {
    for (const [tail, seen] of starts) {
      const { w, cookies, calls } = await setUp();
      await chooseRovara(w, cookies.ada);
      const answer = await w.call(cookies.ada, "POST", P(tail), { requestId: RID });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ canManage: true, aiKey: "connected" });
      expect(calls).toEqual(["GET start-or-state", `POST ${seen}`]);
    }
  });

  it("a person who may not start it gets Code's own refusal, never the AI-key sentence (M7)", async () => {
    const { w, cookies, calls } = await setUp();
    const answer = await w.call(cookies.cal, "POST", P(), { requestId: RID });
    expect(answer.status).toBe(403);
    expect(answer.body.error?.message).toBe(WIKI_SETUP_CODE_WORDS.notAllowed);
    expect(raw(answer)).not.toContain(CONNECT);
    // Code was asked (state read, then the POST), so Code's rule decided.
    expect(calls).toEqual(["GET start-or-state", "POST start-or-state"]);
    // A person with no standing on the project at all: Code's 404 words.
    const other = await w.call(cookies.bob, "POST", "/projects/payments/wiki-build", { requestId: RID });
    expect(other.status).toBe(404);
    expect(raw(other)).not.toContain(CONNECT);
  });

  it("a person who may not start it costs no read of the company's choice, so the refusal takes the same steps whatever the AI state (M15, review L1)", async () => {
    const { w, cookies } = await setUp();
    await chooseMissing(w, cookies.ada);
    const read = vi.spyOn(w.companies, "agentAi");
    expect((await w.call(cookies.cal, "POST", P(), { requestId: RID })).status).toBe(403);
    expect((await w.call(cookies.bob, "POST", "/projects/payments/wiki-build", { requestId: RID })).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    // Positive control: the manager's start does read it.
    expect((await w.call(cookies.ada, "POST", P(), { requestId: RID })).status).toBe(503);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("when Code already says the AI is connected, Cloud does not refuse the start on its own reading (M12)", async () => {
    const { w, cookies, calls } = await setUp("connected");
    const answer = await w.call(cookies.ada, "POST", P(), { requestId: RID });
    expect(answer.status).toBe(200);
    expect(calls).toEqual(["GET start-or-state", "POST start-or-state"]);
  });

  it("stop, the agents switch and delete are not starts: they reach Code whatever the AI state (M8)", async () => {
    const { w, cookies, calls } = await setUp();
    await chooseMissing(w, cookies.ada);
    expect((await w.call(cookies.ada, "POST", P("/stop"), { requestId: RID })).status).toBe(200);
    expect((await w.call(cookies.ada, "POST", P("/agents"), { requestId: RID, on: true })).status).toBe(200);
    expect((await w.call(cookies.ada, "POST", P("/delete"), { requestId: RID })).status).toBe(200);
    expect(calls).toEqual(["POST stop", "POST agents", "POST delete"]);
  });

  it("when Cloud cannot tell, the start goes to Code as before", async () => {
    const { w, cookies, calls } = await setUp();
    vi.spyOn(w.companies, "agentAi").mockRejectedValue(new Error("table down"));
    const answer = await w.call(cookies.ada, "POST", P(), { requestId: RID });
    expect(answer.status).toBe(200);
    expect(calls).toEqual(["GET start-or-state", "POST start-or-state"]);
  });

  it("company B's missing AI does not stop company A's start, and A's connected AI does not start B's (two companies)", async () => {
    const { w, cookies, calls } = await setUp();
    await chooseRovara(w, cookies.ada);
    await chooseMissing(w, cookies.bea);
    expect((await w.call(cookies.ada, "POST", P(), { requestId: RID })).status).toBe(200);
    expect((await w.call(cookies.bea, "POST", P(), { requestId: RID })).status).toBe(503);
    expect(calls).toEqual(["GET start-or-state", "POST start-or-state", "GET start-or-state"]);
  });
});
