// Plan 2, Task 19: the approved union reaches the cell's DNS firewall. `syncCellAllowList` reads the sync marker, then the union, replaces the
// firewall's "ProjectAllowList" with it (in chunks of the API's per-call limit) and clears the marker only if nothing changed meanwhile.
// The scheduled run first backfills a request for every domain stored before approvals existed.
import { GetFirewallDomainListCommand, UpdateFirewallDomainsCommand } from "@aws-sdk/client-route53resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EGRESS_SYNC_KEY, egressDomainsKey, isAllowedDomain, projectMetaKey, projectRevisionKey, type EgressAuditItem, type EgressDomainsItem, type EgressOwner, type OrgId } from "@rovara-code/contracts";
import {
  EGRESS_BACKFILL_KEY, EGRESS_RECONCILE_CONCURRENCY, EMPTY_UNION_SENTINEL, FIREWALL_DOMAINS_PER_CALL, backfillLegacyEgress, reconcileEgressWithRevisions, runEgressDomainsSync, syncCellAllowList,
} from "../../packages/broker/src/aws/egress-domains-sync.js";
import { reconcileProjectEgress } from "../../packages/broker/src/org/project-archive.js";
import { decideEgressDomain, putEgressDomains, setEgressOwnerActive, type EgressDomainsDependencies } from "../../packages/broker/src/org/egress-domains.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const LIST_ID = "rslvr-fdl-0123456789abcdef";
const WEB: EgressOwner = { kind: "project", project: "web" };
const API: EgressOwner = { kind: "project", project: "api" };
const SOURCE: EgressOwner = { kind: "model-source", sourceId: "src_1" };
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

type Sent = { name: string; input: Record<string, unknown> };

/** A Route 53 Resolver that records what it is sent and answers a domain list's status: UPDATING for `updating` reads after each update, then COMPLETE. */
function fakeResolver(options: { updating?: number; status?: string; onUpdate?: (input: Record<string, unknown>) => Promise<void> | void; failUpdate?: Error } = {}) {
  const sent: Sent[] = [];
  let pending = 0;
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    sent.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "UpdateFirewallDomainsCommand") {
      if (options.failUpdate !== undefined) throw options.failUpdate;
      await options.onUpdate?.(command.input);
      pending = options.updating ?? 0;
      return { Id: LIST_ID, Status: "UPDATING" };
    }
    if (command.constructor.name === "GetFirewallDomainListCommand") {
      if (pending > 0) { pending -= 1; return { FirewallDomainList: { Id: LIST_ID, Status: "UPDATING" } }; }
      return { FirewallDomainList: { Id: LIST_ID, Status: options.status ?? "COMPLETE" } };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  const updates = () => sent.filter((entry) => entry.name === "UpdateFirewallDomainsCommand").map((entry) => entry.input as { FirewallDomainListId: string; Operation: string; Domains: string[] });
  return { send, sent, updates };
}

function setup(options: { resolver?: ReturnType<typeof fakeResolver>; now?: () => Date } = {}) {
  const db = new FakeDynamoDb();
  const resolver = options.resolver ?? fakeResolver();
  const sleep = vi.fn(async () => undefined);
  const now = options.now ?? (() => new Date("2026-10-21T10:00:00.000Z"));
  const sync = () => syncCellAllowList({ documentClient: db, tableName: "state", resolver, listId: LIST_ID, now, sleep });
  // Changes go through the real egress writes, which call the real sync like the broker does.
  const deps = (cloud = false): EgressDomainsDependencies => ({ documentClient: db, tableName: "state", cloud, now, sync });
  // The same writes without a sync, for changes that land while another run is in flight.
  const quiet = (cloud = false): EgressDomainsDependencies => ({ documentClient: db, tableName: "state", cloud, now, sync: async () => ({ ok: true }) });
  const marker = () => db.get(EGRESS_SYNC_KEY) as unknown as { dirtySeq?: number; syncedSeq?: number; syncedAt?: string } | undefined;
  return { db, resolver, sleep, now, sync, deps, quiet, marker };
}

