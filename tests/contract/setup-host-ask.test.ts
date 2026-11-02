// Setup host asks (design setup-test-health 3.3, task SH12): the refusal list, one ask per host per project, the card, and the approval that goes through the project's own website change
// (propose, then the approver's commit with the second-person rule and the egress plan). The module is driven directly against the in-memory table; the card routes are driven through the whole broker
// in setup-host-cards.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, ProjectDefinitionSchema, developerOrgKey, egressDomainsKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, orgScoped, projectMetaKey, projectPk, projectRevisionKey, type OrgId,
} from "../../packages/contracts/src/index.js";
import {
  SETUP_HOST_JOIN_MAX, SETUP_HOST_OPEN_MAX, SETUP_HOST_REFUSED_MS, SETUP_HOST_REQUESTER_GONE, approveHostAsk, hostAlreadyAllowed, hostAskItem, hostAskItemsFor, hostAskState, hostAskSubjectId, hostProposalId,
  isInternationalName, listHostAsks, refusedCountsOf, refuseHostAsk, refuseSetupHost, requestHostAsk, setupHostHandler, setupRunStarterOf, type HostAskInput, type HostDecisionDeps,
} from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { proposeProjectAllowedDomains } from "../../packages/broker/src/org/project-allowed-domains.js";
import { projectDecisionCards } from "../../packages/broker/src/decisions/project.js";
import { createDecisionPerformer } from "../../packages/broker/src/decisions/performer.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OWNER = "a".repeat(64);
const ADMIN = "b".repeat(64);
const MEMBER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const project = "payments";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const HOST = "artifactory.acme-build.io";
const TASK = randomUUID();

function person(db: FakeDynamoDb, id: string, role: "owner" | "admin" | "member"): void {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role });
  db.set({ ...developerOrgKey(id), orgId, role });
  db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
}
/** A setup run's task record: what the broker wrote when OWNER started the run. */
function runTask(db: FakeDynamoDb, taskId: string, over: Record<string, unknown> = {}, forProject = project): void {
  db.set({ ...taskKey(taskId), entityType: "DEVTASK", taskId, orgId, project: forProject, purpose: "setup_agent", developerId: OWNER, ...over });
}

