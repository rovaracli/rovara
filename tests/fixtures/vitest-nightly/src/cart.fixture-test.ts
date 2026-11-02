import { describe, expect, it } from "vitest";

describe("cart", () => {
  it("adds an item", () => { expect(1 + 1).toBe(2); });
  it("totals (with tax) correctly", () => { expect(2 + 2).toBe(5); });
  it.skip("applies a coupon", () => {});
  describe("nested rules", () => {
    it("rounds up", () => { expect(1).toBe(2); });
  });
});
