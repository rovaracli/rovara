import { afterProjectBootstrap } from "../support/transaction-audit.js";
import { fixtureActor } from "../support/money-authority.js";
// Task 17: the Audit Ledger's hooks in Plan 1's own code. A pull request opened (reconcilePullRequest), a pull request
// merged (reconcileTaskPullRequestFeedback) and a budget change (writeBudgets) each add their pending audit item to the
// transaction that records the action, so the action and its audit item commit together or not at all.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_FLUSH_DEADLINE_MS,
  auditEventId,
  auditPullRequestId,
  budgetSyncedKey,
  orgSettingsKey,
  WORKFLOW_BLOCK_REASONS,
  type AuditEventInput,
} from "../../packages/contracts/src/index.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { reconcileTaskPullRequestFeedback } from "../../packages/broker/src/aws/github-webhooks.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { tryAuditEvent } from "../../packages/broker/src/audit/outbox.js";
import { changeBudgets, writeBudgets, readBudgets, type OrgBudgetSettings } from "../../packages/broker/src/org/budget.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { capturingAuditDeps, hangingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { singleOrgIdForEnv } from "../../packages/contracts/src/index.js";

// The first import of the broker module transforms its whole dependency graph, which can pass vitest's 10 s hook default.
beforeAll(loadSlackBroker, 60_000);
afterEach(() => { vi.useRealTimers(); });

const PROXY_URL = "http://internal-proxy.example.test:4000";
const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { name?: string; code?: string; message: string }; }
  throw new Error("expected a rejection");
};

// ---------------------------------------------------------------------------------------------------------------------
// The shared pieces
// ---------------------------------------------------------------------------------------------------------------------

describe("auditPullRequestId", () => {
  it("is one opaque id for one pull request however the repository is spelled, and differs between pull requests", () => {
    const id = auditPullRequestId("Example/Demo", 7);
    expect(id).toMatch(/^pr_[0-9a-f]{32}$/);
    expect(auditPullRequestId("example/demo", 7)).toBe(id);
    expect(auditPullRequestId("example/demo", 8)).not.toBe(id);
    expect(auditPullRequestId("example/other", 7)).not.toBe(id);
    // The repository's name is personal data and never part of an id the chain holds.
    expect(id).not.toContain("demo");
  });
});

