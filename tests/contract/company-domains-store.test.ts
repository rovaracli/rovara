import { describe, expect, it } from "vitest";
import { COMPANY_DOMAIN_MAX_PER_ORG, orgMetaKey, type OrgId } from "@agentx/contracts";
import {
  COMPANY_DOMAIN_RECHECK_PK, addCompanyDomain, applyCheck, checkCompanyDomain, claimKey, getClaim, isVerifiedCompanyDomain, listClaims, pointerKey, recheckDueDomains, recordValue, removeCompanyDomain, resultOf, toView,
  type ClaimRecord, type CompanyDomainDeps,
} from "../../packages/broker/src/org/company-domains/store.js";
import type { TxtLookup, TxtResolver } from "../../packages/broker/src/org/company-domains/resolver.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Company domain verification: one domain, one company; verified only by the exact token; lost after three days with no record; a failed lookup never counts against a company.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MAYA = "a".repeat(64);
const OMAR = "b".repeat(64);
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 2, 9, 0, 0);

function world() {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const clock = { at: START };
  const deps: CompanyDomainDeps = { documentClient: db, tableName: "state", now: () => clock.at, audit: capture.audit };
  const dns = { lookups: [] as string[], script: new Map<string, TxtLookup>(), fallback: { kind: "absent" } as TxtLookup };
  const resolver: TxtResolver = { lookupTxt: async (name) => { dns.lookups.push(name); return dns.script.get(name) ?? dns.fallback; } };
  const publish = (domain: string, token: string) => dns.script.set(`_rovara-verify.${domain}`, { kind: "records", records: ["v=spf1 -all", recordValue(token)] });
  const withdraw = (domain: string) => dns.script.delete(`_rovara-verify.${domain}`);
  return { db, capture, clock, deps, dns, resolver, publish, withdraw };
}

