// Setup host asks (design setup-test-health 3.3, task SH12): the refusal list, one ask per host per project, the card, and the approval that goes through the project's own website change
// (propose, then the approver's commit with the second-person rule and the egress plan). The module is driven directly against the in-memory table; the card routes are driven through the whole broker
// in setup-host-cards.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, ProjectDefinitionSchema, developerOrgKey, egressDomainsKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectMetaKey, projectPk, projectRevisionKey, type OrgId,
} from "../../packages/contracts/src/index.js";
import {
  SETUP_HOST_OPEN_MAX, SETUP_HOST_REFUSED_MS, approveHostAsk, hostAlreadyAllowed, hostAskItem, hostAskItemsFor, hostAskState, hostAskSubjectId, hostProposalId, listHostAsks, refuseHostAsk, refuseSetupHost,
  requestHostAsk, setupHostHandler, type HostAskInput, type HostDecisionDeps,
} from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { proposeProjectAllowedDomains } from "../../packages/broker/src/org/project-allowed-domains.js";
import { projectDecisionCards } from "../../packages/broker/src/decisions/project.js";
import { createDecisionPerformer } from "../../packages/broker/src/decisions/performer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OWNER = "a".repeat(64);
const ADMIN = "b".repeat(64);
const MEMBER = "c".repeat(64);
const project = "payments";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const HOST = "artifactory.corp.example";

function person(db: FakeDynamoDb, id: string, role: "owner" | "admin" | "member"): void {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role });
  db.set({ ...developerOrgKey(id), orgId, role });
  db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
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
  const clock = { now: T0 };
  const table = { documentClient: db, tableName: "state", now: () => clock.now };
  const deps: HostDecisionDeps = { ...table, signInTableName: "signin", audit: audit.audit };
  const ask = (overrides: Partial<HostAskInput> = {}) => requestHostAsk(table, { orgId, project, host: HOST, requestedBy: OWNER, projectDomains: [], taskId: randomUUID(), journalN: 7, from: { path: "pip.conf", line: 2 }, ...overrides });
  return { db, audit, clock, table, deps, ask };
}
type World = ReturnType<typeof world>;
const askRow = (w: World, host = HOST) => w.db.get({ pk: projectPk(orgId, project), sk: `SETUP_HOST_ASK#${host}` });

describe("refuseSetupHost: hosts that get no card", () => {
  it("accepts an ordinary private registry name", () => {
    expect(refuseSetupHost(HOST)).toBeUndefined();
    expect(refuseSetupHost("repo.internal-mirror.example.org")).toBeUndefined();
  });
  it.each([
    ["10.0.0.5", "address_literal"], ["192.168.1.1", "address_literal"], ["[::1]", "address_literal"], ["::1", "address_literal"], ["0x7f000001", "address_literal"], ["2130706433", "address_literal"],
    ["localhost", "not_a_host"], ["", "not_a_host"], ["a b.example.com", "not_a_host"], ["-bad.example.com", "not_a_host"], ["host_name.example.com", "not_a_host"], ["https://evil.example.com", "address_literal"],
    ["pastebin.com", "paste_site"], ["raw.pastebin.com", "paste_site"], ["transfer.sh", "paste_site"],
    ["bit.ly", "link_shortener"], ["x.tinyurl.com", "link_shortener"],
    ["abc.ngrok-free.app", "tunnel"], ["x.trycloudflare.com", "tunnel"],
    ["webhook.site", "webhook_sink"], ["abc.oast.fun", "webhook_sink"], ["x.pipedream.net", "webhook_sink"],
    ["acct.blob.core.windows.net", "raw_storage"], ["storage.googleapis.com", "raw_storage"], ["bucket.r2.cloudflarestorage.com", "raw_storage"], ["x.workers.dev", "raw_storage"],
  ] as const)("%s is refused as %s", (host, kind) => {
    expect(refuseSetupHost(host)).toBe(kind);
  });
  it("matches whole labels only: a name that merely ends with a listed suffix is not refused", () => {
    expect(refuseSetupHost("notbit.ly")).toBeUndefined();
    expect(refuseSetupHost("mypastebin.com")).toBeUndefined();
  });
  it("is case and trailing-dot blind", () => {
    expect(refuseSetupHost("PASTEBIN.COM.")).toBe("paste_site");
  });
  it("refuses a name too long to be shown whole on a card", () => {
    expect(refuseSetupHost(`${"a".repeat(60)}.corp.example`)).toBe("too_long");
  });
  it("refuses a host on the company's production deny list (exact, wildcard)", () => {
    const deny = { accountIds: [], hosts: ["*.prod.corp.example", "db.corp.example"], arnPrefixes: [] };
    expect(refuseSetupHost("api.prod.corp.example", deny)).toBe("production");
    expect(refuseSetupHost("db.corp.example", deny)).toBe("production");
    expect(refuseSetupHost("artifactory.corp.example", deny)).toBeUndefined();
  });
});

