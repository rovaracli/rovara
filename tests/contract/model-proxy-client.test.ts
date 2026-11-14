import { AgentXError } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { ModelAccessRequestSchema } from "../../packages/broker/src/model-proxy/protocol.js";
import { routeFetch } from "../support/developer-fakes.js";

const BASE = "http://proxy.internal:4000";
const MASTER = "sk-master-planted-value";
const ORG = "org_abcdefghij0123456789";
const DEV = "a".repeat(64);
const NOW = 1_800_000_000_000;
const CATALOG = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (init: RequestInit | undefined) => JSON.parse(init?.body as string) as Record<string, unknown>;

interface Seen { method: string; path: string; search: string; headers: Headers; body: Record<string, unknown> | undefined }

/** A fake LiteLLM that records each request and answers from `answer`; 404 for anything unanswered. */
function proxy(answer: (seen: Seen) => Response | undefined) {
  const seen: Seen[] = [];
  const fetch = routeFetch(async (url, init) => {
    const entry: Seen = {
      method: init?.method ?? "GET", path: url.pathname, search: url.search, headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? bodyOf(init) : undefined,
    };
    seen.push(entry);
    return answer(entry) ?? json({ error: { message: "not found" } }, 404);
  });
  const client = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch, now: () => NOW, catalog: CATALOG });
  return { client, seen, fetch };
}

const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as AgentXError; }
  throw new Error("expected a rejection");
};