describe("addCompanyDomain", () => {
  it("claims a domain as pending with a random token, a pointer for the company's list, a daily check due and an audit record naming the domain in details only", async () => {
    const w = world();
    const added = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    expect(added).toMatchObject({ created: true, tookOver: false, claim: { state: "pending", domain: "acme.example", orgId: ORG_A, claimedBy: MAYA } });
    expect(added.claim.token).toMatch(/^[0-9a-f]{40}$/);
    expect(w.db.get(claimKey("acme.example"))).toMatchObject({ orgId: ORG_A, dispatchDuePk: COMPANY_DOMAIN_RECHECK_PK });
    expect(w.db.get(pointerKey(ORG_A, "acme.example"))).toBeDefined();
    const [event] = w.capture.recordedBy("company_domain.added");
    expect(event).toMatchObject({ orgId: ORG_A, actor: { kind: "member", id: MAYA }, facts: { tookOver: false }, details: [{ subject: "org", fields: { domain: "acme.example" } }] });
    expect(JSON.stringify(event?.facts)).not.toContain("acme");
    // the record and the audit item were one transaction
    expect(w.db.transactions().at(-1)?.some((entry) => JSON.stringify(entry).includes("AUDIT_PENDING"))).toBe(true);
  });

  it("gives two claims two different tokens", async () => {
    const w = world();
    const first = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    const second = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.test.example" });
    expect(first.claim.token).not.toBe(second.claim.token);
  });

  it("returns a domain the company already holds as it is, with the same token and no second audit record", async () => {
    const w = world();
    const first = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    const again = await addCompanyDomain(w.deps, { orgId: ORG_A, by: OMAR, domain: "acme.example" });
    expect(again).toMatchObject({ created: false, claim: { token: first.claim.token } });
    expect(w.capture.recordedBy("company_domain.added")).toHaveLength(1);
  });

  it("refuses a domain another company holds, pending or verified, and leaves the holder's claim untouched", async () => {
    const w = world();
    const held = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    w.clock.at += 2 * DAY;
    await expect(addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
    expect(await getClaim(w.deps, "acme.example")).toMatchObject({ orgId: ORG_A, token: held.claim.token, version: 1 });
    expect(w.db.get(pointerKey(ORG_B, "acme.example"))).toBeUndefined();

    w.publish("acme.example", held.claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    w.clock.at += 400 * DAY;
    await expect(addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
    expect((await getClaim(w.deps, "acme.example"))?.orgId).toBe(ORG_A);
    expect(w.capture.recordedBy("company_domain.added")).toHaveLength(1);
  });

  it("lets only one of two companies that claim the same domain at the same moment win", async () => {
    const w = world();
    const results = await Promise.allSettled([
      addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "race.example" }),
      addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "race.example" }),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
    const winner = (await getClaim(w.deps, "race.example"))!.orgId;
    // exactly one pointer, the winner's
    expect([ORG_A, ORG_B].filter((org) => w.db.get(pointerKey(org, "race.example")) !== undefined)).toEqual([winner]);
  });

  it("lets another company take over a claim nobody verified in seven days, with a new token, and drops the old pointer", async () => {
    const w = world();
    const first = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    w.clock.at += 7 * DAY - 1000;
    await expect(addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
    w.clock.at += 2000;
    const taken = await addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" });
    expect(taken).toMatchObject({ created: true, tookOver: true, claim: { orgId: ORG_B, state: "pending" } });
    expect(taken.claim.token).not.toBe(first.claim.token);
    expect(w.db.get(pointerKey(ORG_A, "acme.example"))).toBeUndefined();
    expect(w.capture.recordedBy("company_domain.added").at(-1)).toMatchObject({ orgId: ORG_B, facts: { tookOver: true } });
    // the first company's old token proves nothing for the second
    w.publish("acme.example", first.claim.token);
    const check = await checkCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example", resolver: w.resolver });
    expect(check.result).toBe("not_found");
  });

  it("lets another company take over a lost domain, but never a verified one", async () => {
    const w = world();
    const held = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    w.publish("acme.example", held.claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    w.withdraw("acme.example");
    for (let day = 0; day < 4; day += 1) { await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver }); w.clock.at += DAY; }
    expect((await getClaim(w.deps, "acme.example"))?.state).toBe("lost");
    const taken = await addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" });
    expect(taken.tookOver).toBe(true);
  });

  it("lets another company take over a domain whose holder has closed", async () => {
    const w = world();
    w.db.set({ ...orgMetaKey(ORG_A), closedAt: new Date(START).toISOString() });
    await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "gone.example" });
    expect((await addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "gone.example" })).tookOver).toBe(true);
  });

  it("does not read a holder with no record as closed", async () => {
    const w = world();
    await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    await expect(addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "COMPANY_DOMAIN_TAKEN" });
  });

  it("holds a company to its limit", async () => {
    const w = world();
    for (let index = 0; index < COMPANY_DOMAIN_MAX_PER_ORG; index += 1) await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: `d${String(index)}.example` });
    await expect(addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "one-too-many.example" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // another company is not held to it
    await addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "d0b.example" });
  });
});

describe("removeCompanyDomain", () => {
  it("removes the company's own claim and pointer with an audit record", async () => {
    const w = world();
    await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    await removeCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.db.get(pointerKey(ORG_A, "acme.example"))).toBeUndefined();
    expect(w.capture.recordedBy("company_domain.removed")[0]).toMatchObject({ facts: { wasState: "pending" }, details: [{ fields: { domain: "acme.example" } }] });
    // free to claim again, by anyone
    expect((await addCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).created).toBe(true);
  });

  it("cannot remove another company's domain, and says only that it is not theirs", async () => {
    const w = world();
    const held = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    await expect(removeCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "never-claimed.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getClaim(w.deps, "acme.example")).toMatchObject({ orgId: ORG_A, token: held.claim.token });
    expect(w.db.get(pointerKey(ORG_A, "acme.example"))).toBeDefined();
    expect(w.capture.recordedBy("company_domain.removed")).toHaveLength(0);
  });
});

