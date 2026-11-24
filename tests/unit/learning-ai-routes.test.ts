// PRODUCT-LEARNING-CONNECT-ROUTE: the company's "Learning AI key" (learning-ai-routes.ts). Company admins only (reads too), fresh
// step-up on every write, write-only key (never answered, logged or audited), audited, sealed in the company's learning document
// (never a project's, never linked), each provider's account apart, the learning cap and the lessons-paused reasons shown.
// The gateway reads exactly what these routes save (learning-keys.ts). Two companies never meet.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LEARNING_PAUSE_WORDS } from "../../packages/cloud-server/src/index.js";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { LEARNING_PAUSE_MESSAGES, LEARNING_PAUSE_REASONS } from "../../packages/model-gateway/src/learning-route.js";
import { LEARNING_OWNER } from "../../packages/model-gateway/src/product-keys.js";
import { A, B, ISS, world, write } from "./product-ai-world.js";
import { KEY_WHITESPACE_WORDS, wrongProviderKey } from "../../packages/cloud-server/src/learning-ai-routes.js";
import { KEY_WHITESPACE_WORDS as PAGE_WHITESPACE_WORDS, keyWhitespaceHint, wrongProviderKeyHint } from "../../packages/ui/src/api/admin-learning-ai.js";

const PATH = "/org/learning-ai";
const anthropicKey = () => ["sk", "ant", randomBytes(16).toString("hex")].join("-");
const openaiKey = () => ["sk", "proj", randomBytes(16).toString("hex")].join("-");