describe("hostAlreadyAllowed", () => {
  it("reads the default list and the project's list with the firewall's wildcard rule (subdomains only)", () => {
    expect(hostAlreadyAllowed("registry.npmjs.org", [])).toBe(true);
    expect(hostAlreadyAllowed("s3.us-west-2.amazonaws.com", [])).toBe(true);
    expect(hostAlreadyAllowed("amazonaws.com", [])).toBe(false);
    expect(hostAlreadyAllowed(HOST, [])).toBe(false);
    expect(hostAlreadyAllowed(HOST, [HOST])).toBe(true);
    expect(hostAlreadyAllowed("a.corp.example", ["*.corp.example"])).toBe(true);
    expect(hostAlreadyAllowed("corp.example", ["*.corp.example"])).toBe(false);
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.length).toBeGreaterThan(10);
  });
});

describe("requestHostAsk: one ask per host per project", () => {
  it("creates an open ask with where it came from, and writes nothing for a refused host", async () => {
    const w = world();
    const result = await w.ask();
    expect(result).toMatchObject({ outcome: "created", ask: { host: HOST, state: "open", requestedBy: OWNER, journalN: 7, from: { path: "pip.conf", line: 2 }, joined: 0 } });
    expect(askRow(w)).toMatchObject({ state: "open", host: HOST });
    const refused = await w.ask({ host: "pastebin.com" });
    expect(refused).toMatchObject({ outcome: "refused", reason: "paste_site" });
    expect(typeof (refused as { words: string }).words).toBe("string");
    expect(askRow(w, "pastebin.com")).toBeUndefined();
    expect(await w.ask({ host: "10.1.2.3" })).toMatchObject({ outcome: "refused", reason: "address_literal" });
  });
  it("answers already_allowed for a default or project host and makes no row", async () => {
    const w = world();
    expect(await w.ask({ host: "pypi.org" })).toEqual({ outcome: "already_allowed" });
    expect(await w.ask({ projectDomains: [HOST] })).toEqual({ outcome: "already_allowed" });
    expect(askRow(w)).toBeUndefined();
  });
  it("joins an open ask: the same host asked again (a second run, a second command) is one row and one card", async () => {
    const w = world();
    await w.ask();
    const again = await w.ask({ journalN: 12, from: { path: "other.txt", line: 9 } });
    expect(again).toMatchObject({ outcome: "joined", ask: { joined: 1, journalN: 7, from: { path: "pip.conf", line: 2 } } });
    await w.ask();
    expect((askRow(w) as { joined: number }).joined).toBe(2);
    expect(await listHostAsks(w.table, orgId, project)).toHaveLength(1);
    const items = await hostAskItemsFor({ ...w.table, approvableProjects: async () => [project], staffStep: true }, { orgId, developerId: ADMIN });
    expect(items).toHaveLength(1);
  });
  it("two requests racing for a new host make one row", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.ask(), w.ask()]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "joined"]);
    expect((await listHostAsks(w.table, orgId, project))).toHaveLength(1);
  });
  it("a different project asking for the same host has its own ask", async () => {
    const w = world();
    await w.ask();
    const other = await requestHostAsk(w.table, { orgId, project: "other", host: HOST, requestedBy: OWNER, projectDomains: [] });
    expect(other.outcome).toBe("created");
  });
  it("stops at the open-ask bound", async () => {
    const w = world();
    for (let i = 0; i < SETUP_HOST_OPEN_MAX; i += 1) expect((await w.ask({ host: `h${String(i)}.corp.example` })).outcome).toBe("created");
    expect(await w.ask({ host: "extra.corp.example" })).toEqual({ outcome: "too_many_open" });
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
  it("listing never returns a damaged row or another project's", async () => {
    const w = world();
    await w.ask();
    w.db.set({ pk: projectPk(orgId, project), sk: "SETUP_HOST_ASK#bad.corp.example", entityType: "SETUP_HOST_ASK", host: "BAD", state: "open" });
    expect((await listHostAsks(w.table, orgId, project)).map((a) => a.host)).toEqual([HOST]);
  });
});

