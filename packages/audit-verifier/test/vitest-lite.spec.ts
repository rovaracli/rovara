import assert from "node:assert/strict";
import { describe, expect, it } from "./support/vitest-lite.js";

// The test helpers are the only thing standing between a broken assertion and a green run, so they are tested too.
const fails = (run: () => void): void => assert.throws(run, assert.AssertionError);

describe("the test helpers", () => {
  it("toBe uses Object.is", () => {
    expect(1).toBe(1);
    expect(NaN).toBe(NaN);
    fails(() => expect(1).toBe(2));
    fails(() => expect(0).toBe(-0));
    expect(1).not.toBe(2);
    fails(() => expect(1).not.toBe(1));
  });

  it("toEqual compares structure, ignores undefined properties and tells arrays from objects", () => {
    expect({ a: [1, { b: 2 }], c: undefined }).toEqual({ a: [1, { b: 2 }] });
    expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
    expect(new Date(5)).toEqual(new Date(5));
    fails(() => expect({ a: 1 }).toEqual({ a: 2 }));
    fails(() => expect({ a: 1 }).toEqual({ a: 1, b: 1 }));
    fails(() => expect([1]).toEqual([1, 2]));
    fails(() => expect([]).toEqual({}));
    fails(() => expect(new Uint8Array([1])).toEqual(new Uint8Array([2])));
    expect(["a", "b"]).toEqual(expect.arrayContaining(["b"]));
    fails(() => expect(["a"]).toEqual(expect.arrayContaining(["b"])));
  });

  it("toMatchObject checks a subset, recursively", () => {
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    fails(() => expect({ a: 1 }).toMatchObject({ a: 2 }));
    fails(() => expect({ a: 1 }).toMatchObject({ b: 1 }));
  });

  it("toThrow checks the class, the message text, a pattern or nothing", () => {
    const boom = (): never => {
      throw new RangeError("out of range");
    };
    expect(boom).toThrow();
    expect(boom).toThrow(RangeError);
    expect(boom).toThrow("of range");
    expect(boom).toThrow(/^out/);
    expect(boom).toThrow(new RangeError("out of range"));
    fails(() => expect(boom).toThrow(TypeError));
    fails(() => expect(boom).toThrow("other"));
    fails(() => expect(boom).toThrow(/^in/));
    fails(() => expect(() => undefined).toThrow());
    expect(() => undefined).not.toThrow();
  });

  it("the other matchers pass and fail the right way", () => {
    expect("abc").toContain("b");
    expect([1, 2]).toContain(2);
    fails(() => expect("abc").toContain("z"));
    expect([1, 2]).toHaveLength(2);
    fails(() => expect([1]).toHaveLength(2));
    expect(1).toBeDefined();
    expect(undefined).toBeUndefined();
    fails(() => expect(undefined).toBeDefined());
    expect(2).toBeGreaterThan(1);
    expect(2).toBeGreaterThanOrEqual(2);
    expect(1).toBeLessThan(2);
    fails(() => expect(1).toBeGreaterThan(1));
    fails(() => expect(2).toBeLessThan(2));
    expect("abc").toMatch(/b/);
    fails(() => expect("abc").toMatch(/z/));
    expect({ a: 1 }).toHaveProperty("a");
    expect({ a: 1 }).not.toHaveProperty("b");
    fails(() => expect({ a: 1 }).toHaveProperty("b"));
  });

  it("a note given to expect is part of the failure message", () => {
    assert.throws(() => expect(1, "the note").toBe(2), /the note/);
  });

  it.each([[1, 2], [3, 4]] as const)("runs a row of %i and %i", (a, b) => {
    expect(b - a).toBe(1);
  });
  it.each(["x", "y"] as const)("runs a single value %s", (v) => {
    expect(v.length).toBe(1);
  });
});