describe("Learning AI key: company admins, write-only, audited", () => {
  it("an admin connects Anthropic, then OpenAI; the gateway's learning source answers each path with its own key only", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    const empty = await w.call(ada, "GET", PATH);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ revision: 0, accounts: { anthropic: { connected: false }, openai: { connected: false }, gemini: { connected: false } }, pausedNow: ["no_provider"] });
    const ant = anthropicKey(); const oai = openaiKey();
    const one = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "anthropic", key: ant }));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ revision: 1, accounts: { anthropic: { connected: true }, openai: { connected: false } }, pausedNow: [] });
    expect(one.raw).not.toContain(ant);
    const two = await w.call(ada, "PUT", `${PATH}/key`, write(1, { provider: "openai", key: oai }));
    expect(two.status).toBe(200);
    const keys = storedLearningKeys(w.store);
    expect(await keys.keyFor(ISS, A, "anthropic")).toBe(ant);
    expect(await keys.keyFor(ISS, A, "openai")).toBe(oai);
    expect(await keys.keyFor(ISS, A, "gemini")).toBeUndefined();
    // Replacing rotates the same provider's account; removing stops it at once.
    const ant2 = anthropicKey();
    expect((await w.call(ada, "PUT", `${PATH}/key`, write(2, { provider: "anthropic", key: ant2 }))).status).toBe(200);
    expect(await keys.keyFor(ISS, A, "anthropic")).toBe(ant2);
    const removed = await w.call(ada, "DELETE", `${PATH}/key`, write(3, { provider: "anthropic" }));
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ accounts: { anthropic: { connected: false }, openai: { connected: true } }, removed: [{ provider: "anthropic", recoverUntil: expect.any(Number) as unknown }] });
    expect(await keys.keyFor(ISS, A, "anthropic")).toBeUndefined();
    // Audited (never the key), and never in a log.
    const records = (await w.audit.read(A, { max: 50 })).rows.map((r) => [r.action, r.subject]);
    expect(records).toEqual(expect.arrayContaining([["learning_ai.key.connected", "learning_ai:anthropic"], ["learning_ai.key.connected", "learning_ai:openai"], ["learning_ai.key.rotated", "learning_ai:anthropic"], ["learning_ai.key.removed", "learning_ai:anthropic"]]));
    for (const text of [JSON.stringify(await w.audit.read(A, { max: 50 })), ...w.logs]) for (const key of [ant, ant2, oai]) expect(text).not.toContain(key);
  });

  it("never a project's key: the learning account sits in the learning document, not linkable, not a product source", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "gemini", key: ["AI", "za"].join("") + randomBytes(24).toString("base64url").slice(0, 35) }));
    expect((await w.store.view(ISS, A, LEARNING_OWNER)).sources.map((s) => s.provider)).toEqual(["gemini"]);
    expect(await w.store.choices(ISS, A)).toEqual([]);
    expect(await w.store.resolve(ISS, A, "web", "gemini")).toBeUndefined();
  });

  it("refuses anyone but a company admin (reads too), with or without a step-up; an admin needs none (owner DEC 254zzz73)", async () => {
    const w = world();
    for (const who of ["pam", "cal"]) {
      for (const age of [30, undefined]) {
        const cookie = await w.signIn(who, age);
        expect((await w.call(cookie, "GET", PATH)).status).toBe(403);
        expect((await w.call(cookie, "PUT", `${PATH}/key`, write(0, { provider: "anthropic", key: anthropicKey() }))).status).toBe(403);
        expect((await w.call(cookie, "DELETE", `${PATH}/key`, write(0, { provider: "anthropic" }))).status).toBe(403);
      }
    }
    for (const age of [undefined, 3600]) {
      // Past the role check with no fresh step-up: a malformed write is the store's own refusal (400), never a step-up answer.
      const r = await w.call(await w.signIn("ada", age), "PUT", `${PATH}/key`, { ...write(0, { provider: "anthropic", key: anthropicKey() }), extra: 1 });
      expect([r.status, r.body.error?.code]).toEqual([400, "CONFIG_INVALID"]);
    }
    expect((await w.store.view(ISS, A, LEARNING_OWNER)).revision).toBe(0);
    // The CSRF token is still required.
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "anthropic", key: anthropicKey() }), "wrong")).status).toBe(403);
  });

  it("refuses a body that does not read, in fixed words that never echo it", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    for (const body of [write(0, { provider: "vertex", key: anthropicKey() }), write(0, { provider: "mistral<b>", key: anthropicKey() }), write(0, { provider: "anthropic", key: "short" }), write(0, { provider: "anthropic", key: "has space inside" }), write(0, { provider: "anthropic" }), write(0, { provider: "anthropic", key: anthropicKey(), more: 1 }), { provider: "anthropic", key: anthropicKey() }]) {
      const r = await w.call(ada, "PUT", `${PATH}/key`, body);
      expect(r.status).toBe(400);
      expect(r.raw).not.toContain("mistral");
      expect(r.raw).not.toContain("space inside");
    }
    expect((await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "anthropic", key: "x".repeat(5000) }))).status).toBe(413);
    expect((await w.call(ada, "PUT", `${PATH}/key`, write(7, { provider: "anthropic", key: anthropicKey() }))).status).toBe(409);
  });

  it("two companies: each admin sees and changes only their own company's learning key; the company comes from Code", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    const ant = anthropicKey();
    await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "anthropic", key: ant }));
    expect((await w.call(bea, "GET", PATH)).body).toMatchObject({ revision: 0, accounts: { anthropic: { connected: false } } });
    expect((await w.call(bea, "DELETE", `${PATH}/key`, write(0, { provider: "anthropic" }))).status).toBe(404);
    expect(await storedLearningKeys(w.store).keyFor(ISS, B, "anthropic")).toBeUndefined();
    expect(await storedLearningKeys(w.store).keyFor(ISS, A, "anthropic")).toBe(ant);
    expect((await w.audit.read(B, { max: 50 })).rows).toEqual([]);
  });
});