describe("syncCellAllowList", () => {
  it("replaces the list once with an approval's domain, and clears the marker", async () => {
    const s = setup();
    const cloud = s.deps(true);
    await putEgressDomains(cloud, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(s.resolver.updates()).toEqual([]);
    expect(s.marker()).toBeUndefined();
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-1" });
    expect(s.resolver.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["a.acme.dev"] }]);
    expect(s.marker()).toMatchObject({ dirtySeq: 1, syncedSeq: 1, syncedAt: "2026-10-21T10:00:00.000Z" });
  });

  it("sends one sorted union of what two orgs have approved, and not a domain still pending", async () => {
    const s = setup();
    const cloud = s.deps(true);
    await putEgressDomains(cloud, TEST_ORG, WEB, ["b.beta.dev", "a.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(cloud, OTHER_ORG, WEB, ["c.gamma.dev"], { developerId: "dev-2" });
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "b.beta.dev", decision: "approved", operatorId: "staff-1" });
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-1" });
    s.resolver.sent.length = 0;
    // Both approvals synced already; run again after a fresh change to look at one full union.
    await setEgressOwnerActive(s.deps(true), TEST_ORG, WEB, false);
    await setEgressOwnerActive(s.deps(true), TEST_ORG, WEB, true);
    expect(s.resolver.updates().at(-1)).toEqual({ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["a.acme.dev", "b.beta.dev"] });
    expect(s.resolver.updates().at(-1)!.Domains).not.toContain("c.gamma.dev");
  });

  it("splits a union larger than the API's per-call limit into one REPLACE then ADDs that cover every domain once", async () => {
    expect(FIREWALL_DOMAINS_PER_CALL).toBe(1000);
    const s = setup();
    const total = 2 * FIREWALL_DOMAINS_PER_CALL + 500;
    const all = Array.from({ length: total }, (_, index) => `d${String(index).padStart(5, "0")}.acme.dev`);
    // Fifty a project: 50 owners' worth, seeded as approved items.
    for (let start = 0, owner = 0; start < total; start += 50, owner += 1) {
      const domains = all.slice(start, start + 50).map((domain) => ({ domain, status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: "dev-1" }));
      s.db.set({ ...egressDomainsKey(TEST_ORG, { kind: "project", project: `p${String(owner)}` }), entityType: "EGRESS_DOMAINS", orgId: TEST_ORG, owner: { kind: "project", project: `p${String(owner)}` }, active: true, domains, updatedAt: "2026-10-01T00:00:00.000Z" });
    }
    s.db.set({ ...EGRESS_SYNC_KEY, entityType: "EGRESS_SYNC", dirtyAt: "2026-10-01T00:00:00.000Z", dirtySeq: 1 });
    expect(await s.sync()).toEqual({ ok: true, domains: total });
    const updates = s.resolver.updates();
    expect(updates.map((update) => update.Operation)).toEqual(["REPLACE", "ADD", "ADD"]);
    expect(updates.map((update) => update.Domains.length)).toEqual([1000, 1000, 500]);
    expect(updates.flatMap((update) => update.Domains)).toEqual(all);
    // Each update finishes (the list reads COMPLETE) before the next is sent.
    expect(s.resolver.sent.map((entry) => entry.name.replace("Command", ""))).toEqual([
      "UpdateFirewallDomains", "GetFirewallDomainList", "UpdateFirewallDomains", "GetFirewallDomainList", "UpdateFirewallDomains", "GetFirewallDomainList",
    ]);
    expect(s.marker()).toMatchObject({ syncedSeq: 1 });
  });

  it("leaves an archived owner's domains out, and sends the sentinel when nothing is left", async () => {
    const s = setup();
    await putEgressDomains(s.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(s.deps(), TEST_ORG, API, ["b.acme.dev"], { developerId: "dev-1" });
    expect(s.resolver.updates().at(-1)!.Domains).toEqual(["a.acme.dev", "b.acme.dev"]);
    await setEgressOwnerActive(s.deps(), TEST_ORG, API, false);
    expect(s.resolver.updates().at(-1)!.Domains).toEqual(["a.acme.dev"]);
    await setEgressOwnerActive(s.deps(), TEST_ORG, WEB, false);
    expect(s.resolver.updates().at(-1)).toEqual({ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: [EMPTY_UNION_SENTINEL] });
    expect(EMPTY_UNION_SENTINEL).toBe("none.invalid");
    // Removing the last domain of a live owner empties the union too.
    await putEgressDomains(s.deps(), TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-1" });
    await putEgressDomains(s.deps(), TEST_ORG, SOURCE, [], { developerId: "dev-1" });
    expect(s.resolver.updates().at(-1)!.Domains).toEqual([EMPTY_UNION_SENTINEL]);
  });

  it("makes no resolver call when the marker is clean or absent", async () => {
    const s = setup();
    expect(await s.sync()).toEqual({ ok: true, domains: 0 });
    await putEgressDomains(s.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    s.resolver.send.mockClear();
    expect(await s.sync()).toEqual({ ok: true, domains: 0 });
    expect(s.resolver.send).not.toHaveBeenCalled();
  });

  it("keeps the marker dirty when a change lands between the read and the clear, then sends it on the next run", async () => {
    // The sync has read the marker and the union; a second approval lands while it talks to Route 53.
    const t = setup();
    await putEgressDomains(t.quiet(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    let raced = false;
    const resolver = fakeResolver({ onUpdate: async () => {
      if (raced) return;
      raced = true;
      await putEgressDomains(t.quiet(), TEST_ORG, API, ["b.acme.dev"], { developerId: "dev-2" });
    } });
    const run = () => syncCellAllowList({ documentClient: t.db, tableName: "state", resolver, listId: LIST_ID, now: t.now, sleep: t.sleep });
    expect(await run()).toMatchObject({ ok: false });
    expect(resolver.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["a.acme.dev"] }]);
    expect(t.marker()).toMatchObject({ dirtySeq: 2 });
    expect(t.marker()!.syncedSeq).toBeUndefined();
    expect(await run()).toEqual({ ok: true, domains: 2 });
    expect(resolver.updates().at(-1)).toEqual({ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["a.acme.dev", "b.acme.dev"] });
    expect(t.marker()).toMatchObject({ dirtySeq: 2, syncedSeq: 2 });
  });

  it("does not lose a change made in the same millisecond as the one the sync read (dirtyAt alone could not tell them apart)", async () => {
    const t = setup({ now: () => new Date("2026-10-21T10:00:00.000Z") });
    await putEgressDomains(t.quiet(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    let raced = false;
    const resolver = fakeResolver({ onUpdate: async () => {
      if (raced) return;
      raced = true;
      await putEgressDomains(t.quiet(), OTHER_ORG, WEB, ["z.zeta.dev"], { developerId: "dev-2" });
    } });
    const run = () => syncCellAllowList({ documentClient: t.db, tableName: "state", resolver, listId: LIST_ID, now: t.now, sleep: t.sleep });
    expect(await run()).toMatchObject({ ok: false });
    expect((t.db.get(EGRESS_SYNC_KEY) as { dirtyAt: string }).dirtyAt).toBe("2026-10-21T10:00:00.000Z");
    expect(await run()).toEqual({ ok: true, domains: 2 });
    expect(resolver.updates().at(-1)!.Domains).toEqual(["a.acme.dev", "z.zeta.dev"]);
  });

  it("does not let a slower run that read an older union leave the marker clean over a newer union", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    let inner = false;
    const fast = fakeResolver();
    const slow = fakeResolver({ onUpdate: async () => {
      if (inner) return;
      inner = true;
      // While the slow run is in Route 53 with the old union, a change lands and a faster run sends the newer union and clears it.
      await putEgressDomains(t.quiet(), TEST_ORG, API, ["b.acme.dev"], { developerId: "dev-2" });
      await syncCellAllowList({ documentClient: t.db, tableName: "state", resolver: fast, listId: LIST_ID, now: t.now, sleep: t.sleep });
    } });
    const slowRun = await syncCellAllowList({ documentClient: t.db, tableName: "state", resolver: slow, listId: LIST_ID, now: t.now, sleep: t.sleep });
    expect(fast.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["a.acme.dev", "b.acme.dev"] }]);
    expect(slowRun).toMatchObject({ ok: false });
    // The slow run's clear was refused, and the firewall may hold its older union: the marker is dirty again, so the next run puts it right.
    const marker = t.marker()!;
    expect(marker.dirtySeq!).toBeGreaterThan(marker.syncedSeq!);
    expect(await t.sync()).toEqual({ ok: true, domains: 2 });
    expect(t.marker()!.syncedSeq).toBe(t.marker()!.dirtySeq);
  });

  it("returns ok false and leaves the marker dirty when Route 53 fails, and the next scheduled run succeeds", async () => {
    const failing = fakeResolver({ failUpdate: Object.assign(new Error("throttled"), { name: "ThrottlingException" }) });
    const t = setup({ resolver: failing });
    await putEgressDomains(t.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(t.marker()).toMatchObject({ dirtySeq: 1 });
    expect(t.marker()!.syncedSeq).toBeUndefined();
    expect(await t.sync()).toEqual({ ok: false, domains: 0 });
    const healthy = fakeResolver();
    expect(await syncCellAllowList({ documentClient: t.db, tableName: "state", resolver: healthy, listId: LIST_ID, now: t.now, sleep: t.sleep })).toEqual({ ok: true, domains: 1 });
    expect(t.marker()).toMatchObject({ dirtySeq: 1, syncedSeq: 1 });
  });

  it("waits for the list to finish updating before it clears the marker, and gives up (marker dirty) when it never does", async () => {
    const slow = fakeResolver({ updating: 3 });
    const t = setup({ resolver: slow });
    await putEgressDomains(t.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(slow.sent.map((entry) => entry.name.replace("Command", ""))).toEqual(["UpdateFirewallDomains", "GetFirewallDomainList", "GetFirewallDomainList", "GetFirewallDomainList", "GetFirewallDomainList"]);
    expect(t.sleep).toHaveBeenCalledTimes(3);
    expect(t.marker()).toMatchObject({ syncedSeq: 1 });

    const stuck = setup({ resolver: fakeResolver({ updating: 1000 }) });
    await putEgressDomains(stuck.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(stuck.marker()!.syncedSeq).toBeUndefined();
    const failed = setup({ resolver: fakeResolver({ status: "COMPLETE_IMPORT_FAILED" }) });
    expect((await putEgressDomains(failed.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" })).warning).toBe("allowed domains will apply within 5 minutes");
    expect(failed.marker()!.syncedSeq).toBeUndefined();
  });

  it("leaves a rejected or removed domain out of the REPLACE payload (Task 19 review, Minor 6)", async () => {
    const t = setup();
    const cloud = t.deps(true);
    await putEgressDomains(cloud, TEST_ORG, WEB, ["ok.acme.dev", "no.acme.dev", "gone.acme.dev", "wait.acme.dev"], { developerId: "dev-1" });
    for (const domain of ["ok.acme.dev", "gone.acme.dev"]) await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain, decision: "approved", operatorId: "staff-1" });
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "no.acme.dev", decision: "rejected", operatorId: "staff-1", reason: "no" });
    // Removing an approved domain syncs without it; rejected and pending ones were never in.
    await putEgressDomains(cloud, TEST_ORG, WEB, ["ok.acme.dev", "no.acme.dev", "wait.acme.dev"], { developerId: "dev-1" });
    for (const update of t.resolver.updates()) expect(update.Domains).not.toContain("no.acme.dev");
    expect(t.resolver.updates().at(-1)!.Domains).toEqual(["ok.acme.dev"]);
  });

  it("remembers which list it filled, and fills a different (replaced, empty) list even when the marker is clean (Minor 1)", async () => {
    const t = setup();
    await putEgressDomains(t.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(t.marker()).toMatchObject({ syncedSeq: 1, syncedListId: LIST_ID });
    t.resolver.send.mockClear();
    const replaced = fakeResolver();
    const otherList = () => syncCellAllowList({ documentClient: t.db, tableName: "state", resolver: replaced, listId: "rslvr-fdl-replacement", now: t.now, sleep: t.sleep });
    expect(await otherList()).toEqual({ ok: true, domains: 1 });
    expect(replaced.updates()).toEqual([{ FirewallDomainListId: "rslvr-fdl-replacement", Operation: "REPLACE", Domains: ["a.acme.dev"] }]);
    expect(t.marker()).toMatchObject({ syncedListId: "rslvr-fdl-replacement" });
    replaced.send.mockClear();
    expect(await otherList()).toEqual({ ok: true, domains: 0 });
    expect(replaced.send).not.toHaveBeenCalled();
  });

  it("reads a marker with no dirtySeq (written before the counter existed) as dirty, then settles", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    t.db.set({ pk: EGRESS_SYNC_KEY.pk, sk: EGRESS_SYNC_KEY.sk, entityType: "EGRESS_SYNC", dirtyAt: "2026-10-01T00:00:00.000Z", syncedAt: "2026-10-01T00:00:00.000Z" });
    expect(await t.sync()).toEqual({ ok: true, domains: 1 });
    expect(t.resolver.updates()).toHaveLength(1);
    expect(await t.sync()).toEqual({ ok: true, domains: 0 });
    expect(t.resolver.updates()).toHaveLength(1);
  });

  it("sends the commands the Resolver API defines, to the one list", async () => {
    const t = setup();
    await putEgressDomains(t.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    const [update, read] = t.resolver.send.mock.calls.map(([command]) => command);
    expect(update).toBeInstanceOf(UpdateFirewallDomainsCommand);
    expect(read).toBeInstanceOf(GetFirewallDomainListCommand);
    expect((read as { input: unknown }).input).toEqual({ FirewallDomainListId: LIST_ID });
  });
});

const BAD_DOMAINS = ["*", "com", "github.io", "*.github.io", "acme.dev.", "ACME.dev", "bücher.example.com", "10.0.0.1", "localhost"];

describe("domains at the firewall boundary (Task 19 review, Important 1)", () => {
  it("exports the predicate the settings route uses: hostnames and *.hostnames that are not public suffixes, lower case, no trailing dot", () => {
    for (const bad of BAD_DOMAINS) expect(isAllowedDomain(bad), bad).toBe(false);
    for (const good of ["acme.dev", "*.acme.dev", "xn--bcher-kva.example.com", "a.b.acme.dev"]) expect(isAllowedDomain(good), good).toBe(true);
  });

  it("is enforced by putEgressDomains: a bad domain is refused, whatever the caller, and nothing is written", async () => {
    const t = setup();
    for (const bad of BAD_DOMAINS) {
      await expect(putEgressDomains(t.deps(), TEST_ORG, SOURCE, ["ok.acme.dev", bad], { developerId: "dev-1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.db.get(egressDomainsKey(TEST_ORG, SOURCE))).toBeUndefined();
    expect(t.db.get(EGRESS_SYNC_KEY)).toBeUndefined();
    // Punycode is a valid hostname and is accepted.
    await putEgressDomains(t.deps(), TEST_ORG, SOURCE, ["xn--bcher-kva.example.com", "*.acme.dev"], { developerId: "dev-1" });
    expect(t.resolver.updates().at(-1)!.Domains).toEqual(["*.acme.dev", "xn--bcher-kva.example.com"]);
  });

  it("is the sync's last line of defence: an approved bad entry is dropped and logged, never sent", async () => {
    const t = setup();
    const entries = [...BAD_DOMAINS, "ok.acme.dev"].map((domain) => ({ domain, status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: "dev-1" }));
    t.db.set({ ...egressDomainsKey(TEST_ORG, WEB), entityType: "EGRESS_DOMAINS", orgId: TEST_ORG, owner: WEB, active: true, domains: entries, updatedAt: "2026-10-01T00:00:00.000Z" });
    t.db.set({ ...EGRESS_SYNC_KEY, entityType: "EGRESS_SYNC", dirtyAt: "2026-10-01T00:00:00.000Z", dirtySeq: 1 });
    expect(await t.sync()).toEqual({ ok: true, domains: 1 });
    expect(t.resolver.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["ok.acme.dev"] }]);
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).find((line) => line.includes("egress.domains_dropped"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ dropped: BAD_DOMAINS.length });
  });

  it("sends the sentinel when every approved entry was bad", async () => {
    const t = setup();
    const entries = ["*", "com"].map((domain) => ({ domain, status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: "dev-1" }));
    t.db.set({ ...egressDomainsKey(TEST_ORG, WEB), entityType: "EGRESS_DOMAINS", orgId: TEST_ORG, owner: WEB, active: true, domains: entries, updatedAt: "2026-10-01T00:00:00.000Z" });
    t.db.set({ ...EGRESS_SYNC_KEY, entityType: "EGRESS_SYNC", dirtyAt: "2026-10-01T00:00:00.000Z", dirtySeq: 1 });
    expect(await t.sync()).toEqual({ ok: true, domains: 0 });
    expect(t.resolver.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: [EMPTY_UNION_SENTINEL] }]);
  });

  it("is applied by the backfill, which asks only for the good stored domains (and reads them lower case)", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["*", "com", "github.io", "acme.dev.", "bücher.example.com", "Old.Acme.dev", "ok.acme.dev"]);
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: true, projects: 1 });
    expect((t.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains.map((entry) => entry.domain)).toEqual(["old.acme.dev", "ok.acme.dev"]);
  });
});

