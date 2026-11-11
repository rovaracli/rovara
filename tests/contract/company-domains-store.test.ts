import { describe, expect, it } from "vitest";
import { COMPANY_DOMAIN_MAX_PER_ORG, COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS, orgMetaKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import {
  COMPANY_DOMAIN_RECHECK_PK, addCompanyDomain, applyCheck, checkCompanyDomain, claimKey, getClaim, getEntry, getOwn, isVerifiedCompanyDomain, listEntries, ownKey, recheckDueDomains, recordValue, removeCompanyDomain, resultOf, toView,
  type ClaimRecord, type CompanyDomainDeps,
} from "../../packages/broker/src/org/company-domains/store.js";
import type { TxtLookup, TxtResolver } from "../../packages/broker/src/org/company-domains/resolver.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Company domain verification: a claim with no proof blocks nobody; the first company to PROVE a domain holds it; a verified holder keeps it; a lost one moves only on the newcomer's proof alone, confirmed an
// hour apart; a lookup that fails never counts against a company.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ORG_X = "org_xxxxxxxxxxxxxxxxxxxx" as OrgId;
const MAYA = "a".repeat(64);
const OMAR = "b".repeat(64);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 2, 9, 0, 0);

function world() {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const clock = { at: START };
  const deps: CompanyDomainDeps = { documentClient: db, tableName: "state", now: () => clock.at, audit: capture.audit };
  const dns = { lookups: [] as string[], script: new Map<string, TxtLookup>() };
  const resolver: TxtResolver = { lookupTxt: async (name) => { dns.lookups.push(name); return dns.script.get(name) ?? { kind: "absent" }; } };
  /** What DNS shows for the domain: the records of these tokens (plus an unrelated record). */
  const publish = (domain: string, ...tokens: string[]) => dns.script.set(`_rovara-verify.${domain}`, { kind: "records", records: ["v=spf1 -all", ...tokens.map(recordValue)] });
  const withdraw = (domain: string) => dns.script.delete(`_rovara-verify.${domain}`);
  const add = async (org: OrgId, domain = "acme.example", by = MAYA) => (await addCompanyDomain(deps, { orgId: org, by, domain })).entry.own;
  const check = (org: OrgId, domain = "acme.example", by = MAYA) => checkCompanyDomain(deps, { orgId: org, by, domain, resolver });
  const holderOf = (domain = "acme.example") => getClaim(deps, domain);
  /** Company A proves the domain. */
  const prove = async (org: OrgId, domain = "acme.example") => { const own = await add(org, domain); publish(domain, own.token); await check(org, domain); return own; };
  const loseIt = async (org: OrgId, domain = "acme.example") => {
    withdraw(domain);
    for (let day = 0; day < 4; day += 1) { clock.at += DAY; await check(org, domain, "system"); }
  };
  return { db, capture, clock, deps, dns, resolver, publish, withdraw, add, check, holderOf, prove, loseIt };
}

