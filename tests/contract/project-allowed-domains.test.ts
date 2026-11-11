import { loadSlackBroker } from "../support/slack-broker.js";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, INDEX_EXPIRY_ATTRIBUTE, ProjectDefinitionSchema, egressDomainsKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectPk, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { proposeProjectAllowedDomains, readProjectAllowedDomainProposal, decideProjectAllowedDomainProposal, commitReviewedProjectAllowedDomains, readProjectAllowedDomainsReview, commitDirectProjectAllowedDomains } from "../../packages/broker/src/org/project-allowed-domains.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
afterEach(() => { vi.restoreAllMocks(); });
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, by = "a".repeat(64), project = "payments", at = Date.parse("2026-10-29T21:00:00.000Z");
function fixture() {
 const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db });audit.audit.documentClient = db as unknown as typeof audit.audit.documentClient;
 db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00.000Z" });
 db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role: "owner" });db.set({ ...developerOrgKey(by), orgId, role: "owner" });
 db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: false });
 db.set({ ...projectMetaKey(orgId, project), name: project, status: "active", createdAt: "2026-10-01T00:00:00.000Z", createdBy: by, archiveRevision: 0 });
 const definition = ProjectDefinitionSchema.parse({ name: project, revision: 1, repositories: [{ name: "main", url: "https://github.com/acme/web.git", path: "repo/main", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate." });
 db.set({ ...projectRevisionKey(orgId, project, 1), entityType: "PROJECT", definition });db.set({ ...orgProjectCatalogKey(orgId, project), name: project, latestRevision: 1 });
 let now = at;const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => now, audit: audit.audit };
 const body = { requestId: randomUUID(), expectedRevision: 1, allowedDomains: ["artifacts.acme.dev"] };
 const propose = (overrides: Partial<typeof body> = {}) => proposeProjectAllowedDomains(deps, { orgId, project, by, body: { ...body, ...overrides } });
 return { db, audit, deps, body, propose, clock: (value: number) => { now = value; } };
}
describe("allowed website proposal creation", () => {
 it("persists an audited pending proposal and LIVE pointer without changing configuration", async () => {
  const f = fixture(), before = f.db.get(projectRevisionKey(orgId, project, 1));
  const result = await f.propose();
  expect(result).toMatchObject({ proposalId: f.body.requestId, state: "pending", beforeDomains: [], afterDomains: ["artifacts.acme.dev"], baseRevision: 1 });
  expect(f.db.get(projectRevisionKey(orgId, project, 1))).toEqual(before);expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
  const row = f.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` });
  expect(row?.expiresAt).toBe("2026-10-30T21:00:00.000Z");expect(row?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(at / 1000) + 31 * 86400);
  expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toMatchObject({ proposalId: f.body.requestId });
  expect(f.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
 });
 it("same UUID/body is status-only while changed body conflicts", async () => {
  const f = fixture();await f.propose();const writes = f.db.transactions().length;
  await f.propose();expect(f.db.transactions()).toHaveLength(writes);
  await expect(f.propose({ allowedDomains: ["other.acme.dev"] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(f.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
 });
 it("allows one live proposal and replaces only an expired pointer without TTL deletion", async () => {
  const f = fixture();await f.propose();
  await expect(f.propose({ requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  f.clock(at + 86400000);const nextId = randomUUID();await f.propose({ requestId: nextId });
  expect(f.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` })).toBeDefined();
  expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toMatchObject({ proposalId: nextId });
 });
 it("refuses stale revision, narrowing, revoked identity and missing audit without proposal writes", async () => {
  const f = fixture();await expect(f.propose({ expectedRevision: 2 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  await expect(f.propose({ allowedDomains: [] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  const { audit: ignored, ...withoutAudit } = f.deps;void ignored;
  await expect(proposeProjectAllowedDomains(withoutAudit, { orgId, project, by, body: f.body })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
  f.db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: true });
  await expect(f.propose()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL")).toEqual([]);
 });
});

it("proposal creation has one winner under concurrent distinct UUIDs", async () => {
 const f = fixture();const outcomes = await Promise.allSettled([f.propose(), f.propose({ requestId: randomUUID() })]);
 expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
 expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL")).toHaveLength(1);expect(f.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
});
it("a live identity revocation at commit leaves no proposal, pointer or audit", async () => {
 const f = fixture();let raced = false;
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { raced = true;f.db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: true });return false; }, error: { name: "InternalServerError" } });
 await expect(f.propose()).rejects.toMatchObject({ code: "FORBIDDEN" });expect(raced).toBe(true);
 expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL" || row.entityType === "EGRESS_PROPOSAL_LIVE")).toEqual([]);expect(f.audit.recordedBy("project.allowed_domains_proposed")).toEqual([]);
});
it("same-pointer canonical revision mutation is caught by the immutable-definition fence", async () => {
 const f = fixture(), key = projectRevisionKey(orgId, project, 1);
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { const row = f.db.get(key)!;f.db.set({ ...row, definition: { ...(row.definition as Record<string, unknown>), orchestratorInstructions: "Changed behind the pointer." } });return false; }, error: { name: "InternalServerError" } });
 await expect(f.propose()).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.audit.recordedBy("project.allowed_domains_proposed")).toEqual([]);
});
it("a committed proposal whose response is lost recovers its UUID without another transaction", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let writes = 0;
 f.db.send = async command => { const result = await send(command);if (command.constructor.name === "TransactWriteCommand") { writes += 1;throw new Error("lost committed response"); }return result; };
 const result = await f.propose();expect(result.state).toBe("pending");expect(writes).toBe(1);expect(f.audit.recordedBy("project.allowed_domains_proposed")).toHaveLength(1);
});
it("replay refuses a proposal whose stored exact list no longer matches its fingerprint", async () => {
 const f = fixture();await f.propose();const key = { pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` };
 f.db.set({ ...f.db.get(key), afterDomains: ["tampered.acme.dev"] });
 await expect(f.propose()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

const reviewer = "b".repeat(64);
function addReviewer(f: ReturnType<typeof fixture>) {
 f.db.set({ ...orgMemberKey(orgId, reviewer), orgId, developerId: reviewer, role: "admin" });f.db.set({ ...developerOrgKey(reviewer), orgId, role: "admin" });
 f.db.set({ pk: `DEVELOPER#${reviewer}`, sk: "META", developerId: reviewer, revoked: false });
}
it("proposal status derives expiry and stale context without writing", async () => {
 const f = fixture();await f.propose();const input = { orgId, project, by, proposalId: f.body.requestId }, count = f.db.transactions().length;
 expect((await readProjectAllowedDomainProposal(f.deps, input)).status).toBe("pending");
 f.clock(at + 86400000);expect((await readProjectAllowedDomainProposal(f.deps, input)).status).toBe("expired");
 f.clock(at);const key = orgProjectCatalogKey(orgId, project);f.db.set({ ...f.db.get(key), latestRevision: 2 });
 expect((await readProjectAllowedDomainProposal(f.deps, input)).status).toBe("stale");expect(f.db.transactions()).toHaveLength(count);
});
it("proposer cancellation is audited, releases LIVE and replays its own receipt only", async () => {
 const f = fixture();await f.propose();const body = { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" as const, reason: "Not needed" };
 const result = await decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body });expect(result.state).toBe("cancelled");
 expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();expect(f.audit.recordedBy("project.allowed_domains_cancelled")).toHaveLength(1);
 const count = f.db.transactions().length;await decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body });expect(f.db.transactions()).toHaveLength(count);
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { ...body, reason: "different" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("a distinct live eligible reviewer can reject but cannot cancel another person's proposal", async () => {
 const f = fixture();addReviewer(f);await f.propose();
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "reject" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
 const result = await decideProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "reject", reason: "Too broad" } });
 expect(result.state).toBe("rejected");expect(f.audit.recordedBy("project.allowed_domains_rejected")).toHaveLength(1);expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
});
it("expired decisions fail closed and cross-company records are indistinguishable from missing", async () => {
 const f = fixture();await f.propose();f.clock(at + 86400000);
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 const missing = { orgId, project, by, proposalId: randomUUID() };
 await expect(readProjectAllowedDomainProposal(f.deps, missing)).rejects.toMatchObject({ code: "NOT_FOUND" });
 f.db.set({ ...f.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` }), pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${missing.proposalId}`, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
 await expect(readProjectAllowedDomainProposal(f.deps, missing)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("competing cancellation and rejection have one terminal result and one terminal audit", async () => {
 const f = fixture();addReviewer(f);await f.propose();
 const results = await Promise.allSettled([
  decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } }),
  decideProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "reject" } }),
 ]);
 expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
 expect(f.audit.recordedBy("project.allowed_domains_cancelled").length + f.audit.recordedBy("project.allowed_domains_rejected").length).toBe(1);
 expect(f.db.find(row => row.kind === "decision_receipt")).toHaveLength(1);
 expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();
});
it("reviewer revocation at decision commit cannot create a terminal receipt or audit", async () => {
 const f = fixture();addReviewer(f);await f.propose();
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { f.db.set({ pk: `DEVELOPER#${reviewer}`, sk: "META", developerId: reviewer, revoked: true });return false; }, error: { name: "InternalServerError" } });
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "reject" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(f.db.find(row => row.kind === "decision_receipt")).toEqual([]);expect(f.audit.recordedBy("project.allowed_domains_rejected")).toEqual([]);
 expect(f.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` })?.state).toBe("pending");
});
it("name reuse at decision commit cannot terminate the old project's proposal", async () => {
 const f = fixture();await f.propose();const metaKey = projectMetaKey(orgId, project);
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { f.db.set({ ...f.db.get(metaKey), createdAt: "2026-10-29T20:00:00.000Z" });return false; }, error: { name: "InternalServerError" } });
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(f.db.find(row => row.kind === "decision_receipt")).toEqual([]);expect(f.audit.recordedBy("project.allowed_domains_cancelled")).toEqual([]);
});
it("a lost decision response recovers the owned receipt without another transaction", async () => {
 const f = fixture();await f.propose();const send = f.db.send.bind(f.db);let writes = 0;
 f.db.send = async command => { const result = await send(command);if (command.constructor.name === "TransactWriteCommand") { writes += 1;throw new Error("lost response"); }return result; };
 const result = await decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } });
 expect(result.state).toBe("cancelled");expect(writes).toBe(1);expect(f.audit.recordedBy("project.allowed_domains_cancelled")).toHaveLength(1);
});
it("revoked proposer makes pending status stale and cannot supply a live rejection context", async () => {
 const f = fixture();addReviewer(f);await f.propose();f.db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: true });
 expect((await readProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, proposalId: f.body.requestId })).status).toBe("stale");
 await expect(decideProjectAllowedDomainProposal(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "reject" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

function approvalFixture() {
 const f = fixture(), orgKey = orgMetaKey(orgId), key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!;
 f.db.set({ ...f.db.get(orgKey), approvalMembershipVersion: 7, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
 const definition = row.definition as { repositories: Array<Record<string, unknown>> };
 f.db.set({ ...row, definition: { ...definition, repositories: definition.repositories.map(repo => ({ ...repo, installationId: 55, githubRepositoryId: 901 })) },
  runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" }, registeredBy: "original-registration-owner", registeredAt: "2026-10-01T00:00:00.000Z",
  workingBranchSelections: { main: { branch: "release/v1", commit: "c".repeat(40), installationId: 55, repositoryId: 901 } } });
 return f;
}
it("distinct live approval atomically applies websites and preserves immutable registration and branch pins", async () => {
 const f = approvalFixture();addReviewer(f);await f.propose();const original = f.db.get(projectRevisionKey(orgId, project, 1))!;
 const result = await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId } });
 expect(result).toMatchObject({ state: "applied", mode: "second_person", resultRevision: 2 });
 const next = f.db.get(projectRevisionKey(orgId, project, 2));expect(next).toMatchObject({ registeredBy: reviewer, registeredAt: new Date(at).toISOString(), runtimeBinding: original.runtimeBinding, workingBranchSelections: original.workingBranchSelections });
 expect((next?.definition as Record<string, unknown>).network).toEqual({ allowedDomains: ["artifacts.acme.dev"] });
 expect(f.db.get(egressDomainsKey(orgId, { kind: "project", project }))?.domains).toMatchObject([{ domain: "artifacts.acme.dev", status: "pending" }]);
 expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();expect(f.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "second_person", toRevision: 2 } }]);
});
it("sole owner approval requires explicit acknowledgement and complete 24-hour eligibility proof", async () => {
 const f = approvalFixture();await f.propose();const body = { requestId: randomUUID(), proposalId: f.body.requestId };
 await expect(commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by, body })).rejects.toMatchObject({ code: "FORBIDDEN" });
 const result = await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by, body: { ...body, soleOwnerAcknowledged: true } });expect(result.mode).toBe("sole_owner_exception");
 expect(f.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "sole_owner_exception" } }]);
});
it("another eligible reviewer defeats the sole owner exception", async () => {
 const f = approvalFixture();addReviewer(f);await f.propose();
 await expect(commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, soleOwnerAcknowledged: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
});
it("membership generation racing approval leaves revision, egress and terminal receipt untouched", async () => {
 const f = approvalFixture();addReviewer(f);await f.propose();
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { const key = orgMetaKey(orgId);f.db.set({ ...f.db.get(key), approvalMembershipVersion: 8 });return false; }, error: { name: "InternalServerError" } });
 await expect(commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();expect(f.db.get(egressDomainsKey(orgId, { kind: "project", project }))).toBeUndefined();
 expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});

it("two approvers can create only one applied revision, receipt and website audit", async () => {
 const f = approvalFixture();addReviewer(f);const another = "d".repeat(64);
 f.db.set({ ...orgMemberKey(orgId, another), orgId, developerId: another, role: "admin" });f.db.set({ ...developerOrgKey(another), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${another}`, sk: "META", developerId: another, revoked: false });await f.propose();
 const results = await Promise.allSettled([reviewer, another].map(actor => commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: actor, body: { requestId: randomUUID(), proposalId: f.body.requestId } })));
 expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);expect(f.audit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
 expect(f.db.find(row => row.kind === "approval_receipt")).toHaveLength(1);expect(f.db.get(projectRevisionKey(orgId, project, 3))).toBeUndefined();
});
it("recent eligibility loss refuses the acknowledged sole-owner exception", async () => {
 const f = approvalFixture();await f.propose();const key = orgMetaKey(orgId);f.db.set({ ...f.db.get(key), approvalLastCompanyEligibleLossAt: "2026-10-29T20:00:00.000Z" });
 await expect(commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, soleOwnerAcknowledged: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
});
it("a lost applied response recovers only its own UUID and never writes a second revision", async () => {
 const f = approvalFixture();addReviewer(f);await f.propose();const send = f.db.send.bind(f.db);let writes = 0;
 f.db.send = async command => { const result = await send(command);if (command.constructor.name === "TransactWriteCommand") { writes += 1;throw new Error("lost approval response"); }return result; };
 const body = { requestId: randomUUID(), proposalId: f.body.requestId };
 const result = await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body });expect(result.resultRevision).toBe(2);
 await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body });expect(writes).toBe(1);expect(f.audit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
 await expect(commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body: { ...body, soleOwnerAcknowledged: true } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("a 50-entry replacement applies revision, staff state, dirty marker and one summary in one bounded transaction", async () => {
 const f = approvalFixture();addReviewer(f);const key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!, oldDomains = Array.from({ length: 50 }, (_, i) => `old${i}.acme.dev`), nextDomains = Array.from({ length: 50 }, (_, i) => `new${i}.acme.dev`);
 f.db.set({ ...row, definition: { ...(row.definition as Record<string, unknown>), network: { allowedDomains: oldDomains } } });
 const egressKey = egressDomainsKey(orgId, { kind: "project", project });
 f.db.set({ ...egressKey, entityType: "EGRESS_DOMAINS", orgId, owner: { kind: "project", project }, active: true, updatedAt: "2026-10-29T20:00:00.000Z", domains: oldDomains.map(domain => ({ domain, status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: by, decidedAt: "2026-10-01T00:00:00.000Z" })) });
 await f.propose({ allowedDomains: nextDomains });
 await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId } });
 const tx = f.db.transactions().at(-1)!;expect(tx.length).toBeLessThanOrEqual(100);
 expect(tx.filter(item => (item.Put as { Item?: Record<string, unknown> } | undefined)?.Item?.entityType === "EGRESS_DOMAINS")).toHaveLength(1);
 expect(f.db.get(egressKey)?.domains).toHaveLength(50);expect((f.db.get(egressKey)?.domains as Array<{ status: string }>).every(domain => domain.status === "pending")).toBe(true);
 expect(f.db.find(item => item.entityType === "EGRESS_SYNC")).toHaveLength(1);
 expect(f.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { added: 50, removed: 50, mode: "second_person" } }]);
});