function legacyProject(db: FakeDynamoDb, project: string, allowedDomains: string[] | undefined, extra: { orgId?: OrgId; revisions?: Array<string[] | undefined>; status?: string } = {}): void {
  const orgId = extra.orgId ?? TEST_ORG;
  const revisions = extra.revisions ?? [allowedDomains];
  revisions.forEach((domains, index) => db.set({
    ...projectRevisionKey(orgId, project, index + 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: { name: project, revision: index + 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x", ...(domains === undefined ? {} : { network: { allowedDomains: domains } }) },
  }));
  if (extra.status !== undefined) db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", name: project, status: extra.status, createdAt: "2026-10-02T00:00:00.000Z", createdBy: "dev-1" });
}

describe("the legacy backfill", () => {
  const audits = (db: FakeDynamoDb) => db.find((candidate) => candidate.pk === "EGRESS_AUDIT") as unknown as EgressAuditItem[];

  it("asks Rovara, as the system, for the domains a project stored before approvals existed, and only once", async () => {
    const t = setup();
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev", "registry.npmjs.org"], ["old.acme.dev", "registry.npmjs.org", "new.acme.dev"]] });
    legacyProject(t.db, "api", ["x.beta.dev"], { orgId: OTHER_ORG });
    legacyProject(t.db, "docs", undefined);
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: true, projects: 2 });
    // The newest revision's domains, without those every project has; pending, so nothing is served.
    expect((t.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains).toMatchObject([{ domain: "old.acme.dev", status: "pending", requestedBy: "system" }, { domain: "new.acme.dev", status: "pending" }]);
    expect(t.db.get(egressDomainsKey(OTHER_ORG, API))).toMatchObject({ domains: [{ domain: "x.beta.dev", status: "pending" }] });
    expect(t.db.get(egressDomainsKey(TEST_ORG, { kind: "project", project: "docs" }))).toBeUndefined();
    expect(audits(t.db).map((audit) => `${audit.domain}:${audit.action}:${audit.actor.kind}:${audit.actor.id}`).sort()).toEqual([
      "new.acme.dev:requested:operator:system", "old.acme.dev:requested:operator:system", "x.beta.dev:requested:operator:system",
    ]);
    expect(t.resolver.send).not.toHaveBeenCalled();
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toMatchObject({ projects: 2 });
    // Idempotent: a project that gains stored domains afterwards is not swept in again.
    legacyProject(t.db, "late", ["late.acme.dev"]);
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: false, projects: 0 });
    expect(t.db.get(egressDomainsKey(TEST_ORG, { kind: "project", project: "late" }))).toBeUndefined();
  });

  it("leaves a project that already has an egress item alone, so a save made since is never undone", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["saved.acme.dev"], { developerId: "dev-1" });
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: true, projects: 0 });
    expect((t.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains.map((entry) => entry.domain)).toEqual(["saved.acme.dev"]);
  });

  it("starts an archived project's item inactive", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"], { status: "archived" });
    await backfillLegacyEgress(t.deps(true));
    expect(t.db.get(egressDomainsKey(TEST_ORG, WEB))).toMatchObject({ active: false, domains: [{ domain: "old.acme.dev", status: "pending" }] });
  });

  it("does nothing off Rovara Cloud, where a stored domain was never meant to wait for staff", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    expect(await backfillLegacyEgress(t.deps(false))).toEqual({ ran: false, projects: 0 });
    expect(t.db.get(egressDomainsKey(TEST_ORG, WEB))).toBeUndefined();
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toBeUndefined();
  });

  it("is not marked done when it stops partway, and the next run finishes", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    legacyProject(t.db, "api", ["x.beta.dev"]);
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT#api"), error: { name: "InternalServerError" } });
    await expect(backfillLegacyEgress(t.deps(true))).rejects.toThrow();
    // Not done: the marker only keeps where it got to (the project that was written before the failure).
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeUndefined();
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: true, projects: 1 });
    expect(t.db.get(egressDomainsKey(TEST_ORG, API))).toMatchObject({ domains: [{ domain: "x.beta.dev" }] });
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toBeDefined();
  });
});

