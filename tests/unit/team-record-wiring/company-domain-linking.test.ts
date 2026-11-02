// Tracker linking signals (owner, 2026-11-02): the opt-in automatic link needs the company's VERIFIED domain (company domain verification) and a company-controlled account.
//  1. DOMAINS: only a verified domain of THIS company counts; pending, lost, another company's, a subdomain, a lookalike and a case variant are each tested; the domains are read once per run.
//  2. LINEAR: a verified domain, a workspace that enforces SAML, not a guest, an exact member email: all four, or nobody is linked.
//  3. JIRA: only with a company-supplied, read-only Atlassian organization admin key, and only for an account that organization lists as managed; without a key nobody links. The key goes to api.atlassian.com
//     only, is never kept in a stored item, a log line or a reader's answer, and a failure to read it is "cannot tell", never "not managed".
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgEmailKey, orgMetaKey, orgProjectCatalogKey, teamRecordPk, type OrgId } from "@agentx/contracts";
import { OrgConnectionStore } from "../../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../../packages/broker/src/connections/org-secrets.js";
import { companyDomainsPort } from "../../../packages/broker/src/org/company-domains/port.js";
import type { TxtLookup, TxtResolver } from "../../../packages/broker/src/org/company-domains/resolver.js";
import { addCompanyDomain, checkCompanyDomain, getClaim, recordValue, isVerifiedCompanyDomain } from "../../../packages/broker/src/org/company-domains/store.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { emailDomain, exactAutoLinkEmail } from "../../../packages/broker/src/team-record/tracker-autolink.js";
import { connectedTrackersOf } from "../../../packages/broker/src/team-record/tracker-connections.js";
import { MANAGED_PAGES_MAX, atlassianManagedAccountsReader, jiraUsersReader, type ConnectedTracker, type TrackerUser } from "../../../packages/broker/src/team-record/tracker-directory.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../../support/fake-org-secrets.js";
import { ORG_A, ORG_B, T0 } from "../../support/team-record-core.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const DAY = 86_400_000;
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const USER = (extra: Partial<TrackerUser> & { sourceId: string }): TrackerUser => ({ displayName: extra.sourceId, control: "yes", ...extra });

function fakeTracker(users: TrackerUser[], kind: "linear" | "jira" = "linear"): ConnectedTracker {
  return { connectionId: CON, system: kind === "linear" ? "linear" : "jira:acme.atlassian.net", kind, async readUsers() { return { users }; } };
}

