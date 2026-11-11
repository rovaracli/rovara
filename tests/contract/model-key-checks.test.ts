// Plan 3 Task 26: the checks around a scoped key at the model proxy (the spike's `validate_mint`, `verify_minted` and the `/key/list` audit,
// docs/learnings/model-sources-spike.md question 2c). LiteLLM honours a key whose `models` is `[]`, `*`, `all-proxy-models` or an access group by reaching
// every model of its team, so the mint is refused unless the team is scoped, the key read back is exactly what was asked for, and a periodic audit blocks
// any key that has drifted. The fake keeps keys and teams the way the real one does, and can be told to store a key differently from the request.
import { createHash } from "node:crypto";
import { INFERENCE_PATHS, type AgentXError } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { AUDIT_MAX_PAGES, ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler } from "../../packages/broker/src/model-proxy/handler.js";
import { ModelAccessInvoker } from "../../packages/broker/src/model-proxy/invoker.js";

const BASE = "http://proxy.internal:4001";
const MASTER = "sk-master-planted-value";
const ORG = "org_abcdefghij0123456789";
const OTHER_ORG = "org_zzzzzzzzzz9876543210";
const SRC = "src_abcdefghij0123456789";
const CATALOG = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];
const OWN = `${ORG}.${SRC}.claude-sonnet-4-6`;
const ROUTES = INFERENCE_PATHS.map((entry) => entry.path);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface StoredKey { key: string; token: string; models: string[]; team_id?: string | undefined; allowed_routes: string[] | undefined; aliases: Record<string, string>; metadata: Record<string, unknown>; blocked?: boolean; expires?: string; deleted?: boolean }
interface Seen { method: string; path: string; search: string; body: Record<string, unknown> | undefined }