describe("approveHostAsk: the project's own website change, never a grant by itself", () => {
  it("a listed (asked) host grants nothing: only an approval changes the project's websites", async () => {
    const w = world();
    await w.ask();
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))).toBeUndefined();
  });
  it("an admin approves: a new project revision with the host, the egress item pending staff, one audit, the ask approved", async () => {
    const w = world();
    await w.ask();
    const result = await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(result).toMatchObject({ state: "applied", resultRevision: 2, mode: "second_person", staffPending: true });
    expect((w.db.get(projectRevisionKey(orgId, project, 2))?.definition as { network?: unknown }).network).toEqual({ allowedDomains: [HOST] });
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))?.domains).toMatchObject([{ domain: HOST, status: "pending" }]);
    expect(w.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
    expect(w.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "second_person", toRevision: 2 } }]);
    expect(askRow(w)).toMatchObject({ state: "approved", decidedBy: ADMIN, resultRevision: 2 });
    expect(await hostAskState(w.table, orgId, project, HOST)).toBe("approved");
    expect(await w.ask()).toMatchObject({ outcome: "approved_before" });
    expect(await w.ask({ projectDomains: [HOST] })).toEqual({ outcome: "already_allowed" });
  });
  it("the proposal is made by the person whose run asked, the commit by the approver", async () => {
    const w = world();
    await w.ask();
    await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    const ask = askRow(w) as { orgId: string; project: string; host: string; askedAt: string };
    const proposal = w.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${hostProposalId({ orgId: ask.orgId, project, host: HOST, askedAt: ask.askedAt })}` });
    expect(proposal).toMatchObject({ by: OWNER, state: "applied", decidedBy: ADMIN });
  });
  it("the person who asked cannot approve their own ask when another admin exists (second person)", async () => {
    const w = world();
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "open" });
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
  });
  it("a card press never acknowledges the sole-owner exception: the only admin is refused and the ask stays open", async () => {
    const w = world({ admin: false });
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "open" });
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
  });
  it("a host that became refused since the ask (deny list) is refused for good, not approved", async () => {
    const w = world();
    await w.ask();
    const deps = { ...w.deps, prodDeny: async () => ({ accountIds: [], hosts: [HOST], arnPrefixes: [] }) };
    await expect(approveHostAsk(deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(askRow(w)).toMatchObject({ state: "refused" });
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
    await proposeProjectAllowedDomains({ ...w.deps, audit: w.audit.audit }, { orgId, project, by: OWNER, body: { requestId: randomUUID(), expectedRevision: 1, allowedDomains: ["other.corp.example"] } });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(askRow(w)).toMatchObject({ state: "open" });
  });
  it("a request that fails after the proposal is made replays the same proposal on the next press", async () => {
    const w = world();
    await w.ask();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: OWNER, requestId: randomUUID() })).rejects.toBeTruthy();
    const result = await approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(result.state).toBe("applied");
    expect(w.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
  });
  it("an ask for a project that is not there, or one already settled, is stale", async () => {
    const w = world();
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(approveHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: "not-a-uuid" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("refusing changes nothing about the project's websites", async () => {
    const w = world();
    await w.ask();
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(askRow(w)).toMatchObject({ state: "refused", decidedBy: ADMIN, refusalWords: "A person refused it." });
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.db.get(egressDomainsKey(orgId, { kind: "project", project }))).toBeUndefined();
  });
});

describe("the card", () => {
  it("is a medium setup_host card with the host in fixed words and the repository line quoted; approve and reject are POSTs", async () => {
    const w = world();
    const created = await w.ask({ from: { path: "pip.conf‮", line: 2 } });
    if (created.outcome !== "created") throw new Error("ask");
    const item = hostAskItem(created.ask, { staffStep: true });
    const projection = projectDecisionCards([item]);
    expect(projection.dropped).toBe(0);
    const [card] = projection.cards;
    expect(card).toMatchObject({ id: `setup_host:${hostAskSubjectId(orgId, project, HOST)}`, kind: "setup_host", risk: "medium", status: "pending", project });
    expect(card!.question).toBe(`Let the setup of this project reach ${HOST}?`);
    expect(card!.next.text).toContain("Rovara staff");
    expect(card!.evidence.map((chip) => chip.label)).toEqual(["Website", "From the repository", "Setup command"]);
    expect(card!.evidence.find((chip) => chip.label === "From the repository")!.value).not.toMatch(/[‮]/u);
    expect(card!.actions.map((action) => `${action.kind}:${action.method}`).sort()).toEqual(["approve:POST", "open:GET", "reject:POST"]);
    expect(card!.friction).toMatchObject({ expandEvidenceFirst: true, freshSignIn: false });
    expect(JSON.stringify(card)).not.toContain("pip.conf‮");
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
  it("lists only for projects the caller may approve, open asks only, and approvable projects bound the read", async () => {
    const w = world();
    await w.ask();
    const none = await hostAskItemsFor({ ...w.table, approvableProjects: async () => [], staffStep: true }, { orgId, developerId: MEMBER });
    expect(none).toEqual([]);
    await refuseHostAsk(w.deps, { orgId, project, host: HOST, by: ADMIN, requestId: randomUUID() });
    expect(await hostAskItemsFor({ ...w.table, approvableProjects: async () => [project], staffStep: true }, { orgId, developerId: ADMIN })).toEqual([]);
  });
  it("the handler approves and refuses as the caller, and maps the endpoint's refusals to the card's words", async () => {
    const w = world();
    const created = await w.ask();
    if (created.outcome !== "created") throw new Error("ask");
    const item = hostAskItem(created.ask, { staffStep: true });
    const card = projectDecisionCards([item]).cards[0]!;
    const performer = createDecisionPerformer<{ orgId: string; developerId: string }>({ setup_host: setupHostHandler(w.deps) });
    const outcome = await performer.approve({ orgId, developerId: MEMBER }, { card, item, requestId: randomUUID() });
    expect(outcome).toEqual({ kind: "refused", reason: "forbidden" });
    const done = await performer.approve({ orgId, developerId: ADMIN }, { card, item, requestId: randomUUID() });
    expect(done).toEqual({ kind: "done" });
    expect(askRow(w)).toMatchObject({ state: "approved" });
    const gone = await performer.reject({ orgId, developerId: ADMIN }, { card, item, requestId: randomUUID(), reason: "not_now" });
    expect(gone).toEqual({ kind: "refused", reason: "stale" });
  });
});
