// Playbook P3: the task view (version 2) carries the same proof table the pull request gets, in `proofTable`: rows, the not-tested list and the test-proof lines. It is absent when the task has no approved
// plan with claims, and a client that does not ask for the version 2 view never receives it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DeveloperTaskViewSchema } from "../../packages/cloud-contracts/src/developer-tasks.js";
import { ProofTableViewSchema } from "@rovara-code/contracts";
import { createCandidateManifest } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import type { PlanDocument, TestProof } from "@rovara-code/contracts";
import { buildProofTable } from "../../packages/broker/src/rovara-code/proof-table.js";
import { proofCheckResults } from "../../packages/broker/src/rovara-code/proof-section.js";
import { proofTableView } from "../../packages/broker/src/rovara-code/proof-view.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { planAnswer, testedPlanDocument, turnPlanIntoMarkdown } from "../support/plan-documents.js";
import { workerTestProof } from "../support/worker-test-proof.js";

const now = "2026-10-27T12:00:00.000Z";
const pullRequestGateway = () => ({
  reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
  getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
  verifyWebhookRepository: vi.fn(async () => true),
});
const passingChecks = (count = 1) => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: Array.from({ length: count }, (_, index) => ({ id: `readiness:${index}`, label: index === 0 ? "npm test" : "retry tests", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 })), extraTry: "not_needed", agentClaim: "success" });

/** A version 2 task taken through planning, approval, build and review, as the pull request test does; `withPlan: false` stops before the plan is approved. */
async function task(options: { testProofFor?: (digest: string) => unknown; withPlan?: boolean; legacyPlan?: boolean; linkedCheck?: boolean } = {}) {
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: pullRequestGateway() } });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const id = String((started.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record().workspaceId;
  harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion: "1.1.0", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const planning = operations().find((item) => item.workflowMode === "PLAN")!;
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(testedPlanDocument(), options.linkedCheck === true ? { checks: { checks: [{ label: "retry tests", cwd: "repo/demo", executable: "npm", args: ["run", "retry"], proves: ["1"] }] } } : {}));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  if (options.legacyPlan === true) turnPlanIntoMarkdown(harness, workspaceId, String(planning.id), "# Plan\n\nRetry the payment once.");
  const built = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  if (options.withPlan === false) return { harness, id, record, built, workspaceId };
  const planArtifact = record().workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!;
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/decision`, { requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: planArtifact.sha256 });
  const implementation = operations().find((item) => item.workflowMode === "IMPLEMENT")!;
  const proofText = options.testProofFor === undefined ? undefined : await options.testProofFor(built.digest);
  if (options.testProofFor !== undefined) await harness.artifact(workspaceId, String(implementation.id), "test-proof.json", typeof proofText === "string" ? proofText : JSON.stringify(proofText));
  await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: built.repositories, workflowCheckCandidateRepositories: built.repositories, checks: passingChecks(record().workflow.checkPolicy?.proposed?.length ? 2 : 1) } });
  return { harness, id, record, built, workspaceId };
}

type Harness = Awaited<ReturnType<typeof task>>["harness"];
async function readTask(harness: Harness, id: string, headers: Record<string, string> = { "x-agentx-task-view": "2" }) {
  const response = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${id}`, undefined, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.task as Record<string, unknown>;
}

