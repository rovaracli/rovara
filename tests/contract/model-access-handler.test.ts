import { agentXError } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import type { ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { cachedSecret, createModelAccessHandler, handler } from "../../packages/broker/src/model-proxy/handler.js";
import { routeFetch } from "../support/developer-fakes.js";

const ORG = "org_abcdefghij0123456789";
const DEV = "b".repeat(64);
const MASTER = "sk-master-planted-value";
const VIRTUAL = "sk-virtual-planted-value";

function fakeAccess(overrides: Partial<ModelAccess> = {}): ModelAccess & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const record = <T>(name: string, value: T) => async (...args: unknown[]) => { calls.push([name, args]); return value; };
  return {
    calls,
    upsertOrg: record("upsertOrg", undefined),
    upsertMember: record("upsertMember", undefined),
    spend: record("spend", { member: { spentUsd: 1, limitUsd: 2 }, org: { spentUsd: 3, limitUsd: 4 } }),
    orgSpend: record("orgSpend", { spentUsd: 3, limitUsd: 4 }),
    keySpend: record("keySpend", 1.25),
    keyEstimatedSpend: record("keyEstimatedSpend", 0.5),
    upsertSource: record("upsertSource", undefined),
    removeSource: record("removeSource", undefined),
    checkSource: record("checkSource", { ok: true, health: "healthy" }),
    listSources: record("listSources", []),
    auditKeys: record("auditKeys", { checked: 0, blocked: 0, truncated: false }),
    mintKey: record("mintKey", { key: VIRTUAL, expiresAt: 1234 }),
    revokeKey: record("revokeKey", undefined),
    blockKey: record("blockKey", undefined),
    ...overrides,
  };
}

const quiet = () => undefined;