describe("the reconcile of egress items with the current revision (final review I2)", () => {
  const audits = (db: FakeDynamoDb) => db.find((candidate) => candidate.pk === "EGRESS_AUDIT") as unknown as EgressAuditItem[];
  const items = (t: ReturnType<typeof setup>, owner: EgressOwner = WEB, orgId: OrgId = TEST_ORG) => (t.db.get(egressDomainsKey(orgId, owner)) as unknown as EgressDomainsItem);
  /** A clock that has moved well past the item's last write, so an in-flight save is not mistaken for a stopped one. */
  const later = (t: ReturnType<typeof setup>) => ({ ...t.deps(true), now: () => new Date("2026-10-21T10:30:00.000Z") });

  it("asks for a domain the current revision lists and the item lacks, and drops one the item holds and the revision no longer lists", async () => {
    const t = setup();
    // The save wrote its revision, then died before the item: the revision lists new.acme.dev, the item still holds the removed one.
    await putEgressDomains(t.quiet(false), TEST_ORG, WEB, ["old.acme.dev"], { developerId: "dev-1" });
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev"], ["new.acme.dev", "registry.npmjs.org"]] });
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 1 });
    expect(items(t).domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);
    expect(items(t).domains[0]).toMatchObject({ status: "pending", requestedBy: "system" });
    expect(audits(t.db).map((audit) => `${audit.domain}:${audit.action}`).sort()).toEqual(["new.acme.dev:requested", "old.acme.dev:auto_approved", "old.acme.dev:removed"]);
    // A second run finds nothing to do.
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 0 });
  });

  it("keeps the status of a domain both agree on, and takes a removed approved domain out of the served union", async () => {
    const t = setup();
    const cloud = t.deps(true);
    await putEgressDomains(cloud, TEST_ORG, WEB, ["keep.acme.dev", "gone.acme.dev"], { developerId: "dev-1" });
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "keep.acme.dev", decision: "approved", operatorId: "staff-1" });
    await decideEgressDomain(cloud, { orgId: TEST_ORG, owner: WEB, domain: "gone.acme.dev", decision: "approved", operatorId: "staff-1" });
    legacyProject(t.db, "web", undefined, { revisions: [["keep.acme.dev", "gone.acme.dev"], ["keep.acme.dev"]] });
    t.resolver.send.mockClear();
    const outcome = await runEgressDomainsSync({ ...later(t), sync: () => syncCellAllowList({ documentClient: t.db, tableName: "state", resolver: t.resolver, listId: LIST_ID, now: () => new Date("2026-10-21T10:30:00.000Z"), sleep: t.sleep }) });
    expect(outcome.ok).toBe(true);
    expect(items(t).domains).toMatchObject([{ domain: "keep.acme.dev", status: "approved" }]);
    expect(t.resolver.updates().at(-1)).toEqual({ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["keep.acme.dev"] });
  });

  it("leaves an item written a moment ago alone: a save may be between its two writes", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["new.acme.dev"], { developerId: "dev-1" });
    legacyProject(t.db, "web", ["old.acme.dev"]);
    expect(await reconcileEgressWithRevisions(t.deps(true))).toEqual({ repaired: 0 });
    expect(items(t).domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);
  });

  it("leaves a project with no revision, an owner that is not a project, and every other org's item alone", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(t.quiet(true), TEST_ORG, SOURCE, ["b.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(t.quiet(true), OTHER_ORG, API, ["c.beta.dev"], { developerId: "dev-2" });
    // The other org's revision for the same name lists something else: it must not be read for TEST_ORG's item, nor the reverse.
    legacyProject(t.db, "api", ["c.beta.dev"], { orgId: OTHER_ORG });
    legacyProject(t.db, "web", ["a.acme.dev"], { orgId: OTHER_ORG });
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 0 });
    expect(items(t).domains.map((entry) => entry.domain)).toEqual(["a.acme.dev"]);
  });

  it("repairs an archived project's item without waking it", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["old.acme.dev"], { developerId: "dev-1" });
    await setEgressOwnerActive(t.quiet(true), TEST_ORG, WEB, false);
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev"], ["new.acme.dev"]], status: "archived" });
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 1 });
    expect(items(t)).toMatchObject({ active: false, domains: [{ domain: "new.acme.dev" }] });
  });

  it("skips a stored domain the firewall must never serve, and is part of the scheduled run", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["old.acme.dev"], { developerId: "dev-1" });
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev"], ["new.acme.dev", "*"]] });
    const outcome = await runEgressDomainsSync({ ...later(t), sync: async () => ({ ok: true, domains: 0 }) });
    expect(outcome.ok).toBe(true);
    expect(items(t).domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);
  });
});

