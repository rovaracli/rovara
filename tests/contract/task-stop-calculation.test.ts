import { expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/web.js";

function invoke(name: string, input: unknown): unknown {
  const candidate: unknown = Reflect.get(contracts, name);
  expect(typeof candidate).toBe("function");
  return (candidate as (value: unknown) => unknown)(input);
}

const M = 1_000_000;
const base = { companyDefaultMicrousd: 10 * M, ceilingMicrousd: 100 * M };
const unavailable = { kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY", enforcement: "not_connected" };
const resolved = (value: number, bindingScopes: string[], usesCompanyDefault: boolean) => ({
  kind: "resolved", effectiveStopMicrousd: value, bindingScopes, usesCompanyDefault, enforcement: "not_connected",
});

it("uses the company default only when neither override exists", () => {
  expect(invoke("calculateTaskStop", base)).toEqual(resolved(10 * M, ["company_default"], true));
});
it("replaces the default with a higher project stop inside the one company ceiling", () => {
  expect(invoke("calculateTaskStop", { ...base, projectStopMicrousd: 20 * M })).toEqual(resolved(20 * M, ["project"], false));
});
it("uses the smaller explicit agent override without reintroducing the lower default", () => {
  expect(invoke("calculateTaskStop", { ...base, projectStopMicrousd: 20 * M, agentStopMicrousd: 15 * M })).toEqual(resolved(15 * M, ["agent"], false));
});
it("applies an agent override alone and caps it at the one ceiling", () => {
  expect(invoke("calculateTaskStop", { ...base, agentStopMicrousd: 150 * M })).toEqual(resolved(100 * M, ["company_ceiling"], false));
});
it("caps a project-only override above the company ceiling", () => {
  expect(invoke("calculateTaskStop", { ...base, projectStopMicrousd: 150 * M })).toEqual(resolved(100 * M, ["company_ceiling"], false));
});
it("caps the default when the company ceiling is lower", () => {
  expect(invoke("calculateTaskStop", { ...base, ceilingMicrousd: 5 * M })).toEqual(resolved(5 * M, ["company_ceiling"], true));
});
it("keeps explicit zero distinct from inheritance and does not make a zero default an extra ceiling", () => {
  expect(invoke("calculateTaskStop", { ...base, projectStopMicrousd: 0 })).toEqual(resolved(0, ["project"], false));
  expect(invoke("calculateTaskStop", { ...base, companyDefaultMicrousd: 0, projectStopMicrousd: 20 * M })).toEqual(resolved(20 * M, ["project"], false));
});
it("reports all tied binding scopes in stable order", () => {
  expect(invoke("calculateTaskStop", { ...base, ceilingMicrousd: 20 * M, projectStopMicrousd: 20 * M, agentStopMicrousd: 20 * M })).toEqual(resolved(20 * M, ["company_ceiling", "project", "agent"], false));
});

for (const [field, scope, usesDefault] of [
  ["companyDefaultMicrousd", "company_default", true],
  ["ceilingMicrousd", "company_ceiling", true],
  ["projectStopMicrousd", "project", false],
  ["agentStopMicrousd", "agent", false],
] as const) {
  it(`normalizes negative zero in ${field} before calculation`, () => {
    expect(invoke("calculateTaskStop", { ...base, [field]: -0 })).toEqual(resolved(0, [scope], usesDefault));
  });
}
for (const field of ["companyDefaultMicrousd", "ceilingMicrousd", "projectStopMicrousd", "agentStopMicrousd"]) {
  for (const bad of [-1, 0.5, NaN, Infinity, 1_000_000_000_001, null, "10"]) {
    it(`refuses corrupt ${field} (${String(bad)}) instead of computing a plausible stop`, () => {
      expect(invoke("calculateTaskStop", { ...base, [field]: bad })).toEqual(unavailable);
    });
  }
}
for (const [scenario, input] of [
  ["empty", {}],
  ["missing default", { ceilingMicrousd: 100 * M }],
  ["missing ceiling", { companyDefaultMicrousd: 10 * M }],
  ["duplicate legacy ceiling", { ...base, maxPerRunCeilingUsd: 1 }],
  ["speculative group", { ...base, scope: { kind: "group", id: "invented" } }],
] as const) {
  it(`refuses incomplete policies (${scenario}), duplicate legacy ceilings or speculative scopes`, () => {
    expect(invoke("calculateTaskStop", input)).toEqual(unavailable);
  });
}
it("accepts the bound and never mutates its supplied policy", () => {
  const input = Object.freeze({ companyDefaultMicrousd: 1_000_000_000_000, ceilingMicrousd: 1_000_000_000_000 });
  expect(invoke("calculateTaskStop", input)).toEqual(resolved(1_000_000_000_000, ["company_ceiling", "company_default"], true));
  expect(input.companyDefaultMicrousd).toBe(1_000_000_000_000);
});

for (const [value, text] of [
  [0, "$0.00"], [1, "$0.000001"], [10, "$0.00001"], [100_000, "$0.10"],
  [1_000_001, "$1.000001"], [1_000_000_000_000, "$1,000,000.00"],
  [Number.MAX_SAFE_INTEGER, "$9,007,199,254.740991"],
] as const) {
  it(`formats integer micros ${value} without a float division`, () => {
    expect(invoke("formatUsdMicrodollars", value)).toBe(text);
  });
}
for (const bad of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
  it(`rejects unsafe or non-integer formatter input (${String(bad)})`, () => {
    expect(() => invoke("formatUsdMicrodollars", bad)).toThrow(RangeError);
  });
}