function world(options: { admin?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  audit.audit.documentClient = db as unknown as typeof audit.audit.documentClient;
  db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00.000Z", approvalMembershipVersion: 7, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
  person(db, OWNER, "owner");
  if (options.admin !== false) person(db, ADMIN, "admin");
  person(db, MEMBER, "member");
  db.set({ ...projectMetaKey(orgId, project), name: project, status: "active", createdAt: "2026-10-01T00:00:00.000Z", createdBy: OWNER, archiveRevision: 0 });
  const definition = ProjectDefinitionSchema.parse({
    name: project, revision: 1, repositories: [{ name: "main", url: "https://github.com/acme/web.git", path: "repo/main", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate.",
  });
  db.set({ ...projectRevisionKey(orgId, project, 1), entityType: "PROJECT", definition, registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
    runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } });
  db.set({ ...orgProjectCatalogKey(orgId, project), name: project, latestRevision: 1 });
  runTask(db, TASK);
  const clock = { now: T0 };
  const table = { documentClient: db, tableName: "state", now: () => clock.now, audit: audit.audit };
  const deps: HostDecisionDeps = { ...table, signInTableName: "signin" };
  const ask = (overrides: Partial<HostAskInput> = {}) => requestHostAsk(table, { orgId, project, host: HOST, taskId: TASK, projectDomains: [], journalN: 7, from: { path: "pip.conf", line: 2 }, ...overrides });
  return { db, audit, clock, table, deps, ask };
}
type World = ReturnType<typeof world>;
const askRow = (w: World, host = HOST, forProject = project) => w.db.get({ pk: projectPk(orgId, forProject), sk: `SETUP_HOST_ASK#${host}` });
const indexRow = (w: World, host = HOST) => w.db.get({ pk: orgScoped(orgId, "SETUP_HOST_OPEN"), sk: `${project}#${host}` });
const openCount = (w: World) => (w.db.get({ pk: projectPk(orgId, project), sk: "SETUP_HOST_OPEN_COUNT" }) as { open?: number } | undefined)?.open;
/** The transactions that carried a pending audit item (the ledger's outbox row), each as the list of what else it wrote: the audit is written WITH the change, not after it. */
const auditedTransactions = (w: World) => w.db.transactions().filter((items) => items.some((item) => String((item as { Put?: { Item?: { pk?: string } } }).Put?.Item?.pk ?? "").startsWith("AUDIT_PENDING")));
const writesAsk = (items: Array<Record<string, unknown>>, state: string) => items.some((item) => (item as { Put?: { Item?: { entityType?: string; state?: string } } }).Put?.Item?.entityType === "SETUP_HOST_ASK" && (item as { Put?: { Item?: { state?: string } } }).Put?.Item?.state === state);
const settlesAsk = (items: Array<Record<string, unknown>>) => items.some((item) => String((item as { Update?: { UpdateExpression?: string } }).Update?.UpdateExpression ?? "").includes("decidedBy"));
const proposals = (w: World) => w.db.find((item) => item.pk === projectPk(orgId, project) && String(item.sk).startsWith("EGRESS_PROPOSAL#"));

describe("refuseSetupHost: hosts that get no card", () => {
  it("accepts an ordinary private registry name", () => {
    expect(refuseSetupHost(HOST)).toBeUndefined();
    expect(refuseSetupHost("repo.internal-mirror.example.org")).toBeUndefined();
    expect(refuseSetupHost("Artifactory.Acme-Build.IO")).toBeUndefined();
  });
  it.each([
    ["10.0.0.5", "address_literal"], ["192.168.1.1", "address_literal"], ["[::1]", "address_literal"], ["::1", "address_literal"], ["fe80::1", "address_literal"], ["0x7f000001", "address_literal"], ["2130706433", "address_literal"],
    ["10.0.0.5:8080", "address_literal"],
    ["a.acme-build.io:8080", "not_a_host"], ["https://evil.acme-build.io", "not_a_host"], ["", "not_a_host"], ["a b.acme-build.io", "not_a_host"], [" a.acme-build.io", "not_a_host"], ["-bad.acme-build.io", "not_a_host"],
    ["host_name.acme-build.io", "not_a_host"], ["a..acme-build.io", "not_a_host"], ["single", "not_a_host"],
    ["\u212Aelvin.acme-build.io", "not_a_host"], ["bücher.acme-build.io", "not_a_host"],
    ["localhost", "private_name"], ["db.local", "private_name"], ["x.internal", "private_name"], ["nas.lan", "private_name"], ["router.home.arpa", "private_name"], ["5.0.0.10.in-addr.arpa", "private_name"],
    ["abc.onion", "private_name"], ["a.test", "private_name"], ["a.example", "private_name"], ["a.invalid", "private_name"], ["artifactory.corp", "private_name"], ["artifactory.corp.example", "private_name"],
    ["10-0-0-5.acme-build.io", "ip_in_name"], ["10.0.0.5.acme-build.io", "ip_in_name"], ["host-192-168-1-1.acme-build.io", "ip_in_name"], ["1-2-3-4.nip.io", "ip_in_name"], ["a.sslip.io", "ip_in_name"], ["a.xip.io", "ip_in_name"],
    ["a.traefik.me", "ip_in_name"], ["a.localtest.me", "ip_in_name"], ["a.lvh.me", "ip_in_name"], ["a.vcap.me", "ip_in_name"],
    ["pastebin.com", "paste_site"], ["raw.pastebin.com", "paste_site"], ["transfer.sh", "paste_site"], ["ntfy.sh", "paste_site"],
    ["bit.ly", "link_shortener"], ["x.tinyurl.com", "link_shortener"],
    ["abc.ngrok-free.app", "tunnel"], ["abc.ngrok-free.dev", "tunnel"], ["x.trycloudflare.com", "tunnel"], ["x.devtunnels.ms", "tunnel"], ["bore.pub", "tunnel"], ["x.zrok.io", "tunnel"],
    ["webhook.site", "webhook_sink"], ["abc.oast.fun", "webhook_sink"], ["x.pipedream.net", "webhook_sink"], ["x.oastify.com", "webhook_sink"], ["x.dnslog.cn", "webhook_sink"], ["x.ceye.io", "webhook_sink"], ["x.requestrepo.com", "webhook_sink"],
    ["acct.blob.core.windows.net", "raw_storage"], ["storage.googleapis.com", "raw_storage"], ["bucket.r2.cloudflarestorage.com", "raw_storage"], ["x.workers.dev", "raw_storage"],
    ["abc123.lambda-url.us-east-1.on.aws", "raw_storage"], ["d111.cloudfront.net", "raw_storage"], ["someone.github.io", "raw_storage"], ["gist.githubusercontent.com", "raw_storage"], ["raw.githubusercontent.com", "raw_storage"],
    ["x.azurewebsites.net", "raw_storage"], ["x.fly.dev", "raw_storage"], ["x.onrender.com", "raw_storage"], ["x.surge.sh", "raw_storage"], ["ipfs.io", "raw_storage"],
  ] as const)("%s is refused as %s", (host, kind) => {
    expect(refuseSetupHost(host)).toBe(kind);
  });
  it("matches whole labels only: a name that merely ends with a listed suffix is not refused", () => {
    expect(refuseSetupHost("notbit.ly")).toBeUndefined();
    expect(refuseSetupHost("mypastebin.com")).toBeUndefined();
    expect(refuseSetupHost("lambda-url.acme-build.io")).toBeUndefined();
    expect(refuseSetupHost("mygithub.io")).toBeUndefined();
  });
  it("is case and trailing-dot blind", () => {
    expect(refuseSetupHost("PASTEBIN.COM.")).toBe("paste_site");
  });
  it("refuses a name too long to be shown whole on a card", () => {
    expect(refuseSetupHost(`${"a".repeat(60)}.acme-build.io`)).toBe("too_long");
  });
  it("refuses a host on the company's production deny list (exact, wildcard)", () => {
    const deny = { accountIds: [], hosts: ["*.prod.acme-build.io", "db.acme-build.io"], arnPrefixes: [] };
    expect(refuseSetupHost("api.prod.acme-build.io", deny)).toBe("production");
    expect(refuseSetupHost("db.acme-build.io", deny)).toBe("production");
    expect(refuseSetupHost("artifactory.acme-build.io", deny)).toBeUndefined();
  });
  it("marks a name with a punycode label as international", () => {
    expect(isInternationalName("xn--bcher-kva.acme-build.io")).toBe(true);
    expect(isInternationalName(HOST)).toBe(false);
  });
});

describe("hostAlreadyAllowed", () => {
  it("reads the default list and the project's list with the firewall's wildcard rule (subdomains only)", () => {
    expect(hostAlreadyAllowed("registry.npmjs.org", [])).toBe(true);
    expect(hostAlreadyAllowed("s3.us-west-2.amazonaws.com", [])).toBe(true);
    expect(hostAlreadyAllowed("amazonaws.com", [])).toBe(false);
    expect(hostAlreadyAllowed(HOST, [])).toBe(false);
    expect(hostAlreadyAllowed(HOST, [HOST])).toBe(true);
    expect(hostAlreadyAllowed("a.acme-build.io", ["*.acme-build.io"])).toBe(true);
    expect(hostAlreadyAllowed("acme-build.io", ["*.acme-build.io"])).toBe(false);
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.length).toBeGreaterThan(10);
  });
});

describe("requestHostAsk: one ask per host per project, asked for by the run's recorded starter", () => {
  it("creates an open ask with where it came from and who started the run, and writes no ask for a refused host", async () => {
    const w = world();
    const result = await w.ask();
    expect(result).toMatchObject({ outcome: "created", ask: { host: HOST, state: "open", requestedBy: OWNER, taskId: TASK, journalN: 7, from: { path: "pip.conf", line: 2 }, joined: 0 } });
    expect(askRow(w)).toMatchObject({ state: "open", host: HOST });
    expect(indexRow(w)).toBeDefined();
    expect(openCount(w)).toBe(1);
    expect(await w.ask({ host: "pastebin.com" })).toMatchObject({ outcome: "refused", reason: "paste_site" });
    expect(askRow(w, "pastebin.com")).toBeUndefined();
    expect(await w.ask({ host: "10.1.2.3" })).toMatchObject({ outcome: "refused", reason: "address_literal" });
  });
  it("takes the requester from the run's task record only: a forged person in the request changes nothing", async () => {
    const w = world();
    const forged = { ...{ orgId, project, host: HOST, taskId: TASK, projectDomains: [] }, requestedBy: STRANGER } as HostAskInput;
    const result = await requestHostAsk(w.table, forged);
    expect(result).toMatchObject({ outcome: "created", ask: { requestedBy: OWNER } });
    expect(JSON.stringify(askRow(w))).not.toContain(STRANGER);
  });
  it("a started-on-behalf run is asked for by the starter", async () => {
    const w = world();
    runTask(w.db, TASK, { startedBy: { developerId: ADMIN } });
    expect(await setupRunStarterOf(w.table, orgId, project, TASK)).toBe(ADMIN);
  });
  it.each([
    ["a task that is not a setup run", { purpose: "setup_draft" }],
    ["a task with no purpose", { purpose: undefined }],
    ["another company's task", { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }],
    ["another project's task", { project: "other" }],
    ["a task whose starter is not a person id", { developerId: "nobody" }],
  ])("asks nothing for %s", async (_label, over) => {
    const w = world();
    const other = randomUUID();
    runTask(w.db, other, over);
    expect(await w.ask({ taskId: other })).toEqual({ outcome: "no_run" });
    expect(await w.ask({ taskId: randomUUID() })).toEqual({ outcome: "no_run" });
    expect(await w.ask({ taskId: "not-a-uuid" })).toEqual({ outcome: "no_run" });
    expect(askRow(w)).toBeUndefined();
    expect(openCount(w)).toBeUndefined();
  });
  it("counts, per run and kind, the hosts refused without a card", async () => {
    const w = world();
    await w.ask({ host: "pastebin.com" });
    await w.ask({ host: "raw.pastebin.com" });
    await w.ask({ host: "10.0.0.1" });
    await w.ask({ host: "bit.ly" });
    expect(await refusedCountsOf(w.table, orgId, project, TASK)).toEqual({ paste_site: 2, address_literal: 1, link_shortener: 1 });
    expect(await refusedCountsOf(w.table, orgId, project, randomUUID())).toEqual({});
  });
  it("answers already_allowed for a default or project host and makes no row", async () => {
    const w = world();
    expect(await w.ask({ host: "pypi.org" })).toEqual({ outcome: "already_allowed" });
    expect(await w.ask({ projectDomains: [HOST] })).toEqual({ outcome: "already_allowed" });
    expect(askRow(w)).toBeUndefined();
  });
  it("joins an open ask: the same host asked again is one row and one card", async () => {
    const w = world();
    await w.ask();
    const again = await w.ask({ journalN: 12, from: { path: "other.txt", line: 9 } });
    expect(again).toMatchObject({ outcome: "joined", ask: { joined: 1, journalN: 7, from: { path: "pip.conf", line: 2 } } });
    await w.ask();
    expect((askRow(w) as { joined: number }).joined).toBe(2);
    expect(await listHostAsks(w.table, orgId, project)).toHaveLength(1);
    expect(w.audit.recordedBy("setup.host_asked")).toHaveLength(1);
    expect(openCount(w)).toBe(1);
  });
  it("a join is counted up to a bound and no further (a conditional write)", async () => {
    const w = await Promise.resolve(world());
    await w.ask();
    w.db.set({ ...askRow(w)!, joined: SETUP_HOST_JOIN_MAX });
    const again = await w.ask();
    expect(again).toMatchObject({ outcome: "joined" });
    expect((askRow(w) as { joined: number }).joined).toBe(SETUP_HOST_JOIN_MAX);
  });
  it("two requests racing for a new host make one row, one count and one audit event", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.ask(), w.ask()]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "joined"]);
    expect(await listHostAsks(w.table, orgId, project)).toHaveLength(1);
    expect(openCount(w)).toBe(1);
    expect(w.audit.recordedBy("setup.host_asked")).toHaveLength(1);
  });
  it("a different project asking for the same host has its own ask", async () => {
    const w = world();
    await w.ask();
    const other = randomUUID();
    runTask(w.db, other, {}, "other");
    expect((await requestHostAsk(w.table, { orgId, project: "other", host: HOST, taskId: other, projectDomains: [] })).outcome).toBe("created");
  });
  it("stops at the open-ask cap with a conditional write on a counter, even when 25 asks arrive at once", async () => {
    const w = world();
    const outcomes = await Promise.all(Array.from({ length: SETUP_HOST_OPEN_MAX + 5 }, (_, i) => w.ask({ host: `h${String(i)}.acme-build.io` })));
    expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(SETUP_HOST_OPEN_MAX);
    expect(outcomes.filter((o) => o.outcome === "too_many_open")).toHaveLength(5);
    expect(openCount(w)).toBe(SETUP_HOST_OPEN_MAX);
    expect(await listHostAsks(w.table, orgId, project)).toHaveLength(SETUP_HOST_OPEN_MAX);
  });
  it("a settled ask gives its place back", async () => {
    const w = world();
    for (let i = 0; i < SETUP_HOST_OPEN_MAX; i += 1) await w.ask({ host: `h${String(i)}.acme-build.io` });
    expect(await w.ask({ host: "extra.acme-build.io" })).toEqual({ outcome: "too_many_open" });
    await refuseHostAsk(w.deps, { orgId, project, host: "h0.acme-build.io", by: ADMIN, requestId: randomUUID() });
    expect(openCount(w)).toBe(SETUP_HOST_OPEN_MAX - 1);
    expect((await w.ask({ host: "extra.acme-build.io" })).outcome).toBe("created");
  });
  it("a refused host stays refused for a week and then may be asked again", async () => {
    const w = world();
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(await hostAskState(w.table, orgId, project, HOST)).toBe("refused");
    expect(await w.ask()).toMatchObject({ outcome: "refused_before" });
    w.clock.now = T0 + SETUP_HOST_REFUSED_MS + 1;
    expect(await hostAskState(w.table, orgId, project, HOST)).toBeUndefined();
    expect(await w.ask()).toMatchObject({ outcome: "created", ask: { state: "open" } });
  });
  it("an approved ask does not block a new one once the host is no longer covered, and does while it is", async () => {
    const w = world();
    await w.ask();
    await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(await w.ask({ projectDomains: [HOST] })).toEqual({ outcome: "already_allowed" });
    const again = await w.ask({ projectDomains: [] });
    expect(again).toMatchObject({ outcome: "created", ask: { state: "open" } });
    expect(openCount(w)).toBe(1);
    expect(indexRow(w)).toBeDefined();
  });
  it("listing never returns a damaged row or another project's", async () => {
    const w = world();
    await w.ask();
    w.db.set({ pk: projectPk(orgId, project), sk: "SETUP_HOST_ASK#bad.acme-build.io", entityType: "SETUP_HOST_ASK", host: "BAD", state: "open" });
    expect((await listHostAsks(w.table, orgId, project)).map((a) => a.host)).toEqual([HOST]);
  });
});

