// DEC 254t (a), row A2 in Cloud: "AI for your agents" offers the company's own OpenAI and OpenRouter keys only where the install switched
// the kind on, and only once that provider's key is connected. The OpenAI key is the company's existing sealed OpenAI account; the
// OpenRouter key joins the same write-only learning document (company admins, audited, never answered), is connectable
// only where its kind is on, and never makes lessons usable. The gateway reads exactly what these routes save. Two companies never meet.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { A, B, ISS, world, write } from "./product-ai-world.js";

const AGENT = "/org/agent-ai";
const KEYS = "/org/learning-ai";
const openaiKey = () => ["sk", "proj", randomBytes(16).toString("hex")].join("-");
const routerKey = () => ["sk", "or", "v1", randomBytes(24).toString("hex")].join("-");
const both = new Set(["openai", "openrouter"]);

describe("own OpenAI / OpenRouter keys for agents (Cloud)", () => {
  it("listed only where the kind is switched on; choosable only once its key is connected; saved and audited", async () => {
    const w = world({ company: true, aiSourceKinds: both });
    const ada = await w.signIn("ada", 30);
    const before = await w.call(ada, "GET", AGENT);
    expect(before.body).toMatchObject({
      choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }, { source: "openai_key", available: false }, { source: "openrouter_key", available: false }],
      openaiKeyConnected: false, openrouterKeyConnected: false,
    });
    const early = await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source: "openai_key" });
    expect(early.status).toBe(400);
    expect(early.body.error?.message).toBe("Connect that provider's key first (Settings, AI keys), then choose it here.");
    const key = openaiKey();
    expect((await w.call(ada, "PUT", `${KEYS}/key`, write(0, { provider: "openai", key }))).status).toBe(200);
    const saved = await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source: "openai_key" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: "openai_key", version: 1, openaiKeyConnected: true });
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "openai_key", version: 1 });
    expect((await w.audit.read(A, { max: 50 })).rows.filter((r) => r.action === "agent_ai.source.changed").map((r) => r.subject)).toEqual(["agent_ai:openai_key"]);
    expect(saved.raw).not.toContain(key);
  });

  it("the served default leaves own-source eligibility unchanged when kinds are off", async () => {
    const today = world({ company: true });
    const on = world({ company: true, aiSourceKinds: new Set(["anthropic", "bedrock"]) });
    for (const w of [today, on]) {
      const ada = await w.signIn("ada", 30);
      const read = await w.call(ada, "GET", AGENT);
      expect(read.body).toEqual({ source: null, version: 0, effectiveSource: "rovara", sourceIsDefault: true, canChange: true, anthropicKeyConnected: false, bedrockConnected: null, openrouterKeyConnected: false, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }, { source: "openrouter_key", available: false }] });
      await w.call(ada, "PUT", `${KEYS}/key`, write(0, { provider: "openai", key: openaiKey() }));
      for (const source of ["openai_key", "openrouter_key"]) {
        const refused = await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source });
        expect(refused.status).toBe(400);
        expect(refused.body.error?.message).toBe("This AI source isn't switched on for this Cloud yet.");
      }
      expect(await w.companies.agentAi(A)).toBeUndefined();
    }
  });

  it("an OpenRouter credential can connect at launch; choosing it still requires agent eligibility, and it stays write-only and audited", async () => {
    const off = world({ company: true });
    const adaOff = await off.signIn("ada", 30);
    expect((await off.call(adaOff, "GET", KEYS)).body.accounts).toHaveProperty("openrouter", { connected: false });
    const refused = await off.call(adaOff, "PUT", `${KEYS}/key`, write(0, { provider: "openrouter", key: routerKey() }));
    expect(refused.status).toBe(200);
    expect((await off.call(adaOff, "PUT", AGENT, { expectedVersion: 0, source: "openrouter_key" })).status).toBe(400);
    expect((await off.store.view(ISS, A, "_learning")).sources).toHaveLength(1);

    const w = world({ company: true, aiSourceKinds: new Set(["openrouter"]) });
    const ada = await w.signIn("ada", 30);
    const key = routerKey();
    const put = await w.call(ada, "PUT", `${KEYS}/key`, write(0, { provider: "openrouter", key }));
    expect(put.status).toBe(200);
    expect(put.raw).not.toContain(key);
    // OpenRouter is the agents' only: it never makes lessons usable.
    expect(put.body).toMatchObject({ accounts: { openrouter: { connected: true }, anthropic: { connected: false } }, pausedNow: expect.arrayContaining(["no_provider"]) as unknown });
    const keys = storedLearningKeys(w.store);
    expect(await keys.keyFor(ISS, A, "openrouter")).toBe(key);
    expect(await keys.connected(ISS, A, "openrouter")).toBe(true);
    const saved = await w.store.learningSource(ISS, A, "openrouter");
    const bound = await keys.resolveForCharge!(ISS, A, "openrouter");
    expect(bound?.source).toMatchObject({ id: saved?.sourceId, connectionRevision: saved?.versionId, provider: "openrouter" });
    expect(await bound?.key()).toBe(key);
    expect(await keys.keyFor(ISS, B, "openrouter")).toBeUndefined();
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => [r.action, r.subject])).toEqual(expect.arrayContaining([["learning_ai.key.connected", "learning_ai:openrouter"]]));
    for (const text of [JSON.stringify(await w.audit.read(A, { max: 50 })), ...w.logs]) expect(text).not.toContain(key);
    const chosen = await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source: "openrouter_key" });
    expect(chosen.status).toBe(200);
    // Removed: no longer choosable.
    expect((await w.call(ada, "DELETE", `${KEYS}/key`, write(1, { provider: "openrouter" }))).status).toBe(200);
    expect(await keys.keyFor(ISS, A, "openrouter")).toBeUndefined();
    expect(await bound?.key()).toBeUndefined();
    expect((await w.call(ada, "GET", AGENT)).body).toMatchObject({ openrouterKeyConnected: false });
  });

  it("REVIEW-1 L3: once the openrouter kind is switched off, a stored OpenRouter key is still shown and can still be removed (never gated)", async () => {
    const kinds = new Set(["openrouter"]);
    const w = world({ company: true, aiSourceKinds: kinds });
    const ada = await w.signIn("ada", 30);
    const key = routerKey();
    expect((await w.call(ada, "PUT", `${KEYS}/key`, write(0, { provider: "openrouter", key }))).status).toBe(200);
    kinds.delete("openrouter");
    expect((await w.call(ada, "GET", KEYS)).body).toMatchObject({ accounts: { openrouter: { connected: true } } });
    // Round A launch keeps credential replacement available; agent source selection remains separately gated.
    expect((await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source: "openrouter_key" })).status).toBe(400);
    // ...removing never is.
    const removed = await w.call(ada, "DELETE", `${KEYS}/key`, write(1, { provider: "openrouter" }));
    expect(removed.status).toBe(200);
    expect(removed.raw).not.toContain(key);
    expect(await storedLearningKeys(w.store).keyFor(ISS, A, "openrouter")).toBeUndefined();
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => [r.action, r.subject])).toEqual(expect.arrayContaining([["learning_ai.key.removed", "learning_ai:openrouter"]]));
    // Launch lists the disconnected credential even before the first connection.
    const fresh = world({ company: true });
    expect((await fresh.call(await fresh.signIn("ada", 30), "GET", KEYS)).body.accounts).toHaveProperty("openrouter", { connected: false });
  });

  it("two companies: one company's key never makes another's source choosable", async () => {
    const w = world({ company: true, aiSourceKinds: both });
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    expect((await w.call(ada, "PUT", `${KEYS}/key`, write(0, { provider: "openai", key: openaiKey() }))).status).toBe(200);
    expect((await w.call(ada, "PUT", AGENT, { expectedVersion: 0, source: "openai_key" })).status).toBe(200);
    expect((await w.call(bea, "GET", AGENT)).body).toMatchObject({ source: null, openaiKeyConnected: false });
    expect((await w.call(bea, "PUT", AGENT, { expectedVersion: 0, source: "openai_key" })).status).toBe(400);
    expect(await w.companies.agentAi(B)).toBeUndefined();
  });

  it("non-admins can neither read nor change it, with or without a step-up; an admin needs none (owner DEC 254zzz73)", async () => {
    const w = world({ company: true, aiSourceKinds: both });
    for (const age of [30, undefined]) expect((await w.call(await w.signIn("pam", age), "PUT", `${KEYS}/key`, write(0, { provider: "openrouter", key: routerKey() }))).status).toBe(403);
    expect((await w.store.view(ISS, A, "_learning")).sources).toEqual([]);
    // Past the role check with an old step-up: a malformed write is the 400, never a step-up answer.
    expect((await w.call(await w.signIn("ada", 3600), "PUT", `${KEYS}/key`, { ...write(0, { provider: "openrouter", key: routerKey() }), extra: 1 })).status).toBe(400);
  });
});