describe("addCompanyDomain: a claim with no proof blocks nobody", () => {
  it("makes the company's own claim with a random token, a due check and an audit record naming the domain in details only, and no holder", async () => {
    const w = world();
    const added = await addCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    expect(added).toMatchObject({ created: true, entry: { own: { orgId: ORG_A, domain: "acme.example", claimedBy: MAYA, version: 1 } } });
    expect(added.entry.own.token).toMatch(/^[0-9a-f]{40}$/);
    expect(added.entry.holder).toBeUndefined();
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.db.get(ownKey(ORG_A, "acme.example"))).toMatchObject({ dispatchDuePk: COMPANY_DOMAIN_RECHECK_PK });
    const [event] = w.capture.recordedBy("company_domain.added");
    expect(event).toMatchObject({ orgId: ORG_A, actor: { kind: "member", id: MAYA }, details: [{ subject: "org", fields: { domain: "acme.example" } }] });
    expect(JSON.stringify(event?.facts ?? {})).not.toContain("acme");
    expect(w.db.transactions().at(-1)?.some((entry) => JSON.stringify(entry).includes("AUDIT_PENDING"))).toBe(true);
  });

  it("spreads the first look over the day after the claim, by the domain", async () => {
    const w = world();
    const dues: number[] = [];
    for (const domain of ["a1.example", "a2.example", "a3.example", "a4.example", "a5.example", "a6.example"]) {
      dues.push(Number((await w.add(ORG_A, domain)).dispatchDueSk!.split("#")[0]) - START);
    }
    for (const due of dues) { expect(due).toBeGreaterThanOrEqual(HOUR); expect(due).toBeLessThan(24 * HOUR); }
    expect(new Set(dues).size).toBeGreaterThan(3);
  });

  it("gives two claims two different tokens and keeps one claim's token for good", async () => {
    const w = world();
    const first = await w.add(ORG_A, "one.example");
    const second = await w.add(ORG_A, "two.example");
    expect(first.token).not.toBe(second.token);
    const again = await addCompanyDomain(w.deps, { orgId: ORG_A, by: OMAR, domain: "one.example" });
    expect(again).toMatchObject({ created: false, entry: { own: { token: first.token } } });
    expect(w.capture.recordedBy("company_domain.added")).toHaveLength(2);
    w.publish("one.example", first.token);
    await w.check(ORG_A, "one.example");
    w.clock.at += 40 * DAY;
    expect((await getOwn(w.deps, ORG_A, "one.example"))?.token).toBe(first.token);
  });

  it("lets any number of companies add the same domain, each with its own token; none is refused and none is blocked", async () => {
    const w = world();
    const a = await w.add(ORG_A);
    const x = await w.add(ORG_X, "acme.example", OMAR);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    expect(new Set([a.token, x.token, b.token]).size).toBe(3);
    expect(await w.holderOf()).toBeUndefined();
    expect((await listEntries(w.deps, ORG_A)).map((entry) => entry.own.token)).toEqual([a.token]);
    // a week later nobody has been displaced and nothing has expired into anyone's hands
    w.clock.at += 30 * DAY;
    expect((await getOwn(w.deps, ORG_A, "acme.example"))?.token).toBe(a.token);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_X, "p@acme.example")).toBe(false);
  });

  it("holds a company to its limit", async () => {
    const w = world();
    for (let index = 0; index < COMPANY_DOMAIN_MAX_PER_ORG; index += 1) await w.add(ORG_A, `d${String(index)}.example`);
    await expect(w.add(ORG_A, "one-too-many.example")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await w.add(ORG_B, "d0b.example", OMAR);
  });
});

