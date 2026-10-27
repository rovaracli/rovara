// Plan 2, Task 20: a maintainer archives a project and restores it. Archiving refuses only new work (a task start, Slack-started work, the
// setup check, a settings save); work that exists keeps going. The project's approved domains leave the cell's union while it is archived and
// return, still approved, when it is restored. A closed org's projects are archived the same way.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AppProjectsResponseSchema, EGRESS_SYNC_PENDING_WARNING, egressDomainsKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, type EgressOwner, type OrgId,
} from "../../packages/contracts/src/index.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { approvedUnion, decideEgressDomain, putEgressDomains, readEgressDomains, type EgressDomainsDependencies } from "../../packages/broker/src/org/egress-domains.js";
import { archiveProject, restoreProject } from "../../packages/broker/src/org/project-archive.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const PAYMENTS: EgressOwner = { kind: "project", project: "payments" };
const ARCHIVED_MESSAGE = "Project `payments` is archived. Ask a project maintainer to restore it.";
const SETTINGS_ARCHIVED_MESSAGE = ARCHIVED_MESSAGE;
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const setRole = (db: FakeDynamoDb, who: Developer, role: "owner" | "admin" | "member") => seedMembership(db, who.developerId, { orgId: TEST_ORG, role });
const archiveRoute = (h: Harness, who: Developer, name = "payments", body: unknown = { requestId: randomUUID() }) => h.dev(who, "POST", `/v1/app/projects/${name}/archive`, body);
const restoreRoute = (h: Harness, who: Developer, name = "payments", body: unknown = { requestId: randomUUID() }) => h.dev(who, "POST", `/v1/app/projects/${name}/restore`, body);
const metaOf = (h: Harness, name = "payments", orgId: OrgId = TEST_ORG) => h.db.get(projectMetaKey(orgId, name)) as Record<string, unknown> | undefined;
const listed = async (h: Harness, who: Developer, query = "") => (await h.dev(who, "GET", `/v1/app/projects${query}`)).body.projects as Array<{ name: string; status: string }> | undefined;

/** A cloud install whose firewall sync is a spy, so a test sees when an archive or restore asks for it. */
async function cloudInstall(options: { syncOk?: boolean } = {}) {
  const sync = vi.fn(async () => ({ ok: options.syncOk ?? true, domains: 0 }));
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { cloud: true, egressDomainsSync: sync } });
  setRole(h.db, OMAR, "owner");
  const egress: EgressDomainsDependencies = { documentClient: h.db, tableName: "state", cloud: true, now: () => new Date(), sync };
  /** The project asks for exactly these domains and staff approve each, as the app and the operator console do. */
  const approve = async (domains: string[], project = "payments", orgId: OrgId = TEST_ORG) => {
    const owner: EgressOwner = { kind: "project", project };
    await putEgressDomains(egress, orgId, owner, domains, { developerId: OMAR.developerId });
    for (const domain of domains) await decideEgressDomain(egress, { orgId, owner, domain, decision: "approved", operatorId: "operator-1" });
  };
  return { ...h, sync, egress, approve };
}

