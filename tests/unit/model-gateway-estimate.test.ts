import { expect, it } from "vitest";
import { estimateCall, usageCost } from "../../packages/model-gateway/src/estimate.js";
const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false };
it("rounds up whole micros, uses the applied output limit and the entire byte input", () => {
  expect(estimateCall(1, 128_000, price)).toBe(1);
  expect(estimateCall(3_000_000, 1, price)).toBe(4);
  expect(estimateCall(0, 128_000, { ...price, outputMicrosPerMTok: 1_000_000 })).toBe(128_000);
  expect(usageCost({ input: 2, output: 5, cacheRead: 3, cacheWrite: 4 }, { ...price, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 })).toBe(19);
});