describe("tryAuditEvent", () => {
  const event = (): AuditEventInput => ({
    eventId: auditEventId("budget.changed", "x"), orgId: TEST_ORG, action: "budget.changed", actor: { kind: "system", id: "rovara" },
    target: { kind: "budget", id: TEST_ORG }, occurredAt: "2026-10-21T10:00:00.000Z",
  });

  it("builds nothing on an install with no ledger", async () => {
    const build = vi.fn(event);
    expect(await tryAuditEvent({}, build)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it("returns the built event, from a builder or a lookup", async () => {
    const capture = capturingAuditDeps();
    expect(await tryAuditEvent(capture.deps, event)).toEqual(event());
    expect(await tryAuditEvent(capture.deps, async () => event())).toEqual(event());
  });

  it("logs a builder that throws as audit.record_invalid with the error's name only, and lets the action go on", async () => {
    const capture = capturingAuditDeps();
    expect(await tryAuditEvent(capture.deps, () => { throw new RangeError("secret@example.com is not an occurrence"); })).toBeUndefined();
    expect(await tryAuditEvent(capture.deps, async () => { throw new Error("no org for secret@example.com"); })).toBeUndefined();
    expect(capture.logs).toEqual([
      { event: "audit.record_invalid", level: "error", reason: "builder_failed", error: "RangeError" },
      { event: "audit.record_invalid", level: "error", reason: "builder_failed", error: "Error" },
    ]);
    expect(JSON.stringify(capture.logs)).not.toContain("secret@example.com");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// reconcilePullRequest: pull_request.opened
// ---------------------------------------------------------------------------------------------------------------------

describe("a publication callback records pull_request.opened", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
  const user = "U0123456789";
  const PR_URL = "https://github.com/example/demo/pull/7";

  async function harness(capture: AuditCapture, extra: Record<string, unknown> = {}) {
    const { handler, db, brokerInput } = createBroker({ extra: { audit: capture.audit, ...extra } });
    capture.attach(db);
    const reconcile = brokerInput.githubPullRequests.reconcilePullRequest as ReturnType<typeof vi.fn>;
    reconcile.mockResolvedValue({ number: 7, url: PR_URL, reconciled: false });
    await registerSlackProject(handler);
    // M47 requires an independent, durable system bootstrap event. Publication assertions below scope to their action.
    if (extra.orgResolver === undefined) expect(capture.recordedBy("spending.policy_seeded")).toHaveLength(2);
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    return { handler, db, brokerInput, workspaceId, reconcile };
  }
  type Harness = Awaited<ReturnType<typeof harness>>;

  /** Asks for a pull request: the publish operation, and what the worker needs to call back. */
  async function startPublish(h: Harness) {
    const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/pull-requests`, {
      requestId: randomUUID(), repository: "demo", title: "Fix the bug",
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const operationId = (accepted.body.operation as { id: string }).id;
    const invocation = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as {
      callbackCapability: string; payload: { headBranch: string };
    };
    return { operationId, capability: invocation.callbackCapability, headBranch: invocation.payload.headBranch };
  }
  const sendCallback = (h: Harness, start: Awaited<ReturnType<typeof startPublish>>) => call(h.handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${h.workspaceId}/operations/${start.operationId}/pull-request`,
    headers: { "x-agentx-callback-capability": start.capability },
    body: { repository: "demo", repositoryUrl: "https://github.com/example/demo.git", headBranch: start.headBranch, baseBranch: "main", commit: "d".repeat(40), title: "Fix the bug" },
  });
  const pullRequestRecord = (h: Harness) => h.db.get(`WORKSPACE#${h.workspaceId}`, "PULL_REQUEST#demo#000000000007");
  const transactionWithPending = { command: "TransactWriteCommand", match: (input: Record<string, unknown>) => JSON.stringify(input).includes("AUDIT_PENDING#") };

  it("commits the event with the pull request record, then sends it", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    const mark = h.db.commandNames().length;
    const response = await sendCallback(h, start);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(pullRequestRecord(h)).toMatchObject({ number: 7, url: PR_URL, createdByOperationId: start.operationId });
    // The record and its pending item went in one transaction; the flush then sent it and deleted the pending item.
    expect(h.db.commandNames().slice(mark).filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
    const events = capture.recordedBy("pull_request.opened");
    expect(events).toEqual([{
      eventId: auditEventId("pull_request.opened", start.operationId),
      orgId: TEST_ORG,
      action: "pull_request.opened",
      actor: { kind: "member", id: developerIdForSlackUser(user) },
      target: { kind: "pull_request", id: auditPullRequestId("example/demo", 7) },
      occurredAt: expect.any(String) as string,
      facts: { number: 7 },
      details: [{ subject: "org", fields: { repository: "example/demo" } }],
    }]);
    expect(afterProjectBootstrap(capture.flushed())).toEqual(events);
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
  });

  it("keeps the repository's name out of everything but the details", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    capture.queueDown();
    await sendCallback(h, await startPublish(h));
    const { details, ...chainPart } = capture.pending().filter(event => event.action !== "spending.policy_seeded")[0]!;
    expect(details).toBeDefined();
    expect(JSON.stringify(chainPart)).not.toContain("demo");
  });

  it("commits the record and the pending item together or not at all", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    h.db.injectFault({ ...transactionWithPending, error: { name: "InternalServerError" } });
    expect((await sendCallback(h, start)).status).toBeGreaterThanOrEqual(500);
    expect(pullRequestRecord(h)).toBeUndefined();
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
    // The worker's retry of the same callback records both.
    expect((await sendCallback(h, start)).status).toBe(200);
    expect(pullRequestRecord(h)).toBeDefined();
    expect(capture.recordedBy("pull_request.opened")).toHaveLength(1);
  });

  it("R1-1: with SQS failing, the same callback twice succeeds both times and leaves exactly one pending item", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    capture.queueDown();
    expect((await sendCallback(h, start)).status).toBe(200);
    expect((await sendCallback(h, start)).status).toBe(200);
    expect(capture.pendingItems().filter(item => item.event.action !== "spending.policy_seeded")).toHaveLength(1);
    expect(afterProjectBootstrap(capture.flushed())).toEqual([]);
    // The queue comes back: the one pending item is the event, once.
    capture.queueUp();
    expect(capture.recordedBy("pull_request.opened")).toHaveLength(1);
  });

  it("records a replacement's opening in the same transaction as both pull request records", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    const stored = h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${start.operationId}`)!;
    stored.publication = { ...(stored.publication as Record<string, unknown>), mode: "replace", targetPullRequestNumber: 3 };
    h.db.set({
      pk: `WORKSPACE#${h.workspaceId}`, sk: "PULL_REQUEST#demo#000000000003", entityType: "PULL_REQUEST", workspaceId: h.workspaceId,
      repository: "demo", repositoryUrl: "https://github.com/example/demo.git", number: 3, url: "https://github.com/example/demo/pull/3", state: "open",
      headBranch: "old", baseBranch: "main", expectedHeadCommit: "c".repeat(40), title: "Old", body: "", createdByOperationId: randomUUID(), updatedAt: new Date().toISOString(),
    });
    (h.brokerInput.githubPullRequests.updatePullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 3, url: "https://github.com/example/demo/pull/3", state: "closed" });
    h.db.injectFault({ ...transactionWithPending, error: { name: "InternalServerError" } });
    expect((await sendCallback(h, start)).status).toBeGreaterThanOrEqual(500);
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, "PULL_REQUEST#demo#000000000003")).toMatchObject({ state: "open" });
    expect((await sendCallback(h, start)).status).toBe(200);
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, "PULL_REQUEST#demo#000000000003")).toMatchObject({ state: "closed", replacedBy: 7 });
    expect(capture.recordedBy("pull_request.opened")).toHaveLength(1);
  });

  it("answers as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    vi.useFakeTimers();
    const pending = sendCallback(h, start);
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ number: 7, url: PR_URL });
    expect(pullRequestRecord(h)).toBeDefined();
    // Nothing reached the queue; the event waits for the drain.
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.action)).toEqual(["pull_request.opened"]);
  });

  it("opens the pull request without an event when the workspace's org cannot be found, and says so without a value", async () => {
    const capture = capturingAuditDeps();
    let resolveOrg: () => Promise<string | undefined> = async () => TEST_ORG;
    const h = await harness(capture, { orgResolver: () => resolveOrg() });
    const start = await startPublish(h);
    const workspace = h.db.get(`WORKSPACE#${h.workspaceId}`, "META")!;
    delete workspace.orgId;
    resolveOrg = async () => undefined;
    const response = await sendCallback(h, start);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(pullRequestRecord(h)).toBeDefined();
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
    expect(capture.logs).toEqual([expect.objectContaining({ event: "audit.record_invalid", reason: "builder_failed" })]);
  });

  it("opens the pull request without an event when the audit's own read of the earlier record fails, and logs the error's name only", async () => {
    const capture = capturingAuditDeps();
    const h = await harness(capture);
    const start = await startPublish(h);
    h.db.injectFault({ command: "GetCommand", match: (input) => String((input.Key as { sk?: string } | undefined)?.sk).startsWith("PULL_REQUEST#demo#000000000007"), error: { name: "InternalServerError", message: "secret@example.com" } });
    const response = await sendCallback(h, start);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(pullRequestRecord(h)).toBeDefined();
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
    expect(capture.logs).toEqual([{ event: "audit.record_invalid", level: "error", reason: "builder_failed", error: "InternalServerError" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// reconcileTaskPullRequestFeedback: pull_request.merged
// ---------------------------------------------------------------------------------------------------------------------

describe("a merge the webhook finds records pull_request.merged", () => {
  const PR_URL = "https://github.com/example/demo/pull/42";
  const TREE = "b".repeat(40);
  const HEAD = "d".repeat(40);
  const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
  type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

  /** GitHub as the broker sees it: the pull request is open on the checked tree until a test merges it. */
  function gateway() {
    const state = { pr: "open" as "open" | "merged" };
    const pullRequest = (number: number) => ({ number, url: PR_URL, state: state.pr, headBranch: "x", baseBranch: "main", headCommit: HEAD, title: "t", body: "", headTreeSha: TREE });
    return {
      state,
      reconcilePullRequest: vi.fn(async () => ({ number: 42, url: PR_URL, reconciled: false })),
      getCommitTree: vi.fn(async () => TREE), getBranchHead: vi.fn(async () => HEAD), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
      getPullRequest: vi.fn(async (_url: string, number: number) => pullRequest(number)),
      updatePullRequest: vi.fn(async () => ({ ...pullRequest(42), state: "closed" as const })),
      verifyWebhookRepository: vi.fn(async () => true),
      getPullRequestFeedback: vi.fn(async (_url: string, number: number) => ({ pullRequest: pullRequest(number), comments: [], threads: [] })),
      getPullRequestMergeObservation: vi.fn(async (_url: string, number: number) => pullRequest(number)),
    };
  }

  const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

  /** A workflow task whose draft pull request #42 is open and waiting for its merge. */
  async function waitingForMerge(capture: AuditCapture) {
    const gh = gateway();
    const h = await createSingleAnswerPlanBroker({ audit: capture, brokerExtra: { githubPullRequests: gh } });
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
    const workspaceId = record.workspaceId;
    h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const planning = operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!;
    const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
    await finishPlanningWithMarkdown(h, workspaceId, String(planning.id), plan);
    const workflow = () => (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow;
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow().revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    const implementation = operations(h, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: HEAD, treeSha: TREE, baseCommitSha: "e".repeat(40) }]);
    const checks = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
    await h.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks } });
    const review = operations(h, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
    const now = new Date().toISOString();
    await h.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: review.id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
    const publish = operations(h, workspaceId).find((item) => item.kind === "publish") as { id: string; publication: { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body?: string } };
    const p = publish.publication;
    await h.callback(workspaceId, publish.id, "pull-request", { repository: p.repository, repositoryUrl: p.repositoryUrl, headBranch: p.headBranch, baseBranch: p.baseBranch, commit: HEAD, title: p.title, ...(p.body === undefined ? {} : { body: p.body }) });
    await h.finish(workspaceId, publish.id, "SUCCEEDED", { result: { repository: "demo", number: 42, url: PR_URL, headBranch: p.headBranch, baseBranch: "main", commit: HEAD, checks: [], reconciled: false } });
    expect(workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE" });
    return { h, gh, taskId, workspaceId };
  }

  const deliver = async (h: Harness, action = "closed", options?: Record<string, unknown>) => (await import("../../packages/broker/src/aws/broker.js")).processGithubWorkflowEvent(
    h.brokerInput as never, { kind: "PULL_REQUEST", action, installationId: 1, repositoryId: 1, fullName: "example/demo", number: 42 }, randomUUID(), options as never);
  const taskState = (h: Harness, taskId: string) => (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { stage: string; state: string; pullRequests: Array<{ state: string }> } }).workflow;

  it("commits the event with the task's move to MERGED, once, however often the merge is delivered", async () => {
    const capture = capturingAuditDeps();
    const { h, gh, taskId } = await waitingForMerge(capture);
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).not.toContainEqual(expect.objectContaining({ action: "pull_request.merged" }));
    gh.state.pr = "merged";
    await deliver(h);
    expect(taskState(h, taskId)).toMatchObject({ stage: "MERGED", state: "COMPLETE", pullRequests: [{ state: "MERGED" }] });
    await deliver(h);
    await deliver(h, "closed");
    expect(capture.recordedBy("pull_request.merged")).toEqual([{
      eventId: auditEventId("pull_request.merged", auditOccurrence("example/demo", "42")),
      orgId: TEST_ORG,
      action: "pull_request.merged",
      actor: { kind: "system", id: "rovara" },
      target: { kind: "pull_request", id: auditPullRequestId("example/demo", 42) },
      occurredAt: expect.any(String) as string,
      facts: { number: 42 },
      details: [{ subject: "org", fields: { repository: "example/demo" } }],
    }]);
    // Opened and merged name one pull request by one id.
    expect(afterProjectBootstrap(capture.flushed())).toHaveLength(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded").length);
  });

  it("records the opening and the merge of one pull request under one target id", async () => {
    const capture = capturingAuditDeps();
    const { h, gh } = await waitingForMerge(capture);
    gh.state.pr = "merged";
    await deliver(h);
    const ids = new Set(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded").filter((event) => event.action === "pull_request.merged").map((event) => JSON.stringify(event.target)));
    expect([...ids]).toEqual([JSON.stringify({ kind: "pull_request", id: auditPullRequestId("example/demo", 42) })]);
  });

  it("records the same event when the merge is found by the bounded merge polling", async () => {
    const capture = capturingAuditDeps();
    const { h, gh } = await waitingForMerge(capture);
    gh.state.pr = "merged";
    await deliver(h, "closed", { observationMode: "merge", budget: { remaining: 10 }, release: "queue" });
    expect(capture.recordedBy("pull_request.merged")).toHaveLength(1);
  });

  it("records nothing for a pull request that is still open", async () => {
    const capture = capturingAuditDeps();
    const { h } = await waitingForMerge(capture);
    await deliver(h, "synchronize");
    expect(capture.recordedBy("pull_request.merged")).toEqual([]);
  });

  it("commits the task update and the pending item together or not at all, and the retry records one event", async () => {
    const capture = capturingAuditDeps();
    const { h, gh, taskId } = await waitingForMerge(capture);
    gh.state.pr = "merged";
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    // A cancelled transaction is a lost race to the task's revision: the delivery reads the task again and tries once more.
    await deliver(h);
    expect(taskState(h, taskId)).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(capture.recordedBy("pull_request.merged")).toHaveLength(1);
  });

  it("with SQS failing, leaves the event as a pending item and still completes the task", async () => {
    const capture = capturingAuditDeps();
    const { h, gh, taskId } = await waitingForMerge(capture);
    capture.queueDown();
    gh.state.pr = "merged";
    await deliver(h);
    expect(taskState(h, taskId)).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.action)).toEqual(expect.arrayContaining(["pull_request.merged"]));
  });

  it("completes the task as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const { h, gh, taskId } = await waitingForMerge(capture);
    gh.state.pr = "merged";
    vi.useFakeTimers();
    const delivered = deliver(h);
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    await delivered;
    expect(taskState(h, taskId)).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.action)).toEqual(expect.arrayContaining(["pull_request.merged"]));
  });
});