describe("POST /v1/app/projects/{name}/archive", () => {
  it("answers the archived project and writes status, archivedAt and archivedBy on META", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const before = metaOf(h)!;
    const answer = await archiveRoute(h, OMAR);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.project).toMatchObject({ name: "payments", status: "archived", myRole: "maintainer" });
    expect(metaOf(h)).toMatchObject({ entityType: "PROJECT_META", name: "payments", status: "archived", archivedBy: OMAR.developerId, archivedAt: expect.any(String) as string, createdAt: before.createdAt, createdBy: before.createdBy });
    expect(Number.isNaN(Date.parse(String(metaOf(h)!.archivedAt)))).toBe(false);
  });

  it("answers 200 and changes nothing when the project is already archived", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    const first = metaOf(h)!;
    // A different maintainer repeating it does not take over the archive.
    setRole(h.db, MAYA, "admin");
    const again = await archiveRoute(h, MAYA);
    expect(again.status).toBe(200);
    expect(again.body.project).toMatchObject({ status: "archived" });
    expect(metaOf(h)).toEqual(first);
  });

  it("refuses a contributor with 403 and answers 404 to a member with no access; nothing is written either way", async () => {
    const h = await createSingleAnswerPlanBroker();
    // Maya reaches payments through its Slack channel: a contributor.
    const refused = await archiveRoute(h, MAYA);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "only a project maintainer can archive or restore a project" });
    grantProject(h.db, OMAR, "payments");
    expect((await archiveRoute(h, OMAR)).status).toBe(403);
    expect(metaOf(h)).toMatchObject({ status: "active" });
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    const hidden = await archiveRoute(h, OMAR);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const missing = await archiveRoute(h, OMAR, "no-such-project");
    expect(missing.status).toBe(404);
    expect(metaOf(h)).toMatchObject({ status: "active" });
  });

  it("never reaches another org's project of the same name", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    h.db.set({ ...orgProjectCatalogKey(OTHER_ORG, "elsewhere"), entityType: "PROJECT_CATALOG", name: "elsewhere", latestRevision: 1, firstRegisteredAt: "x" });
    h.db.set({ ...projectMetaKey(OTHER_ORG, "elsewhere"), entityType: "PROJECT_META", name: "elsewhere", status: "active", createdAt: "x", createdBy: "y" });
    expect((await archiveRoute(h, OMAR, "elsewhere")).status).toBe(404);
    expect(metaOf(h, "elsewhere", OTHER_ORG)).toMatchObject({ status: "active" });
  });

  it("refuses a body that is not exactly { requestId } with CONFIG_INVALID, before anything is written", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    for (const body of [{}, { requestId: "not-a-uuid" }, { requestId: randomUUID(), extra: true }]) {
      const refused = await archiveRoute(h, OMAR, "payments", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(metaOf(h)).toMatchObject({ status: "active" });
  });

  it("gives a project that predates META one, archived, and reads as created by unknown", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    h.db.delete(projectMetaKey(TEST_ORG, "payments"));
    expect((await archiveRoute(h, OMAR)).status).toBe(200);
    expect(metaOf(h)).toMatchObject({ entityType: "PROJECT_META", name: "payments", status: "archived", createdBy: "unknown", archivedBy: OMAR.developerId });
    expect((await restoreRoute(h, OMAR)).status).toBe(200);
    expect(metaOf(h)).toMatchObject({ status: "active", createdBy: "unknown" });
  });
});

