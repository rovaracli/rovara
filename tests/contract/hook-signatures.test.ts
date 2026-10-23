// Plan 4 Task 19: the two comparisons a provider may use. Both compare SHA-256 digests with `timingSafeEqual`, so the length of a secret never short-circuits, an empty secret
// verifies nothing, and a case or a space in a vendor's hex does not matter.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const crypto = await import("node:crypto");
const { hmacHexEquals, tokenEquals } = await import("../../packages/broker/src/triggers/providers/types.js");
const spy = vi.mocked(crypto.timingSafeEqual);

const body = Buffer.from('{"id":"e1"}', "utf8");
const hex = (algorithm: "sha256" | "sha1", secret: string, raw: Buffer = body) => createHmac(algorithm, secret).update(raw).digest("hex");

describe("tokenEquals", () => {
  it("is false for a token one character short, and compares two digests of the same length to say so", () => {
    spy.mockClear();
    expect(tokenEquals("abc", "abcd")).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [left, right] = spy.mock.calls[0] as [Buffer, Buffer];
    expect([left.length, right.length]).toEqual([32, 32]);
  });

  it("is true for the same token, and false for another of the same length, an empty one and an empty secret", () => {
    expect(tokenEquals("s3cret-token-value", "s3cret-token-value")).toBe(true);
    expect(tokenEquals("s3cret-token-valuf", "s3cret-token-value")).toBe(false);
    expect(tokenEquals("", "s3cret-token-value")).toBe(false);
    expect(tokenEquals("", "")).toBe(false);
    expect(tokenEquals("anything", "")).toBe(false);
  });

  it("compares a very long token and a multi-byte one without trouble", () => {
    expect(tokenEquals("x".repeat(100_000), "x".repeat(100_001))).toBe(false);
    expect(tokenEquals("tøken-日本", "tøken-日本")).toBe(true);
  });
});

describe("hmacHexEquals", () => {
  it("accepts the hex HMAC of the exact bytes, in either case and with spaces around it, for SHA-256 and for SHA-1", () => {
    expect(hmacHexEquals("sha256", body, "secret-value-123456", hex("sha256", "secret-value-123456"))).toBe(true);
    expect(hmacHexEquals("sha256", body, "secret-value-123456", hex("sha256", "secret-value-123456").toUpperCase())).toBe(true);
    expect(hmacHexEquals("sha256", body, "secret-value-123456", ` ${hex("sha256", "secret-value-123456")}\n`)).toBe(true);
    expect(hmacHexEquals("sha1", body, "secret-value-123456", hex("sha1", "secret-value-123456"))).toBe(true);
  });

  it("refuses the other algorithm, another secret, another body, a short or empty or non-hex signature, and compares digests to say so", () => {
    const good = hex("sha256", "secret-value-123456");
    expect(hmacHexEquals("sha1", body, "secret-value-123456", good)).toBe(false);
    expect(hmacHexEquals("sha256", body, "secret-value-123456", hex("sha1", "secret-value-123456"))).toBe(false);
    expect(hmacHexEquals("sha256", body, "another-secret-1234", good)).toBe(false);
    expect(hmacHexEquals("sha256", Buffer.from('{"id":"e2"}'), "secret-value-123456", good)).toBe(false);
    spy.mockClear();
    for (const supplied of [good.slice(0, 10), "", "zz".repeat(32), `sha256=${good}`, `${good}00`]) expect(hmacHexEquals("sha256", body, "secret-value-123456", supplied), supplied).toBe(false);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("never verifies under an empty secret, even for the signature that secret makes", () => {
    expect(hmacHexEquals("sha256", body, "", hex("sha256", ""))).toBe(false);
    expect(hmacHexEquals("sha1", body, "", hex("sha1", ""))).toBe(false);
  });
});
