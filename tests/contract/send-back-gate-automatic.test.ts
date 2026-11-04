// S2 (register SB-2, F27-5 and MR-3, owner decision 2026-11-04): Rovara's own rounds (a CI fix, or a fix of PR review comments it decided) and any queued dispatch run AS the task's owner. When that
// person was removed, lost the project's access, was lowered to viewer, or the project was archived, the round is not started: nothing is run or paid for, the task says why, the dispatch row is
// removed (no endless retry), and the refusal is audited with fixed words. An allowed owner (or a company admin) still gets the round.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_AUTONOMY_ACTOR_ID, WorkflowSnapshotSchema, createCandidateManifest, decideWorkflowFeedbackFindings, orgMemberKey, orgRemovedKey, projectMemberKey, projectMetaKey, startWorkflowFix, type WorkflowSnapshot,
} from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { ciEvidenceItem, ciOutputBlock } from "../../packages/broker/src/rovara-code/ci-fix.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { seedReview } from "../support/rovara-code-feedback.js";
import { TEST_ORG } from "../support/orgs.js";
import { pullRequestDetails } from "../support/p5-world.js";
import { notifyOthersOfStop } from "../../packages/broker/src/developer/work-refusal.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks/task-page.js";

const NOW = "2026-10-25T12:00:00.000Z";
const OTHER_ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const PR = { repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/example/demo/pull/7" };
const PROGRAM = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

type Meta = Record<string, unknown> & { taskId: string; workspaceId: string; workflow: WorkflowSnapshot; outcome?: string; outcomeReason?: string };

async function world() {
  const access = fakeModelAccess();
  const audit = capturingAuditDeps();
  const heads = { current: PR.headSha };
  const getPullRequest = vi.fn(async () => pullRequestDetails(42, { headCommit: heads.current }));
  const h = await createDeveloperTaskBroker({ audit, brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true,
    githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest, updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true) } } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  await new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as Meta;
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const byMode = (workspaceId: string, mode: string) => operations(workspaceId).filter((item) => item.workflowMode === mode);
  const sweep = () => h.handler({ source: "agentx.workflow-dispatch-recovery" });
  const rows = (taskId: string) => h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId);

  async function startTask() {
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = String((reply.body.task as { taskId: string }).taskId);
    const workspaceId = meta(taskId).workspaceId;
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await h.finish(workspaceId, String(byMode(workspaceId, "PLAN").at(-1)!.id), "CANCELLED");
    return { taskId, workspaceId };
  }
  /** Where tracking leaves a task when red CI starts a fix round: coding, ready, marked as a CI fix, with its row. */
  async function ciRound() {
    const { taskId, workspaceId } = await startTask();
    const waiting = WorkflowSnapshotSchema.parse({
      ...meta(taskId).workflow, revision: 30, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate, reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: NOW, results: [], reviewOnly: true },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
      pullRequests: [PR], blockReason: undefined,
    });
    const fixing = startWorkflowFix(waiting, { source: "ci", problems: ["test"], now: NOW });
    h.db.set({ ...meta(taskId), workflow: fixing, checkPolicy: undefined });
    const block = ciOutputBlock([{ name: "test", conclusion: "failure", url: "https://github.com/example/demo/actions/runs/1", log: "Error: boom in handler" }]);
    h.db.set((ciEvidenceItem("state", { orgId: TEST_ORG, taskId, revision: fixing.revision, block, now: Date.parse(NOW) }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    h.db.set((workflowDispatchItem("state", taskId, fixing.revision, "IMPLEMENT", candidate.digest, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return { taskId, workspaceId, source: "ci" as const };
  }
  /** Where the tracking pass leaves a task when Rovara decides to fix review comments itself. */
  async function feedbackRound() {
    const { taskId, workspaceId } = await startTask();
    heads.current = "c".repeat(40);
    seedReview(h, taskId, { extra: { definitionVersion: "1.1.0", program: PROGRAM, programStepId: "pull_request", revision: 30, path: meta(taskId).workflow.path } });
    const waiting = meta(taskId).workflow;
    const card = waiting.feedbackReview!;
    const decided = decideWorkflowFeedbackFindings(waiting, {
      requestId: randomUUID(), expectedRevision: waiting.revision, reviewDigest: card.reviewRef!.sha256, proposalDigest: card.reviewRef!.proposalDigest,
      bundleDigests: card.bundleRefs.map((bundle) => bundle.sha256), selectedFindingIds: card.reviewRef!.findingRefs.map((finding) => finding.id), decision: "APPROVE",
    }, { actorId: FEEDBACK_AUTONOMY_ACTOR_ID, role: "ROVARA_AUTONOMY", autonomy: { level: "prepare" } }, NOW);
    h.db.set({ ...meta(taskId), workflow: decided, checkPolicy: undefined });
    h.db.set((workflowDispatchItem("state", taskId, decided.revision, "IMPLEMENT", decided.candidate!.digest, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return { taskId, workspaceId, source: "feedback" as const };
  }
  /** A task put where its other queued steps wait for their dispatch row: planning ready, checks waiting, reviews waiting, or the pull request ready. */
  async function stepRound(kind: "PLAN" | "CHECKS" | "REVIEW" | "PUBLISH") {
    const { taskId, workspaceId } = await startTask();
    const base = { ...meta(taskId).workflow, revision: 30, candidate, reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }], blockReason: undefined };
    const verification = { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: NOW, results: [], reviewOnly: true };
    const reviews = ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW }));
    const workflow = WorkflowSnapshotSchema.parse(kind === "PLAN" ? { ...meta(taskId).workflow, revision: 30, stage: "PLAN", state: "READY" }
      : kind === "CHECKS" ? { ...base, stage: "VERIFY", state: "WAITING" }
      : kind === "REVIEW" ? { ...base, stage: "REVIEW", state: "WAITING", verification }
      : { ...base, stage: "PULL_REQUEST", state: "READY", verification, reviews });
    h.db.set({ ...meta(taskId), workflow, checkPolicy: undefined });
    h.db.set((workflowDispatchItem("state", taskId, workflow.revision, kind === "PUBLISH" ? "PUBLISH" : kind, kind === "PLAN" ? WORKFLOW_NO_CANDIDATE_DIGEST : candidate.digest, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return { taskId, workspaceId, kind, stage: workflow.stage };
  }
  const notAMember = () => h.channelMembers.mockImplementation(async () => ({ ok: true, memberOf: [] }));
  const grant = (role: "viewer" | "developer") => h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role });
  const archive = (orgId = TEST_ORG) => h.db.set({ ...projectMetaKey(orgId, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: NOW, createdBy: "x" });
  const remove = () => { h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId)); h.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() }); };
  const refused = () => audit.recordedBy("task.work_refused");
  return { h, audit, meta, byMode, sweep, rows, ciRound, feedbackRound, stepRound, operations, notAMember, grant, archive, remove, refused, access };
}