describe("the task view's proof table", () => {
  it("is in the full read of a version 2 task whose approved plan has claims: a row for each requirement, with its result", async () => {
    const { harness, id } = await task();
    const view = await readTask(harness, id);
    const proof = ProofTableViewSchema.parse(view["proofTable"]);
    expect(proof.rows.length).toBeGreaterThan(1);
    expect(proof.rows[0]).toMatchObject({ claimId: "1", requirement: "Payments that fail with a timeout are retried.", evidence: [], result: "not_tested" });
    expect(proof.notTested.some((item) => item.kind === "claim" && item.id === "1")).toBe(true);
    expect(DeveloperTaskViewSchema.safeParse(view).success).toBe(true);
  });

  it("carries the test-proof lines of a proof bound to the candidate, and ignores one for other code (the same inputs as the pull request)", async () => {
    const proofItems = async (digest: string) => (await workerTestProof(digest, 0)).json;
    const bound = await task({ testProofFor: proofItems });
    expect((await readTask(bound.harness, bound.id))["proofTable"]).toMatchObject({ testProofLines: ["Test proof: 1 check fails on the original code and passes now"] });
    const other = await task({ testProofFor: () => proofItems("f".repeat(64)) });
    expect(ProofTableViewSchema.parse((await readTask(other.harness, other.id))["proofTable"]).testProofLines).toEqual([]);
  });

  it("shows a requirement as proven, with the test-proof line once, when the test-proof.json the worker wrote (readiness:<index> check ids) has a proves_change verdict for the check that proves it", async () => {
    // Selected checks: required-1 (index 0) and the plan's proposed retry check (index 1); the worker's own code makes the proof.
    const { harness, id } = await task({ linkedCheck: true, testProofFor: async (digest) => (await workerTestProof(digest, 1)).json });
    const proof = ProofTableViewSchema.parse((await readTask(harness, id))["proofTable"]);
    expect(proof.rows[0]).toMatchObject({ claimId: "1", result: "proven", evidence: [{ kind: "check", label: "retry tests", state: "proven" }] });
    expect(proof.testProofLines).toEqual(["Test proof: 1 check fails on the original code and passes now"]);
    const unproven = await task({ linkedCheck: true });
    const plain = ProofTableViewSchema.parse((await readTask(unproven.harness, unproven.id))["proofTable"]);
    expect(plain.rows[0]).toMatchObject({ claimId: "1", result: "passed" });
    expect(plain.testProofLines).toEqual([]);
  });

  it("is absent before the plan is approved, and a client that does not send the version 2 header never receives it", async () => {
    const early = await task({ withPlan: false });
    expect(await readTask(early.harness, early.id)).not.toHaveProperty("proofTable");
    const approved = await task();
    expect(await readTask(approved.harness, approved.id, {})).not.toHaveProperty("proofTable");
    expect(await readTask(approved.harness, approved.id)).toHaveProperty("proofTable");
  });

  it("stays in the view of a blocked task, where a failed requirement matters most", async () => {
    const { harness, id, record } = await task();
    harness.db.set({ ...record(), workflow: { ...record().workflow, state: "BLOCKED", blockReason: "candidate checks failed or have unknown results" } });
    const view = await readTask(harness, id);
    expect((view["workflow"] as { state: string }).state).toBe("BLOCKED");
    expect(ProofTableViewSchema.parse(view["proofTable"]).rows.length).toBeGreaterThan(1);
  });

  it("is the same for a reader who is not the owner (the view the session read gives a project viewer), and carries nothing more than the schema's fields", async () => {
    const { harness, record } = await task({ testProofFor: async (digest) => (await workerTestProof(digest, 0)).json });
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions }, caller);
    const stored = record() as never;
    const owner = await taskView(deps, stored, { events: 0, details: true, actor: "owner" });
    const viewer = await taskView(deps, stored, { events: 0, details: true, actor: "viewer" });
    expect(owner.proofTable).toBeDefined();
    expect(viewer.proofTable).toEqual(owner.proofTable);
    // The viewer's field is exactly the schema's four-part shape; a strict parse accepts it and nothing was added.
    expect(Object.keys(viewer.proofTable!).sort()).toEqual(["notTested", "rows", "testProofLines"]);
    expect(ProofTableViewSchema.safeParse(viewer.proofTable).success).toBe(true);
    expect(viewer.proofTable!.testProofLines).toHaveLength(1);
  });

  it("S3: a reader who is not the owner sees the task's title without an address, and the owner sees it as written", async () => {
    const { harness, record } = await task();
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions }, caller);
    const written = `Reply to omar${String.fromCharCode(64)}example.test`;
    const stored = { ...record(), title: written } as never;
    expect((await taskView(deps, stored, { events: 0, details: false, actor: "owner" })).title).toBe(written);
    expect((await taskView(deps, stored, { events: 0, details: false, actor: "viewer" })).title).toBe("Reply to [email removed]");
  });

  it("S3 (N6): a reader who is not the owner sees the task's events without an email address, and the owner sees them as written", async () => {
    const { harness, record } = await task();
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const base = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions }, caller);
    const written = `could not mail omar${String.fromCharCode(64)}example.test`;
    const deps = { ...base, actions: { ...base.actions, eventsNewestFirst: async () => [{ sequence: 1, type: "error", timestamp: now, payload: { message: written } }] } } as typeof base;
    const owner = await taskView(deps, record() as never, { events: 20, details: false, actor: "owner" });
    const viewer = await taskView(deps, record() as never, { events: 20, details: false, actor: "viewer" });
    expect(JSON.stringify(owner.events)).toContain(written);
    expect(JSON.stringify(viewer.events)).not.toContain(String.fromCharCode(64));
    expect(JSON.stringify(viewer.events)).toContain("[email removed]");
  });

  it("reads the task's operations once for a full read: the table uses the operations the view already holds", async () => {
    const reads = async (options: Parameters<typeof task>[0]) => {
      const { harness, record } = await task(options);
      const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
      const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
      const counts = { operations: 0 };
      const tasks = { ...harness.actions, operations: (...args: Parameters<typeof harness.actions.operations>) => { counts.operations += 1; return harness.actions.operations(...args); } };
      const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: tasks }, caller);
      const view = await taskView(deps, record() as never, { events: 0, details: true, actor: "owner" });
      return { counts, view };
    };
    const without = await reads({ withPlan: false });
    const withProof = await reads({});
    expect(without.view.proofTable).toBeUndefined();
    expect(withProof.view.proofTable).toBeDefined();
    // The table is built from what the view already read: no extra read of the operations.
    expect(withProof.counts.operations).toBe(without.counts.operations);
  });

  it("is absent when the approved plan is a legacy Markdown document, which has no claims", async () => {
    const { harness, id } = await task({ legacyPlan: true });
    expect(await readTask(harness, id)).not.toHaveProperty("proofTable");
  });
});

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const CODE = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const OLD = createCandidateManifest([{ repositoryId: "payments", commitSha: "2".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
const command = { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 };
const plan: PlanDocument = {
  schemaVersion: 1, title: "Retry failed payments", why: [{ text: "Failed payments are dropped.", author: "Priya" }],
  claims: [{ id: "1", text: "Payments that time out are retried & logged @team." }, { id: "2", text: "The retry count is shown." }], notChanging: [], risks: [], decisions: [],
  checks: { proposed: [{ id: "unit", label: "Unit tests", command }], proves: { unit: ["1"] } },
};
const workflowWith = (verificationDigest: string, candidate = CODE) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }), stage: "VERIFY", state: "READY", candidate,
  checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [{ id: "unit", label: "Unit tests", command }] },
  verification: { candidateDigest: verificationDigest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
});

