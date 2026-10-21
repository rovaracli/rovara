// Plan 2, Task 19: the approved union reaches the cell's DNS firewall. `syncCellAllowList` reads the sync marker, then the union, replaces the
// firewall's "ProjectAllowList" with it (in chunks of the API's per-call limit) and clears the marker only if nothing changed meanwhile.
// The scheduled run first backfills a request for every domain stored before approvals existed.
import { GetFirewallDomainListCommand, UpdateFirewallDomainsCommand } from "@aws-sdk/client-route53resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EGRESS_SYNC_KEY, egressDomainsKey, projectMetaKey, projectRevisionKey, type EgressAuditItem, type EgressDomainsItem, type EgressOwner, type OrgId,
} from "../../packages/contracts/src/index.js";
import {
  EGRESS_BACKFILL_KEY, EMPTY_UNION_SENTINEL, FIREWALL_DOMAINS_PER_CALL, backfillLegacyEgress, runEgressDomainsSync, syncCellAllowList,
} from "../../packages/broker/src/aws/egress-domains-sync.js";
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

  it("sends the commands the Resolver API defines, to the one list", async () => {
    const t = setup();
    await putEgressDomains(t.deps(), TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    const [update, read] = t.resolver.send.mock.calls.map(([command]) => command);
    expect(update).toBeInstanceOf(UpdateFirewallDomainsCommand);
    expect(read).toBeInstanceOf(GetFirewallDomainListCommand);
    expect((read as GetFirewallDomainListCommand).input).toEqual({ FirewallDomainListId: LIST_ID });
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
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toBeUndefined();
    expect(await backfillLegacyEgress(t.deps(true))).toEqual({ ran: true, projects: 1 });
    expect(t.db.get(egressDomainsKey(TEST_ORG, API))).toMatchObject({ domains: [{ domain: "x.beta.dev" }] });
    expect(t.db.get(EGRESS_BACKFILL_KEY)).toBeDefined();
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