describe("checkCompanyDomain", () => {
  const claimed = async (w: ReturnType<typeof world>, domain = "acme.example", org = ORG_A) => (await addCompanyDomain(w.deps, { orgId: org, by: MAYA, domain })).claim;

  it("verifies on the exact token, once, with an audit record by the person who pressed the button", async () => {
    const w = world();
    const claim = await claimed(w);
    w.publish("acme.example", claim.token);
    const checked = await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    expect(checked).toMatchObject({ result: "found", claim: { state: "verified", verifiedAt: new Date(START).toISOString() } });
    expect(w.dns.lookups).toEqual(["_rovara-verify.acme.example"]);
    expect(w.capture.recordedBy("company_domain.verified")).toHaveLength(1);
    expect(w.capture.recordedBy("company_domain.verified")[0]).toMatchObject({ actor: { kind: "member", id: MAYA }, facts: { wasState: "pending" } });
    // a second check changes no state and records nothing more
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    expect(w.capture.recordedBy("company_domain.verified")).toHaveLength(1);
  });

  it("does not verify on anything but the whole record equal to the token", async () => {
    const w = world();
    const claim = await claimed(w);
    const wrong = [
      [`${recordValue(claim.token)}x`], [`x${recordValue(claim.token)}`], [recordValue(claim.token).toUpperCase()], [`rovara-verify= ${claim.token}`], [claim.token], [`rovara-verify=${claim.token.slice(0, 39)}`],
      [`rovara-verify=${"0".repeat(40)}`], [`v=spf1 include:${recordValue(claim.token)} -all`], [`rovara-verify=${claim.token},rovara-verify=${"1".repeat(40)}`], [""],
    ];
    for (const records of wrong) {
      w.dns.script.set("_rovara-verify.acme.example", { kind: "records", records });
      const checked = await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
      expect(checked, JSON.stringify(records)).toMatchObject({ result: "not_found", claim: { state: "pending" } });
    }
  });

  it("accepts the right record among others, and with spaces around it", async () => {
    const w = world();
    const claim = await claimed(w);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "records", records: ["something else", ` ${recordValue(claim.token)} `] });
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver })).result).toBe("found");
  });

  it("does not take another domain's token, even the same company's", async () => {
    const w = world();
    const first = await claimed(w, "one.example");
    await claimed(w, "two.example");
    w.dns.script.set("_rovara-verify.two.example", { kind: "records", records: [recordValue(first.token)] });
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "two.example", resolver: w.resolver })).result).toBe("not_found");
  });

  it("cannot check a domain the company does not hold (no lookup is made)", async () => {
    const w = world();
    await claimed(w);
    await expect(checkCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example", resolver: w.resolver })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(checkCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "unknown.example", resolver: w.resolver })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.dns.lookups).toEqual([]);
  });

  it("reports an alias as 'indirect' and a failed lookup as 'unavailable', verifying neither", async () => {
    const w = world();
    await claimed(w);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "indirect" });
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver }))).toMatchObject({ result: "indirect", claim: { state: "pending", lastResult: "indirect" } });
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver }))).toMatchObject({ result: "unavailable", claim: { state: "pending", lastResult: "unavailable" } });
  });

  it("treats a resolver that throws as a failed lookup", async () => {
    const w = world();
    await claimed(w);
    const throwing: TxtResolver = { lookupTxt: async () => { throw new Error("boom"); } };
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: throwing })).result).toBe("unavailable");
  });

  it("returns the claim as it now is when it changed during the lookup, and writes nothing over it", async () => {
    const w = world();
    const claim = await claimed(w);
    const slow: TxtResolver = { lookupTxt: async () => {
      // someone verifies the domain while this lookup is out
      w.publish("acme.example", claim.token);
      await checkCompanyDomain(w.deps, { orgId: ORG_A, by: OMAR, domain: "acme.example", resolver: w.resolver });
      return { kind: "absent" };
    } };
    const outcome = await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: slow });
    expect(outcome.changed).toBe(false);
    expect(outcome.claim.state).toBe("verified");
    expect((await getClaim(w.deps, "acme.example"))?.state).toBe("verified");
  });
});