describe("ModelAccessFunction handler", () => {
  it("runs each operation and returns ok with the result", async () => {
    const access = fakeAccess();
    const run = createModelAccessHandler({ access, log: quiet });
    expect(await run({ op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: 100 } })).toEqual({ ok: true, result: null });
    expect(await run({ op: "upsertMember", args: { orgId: ORG, developerId: DEV, monthlyBudgetUsd: 10 } })).toEqual({ ok: true, result: null });
    expect(await run({ op: "spend", args: { orgId: ORG, developerId: DEV } })).toEqual({
      ok: true, result: { member: { spentUsd: 1, limitUsd: 2 }, org: { spentUsd: 3, limitUsd: 4 } },
    });
    const mint = { orgId: ORG, developerId: DEV, purpose: "turn", refId: "turn-1", maxBudgetUsd: 0.5, ttlSeconds: 600 };
    expect(await run({ op: "mintKey", args: mint })).toEqual({ ok: true, result: { key: VIRTUAL, expiresAt: 1234 } });
    expect(await run({ op: "revokeKey", args: { key: VIRTUAL } })).toEqual({ ok: true, result: null });
    expect(access.calls).toEqual([
      ["upsertOrg", [ORG, 100]],
      ["upsertMember", [ORG, DEV, 10]],
      ["spend", [ORG, DEV]],
      ["mintKey", [mint]],
      ["revokeKey", [VIRTUAL]],
    ]);
  });

  it("blocks a key by its id, and refuses an id that is not a token hash", async () => {
    const access = fakeAccess();
    const run = createModelAccessHandler({ access, log: quiet });
    expect(await run({ op: "blockKey", args: { keyId: "c".repeat(64) } })).toEqual({ ok: true, result: null });
    expect(access.calls).toEqual([["blockKey", ["c".repeat(64)]]]);
    expect((await run({ op: "blockKey", args: { keyId: "sk-the-key-itself" } })).ok).toBe(false);
    expect(access.calls).toHaveLength(1);
  });

  it("reads the estimated part of the keys' spend, as 0 from an access that cannot, and refuses a raw key", async () => {
    const ids = ["a".repeat(64)];
    const access = fakeAccess();
    expect(await createModelAccessHandler({ access, log: quiet })({ op: "keyEstimatedSpend", args: { keyIds: ids } })).toEqual({ ok: true, result: 0.5 });
    expect(access.calls).toEqual([["keyEstimatedSpend", [ids]]]);
    const without = fakeAccess();
    delete without.keyEstimatedSpend;
    expect(await createModelAccessHandler({ access: without, log: quiet })({ op: "keyEstimatedSpend", args: { keyIds: ids } })).toEqual({ ok: true, result: 0 });
    expect(await createModelAccessHandler({ access, log: quiet })({ op: "keyEstimatedSpend", args: { keyIds: [VIRTUAL] } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
  });

  it("runs the org-only spend and the keys' spend", async () => {
    const access = fakeAccess();
    const run = createModelAccessHandler({ access, log: quiet });
    const ids = ["a".repeat(64), "b".repeat(64)];
    expect(await run({ op: "orgSpend", args: { orgId: ORG } })).toEqual({ ok: true, result: { spentUsd: 3, limitUsd: 4 } });
    expect(await run({ op: "keySpend", args: { keyIds: ids } })).toEqual({ ok: true, result: 1.25 });
    expect(access.calls).toEqual([["orgSpend", [ORG]], ["keySpend", [ids]]]);
    // Key ids are token hashes: a raw key, or too many ids, is refused before the proxy is asked.
    for (const keyIds of [[VIRTUAL], Array.from({ length: 501 }, () => "c".repeat(64))]) {
      expect(await run({ op: "keySpend", args: { keyIds } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    }
    expect(access.calls).toHaveLength(2);
  });

  it("runs a key request with no developer", async () => {
    const access = fakeAccess();
    const run = createModelAccessHandler({ access, log: quiet });
    const mint = { orgId: ORG, purpose: "task", refId: "op-1", maxBudgetUsd: 25, ttlSeconds: 600 };
    expect(await run({ op: "mintKey", args: mint })).toEqual({ ok: true, result: { key: VIRTUAL, expiresAt: 1234 } });
    expect(access.calls).toEqual([["mintKey", [mint]]]);
  });

  it("refuses unknown operations, extra fields, bad ids and bad numbers as CONFIG_INVALID without calling the proxy", async () => {
    const access = fakeAccess();
    const run = createModelAccessHandler({ access, log: quiet });
    const bad: unknown[] = [
      undefined, null, "mintKey", {}, { op: "dropEverything", args: {} },
      { op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: 1 }, extra: true },
      { op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: 1, extra: true } },
      { op: "upsertOrg", args: { orgId: "not-an-org", monthlyBudgetUsd: 1 } },
      { op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: -1 } },
      { op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: Number.POSITIVE_INFINITY } },
      { op: "spend", args: { orgId: ORG } },
      { op: "mintKey", args: { orgId: ORG, developerId: DEV, purpose: "other", refId: "r", maxBudgetUsd: 1, ttlSeconds: 60 } },
      { op: "mintKey", args: { orgId: ORG, developerId: DEV, purpose: "task", refId: "r", maxBudgetUsd: 1, ttlSeconds: 0 } },
      { op: "mintKey", args: { orgId: ORG, developerId: DEV, purpose: "task", refId: "r", maxBudgetUsd: 1, ttlSeconds: 1.5 } },
      { op: "revokeKey", args: { key: "" } },
    ];
    for (const event of bad) {
      const reply = await run(event);
      expect(reply, JSON.stringify(event)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    }
    expect(access.calls).toEqual([]);
  });

  it("does not echo a rejected key in the answer or the log", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const run = createModelAccessHandler({ access: fakeAccess(), log: (entry) => lines.push(entry) });
    const reply = await run({ op: "revokeKey", args: { key: VIRTUAL, surprise: 1 } });
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(VIRTUAL);
    expect(JSON.stringify(lines)).not.toContain(VIRTUAL);
  });

  it("passes an AgentXError through with its code and message, without the code prefix", async () => {
    const access = fakeAccess({
      upsertOrg: async () => { throw agentXError("CONFIG_INVALID", "model proxy refused the request (400): bad budget"); },
      spend: async () => { throw agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"); },
      revokeKey: async () => { throw agentXError("NOT_FOUND", "no such key"); },
    });
    const run = createModelAccessHandler({ access, log: quiet });
    expect(await run({ op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: 1 } })).toEqual({ ok: false, code: "CONFIG_INVALID", message: "model proxy refused the request (400): bad budget" });
    expect(await run({ op: "spend", args: { orgId: ORG, developerId: DEV } })).toEqual({ ok: false, code: "MODEL_PROXY_UNAVAILABLE", message: "model proxy is unreachable" });
    expect(await run({ op: "revokeKey", args: { key: "k" } })).toEqual({ ok: false, code: "NOT_FOUND", message: "no such key" });
  });

  it("maps an unexpected exception to MODEL_PROXY_UNAVAILABLE without its text", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const run = createModelAccessHandler({
      access: fakeAccess({ revokeKey: async () => { throw new Error(`leaked ${MASTER}`); } }),
      log: (entry) => lines.push(entry),
    });
    const reply = await run({ op: "revokeKey", args: { key: "k" } });
    expect(reply).toMatchObject({ ok: false, code: "MODEL_PROXY_UNAVAILABLE" });
    expect(JSON.stringify([reply, lines])).not.toContain(MASTER);
  });

  it("logs the operation and outcome only, never the arguments or the key it minted", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const run = createModelAccessHandler({ access: fakeAccess(), log: (entry) => lines.push(entry) });
    await run({ op: "mintKey", args: { orgId: ORG, developerId: DEV, purpose: "task", refId: "task-9", maxBudgetUsd: 1, ttlSeconds: 60 } });
    expect(lines).toEqual([{ event: "model_access.done", op: "mintKey" }]);
  });

  it("with the real client over a fake proxy, sends the master key from the secret reader and maps a 503 to MODEL_PROXY_UNAVAILABLE", async () => {
    let reads = 0;
    const masterKey = cachedSecret(async () => { reads += 1; return MASTER; });
    const seenAuth: string[] = [];
    let status = 200;
    const fetch = routeFetch(async (_url, init) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      const team = { team_info: { models: ["us.anthropic.claude-sonnet-4-6"] } };
      return new Response(JSON.stringify(status !== 200 ? { error: { message: "down" } } : new URL(String(_url)).pathname === "/team/info" ? team : { key: VIRTUAL }), { status });
    });
    const run = createModelAccessHandler({ access: new ModelProxyClient({ baseUrl: "http://proxy:4000", masterKey, fetch, now: () => 0, catalog: ["us.anthropic.claude-sonnet-4-6"] }), log: quiet });
    const mint = { op: "mintKey", args: { orgId: ORG, developerId: DEV, purpose: "task", refId: "t", maxBudgetUsd: 1, ttlSeconds: 60 } };
    expect(await run(mint)).toEqual({ ok: true, result: { key: VIRTUAL, expiresAt: 60_000 } });
    status = 503;
    expect(await run(mint)).toMatchObject({ ok: false, code: "MODEL_PROXY_UNAVAILABLE" });
    expect(seenAuth).toEqual([`Bearer ${MASTER}`, `Bearer ${MASTER}`, `Bearer ${MASTER}`]);
    expect(reads).toBe(1);
  });
});

