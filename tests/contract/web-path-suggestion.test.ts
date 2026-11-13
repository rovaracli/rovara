import { expect, it } from "vitest";
import * as web from "../../packages/cloud-contracts/src/web.js";
import { CodeIntentBodySchema } from "@rovara-code/contracts";

const requestId = "11111111-1111-4111-8111-111111111111";
it("exports strict suggestion contracts through the web surface", () => {
 expect(web).toHaveProperty("CodeSuggestionBodySchema");
 expect(web).toHaveProperty("CodeSuggestionSchema");
});
it("accepts the stated maximum and refuses blank, oversized, unknown or forged fields", () => {
 const schema = web.CodeSuggestionBodySchema;
 for (const text of ["x".repeat(4000), "界".repeat(4000)]) expect(schema.safeParse({ requestId, text }).success).toBe(true);
 for (const value of [{ requestId, text: " " }, { requestId, text: "x".repeat(4001) }, { requestId: "bad", text: "fix" }, { requestId, text: "fix", orgId: "forged" }, { requestId, text: "fix", path: "quick" }]) expect(schema.safeParse(value).success).toBe(false);
 // Today's start contract has an additional byte cap: preserve it rather than claiming all 4,000-character starts fit.
 expect(CodeIntentBodySchema.safeParse({ requestId, input: { text: "x".repeat(4000) } }).success).toBe(true);
});
it("accepts only matching fixed path/reason pairs and never model text or extra fields", () => {
 for (const [path, reason] of [["quick", "small_change"], ["full", "large_change"], ["answer", "question"], ["answer", "unclear"], ["answer", "unavailable"]]) expect(web.CodeSuggestionSchema.safeParse({ path, reason, source: "wording" }).success).toBe(true);
 for (const value of [{ path: "quick", reason: "injected", source: "wording" }, { path: "full", reason: "small_change", source: "wording" }, { path: "answer", reason: "unavailable", source: "model" }, { path: "quick", reason: "small_change", source: "wording", score: 1 }]) expect(web.CodeSuggestionSchema.safeParse(value).success).toBe(false);
});

it("distinguishes a capped previous suggestion from current wording without allowing model provenance", () => {
 expect(web.CodeSuggestionSchema.safeParse({ path: "quick", reason: "small_change", source: "previous_wording" }).success).toBe(true);
 expect(web.CodeSuggestionSchema.safeParse({ path: "quick", reason: "small_change", source: "model" }).success).toBe(false);
});