describe("a task with several pull requests records each merge once", () => {
  it("records the merge of each pull request when it happens, and never again for one already merged", async () => {
    const capture = capturingAuditDeps();
    // The queue stays down, so every pending item written stays: a duplicate event would show as a second item.
    capture.queueDown();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const taskId = "550e8400-e29b-41d4-a716-446655440012";
    const now = "2026-10-05T12:00:00.000Z";
    // Each delivery is a later moment, as in production: a repeated event would be a second item, not an overwrite.
    let delivery = 0;
    const repositories = ["api", "ui"];
    const candidate = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) })));
    let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING",
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: repositories.map((repositoryId, index) => ({ repositoryId, number: index + 1, url: `https://github.com/acme/${repositoryId}/pull/${String(index + 1)}`, headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" })),
    });
    const rows = new Map(repositories.map((repositoryId, index) => [`GITHUB_PR#acme/${repositoryId}`, {
      entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${repositoryId}`, repositoryId, number: index + 1,
      url: `https://github.com/acme/${repositoryId}/pull/${String(index + 1)}`, taskId, workspaceId: "workspace", candidateDigest: candidate.digest,
    }]));
    const remote = new Map<number, "open" | "merged">([[1, "open"], [2, "open"]]);
    let revision = 0;
    const reconcile = (fullName: string, number: number) => reconcileTaskPullRequestFeedback({
      documentClient: { send: async (command: unknown) => ({ Item: rows.get(String(((command as { input: { Key: { pk: string } } }).input.Key).pk)) }) },
      tableName: "state", repositoryFullName: fullName, number, deliveryId: randomUUID(), observationMode: "merge", now: new Date(Date.parse(now) + (delivery += 1) * 1000).toISOString(),
      loadTask: async () => ({ project: "fixture", startingRevision: 1, orgId: TEST_ORG, workflow }),
      repositoryUrl: async (_project: string, _revision: number, repositoryId: string) => `https://github.com/acme/${repositoryId}.git`,
      getCurrentFeedback: async (_url: string, prNumber: number) => ({
        pullRequest: { number: prNumber, url: `https://github.com/acme/${prNumber === 1 ? "api" : "ui"}/pull/${String(prNumber)}`, state: remote.get(prNumber)!, headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), headTreeSha: "b".repeat(40), title: "t", body: "" },
        comments: [], threads: [],
      }),
      persistBundle: async () => { throw new Error("no feedback is collected on a merge poll"); },
      saveWorkflow: async (_taskId, expectedRevision, next, extraItems = []) => {
        if (expectedRevision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
        revision += 1;
        await db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "TASK", sk: "META", revision } } }, ...extraItems] }));
        workflow = next;
      },
      audit: capture.audit,
    });
    const mergedNumbers = () => capture.pending().filter(event => event.action !== "spending.policy_seeded").filter((event) => event.action === "pull_request.merged").map((event) => event.facts?.number);

    remote.set(1, "merged");
    expect(await reconcile("acme/api", 1)).toBe(true);
    expect(mergedNumbers()).toEqual([1]);
    expect(workflow.stage).not.toBe("MERGED");
    // The same merge delivered again changes nothing and records nothing.
    expect(await reconcile("acme/api", 1)).toBe(false);
    expect(mergedNumbers()).toEqual([1]);
    remote.set(2, "merged");
    expect(await reconcile("acme/ui", 2)).toBe(true);
    expect(workflow.stage).toBe("MERGED");
    // The second merge records its own event only; the first is not recorded again.
    expect(mergedNumbers()).toEqual([1, 2]);
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.target)).toEqual([
      { kind: "pull_request", id: auditPullRequestId("acme/api", 1) }, { kind: "pull_request", id: auditPullRequestId("acme/ui", 2) },
    ]);
  });
});