describe("the three days", () => {
  async function verified(w: ReturnType<typeof world>) {
    const claim = (await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" })).claim;
    w.publish("acme.example", claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    return claim;
  }
  const dailyCheck = (w: ReturnType<typeof world>) => recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 5000 });

  it("a verified domain whose record is gone stays verified for two daily checks and is lost on the third day, with an audit record by the system", async () => {
    const w = world();
    await verified(w);
    w.withdraw("acme.example");
    const states: string[] = [];
    for (let day = 1; day <= 4; day += 1) {
      w.clock.at += DAY;
      await dailyCheck(w);
      states.push((await getClaim(w.deps, "acme.example"))!.state);
    }
    // day 1 starts the clock; day 2 and 3 are one and two days gone; day 4 is three days gone
    expect(states).toEqual(["verified", "verified", "verified", "lost"]);
    expect(w.capture.recordedBy("company_domain.lost")).toHaveLength(1);
    expect(w.capture.recordedBy("company_domain.lost")[0]).toMatchObject({ actor: { kind: "system" }, facts: { missingDays: 3 } });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });

  it("a lookup that fails does not start or advance the clock, and is tried again within the hour", async () => {
    const w = world();
    await verified(w);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    for (let day = 1; day <= 6; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect(await getClaim(w.deps, "acme.example")).toMatchObject({ state: "verified", lastResult: "unavailable" });
    expect((await getClaim(w.deps, "acme.example"))?.missingSince).toBeUndefined();
    // due again in an hour, not a day
    const due = (await getClaim(w.deps, "acme.example"))!.dispatchDueSk!;
    expect(Number(due.split("#")[0])).toBe(w.clock.at + 3_600_000);
  });

  it("the record coming back before the third day clears the clock", async () => {
    const w = world();
    const claim = await verified(w);
    w.withdraw("acme.example");
    for (let day = 1; day <= 2; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await getClaim(w.deps, "acme.example"))?.missingSince).toBeDefined();
    w.publish("acme.example", claim.token);
    w.clock.at += DAY;
    await dailyCheck(w);
    expect(await getClaim(w.deps, "acme.example")).toMatchObject({ state: "verified" });
    expect((await getClaim(w.deps, "acme.example"))?.missingSince).toBeUndefined();
    w.withdraw("acme.example");
    w.clock.at += DAY; await dailyCheck(w);
    w.clock.at += DAY; await dailyCheck(w);
    expect((await getClaim(w.deps, "acme.example"))?.state).toBe("verified");
  });

  it("an alias in place of the record counts as the record being gone", async () => {
    const w = world();
    await verified(w);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "indirect" });
    for (let day = 1; day <= 4; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await getClaim(w.deps, "acme.example"))?.state).toBe("lost");
  });

  it("a lost domain is verified again when its record returns", async () => {
    const w = world();
    const claim = await verified(w);
    w.withdraw("acme.example");
    for (let day = 1; day <= 4; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await getClaim(w.deps, "acme.example"))?.state).toBe("lost");
    w.publish("acme.example", claim.token);
    w.clock.at += DAY;
    await dailyCheck(w);
    expect(await getClaim(w.deps, "acme.example")).toMatchObject({ state: "verified" });
    expect(w.capture.recordedBy("company_domain.verified").at(-1)).toMatchObject({ facts: { wasState: "lost" } });
  });

  it("only looks at domains that are due, not before", async () => {
    const w = world();
    await verified(w);
    const before = w.dns.lookups.length;
    w.clock.at += DAY - 1000;
    expect(await dailyCheck(w)).toMatchObject({ checked: 0 });
    expect(w.dns.lookups.length).toBe(before);
    w.clock.at += 2000;
    expect(await dailyCheck(w)).toMatchObject({ checked: 1 });
  });

  it("stops watching a claim nobody verified within its seven days", async () => {
    const w = world();
    await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    for (let day = 1; day <= 9; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await getClaim(w.deps, "acme.example"))?.dispatchDuePk).toBeUndefined();
  });

  it("releases the claim of a closed company instead of looking at it", async () => {
    const w = world();
    await verified(w);
    w.db.set({ ...orgMetaKey(ORG_A), closedAt: new Date(w.clock.at).toISOString() });
    w.clock.at += DAY;
    expect(await dailyCheck(w)).toMatchObject({ released: 1, checked: 0 });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.db.get(pointerKey(ORG_A, "acme.example"))).toBeUndefined();
  });

  it("is bounded by its limit and its time budget", async () => {
    const w = world();
    for (let index = 0; index < 8; index += 1) await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: `d${String(index)}.example` });
    w.clock.at += DAY;
    expect(await recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 5000, limit: 3 })).toMatchObject({ checked: 3 });
    expect(await recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 0, limit: 3 })).toMatchObject({ checked: 0 });
  });
});

