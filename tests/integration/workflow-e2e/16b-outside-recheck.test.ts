// "Continue in your own tool" (owner Q13), through the whole broker: someone pushes to a version 2 task's pull request outside Rovara, the owner presses Recheck in a browser session, and Rovara adopts
// exactly the head they saw with a read-only run (a clone credential, nothing pushed), then runs the owner's own checks on it as a new candidate, as a merge of the base is (decision 70c). The result is
// recorded on that candidate; the "outside" state clears; a head that moves while the checks run makes the result stale, not passing; a second press starts nothing more; and Rovara's own pushes stay Rovara's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mergeTrackingKey, type ProjectCommand, type WorkflowProgram } from "@rovara-code/contracts";
import { OUTSIDE_RECHECK_MILESTONE, WorkflowSnapshotSchema } from "@agentx/cloud-contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, atPlanReview, journeySuite } from "../../support/workflow-e2e-journeys.js";
import { OUTSIDE_RECHECK_NOT_STARTED } from "../../../packages/broker/src/aws/broker/outside-recheck.js";

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

const task = (e2e: WorkflowE2E) => e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!;
const operations = (e2e: WorkflowE2E) => e2e.db.find((item) => item.entityType === "OPERATION" && item.pk === `WORKSPACE#${String(task(e2e).workspaceId)}`);
const pullRequestRecord = (e2e: WorkflowE2E) => e2e.db.get(`WORKSPACE#${String(task(e2e).workspaceId)}`, `PULL_REQUEST#demo#${String(e2e.github.pullRequests[0]!.number).padStart(12, "0")}`) as { expectedHeadCommit: string };
const tracking = (e2e: WorkflowE2E) => {
  const key = mergeTrackingKey(e2e.taskId(), "demo", e2e.github.pullRequests[0]!.number);
  return e2e.db.get(key.pk, key.sk);
};

/** The fake GitHub as merge tracking reads it: the pull request's own head, CI green, nobody approved yet. */
function trackingGithub(e2e: () => WorkflowE2E) {
  const pullRequest = (number: number) => e2e().github.pullRequests.find((entry) => entry.number === number)!;
  return {
    getPullRequestStatus: async (_url: string, number: number) => {
      const found = pullRequest(number);
      return {
        number, state: found.state, draft: found.draft === true, headSha: found.commit, baseBranch: found.baseBranch, mergeableState: "clean" as const, mergeable: true, behindBy: 0,
        checks: [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "https://github.com/example/demo/actions/runs/1/job/1" }],
        requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 0, reviews: [],
      };
    },
    getRepositoryPermission: async () => "write" as const,
    markPullRequestReady: async (_url: string, number: number) => { pullRequest(number).draft = false; return "ready" as const; },
    requestReviewers: async () => "requested" as const,
  };
}

/** A version 2 task through its first pull request (waiting for the merge), with its program in place and a first tracking pass done. */
async function waitingForMerge(options: { checkResult?: (command: ProjectCommand) => { exitCode: number | null; stdout: string; stderr: string } | undefined; duringAdopt?: () => Promise<void> } = {}) {
  const holder: { e2e?: WorkflowE2E } = {};
  const e2e = (holder.e2e = await createWorkflowE2E({
    model: { plan: PLAN, edits: EDITS }, trackingGithub: trackingGithub(() => holder.e2e!),
    ...(options.checkResult === undefined ? {} : { checkResult: options.checkResult }),
    ...(options.duringAdopt === undefined ? {} : { duringAdopt: options.duringAdopt }),
  }));
  await atPlanReview(e2e);
  const stored = task(e2e);
  e2e.db.set({ ...stored, workflow: { ...(stored.workflow as object), definitionVersion: "1.1.0" } });
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  const opened = task(e2e);
  e2e.db.set({ ...opened, workflow: { ...(opened.workflow as object), program: PROGRAM, programStepId: "pull_request" } });
  expect(WorkflowSnapshotSchema.safeParse(task(e2e).workflow).success).toBe(true);
  e2e.clock.advance(60_000);
  await e2e.runMergeRecovery();
  return { e2e, pullRequest: e2e.github.pullRequests[0]! };
}

/** The schedule's tracking pass (it reads the pull request's head from GitHub). */
async function track(e2e: WorkflowE2E): Promise<void> {
  e2e.clock.advance(16 * 60_000);
  await e2e.runMergeRecovery();
}

/** Runs the queued work (the adoption, the checks, the reviews) until the task is quiet. */
async function runAll(e2e: WorkflowE2E, rounds = 6): Promise<void> {
  await e2e.settle();
  for (let round = 0; round < rounds; round += 1) {
    await e2e.runRecovery();
    await e2e.settle();
  }
}

const recheck = (e2e: WorkflowE2E, headSha: string, requestId: string = randomUUID()) =>
  e2e.webPost(`/v1/app/tasks/${e2e.taskId()}/continue/recheck`, { requestId, repository: "demo", number: e2e.github.pullRequests[0]!.number, headSha });