it("common Cloud registrar accepts only a persisted exact reviewed proposal and preserves branch pins", async () => {
 vi.spyOn(Date, "now").mockReturnValue(at);
 const f = approvalFixture();addReviewer(f);const proposal = await f.propose(), base = f.db.get(projectRevisionKey(orgId, project, 1))!;
 await loadSlackBroker();const { registerProjectFor } = await import("../../packages/broker/src/aws/broker.js");
 const definition = ProjectDefinitionSchema.parse({ ...(base.definition as Record<string, unknown>), revision: 2, network: { allowedDomains: proposal.afterDomains } });
 const requestId = randomUUID(), proof = { requestId, proposalId: f.body.requestId, baseRevision: 1, afterDigest: proposal.afterDigest };
 const deps = { ...f.deps, cloud: true, developer: { signInTableName: "signin" } };
 const result = await registerProjectFor(deps as never, { orgId, ownerKey: reviewer }, { definition, runtimeBinding: base.runtimeBinding }, { creatorMembership: "none", appliedDomainProposal: proof });
 expect(result.duplicate).toBe(false);expect(result.project).toMatchObject({ registeredBy: reviewer, registeredAt: new Date(at).toISOString() });
 expect(f.db.get(projectRevisionKey(orgId, project, 2))?.workingBranchSelections).toEqual(base.workingBranchSelections);
 expect((await registerProjectFor(deps as never, { orgId, ownerKey: reviewer }, { definition, runtimeBinding: base.runtimeBinding }, { creatorMembership: "none", appliedDomainProposal: proof })).duplicate).toBe(true);
});
it("common registrar rejects forged proof digests and unrelated definition edits without side effects", async () => {
 vi.spyOn(Date, "now").mockReturnValue(at);
 const f = approvalFixture();addReviewer(f);const proposal = await f.propose(), base = f.db.get(projectRevisionKey(orgId, project, 1))!;
 await loadSlackBroker();const { registerProjectFor } = await import("../../packages/broker/src/aws/broker.js");
 const definition = ProjectDefinitionSchema.parse({ ...(base.definition as Record<string, unknown>), revision: 2, network: { allowedDomains: proposal.afterDomains } });
 const proof = { requestId: randomUUID(), proposalId: f.body.requestId, baseRevision: 1, afterDigest: createHash("sha256").update(canonicalJson(proposal.afterDomains)).digest("hex") };
 const deps = { ...f.deps, cloud: true, developer: { signInTableName: "signin" } };
 await expect(registerProjectFor(deps as never, { orgId, ownerKey: reviewer }, { definition, runtimeBinding: base.runtimeBinding }, { creatorMembership: "none", appliedDomainProposal: { ...proof, afterDigest: "0".repeat(64) } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 await expect(registerProjectFor(deps as never, { orgId, ownerKey: reviewer }, { definition: { ...definition, orchestratorInstructions: "unrelated edit" }, runtimeBinding: base.runtimeBinding }, { creatorMembership: "none", appliedDomainProposal: proof })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});

it("sole-owner approval audit records the eligibility fence, owner count and explicit exception reason", async () => {
 const f = approvalFixture();await f.propose();
 await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, soleOwnerAcknowledged: true } });
 const event = f.audit.recordedBy("project.allowed_domains_changed")[0]!;
 expect(event.details).toContainEqual({ subject: "org", fields: { membershipVersion: "7", ownerCount: "1", exceptionReason: "sole_owner_no_other_eligible_24h_clear" } });
});

it("canonical review binds project identity and immutable revision without writing", async () => {
 const f = fixture(), before = f.db.transactions().length;
 const review = await readProjectAllowedDomainsReview(f.deps, { orgId, project, by });
 expect(review).toMatchObject({ orgId, project, baseRevision: 1, allowedDomains: [], liveProposal: null });expect(review.contextDigest).toMatch(/^[a-f0-9]{64}$/);
 expect(f.db.transactions()).toHaveLength(before);
 await proposeProjectAllowedDomains(f.deps, { orgId, project, by, body: { ...f.body, expectedContextDigest: review.contextDigest } });
 expect((await readProjectAllowedDomainsReview(f.deps, { orgId, project, by })).liveProposal?.proposal.proposalId).toBe(f.body.requestId);
});
it("a reviewed context cannot stage a widening for a recreated project with the same revision", async () => {
 const f = fixture(), review = await readProjectAllowedDomainsReview(f.deps, { orgId, project, by }), key = projectMetaKey(orgId, project);
 f.db.set({ ...f.db.get(key), createdAt: "2026-10-29T20:00:00.000Z", archiveRevision: 2 });
 await expect(proposeProjectAllowedDomains(f.deps, { orgId, project, by, body: { ...f.body, expectedContextDigest: review.contextDigest } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL")).toEqual([]);
});

it("a proposer can explicitly cancel an obsolete revision proposal on the same active project identity", async () => {
 const f = fixture();await f.propose();const key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!;
 f.db.set({ ...row, ...projectRevisionKey(orgId, project, 2), definition: { ...(row.definition as Record<string, unknown>), revision: 2 } });f.db.set({ ...f.db.get(orgProjectCatalogKey(orgId, project)), latestRevision: 2 });
 const result = await decideProjectAllowedDomainProposal(f.deps, { orgId, project, by, body: { requestId: randomUUID(), proposalId: f.body.requestId, decision: "cancel" } });
 expect(result.state).toBe("cancelled");expect(f.db.get({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" })).toBeUndefined();expect(f.db.get(projectRevisionKey(orgId, project, 3))).toBeUndefined();
});

async function directFixture() {
 const f = approvalFixture(), key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!;
 f.db.set({ ...row, definition: { ...(row.definition as Record<string, unknown>), network: { allowedDomains: ["old.acme.dev"] } }, setupApproval: { proposalRef: "stored-reviewed-source", proposalSha256: "a".repeat(64), candidateDigest: "b".repeat(64), decision: "approve" } });
 const egressKey = egressDomainsKey(orgId, { kind: "project", project });f.db.set({ ...egressKey, entityType: "EGRESS_DOMAINS", orgId, owner: { kind: "project", project }, active: true, updatedAt: "2026-10-29T20:00:00.000Z", domains: [{ domain: "old.acme.dev", status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: by, decidedAt: "2026-10-01T00:00:00.000Z" }] });
 const review = await readProjectAllowedDomainsReview(f.deps, { orgId, project, by });
 const body = { requestId: randomUUID(), expectedRevision: 1, expectedContextDigest: review.contextDigest, allowedDomains: [] as string[] };
 return { ...f, body, egressKey, save: (override: Partial<typeof body> = {}) => commitDirectProjectAllowedDomains(f.deps, { orgId, project, by, body: { ...body, ...override } }) };
}
it("reviewed direct narrowing preserves registration, setup and branch pins in one audited revision", async () => {
 const f = await directFixture(), original = f.db.get(projectRevisionKey(orgId, project, 1))!;const result = await f.save();
 expect(result).toMatchObject({ state: "applied", mode: "direct_narrowing", resultRevision: 2 });
 const next = f.db.get(projectRevisionKey(orgId, project, 2));expect(next).toMatchObject({ registeredBy: by, registeredAt: new Date(at).toISOString(), runtimeBinding: original.runtimeBinding, setupApproval: original.setupApproval, workingBranchSelections: original.workingBranchSelections });
 expect((next?.definition as Record<string, unknown>).network).toBeUndefined();expect(f.db.get(f.egressKey)?.domains).toEqual([]);
 expect(f.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "direct_narrowing", removed: 1, added: 0 } }]);
});
it("direct save refuses widening and stale reviewed identity without changing configuration", async () => {
 const f = await directFixture();await expect(f.save({ allowedDomains: ["new.acme.dev"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
 f.db.set({ ...f.db.get(projectMetaKey(orgId, project)), archiveRevision: 3 });await expect(f.save()).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
});
it("archive/restore between review validation and planner reads cannot rebind direct narrowing", async () => {
 const f = await directFixture();let reads = 0;
 f.db.injectFault({ command: "GetCommand", match: input => { const key = input.Key as { pk: string; sk: string };if (key.pk === projectMetaKey(orgId, project).pk && key.sk === "META" && ++reads === 2) f.db.set({ ...f.db.get(key), archiveRevision: 3 });return false; }, error: { name: "InternalServerError" } });
 await expect(f.save()).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(reads).toBeGreaterThanOrEqual(2);expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});
it("ambiguous direct save recovers one owned receipt and never retries the transaction", async () => {
 const f = await directFixture(), send = f.db.send.bind(f.db);let writes = 0;
 f.db.send = async command => { const result = await send(command);if (command.constructor.name === "TransactWriteCommand") { writes += 1;throw new Error("lost direct save response"); }return result; };
 expect((await f.save()).state).toBe("applied");await f.save();expect(writes).toBe(1);expect(f.audit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
});
it("an identical reviewed website list is a write-free no-op", async () => {
 const f = await directFixture(), count = f.db.transactions().length;
 expect(await f.save({ allowedDomains: ["old.acme.dev"] })).toMatchObject({ state: "unchanged", resultRevision: 1 });expect(f.db.transactions()).toHaveLength(count);expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});
it("direct narrowing rolls back its revision, egress, pending cancellation and receipt together", async () => {
 const f = await directFixture();await f.propose({ allowedDomains: ["new.acme.dev"] });
 const before = structuredClone(f.db.find(() => true));
 f.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes('"entityType":"PROJECT"'), error: { name: "InternalServerError" } });
 await expect(f.save()).rejects.toThrow();expect(f.db.find(() => true)).toEqual(before);expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
 expect(f.db.get({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${f.body.requestId}` })).toBeUndefined();
});
it("direct narrowing refuses a concurrent egress decision rather than replanning the reviewed save", async () => {
 const f = await directFixture();let attempts = 0;
 f.db.injectFault({ command: "TransactWriteCommand", match: input => {
  if (!JSON.stringify(input).includes('"entityType":"PROJECT"')) return false;
  attempts += 1;f.db.set({ ...f.db.get(f.egressKey), updatedAt: "2026-10-29T21:00:01.000Z" });return false;
 }, error: { name: "InternalServerError" } });
 await expect(f.save()).rejects.toThrow();expect(attempts).toBe(1);expect(f.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();expect(f.db.get(f.egressKey)?.domains).toHaveLength(1);expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});
it("direct narrowing fails closed on a malformed immutable repository pin", async () => {
 const f = await directFixture(), key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!;
 f.db.set({ ...row, workingBranchSelections: { main: { branch: "main", commit: "a".repeat(40), installationId: 1, repositoryId: 999 } } });
 const review = await readProjectAllowedDomainsReview(f.deps, { orgId, project, by }), before = structuredClone(f.db.find(() => true));
 await expect(f.save({ expectedContextDigest: review.contextDigest })).rejects.toThrow();expect(f.db.find(() => true)).toEqual(before);expect(f.audit.recordedBy("project.allowed_domains_changed")).toEqual([]);
});

it("a legacy company commits distinct-person website approval without counter initialization", async () => {
 const f = approvalFixture();addReviewer(f);const key = orgMetaKey(orgId), meta = { ...f.db.get(key) };delete meta.approvalMembershipVersion;delete meta.approvalTrackingSince;f.db.set(meta);await f.propose();
 const result = await commitReviewedProjectAllowedDomains(f.deps, { orgId, project, by: reviewer, body: { requestId: randomUUID(), proposalId: f.body.requestId } });
 expect(result).toMatchObject({ state: "applied", mode: "second_person", resultRevision: 2 });expect(f.db.get(key)?.approvalMembershipVersion).toBeUndefined();
 expect(f.db.get(projectRevisionKey(orgId, project, 2))).toMatchObject({ registeredBy: reviewer });
});
it("takeover with website narrowing commits one project META action retaining lifecycle and loss fences", async () => {
 vi.spyOn(Date, "now").mockReturnValue(at);const f = approvalFixture();addReviewer(f);
 const baseKey = projectRevisionKey(orgId, project, 1), base = { ...f.db.get(baseKey) };delete base.workingBranchSelections;
 f.db.set({ ...f.db.get(orgProjectCatalogKey(orgId, project)), entityType: "PROJECT_CATALOG" });
 base.definition = { ...(base.definition as Record<string, unknown>), network: { allowedDomains: ["old.acme.dev"] } };f.db.set(base);
 f.db.set({ ...projectMemberKey(orgId, reviewer, project), entityType: "MEMBERSHIP", ownerKey: reviewer, projectName: project, role: "developer", projectRole: "maintainer", grantId: "old-grant" });
 await loadSlackBroker();const { registerProjectFor } = await import("../../packages/broker/src/aws/broker.js");
 const definition = ProjectDefinitionSchema.parse({ ...(base.definition as Record<string, unknown>), revision: 2, network: { allowedDomains: [] } });
 const result = await registerProjectFor({ ...f.deps, cloud: true, developer: { signInTableName: "signin" } } as never, { orgId, ownerKey: reviewer, auditActor: { kind: "operator", id: "op_" + "1".repeat(24) } }, { definition, runtimeBinding: base.runtimeBinding, takeOwnership: true, takeOwnershipReason: "Reviewed takeover" }, { creatorMembership: "administrator", credentialsChecked: [] });
 expect(result.duplicate).toBe(false);
 const actions = f.db.transactions().at(-1)! as Array<{ Update?: { Key: { pk: string; sk: string }; ConditionExpression?: string }; ConditionCheck?: { Key: { pk: string; sk: string } } }>;
 const matches = actions.filter(action => { const item = action.Update ?? action.ConditionCheck;return item?.Key.pk === projectMetaKey(orgId, project).pk && item.Key.sk === "META"; });
 expect(matches).toHaveLength(1);expect(matches[0]?.Update?.ConditionExpression).toContain("#m0 = :m0");
 expect(f.db.get(projectMetaKey(orgId, project))?.approvalLastMaintainerLossAt).toBe(result.project.registeredAt);
});
