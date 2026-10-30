// Plan 2, Task 18: egress items. A domain a project asks for is `pending` on Rovara Cloud until Rovara staff approve it (and `approved` on
// a private install at once); every request, decision and removal is audited; the approved union of active items is what the DNS firewall
// layer serves (Task 19). Owners are keyed so Plan 3's model sources use the same items.
import { capturingAuditDeps } from "../support/audit-capture.js";
import { readProjectAllowedDomainsReview, proposeProjectAllowedDomains, commitReviewedProjectAllowedDomains, commitDirectProjectAllowedDomains } from "../../packages/broker/src/org/project-allowed-domains.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EGRESS_DOMAINS_PK, EGRESS_SYNC_KEY, developerOrgKey, egressDomainsKey, orgMemberKey, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, projectMemberKey, orgMetaKey, AgentXErrorCodeSchema, errorStatus, type EgressAuditItem, type EgressDomainsItem, type EgressOwner, type OrgId,
} from "../../packages/contracts/src/index.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { reconcileEgressWithRevisions } from "../../packages/broker/src/aws/egress-domains-sync.js";
import {
  approvedUnion, clearOrgEgress, decideEgressDomain, listPendingEgress, putEgressDomains, setEgressOwnerActive, type EgressDomainsDependencies,
} from "../../packages/broker/src/org/egress-domains.js";
import { MAYA, OMAR, bearerFor, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { call } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const WEB: EgressOwner = { kind: "project", project: "web" };
const SOURCE: EgressOwner = { kind: "model-source", sourceId: "src_1" };
const STAFF = { subject: "staff-subject", admin: true };
const PENDING = (domain: string) => `${domain} is waiting for Rovara to approve it`;

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });

function seedProject(db: FakeDynamoDb, orgId: OrgId = TEST_ORG, name = "web", extra: Record<string, unknown> = {}): void {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)], orchestratorInstructions: "Delegate work.", ...extra,
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
}

type Detail = { settings: { allowedDomains: Array<{ domain: string; status: string; reason?: string }> } };

/** A cloud broker with an org admin (Omar), the project `web`, and a sync that records its calls. */
async function install(options: { sync?: () => Promise<{ ok: boolean }> } = {}) {
  const sync = vi.fn(options.sync ?? (async () => ({ ok: true })));
  const audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({
    register: false, audit,
    brokerExtra: {
      cloud: true, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" }, egressDomainsSync: sync,
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn() },
    },
  });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
  seedProject(h.db);
  // Staff-policy tests arrange company-approved changes through the real B33 core.
  // This helper returns the actual core receipt, never a fabricated settings response.
  audit.attach(h.db);audit.audit.documentClient = h.db as unknown as typeof audit.audit.documentClient;
  h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG)), ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
  h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "web", role: "developer", projectRole: "maintainer", grantId: randomUUID() });
  const companyDeps = { documentClient: h.db, tableName: "state", signInTableName: "signin", now: Date.now, audit: audit.audit };
  const changeSites = async (domains: string[], who: Developer = OMAR) => {
    try {
      const review = await readProjectAllowedDomainsReview(companyDeps, { orgId: TEST_ORG, project: "web", by: who.developerId });
      const body = { requestId: randomUUID(), expectedRevision: review.baseRevision, expectedContextDigest: review.contextDigest, allowedDomains: domains };
      let result: unknown;
      if (domains.some(domain => !review.allowedDomains.includes(domain))) {
        const proposal = await proposeProjectAllowedDomains(companyDeps, { orgId: TEST_ORG, project: "web", by: who.developerId, body });
        const sole = h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId)) === undefined;
        result = await commitReviewedProjectAllowedDomains(companyDeps, { orgId: TEST_ORG, project: "web", by: sole ? who.developerId : MAYA.developerId, body: { requestId: randomUUID(), proposalId: proposal.proposalId, soleOwnerAcknowledged: sole } });
      } else result = await commitDirectProjectAllowedDomains(companyDeps, { orgId: TEST_ORG, project: "web", by: who.developerId, body });
      return { status: 200, body: result as Record<string, unknown> };
    } catch (error) { const checked = z.object({ code: AgentXErrorCodeSchema, message: z.string() }).safeParse(error);if (!checked.success) throw error;return { status: errorStatus(checked.data.code), body: { error: checked.data } }; }
  };
  const detail = async () => ((await h.dev(OMAR, "GET", "/v1/app/projects/web")).body as unknown as Detail).settings.allowedDomains;
  const staff = (method: string, path: string, body?: unknown) => call(h.handler, { method, path, user: STAFF, ...(body === undefined ? {} : { body }) });
  const decide = (action: "approve" | "reject", domain: string, extra: Record<string, unknown> = {}, orgId: OrgId = TEST_ORG, owner: EgressOwner = WEB) =>
    staff("POST", `/v1/admin/egress/${action}`, { requestId: randomUUID(), orgId, owner, domain, ...extra });
  const deps: EgressDomainsDependencies = { documentClient: h.db, tableName: "state", cloud: true, now: () => new Date(), sync };
  const item = (orgId: OrgId = TEST_ORG, owner: EgressOwner = WEB) => h.db.get(egressDomainsKey(orgId, owner)) as unknown as EgressDomainsItem | undefined;
  const audits = () => h.db.find((candidate) => candidate.pk === "EGRESS_AUDIT") as unknown as Array<EgressAuditItem & { pk: string; sk: string }>;
  return { ...h, sync, changeSites, detail, staff, decide, deps, item, audits, companyAudit: audit };
}