describe("isVerifiedCompanyDomain", () => {
  it("is true for the company's verified domain, with any case, an address or a bare domain", async () => {
    const w = world();
    const claim = (await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" })).claim;
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "acme.example")).toBe(false); // pending
    w.publish("acme.example", claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    for (const form of ["acme.example", "ACME.Example", "maya@acme.example", "Maya.Rao@ACME.EXAMPLE", "maya@acme.example."]) expect(await isVerifiedCompanyDomain(w.deps, ORG_A, form), form).toBe(true);
  });

  it("is false for another company, for a subdomain, for a lookalike and for something that is not a domain", async () => {
    const w = world();
    const claim = (await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" })).claim;
    w.publish("acme.example", claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    const no = ["maya@mail.acme.example", "maya@acme.example.evil.example", "maya@acme-example.com", "maya@аcme.example", "maya@ａcme.example", "maya@xn--cme-5cd.example", "maya", "", "maya@", "@", "maya@1.2.3.4", "maya@example"];
    for (const form of no) expect(await isVerifiedCompanyDomain(w.deps, ORG_A, form), form).toBe(false);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_B, "maya@acme.example")).toBe(false);
  });

  it("is false once the domain is lost or removed", async () => {
    const w = world();
    const claim = (await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" })).claim;
    w.publish("acme.example", claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    await removeCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });

  it("is false for a domain another company took over", async () => {
    const w = world();
    const claim = (await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" })).claim;
    w.publish("acme.example", claim.token);
    await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: w.resolver });
    // a stray pointer for company B does not make the domain B's
    w.db.set({ ...pointerKey(ORG_B, "acme.example"), entityType: "COMPANY_DOMAIN_POINTER", orgId: ORG_B, domain: "acme.example" });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_B, "maya@acme.example")).toBe(false);
    expect(await listClaims(w.deps, ORG_B)).toEqual([]);
  });

  it("is false for a stored claim it cannot read", async () => {
    const w = world();
    w.db.set({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "verified", token: "short", version: 1, claimedAt: new Date(START).toISOString() });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
    w.db.set({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "verified-ish", token: "a".repeat(40), version: 1, claimedAt: new Date(START).toISOString() });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });
});

describe("the pure parts", () => {
  const base = (): ClaimRecord => ({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "pending", token: "c".repeat(40), version: 1, claimedAt: new Date(START).toISOString(), claimedBy: MAYA });

  it("resultOf reads only the whole record", () => {
    const token = "c".repeat(40);
    expect(resultOf({ kind: "records", records: [recordValue(token)] }, token)).toBe("found");
    expect(resultOf({ kind: "records", records: [`${recordValue(token)}0`] }, token)).toBe("not_found");
    expect(resultOf({ kind: "records", records: [] }, token)).toBe("not_found");
    expect(resultOf({ kind: "absent" }, token)).toBe("not_found");
    expect(resultOf({ kind: "indirect" }, token)).toBe("indirect");
    expect(resultOf({ kind: "unavailable" }, token)).toBe("unavailable");
  });

  it("applyCheck bumps the version and keeps a pending claim pending when the record is not found", () => {
    const { next, transition } = applyCheck(base(), "not_found", START + DAY);
    expect(next).toMatchObject({ state: "pending", version: 2, lastResult: "not_found" });
    expect(transition).toBeUndefined();
  });

  it("toView gives the record to publish and no token anywhere else", () => {
    const view = toView(base());
    expect(view.record).toEqual({ type: "TXT", name: "_rovara-verify.acme.example", value: `rovara-verify=${"c".repeat(40)}` });
    expect(JSON.stringify({ ...view, record: undefined })).not.toContain("c".repeat(40));
    expect(view.expiresAt).toBe(new Date(START + 7 * DAY).toISOString());
  });
});