describe("the first company to prove a domain holds it", () => {
  it("makes the company the holder when its own token is found, with an audit record, and not before", async () => {
    const w = world();
    const own = await w.add(ORG_A);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
    w.publish("acme.example", own.token);
    const checked = await w.check(ORG_A);
    expect(checked).toMatchObject({ result: "found", changed: true, entry: { holder: { orgId: ORG_A, state: "verified", token: own.token, version: 1 } } });
    expect(toView(checked.entry)).toMatchObject({ state: "verified" });
    expect(w.capture.recordedBy("company_domain.verified")[0]).toMatchObject({ actor: { kind: "member", id: MAYA }, facts: { wasState: "pending", tookOver: false } });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(true);
    // a second look changes no state and records nothing more
    await w.check(ORG_A);
    expect(w.capture.recordedBy("company_domain.verified")).toHaveLength(1);
  });

  it("is not stopped by a squatter who added the domain first, again and again, from many companies", async () => {
    const w = world();
    for (const squatter of [ORG_X, ORG_B]) await w.add(squatter, "acme.example", OMAR);
    w.clock.at += 20 * DAY;
    for (const squatter of [ORG_X, ORG_B]) { await w.check(squatter); await w.add(squatter, "acme.example", OMAR); }
    const real = await w.prove(ORG_A);
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, token: real.token, state: "verified" });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "p@acme.example")).toBe(true);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_X, "p@acme.example")).toBe(false);
  });

  it("does not verify on anything but the whole record equal to the company's own token", async () => {
    const w = world();
    const own = await w.add(ORG_A);
    const wrong = [
      [`${recordValue(own.token)}x`], [`x${recordValue(own.token)}`], [recordValue(own.token).toUpperCase()], [`rovara-verify= ${own.token}`], [own.token], [`rovara-verify=${own.token.slice(0, 39)}`],
      [`rovara-verify=${"0".repeat(40)}`], [`v=spf1 include:${recordValue(own.token)} -all`], [`rovara-verify=${own.token},rovara-verify=${"1".repeat(40)}`], [""],
    ];
    for (const records of wrong) {
      w.dns.script.set("_rovara-verify.acme.example", { kind: "records", records });
      expect(await w.check(ORG_A), JSON.stringify(records)).toMatchObject({ result: "not_found" });
      expect(await w.holderOf(), JSON.stringify(records)).toBeUndefined();
    }
    w.dns.script.set("_rovara-verify.acme.example", { kind: "records", records: ["something else", ` ${recordValue(own.token)} `] });
    expect((await w.check(ORG_A)).result).toBe("found");
  });

  it("does not take another domain's token, even the same company's, or another company's token", async () => {
    const w = world();
    const one = await w.add(ORG_A, "one.example");
    await w.add(ORG_A, "two.example");
    const other = await w.add(ORG_B, "two.example", OMAR);
    w.publish("two.example", one.token, other.token);
    expect((await w.check(ORG_A, "two.example")).result).toBe("not_found");
  });

  it("lets only one of two companies that prove at the same moment hold the domain", async () => {
    const w = world();
    const a = await w.add(ORG_A);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    w.publish("acme.example", a.token, b.token);
    const results = await Promise.all([w.check(ORG_A), w.check(ORG_B, "acme.example", OMAR)]);
    const holder = (await w.holderOf())!;
    expect([ORG_A, ORG_B]).toContain(holder.orgId);
    expect(holder.version).toBe(1);
    expect(results.filter((outcome) => outcome.entry.holder !== undefined)).toHaveLength(1);
    expect(w.capture.recordedBy("company_domain.verified")).toHaveLength(1);
    // the one that lost is told the domain is held, on its next look, not that it is verified
    const loser = holder.orgId === ORG_A ? ORG_B : ORG_A;
    expect((await w.check(loser, "acme.example", OMAR)).result).toBe("held");
    expect(await isVerifiedCompanyDomain(w.deps, loser, "p@acme.example")).toBe(false);
  });

  it("does not move a VERIFIED domain: another company's token alone in DNS changes nothing, however long, and the holder's missing record only starts the three days", async () => {
    const w = world();
    const holder = await w.prove(ORG_A);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    w.publish("acme.example", b.token);
    for (let hour = 0; hour < 60; hour += 1) {
      w.clock.at += 2 * HOUR;
      expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held");
      expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, token: holder.token, version: 1 });
    }
    // still true after five days of B's record alone, while nobody has looked at A's side
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "p@acme.example")).toBe(true);
    expect((await getOwn(w.deps, ORG_B, "acme.example"))?.takeoverSeenAt).toBeUndefined();
  });
});