describe("the audit of asks", () => {
  it("records the ask once, by the system for the person who started the run, with ids and a journal position as facts and the host as a detail", async () => {
    const w = world();
    await w.ask();
    const [event] = w.audit.recordedBy("setup.host_asked");
    expect(event).toMatchObject({
      actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: project },
      facts: { askId: hostAskSubjectId(orgId, project, HOST), taskId: TASK, journalN: 7 },
    });
    expect(JSON.stringify(event!.facts)).not.toContain(HOST);
    expect(JSON.stringify(event!.details)).toContain(HOST);
    expect(JSON.stringify(event!.details)).toContain(OWNER);
    // The audit item is written in the SAME transaction as the ask.
    expect(auditedTransactions(w).filter((items) => writesAsk(items, "open"))).toHaveLength(1);
  });
  it("a refusal by an admin is recorded with the admin as actor and a fixed reason, in the same transaction as the settle", async () => {
    const w = world();
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    const [event] = w.audit.recordedBy("setup.host_refused");
    expect(event).toMatchObject({ actor: { kind: "member", id: ADMIN }, facts: { askId: hostAskSubjectId(orgId, project, HOST), refusal: "person" } });
    // The audit item is in the same transaction as the settle.
    expect(auditedTransactions(w).filter((items) => settlesAsk(items))).toHaveLength(1);
    // A second refusal changes nothing and records nothing more.
    await expect(refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.audit.recordedBy("setup.host_refused")).toHaveLength(1);
  });
  it("a refusal that loses the race writes no audit item", async () => {
    const w = world();
    await w.ask();
    const original = w.db.send.bind(w.db);
    let first = true;
    (w.db as { send: unknown }).send = async (command: { constructor: { name: string } }) => {
      if (first && command.constructor.name === "TransactWriteCommand") { first = false; w.db.set({ ...askRow(w)!, state: "approved" }); }
      return original(command as never);
    };
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(w.audit.recordedBy("setup.host_refused")).toHaveLength(0);
  });
});