function plain(options: { cloud?: boolean; sync?: () => Promise<{ ok: boolean }>; now?: () => Date } = {}) {
  const db = new FakeDynamoDb();
  const sync = vi.fn(options.sync ?? (async () => ({ ok: true })));
  const deps: EgressDomainsDependencies = { documentClient: db, tableName: "state", cloud: options.cloud ?? true, now: options.now ?? (() => new Date()), sync };
  const audits = () => db.find((candidate) => candidate.pk === "EGRESS_AUDIT") as unknown as Array<EgressAuditItem & { pk: string; sk: string }>;
  return { db, sync, deps, audits };
}

describe("company-approved website changes on Rovara Cloud", () => {
  it("keeps a company-approved addition staff-pending, with one summary audit and nothing served", async () => {
    const h = await install(), saved = await h.changeSites(["a.acme.dev"]);
    expect(saved.status).toBe(200);expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "pending" }]);
    expect(h.item()).toMatchObject({ orgId: TEST_ORG, owner: WEB, active: true, domains: [{ domain: "a.acme.dev", status: "pending", requestedBy: MAYA.developerId }] });
    expect(h.audits()).toEqual([]);
    expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "second_person", added: 1, removed: 0 } }]);
    expect(h.companyAudit.recordedBy("project.allowed_domains_changed")[0]?.facts).not.toHaveProperty("domain");
    expect(await approvedUnion(h.deps)).toEqual([]);expect(h.sync).not.toHaveBeenCalled();
  });

  it("serves the domain once staff approve it: the audit names the operator and the sync runs", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const approved = await h.decide("approve", "a.acme.dev");
    expect(approved).toMatchObject({ status: 200, body: { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", status: "approved" } });
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
    expect(h.item()!.domains[0]).toMatchObject({ domain: "a.acme.dev", status: "approved", decidedBy: STAFF.subject, requestedBy: MAYA.developerId });
    expect(h.audits().find((audit) => audit.action === "approved")).toMatchObject({ domain: "a.acme.dev", orgId: TEST_ORG, owner: WEB, actor: { kind: "operator", id: STAFF.subject } });
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.db.get(EGRESS_SYNC_KEY)).toMatchObject({ dirtyAt: expect.any(String) as string });
    expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "approved" }]);
    // A later save of the same list keeps the decision, says nothing and asks for no second approval.
    expect((await h.changeSites(["a.acme.dev"])).body).toMatchObject({ state: "unchanged" });
    expect(h.item()!.domains[0]).toMatchObject({ status: "approved" });
    expect(h.audits()).toHaveLength(1);expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
  });

  it("records a rejection with its reason, tells the maintainers, and asks again only when the domain is removed and added back", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    const rejected = await h.decide("reject", "a.acme.dev", { reason: "not an artifact host" });
    expect(rejected).toMatchObject({ status: 200, body: { domain: "a.acme.dev", status: "rejected" } });
    expect(h.item()!.domains.find((entry) => entry.domain === "a.acme.dev")).toMatchObject({ status: "rejected", reason: "not an artifact host", decidedBy: STAFF.subject });
    expect(h.audits().find((audit) => audit.action === "rejected")).toMatchObject({ domain: "a.acme.dev", reason: "not an artifact host", actor: { kind: "operator", id: STAFF.subject } });
    expect(await approvedUnion(h.deps)).toEqual([]);
    const again = await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    expect(again.body).toMatchObject({ state: "unchanged" });
    expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "rejected", reason: "not an artifact host" }, { domain: "b.acme.dev", status: "pending" }]);
    // Removing and re-adding makes it a new request.
    await h.changeSites(["b.acme.dev"]);
    expect(h.audits().filter((audit) => audit.domain === "a.acme.dev").map((audit) => audit.action).sort()).toEqual(["rejected"]);expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { added: 2 } }, { facts: { mode: "direct_narrowing", removed: 1 } }]);
    const back = await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    expect(back.status).toBe(200);expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toHaveLength(3);
    expect(h.item()!.domains.find((entry) => entry.domain === "a.acme.dev")).toMatchObject({ status: "pending" });
    expect(h.item()!.domains.find((entry) => entry.domain === "a.acme.dev")).not.toHaveProperty("reason");
  });

  it("is not asked about a domain every project already has", async () => {
    const h = await install();
    const saved = await h.changeSites(["registry.npmjs.org", "a.acme.dev"]);
    expect(saved.status).toBe(200);
    expect(h.item()!.domains.map((entry) => entry.domain)).toEqual(["a.acme.dev"]);
    expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "pending" }, { domain: "registry.npmjs.org", status: "approved" }]);
  });

  it("drops a domain with one narrowing summary and marks the changed approved union dirty", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    await h.decide("approve", "a.acme.dev");
    h.sync.mockClear();
    await h.changeSites(["b.acme.dev"]);
    expect(h.item()!.domains.map((entry) => entry.domain)).toEqual(["b.acme.dev"]);
    expect(h.companyAudit.recordedBy("project.allowed_domains_changed").at(-1)).toMatchObject({ facts: { mode: "direct_narrowing", removed: 1 } });
    expect(await approvedUnion(h.deps)).toEqual([]);
    expect(h.sync).not.toHaveBeenCalled();expect(h.db.get(EGRESS_SYNC_KEY)).toHaveProperty("dirtySeq");
    await h.changeSites([]);
    expect(h.item()!.domains).toEqual([]);
    expect(h.companyAudit.recordedBy("project.allowed_domains_changed").map(event => event.facts?.removed)).toEqual([0, 1, 1]);
  });

  it("asks for approval of the domains a project already stored before approvals existed, and shows them pending until then", async () => {
    const h = await install();
    h.db.set({ ...projectRevisionKey(TEST_ORG, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
      definition: {
        name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.", network: { allowedDomains: ["old.acme.dev"] },
      } });
    // Nothing served it, so it does not read as approved.
    expect(await h.detail()).toEqual([{ domain: "old.acme.dev", status: "pending" }]);
    expect(await approvedUnion(h.deps)).toEqual([]);
    // The next save of anything reconciles, so staff see the request.
    const saved = await h.dev(OMAR, "PUT", "/v1/app/projects/web/settings", { requestId: randomUUID(), expectedRevision: 1, description: "words" }) as { status: number; body: { warnings: string[] } };
    expect(saved).toMatchObject({ status: 200, body: { warnings: [PENDING("old.acme.dev")] } });
    expect(h.item()!.domains).toMatchObject([{ domain: "old.acme.dev", status: "pending" }]);
    expect((await h.staff("GET", "/v1/admin/egress/pending")).body).toMatchObject({ pending: [{ domain: "old.acme.dev" }] });
  });

  it("makes no revision when the egress write fails on the save that removes the last domain, and the retry then takes it out of the union (ruling C29)", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    await h.decide("approve", "a.acme.dev");
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
    // The revision and egress removal commit together; a failed transaction leaves both unchanged.
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await h.dev(OMAR, "PUT", "/v1/app/projects/web/settings", { requestId: randomUUID(), expectedRevision: 2, allowedDomains: [] });
    expect(failed.status).toBe(503);
    expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 3))).toBeUndefined();
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
    const retried = await h.dev(OMAR, "PUT", "/v1/app/projects/web/settings", { requestId: randomUUID(), expectedRevision: 2, allowedDomains: [] });
    expect(retried.status).toBe(200);
    expect(h.item()!.domains).toEqual([]);
    expect(await approvedUnion(h.deps)).toEqual([]);
  });

  it("never leaves a partial narrowing for the schedule to repair when its combined transaction fails", async () => {
    const h = await install();await h.changeSites(["a.acme.dev"]);await h.decide("approve", "a.acme.dev");
    const before = structuredClone(h.item());
    h.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes('"entityType":"PROJECT"') && JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await h.dev(OMAR, "PUT", "/v1/app/projects/web/settings", { requestId: randomUUID(), expectedRevision: 2, allowedDomains: [] });
    expect(failed.status).toBeGreaterThanOrEqual(500);expect(h.item()).toEqual(before);expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 3))).toBeUndefined();
    expect(await reconcileEgressWithRevisions({ ...h.deps, now: () => new Date(Date.now() + 600_000) })).toEqual({ repaired: 0 });
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
  });

  it("does not put an archived project's first domains in the union (Task 18 Minor 7)", async () => {
    const h = await install();
    h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, "web")) as object), status: "archived" });
    // A settings save on an archived project is refused (Task 20); the egress write itself still starts an archived project's item inactive.
    const refused = await h.changeSites(["a.acme.dev"]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(h.item()).toBeUndefined();
    await putEgressDomains(h.deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: OMAR.developerId });
    expect(h.item()).toMatchObject({ active: false });
    await h.decide("approve", "a.acme.dev");
    expect(await approvedUnion(h.deps)).toEqual([]);
    // Restoring brings it back.
    await setEgressOwnerActive(h.deps, TEST_ORG, WEB, true);
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
  });

  it("creates an archived project's first item inactive even when the archive lands after the project was read (Task 19 review, Minor 4)", async () => {
    const h = await install();
    let archived = false;
    const racing = { send: async (input: unknown) => {
      const answer = await h.db.send(input as never);
      // The first read of the project's META says active; the archive lands right after it.
      if (!archived && input instanceof GetCommand && input.input.Key?.sk === "META") {
        archived = true;
        h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, "web")) as object), status: "archived" });
      }
      return answer;
    } };
    await putEgressDomains({ ...h.deps, documentClient: racing }, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(archived).toBe(true);
    expect(h.item()).toMatchObject({ active: false });
    expect(await approvedUnion(h.deps)).toEqual([]);
    // The other way: an item for a project that is archived when read, restored before the write, is created active.
    const restored = await install();
    restored.db.set({ ...(restored.db.get(projectMetaKey(TEST_ORG, "web")) as object), status: "archived" });
    let flipped = false;
    const racingBack = { send: async (input: unknown) => {
      const answer = await restored.db.send(input as never);
      if (!flipped && input instanceof GetCommand && input.input.Key?.sk === "META") {
        flipped = true;
        restored.db.set({ ...(restored.db.get(projectMetaKey(TEST_ORG, "web")) as object), status: "active" });
      }
      return answer;
    } };
    await putEgressDomains({ ...restored.deps, documentClient: racingBack }, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(restored.item()).toMatchObject({ active: true });
  });

  it("backs off a little, with jitter, before retrying a cancellation that was not about the item, and only a few times (Task 19 review, Minor 5)", async () => {
    const sleeps: number[] = [];
    const { db, deps } = plain({ cloud: true });
    const slow = { ...deps, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); } };
    db.injectFault({ command: "TransactWriteCommand", times: 2, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }] } });
    await putEgressDomains(slow, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(sleeps).toHaveLength(2);
    for (const milliseconds of sleeps) { expect(milliseconds).toBeGreaterThan(0); expect(milliseconds).toBeLessThanOrEqual(500); }
    // Never more than three waits, then it gives up.
    sleeps.length = 0;
    db.injectFault({ command: "TransactWriteCommand", times: 10, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ThrottlingError" }] } });
    await expect(putEgressDomains(slow, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(sleeps).toHaveLength(3);
  });

  it("never shows another org's items: the same project name in another org is its own item", async () => {
    const h = await install();
    seedProject(h.db, OTHER_ORG);
    await putEgressDomains({ ...h.deps }, OTHER_ORG, WEB, ["theirs.acme.dev"], { developerId: "someone-else" });
    expect(await h.detail()).toEqual([]);
    await h.changeSites(["a.acme.dev"]);
    expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "pending" }]);
    expect(h.item(OTHER_ORG)!.domains.map((entry) => entry.domain)).toEqual(["theirs.acme.dev"]);
  });
});