describe("Learning AI key: the learning cap and why lessons are paused", () => {
  it("shows the company's learning cap and lessons switch, and the reasons Cloud can see now", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    // Defaults: lessons off, no company monthly cap (no budget), no account.
    const first = await w.call(ada, "GET", PATH);
    expect(first.body).toMatchObject({ learningCap: { monthlyUsdMicros: 20_000_000, companyMonthlyUsdMicros: null }, lessonsOn: false, pausedNow: ["lessons_off", "no_provider", "no_budget"] });
    await w.setCompanySettings(A, (s) => { s.featureGates["lessons"] = true; s.budgets.companyMonthlyUsdMicros = 500_000_000; s.budgets.learningMonthlyUsdMicros = 5_000_000; });
    await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openai", key: openaiKey() }));
    const on = await w.call(ada, "GET", PATH);
    expect(on.body).toMatchObject({ learningCap: { monthlyUsdMicros: 5_000_000, companyMonthlyUsdMicros: 500_000_000 }, lessonsOn: true, pausedNow: [] });
    // A refused account no longer counts as usable.
    await storedLearningKeys(w.store).refused?.(ISS, A, "openai");
    const refused = await w.call(ada, "GET", PATH);
    expect(refused.body).toMatchObject({ accounts: { openai: { connected: true, refusedAt: expect.any(Number) as unknown } }, pausedNow: ["no_provider"] });
    // Every reason the gateway can pause lessons for, in its words.
    expect((refused.body.pauseReasons as Array<{ reason: string }>).map((r) => r.reason)).toEqual([...LEARNING_PAUSE_REASONS]);
  });

  it("Cloud's pause words are the gateway's", () => {
    expect(LEARNING_PAUSE_WORDS).toEqual(LEARNING_PAUSE_MESSAGES);
  });
});