describe("archiving a project with work in flight", () => {
  it("keeps a running task's continue and cancel working, and refuses only a new task start, with the exact message", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const started = await h.dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord;
    const active = () => String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    await h.finish(task.workspaceId, active(), "SUCCEEDED");

    expect((await archiveRoute(h, OMAR)).status).toBe(200);

    const continued = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const refused = await h.dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ARCHIVED", message: expect.stringContaining(ARCHIVED_MESSAGE) as string });
    // Maya, a contributor, is refused the same way; her refusal is not about her role.
    const mayaRefused = await h.dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(mayaRefused.body.error).toMatchObject({ code: "PROJECT_ARCHIVED" });
    const cancelled = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    // The workspace is not deleted.
    expect(h.db.get(`WORKSPACE#${task.workspaceId}`, "META")).toBeDefined();
  });

  describe("a required E2E round", () => {
    const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
    const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

    /** The owner's Quick workflow task, past implementation, waiting in VERIFY on a required E2E round whose CHECKS dispatch is due. */
    async function waitingForRound(h: Harness, maker: Developer) {
      const started = await h.dev(maker, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const taskId = String((started.body.task as { taskId: string }).taskId);
      const record = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; ownerKey: string; workflow: Record<string, unknown> };
      const workspaceId = record.workspaceId;
      h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
      h.db.set({ ...(h.db.get(`DEVELOPER#${maker.developerId}`, "META") as Record<string, unknown>), entityType: "DEVELOPER" });
      await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
      const plan = "# Plan\n\n1. Fix retry handling.\n";
      await finishPlanningWithMarkdown(h, workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
      const revision = (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
      await h.dev(maker, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
      const implementation = operations(h, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
      const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
      const passing = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
      await h.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passing } });
      const taskRow = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: { revision: number } & Record<string, unknown> };
      const waiting = { ...taskRow.workflow, stage: "VERIFY", state: "WAITING",
        e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } };
      h.db.set({ ...taskRow, workflow: waiting });
      const workspace = h.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
      const { activeOperationId: _active, ...idle } = workspace;
      void _active;
      h.db.set({ ...idle, status: "READY" });
      for (const operation of operations(h, workspaceId).filter((item) => item.workflowMode === "REVIEW")) h.db.set({ ...operation, status: "SUCCEEDED" });
      for (const row of h.db.find((item) => item.pk === "WORKFLOW_DISPATCH")) h.db.delete(row as { pk: string; sk: string });
      const now = new Date().toISOString();
      const dispatchSk = `${taskId}#${waiting.revision}`;
      h.db.set({ pk: "WORKFLOW_DISPATCH", sk: dispatchSk, entityType: "WORKFLOW_DISPATCH", taskId, workflowRevision: waiting.revision, kind: "CHECKS", candidateDigest: candidate.digest,
        createdAt: now, attempts: 0, nextAttemptAt: now, dispatchDuePk: "WORKFLOW_DISPATCH", dispatchDueSk: `${now}#${dispatchSk}`, indexExpiresAt: Math.floor(Date.now() / 1_000) + 86_400 });
      return { workspaceId, ownerKey: record.ownerKey };
    }

    it("runs its next round after the project is archived: the creator-authority recheck passes", async () => {
      const h = await createSingleAnswerPlanBroker();
      setRole(h.db, OMAR, "owner");
      const { workspaceId, ownerKey } = await waitingForRound(h, OMAR);
      h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
      h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
      expect((await archiveRoute(h, OMAR)).status).toBe(200);
      await h.handler({ source: "agentx.workflow-dispatch-recovery" });
      expect(operations(h, workspaceId).filter((item) => item.workflowE2EReadiness !== undefined)).toHaveLength(1);
    });
  });
});

describe("POST /v1/app/projects/{name}/restore", () => {
  it("makes the project active again: status back, archivedAt and archivedBy removed, starts work", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    expect((await h.dev(MAYA, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "PROJECT_ARCHIVED" });
    const restored = await restoreRoute(h, OMAR);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.project).toMatchObject({ name: "payments", status: "active" });
    const meta = metaOf(h)!;
    expect(meta).toMatchObject({ status: "active" });
    expect(meta).not.toHaveProperty("archivedAt");
    expect(meta).not.toHaveProperty("archivedBy");
    expect((await h.dev(MAYA, "POST", "/v1/dev/tasks", start())).status).toBe(200);
  });

  it("answers 200 and changes nothing on a project that is not archived; a contributor is refused", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const before = metaOf(h);
    const answer = await restoreRoute(h, OMAR);
    expect(answer.status).toBe(200);
    expect(answer.body.project).toMatchObject({ status: "active" });
    expect(metaOf(h)).toEqual(before);
    await archiveRoute(h, OMAR);
    const refused = await restoreRoute(h, MAYA);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(metaOf(h)).toMatchObject({ status: "archived" });
  });
});

