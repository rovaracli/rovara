import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE, type RateQuoteOptions } from "../../packages/model-gateway/src/rate-quote.js";
import { claims, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
it("quotes the connected BYO region, revision and the same dearer Bedrock/Anthropic components as admission", async () => {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 2, sources: { litellm: { fetchedAt: now - 100, count: 2, entries: [{ provider: "bedrock", model: "us.anthropic.claude-test-v1:0", kind: "chat", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }, { provider: "anthropic", model: "claude-test", kind: "chat", inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 10_000_000 }] } } }), save: async () => false }, { now: () => now }); await prices.reload();
  const opts: RateQuoteOptions = { prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }), sources: { sourceFor: async () => "bedrock_byo" }, keys: { connected: async () => false }, byo: { connection: async () => ({ row: { iss: claims.iss, cid: claims.cid, owner: "company", sourceId: "byo", versionId: "rotated" }, connection: { scheme: "assume_role", roleArn: "arn:aws:iam::123456789012:role/test", allowGlobal: false, region: "us-east-1", models: { "claude-test": "us.anthropic.claude-test-v1:0" } } }) } };
  const result = await answerRateQuote(opts, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=claude-test`, headers: { authorization: "Bearer fixture" } });
  expect(result.body).toMatchObject({ state: "available", value: { source: { id: "byo", connectionRevision: "rotated" }, region: "us-east-1", base: { input: 4_000_000, output: 15_000_000 } } });
  const { RateQuoteV1Schema } = await import("../../packages/contracts/src/run-usage.js");
  expect(RateQuoteV1Schema.parse((result.body as { value: unknown }).value)).toBeDefined();
});