describe("a lost domain: the holder keeps it until another company proves it alone, twice, an hour apart", () => {
  async function lostHeldByA() {
    const w = world();
    const holder = await w.prove(ORG_A);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    await w.loseIt(ORG_A);
    expect((await w.holderOf())?.state).toBe("lost");
    return { w, holder, b };
  }

  it("a squatter's claim, and a lost domain nobody else proves, leave the lost holder in place with its way back", async () => {
    const { w, holder } = await lostHeldByA();
    await w.add(ORG_X, "acme.example", OMAR);
    w.clock.at += 20 * DAY;
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, state: "lost", token: holder.token });
    w.publish("acme.example", holder.token);
    expect((await w.check(ORG_A, "acme.example", "system")).entry.holder?.state).toBe("verified");
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "p@acme.example")).toBe(true);
  });

  it("moves to another company only on its own token alone, seen twice at least an hour apart", async () => {
    const { w, holder, b } = await lostHeldByA();
    w.publish("acme.example", b.token);
    const lostVersion = (await w.holderOf())!.version;
    const first = await w.check(ORG_B, "acme.example", OMAR);
    expect(first).toMatchObject({ result: "held", entry: { own: { takeoverSeenAt: new Date(w.clock.at).toISOString() } } });
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, version: lostVersion });
    w.clock.at += COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS - 1000;
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held");
    expect((await w.holderOf())?.orgId).toBe(ORG_A);
    w.clock.at += 2000;
    const second = await w.check(ORG_B, "acme.example", OMAR);
    expect(second).toMatchObject({ result: "found", entry: { holder: { orgId: ORG_B, state: "verified", token: b.token } } });
    // the version moved on by one from the old holder's, never back to 1
    expect((await w.holderOf())?.version).toBe(lostVersion + 1);
    expect(w.capture.recordedBy("company_domain.verified").at(-1)).toMatchObject({ orgId: ORG_B, facts: { wasState: "pending", tookOver: true } });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_B, "p@acme.example")).toBe(true);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "p@acme.example")).toBe(false);
    // A keeps its own claim and token; it is simply no longer the holder
    expect(await getEntry(w.deps, ORG_A, "acme.example")).toMatchObject({ own: { token: holder.token } });
    expect((await getEntry(w.deps, ORG_A, "acme.example"))?.holder).toBeUndefined();
  });

  it("does not move when the holder's token is in DNS too", async () => {
    const { w, holder, b } = await lostHeldByA();
    w.publish("acme.example", b.token, holder.token);
    for (let index = 0; index < 4; index += 1) { w.clock.at += 2 * HOUR; expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held"); }
    expect((await w.holderOf())?.orgId).toBe(ORG_A);
  });

  it("flip-flopping DNS moves nothing: the sighting is cleared by any look that is not the newcomer alone, and the holder's record returning ends it", async () => {
    const { w, holder, b } = await lostHeldByA();
    w.publish("acme.example", b.token);
    await w.check(ORG_B, "acme.example", OMAR);
    expect((await getOwn(w.deps, ORG_B, "acme.example"))?.takeoverSeenAt).toBeDefined();
    // DNS flips back to the holder's record and the holder looks
    w.clock.at += 30 * 60_000;
    w.publish("acme.example", holder.token);
    expect((await w.check(ORG_A, "acme.example", "system")).entry.holder?.state).toBe("verified");
    // the newcomer's next look finds its record gone: the sighting is cleared
    w.clock.at += 2 * HOUR;
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("not_found");
    expect((await getOwn(w.deps, ORG_B, "acme.example"))?.takeoverSeenAt).toBeUndefined();
    // and flipping to the newcomer again starts the hour over, against a holder that is verified again
    w.publish("acme.example", b.token);
    w.clock.at += 2 * HOUR;
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held");
    w.clock.at += 2 * HOUR;
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held");
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, state: "verified" });
  });

  it("a short outage moves nothing: a failed lookup neither takes, nor clears, nor starts a sighting", async () => {
    const { w, b } = await lostHeldByA();
    w.publish("acme.example", b.token);
    await w.check(ORG_B, "acme.example", OMAR);
    const seen = (await getOwn(w.deps, ORG_B, "acme.example"))?.takeoverSeenAt;
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    w.clock.at += 2 * HOUR;
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("unavailable");
    expect((await w.holderOf())?.orgId).toBe(ORG_A);
    expect((await getOwn(w.deps, ORG_B, "acme.example"))?.takeoverSeenAt).toBe(seen);
  });

  it("a verified holder through a short outage keeps the domain and starts no clock", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    for (let index = 0; index < 8; index += 1) { w.clock.at += DAY; await w.check(ORG_A, "acme.example", "system"); }
    expect(await w.holderOf()).toMatchObject({ state: "verified" });
    expect((await w.holderOf())?.missingSince).toBeUndefined();
  });

  it("lets another company prove a domain whose holder has closed, at once", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.db.set({ ...orgMetaKey(ORG_A), closedAt: new Date(START).toISOString() });
    const b = await w.add(ORG_B, "acme.example", OMAR);
    w.publish("acme.example", b.token);
    expect(await w.check(ORG_B, "acme.example", OMAR)).toMatchObject({ result: "found", entry: { holder: { orgId: ORG_B, version: 2 } } });
  });

  it("does not read a holder with no org record as closed", async () => {
    const w = world();
    await w.prove(ORG_A);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    w.publish("acme.example", b.token);
    expect((await w.check(ORG_B, "acme.example", OMAR)).result).toBe("held");
  });
});