describe("the project list and name", () => {
  it("hides an archived project from GET /v1/app/projects and shows it, marked archived, with include=archived", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    expect(await listed(h, OMAR)).toEqual([]);
    const all = await h.dev(OMAR, "GET", "/v1/app/projects?include=archived");
    expect(AppProjectsResponseSchema.parse(all.body).projects.map((project) => [project.name, project.status])).toEqual([["payments", "archived"]]);
    // The detail still answers, so the app can show the restore button.
    expect((await h.dev(OMAR, "GET", "/v1/app/projects/payments")).body).toMatchObject({ name: "payments", status: "archived" });
    await restoreRoute(h, OMAR);
    expect((await listed(h, OMAR))!.map((project) => project.name)).toEqual(["payments"]);
  });

  it("keeps the name: creating a project with an archived project's name is PROJECT_NAME_TAKEN", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    const { registerProjectFor } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      registerProjectFor: (...input: unknown[]) => Promise<{ duplicate: boolean }>;
    };
    const definition = {
      name: "payments", revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    };
    await expect(registerProjectFor(h.brokerInput, { orgId: TEST_ORG, ownerKey: OMAR.developerId }, { definition, runtimeBinding: BINDING }, { creatorMembership: "none", requireNewName: true }))
      .rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
  });
});

describe("the project's approved domains", () => {
  it("leave the union when the project is archived and return, still approved and not asked again, when it is restored", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev", "cdn.acme.dev"]);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev", "cdn.acme.dev"]);
    h.sync.mockClear();

    expect((await archiveRoute(h, OMAR)).status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual([]);
    expect(h.sync).toHaveBeenCalledTimes(1);
    // The item keeps its approvals while it is inactive.
    expect(await readEgressDomains(h.egress, TEST_ORG, PAYMENTS)).toMatchObject({ active: false, domains: [{ domain: "artifacts.acme.dev", status: "approved" }, { domain: "cdn.acme.dev", status: "approved" }] });

    h.sync.mockClear();
    expect((await restoreRoute(h, OMAR)).status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev", "cdn.acme.dev"]);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(await readEgressDomains(h.egress, TEST_ORG, PAYMENTS)).toMatchObject({ active: true });
  });

  it("leave only this project's share of the union: another project's domains stay", async () => {
    const h = await cloudInstall();
    const web = { name: "web" };
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, web.name), entityType: "PROJECT_CATALOG", name: web.name, latestRevision: 1, firstRegisteredAt: "x" });
    await h.approve(["artifacts.acme.dev"]);
    await h.approve(["docs.acme.dev"], "web");
    await archiveRoute(h, OMAR);
    expect(await approvedUnion(h.egress)).toEqual(["docs.acme.dev"]);
  });

  it("asks for no firewall sync when the project has no egress item or no approved domain", async () => {
    const h = await cloudInstall();
    expect((await archiveRoute(h, OMAR)).status).toBe(200);
    expect(h.sync).not.toHaveBeenCalled();
    await restoreRoute(h, OMAR);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("finishes a half-done archive when it is repeated: META is archived but the egress flip failed once", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await archiveRoute(h, OMAR);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // The archive stands (new work is refused) while the domains are still served...
    expect(metaOf(h)).toMatchObject({ status: "archived" });
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
    // ...and repeating it finishes the job.
    const again = await archiveRoute(h, OMAR);
    expect(again.status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual([]);
  });

  it("finishes a half-done restore when it is repeated, and never serves a restored project's domains before META says active", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    await archiveRoute(h, OMAR);
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await restoreRoute(h, OMAR);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(metaOf(h)).toMatchObject({ status: "active" });
    // Fail closed: the domains are not served until the flip lands.
    expect(await approvedUnion(h.egress)).toEqual([]);
    expect((await restoreRoute(h, OMAR)).status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
  });

  it("start inactive for a project archived before it first asked for a domain, and a restore turns them on", async () => {
    const h = await cloudInstall();
    await archiveRoute(h, OMAR);
    await putEgressDomains(h.egress, TEST_ORG, PAYMENTS, ["late.acme.dev"], { developerId: OMAR.developerId });
    await decideEgressDomain(h.egress, { orgId: TEST_ORG, owner: PAYMENTS, domain: "late.acme.dev", decision: "approved", operatorId: "operator-1" });
    expect(await approvedUnion(h.egress)).toEqual([]);
    await restoreRoute(h, OMAR);
    expect(await approvedUnion(h.egress)).toEqual(["late.acme.dev"]);
  });
});