describe("Learning AI key: a key PUT is observable, and a wrong-provider key is refused before anything is saved", () => {
  it("a connect and a replace each answer a revision above the one sent, and a later read reports that same revision", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    let seen = (await w.call(ada, "GET", PATH)).body.revision as number;
    for (const provider of ["openai", "openai", "anthropic"] as const) {
      const put = await w.call(ada, "PUT", `${PATH}/key`, write(seen, { provider, key: provider === "openai" ? openaiKey() : anthropicKey() }));
      expect(put.status).toBe(200);
      expect(put.body.revision as number).toBeGreaterThan(seen);
      const read = await w.call(ada, "GET", PATH);
      expect(read.body.revision).toBe(put.body.revision);
      seen = read.body.revision as number;
    }
  });

  it("a key the provider check could not test saves nothing and leaves the revision where it was (the case a held page must be able to release)", async () => {
    const w = world({ openaiCheck: async () => "unavailable" });
    const ada = await w.signIn("ada", 30);
    const put = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openai", key: openaiKey() }));
    expect(put.status).toBe(503);
    const read = await w.call(ada, "GET", PATH);
    expect(read.body).toMatchObject({ revision: 0, accounts: { openai: { connected: false } } });
  });

  it.each([
    ["openai", "sk-or-", "This looks like an OpenRouter key. Paste it under OpenRouter."],
    ["gemini", "sk-ant-", "This looks like an Anthropic key. Paste it under Anthropic."],
    ["anthropic", "sk-or-", "This looks like an OpenRouter key. Paste it under OpenRouter."],
    ["openai", "sk-ant-", "This looks like an Anthropic key. Paste it under Anthropic."],
  ] as const)("a %s slot refuses a key that starts %s with a clean 400, saving and checking nothing", async (provider, prefix, words) => {
    let checked = 0;
    const w = world({ company: true, aiSourceKinds: new Set(["openrouter"]), openaiCheck: async () => { checked += 1; return "ok"; } });
    const ada = await w.signIn("ada", 30);
    const put = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider, key: `${prefix}${"x".repeat(40)}` }));
    expect(put.status).toBe(400);
    expect(put.body.error).toEqual({ code: "CONFIG_INVALID", message: words });
    expect(checked).toBe(0);
    expect((await w.call(ada, "GET", PATH)).body.revision).toBe(0);
    expect(wrongProviderKeyHint(provider, `${prefix}${"x".repeat(40)}`)).toBe(words);
  });

  it("an OpenAI-looking key in the OpenRouter slot is refused, while each provider's own shape is accepted", async () => {
    const w = world({ company: true, aiSourceKinds: new Set(["openrouter"]) });
    const ada = await w.signIn("ada", 30);
    const refused = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openrouter", key: "sk-" + "proj-" + "x".repeat(40) }));
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toBe("This looks like an OpenAI key. Paste it under OpenAI.");
    const accepted = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openrouter", key: "sk-" + "or-" + "x".repeat(40) }));
    expect(accepted.status).toBe(200);
  });

  it("where the OpenRouter slot is switched off, an OpenRouter key is named but nobody is told to paste it there", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    const put = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openai", key: "sk-" + "or-" + "x".repeat(40) }));
    expect(put.status).toBe(400);
    expect(put.body.error?.message).toBe("This looks like an OpenRouter key.");
    expect(wrongProviderKeyHint("openai", "sk-" + "or-" + "x".repeat(40), ["anthropic", "openai", "gemini"])).toBe("This looks like an OpenRouter key.");
  });

  it.each([
    ["a console command", () => `export OPENAI_API_KEY=${openaiKey()}`],
    ["a line break inside", () => `${openaiKey()}\n${openaiKey()}`],
    ["a trailing line break (never trimmed or saved by the server)", () => `${openaiKey()}\n`],
    ["a tab", () => `sk-proj-\t${"x".repeat(30)}`],
  ] as const)("a key with %s is refused with the whitespace words and nothing saved", async (_name, make) => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    const put = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openai", key: make() }));
    expect(put.status).toBe(400);
    expect(put.body.error).toEqual({ code: "CONFIG_INVALID", message: "A key can't contain spaces or line breaks. Copy just the key." });
    expect(KEY_WHITESPACE_WORDS).toBe(PAGE_WHITESPACE_WORDS);
    expect((await w.call(ada, "GET", PATH)).body.revision).toBe(0);
    // The page trims the ends before sending, so only whitespace inside the trimmed value is hinted there.
    expect(keyWhitespaceHint(make())).toBe(_name.startsWith("a trailing") ? undefined : KEY_WHITESPACE_WORDS);
  });

  it("an OpenRouter key saved on the company AI keys page is the key the agent route reads (one company key store), and never makes lessons usable", async () => {
    const w = world({ company: true, aiSourceKinds: new Set(["openrouter"]) });
    const ada = await w.signIn("ada", 30);
    const key = "sk-" + "or-" + randomBytes(24).toString("hex");
    const before = await w.call(ada, "GET", "/org/agent-ai");
    expect(before.body.openrouterKeyConnected).toBe(false);
    expect((before.body.choices as Array<{ source: string; available: boolean }>).find((c) => c.source === "openrouter_key")?.available).toBe(false);
    const put = await w.call(ada, "PUT", `${PATH}/key`, write(0, { provider: "openrouter", key }));
    expect(put.status).toBe(200);
    // The gateway's agent route (company-key mode) resolves the agents' key through storedLearningKeys on this same store.
    const agents = storedLearningKeys(w.store);
    expect(await agents.keyFor(ISS, A, "openrouter")).toBe(key);
    expect(await agents.connected(ISS, A, "openrouter")).toBe(true);
    // The agents' source screen sees it too: connected, and choosable.
    const after = await w.call(ada, "GET", "/org/agent-ai");
    expect(after.body.openrouterKeyConnected).toBe(true);
    expect((after.body.choices as Array<{ source: string; available: boolean }>).find((c) => c.source === "openrouter_key")?.available).toBe(true);
    // Lessons do not use it.
    expect(put.body).toMatchObject({ accounts: { openrouter: { connected: true } }, pausedNow: expect.arrayContaining(["no_provider"]) as unknown });
  });

  it("the page's hint and the server's refusal agree on every provider and prefix", () => {
    for (const provider of ["anthropic", "openai", "gemini", "openrouter"] as const) {
      for (const prefix of ["sk-or-", "sk-ant-", "sk-proj-", "AIza", "other"]) {
        const key = `${prefix}${"x".repeat(40)}`;
        const server = wrongProviderKey(provider, key);
        expect(wrongProviderKeyHint(provider, key)).toBe(server === undefined ? undefined : (server.body as { error: { message: string } }).error.message);
      }
    }
  });
});