describe("approveHostAsk: the project's own website change, never a grant by itself", () => {
  it("a listed (asked) host grants nothing: only an approval changes the project's websites", async () => {
    const w = world();
    await w.ask();
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))).toBeUndefined();
  });
  it("an admin approves: a new project revision with the host, the egress item pending staff, the audit naming the ask and who pressed, the ask settled", async () => {
    const w = world();
    await w.ask();
    const result = await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(result).toMatchObject({ state: "applied", resultRevision: 2, mode: "second_person", staffPending: true });
    expect((w.db.get(projectRevisionKey(orgId, project, 2))?.definition as { network?: unknown }).network).toEqual({ allowedDomains: [HOST] });
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))?.domains).toMatchObject([{ domain: HOST, status: "pending" }]);
    const proposed = w.audit.recordedBy("project.allowed_domains_proposed");
    const changed = w.audit.recordedBy("project.allowed_domains_changed");
    expect(proposed).toHaveLength(1);
    expect(changed).toMatchObject([{ facts: { mode: "second_person", toRevision: 2 } }]);
    for (const event of [...proposed, ...changed]) {
      const details = JSON.stringify(event.details);
      expect(details).toContain("setup_host_ask");
      expect(details).toContain(hostAskSubjectId(orgId, project, HOST));
      expect(details).toContain(ADMIN);
    }
    expect(askRow(w)).toMatchObject({ state: "approved", decidedBy: ADMIN, resultRevision: 2 });
    expect(indexRow(w)).toBeUndefined();
    expect(openCount(w)).toBe(0);
    expect(await hostAskState(w.table, orgId, project, HOST)).toBe("approved");
    expect(await w.ask()).toMatchObject({ outcome: "created" });
  });
  it("the proposal is made by the person whose run asked, the commit by the approver", async () => {
    const w = world();
    await w.ask();
    await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    const ask = askRow(w) as { askedAt: string };
    const proposal = w.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${hostProposalId({ orgId, project, host: HOST, askedAt: ask.askedAt }, 1)}` });
    expect(proposal).toMatchObject({ by: OWNER, state: "applied", decidedBy: ADMIN });
  });
  it("the proposal's id depends on the project revision it was made at", () => {
    const ask = { orgId, project, host: HOST, askedAt: "2026-11-02T09:00:00.000Z" };
    expect(hostProposalId(ask, 1)).not.toBe(hostProposalId(ask, 2));
    expect(hostProposalId(ask, 1)).toBe(hostProposalId(ask, 1));
  });
  it("only an OPEN ask can be approved: an approved or refused one is stale", async () => {
    const w = world();
    await w.ask();
    await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const r = world();
    await r.ask();
    await refuseHostAsk(r.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    await expect(approveHostAsk(r.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const none = world();
    await expect(approveHostAsk(none.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(approveHostAsk(none.deps, { orgId, project, host: HOST, by: ADMIN, requestId: "not-a-uuid" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("a row that does not match its run is refused: the ask's requester must be the run's recorded starter, and its task a setup run", async () => {
    const forgedPerson = world();
    await forgedPerson.ask();
    forgedPerson.db.set({ ...askRow(forgedPerson)!, requestedBy: STRANGER });
    await expect(approveHostAsk(forgedPerson.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(forgedPerson.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(proposals(forgedPerson)).toEqual([]);
    const forgedRun = world();
    await forgedRun.ask();
    const notARun = randomUUID();
    runTask(forgedRun.db, notARun, { purpose: "setup_draft" });
    forgedRun.db.set({ ...askRow(forgedRun)!, taskId: notARun });
    await expect(approveHostAsk(forgedRun.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(proposals(forgedRun)).toEqual([]);
  });
  it("the person who asked cannot approve their own ask when another admin exists (second person), and the failed press wrote nothing", async () => {
    const w = world();
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "open" });
    expect(proposals(w)).toEqual([]);
    expect(w.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();
    expect(w.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(0);
  });
  it("a card press never acknowledges the sole-owner exception: the only admin is refused, the ask stays open and no proposal is left pending", async () => {
    const w = world({ admin: false });
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "open" });
    expect(proposals(w)).toEqual([]);
    expect(w.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();
  });
  it("the page can acknowledge the sole-owner exception for a company with one admin", async () => {
    const w = world({ admin: false });
    w.db.set({ ...orgMemberKey(orgId, MEMBER), orgId, developerId: MEMBER, role: "auditor" });
    await w.ask();
    const result = await approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID(), soleOwnerAcknowledged: true });
    expect(result).toMatchObject({ state: "applied", mode: "sole_owner_exception" });
  });
  it("a plain member is refused by the company rule (admin by default) before anything is read", async () => {
    const w = world();
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: MEMBER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refuseHostAsk(w.deps, { orgId, project, host: HOST, by: MEMBER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "open" });
  });
  it("with the company setting at maintainer a member is let past that rule, and the website change then refuses a member who is no live maintainer", async () => {
    const w = world();
    await w.ask();
    await expect(approveHostAsk({ ...w.deps, hostApprover: async () => "maintainer" }, { orgId, project, host: HOST, by: MEMBER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(proposals(w)).toEqual([]);
  });
  it("a host that became refused since the ask (deny list) is refused for good, not approved", async () => {
    const w = world();
    await w.ask();
    const deps = { ...w.deps, prodDeny: async () => ({ accountIds: [], hosts: [HOST], arnPrefixes: [] }) };
    await expect(approveHostAsk(deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "refused" });
    expect(w.audit.recordedBy("setup.host_refused")).toMatchObject([{ facts: { refusal: "production" } }]);
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
  });
  it("a host the project already has is settled without a new revision", async () => {
    const w = world();
    await w.ask();
    const row = w.db.get(projectRevisionKey(orgId, project, 1))!;
    w.db.set({ ...row, definition: { ...(row.definition as object), network: { allowedDomains: [HOST] } } });
    expect(await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).toEqual({ state: "already_allowed" });
    expect(askRow(w)).toMatchObject({ state: "approved" });
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
  });
  it("a changed project (another revision since) refuses and leaves the ask open", async () => {
    const w = world();
    await w.ask();
    const key = orgProjectCatalogKey(orgId, project);
    w.db.set({ ...w.db.get(key)!, latestRevision: 2 });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toBeTruthy();
    expect(askRow(w)).toMatchObject({ state: "open" });
  });
  it("another website change waiting blocks it (one live proposal per project) and the ask stays open", async () => {
    const w = world();
    await w.ask();
    await proposeProjectAllowedDomains({ ...w.deps, audit: w.audit.audit }, { orgId, project, by: OWNER, body: { requestId: randomUUID(), expectedRevision: 1, allowedDomains: ["other.acme-build.io"] } });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(askRow(w)).toMatchObject({ state: "open" });
  });
  it("a proposal id already used with a different body is stale, not a conflict the person cannot read", async () => {
    const w = world();
    await w.ask();
    const ask = askRow(w) as { askedAt: string };
    await proposeProjectAllowedDomains({ ...w.deps, audit: w.audit.audit }, {
      orgId, project, by: OWNER, body: { requestId: hostProposalId({ orgId, project, host: HOST, askedAt: ask.askedAt }, 1), expectedRevision: 1, allowedDomains: ["other.acme-build.io"] },
    });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(askRow(w)).toMatchObject({ state: "open" });
  });
  it("a requester who can no longer change the project's websites settles the ask with a fixed sentence, which can be asked again at once", async () => {
    const w = world();
    await w.ask();
    w.db.set({ pk: `DEVELOPER#${OWNER}`, sk: "META", developerId: OWNER, revoked: true });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(SETUP_HOST_REQUESTER_GONE) as unknown });
    expect(askRow(w)).toMatchObject({ state: "refused", refusalWords: SETUP_HOST_REQUESTER_GONE });
    expect(proposals(w)).toEqual([]);
    expect(openCount(w)).toBe(0);
    const other = randomUUID();
    runTask(w.db, other, { developerId: ADMIN });
    expect(await w.ask({ taskId: other })).toMatchObject({ outcome: "created", ask: { requestedBy: ADMIN } });
  });
  it("approvals are limited like the website change itself: 10 a minute for a person", async () => {
    const w = world();
    await w.ask();
    const attempts: unknown[] = [];
    for (let i = 0; i < 11; i += 1) attempts.push(await approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() }).catch((error: unknown) => error));
    expect(attempts.slice(0, 10).every((e) => (e as { code?: string }).code === "FORBIDDEN")).toBe(true);
    expect(attempts[10]).toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
  it("refusing changes nothing about the project's websites", async () => {
    const w = world();
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(askRow(w)).toMatchObject({ state: "refused", decidedBy: ADMIN, refusalWords: "A person refused it." });
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))).toBeUndefined();
    expect(indexRow(w)).toBeUndefined();
  });
});