describe("removeCompanyDomain", () => {
  it("removes the company's own claim with an audit record, and the holder item when it is the holder", async () => {
    const w = world();
    await w.prove(ORG_A);
    await removeCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example" });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.db.get(ownKey(ORG_A, "acme.example"))).toBeUndefined();
    expect(w.capture.recordedBy("company_domain.removed")[0]).toMatchObject({ facts: { wasState: "verified" }, details: [{ fields: { domain: "acme.example" } }] });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "p@acme.example")).toBe(false);
  });

  it("removing a claim that is not the holder leaves the holder untouched", async () => {
    const w = world();
    const holder = await w.prove(ORG_A);
    await w.add(ORG_B, "acme.example", OMAR);
    await removeCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" });
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A, token: holder.token });
    expect(w.capture.recordedBy("company_domain.removed")[0]).toMatchObject({ orgId: ORG_B, facts: { wasState: "pending" } });
  });

  it("cannot remove another company's domain, or one that was never added", async () => {
    const w = world();
    await w.prove(ORG_A);
    await expect(removeCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "acme.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeCompanyDomain(w.deps, { orgId: ORG_B, by: OMAR, domain: "never.example" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_A });
    expect(w.capture.recordedBy("company_domain.removed")).toHaveLength(0);
  });
});

describe("checkCompanyDomain", () => {
  it("cannot check a domain the company has not added (no lookup is made)", async () => {
    const w = world();
    await w.add(ORG_A);
    await expect(w.check(ORG_B, "acme.example", OMAR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(w.check(ORG_B, "unknown.example", OMAR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.dns.lookups).toEqual([]);
  });

  it("reports an alias as 'indirect' and a failed lookup as 'unavailable', verifying neither", async () => {
    const w = world();
    await w.add(ORG_A);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "indirect" });
    expect(await w.check(ORG_A)).toMatchObject({ result: "indirect", entry: { own: { lastResult: "indirect" } } });
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    expect(await w.check(ORG_A)).toMatchObject({ result: "unavailable", entry: { own: { lastResult: "unavailable" } } });
    expect(await w.holderOf()).toBeUndefined();
  });

  it("treats a resolver that throws as a failed lookup", async () => {
    const w = world();
    await w.add(ORG_A);
    const throwing: TxtResolver = { lookupTxt: async () => { throw new Error("boom"); } };
    expect((await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: throwing })).result).toBe("unavailable");
  });

  it("returns the claim as it now is when it changed during the lookup, and writes nothing over it", async () => {
    const w = world();
    const own = await w.add(ORG_A);
    const slow: TxtResolver = { lookupTxt: async () => {
      w.publish("acme.example", own.token);
      await w.check(ORG_A, "acme.example", OMAR);
      return { kind: "absent" };
    } };
    const outcome = await checkCompanyDomain(w.deps, { orgId: ORG_A, by: MAYA, domain: "acme.example", resolver: slow });
    expect(outcome.changed).toBe(false);
    expect(outcome.entry.holder?.state).toBe("verified");
  });
});