/** A stateful fake of the LiteLLM routes the mint checks use. `store` lets a test make LiteLLM keep something other than what was asked. */
function litellm(options: { teams?: Record<string, string[] | undefined>; /** The proxy's /model/info entries. */ modelList?: Array<Record<string, unknown>>; store?: (body: Record<string, unknown>) => Partial<StoredKey>; pageSize?: number; failOn?: (seen: Seen) => Response | undefined } = {}) {
  const teams = new Map<string, string[] | undefined>(Object.entries(options.teams ?? { [ORG]: [OWN, ...CATALOG] }));
  const keys: StoredKey[] = [];
  const seen: Seen[] = [];
  let counter = 0;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const entry: Seen = { method: init?.method ?? "GET", path: url.pathname, search: url.search, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
    seen.push(entry);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${MASTER}`) return json({ error: "unauthorized" }, 401);
    const failure = options.failOn?.(entry);
    if (failure !== undefined) return failure;
    const params = new URLSearchParams(url.search);
    if (entry.method === "GET" && entry.path === "/team/info") {
      const id = params.get("team_id") ?? "";
      return teams.has(id) ? json({ team_id: id, team_info: { team_id: id, models: teams.get(id), max_budget: 500, spend: 0 } }) : json({ error: { message: "team not found" } }, 404);
    }
    if (entry.method === "GET" && entry.path === "/model/info") return json({ data: options.modelList ?? [] });
    if (entry.method === "POST" && entry.path === "/team/update") {
      const id = String(entry.body!.team_id);
      if (!teams.has(id)) return json({ error: { message: "team not found" } }, 404);
      // LiteLLM changes only the fields it is sent: the budget and its reset stay as they were.
      if (Array.isArray(entry.body!.models)) teams.set(id, entry.body!.models as string[]);
      return json({ team_id: id });
    }
    if (entry.method === "POST" && entry.path === "/key/generate") {
      counter += 1;
      const body = entry.body!;
      const key = `sk-virtual-${String(counter)}`;
      keys.push({ key, token: sha(key), models: body.models as string[], team_id: body.team_id as string, allowed_routes: body.allowed_routes as string[], aliases: {}, metadata: body.metadata as Record<string, unknown>, ...options.store?.(body) });
      return json({ key, token: sha(key) });
    }
    if (entry.method === "GET" && entry.path === "/key/info") {
      const found = keys.find((candidate) => candidate.token === params.get("key") && candidate.deleted !== true);
      return found === undefined ? json({ error: { message: "key not found" } }, 404) : json({ key: found.token, info: { ...found, key: undefined, spend: 0 } });
    }
    if (entry.method === "GET" && entry.path === "/key/list") {
      const size = options.pageSize ?? Number(params.get("size") ?? 100);
      const page = Number(params.get("page") ?? 1);
      // Newest first when asked: the fake keeps keys in the order they were made, oldest first.
      const live = keys.filter((candidate) => candidate.deleted !== true);
      if (params.get("sort_by") === "created_at" && params.get("sort_order") === "desc") live.reverse();
      return json({ keys: live.slice((page - 1) * size, page * size).map((found) => ({ ...found, key: undefined })), total_count: live.length, current_page: page, total_pages: Math.max(1, Math.ceil(live.length / size)) });
    }
    if (entry.method === "POST" && entry.path === "/key/block") {
      const found = keys.find((candidate) => candidate.token === entry.body!.key);
      if (found === undefined) return json({ error: { message: "key not found" } }, 404);
      found.blocked = true;
      return json({ blocked: true });
    }
    if (entry.method === "POST" && entry.path === "/key/delete") {
      for (const key of keys) if ((entry.body!.keys as string[]).includes(key.key)) key.deleted = true;
      return json({ deleted_keys: entry.body!.keys });
    }
    return json({ error: { message: `unexpected ${entry.method} ${entry.path}` } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFake, teams, keys, seen, calls: () => seen.map((entry) => `${entry.method} ${entry.path}`) };
}

const client = (proxy: ReturnType<typeof litellm>, extra: Partial<ConstructorParameters<typeof ModelProxyClient>[0]> = {}) =>
  new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch: proxy.fetch, now: () => 1_800_000_000_000, catalog: CATALOG, ...extra });
const mint = (models: string[] = [OWN], extra: Partial<Parameters<ModelAccess["mintKey"]>[0]> = {}) => ({ orgId: ORG as typeof ORG, purpose: "task" as const, refId: "task-1", maxBudgetUsd: 2.5, ttlSeconds: 3600, models, ...extra });
const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as AgentXError; }
  throw new Error("expected a rejection");
};

describe("validate_mint: the team must be scoped before a scoped key is minted for it", () => {
  it("reads the team first and mints only when its models are the org's own aliases and catalog ids", async () => {
    const proxy = litellm();
    const minted = await client(proxy).mintKey(mint());
    expect(minted.key).toBe("sk-virtual-1");
    expect(proxy.calls()).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info"]);
    expect(proxy.seen[0]!.search).toBe(`?team_id=${ORG}`);
  });

  it("refuses an unscoped team: empty models (which means every model), a wildcard, an access group, a foreign alias or an unknown id", async () => {
    const teams: Array<[string, string[] | undefined]> = [
      ["a bare wildcard", ["*"]],
      ["all-proxy-models", ["all-proxy-models"]],
      ["a wildcard beside valid models", [OWN, "*"]],
      ["a provider wildcard", [OWN, "openai/*"]],
      ["an access group", [OWN, "team-shared-models"]],
      ["another org's alias", [OWN, `${OTHER_ORG}.${SRC}.claude-sonnet-4-6`]],
    ];
    for (const [what, models] of teams) {
      const proxy = litellm({ teams: { [ORG]: models } });
      const refused = await failure(client(proxy).mintKey(mint()));
      expect(refused.code, what).toBe("CONFIG_INVALID");
      expect(proxy.calls(), what).toEqual(["GET /team/info"]);
    }
  });

  it("refuses when the team is unknown or unreadable, minting nothing", async () => {
    const unknown = litellm({ teams: {} });
    expect((await failure(client(unknown).mintKey(mint()))).code).toBe("NOT_FOUND");
    expect(unknown.calls()).toEqual(["GET /team/info"]);
    const down = litellm({ failOn: (seen) => (seen.path === "/team/info" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(down).mintKey(mint()))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(down.calls()).toEqual(["GET /team/info"]);
  });

  it("checks the team for a key minted without models too, and reads no key back: the key answers to the team's models, so the team must be scoped", async () => {
    const proxy = litellm();
    await client(proxy).mintKey(mint([], { models: undefined }));
    expect(proxy.calls()).toEqual(["GET /team/info", "POST /key/generate"]);
    expect(proxy.seen[1]!.body!.models).toBeUndefined();
  });

  it("refuses a key minted without models for a team that is not the org's own, before any key exists", async () => {
    for (const models of [["*"], [OWN, `${OTHER_ORG}.${SRC}.claude-sonnet-4-6`], ["all-proxy-models"]]) {
      const proxy = litellm({ teams: { [ORG]: models } });
      expect((await failure(client(proxy).mintKey(mint([], { models: undefined })))).code).toBe("CONFIG_INVALID");
      expect(proxy.calls()).toEqual(["GET /team/info"]);
    }
  });
});

const deployment = (name: string, org: string | undefined, extra: Record<string, unknown> = {}) => ({
  model_name: name,
  model_info: { id: `id-${name}`, ...(org === undefined ? {} : { rovara_org: org }), ...extra },
  litellm_params: {},
});

describe("a team left unscoped by an earlier deploy heals at the mint, to exactly the org's allowed models", () => {
  const SERVED = `${ORG}.${SRC}.claude-sonnet-4-6`;
  const REVOKED = `${ORG}.src_revoked00000000000000.claude-sonnet-4-6`;
  const UNTESTED = `${ORG}.src_bedrock0000000000000.claude-sonnet-4-6`;
  const FOREIGN = `${OTHER_ORG}.${SRC}.claude-sonnet-4-6`;
  // The proxy holds the org's served alias, a Bedrock alias that has not passed its probe, another org's alias and a model of nobody's.
  // The revoked source's alias is gone from the proxy: removing a source deletes its models.
  const modelList = [
    deployment(SERVED, ORG),
    deployment(UNTESTED, ORG, { rovara_role_arn: "arn:aws:iam::123456789012:role/x", rovara_tested: false }),
    deployment(FOREIGN, OTHER_ORG),
    deployment("us.anthropic.claude-opus-9", undefined),
  ];

  for (const [what, models] of [["an empty models list", [] as string[]], ["no models field at all", undefined]] as const) {
    it(`mints for a team with ${what}, after limiting the team to the org's served aliases and the catalog`, async () => {
      const proxy = litellm({ teams: { [ORG]: models }, modelList });
      const minted = await client(proxy).mintKey(mint([SERVED]));
      expect(minted.key).toBe("sk-virtual-1");
      expect(proxy.calls()).toEqual(["GET /team/info", "GET /model/info", "POST /team/update", "GET /team/info", "POST /key/generate", "GET /key/info"]);
      const update = proxy.seen.find((entry) => entry.path === "/team/update")!;
      // Only the model list is sent: the team's budget, its reset and its spend are left as they were.
      expect(Object.keys(update.body!).sort()).toEqual(["models", "team_id"]);
      expect(update.body!.team_id).toBe(ORG);
      expect([...(update.body!.models as string[])].sort()).toEqual([SERVED, ...CATALOG].sort());
      expect([...(proxy.teams.get(ORG) ?? [])].sort()).toEqual([SERVED, ...CATALOG].sort());
    });
  }

  it("never adds a revoked alias, a Bedrock alias that failed its probe, another org's alias or a model nobody owns", async () => {
    const proxy = litellm({ teams: { [ORG]: [] }, modelList });
    await client(proxy).mintKey(mint([SERVED]));
    const team = proxy.teams.get(ORG)!;
    for (const forbidden of [REVOKED, UNTESTED, FOREIGN, "us.anthropic.claude-opus-9", "*"]) expect(team, forbidden).not.toContain(forbidden);
  });

  it("refuses a key that names a revoked alias or one that failed its probe, and does not add it to the team", async () => {
    for (const asked of [REVOKED, UNTESTED]) {
      const proxy = litellm({ teams: { [ORG]: [] }, modelList });
      const refused = await failure(client(proxy).mintKey(mint([SERVED, asked])));
      expect(refused.code, asked).toBe("CONFIG_INVALID");
      expect(proxy.calls(), asked).toEqual(["GET /team/info", "GET /model/info"]);
      expect(proxy.teams.get(ORG), asked).toEqual([]);
    }
  });

  it("refuses a key that names another org's alias before reading anything", async () => {
    const proxy = litellm({ teams: { [ORG]: [] }, modelList });
    expect((await failure(client(proxy).mintKey(mint([SERVED, FOREIGN])))).code).toBe("CONFIG_INVALID");
    expect(proxy.calls()).toEqual([]);
  });

  it("fails closed when the allowed models cannot be read: the team is not touched and no key is minted", async () => {
    const proxy = litellm({ teams: { [ORG]: [] }, modelList, failOn: (seen) => (seen.path === "/model/info" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(proxy).mintKey(mint([SERVED])))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(proxy.calls()).toEqual(["GET /team/info", "GET /model/info"]);
    expect(proxy.teams.get(ORG)).toEqual([]);
  });

  it("fails closed when the team update is refused, and when the team still reads as unscoped afterwards", async () => {
    const refused = litellm({ teams: { [ORG]: [] }, modelList, failOn: (seen) => (seen.path === "/team/update" ? json({ error: { message: "no" } }, 400) : undefined) });
    expect((await failure(client(refused).mintKey(mint([SERVED])))).code).toBe("CONFIG_INVALID");
    expect(refused.calls()).toEqual(["GET /team/info", "GET /model/info", "POST /team/update"]);
    // An update the proxy accepts but does not keep: the second read still shows no models.
    const ignored = litellm({ teams: { [ORG]: [] }, modelList, failOn: (seen) => (seen.path === "/team/update" ? json({ team_id: ORG }) : undefined) });
    expect((await failure(client(ignored).mintKey(mint([SERVED])))).code).toBe("CONFIG_INVALID");
    expect(ignored.calls()).toEqual(["GET /team/info", "GET /model/info", "POST /team/update", "GET /team/info"]);
  });

  it("does not touch a team that is already scoped: no model listing, no update", async () => {
    const proxy = litellm({ modelList });
    await client(proxy).mintKey(mint([SERVED]));
    expect(proxy.calls()).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info"]);
  });

  it("needs the catalog, since a team is never written without it", async () => {
    const proxy = litellm({ teams: { [ORG]: [] }, modelList });
    expect((await failure(client(proxy, { catalog: [] }).mintKey(mint([SERVED])))).code).toBe("CONFIG_INVALID");
    expect(proxy.calls()).toEqual([]);
  });
});