describe("the card", () => {
  it("is a medium setup_host card with the host in fixed words and the repository line quoted; approve and reject are POSTs", async () => {
    const w = world();
    const created = await w.ask({ from: { path: "pip.conf\u202e", line: 2 } });
    if (created.outcome !== "created") throw new Error("ask");
    const item = hostAskItem(created.ask, { staffStep: true });
    const projection = projectDecisionCards([item]);
    expect(projection.dropped).toBe(0);
    const [card] = projection.cards;
    expect(card).toMatchObject({ id: `setup_host:${hostAskSubjectId(orgId, project, HOST)}`, kind: "setup_host", risk: "medium", status: "pending", project });
    expect(card!.question).toBe(`Let the setup of this project reach ${HOST}?`);
    expect(card!.next.text).toContain("Rovara staff");
    expect(card!.evidence.map((chip) => chip.label)).toEqual(["Website", "From the repository", "Setup command"]);
    expect(card!.evidence.find((chip) => chip.label === "From the repository")!.value).not.toMatch(/[\u202e]/u);
    expect(card!.actions.map((action) => `${action.kind}:${action.method}`).sort()).toEqual(["approve:POST", "open:GET", "reject:POST"]);
    expect(card!.friction).toMatchObject({ expandEvidenceFirst: true, freshSignIn: false });
  });
  it("says 'international name' for a punycode host", async () => {
    const w = world();
    const created = await w.ask({ host: "xn--bcher-kva.acme-build.io" });
    if (created.outcome !== "created") throw new Error("ask");
    const [card] = projectDecisionCards([hostAskItem(created.ask, { staffStep: true })]).cards;
    expect(card!.evidence.find((chip) => chip.label === "Name")).toMatchObject({ value: "international name" });
  });
  it("a company lock can raise it to high, which has no approve action", async () => {
    const w = world();
    const created = await w.ask();
    if (created.outcome !== "created") throw new Error("ask");
    const [card] = projectDecisionCards([hostAskItem(created.ask, { staffStep: false })], { locks: { setup_host: "high" } }).cards;
    expect(card).toMatchObject({ risk: "high" });
    expect(card!.actions.map((action) => action.kind)).toEqual(["open"]);
  });
  it("the subject id holds no dot and no repository text", () => {
    expect(hostAskSubjectId(orgId, project, HOST)).toMatch(/^[0-9a-f]{32}$/u);
    expect(hostAskSubjectId(orgId, project, HOST)).not.toBe(hostAskSubjectId(orgId, "other", HOST));
  });
  it("lists the open asks of a whole company in one read of its index, only for projects the caller may approve, however many projects there are", async () => {
    const w = world();
    for (let i = 0; i < 40; i += 1) {
      const name = `proj${String(i)}`;
      const task = randomUUID();
      runTask(w.db, task, {}, name);
      await requestHostAsk(w.table, { orgId, project: name, host: HOST, taskId: task, projectDomains: [] });
    }
    await w.ask();
    const reads: string[] = [];
    const original = w.db.send.bind(w.db);
    (w.db as { send: unknown }).send = async (command: { constructor: { name: string } }) => { reads.push(command.constructor.name); return original(command as never); };
    const all = [project, ...Array.from({ length: 40 }, (_, i) => `proj${String(i)}`)];
    const items = await hostAskItemsFor({ ...w.table, approvableProjects: async () => all, staffStep: true }, { orgId, developerId: ADMIN });
    expect(items).toHaveLength(41);
    expect(reads.filter((name) => name === "QueryCommand")).toHaveLength(1);
    expect(await hostAskItemsFor({ ...w.table, approvableProjects: async () => [], staffStep: true }, { orgId, developerId: MEMBER })).toEqual([]);
    expect(await hostAskItemsFor({ ...w.table, approvableProjects: async () => ["proj3"], staffStep: true }, { orgId, developerId: ADMIN })).toHaveLength(1);
  });
  it("a settled ask leaves the list", async () => {
    const w = world();
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(await hostAskItemsFor({ ...w.table, approvableProjects: async () => [project], staffStep: true }, { orgId, developerId: ADMIN })).toEqual([]);
  });
});