describe("a save that records landed fix pushes and merges together", () => {
  const COUNT = 32;
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const T1 = "3".repeat(40);
  const T2 = "4".repeat(40);
  const repositories = Array.from({ length: COUNT }, (_, index) => index === 0 ? "demo" : `repo${String(index).padStart(2, "0")}`);
  // The first half were merged by GitHub at the fix's head; the second half show the fix's push, which was taken for failed.
  const mergedCount = COUNT / 2;
  const isMerged = (index: number) => index < mergedCount;

  async function blockedAfterPush(capture: AuditCapture) {
    const now = "2026-10-05T12:00:00.000Z";
    const taskId = "550e8400-e29b-41d4-a716-446655440012";
    const workspaceId = "550e8400-e29b-41d4-a716-446655440013";
    const gateway = {
      getPullRequestFeedback: vi.fn(async (url: string, number: number) => ({
        pullRequest: { number, url: `${url.replace(/\.git$/, "")}/pull/${String(number)}`, state: isMerged(number - 1) ? "merged" as const : "open" as const,
          headBranch: "feature", baseBranch: "main", headCommit: H2, headTreeSha: T2, title: "t", body: "" },
        comments: [], threads: [],
      })),
      getCommitParents: vi.fn(async () => [H1]),
    };
    const h = await createSingleAnswerPlanBroker({ audit: capture, register: false, brokerExtra: { githubPullRequests: gateway } });
    await registerSlackProject(h.handler, { extraRepositories: repositories.slice(1).map((name) => ({ name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app" })) });
    const first = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: H1, treeSha: T1 })));
    const fix = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: H2, treeSha: T2 })));
    const url = (index: number) => `https://github.com/example/${repositories[index]!}/pull/${String(index + 1)}`;
    const workflow = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), candidate: fix, stage: "WAIT_FOR_MERGE", state: "BLOCKED",
      blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed, pullRequestUpdateFailure: { numbers: repositories.map((_, index) => index + 1), cause: "PUSH_REFUSED" },
      verification: { candidateDigest: fix.digest, producer: "broker", environmentId: "fixture", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: taskId, candidateDigest: fix.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: repositories.map((repositoryId, index) => ({ repositoryId, number: index + 1, url: url(index), headSha: H1, headTreeSha: T1, candidateDigest: first.digest, required: true, state: "OPEN" })),
    });
    h.db.set({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, project: "payments", startingRevision: 1, workspaceId, ownerKey: "owner", developerId: MAYA.developerId, workflow });
    repositories.forEach((repositoryId, index) => {
      h.db.set({ ...githubWorkflowPullRequestKey(`example/${repositoryId}`, index + 1), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `example/${repositoryId}`, repositoryId,
        number: index + 1, url: url(index), taskId, workspaceId, candidateDigest: first.digest, createdAt: now });
      h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#${repositoryId}#${String(index + 1).padStart(12, "0")}`, entityType: "PULL_REQUEST", workspaceId, repository: repositoryId,
        repositoryUrl: `https://github.com/example/${repositoryId}.git`, number: index + 1, url: url(index), state: "open", expectedHeadCommit: H1, updatedAt: now });
    });
    // What the transactions carry, as sent.
    const transactions: Array<Array<{ Put?: { Item: Record<string, unknown> } }>> = [];
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") transactions.push((command as unknown as { input: { TransactItems: Array<{ Put?: { Item: Record<string, unknown> } }> } }).input.TransactItems);
      return send(command);
    };
    // No developer configuration: nothing starts a feedback review after the reconcile.
    const dependencies = { ...h.brokerInput, developer: undefined };
    const deliver = async () => (await import("../../packages/broker/src/aws/broker.js")).processGithubWorkflowEvent(dependencies as never,
      { kind: "PULL_REQUEST", action: "synchronize", installationId: 1, repositoryId: 1, fullName: "example/demo", number: 1 }, randomUUID());
    const saved = () => (h.db.get(taskKey(taskId)) as { workflow: { stage: string; state: string; candidate: { digest: string }; pullRequests: Array<{ state: string; candidateDigest: string }> } }).workflow;
    const pendingIn = (transaction: Array<{ Put?: { Item: Record<string, unknown> } }>) => transaction.filter((item) => String(item.Put?.Item.pk).startsWith("AUDIT_PENDING#"));
    return { h, deliver, saved, transactions, pendingIn, fix };
  }

  it("commits the fix pushes, the task update and the merge events in one transaction within the item limit", async () => {
    const capture = capturingAuditDeps();
    capture.queueDown();
    const { deliver, saved, transactions, pendingIn, fix } = await blockedAfterPush(capture);
    await deliver();
    expect(saved()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(saved().pullRequests.filter((pr) => pr.state === "MERGED")).toHaveLength(mergedCount);
    expect(saved().pullRequests.every((pr) => pr.candidateDigest === fix.digest)).toBe(true);
    const landed = transactions.filter((transaction) => transaction.length > 1);
    expect(landed).toHaveLength(1);
    // The task update, a link update and a record update for each landed push, one pending item for each merge, and the project's merged count (one item, however many merged).
    expect(landed[0]).toHaveLength(1 + 2 * (COUNT - mergedCount) + mergedCount + 1);
    expect(landed[0]!.length).toBeLessThanOrEqual(100);
    expect(pendingIn(landed[0]!)).toHaveLength(mergedCount);
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.action)).toEqual(Array(mergedCount).fill("pull_request.merged"));
    expect(new Set(capture.pending().filter(event => event.action !== "spending.policy_seeded").map((event) => event.eventId)).size).toBe(mergedCount);
  });

  it("commits them together or not at all: a cancelled transaction leaves no event, and the retry records each merge once", async () => {
    const capture = capturingAuditDeps();
    capture.queueDown();
    const { h, deliver, saved } = await blockedAfterPush(capture);
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] } });
    await deliver();
    expect(saved()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(afterProjectBootstrap(capture.pending())).toHaveLength(mergedCount);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// writeBudgets: budget.changed
// ---------------------------------------------------------------------------------------------------------------------

describe("a budget change records budget.changed in writeBudgets' transaction", () => {
  const AT = "2026-10-21T10:00:00.000Z";
  const MAYA_ID = MAYA.developerId;
  const OMAR_ID = OMAR.developerId;

  function setup(options: { cloud?: boolean; capture?: AuditCapture } = {}) {
    const db = new FakeDynamoDb();
    const capture = options.capture ?? capturingAuditDeps();
    capture.attach(db);
    const deps = { documentClient: db, tableName: "state", access: fakeModelAccess(), audit: capture.audit, ...(options.cloud === true ? { cloud: true } : {}) };
    const stored = () => db.get(orgSettingsKey(TEST_ORG, "BUDGET"));
    return { db, capture, deps, stored };
  }
  const settings = (orgMonthlyUsd: number | undefined, memberDefaultMonthlyUsd: number | undefined, memberOverrides: Record<string, number> = {}): OrgBudgetSettings => ({
    ...(orgMonthlyUsd === undefined ? {} : { orgMonthlyUsd }), ...(memberDefaultMonthlyUsd === undefined ? {} : { memberDefaultMonthlyUsd }), memberOverrides,
  });
  const facts = (events: AuditEventInput[]) => events.map((event) => event.facts);

  it("records a change of the org's limit from 500 to 800 with the old and new figures in cents", async () => {
    const { db, capture, deps } = setup();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: {} });
    await writeBudgets(deps, TEST_ORG, settings(800, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(capture.recordedBy("budget.changed")).toEqual([{
      eventId: auditEventId("budget.changed", auditOccurrence("1", AT, MAYA_ID, "org_monthly_limit", TEST_ORG)),
      orgId: TEST_ORG,
      action: "budget.changed",
      actor: { kind: "member", id: MAYA_ID },
      target: { kind: "budget", id: TEST_ORG },
      occurredAt: AT,
      facts: { scopeKind: "org", field: "org_monthly_limit", fromCents: 50000, toCents: 80000 },
    }]);
  });

  it("reads the cloud install's placeholder limits as the old figures of an org that never set any", async () => {
    const { capture, deps, stored } = setup({ cloud: true });
    await writeBudgets(deps, TEST_ORG, settings(800, 40), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(facts(capture.recordedBy("budget.changed"))).toEqual([
      { scopeKind: "org", field: "org_monthly_limit", fromCents: 50000, toCents: 80000 },
      { scopeKind: "org", field: "member_default_limit", fromCents: 2900, toCents: 4000 },
    ]);
    expect(stored()).toMatchObject({ orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40 });
  });

  it("leaves out the figure of a limit that was or becomes unset", async () => {
    const { capture, deps } = setup();
    await writeBudgets(deps, TEST_ORG, settings(1000, undefined), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    await writeBudgets(deps, TEST_ORG, settings(undefined, undefined), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, "2026-10-21T11:00:00.000Z", { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(facts(capture.recordedBy("budget.changed"))).toEqual([
      { scopeKind: "org", field: "org_monthly_limit", toCents: 100000 },
      { scopeKind: "org", field: "org_monthly_limit", fromCents: 100000 },
    ]);
  });

  it("records one event for each limit that changed, a member's included, and none for one that did not", async () => {
    const { db, capture, deps } = setup();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: { [MAYA_ID]: 100 } });
    await writeBudgets(deps, TEST_ORG, settings(500, 29, { [OMAR_ID]: 2000 }), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    const events = capture.recordedBy("budget.changed");
    // Maya's override went away (she is back on the default $29), Omar's was added (from the default).
    expect(events.map((event) => ({ target: event.target, related: event.related, facts: event.facts }))).toEqual(expect.arrayContaining([
      { target: { kind: "budget", id: MAYA_ID }, related: [MAYA_ID], facts: { scopeKind: "member", field: "member_monthly_limit", fromCents: 10000, toCents: 2900 } },
      { target: { kind: "budget", id: OMAR_ID }, related: [OMAR_ID], facts: { scopeKind: "member", field: "member_monthly_limit", fromCents: 2900, toCents: 200000 } },
    ]));
    expect(events).toHaveLength(2);
    // Every event of the change has its own id.
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records nothing when nothing changed", async () => {
    const { db, capture, deps } = setup();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: {} });
    await writeBudgets(deps, TEST_ORG, settings(500, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
  });

  it("commits the settings and the pending items in one transaction", async () => {
    const { db, capture, deps, stored } = setup();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: {} });
    const mark = db.commandNames().length;
    await writeBudgets(deps, TEST_ORG, settings(800, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(db.commandNames().slice(mark).filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
    expect(stored()).toMatchObject({ orgMonthlyUsd: 800 });
    // A cancelled transaction changes neither.
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    capture.queueDown();
    const before = capture.pendingItems().length;
    await rejection(writeBudgets(deps, TEST_ORG, settings(900, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, "2026-10-21T12:00:00.000Z", { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) }));
    expect(stored()).toMatchObject({ orgMonthlyUsd: 800 });
    expect(capture.pendingItems()).toHaveLength(before);
  });

  it("classifies a lost settings condition as a reloadable revision conflict", async () => {
    const { db, deps } = setup();
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    const error = await rejection(writeBudgets(deps, TEST_ORG, settings(800, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) }));
    expect(error.code).toBe("CHANGE_STALE");
  });

  it("keeps the revision and actor transaction on an install with no ledger", async () => {
    const db = new FakeDynamoDb();
    const mark = db.commandNames().length;
    await writeBudgets({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, settings(800, 29), fixtureActor({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, MAYA_ID, true) });
    expect(db.commandNames().slice(mark)).toEqual(["GetCommand", "TransactWriteCommand"]);
    expect(await readBudgets({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG)).toMatchObject({ orgMonthlyUsd: 800 });
  });

  it("answers as today when the intake queue never answers", async () => {
    vi.useFakeTimers();
    const capture = hangingAuditDeps();
    const { db, deps, stored } = setup({ capture });
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: {} });
    const written = writeBudgets(deps, TEST_ORG, settings(800, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    await written;
    expect(stored()).toMatchObject({ orgMonthlyUsd: 800 });
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded")).toHaveLength(1);
  });

  it("records no event for a member limit set to, or put back to, the default figure", async () => {
    const { db, capture, deps } = setup();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: { [OMAR_ID]: 29 } });
    // Maya gets an override equal to the default; Omar's override equal to the default goes away: neither limit moves.
    await writeBudgets(deps, TEST_ORG, settings(500, 29, { [MAYA_ID]: 29 }), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
    // An override that does move the figure still records, to and from the default.
    await writeBudgets(deps, TEST_ORG, settings(500, 29, { [MAYA_ID]: 50 }), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, "2026-10-21T11:00:00.000Z", { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    await writeBudgets(deps, TEST_ORG, settings(500, 29), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, "2026-10-21T12:00:00.000Z", { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
    expect(facts(capture.recordedBy("budget.changed"))).toEqual([
      { scopeKind: "member", field: "member_monthly_limit", fromCents: 2900, toCents: 5000 },
      { scopeKind: "member", field: "member_monthly_limit", fromCents: 5000, toCents: 2900 },
    ]);
  });

  describe("a change that would record more events than one transaction holds is refused", () => {
    const overrides = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`dev${String(index).padStart(3, "0")}`, 100 + index]));

    it("commits a change of exactly 96 events with all of them", async () => {
      const { db, capture, deps, stored } = setup();
      capture.queueDown();
      const mark = db.commandNames().length;
      await writeBudgets(deps, TEST_ORG, settings(undefined, undefined, overrides(96)), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
      expect(Object.keys(stored()!.memberOverrides as object)).toHaveLength(96);
      expect(capture.pendingItems()).toHaveLength(96);
      expect(db.commandNames().slice(mark).filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
    });

    it("counts events and not overrides: an org limit and 95 overrides are 96 events", async () => {
      const { capture, deps } = setup();
      capture.queueDown();
      await writeBudgets(deps, TEST_ORG, settings(1000, undefined, overrides(95)), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
      expect(capture.pendingItems()).toHaveLength(96);
    });

    it("refuses 97 events with CONFIG_INVALID, writing and recording nothing, and names no value", async () => {
      const { capture, deps, stored } = setup();
      capture.queueDown();
      const error = await rejection(writeBudgets(deps, TEST_ORG, settings(undefined, undefined, overrides(97)), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) }));
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain("dev0");
      expect(stored()).toBeUndefined();
      expect(capture.pendingItems()).toEqual([]);
      expect(capture.logs).toEqual([]);
      // 1 org limit and 96 overrides are 97 events too.
      expect((await rejection(writeBudgets(deps, TEST_ORG, settings(1000, undefined, overrides(96)), fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) }))).code).toBe("CONFIG_INVALID");
      expect(stored()).toBeUndefined();
    });

    it("lets a change of any size through on an install with no ledger", async () => {
      const db = new FakeDynamoDb();
      await writeBudgets({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, settings(undefined, undefined, overrides(150)), fixtureActor({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, MAYA_ID, true).developerId, AT, { actor: { kind: "member", id: MAYA_ID }, ...({}), authority: fixtureActor({ documentClient: db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, MAYA_ID, true) });
      expect(Object.keys(db.get(orgSettingsKey(TEST_ORG, "BUDGET"))!.memberOverrides as object)).toHaveLength(150);
    });

    it("refuses in changeBudgets before the settings are written or the proxy is told", async () => {
      const { db, capture, stored } = setup();
      const access = fakeModelAccess();
      const orgs = { orgForDeveloper: async () => ({ orgId: TEST_ORG }), getOrg: async () => ({ plan: "team" }) };
      const deps = { documentClient: db, tableName: "state", access, audit: capture.audit, orgs } as unknown as Parameters<typeof changeBudgets>[0];
      const refused = await rejection(changeBudgets(deps, { ...({ orgId: TEST_ORG, body: { requestId: randomUUID(), memberOverrides: overrides(97) }, updatedBy: MAYA_ID, at: AT }), updatedBy: fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) }));
      expect(refused.code).toBe("CONFIG_INVALID");
      expect(refused.message).not.toContain("dev0");
      expect(stored()).toBeUndefined();
      expect(access.upsertOrg).not.toHaveBeenCalled();
      expect(access.upsertMember).not.toHaveBeenCalled();
      expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
      // 96 is changed as usual.
      await changeBudgets(deps, { ...({ orgId: TEST_ORG, body: { requestId: randomUUID(), memberOverrides: overrides(96) }, updatedBy: MAYA_ID, at: AT }), updatedBy: fixtureActor(deps, TEST_ORG, MAYA_ID, true).developerId, authority: fixtureActor(deps, TEST_ORG, MAYA_ID, true) });
      expect(capture.recordedBy("budget.changed")).toHaveLength(96);
    });
  });
});

describe("the budget routes record the change", () => {
  it("PUT /v1/dev/org/budget by an admin records budget.changed from 500 to 800 with the admin as actor", async () => {
    const capture = capturingAuditDeps();
    const access = fakeModelAccess();
    const h = await createSingleAnswerPlanBroker({ audit: capture, brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    const response = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), orgMonthlyUsd: 800 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(capture.recordedBy("budget.changed")).toEqual([expect.objectContaining({
      orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId }, target: { kind: "budget", id: TEST_ORG },
      facts: { scopeKind: "org", field: "org_monthly_limit", fromCents: 50000, toCents: 80000 },
    })]);
    expect(h.db.get(budgetSyncedKey(TEST_ORG))).toMatchObject({ limitUsd: 800 });
    // The event was sent, so no pending item is left.
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
  });

  it("refuses a member before any event is made", async () => {
    const capture = capturingAuditDeps();
    const access = fakeModelAccess();
    const h = await createSingleAnswerPlanBroker({ audit: capture, brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    expect((await h.dev(OMAR, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), orgMonthlyUsd: 10 })).status).toBe(403);
    expect(afterProjectBootstrap(capture.recorded()).filter(event => event.action !== "spending.policy_seeded")).toEqual([]);
  });

  it("PUT /v1/admin/org/budget by an operator records the change under the operator's pseudonymous id, never their subject", async () => {
    const capture = capturingAuditDeps();
    const access = fakeModelAccess();
    const { handler, db } = await createAdminBroker({ extra: { audit: capture.audit, modelAccess: { access, proxyUrl: PROXY_URL } } });
    capture.attach(db);
    const response = await adminCall(handler, { method: "PUT", path: "/v1/admin/org/budget", body: { requestId: randomUUID(), orgMonthlyUsd: 2000, memberDefaultMonthlyUsd: 150 }, admin: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const events = capture.recordedBy("budget.changed");
    expect(events.map((event) => event.facts)).toEqual([
      { scopeKind: "org", field: "org_monthly_limit", toCents: 200000 },
      { scopeKind: "org", field: "member_default_limit", toCents: 15000 },
    ]);
    const actor = events[0]!.actor;
    expect(actor).toEqual({ kind: "operator", id: expect.stringMatching(/^op_[0-9a-f]{24}$/) as string });
    expect(events.every((event) => event.orgId === singleOrgIdForEnv(TEST_ENV))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("admin-subject");
  });

  it("answers the admin route as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const access = fakeModelAccess();
    const { handler, db } = await createAdminBroker({ extra: { audit: capture.audit, modelAccess: { access, proxyUrl: PROXY_URL } } });
    capture.attach(db);
    vi.useFakeTimers();
    const answered = adminCall(handler, { method: "PUT", path: "/v1/admin/org/budget", body: { requestId: randomUUID(), orgMonthlyUsd: 2000 }, admin: true });
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    expect((await answered).status).toBe(200);
    expect(db.get(orgSettingsKey(singleOrgIdForEnv(TEST_ENV), "BUDGET"))).toMatchObject({ orgMonthlyUsd: 2000 });
    expect(capture.pending().filter(event => event.action !== "spending.policy_seeded")).toHaveLength(1);
  });
});
