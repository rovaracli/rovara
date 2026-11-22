import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { openRouterPolicy, openRouterRequest, REVIEWED_OPENROUTER_POLICIES } from "../../packages/model-gateway/src/openrouter-policy.js";
beforeAll(denyNetwork);
const now = Date.UTC(2026, 10, 20);
const row = { model: "openai/gpt-5-mini", route: "fixture-provider", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture only; not a vendor tariff" };
it("has no fabricated production tariff; exact reviewed routes expire and hash all restrictions", () => {
 expect(REVIEWED_OPENROUTER_POLICIES).toEqual([]);
 expect(openRouterPolicy(row.model, now, [row])?.model).toBe(row.model);
 expect(openRouterPolicy(row.model, now, [row])?.hash).toMatch(/^[a-f0-9]{64}$/u);
 for (const patch of [{ expiresAt: now }, { verifiedAt: now + 1 }, { inputMicrosPerMTok: 0 }, { route: "" }]) expect(openRouterPolicy(row.model, now, [{ ...row, ...patch }])).toBeUndefined();
 expect(openRouterPolicy("openai/gpt-5-mini:free", now, [row])).toBeUndefined();
 expect(openRouterPolicy(row.model, now, [row])?.hash).not.toBe(openRouterPolicy(row.model, now, [{ ...row, route: "other" }])?.hash);
});
it("pins route, maximum USD per million token rates and no fallback; caller overrides and unbounded features refuse", () => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 const body = { model: row.model, messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream: true };
 expect(openRouterRequest(body, policy)).toMatchObject({ provider: { only: [row.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 2 } }, usage: { include: true } });
 for (const patch of [{ provider: {} }, { plugins: [] }, { models: ["other"] }, { reasoning: {} }, { model: "openrouter/auto" }, { max_tokens: 0 }, { messages: [{ role: "user", content: [{ type: "image_url" }] }] }]) expect(openRouterRequest({ ...body, ...patch }, policy)).toBeUndefined();
});