describe("Suite 16b: Recheck of a head pushed outside Rovara", () => {
  journeySuite();

  it("16b.1 the owner's Recheck adopts exactly the head they saw (clone credential, nothing pushed), runs their checks on it as the new candidate, records the result there and clears the outside state", async () => {
    const { e2e, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    expect(tracking(e2e)).toMatchObject({ headByRovara: false, headSha: outside });
    const pushes = e2e.github.pushLog.length;
    const checksBefore = operations(e2e).filter((operation) => operation.workflowMode === "CHECKS").length;

    const requestId = randomUUID();
    const started = await recheck(e2e, outside, requestId);
    expect(started, JSON.stringify(started.body)).toMatchObject({ status: 200, body: { status: "started" } });
    // A double press: the same request answers the same run; another request is refused while the first runs. One run either way.
    expect((await recheck(e2e, outside, requestId)).status).toBe(200);
    expect((await recheck(e2e, outside)).status).toBeGreaterThanOrEqual(400);
    const adoptions = operations(e2e).filter((operation) => operation.kind === "maintain" && (operation.maintenance as { workflowAdopt?: unknown } | undefined)?.workflowAdopt !== undefined);
    expect(adoptions).toHaveLength(1);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING", outsideRecheck: { phase: "adopting", headSha: outside, previousHeadSha: before } });

    await runAll(e2e);

    const after = e2e.workflow();
    // The checks ran once more, on the adopted head, as the owner's own Retry checks, and the reviews followed; the task waits for the merge again on that head.
    expect(operations(e2e).filter((operation) => operation.workflowMode === "CHECKS").length, JSON.stringify({ stage: after.stage, state: after.state, block: after.blockReason, marker: after.outsideRecheck, ops: operations(e2e).map((o) => [o.kind, o.workflowMode, o.status, o.error]) })).toBe(checksBefore + 1);
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.outsideRecheck).toBeUndefined();
    expect(after.candidate!.digest).not.toBe(beforeDigest);
    expect(after.candidate!.repositories[0]).toMatchObject({ commitSha: outside });
    expect(after.verification?.candidateDigest).toBe(after.candidate!.digest);
    expect(after.verification?.results.every((result) => result.status === "PASS")).toBe(true);
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: outside, candidateDigest: after.candidate!.digest });
    // Nothing was pushed (the adoption's credential could only clone), and the head is Rovara's own from now on: its later pushes build on it.
    expect(e2e.github.pushLog.length).toBe(pushes);
    expect(e2e.adoptCredentials).toEqual(["clone"]);
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(outside);
    expect(e2e.db.find((item) => item.entityType === "CODE_MILESTONE" && item.text === OUTSIDE_RECHECK_MILESTONE)).toHaveLength(1);
    await track(e2e);
    expect(tracking(e2e)).toMatchObject({ headByRovara: true, headSha: outside });
  });

  it("16b.2 a head that moves while the checks run makes the result stale, not passing: nothing of it is recorded, the task is back on its earlier checked code, and the new head reads as changed outside", async () => {
    const armed: { push?: (() => void) | undefined; e2e?: WorkflowE2E } = {};
    const SEEN = "2026-11-11T13:00:00.000Z";
    const { e2e, pullRequest } = await waitingForMerge({ checkResult: () => {
      // While the re-check's checks run, someone pushes again (the push lands before the result is recorded), and GitHub was seen again meanwhile (the pull request's observedAt moves on).
      if (armed.push !== undefined && armed.e2e !== undefined) {
        const stored = task(armed.e2e);
        const workflow = stored.workflow as { pullRequests: Array<Record<string, unknown>> };
        armed.e2e.db.set({ ...stored, workflow: { ...workflow, pullRequests: workflow.pullRequests.map((entry) => ({ ...entry, observedAt: SEEN })) } });
      }
      armed.push?.();
      armed.push = undefined;
      return undefined;
    } });
    armed.e2e = e2e;
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    const again = await e2e.prepareOutsidePush(pullRequest.headBranch, "outside.ts", "export const outside = 2;\n");
    armed.push = () => { again.push(); };
    const requestId = randomUUID();
    expect((await recheck(e2e, outside, requestId)).status).toBe(200);
    await runAll(e2e, 2);
    expect(armed.push).toBeUndefined();
    const after = e2e.workflow();
    // Nothing of the stale result is recorded: the task is back on its earlier checked code, the record at Rovara's earlier head.
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.outsideRecheck).toBeUndefined();
    expect(after.candidate!.digest).toBe(beforeDigest);
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: before });
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(before);
    // What GitHub said of the pull request since is today's, not the pre-adoption copy's.
    expect(after.pullRequests?.[0]).toMatchObject({ state: "OPEN", observedAt: SEEN });
    // A repeat of the same request answers how it ended, not "started".
    const repeat = await recheck(e2e, outside, requestId);
    expect(repeat.status).toBe(409);
    expect(JSON.stringify(repeat.body)).toContain("changed again while Rovara was re-checking it");
    await track(e2e);
    expect(tracking(e2e)).toMatchObject({ headByRovara: false, headSha: again.commit });
    // The new head is offered for a re-check of its own.
    expect((await recheck(e2e, again.commit)).status).toBe(200);
  });

  it("16b.2b a checks run that FAILS on a head that moved is fenced the same: nothing of it is recorded and the task is back on its earlier checked code", async () => {
    const { e2e, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    expect((await recheck(e2e, outside)).status).toBe(200);
    // The adoption runs; the person's checks are queued next (one step, then the harness stops before running them).
    await e2e.settle(1).catch(() => undefined);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "RUNNING", outsideRecheck: { phase: "checking", headSha: outside } });
    // Someone pushes again, and the checks run itself fails.
    await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 2;\n");
    e2e.worker.failNext("task:CHECKS", "RUNTIME_UNAVAILABLE: the check runner stopped");
    await runAll(e2e, 2);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.outsideRecheck).toBeUndefined();
    expect(after.candidate!.digest).toBe(beforeDigest);
    expect(after.verification?.results.every((result) => result.status === "PASS")).toBe(true);
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(before);
  });

  it("16b.3 a head that moves before the adoption is recorded is not adopted: the task waits for the merge with its earlier checked code", async () => {
    const holder: { e2e?: WorkflowE2E; branch?: string } = {};
    const { e2e, pullRequest } = await waitingForMerge({ duringAdopt: async () => { await holder.e2e!.pushOutside(holder.branch!, "outside.ts", "export const outside = 3;\n"); } });
    holder.e2e = e2e;
    holder.branch = pullRequest.headBranch;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    const requestId = randomUUID();
    expect((await recheck(e2e, outside, requestId)).status).toBe(200);
    await runAll(e2e, 2);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.outsideRecheck).toBeUndefined();
    expect(after.candidate!.digest).toBe(beforeDigest);
    expect(pullRequestRecord(e2e).expectedHeadCommit).not.toBe(outside);
    // A repeat of the same request answers that the code was not taken, not "started".
    const repeat = await recheck(e2e, outside, requestId);
    expect(repeat.status).toBe(409);
    expect(JSON.stringify(repeat.body)).toContain("couldn't take that code: the pull request changed again");
  });

  it("16b.4 the head the owner saw must be the one GitHub shows: a press for a head that moved on is refused and adopts nothing", async () => {
    const { e2e, pullRequest } = await waitingForMerge();
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    // GitHub moved on again, and merge tracking has not read it yet: the acceptance's own read of GitHub refuses the old head.
    await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 2;\n");
    const refused = await recheck(e2e, outside);
    expect(refused.status).toBe(409);
    expect(operations(e2e).filter((operation) => (operation.maintenance as { workflowAdopt?: unknown } | undefined)?.workflowAdopt !== undefined)).toHaveLength(0);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().outsideRecheck).toBeUndefined();
  });

  it("16b.5 money: a spend wait that starts after the adoption stops the owner's checks before they run, in plain words", async () => {
    const holder: { e2e?: WorkflowE2E } = {};
    const { e2e, pullRequest } = await waitingForMerge({ duringAdopt: async () => {
      // While the adoption runs, the task starts waiting for an approval of more spend.
      const stored = task(holder.e2e!);
      holder.e2e!.db.set({ ...stored, budgetPause: { scope: { kind: "task", taskId: holder.e2e!.taskId() }, at: new Date().toISOString() } });
    } });
    holder.e2e = e2e;
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    const checksBefore = operations(e2e).filter((operation) => operation.workflowMode === "CHECKS").length;
    expect((await recheck(e2e, outside)).status).toBe(200);
    await runAll(e2e, 2);
    expect(operations(e2e).filter((operation) => operation.workflowMode === "CHECKS").length).toBe(checksBefore);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(after.blockReason?.startsWith(OUTSIDE_RECHECK_NOT_STARTED)).toBe(true);
    expect(after.outsideRecheck).toBeUndefined();
  });

  it("16b.6 money: a task already waiting for more spend is not re-checked, and nothing starts", async () => {
    const { e2e, pullRequest } = await waitingForMerge();
    const outside = await e2e.pushOutside(pullRequest.headBranch, "outside.ts", "export const outside = 1;\n");
    await track(e2e);
    e2e.db.set({ ...task(e2e), budgetPause: { scope: { kind: "task", taskId: e2e.taskId() }, at: new Date().toISOString() } });
    const refused = await recheck(e2e, outside);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(operations(e2e).filter((operation) => (operation.maintenance as { workflowAdopt?: unknown } | undefined)?.workflowAdopt !== undefined)).toHaveLength(0);
  });
});