describe("the three days", () => {
  const dailyCheck = (w: ReturnType<typeof world>) => recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 5000 });

  it("a verified domain whose record is gone stays verified for two daily checks and is lost on the third day, with an audit record by the system", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.withdraw("acme.example");
    const states: string[] = [];
    for (let day = 1; day <= 4; day += 1) {
      w.clock.at += DAY;
      await dailyCheck(w);
      states.push((await w.holderOf())!.state);
    }
    expect(states).toEqual(["verified", "verified", "verified", "lost"]);
    expect(w.capture.recordedBy("company_domain.lost")).toHaveLength(1);
    expect(w.capture.recordedBy("company_domain.lost")[0]).toMatchObject({ actor: { kind: "system" }, facts: { missingDays: 3 } });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });

  it("a lookup that fails does not start or advance the clock, and is tried again within the hour", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "unavailable" });
    for (let day = 1; day <= 6; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect(await w.holderOf()).toMatchObject({ state: "verified" });
    expect((await w.holderOf())?.missingSince).toBeUndefined();
    const own = (await getOwn(w.deps, ORG_A, "acme.example"))!;
    expect(own.lastResult).toBe("unavailable");
    expect(Number(own.dispatchDueSk!.split("#")[0])).toBe(w.clock.at + HOUR);
  });

  it("the record coming back before the third day clears the clock", async () => {
    const w = world();
    const own = await w.prove(ORG_A);
    w.withdraw("acme.example");
    for (let day = 1; day <= 2; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await w.holderOf())?.missingSince).toBeDefined();
    w.publish("acme.example", own.token);
    w.clock.at += DAY;
    await dailyCheck(w);
    expect(await w.holderOf()).toMatchObject({ state: "verified" });
    expect((await w.holderOf())?.missingSince).toBeUndefined();
    w.withdraw("acme.example");
    w.clock.at += DAY; await dailyCheck(w);
    w.clock.at += DAY; await dailyCheck(w);
    expect((await w.holderOf())?.state).toBe("verified");
  });

  it("an alias in place of the record counts as the record being gone", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.dns.script.set("_rovara-verify.acme.example", { kind: "indirect" });
    for (let day = 1; day <= 4; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await w.holderOf())?.state).toBe("lost");
  });

  it("a lost domain is verified again when its record returns", async () => {
    const w = world();
    const own = await w.prove(ORG_A);
    w.withdraw("acme.example");
    for (let day = 1; day <= 4; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await w.holderOf())?.state).toBe("lost");
    w.publish("acme.example", own.token);
    w.clock.at += DAY;
    await dailyCheck(w);
    expect(await w.holderOf()).toMatchObject({ state: "verified" });
    expect(w.capture.recordedBy("company_domain.verified").at(-1)).toMatchObject({ facts: { wasState: "lost", tookOver: false } });
  });

  it("only looks at claims that are due, not before", async () => {
    const w = world();
    await w.prove(ORG_A);
    const before = w.dns.lookups.length;
    w.clock.at += DAY - 1000;
    expect(await dailyCheck(w)).toMatchObject({ checked: 0 });
    expect(w.dns.lookups.length).toBe(before);
    w.clock.at += 2000;
    expect(await dailyCheck(w)).toMatchObject({ checked: 1 });
  });

  it("stops watching a claim nobody proved within its seven days", async () => {
    const w = world();
    await w.add(ORG_A);
    for (let day = 1; day <= 9; day += 1) { w.clock.at += DAY; await dailyCheck(w); }
    expect((await getOwn(w.deps, ORG_A, "acme.example"))?.dispatchDuePk).toBeUndefined();
  });

  it("a pending claim whose record appears is verified by the daily run too", async () => {
    const w = world();
    const own = await w.add(ORG_A);
    w.publish("acme.example", own.token);
    w.clock.at += DAY;
    expect(await dailyCheck(w)).toMatchObject({ checked: 1, verified: 1 });
    expect((await w.holderOf())?.orgId).toBe(ORG_A);
  });

  it("releases the claim and the holder item of a closed company instead of looking at them", async () => {
    const w = world();
    await w.prove(ORG_A);
    w.db.set({ ...orgMetaKey(ORG_A), closedAt: new Date(w.clock.at).toISOString() });
    w.clock.at += DAY;
    expect(await dailyCheck(w)).toMatchObject({ released: 1, checked: 0 });
    expect(w.db.get(claimKey("acme.example"))).toBeUndefined();
    expect(w.db.get(ownKey(ORG_A, "acme.example"))).toBeUndefined();
  });

  it("never releases a holder item that has become another company's: the closed company's release touches its own claim only", async () => {
    const w = world();
    const a = await w.add(ORG_A);
    const b = await w.add(ORG_B, "acme.example", OMAR);
    w.publish("acme.example", b.token);
    await w.check(ORG_B, "acme.example", OMAR);
    expect((await w.holderOf())?.orgId).toBe(ORG_B);
    w.db.set({ ...orgMetaKey(ORG_A), closedAt: new Date(w.clock.at).toISOString() });
    w.clock.at += 2 * DAY;
    const outcome = await dailyCheck(w);
    expect(outcome.released).toBe(1);
    expect(await w.holderOf()).toMatchObject({ orgId: ORG_B, state: "verified", token: b.token });
    expect(w.db.get(ownKey(ORG_A, "acme.example"))).toBeUndefined();
    expect(a.token).not.toBe(b.token);
  });

  it("is bounded by its limit and its time budget", async () => {
    const w = world();
    for (let index = 0; index < 8; index += 1) await w.add(ORG_A, `d${String(index)}.example`);
    w.clock.at += DAY;
    expect(await recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 5000, limit: 3 })).toMatchObject({ checked: 3 });
    expect(await recheckDueDomains(w.deps, { resolver: w.resolver, budgetMs: 0, limit: 3 })).toMatchObject({ checked: 0 });
  });
});