describe("the card's handler", () => {
  const press = async (w: World, caller: { orgId: string; developerId: string; browserSession?: true }, kind: "approve" | "reject" = "approve") => {
    const created = await w.ask();
    const ask = created.outcome === "created" ? created.ask : askRow(w) as never;
    const item = hostAskItem(ask, { staffStep: true });
    const card = projectDecisionCards([item]).cards[0]!;
    const performer = createDecisionPerformer<typeof caller>({ setup_host: setupHostHandler(w.deps, { webOrigin: "https://app.example.test" }) });
    return kind === "approve" ? performer.approve(caller, { card, item, requestId: randomUUID() }) : performer.reject(caller, { card, item, requestId: randomUUID(), reason: "not_now" });
  };
  it("a press without a live browser session decides nothing: it answers the project's website page", async () => {
    const w = world();
    const outcome = await press(w, { orgId, developerId: ADMIN });
    expect(outcome).toEqual({ kind: "needs_confirmation", confirmUrl: `https://app.example.test/app/projects/${project}` });
    expect(askRow(w)).toMatchObject({ state: "open" });
    expect(proposals(w)).toEqual([]);
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(0);
  });
  it("a press with a live browser session decides, and a stranger is refused", async () => {
    const w = world();
    expect(await press(w, { orgId, developerId: MEMBER, browserSession: true })).toEqual({ kind: "refused", reason: "forbidden" });
    expect(await press(w, { orgId, developerId: ADMIN, browserSession: true })).toEqual({ kind: "done" });
    expect(askRow(w)).toMatchObject({ state: "approved" });
  });
  it("a refusal needs no browser session (it only makes things stricter)", async () => {
    const w = world();
    expect(await press(w, { orgId, developerId: ADMIN }, "reject")).toEqual({ kind: "done" });
    expect(askRow(w)).toMatchObject({ state: "refused" });
  });
  it("a settled ask is the card's stale", async () => {
    const w = world();
    await press(w, { orgId, developerId: ADMIN }, "reject");
    expect(await press(w, { orgId, developerId: ADMIN, browserSession: true }, "reject")).toEqual({ kind: "refused", reason: "stale" });
  });
});
