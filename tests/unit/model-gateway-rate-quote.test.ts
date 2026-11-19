import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_TOKEN_KIND, RATE_QUOTE_AUDIENCE, type RateQuoteOptions } from "../../packages/model-gateway/src/rate-quote.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { claims, jwk, kid, keys, now } from "./model-gateway-fixture.js";
import { randomUUID, sign } from "node:crypto";
beforeAll(denyNetwork);
const cid = claims.cid;
const path = `/v1/service/companies/${cid}/rate-quote?model=claude-test`;
const serviceClaims = { iss: claims.iss, cid, aud: "rovara-model-gateway-rate-quote", jti: randomUUID(), iat: now / 1000, nbf: now / 1000 - 30, exp: now / 1000 + 60 };
function mint(changes: Record<string, unknown> = {}) {
  const data = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid }), JSON.stringify({ ...serviceClaims, ...changes })].map((s) => Buffer.from(s).toString("base64url")).join(".");
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url")}`;
}
async function world() {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 7, sources: { litellm: { fetchedAt: now - 1000, count: 1, entries: [{ provider: "anthropic", model: "claude-test", kind: "chat", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }] } } }), save: async () => false }, { now: () => now });
  await prices.reload();
  const verify = createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, RATE_QUOTE_TOKEN_KIND);
  const seen: string[] = [];
  return { prices, verify, sources: { sourceFor: async (company: string) => { seen.push(company); return "anthropic_key" as const; } }, keys: { connected: async () => true, keyFor: async () => { throw new Error("quote must not open secrets"); }, identityFor: async () => ({ sourceId: "own", versionId: "v1" }) }, switchedOn: new Set<string>(), offeredProviders: new Set(["anthropic", "openai", "openrouter", "bedrock"]), region: "us-west-2", now: () => now, seen };
}
const get = (w: RateQuoteOptions, url = path, token = mint()) => answerRateQuote(w, { method: "GET", url, headers: { authorization: `Bearer ${token}` } });
describe("signed rate quote", () => {
  it("reads the admission snapshot and source, with derived components and snapshot identity", async () => {
    const w = await world(); const result = await get(w);
    expect(result.status).toBe(200);
    const { RateQuoteV1Schema } = await import("../../packages/contracts/src/run-usage.js");
    expect(RateQuoteV1Schema.parse((result.body as { value: unknown }).value)).toBeDefined();
    expect(result.body).toMatchObject({ state: "available", value: { version: 1, currency: "USD", model: { provider: "anthropic", modelId: "claude-test" }, source: { kind: "company_key", id: "own", connectionRevision: "v1" }, ref: { authority: "gateway", version: "7", hash: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown }, base: { input: 3_000_000, output: 15_000_000, cacheWrite5m: 6_000_000, cacheWrite1h: 6_000_000 }, derived: expect.arrayContaining([{ aboveInputTokens: 0, components: expect.arrayContaining(["cacheWrite5m", "cacheWrite1h"]) as unknown }]) as unknown } });
    expect(w.seen).toEqual([cid]);
  });
  it("refuses foreign companies, wrong audiences, extra claims and expired signatures before reads", async () => {
    const w = await world();
    for (const [url, token] of [[path.replace(cid, "org_bbbbbbbbbbbbbbbbbbbb"), mint()], [path, mint({ aud: "rovara-model-gateway-offered-models" })], [path, mint({ extra: true })], [path, mint({ exp: now / 1000 - 31 })]]) expect((await get(w, url, token)).status).toBe(401);
    expect(w.seen).toEqual([]);
    expect(RATE_QUOTE_AUDIENCE).toBe(serviceClaims.aud);
  });
  it("makes missing prices, unknown connection revisions, stale snapshots and unsupported media explicit", async () => {
    const w = await world();
    expect((await get(w, path.replace("claude-test", "missing"))).body).toMatchObject({ state: "unavailable" });
    expect((await get({ ...w, keys: { ...w.keys, identityFor: async () => undefined } })).body).toMatchObject({ state: "unavailable" });
    expect((await get({ ...w, now: () => now + 8 * 86_400_000 })).body).toMatchObject({ state: "unavailable" });
    expect((await get(w, path + "&modality=image")).body).toMatchObject({ state: "unavailable" });
  });
  it("does not quote a provider absent from the installed agent route", async () => {
    const w = await world();
    const result = await get({ ...w, sources: { sourceFor: async () => "openai_key" as const }, offeredProviders: new Set(["anthropic"]) });
    expect(result.body).toMatchObject({ state: "unavailable" });
  });
  it("maps Rovara aliases to the very Bedrock row used by admission without reading a key", async () => {
    const w = await world();
    const result = await get({ ...w, sources: { sourceFor: async () => "rovara" as const }, rovara: { models: new Map([["claude-test", "us.anthropic.claude-test-v1:0"]]), exempt: new Set() } });
    // No Bedrock price authority in this snapshot: never substitute the Anthropic row.
    expect(result.body).toMatchObject({ state: "unavailable" });
  });
});