describe("isVerifiedCompanyDomain", () => {
  it("is true for the holder's verified domain, with any case, an address or a bare domain", async () => {
    const w = world();
    await w.prove(ORG_A);
    for (const form of ["acme.example", "ACME.Example", "maya@acme.example", "Maya.Rao@ACME.EXAMPLE", "maya@acme.example."]) expect(await isVerifiedCompanyDomain(w.deps, ORG_A, form), form).toBe(true);
  });

  it("is false for another company, for a subdomain, for a lookalike and for something that is not a domain", async () => {
    const w = world();
    await w.prove(ORG_A);
    const no = ["maya@mail.acme.example", "maya@acme.example.evil.example", "maya@acme-example.com", "maya@аcme.example", "maya@ａcme.example", "maya@xn--cme-5cd.example", "maya", "", "maya@", "@", "maya@1.2.3.4", "maya@example"];
    for (const form of no) expect(await isVerifiedCompanyDomain(w.deps, ORG_A, form), form).toBe(false);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_B, "maya@acme.example")).toBe(false);
  });

  it("is false for a claim that is only added, a stray item of another company, a holder it cannot read", async () => {
    const w = world();
    await w.add(ORG_A);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
    w.db.set({ ...ownKey(ORG_B, "acme.example"), entityType: "COMPANY_DOMAIN_POINTER", orgId: ORG_B, domain: "acme.example" });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_B, "maya@acme.example")).toBe(false);
    expect(await listEntries(w.deps, ORG_B)).toEqual([]);
    w.db.set({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "verified", token: "short", version: 1, claimedAt: new Date(START).toISOString() });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
    w.db.set({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "pending", token: "a".repeat(40), version: 1, claimedAt: new Date(START).toISOString() });
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });

  it("is false once the domain is lost or removed", async () => {
    const w = world();
    await w.prove(ORG_A);
    await w.loseIt(ORG_A);
    expect(await isVerifiedCompanyDomain(w.deps, ORG_A, "maya@acme.example")).toBe(false);
  });
});

describe("the pure parts", () => {
  const holder = (): ClaimRecord => ({ ...claimKey("acme.example"), entityType: "COMPANY_DOMAIN", domain: "acme.example", orgId: ORG_A, state: "verified", token: "c".repeat(40), version: 1, claimedAt: new Date(START).toISOString(), claimedBy: MAYA, verifiedAt: new Date(START).toISOString() });

  it("resultOf reads only the whole record", () => {
    const token = "c".repeat(40);
    expect(resultOf({ kind: "records", records: [recordValue(token)] }, token)).toBe("found");
    expect(resultOf({ kind: "records", records: [`${recordValue(token)}0`] }, token)).toBe("not_found");
    expect(resultOf({ kind: "records", records: [] }, token)).toBe("not_found");
    expect(resultOf({ kind: "absent" }, token)).toBe("not_found");
    expect(resultOf({ kind: "indirect" }, token)).toBe("indirect");
    expect(resultOf({ kind: "unavailable" }, token)).toBe("unavailable");
  });

  it("applyCheck bumps the version, and a verified holder whose record is not found starts its clock", () => {
    const { next, transition } = applyCheck(holder(), "not_found", START + DAY);
    expect(next).toMatchObject({ state: "verified", version: 2, missingSince: new Date(START + DAY).toISOString() });
    expect(transition).toBeUndefined();
  });

  it("toView gives the record to publish and no token anywhere else", () => {
    const own = { ...ownKey(ORG_A, "acme.example"), entityType: "COMPANY_DOMAIN_POINTER" as const, domain: "acme.example", orgId: ORG_A, token: "c".repeat(40), version: 1, claimedAt: new Date(START).toISOString(), claimedBy: MAYA };
    const view = toView({ own });
    expect(view.record).toEqual({ type: "TXT", name: "_rovara-verify.acme.example", value: `rovara-verify=${"c".repeat(40)}` });
    expect(JSON.stringify({ ...view, record: undefined })).not.toContain("c".repeat(40));
    expect(view.state).toBe("pending");
  });
});