describe("the reconciles are bounded and isolated (follow-up N3)", () => {
  const items = (t: ReturnType<typeof setup>, project: string) => (t.db.get(egressDomainsKey(TEST_ORG, { kind: "project", project })) as unknown as EgressDomainsItem);
  const later = (t: ReturnType<typeof setup>, at = "2026-10-21T10:30:00.000Z") => ({ ...t.deps(true), now: () => new Date(at) });
  /** `count` projects whose items still hold a domain their newest revision dropped. */
  async function stale(t: ReturnType<typeof setup>, count: number): Promise<string[]> {
    const names = Array.from({ length: count }, (_, index) => `p${String(index).padStart(2, "0")}`);
    for (const name of names) {
      await putEgressDomains(t.quiet(true), TEST_ORG, { kind: "project", project: name }, ["old.acme.dev"], { developerId: "dev-1" });
      legacyProject(t.db, name, undefined, { revisions: [["old.acme.dev"], ["new.acme.dev"]] });
    }
    return names;
  }
  /** Wraps the fake so each command waits a tick and the most commands of a kind in flight at once are recorded. */
  function watchConcurrency(t: ReturnType<typeof setup>) {
    const inFlight = { query: 0, write: 0 };
    const most = { query: 0, write: 0 };
    const send = t.db.send.bind(t.db);
    t.db.send = (async (command: { constructor: { name: string } }) => {
      const kind = command.constructor.name === "QueryCommand" ? "query" : command.constructor.name === "TransactWriteCommand" ? "write" : undefined;
      if (kind === undefined) return send(command as never);
      inFlight[kind] += 1;
      most[kind] = Math.max(most[kind], inFlight[kind]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await send(command as never);
      } finally { inFlight[kind] -= 1; }
    });
    return most;
  }

  it("reads the revisions several at a time, within its bound, and writes one item at a time", async () => {
    const t = setup();
    const names = await stale(t, 30);
    const most = watchConcurrency(t);
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 30 });
    expect(most.query).toBeGreaterThan(1);
    expect(most.query).toBeLessThanOrEqual(EGRESS_RECONCILE_CONCURRENCY);
    expect(most.write).toBe(1);
    for (const name of names) expect(items(t, name).domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);
  });

  it("repairs the others when one project's revision cannot be read, and then reports the failure", async () => {
    const t = setup();
    const names = await stale(t, 6);
    t.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input).includes("PROJECT#p03"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(reconcileEgressWithRevisions(later(t))).rejects.toThrow("1 egress item(s)");
    for (const name of names.filter((candidate) => candidate !== "p03")) expect(items(t, name).domains.map((entry) => entry.domain), name).toEqual(["new.acme.dev"]);
    expect(items(t, "p03").domains.map((entry) => entry.domain)).toEqual(["old.acme.dev"]);
    // The next run finishes it.
    expect(await reconcileEgressWithRevisions(later(t))).toEqual({ repaired: 1 });
  });

  it("looks at no more than its per-run limit, moving along so every item is reached within a few runs", async () => {
    const t = setup();
    const names = await stale(t, 5);
    const slice = (index: number) => new Date(Date.parse("2026-10-21T10:30:00.000Z") + index * 300_000).toISOString();
    const repaired: number[] = [];
    for (let run = 0; run < 3; run += 1) repaired.push((await reconcileEgressWithRevisions(later(t, slice(run)), { limit: 2 })).repaired);
    expect(repaired).toEqual([2, 2, 1]);
    for (const name of names) expect(items(t, name).domains.map((entry) => entry.domain), name).toEqual(["new.acme.dev"]);
  });

  it("flips the others when one project's META cannot be read, and then reports the failure", async () => {
    const t = setup();
    for (const name of ["a", "b", "c"]) {
      await putEgressDomains(t.quiet(true), TEST_ORG, { kind: "project", project: name }, ["x.acme.dev"], { developerId: "dev-1" });
      legacyProject(t.db, name, ["x.acme.dev"], { status: "archived" });
    }
    t.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("PROJECT#b"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(reconcileProjectEgress({ documentClient: t.db, tableName: "state", egress: t.deps(true) })).rejects.toThrow("1 egress item(s)");
    expect([items(t, "a").active, items(t, "b").active, items(t, "c").active]).toEqual([false, true, false]);
  });

  it("runs the revision reconcile although the META reconcile failed, and the META reconcile although the revision one failed, and still syncs", async () => {
    const t = setup();
    await putEgressDomains(t.quiet(true), TEST_ORG, WEB, ["old.acme.dev"], { developerId: "dev-1" });
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev"], ["new.acme.dev"]] });
    t.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("PROJECT#web"), error: { name: "ProvisionedThroughputExceededException" } });
    const sync = vi.fn(async () => ({ ok: true, domains: 0 }));
    const metaFailed = await runEgressDomainsSync({ ...later(t), sync });
    expect(metaFailed.ok).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(items(t, "web").domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);

    const u = setup();
    await putEgressDomains(u.quiet(true), TEST_ORG, API, ["a.acme.dev"], { developerId: "dev-1" });
    legacyProject(u.db, "api", ["a.acme.dev"], { status: "archived" });
    await putEgressDomains(u.quiet(true), TEST_ORG, WEB, ["old.acme.dev"], { developerId: "dev-1" });
    legacyProject(u.db, "web", undefined, { revisions: [["old.acme.dev"], ["new.acme.dev"]] });
    u.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input).includes("PROJECT#web"), error: { name: "ProvisionedThroughputExceededException" } });
    const revisionFailed = await runEgressDomainsSync({ ...later(u), sync });
    expect(revisionFailed.ok).toBe(false);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(items(u, "api").active).toBe(false);
  });
});