describe("proofTableView", () => {
  it("is the table the pull request gets (same rows, not-tested list and lines), shown as plain text for the page", () => {
    const workflow = workflowWith(CODE.digest);
    const view = proofTableView(workflow, { plan })!;
    const table = buildProofTable({ plan, checkResults: proofCheckResults(workflow), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(view.rows.map((row) => [row.claimId, row.result, row.evidence.map((item) => item.state)])).toEqual(table.rows.map((row) => [row.claimId, row.result, row.evidence.map((item) => item.state)]));
    expect(view.rows.map((row) => row.result)).toEqual(["passed", "not_tested"]);
    expect(view.notTested.map((item) => item.id)).toEqual(table.notTested.map((item) => item.id));
    // The pull request's text is escaped for GitHub (`&amp;`, a joiner after `@`); the page shows plain words.
    expect(view.rows[0]!.requirement).toBe("Payments that time out are retried & logged @team.");
    expect(ProofTableViewSchema.safeParse(view).success).toBe(true);
  });

  it("carries partly_tested through the page's table, and the contract accepts it", () => {
    const partly = { ...plan, claims: [{ id: "1", text: "Retries work.", children: [{ id: "1.1", text: "Waits longer." }, { id: "1.2", text: "Stops at five." }] }], checks: { proposed: [{ id: "unit", label: "Unit tests", command }], proves: { unit: ["1.1"] } } };
    const view = proofTableView(workflowWith(CODE.digest), { plan: partly })!;
    expect(view.rows.map((row) => [row.claimId, row.result])).toEqual([["1", "partly_tested"], ["1.1", "passed"], ["1.2", "not_tested"]]);
    expect(ProofTableViewSchema.safeParse(view).success).toBe(true);
  });

  it("uses the results recorded for earlier code when the candidate has changed since, rather than calling every requirement untested", () => {
    const view = proofTableView(workflowWith(OLD.digest), { plan })!;
    expect(view.rows[0]).toMatchObject({ claimId: "1", result: "passed" });
  });

  it("keeps every string within its contract limit after the page-plain step, even when redacting a tail the first cut made would make it longer", () => {
    // 290 filler characters then a client password flag: the builder cuts the text at 300 characters and leaves "mysql -pabc", which the page's second redaction turns into "mysql -p[REDACTED]" (longer).
    const text = `${"x".repeat(290)} mysql -pabc tail words here and more`;
    const grown = { ...plan, claims: [{ id: "1", text }, { id: "2", text: "The retry count is shown." }], checks: { proposed: [{ id: "unit", label: `${"y".repeat(110)} mysql -pabc more words`, command }], proves: { unit: ["1"] } } };
    const view = proofTableView(workflowWith(CODE.digest), { plan: grown })!;
    const points = (value: string) => Array.from(value).length;
    expect(points(view.rows[0]!.requirement)).toBeLessThanOrEqual(300);
    expect(view.rows[0]!.evidence.every((item) => points(item.label) <= 120)).toBe(true);
    expect(view.notTested.every((item) => points(item.text) <= 300 && points(item.id) <= 64 && points(item.reason) <= 100)).toBe(true);
    expect(ProofTableViewSchema.safeParse(view).success).toBe(true);
    // The same text unchanged would have been over the limit: the cut is what keeps it in.
    expect(points(view.rows[0]!.requirement)).toBe(300);
  });

  it("redacts a secret in a requirement, and is absent without a plan with claims", () => {
    const secret = `token ghp_${"a".repeat(36)}`;
    const view = proofTableView(workflowWith(CODE.digest), { plan: { ...plan, claims: [{ id: "1", text: secret }] } })!;
    expect(JSON.stringify(view)).not.toContain("ghp_");
    expect(proofTableView(workflowWith(CODE.digest), undefined)).toBeUndefined();
    expect(proofTableView(workflowWith(CODE.digest), { plan: { ...plan, claims: [] } })).toBeUndefined();
  });

  it("carries the test-proof lines only for a proof bound to the current candidate", () => {
    const proof = (digest: string): TestProof => ({ schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [{ checkId: "readiness:0", label: "Unit tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }], durationMs: 5 });
    expect(proofTableView(workflowWith(CODE.digest), { plan, testProof: proof(CODE.digest) })!.testProofLines).toHaveLength(1);
    expect(proofTableView(workflowWith(CODE.digest), { plan, testProof: proof(OLD.digest) })!.testProofLines).toEqual([]);
    expect(proofTableView(workflowWith(CODE.digest), { plan, testProof: proof(CODE.digest) })!.rows[0]!.result).toBe("proven");
  });
});