describe("ModelProxyClient", () => {
  it("mintKey posts to /key/generate with the master key as bearer and the key's scope, budget, lifetime and metadata", async () => {
    const { client, seen } = proxy(({ path }) => (path === "/team/info" ? json({ team_info: { models: CATALOG } }) : path === "/key/generate" ? json({ key: "sk-virtual-1", expires: "2027-01-01T00:00:00Z" }) : undefined));
    const minted = await client.mintKey({ orgId: ORG, developerId: DEV, purpose: "task", refId: "task-1", maxBudgetUsd: 2.5, ttlSeconds: 3600 });
    expect(minted).toEqual({ key: "sk-virtual-1", expiresAt: NOW + 3_600_000 });
    // Every key answers to its org's team, so the team is read first.
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /team/info", "POST /key/generate"]);
    expect(seen[1]!.method).toBe("POST");
    expect(seen[1]!.headers.get("authorization")).toBe(`Bearer ${MASTER}`);
    expect(seen[1]!.headers.get("content-type")).toBe("application/json");
    expect(seen[1]!.body).toEqual({
      // Ruling R48: a task key reaches the model routes only, never LiteLLM's management routes.
      team_id: ORG, user_id: DEV, max_budget: 2.5, allowed_routes: ["llm_api_routes"], duration: "3600s",
      metadata: { orgId: ORG, developerId: DEV, purpose: "task", refId: "task-1" },
    });
  });

  it("mintKey without a developer mints an org-only key: a team, no user", async () => {
    const { client, seen } = proxy(({ path }) => (path === "/team/info" ? json({ team_info: { models: CATALOG } }) : path === "/key/generate" ? json({ key: "sk-virtual-2" }) : undefined));
    await client.mintKey({ orgId: ORG, purpose: "task", refId: "op-1", maxBudgetUsd: 25, ttlSeconds: 3600 });
    expect(seen[1]!.body).toEqual({ team_id: ORG, max_budget: 25, allowed_routes: ["llm_api_routes"], duration: "3600s", metadata: { orgId: ORG, purpose: "task", refId: "op-1" } });
  });

  describe("2026-11-03: Rovara pays for no key", () => {
    it("a scoped diagnosis-style key answers to the org's own team, with its budget: the support team is never read or written, and the mint cannot ask for another", async () => {
      let stored: Record<string, unknown> | undefined;
      const { client, seen } = proxy(({ path, body }) => {
        if (path === "/team/info") return json({ team_info: { models: CATALOG } });
        if (path === "/key/generate") { stored = body; return json({ key: "sk-virtual-3" }); }
        if (path === "/key/info") return json({ info: { models: stored!.models, team_id: stored!.team_id, aliases: {}, allowed_routes: stored!.allowed_routes } });
        return undefined;
      });
      await client.mintKey({ orgId: ORG, purpose: "turn", refId: "t", maxBudgetUsd: 0.25, ttlSeconds: 60, models: [CATALOG[0]!] });
      const generate = seen.find((entry) => entry.path === "/key/generate")!;
      expect(generate.body).toMatchObject({ team_id: ORG, max_budget: 0.25, models: [CATALOG[0]], metadata: { orgId: ORG, purpose: "turn", refId: "t" } });
      expect(JSON.stringify(generate.body)).not.toContain("rovaraPaid");
      expect(seen.some((entry) => `${entry.path}${entry.search}${JSON.stringify(entry.body ?? {})}`.includes("rovara-support"))).toBe(false);
    });

    it("the model-access protocol has no way to ask for a Rovara-paid key: the field is refused", () => {
      const args = { orgId: ORG, purpose: "turn", refId: "t", maxBudgetUsd: 0.25, ttlSeconds: 60, models: [CATALOG[0]] };
      expect(ModelAccessRequestSchema.safeParse({ op: "mintKey", args }).success).toBe(true);
      expect(ModelAccessRequestSchema.safeParse({ op: "mintKey", args: { ...args, rovaraPaid: true } }).success).toBe(false);
    });
  });

  it("upsertOrg creates the LiteLLM team with the monthly budget and 1mo reset", async () => {
    const { client, seen } = proxy(({ path }) => (path === "/team/new" ? json({ team_id: ORG }) : path === "/model/info" ? json({ data: [] }) : undefined));
    await client.upsertOrg(ORG, 100);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /model/info", "POST /team/new"]);
    expect(seen[1]!.headers.get("authorization")).toBe(`Bearer ${MASTER}`);
    // Every team is limited to the Rovara AI catalog (an empty list would mean every model).
    expect(seen[1]!.body).toEqual({ team_id: ORG, max_budget: 100, budget_duration: "1mo", models: CATALOG });
  });

  it("upsertOrg updates the team when it already exists", async () => {
    const { client, seen } = proxy(({ path }) => {
      if (path === "/team/new") return json({ error: { message: `Team id = ${ORG} already exists. Please use a different team id.` } }, 400);
      if (path === "/team/update") return json({ team_id: ORG });
      if (path === "/model/info") return json({ data: [] });
      return undefined;
    });
    await client.upsertOrg(ORG, 150);
    expect(seen.map((s) => s.path)).toEqual(["/model/info", "/team/new", "/team/update"]);
    expect(seen[2]!.body).toEqual({ team_id: ORG, max_budget: 150, budget_duration: "1mo", models: CATALOG });
  });

  it("upsertMember creates the LiteLLM user inside the team with no stray key, then updates it when it exists", async () => {
    const created = proxy(({ path }) => (path === "/user/new" ? json({ user_id: DEV }) : undefined));
    await created.client.upsertMember(ORG, DEV, 20);
    expect(created.seen.map((s) => s.path)).toEqual(["/user/new"]);
    expect(created.seen[0]!.body).toEqual({ user_id: DEV, user_role: "internal_user_viewer", max_budget: 20, budget_duration: "1mo", metadata: { orgId: ORG }, auto_create_key: false });

    const existing = proxy(({ path }) => {
      if (path === "/user/new") return json({ error: { message: `User with id ${DEV} already exists in the db` } }, 400);
      if (path === "/user/update") return json({ user_id: DEV });
      return undefined;
    });
    await existing.client.upsertMember(ORG, DEV, 30);
    expect(existing.seen.map((s) => s.path)).toEqual(["/user/new", "/user/update"]);
    expect(existing.seen[1]!.body).toEqual({ user_id: DEV, user_role: "internal_user_viewer", max_budget: 30, budget_duration: "1mo", metadata: { orgId: ORG } });
  });

  it("a 400 validation error on create is surfaced as the create's own refusal and never falls back to update", async () => {
    for (const [create, update, call] of [
      ["/team/new", "/team/update", (client: ModelProxyClient) => client.upsertOrg(ORG, -5)],
      ["/user/new", "/user/update", (client: ModelProxyClient) => client.upsertMember(ORG, DEV, -5)],
    ] as const) {
      const { client, seen } = proxy(({ path }) => {
        if (path === create) return json({ error: { message: "max_budget must be a non-negative number" } }, 400);
        if (path === update) return json({ error: { message: "not found" } }, 404);
        if (path === "/model/info") return json({ data: [] });
        return undefined;
      });
      const error = await failure(call(client));
      expect(error.code, create).toBe("CONFIG_INVALID");
      expect(error.message, create).toContain("max_budget must be a non-negative number");
      expect(seen.map((s) => s.path).filter((path) => path !== "/model/info"), create).toEqual([create]);
    }
  });

  it("a 409 on create also falls back to update", async () => {
    const { client, seen } = proxy(({ path }) => (path === "/team/new" ? json({ error: { message: "conflict" } }, 409) : path === "/team/update" ? json({}) : path === "/model/info" ? json({ data: [] }) : undefined));
    await client.upsertOrg(ORG, 5);
    expect(seen.map((s) => s.path)).toEqual(["/model/info", "/team/new", "/team/update"]);
  });

  it("spend maps /team/info and /user/info to the member and org figures LiteLLM reports", async () => {
    const { client, seen } = proxy(({ path, search }) => {
      if (path === "/team/info" && search === `?team_id=${ORG}`) return json({ team_id: ORG, team_info: { spend: 12.5, max_budget: 100 }, keys: [] });
      if (path === "/user/info" && search === `?user_id=${DEV}`) return json({ user_id: DEV, user_info: { spend: 3.25, max_budget: 20 }, keys: [] });
      return undefined;
    });
    expect(await client.spend(ORG, DEV)).toEqual({ member: { spentUsd: 3.25, limitUsd: 20 }, org: { spentUsd: 12.5, limitUsd: 100 } });
    expect(seen.every((s) => s.method === "GET" && s.headers.get("authorization") === `Bearer ${MASTER}`)).toBe(true);
  });

  it("spend reports overspend as LiteLLM returns it (caps are soft) and treats a null spend as 0", async () => {
    const { client } = proxy(({ path }) => {
      if (path === "/team/info") return json({ team_info: { spend: null, max_budget: 100 } });
      if (path === "/user/info") return json({ user_info: { spend: 0.0617, max_budget: 0.05 } });
      return undefined;
    });
    expect(await client.spend(ORG, DEV)).toEqual({ member: { spentUsd: 0.0617, limitUsd: 0.05 }, org: { spentUsd: 0, limitUsd: 100 } });
  });

  it("orgSpend reads only the team's figures", async () => {
    const { client, seen } = proxy(({ path }) => (path === "/team/info" ? json({ team_info: { spend: 7.5, max_budget: 500 } }) : undefined));
    expect(await client.orgSpend(ORG)).toEqual({ spentUsd: 7.5, limitUsd: 500 });
    expect(seen.map((s) => `${s.method} ${s.path}${s.search}`)).toEqual([`GET /team/info?team_id=${ORG}`]);
    const unknown = proxy(() => undefined);
    expect((await failure(unknown.client.orgSpend(ORG))).code).toBe("NOT_FOUND");
    const noBudget = proxy(() => json({ team_info: { spend: 1 } }));
    expect((await failure(noBudget.client.orgSpend(ORG))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("keySpend sums /key/info spend over the distinct ids and counts a null spend as 0", async () => {
    const spends: Record<string, number | null> = { ["a".repeat(64)]: 1.5, ["b".repeat(64)]: null, ["d".repeat(64)]: 2.25 };
    const { client, seen } = proxy(({ path, search }) => {
      if (path !== "/key/info") return undefined;
      const spend = spends[new URLSearchParams(search).get("key") ?? ""];
      if (spend === undefined) return json({ error: { message: "key not found" } }, 404);
      return json({ key: "ignored", info: { spend, max_budget: 5 } });
    });
    expect(await client.keySpend([...Object.keys(spends), "a".repeat(64)])).toBe(3.75);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.method === "GET" && s.headers.get("authorization") === `Bearer ${MASTER}`)).toBe(true);
    expect(await client.keySpend([])).toBe(0);
    expect(seen).toHaveLength(3);
  });

  it("keyEstimatedSpend sums the guard's stamp in each key's metadata (micro-dollars), never more than the key's own spend, and 0 for a key with none", async () => {
    const infos: Record<string, Record<string, unknown>> = {
      ["a".repeat(64)]: { spend: 1.5, metadata: { orgId: "o", rovara_estimated_micros: 250_000 } },
      ["b".repeat(64)]: { spend: 0.1, metadata: { rovara_estimated_micros: 9_000_000 } },   // a stamp ahead of the spend the proxy has flushed: capped at the spend
      ["d".repeat(64)]: { spend: 2.25, metadata: { orgId: "o" } },
      ["e".repeat(64)]: { spend: 1, metadata: null },
      ["f".repeat(64)]: { spend: 1, metadata: { rovara_estimated_micros: "x" } },
      ["g".repeat(64)]: { spend: 1, metadata: { rovara_estimated_micros: -5 } },
    };
    const { client } = proxy(({ path, search }) => (path === "/key/info" ? json({ info: infos[new URLSearchParams(search).get("key") ?? ""] }) : undefined));
    expect(await client.keyEstimatedSpend(Object.keys(infos))).toBeCloseTo(0.25 + 0.1, 9);
    expect(await client.keySpend(Object.keys(infos))).toBeCloseTo(1.5 + 0.1 + 2.25 + 3, 9);
    expect(await client.keyEstimatedSpend([])).toBe(0);
    // A key the proxy cannot find fails closed, as keySpend does.
    expect((await failure(proxy(() => undefined).client.keyEstimatedSpend(["c".repeat(64)]))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("keySpend fails closed on a key the proxy cannot find: MODEL_PROXY_UNAVAILABLE, never a spend of 0", async () => {
    const { client } = proxy(({ path, search }) => (path === "/key/info" && new URLSearchParams(search).get("key") === "a".repeat(64) ? json({ info: { spend: 1 } }) : undefined));
    expect((await failure(client.keySpend(["a".repeat(64), "c".repeat(64)]))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("keySpend refuses a malformed answer as MODEL_PROXY_UNAVAILABLE and fails on a 5xx or a 403", async () => {
    const ids = ["a".repeat(64)];
    expect((await failure(proxy(() => json({ info: {} })).client.keySpend(ids))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect((await failure(proxy(() => json({ error: "busy" }, 503)).client.keySpend(ids))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect((await failure(proxy(() => json({ error: { message: "forbidden" } }, 403)).client.keySpend(ids))).code).toBe("CONFIG_INVALID");
  });

  it("spend refuses an answer without a budget or with the wrong shape as MODEL_PROXY_UNAVAILABLE", async () => {
    const noBudget = proxy(({ path }) => (path === "/team/info" ? json({ team_info: { spend: 1, max_budget: null } }) : json({ user_info: { spend: 1, max_budget: 5 } })));
    expect((await failure(noBudget.client.spend(ORG, DEV))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    const html = proxy(() => new Response("<html></html>", { status: 200 }));
    expect((await failure(html.client.spend(ORG, DEV))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("revokeKey deletes the key and treats an already-missing key as revoked", async () => {
    const ok = proxy(({ path }) => (path === "/key/delete" ? json({ deleted_keys: ["sk-virtual-1"] }) : undefined));
    await ok.client.revokeKey("sk-virtual-1");
    expect(ok.seen[0]!.body).toEqual({ keys: ["sk-virtual-1"] });
    const gone = proxy(() => json({ error: { message: "key not found" } }, 404));
    await expect(gone.client.revokeKey("sk-virtual-1")).resolves.toBeUndefined();
  });

  it("blockKey blocks the key by its id, treats a missing key as blocked and fails closed on any other refusal", async () => {
    const id = "e".repeat(64);
    const ok = proxy(({ path }) => (path === "/key/block" ? json({ blocked: true }) : undefined));
    await ok.client.blockKey(id);
    expect(ok.seen).toHaveLength(1);
    expect(ok.seen[0]!.body).toEqual({ key: id });
    const gone = proxy(() => json({ error: { message: "key not found" } }, 404));
    await expect(gone.client.blockKey(id)).resolves.toBeUndefined();
    const busy = proxy(() => json({ error: { message: "upstream unhealthy" } }, 503));
    expect((await failure(busy.client.blockKey(id))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("a fetch rejection and a 5xx answer throw MODEL_PROXY_UNAVAILABLE", async () => {
    const down = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch: async () => { throw new TypeError("fetch failed"); }, now: () => NOW, catalog: CATALOG });
    const refused = await failure(down.upsertOrg(ORG, 1));
    expect(refused).toBeInstanceOf(AgentXError);
    expect(refused.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(refused.statusCode).toBe(503);
    const busy = proxy(() => json({ error: { message: "upstream unhealthy" } }, 503));
    expect((await failure(busy.client.mintKey({ orgId: ORG, developerId: DEV, purpose: "turn", refId: "r", maxBudgetUsd: 1, ttlSeconds: 60 }))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect((await failure(busy.client.spend(ORG, DEV))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("a master key that cannot be read is MODEL_PROXY_UNAVAILABLE and nothing is sent", async () => {
    const fetch = routeFetch();
    const client = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => { throw new Error("denied"); }, fetch, now: () => NOW });
    expect((await failure(client.revokeKey("sk-x"))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(fetch.calls).toEqual([]);
  });

  it("a 4xx answer throws with the proxy's message and never echoes a key", async () => {
    const { client } = proxy(({ path }) => (path === "/model/info" ? json({ data: [] }) : json({ error: { message: "Invalid team budget for sk-leaked-virtual-key-12345" } }, 400)));
    const error = await failure(client.upsertOrg(ORG, -1));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("Invalid team budget");
    expect(error.message).not.toContain("sk-leaked-virtual-key-12345");
    const missing = proxy(() => json({ error: { message: "Team not found" } }, 404));
    expect((await failure(missing.client.spend(ORG, DEV))).code).toBe("NOT_FOUND");
  });

  it("reads the master key once per call and never puts it in an error", async () => {
    let reads = 0;
    const fetch = routeFetch(async () => json({ error: { message: "boom" } }, 500));
    const client = new ModelProxyClient({ baseUrl: `${BASE}/`, masterKey: async () => { reads += 1; return MASTER; }, fetch, now: () => NOW, catalog: CATALOG });
    const error = await failure(client.upsertOrg(ORG, 1));
    expect(error.message).not.toContain(MASTER);
    expect(reads).toBe(1);
    expect(fetch.calls).toEqual(["GET http://proxy.internal:4000/model/info"]);
  });
});