const itemsOf = (t: { db: FakeDynamoDb }) => t.db.find((item) => item.pk === "EGRESS_DOMAINS" && String(item.sk).startsWith("ORG#")) as unknown as EgressDomainsItem[];

describe("the legacy backfill is time-bounded and resumable (final review M6)", () => {
  /** A clock that moves 100 ms each time it is read. */
  const ticking = () => { let at = 0; return () => { at += 100; return at; }; };

  it("stops when its time is up with a cursor on its marker, and the next run carries on, asking for every project once", async () => {
    const t = setup();
    for (const name of ["a1", "a2", "a3", "a4", "a5"]) legacyProject(t.db, name, [`${name}.acme.dev`]);
    let total = 0;
    let runs = 0;
    for (; runs < 10; runs += 1) {
      const outcome = await backfillLegacyEgress(t.deps(true), { deadline: 350, clock: ticking(), pageSize: 2 });
      total += outcome.projects;
      if (t.db.get(EGRESS_BACKFILL_KEY)?.completedAt !== undefined) break;
      // Unfinished: the marker keeps where it got to, and the run made progress.
      expect(t.db.get(EGRESS_BACKFILL_KEY)).toMatchObject({ cursor: { pk: expect.any(String) as string, sk: expect.any(String) as string } });
      expect(outcome.projects).toBeGreaterThan(0);
    }
    expect(runs).toBeGreaterThan(0);
    expect(total).toBe(5);
    expect(itemsOf(t)).toHaveLength(5);
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toMatchObject({ projects: 5 });
    expect(t.db.get(EGRESS_BACKFILL_KEY)).not.toHaveProperty("cursor");
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: false, projects: 0 });
  });

  it("stops in the middle of one page of projects when its time is up, and no project is lost or asked twice", async () => {
    const t = setup();
    for (const name of ["a1", "a2", "a3", "a4", "a5"]) legacyProject(t.db, name, [`${name}.acme.dev`]);
    // One page holds all five; the clock runs out after the first whole project.
    const first = await backfillLegacyEgress(t.deps(true), { deadline: 150, clock: ticking() });
    expect(first.projects).toBeGreaterThan(0);
    expect(first.projects).toBeLessThan(5);
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeUndefined();
    let total = first.projects;
    for (let runs = 0; runs < 10 && t.db.get(EGRESS_BACKFILL_KEY)?.completedAt === undefined; runs += 1) total += (await backfillLegacyEgress(t.deps(true), { deadline: 150, clock: ticking() })).projects;
    expect(total).toBe(5);
    expect(itemsOf(t)).toHaveLength(5);
  });

  it("moves on by a whole project even when it starts after its deadline", async () => {
    const t = setup();
    for (const name of ["a1", "a2", "a3"]) legacyProject(t.db, name, [`${name}.acme.dev`]);
    const outcome = await backfillLegacyEgress(t.deps(true), { deadline: 0, clock: ticking() });
    expect(outcome.projects).toBe(1);
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeUndefined();
  });

  it("asks only for a project's newest revision even when its revisions are read on different pages", async () => {
    const t = setup();
    legacyProject(t.db, "web", undefined, { revisions: [["old.acme.dev"], ["old.acme.dev", "mid.acme.dev"], ["new.acme.dev"]] });
    legacyProject(t.db, "api", ["x.beta.dev"], { orgId: OTHER_ORG });
    for (let runs = 0; runs < 10 && t.db.get(EGRESS_BACKFILL_KEY)?.completedAt === undefined; runs += 1) await backfillLegacyEgress(t.deps(true), { deadline: 150, clock: ticking(), pageSize: 1 });
    expect((t.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains.map((entry) => entry.domain)).toEqual(["new.acme.dev"]);
    expect(t.db.get(egressDomainsKey(OTHER_ORG, API))).toMatchObject({ domains: [{ domain: "x.beta.dev" }] });
  });

  it("keeps its progress when a write fails partway, and the next run resumes after the last whole project", async () => {
    const t = setup();
    legacyProject(t.db, "a1", ["a1.acme.dev"]);
    legacyProject(t.db, "a2", ["a2.acme.dev"]);
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT#a2"), error: { name: "InternalServerError" } });
    await expect(backfillLegacyEgress(t.deps(true))).rejects.toThrow();
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeUndefined();
    expect((await backfillLegacyEgress(t.deps(true))).projects).toBeGreaterThanOrEqual(1);
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeDefined();
    expect(itemsOf(t)).toHaveLength(2);
  });
});

