import { expect, it } from "vitest";
import { TaskUsageTelemetrySchema } from "../../packages/contracts/src/usage.js";
import { RateQuoteV1Schema } from "../../packages/contracts/src/run-usage.js";
it("strict Cloud readers accept optional unit history before Code workers emit it", () => {
  const value = { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "test", cacheRetention: "short", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cacheReadRatio: 0, costUsd: 0, calls: [] };
  expect(TaskUsageTelemetrySchema.safeParse(value).success).toBe(true);
  expect(TaskUsageTelemetrySchema.safeParse({ ...value, calls: [{ callId: "incomplete" }] }).success).toBe(false);
  expect(RateQuoteV1Schema.safeParse({ version: 1, currency: "USD", base: { input: -1 } }).success).toBe(false);
});