describe("the scheduled sync repairs an archive or restore that stopped after META (fix round, Important 1)", () => {
  const scheduled = (h: Awaited<ReturnType<typeof cloudInstall>>) => h.handler({ source: "agentx.egress-domains-sync" });
  const archivedMeta = (h: Harness, name = "payments", orgId: OrgId = TEST_ORG) =>
    h.db.set({ ...(metaOf(h, name, orgId) as object), status: "archived", archivedAt: "2026-10-21T10:00:00.000Z", archivedBy: OMAR.developerId });

  it("takes an archived project's still-active items out of the union", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    archivedMeta(h);
    // The process died here: META says archived, the item is still active, the union still serves the domain.
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
    const run = await scheduled(h);
    expect(run.statusCode).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual([]);
    expect(await readEgressDomains(h.egress, TEST_ORG, PAYMENTS)).toMatchObject({ active: false, domains: [{ domain: "artifacts.acme.dev", status: "approved" }] });
  });

  it("puts a restored project's inactive items back in the union", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    await archiveRoute(h, OMAR);
    // The process died after the restore wrote META: the project is active and its item is still inactive.
    const { archivedAt: _at, archivedBy: _by, ...rest } = metaOf(h)!;
    void _at; void _by;
    h.db.set({ ...rest, status: "active" });
    expect(await approvedUnion(h.egress)).toEqual([]);
    expect((await scheduled(h)).statusCode).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
  });

  it("leaves items that already agree with their project alone, and a project with no META reads as active", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    h.db.delete(projectMetaKey(TEST_ORG, "payments"));
    h.sync.mockClear();
    expect((await scheduled(h)).statusCode).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
    expect(await readEgressDomains(h.egress, TEST_ORG, PAYMENTS)).toMatchObject({ active: true });
  });

  it("repairs each org's projects by their own META", async () => {
    const h = await cloudInstall();
    h.db.set({ ...projectMetaKey(OTHER_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "x", createdBy: "y" });
    await h.approve(["a.acme.dev"]);
    await h.approve(["b.acme.dev"], "payments", OTHER_ORG);
    archivedMeta(h);
    await scheduled(h);
    expect(await approvedUnion(h.egress)).toEqual(["b.acme.dev"]);
  });
});

describe("the answer's warnings and the stored request id (fix round)", () => {
  it("carries the pending-sync warning when the firewall could not be told, and none when it could", async () => {
    const failing = await cloudInstall({ syncOk: false });
    await failing.approve(["artifacts.acme.dev"]);
    const archived = await archiveRoute(failing, OMAR);
    expect(archived.status).toBe(200);
    expect(archived.body.warnings).toEqual([EGRESS_SYNC_PENDING_WARNING]);
    expect((await restoreRoute(failing, OMAR)).body.warnings).toEqual([EGRESS_SYNC_PENDING_WARNING]);
    const working = await cloudInstall();
    await working.approve(["artifacts.acme.dev"]);
    expect((await archiveRoute(working, OMAR)).body.warnings).toEqual([]);
    expect((await restoreRoute(working, OMAR)).body.warnings).toEqual([]);
  });

  it("answers a replay of the same request id without applying it again: a late archive after a restore leaves the project active", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const first = randomUUID();
    expect((await archiveRoute(h, OMAR, "payments", { requestId: first })).status).toBe(200);
    expect((await restoreRoute(h, OMAR)).status).toBe(200);
    const late = await archiveRoute(h, OMAR, "payments", { requestId: first });
    expect(late.status).toBe(200);
    expect(late.body.project).toMatchObject({ status: "active" });
    expect(late.body.warnings).toEqual([]);
    expect(metaOf(h)).toMatchObject({ status: "active" });
    // The same goes for a late restore after a second archive.
    const restoreId = randomUUID();
    await restoreRoute(h, OMAR, "payments", { requestId: restoreId });
    await archiveRoute(h, OMAR);
    expect((await restoreRoute(h, OMAR, "payments", { requestId: restoreId })).body.project).toMatchObject({ status: "archived" });
    expect(metaOf(h)).toMatchObject({ status: "archived" });
  });

  it("refuses one request id used for the other action, and does not store an id whose call failed", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    const id = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBeGreaterThanOrEqual(500);
    // The retry with the same id is not a replay: it finishes the job.
    const retried = await archiveRoute(h, OMAR, "payments", { requestId: id });
    expect(retried.status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual([]);
    const other = await restoreRoute(h, OMAR, "payments", { requestId: id });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(metaOf(h)).toMatchObject({ status: "archived" });
  });

  it("keeps a request id to its own project", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1, firstRegisteredAt: "x" });
    const id = randomUUID();
    await archiveRoute(h, OMAR, "payments", { requestId: id });
    // Another project's archive under the same id is its own request, not a replay.
    const key = (name: string) => h.db.find((item) => item.pk === projectMetaKey(TEST_ORG, name).pk && typeof item.sk === "string" && item.sk.startsWith("ARCHIVE_REQUEST#"));
    expect(key("payments")).toHaveLength(1);
    expect(key("web")).toHaveLength(0);
  });
});