describe("the scheduled run", () => {
  it("backfills first, then syncs, and says whether the firewall is current", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    await putEgressDomains(t.quiet(false), OTHER_ORG, WEB, ["ok.beta.dev"], { developerId: "dev-2" });
    const outcome = await runEgressDomainsSync({ ...t.deps(true), sync: t.sync });
    expect(outcome).toEqual({ ok: true, domains: 1, backfilled: 1 });
    expect(t.resolver.updates()).toEqual([{ FirewallDomainListId: LIST_ID, Operation: "REPLACE", Domains: ["ok.beta.dev"] }]);
    expect(t.db.get(egressDomainsKey(TEST_ORG, WEB))).toMatchObject({ domains: [{ status: "pending" }] });
    // Nothing changed: a quiet run.
    t.resolver.send.mockClear();
    expect(await runEgressDomainsSync({ ...t.deps(true), sync: t.sync })).toEqual({ ok: true, domains: 0, backfilled: 0 });
    expect(t.resolver.send).not.toHaveBeenCalled();
  });

  it("syncs BEFORE it backfills, so a large backfill never starves the firewall (final review M6)", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    const order: string[] = [];
    const sync = async () => { order.push(`sync with ${String(itemsOf(t).length)} items`); return t.sync(); };
    await runEgressDomainsSync({ ...t.deps(true), sync });
    order.push(`after: ${String(itemsOf(t).length)} items`);
    expect(order).toEqual(["sync with 0 items", "after: 1 items"]);
  });

  it("hands the backfill what is left of its budget and carries on next run", async () => {
    const t = setup();
    for (const name of ["a1", "a2", "a3"]) legacyProject(t.db, name, [`${name}.acme.dev`]);
    let at = 0;
    const first = await runEgressDomainsSync(t.deps(true), { budgetMs: 150, clock: () => { at += 100; return at; } });
    expect(first.backfilled).toBeGreaterThan(0);
    expect(first.backfilled).toBeLessThan(3);
    expect(t.db.get(EGRESS_BACKFILL_KEY)?.completedAt).toBeUndefined();
    let guard = 0;
    while (t.db.get(EGRESS_BACKFILL_KEY)?.completedAt === undefined && guard < 10) { guard += 1; at = 0; await runEgressDomainsSync(t.deps(true), { budgetMs: 150, clock: () => { at += 100; return at; } }); }
    expect(itemsOf(t)).toHaveLength(3);
  });

  it("still syncs when the backfill fails, and reports it", async () => {
    const t = setup();
    legacyProject(t.db, "web", ["old.acme.dev"]);
    await putEgressDomains(t.quiet(false), OTHER_ORG, WEB, ["ok.beta.dev"], { developerId: "dev-2" });
    t.db.injectFault({ command: "ScanCommand", error: { name: "ProvisionedThroughputExceededException" } });
    const outcome = await runEgressDomainsSync({ ...t.deps(true), sync: t.sync });
    expect(outcome).toMatchObject({ ok: false, domains: 1, backfilled: 0 });
    expect(t.resolver.updates()).toHaveLength(1);
  });

  it("is what the broker runs for the egress-domains-sync schedule event, and answers 500 while the firewall is behind", async () => {
    const sync = vi.fn(async () => ({ ok: true, domains: 3 }));
    const h = await createDeveloperTaskBroker({ register: false, brokerExtra: { cloud: true, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" }, egressDomainsSync: sync } });
    legacyProject(h.db, "web", ["old.acme.dev"]);
    const ran = await h.handler({ source: "agentx.egress-domains-sync" });
    expect(ran.statusCode).toBe(200);
    expect(JSON.parse(ran.body)).toMatchObject({ ok: true, domains: 3, backfilled: 1 });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(h.db.get(egressDomainsKey(TEST_ORG, WEB))).toMatchObject({ domains: [{ domain: "old.acme.dev", status: "pending" }] });
    sync.mockResolvedValueOnce({ ok: false, domains: 0 });
    expect((await h.handler({ source: "agentx.egress-domains-sync" })).statusCode).toBe(500);
  });
});
