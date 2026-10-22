// Plan 3 Task 26: the checks around a scoped key at the model proxy (the spike's `validate_mint`, `verify_minted` and the `/key/list` audit,
// docs/learnings/model-sources-spike.md question 2c). LiteLLM honours a key whose `models` is `[]`, `*`, `all-proxy-models` or an access group by reaching
// every model of its team, so the mint is refused unless the team is scoped, the key read back is exactly what was asked for, and a periodic audit blocks
// any key that has drifted. The fake keeps keys and teams the way the real one does, and can be told to store a key differently from the request.
import { createHash } from "node:crypto";
import { INFERENCE_PATHS, type AgentXError } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
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
function litellm(options: { teams?: Record<string, string[] | undefined>; store?: (body: Record<string, unknown>) => Partial<StoredKey>; pageSize?: number; failOn?: (seen: Seen) => Response | undefined } = {}) {
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
      const live = keys.filter((candidate) => candidate.deleted !== true);
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
      ["no models at all", undefined],
      ["an empty list", []],
      ["a bare wildcard", ["*"]],
      ["all-proxy-models", ["all-proxy-models"]],
      ["a wildcard beside valid models", [OWN, "*"]],
      ["a provider wildcard", [OWN, "openai/*"]],
      ["an access group", [OWN, "team-shared-models"]],
      ["another org's alias", [OWN, `${OTHER_ORG}.${SRC}.claude-sonnet-4-6`]],
      ["an id outside the catalog", [OWN, "us.anthropic.claude-opus-9"]],
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

  it("changes nothing for a key minted without models: no read of the team or the key", async () => {
    const proxy = litellm();
    await client(proxy).mintKey(mint([], { models: undefined }));
    expect(proxy.calls()).toEqual(["POST /key/generate"]);
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

  it("accepts a key whose stored models are in another order, and whose info does not list the routes", async () => {
    const proxy = litellm({ store: () => ({ models: [CATALOG[0]!, OWN], allowed_routes: undefined }) });
    await expect(client(proxy).mintKey(mint([OWN, CATALOG[0]!]))).resolves.toMatchObject({ key: "sk-virtual-1" });
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
    expect(result).toEqual({ checked: 1 + bad.length, blocked: bad.length });
    expect(proxy.keys.filter((key) => key.blocked === true).map((key) => key.token).sort()).toEqual(bad.map((key) => key.token).sort());
    expect(good.blocked).toBeUndefined();
    expect(proxy.seen.filter((entry) => entry.path === "/key/block").every((entry) => /^[0-9a-f]{64}$/.test(String(entry.body!.key)))).toBe(true);
  });

  it("leaves legacy keys alone (the older llm_api_routes key has no models and is bounded by its scoped team), and keys that are blocked or expired", async () => {
    const proxy = litellm();
    proxy.keys.push(
      scoped([], { allowed_routes: ["llm_api_routes"] }),
      scoped(["*"], { blocked: true }),
      scoped(["*"], { expires: "2020-01-01T00:00:00Z" }),
      scoped([OWN]),
    );
    expect(await client(proxy).auditKeys()).toEqual({ checked: 1, blocked: 0 });
  });

  it("reads every page, and stops at the last", async () => {
    const proxy = litellm({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1) proxy.keys.push(scoped([OWN]));
    proxy.keys[4]!.models = ["*"];
    expect(await client(proxy).auditKeys()).toEqual({ checked: 5, blocked: 1 });
    expect(proxy.seen.filter((entry) => entry.path === "/key/list").map((entry) => new URLSearchParams(entry.search).get("page"))).toEqual(["1", "2", "3"]);
  });

  it("fails visibly when the list cannot be read, and when a block is refused, rather than reporting a clean audit", async () => {
    const down = litellm({ failOn: (seen) => (seen.path === "/key/list" ? json({ error: "down" }, 503) : undefined) });
    expect((await failure(client(down).auditKeys())).code).toBe("MODEL_PROXY_UNAVAILABLE");
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
    const auditKeys = vi.fn(async () => ({ checked: 3, blocked: 1 }));
    const access = {
      upsertOrg: never, upsertMember: never, spend: never, orgSpend: never, keySpend: never, mintKey: never, revokeKey: never, blockKey: never,
      upsertSource: never, removeSource: never, checkSource: never, listSources: never, auditKeys,
    } as unknown as ModelAccess;
    const run = createModelAccessHandler({ access, log: () => undefined });
    expect(await run({ op: "auditKeys", args: {} })).toEqual({ ok: true, result: { checked: 3, blocked: 1 } });
    expect(await run({ op: "auditKeys", args: { orgId: ORG } })).toMatchObject({ ok: false });
    const lambda = { send: vi.fn(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { checked: 3, blocked: 1 } })) })) };
    expect(await new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).auditKeys()).toEqual({ checked: 3, blocked: 1 });
    lambda.send.mockImplementationOnce(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { checked: -1, blocked: 0 } })) }));
    await expect(new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).auditKeys()).rejects.toThrow("unexpected result");
  });
});
