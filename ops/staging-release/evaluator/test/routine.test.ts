import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluate.ts";
import { cloudInput, codeInput } from "./fixtures.ts";

describe("routine releases are AUTO", () => {
  it("code release", () => {
    const d = evaluate(codeInput());
    expect(d.reasons).toEqual([]);
    expect(d.verdict).toBe("AUTO");
    expect(d.rows.map((r) => r.rule)).toContain("R-SIGNKEY");
  });
  it("cloud release", () => {
    const d = evaluate(cloudInput());
    expect(d.reasons).toEqual([]);
    expect(d.verdict).toBe("AUTO");
    expect(d.rows.map((r) => r.rule)).toEqual(expect.arrayContaining(["R3", "R4", "R4b", "E1", "R5", "R6"]));
  });
});
