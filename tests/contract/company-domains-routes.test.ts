import { describe, expect, it } from "vitest";
import { COMPANY_DOMAIN_LOST_AFTER_DAYS, COMPANY_DOMAIN_MAX_PER_ORG, type OrgId } from "@agentx/contracts";
import { COMPANY_DOMAINS_PER_MINUTE, DOMAIN_REFUSAL_MESSAGES, routeCompanyDomains } from "../../packages/broker/src/aws/developer-routes/company-domains.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import type { TxtLookup, TxtResolver } from "../../packages/broker/src/org/company-domains/resolver.js";
import { addCompanyDomain, claimKey, getClaim, recordValue } from "../../packages/broker/src/org/company-domains/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// The owner-only "Company domains" routes: who may use them, what a change needs first, and that nothing of another company is seen or touched.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const BASE = "/v1/app/org/domains";
const START = Date.UTC(2026, 10, 2, 9, 0, 0);

function world(options: { ledger?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const clock = { at: START };
  const dns = { lookups: [] as string[], script: new Map<string, TxtLookup>() };
  const resolver: TxtResolver = { lookupTxt: async (name) => { dns.lookups.push(name); return dns.script.get(name) ?? { kind: "absent" }; } };
  const deps = {
    documentClient: db, tableName: "state", now: () => clock.at, developer: { signInTableName: "state" },
    ...(options.ledger === false ? {} : { audit: capture.audit }), domainResolver: resolver,
  } as unknown as DeveloperRouteDependencies;
  const caller = (orgId: OrgId, role: DeveloperCaller["orgRole"] = "owner", extra: { browser?: boolean; sessionId?: string } = {}): DeveloperCaller => ({
    developerId: (role === "owner" ? "a" : role === "admin" ? "b" : "c").repeat(64), sessionId: extra.sessionId ?? `session-${orgId}-${role}`, amr: "oidc", name: "Maya", orgId, orgRole: role,
    ...(extra.browser === false ? {} : { browserSession: true as const }),
  });
  const signIn = (who: DeveloperCaller, minutesAgo: number | undefined) => db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", ...(minutesAgo === undefined ? {} : { authTime: new Date(clock.at - minutesAgo * 60_000).toISOString() }) });
  const call = (who: DeveloperCaller, method: string, path: string, body?: unknown) => {
    const request: AdaptedHttpRequest = { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return routeCompanyDomains(deps, who, request, path) as Promise<Record<string, unknown>>;
  };
  return { db, capture, clock, deps, dns, caller, signIn, call };
}

describe("who may use the routes", () => {
  it("answers only an owner, on every route", async () => {
    const w = world();
    for (const role of ["admin", "member"] as const) {
      const who = w.caller(ORG_A, role);
      w.signIn(who, 0);
      for (const [method, path] of [["GET", BASE], ["POST", BASE], ["POST", `${BASE}/check`], ["POST", `${BASE}/remove`]] as const) {
        await expect(w.call(who, method, path, { domain: "acme.example" }), `${role} ${method} ${path}`).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    expect(w.db.find((item) => String(item.pk).startsWith("COMPANY_DOMAIN#"))).toEqual([]);
  });

  it("ignores a path that is not its own, and refuses a method it does not take", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    expect(await w.call(owner, "GET", "/v1/app/org/other")).toBeUndefined();
    await expect(w.call(owner, "PUT", BASE, { domain: "acme.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(w.call(owner, "GET", `${BASE}/check`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(w.call(owner, "DELETE", BASE)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET", () => {
  it("lists the company's domains with the record to publish, and only its own", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const other = w.caller(ORG_B);
    for (const who of [owner, other]) w.signIn(who, 1);
    expect(await w.call(owner, "GET", BASE)).toEqual({ domains: [], max: COMPANY_DOMAIN_MAX_PER_ORG, lostAfterDays: COMPANY_DOMAIN_LOST_AFTER_DAYS });
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    await w.call(other, "POST", BASE, { domain: "other.example" });
    const mine = await w.call(owner, "GET", BASE) as { domains: Array<{ domain: string; state: string; record: { type: string; name: string; value: string } }> };
    expect(mine.domains.map((entry) => entry.domain)).toEqual(["acme.example"]);
    expect(mine.domains[0]).toMatchObject({ state: "pending", record: { type: "TXT", name: "_rovara-verify.acme.example" } });
    expect(mine.domains[0]!.record.value).toMatch(/^rovara-verify=[0-9a-f]{40}$/);
  });

  it("needs no browser session or fresh sign-in", async () => {
    const w = world();
    const owner = w.caller(ORG_A, "owner", { browser: false });
    expect(await w.call(owner, "GET", BASE)).toMatchObject({ domains: [] });
  });
});

describe("POST add", () => {
  it("claims the domain, normalised, and answers with the record", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 1);
    const reply = await w.call(owner, "POST", BASE, { domain: "  ACME.Example. " }) as { domain: { domain: string; state: string; record: { value: string } } };
    expect(reply.domain).toMatchObject({ domain: "acme.example", state: "pending" });
    expect(await getClaim({ documentClient: w.db, tableName: "state", now: w.deps.now }, "acme.example")).toMatchObject({ orgId: ORG_A, claimedBy: owner.developerId });
    expect(w.capture.recordedBy("company_domain.added")).toHaveLength(1);
  });

  it("needs a live browser session", async () => {
    const w = world();
    const owner = w.caller(ORG_A, "owner", { browser: false });
    w.signIn(owner, 0);
    await expect(w.call(owner, "POST", BASE, { domain: "acme.example" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
  });

  it("needs a fresh sign-in, and makes no change without one", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    for (const age of [60, undefined]) {
      w.signIn(owner, age);
      await expect(w.call(owner, "POST", BASE, { domain: "acme.example" }), String(age)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    w.db.delete(`SESSION#${owner.sessionId}`, "META");
    await expect(w.call(owner, "POST", BASE, { domain: "acme.example" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.capture.recordedBy("company_domain.added")).toEqual([]);
  });

  it("is not made on an install with no audit ledger", async () => {
    const w = world({ ledger: false });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await expect(w.call(owner, "POST", BASE, { domain: "acme.example" })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
  });

  it("refuses what is not a company domain with a fixed sentence that does not repeat the input", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const cases: Array<[string, keyof typeof DOMAIN_REFUSAL_MESSAGES]> = [
      ["https://secret-input.example/path", "not_a_name"], ["10.1.2.3", "ip_address"], ["co.uk", "public_suffix"], ["com", "public_suffix"], ["аcme.example", "lookalike"], ["ａｃｍｅ.example", "lookalike"],
    ];
    for (const [input, reason] of cases) {
      const error = await w.call(owner, "POST", BASE, { domain: input }).catch((caught: unknown) => caught as Error);
      expect(error, input).toMatchObject({ code: "CONFIG_INVALID" });
      expect((error as Error).message).toContain(DOMAIN_REFUSAL_MESSAGES[reason]);
      expect((error as Error).message).not.toContain("secret-input");
    }
    expect(w.db.find((item) => String(item.pk).startsWith("COMPANY_DOMAIN#"))).toEqual([]);
  });

  it("refuses a body with another field, a missing domain and a body that is not an object", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    for (const body of [{ domain: "acme.example", orgId: ORG_B }, {}, { domain: 5 }, { domain: "" }, []]) await expect(w.call(owner, "POST", BASE, body), JSON.stringify(body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a domain another company holds without saying whose", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const other = w.caller(ORG_B);
    w.signIn(owner, 0); w.signIn(other, 0);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    const error = await w.call(other, "POST", BASE, { domain: "ACME.example" }).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
    expect((error as Error).message).not.toContain(ORG_A);
    expect(await getClaim({ documentClient: w.db, tableName: "state", now: w.deps.now }, "acme.example")).toMatchObject({ orgId: ORG_A });
  });

  it("is rate limited", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    for (let index = 0; index < COMPANY_DOMAINS_PER_MINUTE; index += 1) await w.call(owner, "POST", BASE, { domain: `d${String(index)}.example` });
    await expect(w.call(owner, "POST", BASE, { domain: "d99.example" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("POST check", () => {
  it("looks at _rovara-verify.<domain> and verifies on the token; no fresh sign-in or ledger needed", async () => {
    const w = world({ ledger: false });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 90);
    // claimed earlier, by a path that had a ledger
    const { claim } = await addCompanyDomain({ documentClient: w.db, tableName: "state", now: w.deps.now }, { orgId: ORG_A, by: owner.developerId, domain: "acme.example" });
    expect(await w.call(owner, "POST", `${BASE}/check`, { domain: "acme.example" })).toMatchObject({ result: "not_found", domain: { state: "pending" } });
    w.dns.script.set("_rovara-verify.acme.example", { kind: "records", records: [recordValue(claim.token)] });
    expect(await w.call(owner, "POST", `${BASE}/check`, { domain: "ACME.example" })).toMatchObject({ result: "found", domain: { state: "verified" } });
    expect(w.dns.lookups).toEqual(["_rovara-verify.acme.example", "_rovara-verify.acme.example"]);
  });

  it("needs a live browser session", async () => {
    const w = world();
    const owner = w.caller(ORG_A, "owner", { browser: false });
    await expect(w.call(owner, "POST", `${BASE}/check`, { domain: "acme.example" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.dns.lookups).toEqual([]);
  });

  it("cannot check another company's domain, and makes no lookup for it", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const other = w.caller(ORG_B);
    w.signIn(owner, 0); w.signIn(other, 0);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    await expect(w.call(other, "POST", `${BASE}/check`, { domain: "acme.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.dns.lookups).toEqual([]);
  });

  it("is rate limited, since each check is a DNS lookup", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    // the add took one of the minute's tries
    for (let index = 0; index < COMPANY_DOMAINS_PER_MINUTE - 1; index += 1) await w.call(owner, "POST", `${BASE}/check`, { domain: "acme.example" });
    await expect(w.call(owner, "POST", `${BASE}/check`, { domain: "acme.example" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(w.dns.lookups).toHaveLength(COMPANY_DOMAINS_PER_MINUTE - 1);
    w.clock.at += 61_000;
    await w.call(owner, "POST", `${BASE}/check`, { domain: "acme.example" });
  });
});

describe("POST remove", () => {
  it("removes the company's domain with a fresh sign-in and a ledger", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 1);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    expect(await w.call(owner, "POST", `${BASE}/remove`, { domain: "acme.example" })).toEqual({ removed: true });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.capture.recordedBy("company_domain.removed")).toHaveLength(1);
  });

  it("changes nothing without a fresh sign-in, a browser session or a ledger", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 1);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    w.signIn(owner, 60);
    await expect(w.call(owner, "POST", `${BASE}/remove`, { domain: "acme.example" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    w.signIn(owner, 1);
    await expect(w.call(w.caller(ORG_A, "owner", { browser: false, sessionId: owner.sessionId }), "POST", `${BASE}/remove`, { domain: "acme.example" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.db.get(claimKey("acme.example"))).toBeDefined();
    const noLedger = world({ ledger: false });
    const same = noLedger.caller(ORG_A);
    noLedger.signIn(same, 0);
    noLedger.db.set({ ...w.db.get(claimKey("acme.example"))! });
    await expect(noLedger.call(same, "POST", `${BASE}/remove`, { domain: "acme.example" })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(noLedger.db.get(claimKey("acme.example"))).toBeDefined();
  });

  it("cannot remove another company's domain", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const other = w.caller(ORG_B);
    w.signIn(owner, 0); w.signIn(other, 0);
    await w.call(owner, "POST", BASE, { domain: "acme.example" });
    await expect(w.call(other, "POST", `${BASE}/remove`, { domain: "acme.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.db.get(claimKey("acme.example"))).toMatchObject({ orgId: ORG_A });
  });
});
