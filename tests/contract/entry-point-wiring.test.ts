import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Enterprise foundations M-6 (fix round 1): the entry points are module-level code no harness runs, so what they hand to the handlers is pinned here. Deleting one of these
// lines would leave the edition's gates off with every behavioural test still green.

const source = (path: string) => readFileSync(new URL(`../../packages/broker/src/aws/${path}`, import.meta.url), "utf8");

describe("broker.ts hands the broker its edition, stores, plug-ins and guard", () => {
  const broker = source("broker.ts");
  const handlerCall = broker.slice(broker.indexOf("export const handler = createAwsBrokerHandler({"));
  it.each([
    ["the edition policy", /\.\.\.\(editionPolicy === undefined \? \{\} : \{ editionPolicy \}\)/],
    ["the company sign-in stores", /\.\.\.\(ssoStores === undefined \? \{\} : \{ sso: ssoStores \}\)/],
    ["the edition guard", /editionGuard: createEditionGuard\(\{ stamp: editionPolicy\?\.edition/],
    ["the code host router and check runners", /codeHost: plugins\.codeHost, checkRunner: plugins\.checkRunner/],
    ["the audit ledger", /\.\.\.\(audit === undefined \? \{\} : \{ audit \}\)/],
  ])("passes %s to the handler", (_name, pattern) => {
    expect(handlerCall).toMatch(pattern);
  });

  it("reads the edition from the stamp only (never derived from the cloud flag) and builds the stores from it", () => {
    expect(broker).toMatch(/const editionPolicy = installEditionPolicy\(process\.env, cloudOrgResolver !== undefined\);/);
    expect(broker).toMatch(/const ssoStores = ssoStoresFor\(\{[^}]*policy: editionPolicy/);
  });
});

describe("the sign-in Lambda hands its handler the edition, the stores, the ledger and the guard", () => {
  const identity = source("developer-identity.ts");
  const handlerCall = identity.slice(identity.indexOf("return createDeveloperIdentityHandler({"));
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
  it("both route-dependency builders carry the edition policy, and the main one the stores", () => {
    expect(handler.match(/editionPolicy: dependencies\.editionPolicy/g)?.length).toBe(2);
    expect(handler).toMatch(/sso: dependencies\.sso/);
    expect(handler).toMatch(/requireStaffRouteAllowed\(dependencies\.editionPolicy, url\.pathname\);/);
    expect(handler).toMatch(/await dependencies\.editionGuard\?\.\(\);/);
  });
});