const ROUNDS = [["a CI fix round", "ciRound", "ci_fix_round"], ["a review-comment fix round Rovara decided", "feedbackRound", "feedback_round"]] as const;

describe.each(ROUNDS)("%s runs as the task's owner", (_name, make, path) => {
  const stopped = (t: Awaited<ReturnType<typeof world>>, round: { taskId: string; workspaceId: string }) => {
    expect(t.byMode(round.workspaceId, "IMPLEMENT")).toEqual([]);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    // The row is gone: nothing retries it.
    expect(t.rows(round.taskId)).toEqual([]);
  };

  it("golden: an owner who is a contributor through the project's channel gets the round", async () => {
    const t = await world();
    const round = await t[make]();
    await t.sweep();
    expect(t.byMode(round.workspaceId, "IMPLEMENT")).toHaveLength(1);
    expect(t.refused()).toEqual([]);
  });

  it("golden: a company admin with no grant and no channel still gets the round", async () => {
    const t = await world();
    const round = await t[make]();
    t.notAMember();
    t.h.db.set({ ...orgMemberKey(TEST_ORG, MAYA.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: MAYA.developerId, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
    await t.sweep();
    expect(t.byMode(round.workspaceId, "IMPLEMENT")).toHaveLength(1);
  });

  it("an owner who lost the project's access: no run, a clear reason on the task, an audit event, and no retry", async () => {
    const t = await world();
    const round = await t[make]();
    t.notAMember();
    await t.sweep();
    stopped(t, round);
    const workflow = t.meta(round.taskId).workflow;
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(workflow.blockReason).toContain("Rovara didn't start");
    expect(workflow.fixSource).toBeUndefined();
    expect(t.refused()).toHaveLength(1);
    expect(t.refused()[0]).toMatchObject({ actor: { kind: "system" }, target: { kind: "task", id: round.taskId }, facts: { path, cause: "no_project_access" } });
    // A second sweep finds nothing to do.
    await t.sweep();
    expect(t.refused()).toHaveLength(1);
    expect(t.byMode(round.workspaceId, "IMPLEMENT")).toEqual([]);
  });

  it("an owner lowered to project viewer: no run (the project check reads a viewer grant as no access to start work)", async () => {
    const t = await world();
    const round = await t[make]();
    t.grant("viewer");
    await t.sweep();
    stopped(t, round);
    expect(t.meta(round.taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(t.refused()[0]).toMatchObject({ facts: { path, cause: "no_project_access" } });
  });

  it("an archived project: no run, even for a company admin, and the reason names the archive", async () => {
    const t = await world();
    const round = await t[make]();
    t.archive();
    t.h.db.set({ ...orgMemberKey(TEST_ORG, MAYA.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: MAYA.developerId, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
    await t.sweep();
    stopped(t, round);
    expect(t.meta(round.taskId).workflow.blockReason).toContain("archived");
    expect(t.refused()[0]).toMatchObject({ facts: { path, cause: "project_archived" } });
  });

  it("another company's archived project of the same name changes nothing (keys are the task's own org)", async () => {
    const t = await world();
    const round = await t[make]();
    t.archive(OTHER_ORG);
    await t.sweep();
    expect(t.byMode(round.workspaceId, "IMPLEMENT")).toHaveLength(1);
    expect(t.refused()).toEqual([]);
  });

  it("a removed owner (MR-3): the task ends creator_removed, no run, the row is removed, and the stop is audited", async () => {
    const t = await world();
    const round = await t[make]();
    t.remove();
    await t.sweep();
    stopped(t, round);
    expect(t.meta(round.taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(t.refused()).toHaveLength(1);
    expect(t.refused()[0]).toMatchObject({ target: { kind: "task", id: round.taskId }, facts: { path: "queued_dispatch", cause: "owner_removed" } });
    await t.sweep();
    expect(t.refused()).toHaveLength(1);
  });
});

describe("MR-3: a queued dispatch of any kind for a removed owner stops for good", () => {
  it("a PLAN dispatch row: the task ends creator_removed, the row is removed (not parked, not retried), and the stop is audited once", async () => {
    const t = await world();
    const { taskId, workspaceId } = await (async () => {
      const reply = await t.h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
      const id = String((reply.body.task as { taskId: string }).taskId);
      return { taskId: id, workspaceId: t.meta(id).workspaceId };
    })();
    const task = t.meta(taskId);
    const ready = WorkflowSnapshotSchema.parse({ ...task.workflow, stage: "PLAN", state: "READY", revision: task.workflow.revision + 1 });
    t.h.db.set({ ...task, workflow: ready });
    t.h.db.set((workflowDispatchItem("state", taskId, ready.revision, "PLAN", WORKFLOW_NO_CANDIDATE_DIGEST, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    const plansBefore = t.byMode(workspaceId, "PLAN").length;
    t.remove();
    await t.sweep();
    expect(t.rows(taskId)).toEqual([]);
    expect(t.meta(taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(t.byMode(workspaceId, "PLAN")).toHaveLength(plansBefore);
    expect(t.refused()).toHaveLength(1);
    expect(t.refused()[0]).toMatchObject({ facts: { path: "queued_dispatch", cause: "owner_removed" } });
    await t.sweep();
    expect(t.refused()).toHaveLength(1);
  });
});

describe.each([["planning", "PLAN"], ["checks", "CHECKS"], ["reviews", "REVIEW"], ["the pull request push", "PUBLISH"]] as const)("a queued %s dispatch runs as the task's owner", (_name, kind) => {
  it("an owner who lost the project's access: nothing starts, the task blocks with a plain reason, the row goes, and the refusal is audited once", async () => {
    const t = await world();
    const round = await t.stepRound(kind);
    t.notAMember();
    const before = t.operations(round.workspaceId).length;
    await t.sweep();
    expect(t.operations(round.workspaceId)).toHaveLength(before);
    expect(t.rows(round.taskId)).toEqual([]);
    const workflow = t.meta(round.taskId).workflow;
    expect(workflow).toMatchObject({ stage: round.stage, state: "BLOCKED" });
    expect(workflow.blockReason).toContain("Rovara didn't start");
    expect(t.refused()).toHaveLength(1);
    expect(t.refused()[0]).toMatchObject({ target: { kind: "task", id: round.taskId }, facts: { path: "queued_dispatch", cause: "no_project_access" } });
    await t.sweep();
    expect(t.refused()).toHaveLength(1);
  });

  it("an archived project: nothing starts, even for a company admin", async () => {
    const t = await world();
    const round = await t.stepRound(kind);
    t.archive();
    t.h.db.set({ ...orgMemberKey(TEST_ORG, MAYA.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: MAYA.developerId, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
    const before = t.operations(round.workspaceId).length;
    await t.sweep();
    expect(t.operations(round.workspaceId)).toHaveLength(before);
    expect(t.meta(round.taskId).workflow).toMatchObject({ state: "BLOCKED" });
    expect(t.refused()[0]).toMatchObject({ facts: { path: "queued_dispatch", cause: "project_archived" } });
  });

  it("an allowed owner is not stopped by the gate", async () => {
    const t = await world();
    const round = await t.stepRound(kind);
    await t.sweep();
    expect(t.refused()).toEqual([]);
    expect(t.meta(round.taskId).workflow.blockReason ?? "").not.toContain("Rovara didn't start");
  });

  it("another company's archived project of the same name changes nothing", async () => {
    const t = await world();
    const round = await t.stepRound(kind);
    t.archive(OTHER_ORG);
    await t.sweep();
    expect(t.refused()).toEqual([]);
    expect(t.meta(round.taskId).workflow.blockReason ?? "").not.toContain("Rovara didn't start");
  });
});

describe("review fixes: a refusal can be recovered, parked rows are not resumed, a Slack outage defers", () => {
  const review = (t: Awaited<ReturnType<typeof world>>, taskId: string, body: Record<string, unknown>) => t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/review`, { requestId: randomUUID(), instructions: "Review.", ...body });
  const codeOf = (reply: { body: Record<string, unknown> }) => (reply.body.error as { code?: string } | undefined)?.code;

  it("H3: a parked REVIEW row is not resumed by a presser who has no project access: refused first, nothing starts", async () => {
    const t = await world();
    const round = await t.stepRound("REVIEW");
    const row = t.rows(round.taskId)[0]!;
    t.h.db.set({ ...row, taskAccessPausedAt: "2026-10-25T12:00:00.000Z" });
    t.notAMember();
    const before = t.operations(round.workspaceId).length;
    const reply = await review(t, round.taskId, { expectedRevision: t.meta(round.taskId).workflow.revision, candidateDigest: candidate.digest });
    expect(codeOf(reply)).toBe("PROJECT_ACCESS_DENIED");
    expect(t.operations(round.workspaceId)).toHaveLength(before);
    expect(t.rows(round.taskId)[0]).toMatchObject({ taskAccessPausedAt: "2026-10-25T12:00:00.000Z" });
  });

  it("H4: a CI-fix round refused while waiting for the merge has a way back: once access returns, Retry puts the task back to waiting and wakes tracking", async () => {
    const t = await world();
    const round = await t.ciRound();
    t.notAMember();
    await t.sweep();
    const blocked = t.meta(round.taskId).workflow;
    expect(blocked).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(blocked.blockReason).toContain("Retry");
    // Access returns.
    t.h.channelMembers.mockImplementation(async (request) => ({ ok: true, memberOf: request.slackUserId === MAYA.slackUserId ? request.channelIds : [] }));
    const retried = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Go on.", expectedRevision: blocked.revision });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(t.meta(round.taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: blocked.revision + 1 });
    expect(t.meta(round.taskId).workflow.blockReason).toBeUndefined();
  });

  it("H4: while access is still missing, that Retry is refused and the task stays blocked", async () => {
    const t = await world();
    const round = await t.ciRound();
    t.notAMember();
    await t.sweep();
    const blocked = t.meta(round.taskId).workflow;
    const retried = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Go on.", expectedRevision: blocked.revision });
    expect(codeOf(retried)).toBe("PROJECT_ACCESS_DENIED");
    expect(t.meta(round.taskId).workflow.state).toBe("BLOCKED");
  });

  it("M6: when Slack cannot be reached, a queued step is deferred without using up its tries, and runs once Slack answers", async () => {
    const t = await world();
    const round = await t.stepRound("PLAN");
    t.h.channelMembers.mockImplementation(async () => ({ ok: false } as never));
    const before = t.operations(round.workspaceId).length;
    await t.sweep();
    expect(t.operations(round.workspaceId)).toHaveLength(before);
    const row = t.rows(round.taskId)[0]!;
    expect(row.attempts ?? 0).toBe(0);
    expect(row.taskAccessPausedAt).toBeUndefined();
    expect(t.meta(round.taskId).workflow.state).toBe("READY");
    expect(t.refused()).toEqual([]);
  });

  it("M4: a plan-grounding check that is already running is not cut off when the owner loses access; one that has not started is not started", async () => {
    const t = await world();
    const round = await t.stepRound("PLAN");
    // A held plan whose check has not started: refused, and the hold ends as a plan that could not be checked, with the row removed.
    const task = t.meta(round.taskId);
    const running = { ...task.workflow, state: "RUNNING" as const, revision: task.workflow.revision + 1 };
    t.h.db.set({ ...task, workflow: running, planGrounding: { artifactId: "plan-v1", version: 1, artifactSha256: "a".repeat(64), artifactCreatedAt: NOW, planOperationId: randomUUID(), attempt: 1 } });
    t.h.db.set((workflowDispatchItem("state", round.taskId, running.revision, "GROUNDING", "a".repeat(64), NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    t.notAMember();
    await t.sweep();
    expect(t.meta(round.taskId).planGrounding).toBeUndefined();
    expect(t.refused().some((event) => (event.facts as { path?: string }).path === "queued_dispatch")).toBe(true);
  });
});

describe("others who can take the task over are told once when Rovara stops a step for the owner", () => {
  const BEA = "b".repeat(64);
  const CAL = "c".repeat(64);
  const DEE = "d".repeat(64);
  const people = (t: Awaited<ReturnType<typeof world>>, taskId: string) => t.h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: [
    { developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: "Maya Chen", role: "owner" },
    { developerId: OMAR.developerId, slackUserId: "U0OMAR0001", name: "Omar Diaz", role: "owner" },
    { developerId: BEA, slackUserId: "U0BEA00001", name: "Bea", role: "commenter" },
    { developerId: CAL, slackUserId: "U0CAL00001", name: "Cal", role: "viewer" },
    { developerId: DEE, slackUserId: "U0DEE00001", name: "Dee", role: "denied" },
  ] });
  const rows = (t: Awaited<ReturnType<typeof world>>, taskId: string) => t.h.db.find((item) => item.pk === `DEVTASK#${taskId}` && item.entityType === "TASK_OWNER_STOPPED_NOTIFICATION");

  it("a co-owner and a commenter get one pending notice each; the effective owner, a viewer and a denied person get none", async () => {
    const t = await world();
    const round = await t.ciRound();
    people(t, round.taskId);
    t.notAMember();
    await t.sweep();
    expect(rows(t, round.taskId).map((row) => row.targetDeveloperId).sort()).toEqual([OMAR.developerId, BEA].sort());
    expect(rows(t, round.taskId).every((row) => row.status === "PENDING" && row.attempts === 0 && typeof row.slackUserId === "string")).toBe(true);
    // A second look finds nothing to do and adds nothing.
    await t.sweep();
    expect(rows(t, round.taskId)).toHaveLength(2);
  });

  it("the same stop recorded twice (a retried refusal) is still one notice per person", async () => {
    const t = await world();
    const round = await t.ciRound();
    people(t, round.taskId);
    const task = t.meta(round.taskId) as never;
    const table = { documentClient: t.h.db as never, tableName: "state" };
    expect(await notifyOthersOfStop(table, task, "ci_fix_round#31", NOW)).toBe(2);
    expect(await notifyOthersOfStop(table, task, "ci_fix_round#31", NOW)).toBe(0);
    expect(rows(t, round.taskId)).toHaveLength(2);
    // Another stop is another notice.
    expect(await notifyOthersOfStop(table, task, "ci_fix_round#40", NOW)).toBe(2);
  });

  it("a removed owner's stop also tells the co-owner, and the notice names nobody", async () => {
    const t = await world();
    const round = await t.ciRound();
    people(t, round.taskId);
    t.remove();
    await t.sweep();
    expect(rows(t, round.taskId).map((row) => row.targetDeveloperId)).toContain(OMAR.developerId);
    expect(JSON.stringify(rows(t, round.taskId))).not.toContain("Maya");
  });

  it("a task with nobody else on it notifies nobody", async () => {
    const t = await world();
    const round = await t.ciRound();
    t.notAMember();
    await t.sweep();
    expect(rows(t, round.taskId)).toEqual([]);
  });

  it("the stop says how to go on: take the task over (or restore the owner's access and press Retry)", async () => {
    const t = await world();
    const round = await t.ciRound();
    t.notAMember();
    await t.sweep();
    const text = String(t.meta(round.taskId).workflow.blockReason);
    expect(text).toContain("take");
    expect(text).toContain("Retry");
    expect(text).not.toContain("someone with access presses Retry");
  });
});

describe("M6: a Slack outage defers with an age cap and says so on the task", () => {
  it("while deferred the task page says it waits for Slack; the row keeps its tries", async () => {
    const t = await world();
    const round = await t.stepRound("PLAN");
    t.h.channelMembers.mockImplementation(async () => ({ ok: false } as never));
    await t.sweep();
    const workflow = t.meta(round.taskId).workflow;
    expect(workflow.state).toBe("READY");
    expect(workflow.accessCheckWaitSince).toMatchObject({ revision: workflow.revision });
    expect(t.rows(round.taskId)[0]!.slackWaitSince).toBeDefined();
    expect(taskPageStage(workflow, false, true).status).toContain("Slack");
  });

  it("after 30 minutes of it the step is blocked with a plain, retryable reason, the row goes, and it is audited", async () => {
    const t = await world();
    const round = await t.stepRound("PLAN");
    t.h.channelMembers.mockImplementation(async () => ({ ok: false } as never));
    await t.sweep();
    const row = t.rows(round.taskId)[0]!;
    const past = new Date(Date.now() - 31 * 60_000).toISOString();
    t.h.db.set({ ...row, slackWaitSince: past, nextAttemptAt: past, dispatchDueSk: `${past}#${String(row.sk)}` });
    await t.sweep();
    expect(t.rows(round.taskId)).toEqual([]);
    const workflow = t.meta(round.taskId).workflow;
    expect(workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(workflow.blockReason).toContain("Slack");
    expect(workflow.blockReason).toContain("Retry");
    expect(t.refused()[0]).toMatchObject({ facts: { path: "queued_dispatch", cause: "slack_unavailable" } });
  });
});