function world(options: { users?: TrackerUser[]; switchOn?: boolean } = {}) {
  const db = new FakeDynamoDb({ indexKeys });
  const clock = { at: T0 };
  db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
  db.set({ ...orgMetaKey(ORG_B), orgId: ORG_B });
  db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  for (const [developerId, orgId, email] of [["dev-priya", ORG_A, "priya@acme.test"], ["dev-sam", ORG_A, "sam@acme.test"], ["dev-olga", ORG_B, "olga@other.test"], ["dev-xavi", ORG_A, "xavi@mail.acme.test"]] as const) {
    db.set({ ...developerOrgKey(developerId), entityType: "DEVELOPER_ORG", orgId, role: "member" });
    db.set({ ...orgEmailKey(email), entityType: "ORG_EMAIL", developerId, orgId });
  }
  if (options.switchOn !== false) db.set({ pk: teamRecordPk(ORG_A), sk: "TRAUTOLINK", entityType: "TEAM_RECORD_AUTOLINK_SETTING", orgId: ORG_A, enabled: true, changedBy: "dev-sam", at: "2026-10-30T10:00:00.000Z" });
  const dns = new Map<string, TxtLookup>();
  const resolver: TxtResolver = { lookupTxt: async (name) => dns.get(name) ?? { kind: "absent" } };
  const domainDeps = { documentClient: db, tableName: "State", now: () => clock.at };
  const reads = { count: 0 };
  const port = companyDomainsPort(domainDeps);
  const verifiedDomains = { domainsOf: async (orgId: OrgId) => { reads.count += 1; return port.domainsOf(orgId); } };
  const verify = async (domain: string, orgId: OrgId = ORG_A) => {
    const { entry: { own } } = await addCompanyDomain(domainDeps, { orgId, by: "a".repeat(64), domain });
    dns.set(`_rovara-verify.${domain}`, { kind: "records", records: [recordValue(own.token)] });
    await checkCompanyDomain(domainDeps, { orgId, by: "a".repeat(64), domain, resolver });
    return own;
  };
  const trackers = options.users === undefined ? undefined : { list: async (orgId: OrgId) => (orgId === ORG_A ? [fakeTracker(options.users!)] : []), get: async (orgId: OrgId) => (orgId === ORG_A ? fakeTracker(options.users!) : undefined) };
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => clock.at, verifiedDomains, ...(trackers === undefined ? {} : { trackers }) }) as TeamRecordRuntime;
  return { db, clock, dns, resolver, domainDeps, reads, verify, runtime, sync: () => runtime.trackerPeople.syncConnection(ORG_A, CON) };
}
const linksOf = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_LINK").map((item) => [(item.sk as string).split("#").pop()!, item.developerId as string]);
const reasonsOf = (db: FakeDynamoDb) => Object.fromEntries(db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_UNMATCHED").map((item) => [item.sourceId as string, item.reason as string | undefined]));

describe("Linear: the verified domain, SAML, not a guest, an exact member email", () => {
  it("links a person at the company's verified domain, whatever the case or spacing of the tool's email", async () => {
    const w = world({ users: [USER({ sourceId: "lin-priya", email: "  PRIYA@Acme.TEST " })] });
    await w.verify("acme.test");
    expect(await w.sync()).toMatchObject({ linked: 1, unmatched: 0 });
    expect(linksOf(w.db)).toStrictEqual([["lin-priya", "dev-priya"]]);
  });

  it("does not link while the domain is only claimed (pending), and says the company has no verified domain", async () => {
    const w = world({ users: [USER({ sourceId: "lin-priya", email: "priya@acme.test" })] });
    await addCompanyDomain(w.domainDeps, { orgId: ORG_A, by: "a".repeat(64), domain: "acme.test" });
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-priya": "no_verified_domains" });
  });

  it("does not link once the domain is lost, and links again when the record returns", async () => {
    const w = world({ users: [USER({ sourceId: "lin-priya", email: "priya@acme.test" })] });
    const claim = await w.verify("acme.test");
    w.dns.delete("_rovara-verify.acme.test");
    for (let day = 0; day < 4; day += 1) {
      w.clock.at += DAY;
      await checkCompanyDomain(w.domainDeps, { orgId: ORG_A, by: "system", domain: "acme.test", resolver: w.resolver });
    }
    expect((await getClaim(w.domainDeps, "acme.test"))?.state).toBe("lost");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)["lin-priya"]).toBe("no_verified_domains");
    w.dns.set("_rovara-verify.acme.test", { kind: "records", records: [recordValue(claim.token)] });
    await checkCompanyDomain(w.domainDeps, { orgId: ORG_A, by: "system", domain: "acme.test", resolver: w.resolver });
    w.clock.at += 1000;
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([["lin-priya", "dev-priya"]]);
  });

  it("does not count another company's verified domain, and a member of the other company is never linked here", async () => {
    const w = world({ users: [USER({ sourceId: "lin-olga", email: "olga@other.test" }), USER({ sourceId: "lin-priya", email: "priya@acme.test" })] });
    await w.verify("other.test", ORG_B);
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-olga": "no_verified_domains", "lin-priya": "no_verified_domains" });
    // even if this company verifies the same-looking domain later, a company B member's email is not a member of company A
    await w.verify("acme.test");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([["lin-priya", "dev-priya"]]);
    expect(reasonsOf(w.db)["lin-olga"]).toBe("domain_not_verified");
  });

  it("does not stretch a verified domain to its subdomains, or to a lookalike of it", async () => {
    const w = world({ users: [
      USER({ sourceId: "lin-xavi", email: "xavi@mail.acme.test" }), USER({ sourceId: "lin-cyr", email: "priya@аcme.test" }), USER({ sourceId: "lin-wide", email: "priya@ａcme.test" }),
      USER({ sourceId: "lin-evil", email: "priya@acme.test.evil.example" }), USER({ sourceId: "lin-priya", email: "priya@acme.test" }),
    ] });
    await w.verify("acme.test");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([["lin-priya", "dev-priya"]]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-xavi": "domain_not_verified", "lin-cyr": "domain_not_verified", "lin-wide": "domain_not_verified", "lin-evil": "domain_not_verified" });
  });

  it("does not link by an email that only looks exact: the Kelvin sign for K, accented, full-width or case-folded characters, a domain not in stored form; plain ASCII case variants do link", async () => {
    const w = world({ users: [
      USER({ sourceId: "lin-kelvin", email: "\u212Aate@acme.test" }),
      USER({ sourceId: "lin-fullwidth", email: "\uFF53am@acme.test" }), USER({ sourceId: "lin-accent", email: "s\u00E4m@acme.test" }),
      USER({ sourceId: "lin-twoat", email: "sam@acme.test@acme.test" }), USER({ sourceId: "lin-sam", email: "SAM@ACME.test" }),
    ] });
    // members whose sign-in emails are the ASCII ones the look-alikes would fold onto
    w.db.set({ ...developerOrgKey("dev-kate"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
    w.db.set({ ...orgEmailKey("kate@acme.test"), entityType: "ORG_EMAIL", developerId: "dev-kate", orgId: ORG_A });
    await w.verify("acme.test");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([["lin-sam", "dev-sam"]]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-kelvin": "email_not_exact", "lin-fullwidth": "email_not_exact", "lin-accent": "email_not_exact", "lin-twoat": "email_not_exact" });
  });

  it("exactAutoLinkEmail: plain ASCII only, ASCII lower-casing, one @, a stored-form domain", () => {
    expect(exactAutoLinkEmail("  Kate@ACME.test ")).toBe("kate@acme.test");
    for (const bad of ["\u212Aate@acme.test", "kate@acme.test\u212A", "k\u00E4te@acme.test", "kate@b\u00FCcher.test", "kate@\u0430cme.test", "a@b@acme.test", "@acme.test", "kate@", "kate@com", "kate", "ka te@acme.test", ""]) {
      expect(exactAutoLinkEmail(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(exactAutoLinkEmail("kate@xn--bcher-kva.test")).toBe("kate@xn--bcher-kva.test");
  });

  it("does not link a guest, or an account the workspace's sign-in does not control, even at a verified domain with an exact match", async () => {
    const w = world({ users: [USER({ sourceId: "lin-guest", email: "priya@acme.test", guest: true }), USER({ sourceId: "lin-open", email: "sam@acme.test", control: "no" }), USER({ sourceId: "lin-unknown", email: "sam@acme.test", control: "unavailable" })] });
    await w.verify("acme.test");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-guest": "guest", "lin-open": "not_company_controlled", "lin-unknown": "company_control_unavailable" });
  });

  it("does not link when the switch is off, however verified the domain", async () => {
    const w = world({ users: [USER({ sourceId: "lin-priya", email: "priya@acme.test" })], switchOn: false });
    await w.verify("acme.test");
    await w.sync();
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-priya": "switch_off" });
  });

  it("does not link when the email is no member's exact verified sign-in email, at a verified domain", async () => {
    const w = world({ users: [USER({ sourceId: "lin-nobody", email: "nobody@acme.test" })] });
    await w.verify("acme.test");
    await w.sync();
    expect(reasonsOf(w.db)).toStrictEqual({ "lin-nobody": "no_matching_member" });
  });

  it("reads the switch and the verified domains once for the whole run, not once for each person", async () => {
    const users = Array.from({ length: 12 }, (_, index) => USER({ sourceId: `lin-${String(index)}`, email: `nobody${String(index)}@acme.test` }));
    const w = world({ users });
    await w.verify("acme.test");
    w.reads.count = 0;
    await w.sync();
    expect(w.reads.count).toBe(1);
  });

  it("the list the linker reads and isVerifiedCompanyDomain agree, for every form of the domain", async () => {
    const w = world();
    await w.verify("acme.test");
    await w.verify("xn--bcher-kva.test");
    await addCompanyDomain(w.domainDeps, { orgId: ORG_A, by: "a".repeat(64), domain: "pending.test" });
    const set = (await companyDomainsPort(w.domainDeps).domainsOf(ORG_A))!;
    for (const email of ["a@acme.test", "a@ACME.test", "a@B\u00FCcher.TEST", "a@xn--bcher-kva.test", "a@pending.test", "a@mail.acme.test", "a@аcme.test", "a@other.test", "a", "a@com"]) {
      const domain = emailDomain(email);
      expect(domain !== undefined && set.has(domain), email).toBe(await isVerifiedCompanyDomain(w.domainDeps, ORG_A, email));
    }
    expect([...set].sort()).toStrictEqual(["acme.test", "xn--bcher-kva.test"]);
    expect(emailDomain("a@B\u00FCcher.TEST")).toBe("xn--bcher-kva.test");
    expect([...(await companyDomainsPort(w.domainDeps).domainsOf(ORG_B))!]).toStrictEqual([]);
  });
});

describe("the Atlassian organization admin API reader", () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ORG = "org-id-1234";
  const URL1 = `https://api.atlassian.com/admin/v1/orgs/${ORG}/users`;

  it("asks GET /admin/v1/orgs/{orgId}/users with the key as a bearer, follows only its own next links, and lists active atlassian accounts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const pages: Record<string, unknown> = {
      [URL1]: { data: [{ account_id: "a1", account_type: "atlassian", account_status: "active" }, { account_id: "a2", account_type: "app", account_status: "active" }, { account_id: "a3", account_type: "atlassian", account_status: "inactive" }], links: { next: `${URL1}?cursor=c2` } },
      [`${URL1}?cursor=c2`]: { data: [{ account_id: "a4", account_type: "atlassian", account_status: "active" }], links: { next: null } },
    };
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(pages[url]); }) as unknown as typeof fetch;
    const result = await atlassianManagedAccountsReader({ fetch: fetcher, atlassianOrgId: ORG, apiKey: "adm-key-123" })();
    expect([...result!.ids]).toStrictEqual(["a1", "a4"]);
    expect(result!.complete).toBe(true);
    expect(calls.map((call) => call.url)).toStrictEqual([URL1, `${URL1}?cursor=c2`]);
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer adm-key-123");
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("error");
    }
  });

  it("follows a next link given as a full URL, a path, a query or a bare cursor, always to the same address", async () => {
    for (const next of [`${URL1}?cursor=c2`, `/admin/v1/orgs/${ORG}/users?cursor=c2`, "?cursor=c2", "c2"]) {
      const urls: string[] = [];
      const fetcher = (async (url: string) => {
        urls.push(url);
        return json(urls.length === 1 ? { data: [{ account_id: "a1", account_type: "atlassian", account_status: "active" }], links: { next } } : { data: [{ account_id: "a2", account_type: "atlassian", account_status: "active" }], links: {} });
      }) as unknown as typeof fetch;
      const result = await atlassianManagedAccountsReader({ fetch: fetcher, atlassianOrgId: ORG, apiKey: "k" })();
      expect([...result!.ids], next).toStrictEqual(["a1", "a2"]);
      expect(result?.complete, next).toBe(true);
      expect(urls, next).toStrictEqual([URL1, `${URL1}?cursor=c2`]);
    }
  });

  it("never sends the key anywhere else: a next link to another host, organization or path ends the read as incomplete", async () => {
    for (const next of ["https://evil.example/admin/v1/orgs/org-id-1234/users?cursor=x", "https://api.atlassian.com/admin/v1/orgs/other-org-99/users", "https://api.atlassian.com/admin/v1/orgs/org-id-1234/other", "http://api.atlassian.com/admin/v1/orgs/org-id-1234/users", "https://u:p@api.atlassian.com/admin/v1/orgs/org-id-1234/users", "not a url at all :::"]) {
      const urls: string[] = [];
      const fetcher = (async (url: string) => { urls.push(url); return json({ data: [{ account_id: "a1", account_type: "atlassian", account_status: "active" }], links: { next } }); }) as unknown as typeof fetch;
      const result = await atlassianManagedAccountsReader({ fetch: fetcher, atlassianOrgId: ORG, apiKey: "k" })();
      expect(result?.complete, next).toBe(false);
      expect(urls, next).toStrictEqual([URL1]);
    }
  });

  it("says nothing (undefined) when the key is refused, the answer is unreadable or the request fails", async () => {
    for (const fetcher of [async () => json({}, 401), async () => json({}, 403), async () => json({ data: "x" }), async () => { throw new Error("down"); }, async () => new Response("not json", { status: 200 })]) {
      expect(await atlassianManagedAccountsReader({ fetch: fetcher, atlassianOrgId: ORG, apiKey: "k" })()).toBeUndefined();
    }
  });

  it("stops at its page cap and its time cap and says the list is incomplete", async () => {
    let served = 0;
    const endless = (async () => { served += 1; return json({ data: [{ account_id: `a${String(served)}`, account_type: "atlassian", account_status: "active" }], links: { next: `${URL1}?cursor=${String(served)}` } }); }) as unknown as typeof fetch;
    const capped = await atlassianManagedAccountsReader({ fetch: endless, atlassianOrgId: ORG, apiKey: "k" })();
    expect(capped?.complete).toBe(false);
    expect(served).toBe(MANAGED_PAGES_MAX);
    let clock = 0;
    const slow = (async () => { clock += 15_000; return json({ data: [], links: { next: `${URL1}?cursor=n` } }); }) as unknown as typeof fetch;
    const timed = await atlassianManagedAccountsReader({ fetch: slow, atlassianOrgId: ORG, apiKey: "k", now: () => clock })();
    expect(timed?.complete).toBe(false);
  });
});

describe("Jira: control is read only from a company-supplied organization admin key", () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const site = { fetch: undefined as unknown as typeof fetch, siteUrl: "https://acme.atlassian.net", email: "svc@acme.test", apiToken: "tok" };
  const people = [
    { accountId: "m1", accountType: "atlassian", active: true, displayName: "Managed", emailAddress: "priya@acme.test" },
    { accountId: "x1", accountType: "atlassian", active: true, displayName: "Outside", emailAddress: "sam@acme.test" },
  ];
  const jiraFetch = (async () => json(people)) as unknown as typeof fetch;

  it("without a key every account is 'unavailable' (nobody links)", async () => {
    const page = await jiraUsersReader({ ...site, fetch: jiraFetch })({ limit: 50 });
    expect(page.users.map((user) => user.control)).toStrictEqual(["unavailable", "unavailable"]);
  });

  it("with a key: managed accounts are 'yes', the others 'no' when the list is complete, 'unavailable' when it is cut short or unreadable", async () => {
    const run = (managed: () => Promise<{ ids: ReadonlySet<string>; complete: boolean } | undefined>) => jiraUsersReader({ ...site, fetch: jiraFetch, managed })({ limit: 50 }).then((page) => page.users.map((user) => user.control));
    expect(await run(async () => ({ ids: new Set(["m1"]), complete: true }))).toStrictEqual(["yes", "no"]);
    expect(await run(async () => ({ ids: new Set(["m1"]), complete: false }))).toStrictEqual(["yes", "unavailable"]);
    expect(await run(async () => undefined)).toStrictEqual(["unavailable", "unavailable"]);
    expect(await run(async () => { throw new Error("boom"); })).toStrictEqual(["unavailable", "unavailable"]);
  });

  it("asks the organization admin API only when the page has a real person in it", async () => {
    const managed = vi.fn(async () => ({ ids: new Set<string>(), complete: true }));
    await jiraUsersReader({ ...site, fetch: async () => json([{ accountId: "bot", accountType: "app", active: true }]), managed })({ limit: 50 });
    expect(managed).not.toHaveBeenCalled();
  });
});

