// S2 (register SB-2 and F27-5): the CI-fix Retry, forward onto a coding step, a custom sequence's automatic next coding step and the PR-feedback critic run (every finding accepted, the sequence's next step is coding) start agent work for a person, so they meet the
// send-back access gate (`requireProjectSendBackRole`): a member with no project access, a viewer, an archived project and another company are refused; an allowed person still goes on.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, agentXError, resolveWorkflowReviewFindings, retryWorkflowFeedbackReview, ciFixAskMessage, createCandidateManifest, orgMemberKey, orgRemovedKey, projectMetaKey, type WorkflowSnapshot } from "@agentx/contracts";
import { resolveTaskWorkflowFindings, retryTaskWorkflowFeedbackReview, startTaskWorkflowFeedbackReviewFromWebhook, startTaskWorkflowImplementationFromSystem, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { retryTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/workflow-retry.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { sendBackNoAccessMessage } from "../../packages/broker/src/developer/task-access.js";
import { viewerCannotStartTasksMessage } from "../../packages/broker/src/developer/project-roles.js";
import { openReviewFindings } from "../../packages/contracts/src/task-workflow-node.js";
import { MAYA, createDeveloperTaskBroker, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { seedReview } from "../support/rovara-code-feedback.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";
import { TEST_ORG } from "../support/orgs.js";

type CheckAccess = DeveloperTaskRouteDependencies["checkAccess"];
const grantedAs = (role: "maintainer" | "contributor" | "viewer"): CheckAccess => async () => ({ revision: 1, policy: {} as never, access: "granted", channelIds: [], role });
const denied: CheckAccess = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "no access"); };
const OWNER: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
const OTHER_ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const NOW = "2026-10-25T12:00:00.000Z";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const PR = { repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/example/demo/pull/7" };
const archive = (db: { set(item: Record<string, unknown>): void }) => db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: NOW, createdBy: "x" });
const removeMaya = (db: { set(item: Record<string, unknown>): void; delete(key: { pk: string; sk: string }): void }) => {
  db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
  db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() });
};

/** The refusal is PROJECT_ACCESS_DENIED and carries the send-back gate's words (it may add a hint after them). */
async function expectRefused(promise: Promise<unknown>, text: string): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught) as { code?: string; message?: string } | undefined;
  expect(error?.code).toBe("PROJECT_ACCESS_DENIED");
  expect(error?.message).toContain(text);
}

const routeDeps = (harness: { db: never; actions: never }, checkAccess: CheckAccess, audit?: ReturnType<typeof capturingAuditDeps>): DeveloperTaskRouteDependencies => ({
  documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions, orgId: TEST_ORG, checkAccess,
  projectChannelIds: async () => [], now: () => Date.now(), log: () => undefined, ...(audit === undefined ? {} : { learningAudit: audit.audit }),
});

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const meta = (h: Harness, taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string };
const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