describe("an unscoped mint is never left to an empty or unreadable team (a team with no models means every model of every org)", () => {
  const UNSCOPED = mint([], { models: undefined });
  const modelList = [deployment(OWN, ORG), deployment(`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`, OTHER_ORG)];

  it("refuses before the heal and mints after it, and the key still names no other org's alias", async () => {
    // Before: the proxy cannot say what the org may use, so the empty team stays as it is and no key exists.
    const before = litellm({ teams: { [ORG]: [] }, modelList, failOn: (seen) => (seen.path === "/model/info" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(before).mintKey(UNSCOPED))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(before.calls()).toEqual(["GET /team/info", "GET /model/info"]);
    expect(before.keys).toEqual([]);
    // After: the team is limited to the org's allowed models, then the key is made, without a model list of its own.
    const after = litellm({ teams: { [ORG]: [] }, modelList });
    await client(after).mintKey(UNSCOPED);
    expect(after.calls()).toEqual(["GET /team/info", "GET /model/info", "POST /team/update", "GET /team/info", "POST /key/generate"]);
    expect([...after.teams.get(ORG)!].sort()).toEqual([OWN, ...CATALOG].sort());
    expect(after.teams.get(ORG)).not.toContain(`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`);
  });

  it("refuses another org's alias asked for by name, with or without an empty team, minting nothing", async () => {
    for (const teams of [{ [ORG]: [] as string[] }, undefined]) {
      const proxy = litellm({ ...(teams === undefined ? {} : { teams }), modelList });
      expect((await failure(client(proxy).mintKey(mint([`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`])))).code).toBe("CONFIG_INVALID");
      expect(proxy.keys).toEqual([]);
    }
  });
});

describe("a stale team list is limited again to exactly the allowed models, but a list that is not Rovara's is refused and logged", () => {
  const RETIRED = "us.anthropic.claude-sonnet-4-20250514-v1:0";
  const modelList = [deployment(OWN, ORG)];

  it("replaces a retired catalog id (and keeps nothing else it did not hold), once", async () => {
    const proxy = litellm({ teams: { [ORG]: [OWN, RETIRED, ...CATALOG] }, modelList });
    await client(proxy).mintKey(mint([OWN]));
    expect(proxy.calls()).toEqual(["GET /team/info", "GET /model/info", "POST /team/update", "GET /team/info", "POST /key/generate", "GET /key/info"]);
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([OWN, ...CATALOG].sort());
    expect(Object.keys(proxy.seen.find((entry) => entry.path === "/team/update")!.body!).sort()).toEqual(["models", "team_id"]);
    // The next mint finds the team in line and does nothing more.
    const again = proxy.seen.length;
    await client(proxy).mintKey(mint([OWN]));
    expect(proxy.seen.slice(again).map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info"]);
  });

  it("adds a catalog id the team was written without", async () => {
    const proxy = litellm({ teams: { [ORG]: [OWN, CATALOG[0]!] }, modelList });
    await client(proxy).mintKey(mint([OWN]));
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([OWN, ...CATALOG].sort());
  });

  it("never widens past the allowed models: a retired alias the key asks for is refused and the team is left as it was", async () => {
    const retiredAlias = `${ORG}.src_retired00000000000000.claude-sonnet-4-6`;
    const proxy = litellm({ teams: { [ORG]: [OWN, RETIRED, ...CATALOG] }, modelList });
    expect((await failure(client(proxy).mintKey(mint([retiredAlias])))).code).toBe("CONFIG_INVALID");
    expect(proxy.calls()).toEqual(["GET /team/info", "GET /model/info"]);
    expect(proxy.teams.get(ORG)).toEqual([OWN, RETIRED, ...CATALOG]);
  });

  it("refuses and logs a list with a wildcard, another org's alias or an access group, and rewrites nothing", async () => {
    const cases: Array<[string, string[], string]> = [
      ["a wildcard", [OWN, "*", ...CATALOG], "wildcard"],
      ["a provider wildcard", [OWN, "openai/*"], "wildcard"],
      ["another org's alias", [OWN, `${OTHER_ORG}.${SRC}.claude-sonnet-4-6`], "foreign_alias"],
      ["an access group", [OWN, "team-shared-models"], "unknown_entry"],
      ["all-proxy-models", ["all-proxy-models"], "unknown_entry"],
    ];
    for (const [what, models, reason] of cases) {
      const log = vi.fn();
      const proxy = litellm({ teams: { [ORG]: models }, modelList });
      expect((await failure(client(proxy, { log }).mintKey(mint([OWN])))).code, what).toBe("CONFIG_INVALID");
      expect(proxy.calls(), what).toEqual(["GET /team/info"]);
      expect(log, what).toHaveBeenCalledWith({ event: "model_access.team_refused", orgId: ORG, reason });
    }
  });

  it("leaves the proxy's master key and the listed names out of the log", async () => {
    const log = vi.fn();
    await failure(client(litellm({ teams: { [ORG]: [OWN, "*"] } }), { log }).mintKey(mint([OWN])));
    expect(JSON.stringify(log.mock.calls)).not.toContain(MASTER);
    expect(JSON.stringify(log.mock.calls)).not.toContain(OWN);
  });
});

describe("verify_minted: the key LiteLLM stored is read back and must be what was asked for", () => {
  const drifts: Array<[string, Partial<StoredKey>]> = [
    ["models stored empty (reaches every model of the team)", { models: [] }],
    ["models widened to a wildcard", { models: ["*"] }],
    ["models widened to all-proxy-models", { models: ["all-proxy-models"] }],
    ["an extra model", { models: [OWN, CATALOG[0]!] }],
    ["a different model", { models: [CATALOG[0]!] }],
    ["an aliases map", { aliases: { friendly: CATALOG[0]! } }],
    ["another team", { team_id: OTHER_ORG }],
    ["no team", { team_id: undefined }],
    ["other allowed routes", { allowed_routes: ["llm_api_routes"] }],
  ];

  it.each(drifts)("revokes the key and refuses when LiteLLM stored %s, without echoing the key", async (_what, stored) => {
    const proxy = litellm({ store: () => stored });
    const refused = await failure(client(proxy).mintKey(mint()));
    expect(refused.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(refused.message).not.toContain("sk-virtual-1");
    expect(proxy.calls()).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info", "POST /key/delete"]);
    expect(proxy.seen.at(-1)!.body).toEqual({ keys: ["sk-virtual-1"] });
    expect(proxy.keys[0]!.deleted).toBe(true);
  });

  it("revokes the key when it cannot be read back, since it cannot be shown to match", async () => {
    const unreadable = litellm({ failOn: (seen) => (seen.path === "/key/info" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(unreadable).mintKey(mint()))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(unreadable.calls()).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info", "POST /key/delete"]);
    const noInfo = litellm({ failOn: (seen) => (seen.path === "/key/info" ? json({ nothing: true }) : undefined) });
    expect((await failure(client(noInfo).mintKey(mint()))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(noInfo.keys[0]!.deleted).toBe(true);
  });

  it("still refuses when the revoke itself fails, never returning the key", async () => {
    const proxy = litellm({ store: () => ({ models: ["*"] }), failOn: (seen) => (seen.path === "/key/delete" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(proxy).mintKey(mint()))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("accepts a key whose stored models are in another order", async () => {
    const proxy = litellm({ store: () => ({ models: [CATALOG[0]!, OWN] }) });
    await expect(client(proxy).mintKey(mint([OWN, CATALOG[0]!]))).resolves.toMatchObject({ key: "sk-virtual-1" });
  });

  // The Task 25 spike does not show whether /key/info echoes `allowed_routes` (it shows only that the route list is stored and enforced), so a key whose info
  // omits or nulls the list cannot be shown to be limited to the inference routes. Task 37 checks the real shape on staging.
  it.each([["omits the route list", undefined], ["nulls the route list", null]])("revokes and refuses a key whose info %s, since its routes cannot be shown", async (_what, routes) => {
    const proxy = litellm({ store: () => ({ allowed_routes: routes as never }) });
    expect((await failure(client(proxy).mintKey(mint()))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(proxy.calls()).toEqual(["GET /team/info", "POST /key/generate", "GET /key/info", "POST /key/delete"]);
    expect(proxy.keys[0]!.deleted).toBe(true);
  });
});

describe("the /key/list audit", () => {
  const scoped = (models: string[], extra: Partial<StoredKey> = {}): StoredKey => ({ key: `sk-${Math.random()}`, token: sha(`t-${Math.random()}`), models, team_id: ORG, allowed_routes: ROUTES, aliases: {}, metadata: {}, ...extra });

  it("checks every scoped key and blocks the ones that have drifted, by token id", async () => {
    const proxy = litellm();
    const good = scoped([OWN]);
    const bad = [
      scoped([]), scoped(["*"]), scoped(["all-proxy-models"]), scoped([OWN, "openai/*"]), scoped([`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`]), scoped(["us.anthropic.claude-opus-9"]),
      scoped([OWN], { aliases: { friendly: CATALOG[0]! } }), scoped([OWN], { team_id: undefined }), scoped([`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`], { team_id: OTHER_ORG, metadata: { orgId: ORG } }),
    ];
    proxy.keys.push(good, ...bad);
    const result = await client(proxy).auditKeys();
    expect(result).toEqual({ checked: 1 + bad.length, blocked: bad.length, truncated: false });
    expect(proxy.keys.filter((key) => key.blocked === true).map((key) => key.token).sort()).toEqual(bad.map((key) => key.token).sort());
    expect(good.blocked).toBeUndefined();
    expect(proxy.seen.filter((entry) => entry.path === "/key/block").every((entry) => /^[0-9a-f]{64}$/.test(String(entry.body!.key)))).toBe(true);
  });

  it("2026-11-03: Rovara pays for no key, so a key of the retired rovara-support team is blocked whatever it names (with or without an org label), and an org's own key is untouched", async () => {
    const proxy = litellm();
    const good = scoped([CATALOG[0]!], { team_id: ORG, metadata: { orgId: ORG } });
    const bad = [
      scoped([CATALOG[0]!], { team_id: "rovara-support", metadata: { orgId: ORG, rovaraPaid: true } }), scoped([CATALOG[0]!], { team_id: "rovara-support" }), scoped([OWN], { team_id: "rovara-support", metadata: { orgId: ORG } }),
    ];
    proxy.keys.push(good, ...bad);
    expect(await client(proxy).auditKeys()).toEqual({ checked: 1 + bad.length, blocked: bad.length, truncated: false });
    expect(good.blocked).toBeUndefined();
  });

  it("leaves legacy keys alone (the older llm_api_routes key has no models and is bounded by its scoped team), and keys that are blocked or expired", async () => {
    const proxy = litellm();
    proxy.keys.push(
      scoped([], { allowed_routes: ["llm_api_routes"] }),
      scoped(["*"], { blocked: true }),
      scoped(["*"], { expires: "2020-01-01T00:00:00Z" }),
      scoped([OWN]),
    );
    expect(await client(proxy).auditKeys()).toEqual({ checked: 1, blocked: 0, truncated: false });
  });

  it("reads every page, and stops at the last", async () => {
    const proxy = litellm({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1) proxy.keys.push(scoped([OWN]));
    proxy.keys[4]!.models = ["*"];
    expect(await client(proxy).auditKeys()).toEqual({ checked: 5, blocked: 1, truncated: false });
    expect(proxy.seen.filter((entry) => entry.path === "/key/list").map((entry) => new URLSearchParams(entry.search).get("page"))).toEqual(["1", "2", "3"]);
  });

  it("blocks a scoped key whose routes are missing or have widened, and leaves one with fewer routes alone", async () => {
    const proxy = litellm();
    const widened = [scoped([OWN], { allowed_routes: ["llm_api_routes"] }), scoped([OWN], { allowed_routes: [...ROUTES, "/model/info"] }), scoped([OWN], { allowed_routes: [] }), scoped([OWN], { allowed_routes: undefined })];
    const fewer = scoped([OWN], { allowed_routes: ["/v1/messages"] });
    proxy.keys.push(fewer, ...widened);
    expect(await client(proxy).auditKeys()).toEqual({ checked: 5, blocked: 4, truncated: false });
    expect(fewer.blocked).toBeUndefined();
  });

  it("asks for the newest keys first, so a proxy with many old keys still has its recent ones audited", async () => {
    const proxy = litellm();
    proxy.keys.push(scoped([OWN]));
    await client(proxy).auditKeys();
    const query = new URLSearchParams(proxy.seen.find((entry) => entry.path === "/key/list")!.search);
    expect([query.get("sort_by"), query.get("sort_order")]).toEqual(["created_at", "desc"]);
  });

  it("stops at the page limit, says it did, and has audited the newest keys", async () => {
    const proxy = litellm({ pageSize: 1 });
    const oldest = scoped(["*"]);
    proxy.keys.push(oldest);
    for (let index = 0; index < AUDIT_MAX_PAGES + 4; index += 1) proxy.keys.push(scoped([OWN]));
    const newest = scoped(["*"]);
    proxy.keys.push(newest);
    const result = await client(proxy).auditKeys();
    expect(result).toEqual({ checked: AUDIT_MAX_PAGES, blocked: 1, truncated: true });
    expect(proxy.seen.filter((entry) => entry.path === "/key/list")).toHaveLength(AUDIT_MAX_PAGES);
    // The newest drifted key is on the first page and is blocked; the oldest, past the limit, waits for a run that reaches it.
    expect(newest.blocked).toBe(true);
    expect(oldest.blocked).toBeUndefined();
  });

  it("stops at its time budget, says so, and does not stop short of a list it finished", async () => {
    let clock = 0;
    const proxy = litellm({ pageSize: 1, failOn: (seen) => { if (seen.path === "/key/list") clock += 1_000; return undefined; } });
    for (let index = 0; index < 10; index += 1) proxy.keys.push(scoped([OWN]));
    expect(await client(proxy, { now: () => clock }).auditKeys({ budgetMs: 2_500 })).toEqual({ checked: 3, blocked: 0, truncated: true });
    clock = 0;
    const small = litellm({ pageSize: 1, failOn: (seen) => { if (seen.path === "/key/list") clock += 1_000; return undefined; } });
    small.keys.push(scoped([OWN]), scoped([OWN]));
    expect(await client(small, { now: () => clock }).auditKeys({ budgetMs: 2_500 })).toEqual({ checked: 2, blocked: 0, truncated: false });
  });

  // Review re-check N1: keys have two lifetimes (a turn's 15 minutes, an operation's hour), so a page of newer, expired keys says nothing about older ones.
  it("reads past newer expired keys to the live, drifted key behind them, and blocks it", async () => {
    const proxy = litellm({ pageSize: 2 });
    const wildcard = scoped(["*"], { expires: "2030-01-01T00:00:00Z" });
    proxy.keys.push(wildcard, scoped([OWN], { expires: "2020-01-01T00:00:00Z" }), scoped([OWN], { expires: "2020-01-01T00:00:00Z" }));
    expect(await client(proxy).auditKeys()).toEqual({ checked: 1, blocked: 1, truncated: false });
    expect(wildcard.blocked).toBe(true);
    expect(proxy.seen.filter((entry) => entry.path === "/key/list")).toHaveLength(2);
  });

  it("says it was truncated whenever it stops before the last page, never reporting a clean audit it did not finish", async () => {
    const proxy = litellm({ pageSize: 1 });
    const behind = scoped(["*"]);
    proxy.keys.push(behind);
    for (let index = 0; index < AUDIT_MAX_PAGES; index += 1) proxy.keys.push(scoped([OWN], { expires: "2020-01-01T00:00:00Z" }));
    const result = await client(proxy).auditKeys();
    expect(result).toEqual({ checked: 0, blocked: 0, truncated: true });
    expect(behind.blocked).toBeUndefined();
  });

  it("checks its budget between blocks within a page, and says it stopped", async () => {
    let clock = 0;
    const proxy = litellm({ failOn: (seen) => { if (seen.path === "/key/block") clock += 1_000; return undefined; } });
    const drifted = Array.from({ length: 6 }, () => scoped(["*"]));
    proxy.keys.push(...drifted);
    expect(await client(proxy, { now: () => clock }).auditKeys({ budgetMs: 2_500 })).toEqual({ checked: 4, blocked: 3, truncated: true });
    expect(proxy.seen.filter((entry) => entry.path === "/key/block")).toHaveLength(3);
    // Stopping mid-page ends the audit there: the next page is not listed.
    clock = 0;
    const paged = litellm({ pageSize: 4, failOn: (seen) => { if (seen.path === "/key/block") clock += 1_000; return undefined; } });
    paged.keys.push(...Array.from({ length: 8 }, () => scoped(["*"])));
    expect(await client(paged, { now: () => clock }).auditKeys({ budgetMs: 2_500 })).toMatchObject({ truncated: true });
    expect(paged.seen.filter((entry) => entry.path === "/key/list")).toHaveLength(1);
  });

  it("goes on to the other drifted keys when one block fails, counts the failure, and then fails visibly", async () => {
    let blocks = 0;
    const proxy = litellm({ failOn: (seen) => (seen.path === "/key/block" && (blocks += 1) === 1 ? json({ error: "down" }, 503) : undefined) });
    const first = scoped(["*"]);
    const second = scoped([]);
    const third = scoped([`${OTHER_ORG}.${SRC}.claude-sonnet-4-6`]);
    proxy.keys.push(first, second, third);
    const refused = await failure(client(proxy).auditKeys());
    expect(refused.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(refused.message).toContain("1 of 3");
    // The counts of the run travel in the error, so the broker can log them.
    expect(refused.message).toContain("checked 3, blocked 2");
    expect(proxy.seen.filter((entry) => entry.path === "/key/block")).toHaveLength(3);
    expect([first.blocked, second.blocked, third.blocked].filter((blocked) => blocked === true)).toHaveLength(2);
  });

  it("fails visibly when the list cannot be read, and when a block is refused, rather than reporting a clean audit", async () => {
    const down = litellm({ failOn: (seen) => (seen.path === "/key/list" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(down).auditKeys())).code).toBe("MODEL_PROXY_UNAVAILABLE");
    // A refusal (not an outage) of the list is no clean audit either.
    const refusedList = litellm({ failOn: (seen) => (seen.path === "/key/list" ? json({ error: { message: "not allowed" } }, 403) : undefined) });
    expect((await failure(client(refusedList).auditKeys())).code).toBe("CONFIG_INVALID");
    const stuck = litellm({ failOn: (seen) => (seen.path === "/key/block" ? json({ error: "down" }, 503) : undefined) });
    stuck.keys.push(scoped(["*"]));
    expect((await failure(client(stuck).auditKeys())).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("needs the catalog, since it cannot tell a catalog id from a stranger's model without it", async () => {
    const proxy = litellm();
    expect((await failure(client(proxy, { catalog: [] }).auditKeys())).code).toBe("CONFIG_INVALID");
    expect(proxy.seen).toEqual([]);
  });

  it("is a request of its own for the handler and the invoker, and the handler refuses an argument", async () => {
    const never = async () => { throw new Error("not used"); };
    const auditKeys = vi.fn(async () => ({ checked: 3, blocked: 1, truncated: true }));
    const access = {
      upsertOrg: never, upsertMember: never, spend: never, orgSpend: never, keySpend: never, mintKey: never, revokeKey: never, blockKey: never,
      upsertSource: never, removeSource: never, checkSource: never, listSources: never, auditKeys,
    } as unknown as ModelAccess;
    const run = createModelAccessHandler({ access, log: () => undefined });
    expect(await run({ op: "auditKeys", args: {} })).toEqual({ ok: true, result: { checked: 3, blocked: 1, truncated: true } });
    expect(auditKeys).toHaveBeenLastCalledWith(undefined);
    expect(await run({ op: "auditKeys", args: { budgetMs: 4_000 } })).toMatchObject({ ok: true });
    expect(auditKeys).toHaveBeenLastCalledWith({ budgetMs: 4_000 });
    expect(await run({ op: "auditKeys", args: { budgetMs: -1 } })).toMatchObject({ ok: false });
    expect(await run({ op: "auditKeys", args: { orgId: ORG } })).toMatchObject({ ok: false });
    const lambda = { send: vi.fn(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { checked: 3, blocked: 1, truncated: true } })) })) };
    expect(await new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).auditKeys({ budgetMs: 4_000 })).toEqual({ checked: 3, blocked: 1, truncated: true });
    expect(JSON.parse(Buffer.from((lambda.send.mock.calls[0] as unknown as [{ input: { Payload: Uint8Array } }])[0].input.Payload).toString("utf8"))).toEqual({ op: "auditKeys", args: { budgetMs: 4_000 } });
    lambda.send.mockImplementationOnce(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { checked: -1, blocked: 0, truncated: false } })) }));
    await expect(new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).auditKeys()).rejects.toThrow("unexpected result");
  });
});
