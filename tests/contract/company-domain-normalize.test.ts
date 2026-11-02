import { describe, expect, it } from "vitest";
import { normalizeCompanyDomain, normalizeEmailDomain } from "../../packages/broker/src/org/company-domains/normalize.js";

// Company domain verification (owner decision 2026-11-02): a domain is stored in one form only, and the forms that could stand for somebody else's name are refused.

const ok = (input: string) => {
  const result = normalizeCompanyDomain(input);
  if (!result.ok) throw new Error(`expected ${input} to be accepted, refused as ${result.reason}`);
  return result.domain;
};
const refused = (input: string) => {
  const result = normalizeCompanyDomain(input);
  return result.ok ? `accepted as ${result.domain}` : result.reason;
};

describe("normalizeCompanyDomain", () => {
  it("lower-cases, trims and drops one trailing dot", () => {
    expect(ok("  ACME.Example.COM ")).toBe("acme.example.com");
    expect(ok("acme.com.")).toBe("acme.com");
    expect(refused("acme.com..")).toBe("not_a_name");
  });

  it("stores an international name as punycode, from either spelling", () => {
    expect(ok("bücher.de")).toBe("xn--bcher-kva.de");
    expect(ok("BÜCHER.de")).toBe("xn--bcher-kva.de");
    expect(ok("xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  });

  it("refuses a spelling whose stored form is not the same name as typed (fullwidth letters, a dotted capital I)", () => {
    expect(refused("ａｃｍｅ.com")).toBe("lookalike");
    expect(refused("İstanbul.com")).toBe("lookalike");
  });

  it("keeps the sharp s as a letter of its own: faß.de is not fass.de", () => {
    expect(ok("faß.de")).toBe("xn--fa-hia.de");
    expect(ok("fass.de")).toBe("fass.de");
  });

  it("refuses a label that mixes scripts (a Cyrillic letter among Latin ones)", () => {
    expect(refused("аcme.com")).toBe("lookalike"); // first letter is Cyrillic a
    expect(refused("acmе.com")).toBe("lookalike"); // last letter before the dot is Cyrillic ie
    expect(refused("xn--cme-5cd.com")).toBe("lookalike"); // the same name, already in punycode
  });

  it("refuses broken punycode and punycode that decodes to nothing", () => {
    expect(refused("xn--zz.com")).toBe("not_a_name");
    expect(refused("xn--.com")).toBe("not_a_name");
  });

  it("refuses IP addresses in every spelling", () => {
    for (const ip of ["1.2.3.4", "127.0.0.1", "127.1", "0x7f.0.0.1", "2130706433", "[::1]", "::1", "10.0.0.1.", "999.1.1.1"]) expect(refused(ip), ip).toBe("ip_address");
  });

  it("refuses a public suffix, however it is spelled, and a single label", () => {
    for (const suffix of ["com", "co.uk", "COM", "github.io", "s3.amazonaws.com", "com."]) expect(refused(suffix), suffix).toBe("public_suffix");
    // a name under a public suffix is a company's own
    expect(ok("acme.co.uk")).toBe("acme.co.uk");
    expect(ok("acme.github.io")).toBe("acme.github.io");
  });

  it("refuses what is not a host name: scheme, path, port, user, wildcard, space, underscore, empty label, hyphen at an edge", () => {
    for (const bad of ["https://acme.com", "acme.com/x", "acme.com:8080", "me@acme.com", "*.acme.com", "ac me.com", "ac_me.com", "a..b.com", "-a.com", "a-.com", "acme.com?x", "acme.com#x", "acme.com\\x", "", "   ", "."]) {
      expect(refused(bad), JSON.stringify(bad)).toBe("not_a_name");
    }
  });

  it("refuses a name longer than 253 characters or a label longer than 63", () => {
    expect(refused(`${"a".repeat(64)}.com`)).toBe("not_a_name");
    expect(refused(`${Array.from({ length: 30 }, () => "abcdefgh").join(".")}.com`)).toBe("not_a_name");
    expect(ok(`${"a".repeat(63)}.com`)).toBe(`${"a".repeat(63)}.com`);
  });

  it("refuses a control character and a non-string without throwing", () => {
    expect(refused("acme\u0000.com")).toBe("not_a_name");
    expect(refused("acme\n.com")).toBe("not_a_name");
    expect(normalizeCompanyDomain(undefined as unknown as string)).toEqual({ ok: false, reason: "not_a_name" });
    expect(normalizeCompanyDomain(42 as unknown as string)).toEqual({ ok: false, reason: "not_a_name" });
  });
});

describe("normalizeEmailDomain", () => {
  it("takes the part after the last @ of an address and normalises it the same way", () => {
    expect(normalizeEmailDomain("Maya@ACME.com")).toBe("acme.com");
    expect(normalizeEmailDomain("maya@bücher.de")).toBe("xn--bcher-kva.de");
  });

  it("gives nothing for an address with no domain, a lookalike domain or a public suffix", () => {
    for (const bad of ["maya", "maya@", "@", "maya@com", "maya@ａｃｍｅ.com", "maya@аcme.com", "maya@1.2.3.4"]) expect(normalizeEmailDomain(bad), bad).toBeUndefined();
  });

  it("accepts a bare domain too (the caller may already have split the address)", () => {
    expect(normalizeEmailDomain("Acme.com")).toBe("acme.com");
  });
});