describe("a settings save on an archived project", () => {
  const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });

  it("is refused with PROJECT_ARCHIVED, writes no revision and no description, and works again once the project is restored", async () => {
    const h = await createSingleAnswerPlanBroker({
      register: false,
      brokerExtra: { cloud: true, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" } },
    });
    setRole(h.db, OMAR, "owner");
    h.db.set({
      ...projectRevisionKey(TEST_ORG, "payments", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
      definition: {
        name: "payments", revision: 1,
        repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)], orchestratorInstructions: "Delegate work.",
      },
    });
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", description: "Billing", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    const put = (body: Record<string, unknown>) => h.dev(OMAR, "PUT", "/v1/app/projects/payments/settings", { requestId: randomUUID(), expectedRevision: 1, ...body });
    const revisions = () => h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(TEST_ORG, "payments", 1).pk);

    await archiveRoute(h, OMAR);
    const refused = await put({ setupCommands: ["npm run setup"], description: "Changed", allowedDomains: ["x.acme.dev"] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ARCHIVED", message: expect.stringContaining(SETTINGS_ARCHIVED_MESSAGE) as string });
    expect(revisions()).toHaveLength(1);
    expect(metaOf(h)).toMatchObject({ description: "Billing" });
    expect(h.db.get(egressDomainsKey(TEST_ORG, PAYMENTS))).toBeUndefined();

    await restoreRoute(h, OMAR);
    const saved = await put({ setupCommands: ["npm run setup"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(revisions()).toHaveLength(2);
  });

  it("answers a contributor 403 before it says anything about the archive", async () => {
    const h = await createSingleAnswerPlanBroker({ register: true, brokerExtra: { cloud: true, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" } } });
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    const refused = await h.dev(MAYA, "PUT", "/v1/app/projects/payments/settings", { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["x"] });
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("archiveProject and restoreProject", () => {
  const deps = (h: Harness) => ({ documentClient: h.db, tableName: "state", egress: { documentClient: h.db, tableName: "state", cloud: true, now: () => new Date(), sync: async () => ({ ok: true }) } as EgressDomainsDependencies, now: () => new Date("2026-10-21T10:00:00.000Z") });

  it("archives with the actor and the time given, once: a second archive keeps the first actor and time", async () => {
    const h = await createSingleAnswerPlanBroker();
    await archiveProject(deps(h), TEST_ORG, "payments", { developerId: OMAR.developerId });
    expect(metaOf(h)).toMatchObject({ status: "archived", archivedBy: OMAR.developerId, archivedAt: "2026-10-21T10:00:00.000Z" });
    await archiveProject({ ...deps(h), now: () => new Date("2026-10-22T10:00:00.000Z") }, TEST_ORG, "payments", { developerId: MAYA.developerId });
    expect(metaOf(h)).toMatchObject({ archivedBy: OMAR.developerId, archivedAt: "2026-10-21T10:00:00.000Z" });
    await restoreProject(deps(h), TEST_ORG, "payments");
    expect(metaOf(h)).toMatchObject({ status: "active" });
    expect(metaOf(h)).not.toHaveProperty("archivedAt");
  });

  it("touches only the named org's project", async () => {
    const h = await createSingleAnswerPlanBroker();
    h.db.set({ ...projectMetaKey(OTHER_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "x", createdBy: "y" });
    await archiveProject(deps(h), TEST_ORG, "payments", { developerId: OMAR.developerId });
    expect(metaOf(h, "payments", OTHER_ORG)).toMatchObject({ status: "active" });
  });
});

describe("closing an org archives its projects (POST /v1/app/org/leave by the only member)", () => {
  it("archives every project of the closed org, takes its domains out of the union, and leaves another org's projects alone", async () => {
    const orgA = `org_${"a".repeat(20)}`;
    const zed: Developer = { developerId: createHash("sha256").update("zed").digest("hex"), name: "Zed Yu", provider: "oidc", sessionId: "s-zed" };
    const sync = vi.fn(async () => ({ ok: true, domains: 0 }));
    const h = await createSingleAnswerPlanBroker({
      brokerExtra: { cloud: true, egressDomainsSync: sync },
      orgResolver: async ({ developerId }) => (developerId === zed.developerId ? orgA : TEST_ORG),
      developerExtra: { endDeveloperSessions: async () => ({ ok: true as const }) },
    });
    h.db.set({ pk: `SESSION#${zed.sessionId}`, sk: "META", sessionId: zed.sessionId, developerId: zed.developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${zed.developerId}`, sk: "META", developerId: zed.developerId, provider: "oidc", displayName: zed.name, email: "zed@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(zed);
    seedMembership(h.db, zed.developerId, { orgId: orgA, role: "owner" });
    const egress: EgressDomainsDependencies = { documentClient: h.db, tableName: "state", cloud: true, now: () => new Date(), sync };
    for (const name of ["alpha", "beta"]) {
      h.db.set({ ...orgProjectCatalogKey(orgA, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "x" });
      h.db.set({ ...projectMetaKey(orgA, name), entityType: "PROJECT_META", name, status: "active", createdAt: "x", createdBy: "y" });
    }
    // Beta was archived earlier, by someone else, and keeps that record.
    await archiveProject({ documentClient: h.db, tableName: "state", egress, now: () => new Date("2026-10-01T00:00:00.000Z") }, orgA, "beta", { developerId: "earlier" });
    await putEgressDomains(egress, orgA, { kind: "project", project: "alpha" }, ["a.acme.dev"], { developerId: zed.developerId });
    await decideEgressDomain(egress, { orgId: orgA, owner: { kind: "project", project: "alpha" }, domain: "a.acme.dev", decision: "approved", operatorId: "operator-1" });
    await putEgressDomains(egress, TEST_ORG, PAYMENTS, ["p.acme.dev"], { developerId: OMAR.developerId });
    await decideEgressDomain(egress, { orgId: TEST_ORG, owner: PAYMENTS, domain: "p.acme.dev", decision: "approved", operatorId: "operator-1" });

    // Closing makes no per-project flip or sync: the items are deleted by clearOrgEgress, whose one sync follows. At each sync, alpha's item is already gone.
    const seen: Array<boolean> = [];
    sync.mockImplementation(async () => { seen.push(h.db.get(egressDomainsKey(orgA, { kind: "project", project: "alpha" })) !== undefined); return { ok: true, domains: 0 }; });
    const left = await h.dev(zed, "POST", "/v1/app/org/leave", {});
    expect(seen).toEqual([false]);
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    expect(metaOf(h, "alpha", orgA)).toMatchObject({ status: "archived", archivedBy: zed.developerId });
    expect(metaOf(h, "beta", orgA)).toMatchObject({ status: "archived", archivedBy: "earlier" });
    expect(metaOf(h)).toMatchObject({ status: "active" });
    expect(await approvedUnion(egress)).toEqual(["p.acme.dev"]);
  });
});

// Final review M2: the one request-id pattern. The record is written in the same transaction as the change, with an expiry; a replay by the same
// person answers the stored outcome and writes nothing; another person's use of the id, or the other action's, is IDEMPOTENCY_CONFLICT.
describe("the archive and restore request id (final review M2)", () => {
  const requestsOf = (h: Harness) => h.db.find((item) => item.pk === projectMetaKey(TEST_ORG, "payments").pk && typeof item.sk === "string" && item.sk.startsWith("ARCHIVE_REQUEST#"));

  it("stores the request in the same transaction as the META change, bound to the caller and with an expiry", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const sent: Array<Array<Record<string, unknown>>> = [];
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<Record<string, unknown>> } }) => {
      if (command.constructor.name === "TransactWriteCommand") sent.push(command.input?.TransactItems ?? []);
      return send(command as never);
    });
    const id = randomUUID();
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBe(200);
    const withMeta = sent.filter((items) => JSON.stringify(items).includes("ARCHIVE_REQUEST#") && JSON.stringify(items).includes("archived"));
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0]!.length).toBeLessThanOrEqual(100);
    expect(requestsOf(h)).toHaveLength(1);
    expect(requestsOf(h)[0]).toMatchObject({ sk: `ARCHIVE_REQUEST#${id}`, action: "archive", by: OMAR.developerId });
    expect(requestsOf(h)[0]!.indexExpiresAt as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("leaves neither the change nor the record when the transaction fails, and the same id then works", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const id = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBeGreaterThanOrEqual(500);
    expect(metaOf(h)).toMatchObject({ status: "active" });
    expect(requestsOf(h)).toEqual([]);
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBe(200);
    expect(metaOf(h)).toMatchObject({ status: "archived" });
  });

  it("records a request that changes nothing (the project is already archived) and replays it", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    await archiveRoute(h, OMAR);
    const id = randomUUID();
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBe(200);
    expect(requestsOf(h).map((item) => item.sk)).toContain(`ARCHIVE_REQUEST#${id}`);
    await restoreRoute(h, OMAR);
    const late = await archiveRoute(h, OMAR, "payments", { requestId: id });
    expect(late.status).toBe(200);
    expect(metaOf(h)).toMatchObject({ status: "active" });
  });

  it("refuses another person's use of a request id with IDEMPOTENCY_CONFLICT, and applies nothing", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    setRole(h.db, MAYA, "admin");
    const id = randomUUID();
    await archiveRoute(h, OMAR, "payments", { requestId: id });
    await restoreRoute(h, OMAR);
    const stolen = await archiveRoute(h, MAYA, "payments", { requestId: id });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(metaOf(h)).toMatchObject({ status: "active" });
  });

  it("treats an expired record the State table has not yet deleted as absent, and replaces it in the same transaction", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const id = randomUUID();
    h.db.set({ pk: projectMetaKey(TEST_ORG, "payments").pk, sk: `ARCHIVE_REQUEST#${id}`, entityType: "PROJECT_ARCHIVE_REQUEST", action: "restore", by: MAYA.developerId, indexExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBe(200);
    expect(metaOf(h)).toMatchObject({ status: "archived" });
    expect(requestsOf(h)[0]).toMatchObject({ action: "archive", by: OMAR.developerId });
  });

  it("answers a replay of a call whose firewall step failed without writing, and the schedule's reconcile finishes the flip", async () => {
    const h = await cloudInstall();
    await h.approve(["artifacts.acme.dev"]);
    const id = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    expect((await archiveRoute(h, OMAR, "payments", { requestId: id })).status).toBeGreaterThanOrEqual(500);
    const again = await archiveRoute(h, OMAR, "payments", { requestId: id });
    expect(again.status).toBe(200);
    expect(await approvedUnion(h.egress)).toEqual(["artifacts.acme.dev"]);
    const { reconcileProjectEgress } = await import("../../packages/broker/src/org/project-archive.js");
    await reconcileProjectEgress({ documentClient: h.db, tableName: "state", egress: h.egress });
    expect(await approvedUnion(h.egress)).toEqual([]);
  });
});
