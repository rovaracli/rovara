import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Enterprise foundations M-6 (fix round 1): the entry points are module-level code no harness runs, so what they hand to the handlers is pinned here. Deleting one of these
// lines would leave the edition's gates off with every behavioural test still green.

const source = (path: string) => readFileSync(new URL(`../../packages/broker/src/aws/${path}`, import.meta.url), "utf8");

describe("broker.ts hands the broker its edition, stores, plug-ins and guard", () => {
  const broker = source("broker.ts");
  // Since lessons-prod-2 the handler is built from a named `brokerInput` object (so the worker entry can share the same input); pin that object's text, and that the handler is made from it.
  const handlerCall = broker.slice(broker.indexOf("const brokerInput: AwsBrokerInput = {"));
  it.each([
    ["the edition policy", /\.\.\.\(editionPolicy === undefined \? \{\} : \{ editionPolicy \}\)/],
    ["the company sign-in stores", /\.\.\.\(ssoStores === undefined \? \{\} : \{ sso: ssoStores \}\)/],
    ["the edition guard", /editionGuard: createEditionGuard\(\{ stamp: editionPolicy\?\.edition/],
    ["the code host router and check runners", /codeHost: plugins\.codeHost, checkRunner: plugins\.checkRunner/],
    ["the audit ledger", /\.\.\.\(audit === undefined \? \{\} : \{ audit \}\)/],
  ])("passes %s to the handler", (_name, pattern) => {
    expect(handlerCall).toMatch(pattern);
  });

  it("builds the handler from that same input", () => {
    expect(broker).toMatch(/export const handler = createAwsBrokerHandler\(brokerInput\);/);
  });

  it("reads the edition from the stamp only (never derived from the cloud flag) and builds the stores from it", () => {
    expect(broker).toMatch(/const editionPolicy = installEditionPolicy\(process\.env, cloudOrgResolver !== undefined\);/);
    expect(broker).toMatch(/const ssoStores = ssoStoresFor\(\{[^}]*policy: editionPolicy/);
  });
});

describe("the sign-in Lambda hands its handler the edition, the stores, the ledger and the guard", () => {
  const identity = source("developer-identity.ts");
  // What the handler is given is assembled by buildDependencies (build() only passes it to createDeveloperIdentityHandler), so the wiring is read from there.
  const handlerCall = identity.slice(identity.indexOf("export function buildDependencies"), identity.indexOf("export const handler"));
  it("reads the wiring from a non-empty slice", () => {
    expect(handlerCall).toContain("return {\n    config,");
    expect(identity).toMatch(/createDeveloperIdentityHandler\(buildDependencies\(env\)\)/);
  });
  it.each([
    ["the edition policy", /\.\.\.\(editionPolicy === undefined \? \{\} : \{ editionPolicy \}\)/],
    ["the company sign-in stores", /\.\.\.\(ssoStores === undefined \? \{\} : \{ sso: ssoStores \}\)/],
    ["the audit ledger", /\.\.\.\(audit === undefined \? \{\} : \{ audit \}\)/],
  ])("passes %s", (_name, pattern) => {
    expect(handlerCall).toMatch(pattern);
  });

  it("reads the stamp with the cloud method as the cross-check, builds the stores from it and runs the guard before every request", () => {
    expect(identity).toMatch(/const editionPolicy = installEditionPolicy\(env, config\.cloud !== undefined\);/);
    expect(identity).toMatch(/const ssoStores = ssoStoresFor\(\{[^}]*policy: editionPolicy/);
    expect(identity).toMatch(/built \?\?= build\(process\.env\);\n {2}await editionGuard\?\.\(\);/);
  });
});

describe("handler.ts puts the edition and the stores into the route dependencies", () => {
  const handler = source("broker/handler.ts");
  it("all three route-dependency builders carry the edition policy, and the main one the stores", () => {
    // Spread from the one function that passes the broker's edition on (wiring/enterprise-identity.ts routeEditionDependencies; its own test pins what it returns).
    // Three builders: the two developer-route builders, and the Slack decision-card press (added with 011d99500: a press meets the edition's sign-in rules, so its route
    // dependencies need the policy too). Replaces the earlier count of two.
    expect(handler.match(/\.\.\.routeEditionDependencies\(dependencies\)/g)?.length).toBe(3);
    expect(handler).toMatch(/handleSlackDecisionPress\(dependencies, \{[^\n]*\.\.\.routeEditionDependencies\(dependencies\)/);
    expect(handler).toMatch(/sso: dependencies\.sso/);
    expect(handler).toMatch(/requireStaffRouteAllowed\(dependencies\.editionPolicy, url\.pathname\);/);
    expect(handler).toMatch(/await dependencies\.editionGuard\?\.\(\);/);
  });
});