describe("a saved Jira connection with an organization admin key: the full path", () => {
  async function jiraWorld(secret: Record<string, unknown>, orgList: unknown, options: { fail?: boolean } = {}) {
    const w = world({ switchOn: true });
    const fake = new FakeOrgSecrets({ env: "staging", now: () => T0 });
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => T0 });
    const deps = { documentClient: w.db, tableName: "State", env: "staging", secrets, now: () => T0 };
    const seen: Array<{ url: string; authorization: string }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, authorization: (init.headers as Record<string, string>).authorization ?? "" });
      if (url.startsWith("https://api.atlassian.com/")) return options.fail === true ? new Response("{}", { status: 403 }) : new Response(JSON.stringify(orgList), { status: 200 });
      return new Response(JSON.stringify([{ accountId: "m1", accountType: "atlassian", active: true, displayName: "Priya R", emailAddress: "priya@acme.test" }, { accountId: "x1", accountType: "atlassian", active: true, displayName: "Sam K", emailAddress: "sam@acme.test" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const trackers = connectedTrackersOf({ deps, fetch: fetcher });
    const logs: string[] = [];
    const runtime = createTeamRecordRuntime({ env: ON, documentClient: w.db, stateTableName: "State", now: () => T0, trackers, verifiedDomains: companyDomainsPort({ documentClient: w.db, tableName: "State", now: () => T0 }), log: (entry) => logs.push(JSON.stringify(entry)) }) as TeamRecordRuntime;
    const store = new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined });
    await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "jira", label: "Jira", access: "read", siteUrl: "https://acme.atlassian.net" }, secret, by: "a".repeat(64) });
    await w.verify("acme.test");
    return { w, runtime, seen, logs, fake, trackers, store, connection: { connectionId: CON, type: "jira", label: "Jira", access: "read", siteUrl: "https://acme.atlassian.net" } };
  }
  const KEY = "ATAdminKey-0123456789";
  const full = { email: "svc@acme.test", apiToken: "jira-token-xyz", orgAdminKey: KEY, atlassianOrgId: "org-id-1234" };
  const list = { data: [{ account_id: "m1", account_type: "atlassian", account_status: "active" }], links: {} };

  it("links the managed account at the verified domain, not the unmanaged one; the key goes to api.atlassian.com only and is nowhere stored, logged or returned", async () => {
    const { w, runtime, seen, logs } = await jiraWorld(full, list);
    await runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(linksOf(w.db)).toStrictEqual([["m1", "dev-priya"]]);
    expect(reasonsOf(w.db)).toStrictEqual({ x1: "not_company_controlled" });
    expect(seen.filter((call) => call.authorization === `Bearer ${KEY}`).map((call) => call.url)).toStrictEqual(["https://api.atlassian.com/admin/v1/orgs/org-id-1234/users"]);
    expect(seen.filter((call) => call.url.includes("atlassian.net")).every((call) => !call.authorization.includes(KEY))).toBe(true);
    const everything = JSON.stringify([...w.db.items.values()]) + logs.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("jira-token-xyz");
    expect(JSON.stringify(await runtime.trackerPeople.list(ORG_A))).not.toContain(KEY);
  });

  it("asks the organization admin API once for a whole run, not once for each page", async () => {
    const { runtime, seen } = await jiraWorld(full, list);
    await runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(seen.filter((call) => call.url.startsWith("https://api.atlassian.com/"))).toHaveLength(1);
  });

  it("with no key nobody is linked and every person says control cannot be told; the organization admin API is never called", async () => {
    const { w, runtime, seen } = await jiraWorld({ email: "svc@acme.test", apiToken: "jira-token-xyz" }, list);
    await runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ m1: "company_control_unavailable", x1: "company_control_unavailable" });
    expect(seen.some((call) => call.url.startsWith("https://api.atlassian.com/"))).toBe(false);
  });

  it("with a key the organization refuses, nobody is linked and nobody is called unmanaged", async () => {
    const { w, runtime } = await jiraWorld(full, {}, { fail: true });
    await runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(linksOf(w.db)).toStrictEqual([]);
    expect(reasonsOf(w.db)).toStrictEqual({ m1: "company_control_unavailable", x1: "company_control_unavailable" });
  });

  it("a key without the organization id (or the reverse) is refused when it is saved, so it is never half used", async () => {
    const w = world();
    const fake = new FakeOrgSecrets({ env: "staging", now: () => T0 });
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => T0 });
    const store = new OrgConnectionStore({ documentClient: w.db, tableName: "State", env: "staging", secrets, now: () => T0, checkEndpoint: async () => undefined });
    const connection = { connectionId: CON, type: "jira", label: "Jira", access: "read", siteUrl: "https://acme.atlassian.net" };
    for (const partial of [{ email: "svc@acme.test", apiToken: "t", orgAdminKey: KEY }, { email: "svc@acme.test", apiToken: "t", atlassianOrgId: "org-id-1234" }, { ...full, clearOrgAdmin: true }]) {
      await expect(store.put({ orgId: ORG_A, connection, secret: partial, by: "a".repeat(64) }), JSON.stringify(Object.keys(partial))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("a later save that leaves the key out keeps the stored key and organization id; clearOrgAdmin removes them; a new pair replaces them", async () => {
    const adminCalls = (seen: Array<{ url: string; authorization: string }>) => seen.filter((call) => call.url.startsWith("https://api.atlassian.com/")).map((call) => [call.url, call.authorization]);
    // the web and the CLI save only the email and token: the pair stays
    const kept = await jiraWorld(full, list);
    await kept.store.put({ orgId: ORG_A, connection: kept.connection, secret: { email: "svc@acme.test", apiToken: "rotated-token" }, by: "a".repeat(64) });
    await kept.runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(adminCalls(kept.seen)).toStrictEqual([["https://api.atlassian.com/admin/v1/orgs/org-id-1234/users", `Bearer ${KEY}`]]);
    expect(linksOf(kept.w.db)).toStrictEqual([["m1", "dev-priya"]]);
    expect(kept.seen.some((call) => call.authorization === `Basic ${Buffer.from("svc@acme.test:rotated-token").toString("base64")}`)).toBe(true);
    // explicitly cleared: no key is used and nobody links
    const cleared = await jiraWorld(full, list);
    await cleared.store.put({ orgId: ORG_A, connection: cleared.connection, secret: { email: "svc@acme.test", apiToken: "t2", clearOrgAdmin: true }, by: "a".repeat(64) });
    await cleared.runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(adminCalls(cleared.seen)).toStrictEqual([]);
    expect(linksOf(cleared.w.db)).toStrictEqual([]);
    // the flag is never stored
    // (the secret store keeps the previous version for recovery, as AWS does: it is the CURRENT version that has no key)
    const current = [...cleared.fake.secrets.values()].map((secret) => secret.value).join("") + JSON.stringify([...cleared.w.db.items.values()]);
    expect(current).not.toContain("clearOrgAdmin");
    expect(current).not.toContain(KEY);
    // a new pair replaces the old
    const replaced = await jiraWorld(full, list);
    await replaced.store.put({ orgId: ORG_A, connection: replaced.connection, secret: { email: "svc@acme.test", apiToken: "t3", orgAdminKey: "ATAdminKey-NEWNEWNEW", atlassianOrgId: "org-id-9999" }, by: "a".repeat(64) });
    await replaced.runtime.trackerPeople.syncConnection(ORG_A, CON);
    expect(adminCalls(replaced.seen)).toStrictEqual([["https://api.atlassian.com/admin/v1/orgs/org-id-9999/users", "Bearer ATAdminKey-NEWNEWNEW"]]);
  });

  it("the secret schema refuses a malformed organization id and an unknown field", async () => {
    const w = world();
    const fake = new FakeOrgSecrets({ env: "staging", now: () => T0 });
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => T0 });
    const store = new OrgConnectionStore({ documentClient: w.db, tableName: "State", env: "staging", secrets, now: () => T0, checkEndpoint: async () => undefined });
    const connection = { connectionId: CON, type: "jira", label: "Jira", access: "read", siteUrl: "https://acme.atlassian.net" };
    for (const secret of [{ ...full, atlassianOrgId: "../../x" }, { ...full, atlassianOrgId: "a b" }, { ...full, extra: "x" }]) {
      await expect(store.put({ orgId: ORG_A, connection, secret, by: "a".repeat(64) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
});