describe("the admin routes", () => {
  it("refuse a developer token and a caller without the administrator claim, and decide nothing", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const token = await bearerFor(OMAR, { orgId: TEST_ORG, role: "owner" });
    for (const [method, path, body] of [
      ["GET", "/v1/admin/egress/pending", undefined],
      ["POST", "/v1/admin/egress/approve", { requestId: randomUUID(), orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev" }],
      ["POST", "/v1/admin/egress/reject", { requestId: randomUUID(), orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", reason: "no" }],
    ] as const) {
      const withToken = await call(h.handler, { method, path, headers: { authorization: token }, ...(body === undefined ? {} : { body }) });
      expect([401, 403], `${method} ${path} with a developer token`).toContain(withToken.status);
      const member = await call(h.handler, { method, path, user: { subject: "member", admin: false }, ...(body === undefined ? {} : { body }) });
      expect(member.status, `${method} ${path} without the claim`).toBe(403);
    }
    expect(h.item()!.domains[0]).toMatchObject({ status: "pending" });
    expect(h.audits()).toHaveLength(0);expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
  });

  it("list what waits: org name, owner, domain, when and who asked; never the sync marker", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    await h.decide("approve", "b.acme.dev");
    expect(h.db.get(EGRESS_SYNC_KEY)).toBeDefined();
    await putEgressDomains(h.deps, TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-x" });
    const listed = await h.staff("GET", "/v1/admin/egress/pending");
    expect(listed.status).toBe(200);
    const pending = (listed.body as { pending: Array<Record<string, unknown>> }).pending;
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ orgId: TEST_ORG, orgName: "staging", owner: WEB, domain: "a.acme.dev", requestedBy: { developerId: MAYA.developerId, name: "Maya Chen" } });
    expect(pending[0]!.requestedAt).toEqual(expect.any(String));
    expect(pending[1]).toMatchObject({ owner: SOURCE, domain: "m.model.dev", requestedBy: { developerId: "dev-x", name: "Unknown" } });
    expect(JSON.stringify(listed.body)).not.toContain("SYNC");
    expect(JSON.stringify(listed.body)).not.toContain("dirtyAt");
  });

  it("refuse a domain that is not waiting for approval, and a reason that is empty or too long", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    await h.decide("approve", "a.acme.dev");
    for (const answer of [await h.decide("approve", "a.acme.dev"), await h.decide("reject", "a.acme.dev", { reason: "late" }), await h.decide("approve", "never.acme.dev"), await h.decide("approve", "a.acme.dev", {}, OTHER_ORG)]) {
      expect(answer).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    }
    expect((await h.decide("approve", "a.acme.dev")).body.error).toMatchObject({ message: "a.acme.dev is not waiting for approval" });
    expect(h.item()!.domains[0]).toMatchObject({ status: "approved" });
    await h.changeSites(["a.acme.dev", "c.acme.dev"]);
    for (const reason of [undefined, "", "   ", "x".repeat(201)]) {
      const refused = await h.decide("reject", "c.acme.dev", reason === undefined ? {} : { reason });
      expect(refused, JSON.stringify(reason)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    }
    expect((await h.decide("reject", "c.acme.dev", { reason: "x".repeat(200) })).status).toBe(200);
    expect((await h.decide("approve", "c.acme.dev", { extra: 1 })).status).toBe(400);
  });
});

describe("a staff decision's request id (final review M2)", () => {
  const decisionRecords = (h: Awaited<ReturnType<typeof install>>) => h.db.find((item) => item.pk === "EGRESS_DECISION_REQUEST");

  it("stores the request in the same transaction as the decision, bound to the operator and with an expiry", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const id = randomUUID();
    const sent: Array<Array<Record<string, unknown>>> = [];
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<Record<string, unknown>> } }) => {
      if (command.constructor.name === "TransactWriteCommand") sent.push(command.input?.TransactItems ?? []);
      return send(command as never);
    });
    expect((await h.decide("approve", "a.acme.dev", { requestId: id })).status).toBe(200);
    const decided = sent.filter((items) => JSON.stringify(items).includes("EGRESS_DECISION_REQUEST"));
    expect(decided).toHaveLength(1);
    expect(decided[0]!.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(decided[0])).toContain("\"action\":\"approved\"");
    expect(decisionRecords(h)).toHaveLength(1);
    expect(decisionRecords(h)[0]).toMatchObject({ sk: id, by: STAFF.subject });
    expect(decisionRecords(h)[0]!.indexExpiresAt as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("leaves no record when the decision fails, and the same id then decides", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const id = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DECISION_REQUEST"), error: { name: "InternalServerError" } });
    expect((await h.decide("approve", "a.acme.dev", { requestId: id })).status).toBeGreaterThanOrEqual(500);
    expect(decisionRecords(h)).toEqual([]);
    expect(h.item()!.domains[0]).toMatchObject({ status: "pending" });
    expect((await h.decide("approve", "a.acme.dev", { requestId: id })).status).toBe(200);
  });

  it("answers a repeat of the same id with the same outcome and writes nothing, even after the domain was removed and asked for again", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const id = randomUUID();
    const first = await h.decide("approve", "a.acme.dev", { requestId: id });
    expect(first.status).toBe(200);
    await h.changeSites(["b.acme.dev"]);
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    expect(h.item()!.domains.find((entry) => entry.domain === "a.acme.dev")).toMatchObject({ status: "pending" });
    const auditsBefore = h.audits().length;
    const syncs = h.sync.mock.calls.length;
    const again = await h.decide("approve", "a.acme.dev", { requestId: id });
    expect(again).toMatchObject({ status: 200, body: { orgId: TEST_ORG, domain: "a.acme.dev", status: "approved" } });
    expect(h.item()!.domains.find((entry) => entry.domain === "a.acme.dev")).toMatchObject({ status: "pending" });
    expect(h.audits()).toHaveLength(auditsBefore);
    expect(h.sync.mock.calls).toHaveLength(syncs);
  });

  it("refuses the same id for another decision, another domain, or another operator with IDEMPOTENCY_CONFLICT, and decides nothing", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    const id = randomUUID();
    expect((await h.decide("approve", "a.acme.dev", { requestId: id })).status).toBe(200);
    const other = [
      await h.decide("reject", "a.acme.dev", { requestId: id, reason: "no" }),
      await h.decide("approve", "b.acme.dev", { requestId: id }),
      await call(h.handler, { method: "POST", path: "/v1/admin/egress/approve", user: { subject: "staff-2", admin: true }, body: { requestId: id, orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev" } }),
    ];
    for (const answer of other) expect(answer).toMatchObject({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
    expect(h.item()!.domains.find((entry) => entry.domain === "b.acme.dev")).toMatchObject({ status: "pending" });
  });

  it("takes an expired record the State table has not yet deleted as no record", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const id = randomUUID();
    h.db.set({ pk: "EGRESS_DECISION_REQUEST", sk: id, entityType: "EGRESS_DECISION_REQUEST", by: "staff-2", bodyHash: "x", indexExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    expect((await h.decide("approve", "a.acme.dev", { requestId: id })).status).toBe(200);
    expect(decisionRecords(h)[0]).toMatchObject({ by: STAFF.subject });
  });

  it("answers two identical requests sent together as one decision and one replay", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev"]);
    const id = randomUUID();
    const answers = await Promise.all([h.decide("approve", "a.acme.dev", { requestId: id }), h.decide("approve", "a.acme.dev", { requestId: id })]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(h.audits().filter((audit) => audit.action === "approved")).toHaveLength(1);
  });
});

describe("egress items", () => {
  it("are keyed by owner: a project under PROJECT# and a model source under SOURCE#", async () => {
    const { db, deps } = plain({ cloud: false });
    expect(egressDomainsKey(TEST_ORG, SOURCE)).toEqual({ pk: EGRESS_DOMAINS_PK, sk: `ORG#${TEST_ORG}#SOURCE#src_1` });
    expect(egressDomainsKey(TEST_ORG, WEB)).toEqual({ pk: EGRESS_DOMAINS_PK, sk: `ORG#${TEST_ORG}#PROJECT#web` });
    await putEgressDomains(deps, TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-1" });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(db.get({ pk: "EGRESS_DOMAINS", sk: `ORG#${TEST_ORG}#SOURCE#src_1` })).toMatchObject({ orgId: TEST_ORG, owner: SOURCE, active: true });
    expect(db.get({ pk: "EGRESS_DOMAINS", sk: `ORG#${TEST_ORG}#PROJECT#web` })).toMatchObject({ orgId: TEST_ORG, owner: WEB, active: true });
  });

  it("are approved at once, audited as auto_approved, and synced, on a private install", async () => {
    const { deps, audits, sync } = plain({ cloud: false });
    const result = await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(result).toEqual({ pending: [] });
    expect(await approvedUnion(deps)).toEqual(["a.acme.dev"]);
    expect(audits()).toMatchObject([{ domain: "a.acme.dev", action: "auto_approved", actor: { kind: "developer", id: "dev-1" } }]);
    expect(audits().map((audit) => audit.action)).not.toContain("requested");
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("serve one sorted, de-duplicated union of approved domains across owners and orgs", async () => {
    const { deps } = plain({ cloud: false });
    await putEgressDomains(deps, TEST_ORG, WEB, ["b.acme.dev", "a.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(deps, OTHER_ORG, WEB, ["a.acme.dev", "c.beta.dev"], { developerId: "dev-2" });
    await putEgressDomains(deps, TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-1" });
    expect(await approvedUnion(deps)).toEqual(["a.acme.dev", "b.acme.dev", "c.beta.dev", "m.model.dev"]);
  });

  it("leave the union when the owner is archived and return, without approval, when it is restored", async () => {
    const h = await install();
    await h.changeSites(["a.acme.dev", "b.acme.dev"]);
    await h.decide("approve", "a.acme.dev");
    h.sync.mockClear();
    await setEgressOwnerActive(h.deps, TEST_ORG, WEB, false);
    expect(await approvedUnion(h.deps)).toEqual([]);
    expect(h.item()).toMatchObject({ active: false });
    expect(h.sync).toHaveBeenCalledTimes(1);
    await setEgressOwnerActive(h.deps, TEST_ORG, WEB, true);
    expect(await approvedUnion(h.deps)).toEqual(["a.acme.dev"]);
    expect(h.item()!.domains.map((entry) => entry.status)).toEqual(["approved", "pending"]);
    expect(h.audits().map((audit) => audit.action)).toEqual(["approved"]);expect(h.companyAudit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
    expect(h.sync).toHaveBeenCalledTimes(2);
    // An owner with no item has nothing to flip.
    await expect(setEgressOwnerActive(h.deps, TEST_ORG, SOURCE, false)).resolves.toEqual({});
    expect(h.item(TEST_ORG, SOURCE)).toBeUndefined();
  });

  it("are all removed for one org by clearOrgEgress, audited, leaving every other org's", async () => {
    const { db, deps, audits, sync } = plain({ cloud: false });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" });
    await putEgressDomains(deps, TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-1" });
    await putEgressDomains(deps, OTHER_ORG, WEB, ["c.beta.dev"], { developerId: "dev-2" });
    sync.mockClear();
    await clearOrgEgress(deps, TEST_ORG);
    expect(db.get(egressDomainsKey(TEST_ORG, WEB))).toBeUndefined();
    expect(db.get(egressDomainsKey(TEST_ORG, SOURCE))).toBeUndefined();
    expect(db.get(egressDomainsKey(OTHER_ORG, WEB))).toMatchObject({ domains: [{ domain: "c.beta.dev" }] });
    expect(await approvedUnion(deps)).toEqual(["c.beta.dev"]);
    expect(audits().filter((audit) => audit.action === "removed" && audit.orgId === TEST_ORG).map((audit) => audit.domain).sort()).toEqual(["a.acme.dev", "b.acme.dev", "m.model.dev"]);
    expect(audits().filter((audit) => audit.action === "removed" && audit.orgId === OTHER_ORG)).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(1);
    // The sync marker survives, and clearing an org with nothing is quiet.
    expect(db.get(EGRESS_SYNC_KEY)).toBeDefined();
    sync.mockClear();
    await clearOrgEgress(deps, TEST_ORG);
    expect(sync).not.toHaveBeenCalled();
  });

  it("tell the caller the change applies within 5 minutes when the sync fails", async () => {
    const { deps } = plain({ cloud: false, sync: async () => ({ ok: false }) });
    expect(await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" })).toEqual({ warning: "allowed domains will apply within 5 minutes", pending: [] });
    const thrown = plain({ cloud: false, sync: async () => { throw new Error("route53 down"); } });
    expect(await putEgressDomains(thrown.deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" })).toMatchObject({ warning: "allowed domains will apply within 5 minutes" });
    expect(await approvedUnion(thrown.deps)).toEqual(["a.acme.dev"]);
  });

  it("keep defaults separate and report an eventual sync failure after staff approval", async () => {
    const h = await install({ sync: async () => ({ ok: false }) });
    await h.changeSites(["a.acme.dev"]);
    expect((await h.changeSites(["a.acme.dev", "registry.npmjs.org"])).status).toBe(200);expect(await h.detail()).toEqual([{ domain: "a.acme.dev", status: "pending" }, { domain: "registry.npmjs.org", status: "approved" }]);
    const approved = await h.decide("approve", "a.acme.dev");
    expect(approved).toMatchObject({ status: 200, body: { warning: "allowed domains will apply within 5 minutes" } });
    const sibling = await h.staff("POST", "/v1/admin/egress/approve", { requestId: randomUUID(), orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev" });
    expect(sibling.status).toBe(400);
  });

  it("make no write when a save changes nothing", async () => {
    const { db, deps, sync } = plain({ cloud: true });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    const before = structuredClone(db.get(egressDomainsKey(TEST_ORG, WEB)));
    const result = await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(result).toEqual({ pending: ["a.acme.dev"] });
    expect(db.get(egressDomainsKey(TEST_ORG, WEB))).toEqual(before);
    expect(sync).not.toHaveBeenCalled();
    // Releasing an owner with no item writes nothing either.
    await putEgressDomains(deps, TEST_ORG, SOURCE, [], { developerId: "dev-1" });
    expect(db.get(egressDomainsKey(TEST_ORG, SOURCE))).toBeUndefined();
  });

  it("keep a staff decision made while a save was in flight (the race)", async () => {
    const { db, deps, audits } = plain({ cloud: true, now: () => new Date("2026-10-21T10:00:00.000Z") });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    // The save reads the item; staff approve before it writes; its write is refused and it reads again.
    let raced = false;
    const racing = { send: async (input: unknown) => {
      const answer = await db.send(input as never);
      if (!raced && input instanceof GetCommand && input.input.Key?.sk === egressDomainsKey(TEST_ORG, WEB).sk) {
        raced = true;
        await decideEgressDomain(deps, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-1" });
      }
      return answer;
    } };
    const result = await putEgressDomains({ ...deps, documentClient: racing }, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" });
    expect(raced).toBe(true);
    expect(result.pending).toEqual(["b.acme.dev"]);
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains).toMatchObject([{ domain: "a.acme.dev", status: "approved", decidedBy: "staff-1" }, { domain: "b.acme.dev", status: "pending" }]);
    expect(await approvedUnion(deps)).toEqual(["a.acme.dev"]);
    expect(audits().map((audit) => `${audit.domain}:${audit.action}`).sort()).toEqual(["a.acme.dev:approved", "a.acme.dev:requested", "b.acme.dev:requested"]);
  });

  it("keep a save made while staff were deciding: the decision retries against what is stored", async () => {
    const { db, deps } = plain({ cloud: true, now: () => new Date("2026-10-21T10:00:00.000Z") });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    let raced = false;
    const racing = { send: async (input: unknown) => {
      const answer = await db.send(input as never);
      if (!raced && input instanceof GetCommand && input.input.Key?.sk === egressDomainsKey(TEST_ORG, WEB).sk) {
        raced = true;
        await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" });
      }
      return answer;
    } };
    await decideEgressDomain({ ...deps, documentClient: racing }, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-1" });
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains).toMatchObject([{ domain: "a.acme.dev", status: "approved" }, { domain: "b.acme.dev", status: "pending" }]);
  });

  it("refuse a save that loses the race twice with CHANGE_STALE and change nothing", async () => {
    const { db, deps, audits } = plain({ cloud: true });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    const auditsBefore = audits().length;
    let reads = 0;
    const racing = { send: async (input: unknown) => {
      const answer = await db.send(input as never);
      if (input instanceof GetCommand && input.input.Key?.sk === egressDomainsKey(TEST_ORG, WEB).sk) {
        reads += 1;
        // Staff change the item after each read, so no write can hold.
        db.set({ ...(db.get(egressDomainsKey(TEST_ORG, WEB)) as object), updatedAt: `2099-01-0${String(reads)}T00:00:00.000Z` });
      }
      return answer;
    } };
    await expect(putEgressDomains({ ...deps, documentClient: racing }, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" }))
      .rejects.toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining("the allowed domains changed while saving; reload and try again") as string });
    expect(reads).toBe(2);
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains.map((entry) => entry.domain)).toEqual(["a.acme.dev"]);
    expect(audits()).toHaveLength(auditsBefore);
  });

  it("do not let two writes in one millisecond pass for one", async () => {
    const fixed = () => new Date("2026-10-21T10:00:00.000Z");
    const { db, deps } = plain({ cloud: true, now: fixed });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    const first = (db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).updatedAt;
    await decideEgressDomain(deps, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-1" });
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).updatedAt > first).toBe(true);
  });

  it("count every change that serves differently on the sync marker, so two changes in one millisecond are two (Task 18 Minor 5)", async () => {
    const { db, deps } = plain({ cloud: false, now: () => new Date("2026-10-21T10:00:00.000Z") });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect(db.get(EGRESS_SYNC_KEY)).toMatchObject({ dirtySeq: 1, dirtyAt: "2026-10-21T10:00:00.000Z" });
    await putEgressDomains(deps, OTHER_ORG, WEB, ["b.beta.dev"], { developerId: "dev-2" });
    // The same millisecond, so `dirtyAt` repeats; the counter does not.
    expect(db.get(EGRESS_SYNC_KEY)).toMatchObject({ dirtySeq: 2, dirtyAt: "2026-10-21T10:00:00.000Z" });
    // A change that serves nothing differently (a request waiting for staff) leaves the marker alone.
    await putEgressDomains({ ...deps, cloud: true }, TEST_ORG, SOURCE, ["m.model.dev"], { developerId: "dev-1" });
    expect(db.get(EGRESS_SYNC_KEY)).toMatchObject({ dirtySeq: 2 });
  });

  it("retry a transaction that was cancelled for a reason other than the item changing, without calling it a changed list (Task 18 Minor 6)", async () => {
    const { db, deps } = plain({ cloud: true });
    // A concurrent transaction on the shared sync marker cancels this one once; the retry holds.
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] } });
    await expect(putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" })).resolves.toMatchObject({ pending: ["a.acme.dev"] });
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains).toHaveLength(1);
    // Cancelled every time, it is not a lost race: the caller is not told to reload.
    db.injectFault({ command: "TransactWriteCommand", times: 10, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ThrottlingError" }] } });
    const refused = await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-1" }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((refused as Error).message).not.toContain("the allowed domains changed");
  });

  it("write more audit items than one transaction holds, all of them", async () => {
    const { db, deps, audits } = plain({ cloud: false });
    const first = Array.from({ length: 50 }, (_, index) => `a${String(index)}.acme.dev`);
    await putEgressDomains(deps, TEST_ORG, WEB, first, { developerId: "dev-1" });
    const second = Array.from({ length: 50 }, (_, index) => `b${String(index)}.acme.dev`);
    await putEgressDomains(deps, TEST_ORG, WEB, second, { developerId: "dev-1" });
    expect(audits().filter((audit) => audit.action === "removed")).toHaveLength(50);
    expect(audits().filter((audit) => audit.action === "auto_approved")).toHaveLength(100);
    expect((db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains).toHaveLength(50);
  });

  it("list what waits, oldest first, from every org", async () => {
    const { deps } = plain({ cloud: true });
    await putEgressDomains(deps, OTHER_ORG, WEB, ["c.beta.dev"], { developerId: "dev-2" });
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev"], { developerId: "dev-1" });
    expect((await listPendingEgress(deps)).map((row) => `${row.orgId}:${row.domain}`).sort()).toEqual([`${OTHER_ORG}:c.beta.dev`, `${TEST_ORG}:a.acme.dev`].sort());
  });
});

describe("agentx project show", () => {
  it("prints each domain with its status, and a rejected one with the reason", async () => {
    const { projectShowText } = await import("../../packages/cli/src/developer/commands.js");
    const text = projectShowText({
      name: "web", status: "active", latestRevision: 2, myRole: "maintainer", setup: { status: "passed" }, repositories: [{ fullName: "acme/web", defaultBranch: "main" }],
      settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [
        { domain: "a.acme.dev", status: "pending" }, { domain: "b.acme.dev", status: "rejected", reason: "not an artifact host" }, { domain: "c.acme.dev", status: "approved" },
      ] },
    } as never);
    expect(text).toContain("a.acme.dev  (pending)");
    expect(text).toContain("b.acme.dev  (rejected: not an artifact host)");
    expect(text).toContain("c.acme.dev  (approved)");
  });
});

describe("closing an org", () => {
  it("clears its egress items through the sole owner's leave", async () => {
    const h = await install();
    // Omar is the org's only member, and its owner.
    h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    h.db.delete(developerOrgKey(MAYA.developerId));
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG)), approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
    await h.changeSites(["a.acme.dev"]);
    await putEgressDomains(h.deps, OTHER_ORG, WEB, ["c.beta.dev"], { developerId: "dev-2" });
    const left = await h.dev(OMAR, "POST", "/v1/app/org/leave", {});
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(h.item()).toBeUndefined();
    expect(h.item(OTHER_ORG)).toBeDefined();
    expect(h.audits().filter((audit) => audit.action === "removed" && audit.orgId === TEST_ORG)).toHaveLength(1);
  });
});

describe("agentx admin egress", () => {
  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };

  async function context() {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-egress-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
    return { tokens, globals: ["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback"] };
  }

  async function run(args: string[], answer: (path: string, body: unknown) => unknown) {
    const { tokens, globals } = await context();
    const requests: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ method: init?.method ?? "GET", path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") });
      return Response.json(answer(url.pathname, body));
    });
    let out = ""; let err = "";
    const code = await executeCli([...globals, ...args], { fetchImplementation, tokenStore: tokens, stdout: { write(text) { out += text; } }, stderr: { write(text) { err += text; } } });
    return { code, out, err, requests, fetchImplementation };
  }

  it("lists what waits for approval", async () => {
    const result = await run(["admin", "egress", "pending"], () => ({ pending: [
      { orgId: TEST_ORG, orgName: "Acme", owner: WEB, domain: "a.acme.dev", requestedAt: "2026-10-21T10:00:00.000Z", requestedBy: { developerId: "dev-1", name: "Omar Diaz" } },
      { orgId: TEST_ORG, orgName: "Acme", owner: SOURCE, domain: "m.model.dev", requestedAt: "2026-10-21T11:00:00.000Z", requestedBy: { developerId: "dev-2", name: "Maya Chen" } },
    ] }));
    expect(result.code).toBe(0);
    expect(result.requests).toMatchObject([{ method: "GET", path: "/v1/admin/egress/pending", authorization: "Bearer access-secret" }]);
    for (const expected of [TEST_ORG, "Acme", "project:web", "a.acme.dev", "Omar Diaz", "model-source:src_1", "m.model.dev"]) expect(result.out).toContain(expected);
    expect((await run(["admin", "egress", "pending"], () => ({ pending: [] }))).out).toContain("Nothing is waiting for approval");
  });

  it("approves and rejects one domain of one owner of one org", async () => {
    const approved = await run(["admin", "egress", "approve", TEST_ORG, "project:web", "a.acme.dev"], () => ({ orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", status: "approved" }));
    expect(approved.code).toBe(0);
    expect(approved.requests[0]).toMatchObject({ method: "POST", path: "/v1/admin/egress/approve", body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev" } });
    expect(approved.out).toContain("a.acme.dev");
    const warned = await run(["admin", "egress", "approve", TEST_ORG, "model-source:src_1", "m.model.dev"], () => ({ orgId: TEST_ORG, owner: SOURCE, domain: "m.model.dev", status: "approved", warning: "allowed domains will apply within 5 minutes" }));
    expect(warned.requests[0]!.body).toMatchObject({ owner: SOURCE });
    expect(warned.out).toContain("allowed domains will apply within 5 minutes");
    const rejected = await run(["admin", "egress", "reject", TEST_ORG, "project:web", "a.acme.dev", "--reason", "not an artifact host"], () => ({ orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", status: "rejected" }));
    expect(rejected.code).toBe(0);
    expect(rejected.requests[0]).toMatchObject({ path: "/v1/admin/egress/reject", body: { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", reason: "not an artifact host" } });
  });

  it("refuses a bad owner or a missing reason before calling the control plane", async () => {
    for (const args of [["admin", "egress", "approve", TEST_ORG, "web", "a.acme.dev"], ["admin", "egress", "reject", TEST_ORG, "project:web", "a.acme.dev"], ["admin", "egress", "reject", TEST_ORG, "project:web", "a.acme.dev", "--reason", ""]]) {
      const result = await run(args, () => ({}));
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.fetchImplementation).not.toHaveBeenCalled();
    }
  });

  it("shows the server's refusal", async () => {
    const { tokens, globals } = await context();
    let err = "";
    const code = await executeCli([...globals, "admin", "egress", "approve", TEST_ORG, "project:web", "a.acme.dev"], {
      fetchImplementation: vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFIG_INVALID", message: "a.acme.dev is not waiting for approval" } }, { status: 400 })),
      tokenStore: tokens, stdout: { write() {} }, stderr: { write(text) { err += text; } },
    });
    expect(code).not.toBe(0);
    expect(err).toContain("a.acme.dev is not waiting for approval");
  });
});
