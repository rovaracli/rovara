// Proof and test environment E13: AI navigation on Cloud is charged through a capped proxy key. Worst case reserved first, never an uncharged call, key given back when the round ends.
import { describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, E2E_PROXY_KEY_FEATURE, E2eProxyGrantSchema, agentXError, e2eProxyGate, e2eRoundWorstCaseUsd } from "@agentx/contracts";
import { mintRoundKeyPort, closeE2eRoundSpend, startE2eRoundSpend, type MintedRoundKey, type RoundSpendPorts } from "../../packages/broker/src/e2e/model-spend.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const PRICE = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
// 3 groups x ((400,000 input tokens x $3 + 40 x 1,024 output tokens x $15) / 1M) = 3 x (1.2 + 0.6144) = 5.4432 -> 5.444 (rounded up to a tenth of a cent)
const WORST = 5.444;
const minted = (over: Partial<MintedRoundKey> = {}): MintedRoundKey => ({ key: "sk-test-key-0123456789abcdef", keyId: "key-1", expiresAt: 1_800_000_000_000 + 4_000_000, maxBudgetUsd: WORST, reserved: true, ...over });

function ports(over: Partial<RoundSpendPorts> = {}) {
  const log: string[] = [];
  const asked: Array<{ routeAlias: string; ttlSeconds: number }> = [];
  const value: RoundSpendPorts = {
    admit: () => { log.push("admit"); return Promise.resolve({ maxBudgetUsd: 20 }); },
    mint: (input) => { log.push("mint"); asked.push(input); return Promise.resolve(minted()); },
    close: (_org, keyId) => { log.push(`close:${keyId}`); return Promise.resolve(true); },
    proxyBaseUrl: "https://proxy.rovara.example/v1",
    now: () => 1_800_000_000_000,
    ...over,
  };
  return { value, log, asked };
}
const start = (value: RoundSpendPorts, over: Record<string, unknown> = {}) => startE2eRoundSpend(value, { orgId: ORG, operationId: "op-1", routeAlias: "e2e-nav", groups: 3, price: PRICE, roundSeconds: 1_800, ...over });

describe("the worst case", () => {
  it("is the route's calls and tokens at the model's price, per group, rounded up", () => {
    expect(E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxModelCallsPerGroup).toBe(40);
    expect(e2eRoundWorstCaseUsd({ groups: 3, price: PRICE })).toBe(WORST);
    expect(e2eRoundWorstCaseUsd({ groups: 1, price: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } })).toBe(0);
  });
  it("holds the input tokens to the group's own cap, not calls times the per-call cap", () => {
    const loose = { maxModelCallsPerGroup: 40, maxInputTokens: 32_000, maxOutputTokens: 0 + 1, maxInputTokensPerGroup: 100_000 };
    expect(e2eRoundWorstCaseUsd({ groups: 1, budgets: loose, price: { inputUsdPerMTok: 10, outputUsdPerMTok: 0 } })).toBe(1);
  });
  it("throws for a price or a group count that is not usable, rather than reserve nothing", () => {
    expect(() => e2eRoundWorstCaseUsd({ groups: 0, price: PRICE })).toThrow(RangeError);
    expect(() => e2eRoundWorstCaseUsd({ groups: 101, price: PRICE })).toThrow(RangeError);
    expect(() => e2eRoundWorstCaseUsd({ groups: 1, price: { inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 1 } })).toThrow();
    expect(() => e2eRoundWorstCaseUsd({ groups: 1, price: { inputUsdPerMTok: -1, outputUsdPerMTok: 1 } })).toThrow();
  });
});