describe("cachedSecret", () => {
  it("reads once, shares an in-flight read, and retries after a failure", async () => {
    let reads = 0;
    let fail = true;
    const secret = cachedSecret(async () => {
      reads += 1;
      if (fail) throw new Error("denied");
      return "value";
    });
    await expect(secret()).rejects.toThrow("denied");
    fail = false;
    expect(await Promise.all([secret(), secret()])).toEqual(["value", "value"]);
    expect(await secret()).toBe("value");
    expect(reads).toBe(2);
  });
});

describe("the exported Lambda handler", () => {
  it("answers CONFIG_INVALID when the function's environment is missing, without throwing", async () => {
    const saved = { url: process.env.MODEL_PROXY_URL, arn: process.env.MODEL_PROXY_MASTER_KEY_SECRET_ARN };
    delete process.env.MODEL_PROXY_URL;
    delete process.env.MODEL_PROXY_MASTER_KEY_SECRET_ARN;
    try {
      expect(await handler({ op: "revokeKey", args: { key: "k" } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    } finally {
      if (saved.url !== undefined) process.env.MODEL_PROXY_URL = saved.url;
      if (saved.arn !== undefined) process.env.MODEL_PROXY_MASTER_KEY_SECRET_ARN = saved.arn;
    }
  });
});