describe("the CI-fix Retry meets the send-back gate", () => {
  /** A real task with its planning cancelled, put where tracking leaves it when Rovara was set to suggest and CI is red: waiting for the merge, blocked with the CI-fix ask. */
  async function blocked() {
    const h = await createDeveloperTaskBroker({});
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = meta(h, taskId).workspaceId;
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), "CANCELLED");
    const waiting = WorkflowSnapshotSchema.parse({
      ...meta(h, taskId).workflow, revision: 30, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: ciFixAskMessage("test"), candidate,
      reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: NOW, results: [], reviewOnly: true },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
      pullRequests: [PR],
    });
    h.db.set({ ...meta(h, taskId), workflow: waiting });
    const retry = (checkAccess: CheckAccess, caller: DeveloperCaller = OWNER) =>
      retryTaskWorkflow(routeDeps(h as never, checkAccess), caller, taskId, { requestId: randomUUID(), instructions: "Fix CI.", expectedRevision: waiting.revision });
    return { h, taskId, waiting, retry };
  }

  it("golden: an allowed contributor's Retry lets Rovara go on", async () => {
    const t = await blocked();
    await t.retry(grantedAs("contributor"));
    expect(meta(t.h, t.taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", ciFixApproved: [PR.headSha] });
  });

  it("a member who lost project access is refused with the send-back's words, and the task stays blocked", async () => {
    const t = await blocked();
    await expectRefused(t.retry(denied), sendBackNoAccessMessage("payments"));
    expect(meta(t.h, t.taskId).workflow).toMatchObject({ state: "BLOCKED", revision: t.waiting.revision });
  });

  it("a demoted project viewer is refused with the viewer message", async () => {
    const t = await blocked();
    await expectRefused(t.retry(grantedAs("viewer")), viewerCannotStartTasksMessage("payments"));
    expect(meta(t.h, t.taskId).workflow.state).toBe("BLOCKED");
  });

  it("an archived project is refused, a maintainer's Retry included", async () => {
    const t = await blocked();
    archive(t.h.db);
    await expect(t.retry(grantedAs("maintainer"))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(meta(t.h, t.taskId).workflow.state).toBe("BLOCKED");
  });

  it("a removed member is refused, and the task ends creator_removed", async () => {
    const t = await blocked();
    removeMaya(t.h.db);
    await expect(t.retry(grantedAs("contributor"))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(meta(t.h, t.taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(meta(t.h, t.taskId).workflow.state).toBe("BLOCKED");
  });

  it("another company's caller reads it as no task", async () => {
    const t = await blocked();
    await expect(t.retry(grantedAs("maintainer"), { ...OWNER, orgId: OTHER_ORG })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(meta(t.h, t.taskId).workflow.state).toBe("BLOCKED");
  });
});

/** A task whose reviews block on one finding, in a sequence whose next step after the review is a second coding step. */
async function blockedOnFinding() {
  const audit = capturingAuditDeps();
  const harness = await createSingleAnswerPlanBroker({ audit, brokerExtra: { planSelfCheck: false } });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = meta(harness, taskId).workspaceId;
  const record = meta(harness, taskId);
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const approval = { requestId: randomUUID(), expectedRevision: meta(harness, taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") };
  expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, approval)).status).toBe(200);
  const coding = () => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT").at(-1)!;
  const passing = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
  await harness.finish(workspaceId, String(coding().id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passing } });
  const review = operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW").at(-1)!;
  const at = new Date().toISOString();
  await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
    { operationId: String(review.id), candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: at },
    { operationId: String(review.id), candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at },
  ] } });
  const row = meta(harness, taskId);
  expect(row.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  const program = { steps: [{ id: "plan", kind: "plan" }, { id: "code", kind: "build" }, { id: "check", kind: "check" },
    { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "code", maxRounds: 3 } }, { id: "code_two", kind: "build" }, { id: "check_two", kind: "check" },
    { id: "review_two", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "code_two", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" }] };
  harness.db.set({ ...row, workflow: { ...row.workflow, program, programStepId: "review" } });
  const accept = (checkAccess: CheckAccess, caller: DeveloperCaller = OWNER) => {
    const workflow = meta(harness, taskId).workflow;
    return resolveTaskWorkflowFindings(routeDeps(harness as never, checkAccess), caller, taskId, { requestId: randomUUID(), expectedRevision: workflow.revision, candidateDigest: workflow.candidate!.digest,
      resolutions: openReviewFindings(workflow).map((finding) => ({ findingId: finding.findingId, action: "ACCEPT", note: "Accepted for now." })) });
  };
  return { harness, taskId, accept, audit };
}

describe("forward onto a coding step after every finding is accepted meets the send-back gate", () => {
  it("golden: an allowed contributor accepts and the sequence goes on to its next coding step", async () => {
    const t = await blockedOnFinding();
    await t.accept(grantedAs("contributor"));
    expect(meta(t.harness, t.taskId).workflow).toMatchObject({ programStepId: "code_two" });
    expect(meta(t.harness, t.taskId).workflow.stage).toBe("IMPLEMENT");
  });

  it("a member with no project access is refused with the send-back's words, and the findings stay open", async () => {
    const t = await blockedOnFinding();
    await expectRefused(t.accept(denied), sendBackNoAccessMessage("payments"));
    expect(meta(t.harness, t.taskId).workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  });

  it("a demoted project viewer is refused with the viewer message", async () => {
    const t = await blockedOnFinding();
    await expectRefused(t.accept(grantedAs("viewer")), viewerCannotStartTasksMessage("payments"));
    expect(meta(t.harness, t.taskId).workflow.state).toBe("BLOCKED");
  });

  it("an archived project is refused", async () => {
    const t = await blockedOnFinding();
    archive(t.harness.db);
    await expect(t.accept(grantedAs("maintainer"))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(meta(t.harness, t.taskId).workflow.state).toBe("BLOCKED");
  });

  it("accepting when the sequence goes on to publication (not coding) is not gated: forward onto coding only", async () => {
    const t = await blockedOnFinding();
    const row = meta(t.harness, t.taskId);
    t.harness.db.set({ ...row, workflow: { ...row.workflow, program: { steps: row.workflow.program!.steps.filter((step) => !["code_two", "check_two", "review_two"].includes(step.id)) } } });
    await expect(t.accept(denied)).resolves.toBeDefined();
  });

  it("a removed member is refused, and the task ends creator_removed", async () => {
    const t = await blockedOnFinding();
    removeMaya(t.harness.db);
    await expect(t.accept(grantedAs("contributor"))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(meta(t.harness, t.taskId)).toMatchObject({ outcome: "creator_removed" });
  });

  it("another company's caller reads it as no task", async () => {
    const t = await blockedOnFinding();
    await expect(t.accept(grantedAs("maintainer"), { ...OWNER, orgId: OTHER_ORG })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("a custom sequence's next coding step, started automatically, meets the send-back gate", () => {
  /** The task as the accepted finding leaves it (next step: a second coding step) with its dispatch row, before anything has started it. */
  async function readyForNextStep() {
    const t = await blockedOnFinding();
    const row = meta(t.harness, t.taskId);
    const workflow = row.workflow;
    const next = resolveWorkflowReviewFindings(workflow, { requestId: randomUUID(), expectedRevision: workflow.revision, candidateDigest: workflow.candidate!.digest,
      resolutions: openReviewFindings(workflow).map((finding) => ({ findingId: finding.findingId, action: "ACCEPT", note: "Accepted for now." })) }, { actorId: String(row.ownerKey) }, { now: NOW });
    t.harness.db.set({ ...row, workflow: next });
    const start = (checkAccess: CheckAccess) => startTaskWorkflowImplementationFromSystem(routeDeps(t.harness as never, checkAccess, t.audit), t.taskId, { workflowRevision: next.revision });
    return { ...t, next, start };
  }
  const reasonOf = (h: Harness, taskId: string) => meta(h, taskId).workflow;

  it("golden: an allowed owner's next coding step starts", async () => {
    const t = await readyForNextStep();
    await expect(t.start(grantedAs("contributor"))).resolves.toBe("STARTED");
    expect(reasonOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  });

  it("an owner who lost project access: no run, the task blocks with a plain reason", async () => {
    const t = await readyForNextStep();
    await expect(t.start(denied)).resolves.toBe("STALE");
    expect(reasonOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(reasonOf(t.harness, t.taskId).blockReason).toContain("Rovara didn't start");
    expect(operations(t.harness, meta(t.harness, t.taskId).workspaceId).filter((op) => op.workflowMode === "IMPLEMENT")).toHaveLength(1);
    expect(t.audit.recordedBy("task.work_refused")).toHaveLength(1);
    expect(t.audit.recordedBy("task.work_refused")[0]).toMatchObject({ target: { kind: "task", id: t.taskId }, facts: { path: "program_step", cause: "no_project_access" } });
  });

  it("an archived project: no run", async () => {
    const t = await readyForNextStep();
    archive(t.harness.db);
    await expect(t.start(grantedAs("maintainer"))).resolves.toBe("STALE");
    expect(reasonOf(t.harness, t.taskId)).toMatchObject({ state: "BLOCKED" });
  });

  it("a removed owner is refused by the creator check, as before", async () => {
    const t = await readyForNextStep();
    removeMaya(t.harness.db);
    await expect(t.start(grantedAs("contributor"))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(meta(t.harness, t.taskId)).toMatchObject({ outcome: "creator_removed" });
  });
});

describe("the read-only feedback-review critic meets the send-back gate", () => {
  const PREPARED_BASE = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
  /** A task with a ready workspace and a stored PR-feedback review that FAILED, so a critic run can be (re)started. */
  async function failedReview() {
    const audit = capturingAuditDeps();
    const h = await createDeveloperTaskBroker({ audit });
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Handle retries", client: "test", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = meta(h, taskId).workspaceId;
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED_BASE);
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), "CANCELLED");
    const seeded = seedReview(h, taskId, { extra: { definitionVersion: "1.1.0" } });
    const review = seeded.workflow.feedbackReview!;
    if (review.status !== "PENDING") throw new Error("expected a pending review");
    const failed = WorkflowSnapshotSchema.parse({ ...seeded.workflow, feedbackReview: { ...review, reviewRef: { ...review.reviewRef, status: "FAILED", blockReason: "The review failed." } } });
    const row = meta(h, taskId);
    h.db.set({ ...row, workflow: failed });
    return { h, audit, taskId, workspaceId, failed, reviewDigest: review.reviewRef.sha256, ownerId: String(row.ownerKey) };
  }
  const critics = (h: Harness, workspaceId: string) => operations(h, workspaceId).filter((op) => op.workflowMode === "FEEDBACK_REVIEW");

  describe("started by a GitHub event (as the task's owner)", () => {
    async function collecting() {
      const t = await failedReview();
      const collectingWorkflow = retryWorkflowFeedbackReview(t.failed, { reviewDigest: t.reviewDigest, actor: { actorId: t.ownerId, role: "TASK_OWNER" }, now: NOW });
      t.h.db.set({ ...meta(t.h, t.taskId), workflow: collectingWorkflow });
      return { ...t, start: (checkAccess: CheckAccess) => startTaskWorkflowFeedbackReviewFromWebhook(routeDeps(t.h as never, checkAccess, t.audit), t.taskId) };
    }

    it("golden: an allowed owner's critic starts", async () => {
      const t = await collecting();
      await expect(t.start(grantedAs("contributor"))).resolves.toBe(true);
      expect(critics(t.h, t.workspaceId)).toHaveLength(1);
    });

    it("an owner who lost project access: no critic run, the task blocks with a plain reason, and the refusal is audited", async () => {
      const t = await collecting();
      await expect(t.start(denied)).resolves.toBe(false);
      expect(critics(t.h, t.workspaceId)).toEqual([]);
      expect(meta(t.h, t.taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
      expect(meta(t.h, t.taskId).workflow.blockReason).toContain("Rovara didn't start");
      expect(t.audit.recordedBy("task.work_refused")).toHaveLength(1);
      expect(t.audit.recordedBy("task.work_refused")[0]).toMatchObject({ target: { kind: "task", id: t.taskId }, facts: { path: "feedback_review", cause: "no_project_access" } });
    });

    it("an archived project: no critic run", async () => {
      const t = await collecting();
      archive(t.h.db);
      await expect(t.start(grantedAs("maintainer"))).resolves.toBe(false);
      expect(critics(t.h, t.workspaceId)).toEqual([]);
      expect(meta(t.h, t.taskId).workflow.state).toBe("BLOCKED");
    });

    it("a removed owner: refused by the creator check, no critic run", async () => {
      const t = await collecting();
      removeMaya(t.h.db);
      await expect(t.start(grantedAs("contributor"))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
      expect(critics(t.h, t.workspaceId)).toEqual([]);
    });
  });

  describe("the owner's Retry review", () => {
    const retry = (t: Awaited<ReturnType<typeof failedReview>>, checkAccess: CheckAccess, caller: DeveloperCaller = OWNER) =>
      retryTaskWorkflowFeedbackReview(routeDeps(t.h as never, checkAccess), caller, t.taskId, { reviewDigest: t.reviewDigest });

    it("golden: an allowed owner's retry starts the critic", async () => {
      const t = await failedReview();
      await expect(retry(t, grantedAs("contributor"))).resolves.toMatchObject({ started: true });
      expect(critics(t.h, t.workspaceId)).toHaveLength(1);
    });

    it("a member with no project access is refused with the send-back's words", async () => {
      const t = await failedReview();
      await expectRefused(retry(t, denied), sendBackNoAccessMessage("payments"));
      expect(critics(t.h, t.workspaceId)).toEqual([]);
    });

    it("a demoted project viewer is refused with the viewer message", async () => {
      const t = await failedReview();
      await expectRefused(retry(t, grantedAs("viewer")), viewerCannotStartTasksMessage("payments"));
      expect(critics(t.h, t.workspaceId)).toEqual([]);
    });

    it("an archived project is refused", async () => {
      const t = await failedReview();
      archive(t.h.db);
      await expect(retry(t, grantedAs("maintainer"))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
      expect(critics(t.h, t.workspaceId)).toEqual([]);
    });

    it("a removed member is refused, and the task ends creator_removed", async () => {
      const t = await failedReview();
      removeMaya(t.h.db);
      await expect(retry(t, grantedAs("contributor"))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
      expect(critics(t.h, t.workspaceId)).toEqual([]);
    });

    it("another company's caller reads it as no task", async () => {
      const t = await failedReview();
      await expect(retry(t, grantedAs("maintainer"), { ...OWNER, orgId: OTHER_ORG })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    });
  });
});