describe("starting a round", () => {
  it("admits, mints a capped key, and hands out a grant whose cap covers the worst case; the key lives a little past the round", async () => {
    const { value, log, asked } = ports();
    const result = await start(value);
    expect(result).toMatchObject({ ok: true, worstCaseUsd: WORST });
    if (!result.ok) throw new Error("not ok");
    expect(log).toEqual(["admit", "mint"]);
    expect(asked).toEqual([{ routeAlias: "e2e-nav", ttlSeconds: 2_100, capUsd: WORST }]);
    expect(E2eProxyGrantSchema.safeParse(result.grant).success).toBe(true);
    expect(result.grant).toMatchObject({ proxyBaseUrl: "https://proxy.rovara.example/v1", keyId: "key-1", operationId: "op-1", routeAlias: "e2e-nav", capUsd: WORST });
  });
  it("mints nothing when the admission is refused, and the card asks for spend with the ledger's own words", async () => {
    const { value, log } = ports({ admit: () => Promise.reject(agentXError("PROJECT_BUDGET_EXCEEDED", "The payments project's monthly AI budget is used up ($50 of $50). Ask for more from the project's page.")) });
    const result = await start(value);
    expect(result).toMatchObject({ ok: false, reason: "budget", code: "PROJECT_BUDGET_EXCEEDED", askCard: "approve_spend", neededUsd: WORST });
    if (result.ok || result.reason !== "budget") throw new Error("unexpected");
    expect(result.message).toContain("monthly AI budget is used up");
    expect(log).toEqual([]);
  });
  it("refuses a round whose room is below the worst case, before and after minting, and gives the key back", async () => {
    const small = ports({ admit: () => Promise.resolve({ maxBudgetUsd: 5 }) });
    expect(await start(small.value)).toEqual({ ok: false, reason: "insufficient_room", neededUsd: WORST, availableUsd: 5, askCard: "approve_spend" });
    expect(small.log).toEqual([]);
    const raced = ports({ mint: () => Promise.resolve(minted({ maxBudgetUsd: 3 })) });
    expect(await start(raced.value)).toEqual({ ok: false, reason: "insufficient_room", neededUsd: WORST, availableUsd: 3, askCard: "approve_spend" });
    expect(raced.log).toEqual(["admit", "close:key-1"]);
    const nan = ports({ admit: () => Promise.resolve({ maxBudgetUsd: Number.NaN }) });
    expect(await start(nan.value)).toMatchObject({ ok: false, reason: "insufficient_room", availableUsd: 0 });
  });
  it("asks for a key capped at the worst case, not at the room: a binding that returns the room as the cap is refused and the key is given back", async () => {
    const wide = ports({ mint: () => Promise.resolve(minted({ maxBudgetUsd: 20 })) });
    expect(await start(wide.value)).toEqual({ ok: false, reason: "cap_not_applied", neededUsd: WORST });
    expect(wide.log).toEqual(["admit", "close:key-1"]);
  });
  it("refuses a key that was not reserved on the ledger (a binding without scopes or tags), and gives it back", async () => {
    const loose = ports({ mint: () => Promise.resolve(minted({ reserved: false })) });
    expect(await start(loose.value)).toEqual({ ok: false, reason: "not_reserved" });
    expect(loose.log).toEqual(["admit", "close:key-1"]);
  });
  it("needs a positive, finite round length", async () => {
    for (const roundSeconds of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) await expect(start(ports().value, { roundSeconds })).rejects.toThrow(RangeError);
  });
  it("starts a round at exactly the worst case", async () => {
    expect((await start(ports({ admit: () => Promise.resolve({ maxBudgetUsd: WORST }), mint: () => Promise.resolve(minted({ maxBudgetUsd: WORST })) }).value)).ok).toBe(true);
  });
  it("a proxy that cannot be asked, or a lost race, ends the round before it starts and says it may be tried again", async () => {
    expect(await start(ports({ admit: () => Promise.reject(agentXError("MODEL_PROXY_UNAVAILABLE", "proxy down")) }).value)).toEqual({ ok: false, reason: "unavailable", retryable: true });
    expect(await start(ports({ mint: () => Promise.reject(agentXError("MODEL_PROXY_UNAVAILABLE", "proxy down")) }).value)).toEqual({ ok: false, reason: "unavailable", retryable: true });
    expect(await start(ports({ mint: () => Promise.reject(new Error("socket hang up")) }).value)).toEqual({ ok: false, reason: "unavailable", retryable: true });
    expect(await start(ports({ mint: () => Promise.resolve(undefined) }).value)).toEqual({ ok: false, reason: "raced", retryable: true });
  });
  it("rethrows a refusal that is not about money or availability (a bug is loud)", async () => {
    await expect(start(ports({ admit: () => Promise.reject(agentXError("FORBIDDEN", "no")) }).value)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("has no proxy route: nothing is admitted or minted", async () => {
    const { value, log } = ports({ proxyBaseUrl: undefined });
    expect(await start(value)).toEqual({ ok: false, reason: "no_proxy_route" });
    expect(log).toEqual([]);
  });
  it("closes a key that cannot become a grant (an address that is not https, an expiry already past)", async () => {
    const http = ports({ proxyBaseUrl: "http://proxy.internal/v1" });
    expect(await start(http.value)).toEqual({ ok: false, reason: "unavailable", retryable: true });
    expect(http.log).toEqual(["admit", "mint", "close:key-1"]);
    const expired = ports({ mint: () => Promise.resolve(minted({ expiresAt: 1_799_999_999_000 })) });
    expect((await start(expired.value)).ok).toBe(false);
    expect(expired.log).toEqual(["admit", "close:key-1"]);
  });
  it("never lets a key live more than three hours", async () => {
    const { value, asked } = ports();
    await start(value, { roundSeconds: 100_000 });
    expect(asked[0]?.ttlSeconds).toBe(3 * 3_600);
  });
});

describe("ending a round", () => {
  it("closes the key, and says false (not throws) when it cannot, so every exit can call it", async () => {
    const { value, log } = ports();
    expect(await closeE2eRoundSpend(value, ORG, "key-9")).toBe(true);
    expect(log).toEqual(["close:key-9"]);
    expect(await closeE2eRoundSpend({ close: () => Promise.reject(new Error("proxy down")) }, ORG, "key-9")).toBe(false);
    expect(await closeE2eRoundSpend({ close: () => Promise.resolve(false) }, ORG, "key-9")).toBe(false);
  });
});

describe("the gate that lifts the Cloud refusals", () => {
  const ok = { installHasProxyRoute: true, routePrice: PRICE, workerFeatures: ["task.workflowE2EAgentSteps.v1", E2E_PROXY_KEY_FEATURE] };
  it("lifts only with the install's proxy route, a price, and a worker that lists the proxy-key feature", () => {
    expect(e2eProxyGate(ok)).toEqual({ lift: true });
    expect(e2eProxyGate({ ...ok, installHasProxyRoute: false })).toEqual({ lift: false, refusal: "no_proxy_route" });
    expect(e2eProxyGate({ ...ok, routePrice: undefined })).toEqual({ lift: false, refusal: "no_price" });
    expect(e2eProxyGate({ ...ok, routePrice: { inputUsdPerMTok: -1, outputUsdPerMTok: 0 } })).toEqual({ lift: false, refusal: "no_price" });
    expect(e2eProxyGate({ ...ok, workerFeatures: ["task.workflowE2EAgentSteps.v1"] })).toEqual({ lift: false, refusal: "worker_lacks_feature" });
    expect(e2eProxyGate({ ...ok, workerFeatures: undefined })).toEqual({ lift: false, refusal: "worker_lacks_feature" });
  });
});

describe("the grant", () => {
  it("is strict and needs an https proxy address without credentials", () => {
    const grant = { schemaVersion: 1, proxyBaseUrl: "https://proxy.example.com/v1", key: "sk-0123456789abcdef", keyId: "k", operationId: "o", routeAlias: "a", capUsd: 1, expiresAt: 5 };
    expect(E2eProxyGrantSchema.safeParse(grant).success).toBe(true);
    for (const bad of [{ ...grant, extra: 1 }, { ...grant, proxyBaseUrl: "http://proxy.example.com" }, { ...grant, proxyBaseUrl: "https://user:pw@proxy.example.com" }, { ...grant, key: "short" }, { ...grant, capUsd: 0 }, { ...grant, proxyBaseUrl: "https://p.example.com/v1?k=1" }]) expect(E2eProxyGrantSchema.safeParse(bad).success).toBe(false);
  });
});

describe("the mint port over the real mintOperationKey's input", () => {
  const baseInput = { guardRecord: ((items: readonly unknown[]) => [...items]) as never, orgId: ORG, developerId: "dev_a", refId: "op-1", taskKeyIds: ["k0"], operationKeyIds: [] as string[], scopes: [{ kind: "org" }, { kind: "project", project: "svc" }] as never, tags: { agentId: "rovara-code", payerKind: "project", payerId: "svc", source: "x", origin: "e2e" } as never, keepEarlierKeys: true };
  it("sets every limit to the round's cap, passes scopes, tags and the e2e alias, and says 'reserved' only with the ledger", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mintOperationKey = (_deps: unknown, input: Record<string, unknown>) => { seen.push(input); return Promise.resolve({ outcome: "minted" as const, key: "sk-0123456789abcdef", keyId: "k1", expiresAt: 5, maxBudgetUsd: 5.444 }); };
    const port = mintRoundKeyPort({ mintOperationKey: mintOperationKey as never, deps: { ledger: {} } as never, base: baseInput });
    expect(await port({ routeAlias: "e2e-nav", ttlSeconds: 600, capUsd: 5.444 })).toEqual({ key: "sk-0123456789abcdef", keyId: "k1", expiresAt: 5, maxBudgetUsd: 5.444, reserved: true });
    expect(seen[0]).toMatchObject({ runLimitUsd: 5.444, stopAtUsd: 5.444, stepBudgetUsd: 5.444, ttlSeconds: 600, route: { alias: "e2e-nav" }, keepEarlierKeys: true, scopes: baseInput.scopes, tags: baseInput.tags });
  });
  it("cannot be built without the ledger or without scopes", () => {
    const mintOperationKey = (() => Promise.resolve({ outcome: "raced" as const })) as never;
    expect(() => mintRoundKeyPort({ mintOperationKey, deps: {} as never, base: baseInput })).toThrow(RangeError);
    expect(() => mintRoundKeyPort({ mintOperationKey, deps: { ledger: {} } as never, base: { ...baseInput, scopes: [] } })).toThrow(RangeError);
  });
  it("cannot be built without the task-stop guard: fail closed until the guard is wired", () => {
    const mintOperationKey = (() => Promise.resolve({ outcome: "raced" as const })) as never;
    const unguarded = { ...baseInput, guardRecord: undefined };
    expect(() => mintRoundKeyPort({ mintOperationKey, deps: { ledger: {} } as never, base: unguarded })).toThrow(/guardRecord/);
  });
  it("hands the caller's guard to the mint, so the key is recorded through it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mintOperationKey = (_deps: unknown, input: Record<string, unknown>) => { seen.push(input); return Promise.resolve({ outcome: "raced" as const }); };
    await mintRoundKeyPort({ mintOperationKey: mintOperationKey as never, deps: { ledger: {} } as never, base: baseInput })({ routeAlias: "e2e-nav", ttlSeconds: 600, capUsd: 1 });
    expect(seen[0]!["guardRecord"]).toBe(baseInput.guardRecord);
  });
  it("a lost race is no key", async () => {
    const port = mintRoundKeyPort({ mintOperationKey: (() => Promise.resolve({ outcome: "raced" as const })), deps: { ledger: {} } as never, base: baseInput });
    expect(await port({ routeAlias: "e2e-nav", ttlSeconds: 600, capUsd: 1 })).toBeUndefined();
  });
});
