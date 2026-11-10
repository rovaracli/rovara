// Rovara Code (Plan 6 Task 17), through the whole broker: a version 2 task's pull request falls behind a base that requires an up-to-date branch (with a person's approval) or conflicts with it. The
// schedule's tracking pass queues a merge of the base, the dispatch sweep starts it, the worker (real Git) merges exactly the base commit, and the broker records what GitHub shows. A clean merge keeps
// the pull request's head a fast-forward and moves the candidate to the new base; a conflict becomes one coding round, checked, reviewed and pushed as a merge commit whose parents are the old head and
// the base commit; GitHub refusing workflow files stops with its text. Nothing is rebased, nothing is force-pushed, and a person's push wins.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CI_OUTPUT_BLOCK_HEADER, BRANCH_SYNC_UNSURE_MESSAGE, BRANCH_WORKFLOW_FILES_MESSAGE, branchSyncGiveUpMessage, branchConflictAskMessage, CONFLICT_PATHS_BLOCK_HEADER, EMPTY_RECIPE, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, branchConflictStopMessage, type ProjectCommand, type WorkflowProgram } from "@agentx/contracts";
import { taskRecipeKey } from "../../../packages/broker/src/developer/task-records.js";
import { TEST_ORG } from "../../support/orgs.js";
import { mergeTrackingKey } from "../../../packages/contracts/src/org-scoped-keys.js";
import { E2E_CHECK, createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, FIXED, PLAN, TASK_LINK_RETRY, actionIds, atPlanReview, journeySuite, said } from "../../support/workflow-e2e-journeys.js";

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const RESOLVED = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n" }];
const BASE_GREETING = "export function greet(name: string): string {\n  return 'Hi ' + name;\n}\n";

const task = (e2e: WorkflowE2E) => e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!;
const dispatchRows = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const milestones = (e2e: WorkflowE2E, kind: string) => e2e.db.find((item) => item.entityType === "CODE_MILESTONE" && item.kind === kind);
const pullRequestRecord = (e2e: WorkflowE2E) => e2e.db.get(`WORKSPACE#${String(task(e2e).workspaceId)}`, `PULL_REQUEST#demo#${String(e2e.github.pullRequests[0]!.number).padStart(12, "0")}`) as { expectedHeadCommit: string };
const tracking = (e2e: WorkflowE2E) => {
  const key = mergeTrackingKey(e2e.taskId(), "demo", e2e.github.pullRequests[0]!.number);
  return e2e.db.get(key.pk, key.sk);
};

/** The fake GitHub as merge tracking reads it: the base is ahead (or not), the branch conflicts or not, a person has approved or not. */
function syncGithub(e2e: () => WorkflowE2E) {
  const state = { baseAhead: false, conflicted: false, approved: true, red: false };
  const pullRequest = (number: number) => e2e().github.pullRequests.find((entry) => entry.number === number)!;
  return {
    state,
    methods: {
      getPullRequestStatus: async (_url: string, number: number) => {
        const found = pullRequest(number);
        // Once the head is a merge of the base (or a conflict fix pushed as one), the branch has the base and no longer conflicts.
        const has = e2e().github.baseMerges.has(found.commit);
        const behind = state.baseAhead && !has;
        const conflicted = state.conflicted && !has;
        return {
          number, state: found.state, draft: found.draft === true, headSha: found.commit, baseBranch: found.baseBranch,
          mergeableState: conflicted ? "dirty" as const : behind ? "behind" as const : "clean" as const, mergeable: !conflicted, ...(conflicted ? {} : { behindBy: behind ? 1 : 0 }),
          checks: [{ name: "test", status: "completed" as const, conclusion: state.red ? "failure" as const : "success" as const, required: false, url: "https://github.com/example/demo/actions/runs/1/job/1" }],
          requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 0,
          reviews: state.approved ? [{ githubUserId: "9", login: "maint", userType: "User", state: "APPROVED" as const, commitId: found.commit, submittedAt: "2026-10-25T09:00:00.000Z" }] : [],
        };
      },
      getRepositoryPermission: async () => "write" as const,
      markPullRequestReady: async (_url: string, number: number) => { pullRequest(number).draft = false; return "ready" as const; },
      requestReviewers: async () => "requested" as const,
    },
  };
}

/** A version 2 task through its first pull request (waiting for the merge), with its program in place. */
async function waitingForMerge(options: { resolves?: boolean; autofix?: { enabled: boolean; capUsd: number; roundEstimateUsd: number }; checkResult?: (command: ProjectCommand) => { exitCode: number | null; stdout: string; stderr: string } | undefined } = {}) {
  const holder: { e2e?: WorkflowE2E } = {};
  const github = syncGithub(() => holder.e2e!);
  const prompts: string[] = [];
  const e2e = (holder.e2e = await createWorkflowE2E({
    model: { plan: PLAN, edits: (latest) => { prompts.push(latest); return latest.includes(CONFLICT_PATHS_BLOCK_HEADER) && options.resolves !== false ? RESOLVED : latest.includes(CI_OUTPUT_BLOCK_HEADER) ? FIXED : EDITS; } },
    trackingGithub: github.methods,
    ...(options.autofix === undefined ? {} : { autofix: options.autofix }),
    ...(options.checkResult === undefined ? {} : { checkResult: options.checkResult }),
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
  // Draft marked ready on the first pass, so every later pass is about the branch.
  e2e.clock.advance(60_000);
  await e2e.runMergeRecovery();
  return { e2e, github, prompts, pullRequest: e2e.github.pullRequests[0]! };
}

/** The owner presses Retry checks with the same checks, and the checks, the reviews and the move to waiting for the merge are run to the end. */
async function retryChecks(e2e: WorkflowE2E): Promise<void> {
  await e2e.click("agentx_workflow_retry_checks");
  await e2e.submitView({ workflow_checks: { selected_options: { selected_options: [] } } });
  await e2e.settle();
  for (let round = 0; round < 4; round += 1) {
    await e2e.runRecovery();
    await e2e.settle();
  }
}

/** The schedule's tracking pass, then the dispatch sweep that starts what it queued, then the worker, and so on until the task is quiet. */
async function trackAndRun(e2e: WorkflowE2E, rounds = 6): Promise<void> {
  // A quiet task is looked at again at the heartbeat; a webhook would wake it sooner.
  e2e.clock.advance(16 * 60_000);
  await e2e.runMergeRecovery();
  for (let round = 0; round < rounds; round += 1) {
    await e2e.runRecovery();
    await e2e.settle();
  }
}

describe("Suite 15: keeping the branch up to date", () => {
  journeySuite();

  it("15.1 behind a base that requires it, with a person's approval: the base is merged into the branch as a fast-forward, and the candidate moves to the new base", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const base = await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    const pushesBefore = e2e.github.pushLog.length;

    await trackAndRun(e2e);

    const after = e2e.workflow();
    // The merge is a NEW CANDIDATE (decision 67b): the task is not waiting for the merge until the merged code is checked and reviewed again.
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    expect(after.branchSync).toBeUndefined();
    // GitHub shows the merge: the old head first, the base commit second; nothing else was pushed, to no other branch.
    const merged = pullRequest.commit;
    expect(merged).not.toBe(before);
    expect(e2e.github.parents.get(merged)).toEqual([before, base]);
    const pushes = e2e.github.pushLog.slice(pushesBefore);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ branch: pullRequest.headBranch, commit: merged, parents: [before, base], during: "maintain" });
    // The workflow records the head, the head before it, and the candidate on the new base, so the next review diffs only Rovara's change.
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: merged, syncedFrom: before, candidateDigest: after.candidate!.digest });
    expect(after.candidate!.digest).not.toBe(beforeDigest);
    expect(after.candidate!.repositories[0]).toMatchObject({ commitSha: merged, baseCommitSha: base });
    expect(after.reviewBase).toEqual([{ repositoryId: "demo", baseCommitSha: base }]);
    // The earlier checks and reviews are not carried over to the merged code.
    expect(after.verification).toBeUndefined();
    expect(after.reviews ?? []).toEqual([]);
    expect(after.acceptedFindings ?? []).toEqual([]);
    // The day's merge is counted once, the row is gone, no fix round was used and nothing was said as stuck.
    expect(dispatchRows(e2e).filter((row) => row.kind === "SYNC")).toEqual([]);
    expect(after.fixRounds).toBeUndefined();
    // The task now waits for the owner: the milestone feed says so (a "needs you" line), once.
    expect(milestones(e2e, "stuck")).toEqual([expect.objectContaining({ text: WORKFLOW_BLOCK_REASONS.baseMergedRecheck })]);
    // The thread says why the task is not waiting for the merge yet, and offers the checks again.
    expect(said(e2e).at(-1)).toBe(WORKFLOW_BLOCK_REASONS.baseMergedRecheck);
    expect(actionIds(e2e.slack.posts.at(-1)!)).toEqual(expect.arrayContaining(["agentx_workflow_retry_checks", "agentx_workflow_close"]));
    // The workspace is on the merge, with the base's file.
    expect(await e2e.repoFile("upstream.ts")).toBe("export const upstream = 1;\n");
    // The pull request is not called ready, and no second merge starts, while the merged code is unchecked.
    const rows = dispatchRows(e2e).length;
    await trackAndRun(e2e, 2);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(dispatchRows(e2e)).toHaveLength(rows);
    expect(e2e.github.pushLog.slice(pushesBefore)).toHaveLength(1);

    // The owner's Retry checks runs the checks on the merged code (the candidate the host shows), then the reviews run again; only then does the task wait for the merge.
    await retryChecks(e2e);
    const rechecked = e2e.workflow();
    expect(rechecked).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(rechecked.candidate!.digest).toBe(after.candidate!.digest);
    expect(rechecked.verification?.candidateDigest).toBe(after.candidate!.digest);
    expect(rechecked.reviews?.length).toBeGreaterThan(0);
    expect(rechecked.reviews?.every((review) => review.candidateDigest === after.candidate!.digest)).toBe(true);
    expect(rechecked.pullRequests?.[0]).toMatchObject({ headSha: merged, candidateDigest: after.candidate!.digest });
    // Nothing more was pushed (the pull request already held the candidate), and the next pass reads a branch that has the base, on a head that is Rovara's.
    expect(e2e.github.pushLog.slice(pushesBefore)).toHaveLength(1);
    await trackAndRun(e2e, 2);
    expect(tracking(e2e)).toMatchObject({ syncs: { count: 1 }, headSha: merged, branch: "up_to_date", headByRovara: true });
    expect(e2e.github.pushLog.slice(pushesBefore)).toHaveLength(1);
  });

  it("15.2 behind with no approval: nothing is merged, and no machine is started", async () => {
    const { e2e, github } = await waitingForMerge();
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    github.state.approved = false;
    const pushesBefore = e2e.github.pushLog.length;
    const invocationsBefore = e2e.invocations.length;
    await trackAndRun(e2e, 2);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pushLog).toHaveLength(pushesBefore);
    expect(e2e.invocations).toHaveLength(invocationsBefore);
    expect(tracking(e2e)?.syncs).toMatchObject({ count: 0 });
  });

  it("15.3 a person pushes to the branch before the merge starts: nothing is merged over their push", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    // The tracking pass queues the merge; before the dispatch sweep starts it, a person pushes.
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "READY", branchSync: { reason: "behind" } });
    const foreign = e2e.github.foreignPush(pullRequest.number);
    const pushesBefore = e2e.github.pushLog.length;
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().branchSync).toBeUndefined();
    expect(e2e.github.pushLog).toHaveLength(pushesBefore);
    expect(pullRequest.commit).toBe(foreign.commit);
    expect(e2e.invocations.filter((invocation) => invocation.kind === "maintain")).toHaveLength(0);
    // And the next passes leave a head that is a person's alone.
    await trackAndRun(e2e, 2);
    expect(e2e.github.pushLog).toHaveLength(pushesBefore);
    expect(e2e.invocations.filter((invocation) => invocation.kind === "maintain")).toHaveLength(0);
  });

  it("15.4 a conflict becomes one coding round: the files are named to the coder, the fix is checked and reviewed, and it is pushed as a merge commit of the old head and the base commit", async () => {
    const { e2e, github, prompts, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const base = await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    const pushesBefore = e2e.github.pushLog.length;
    const promptsBefore = prompts.length;

    await trackAndRun(e2e);

    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { ci: 0, conflict: 1, feedbackAuto: 0 } });
    expect(after.fixSource).toBeUndefined();
    expect(after.conflictBase).toBeUndefined();
    // The coder was told which file, in the exact block, and that it cannot push.
    const conflictPrompt = prompts.slice(promptsBefore).find((prompt) => prompt.includes(CONFLICT_PATHS_BLOCK_HEADER))!;
    expect(conflictPrompt).toBeDefined();
    expect(conflictPrompt.indexOf("the merge conflicts")).toBeLessThan(conflictPrompt.indexOf(CONFLICT_PATHS_BLOCK_HEADER));
    expect(conflictPrompt).toContain('["greeting.ts"]');
    expect(conflictPrompt).toContain("you cannot push");
    // One merge commit, a fast-forward of the old head with the base commit second; the fix's own checks and reviews ran before it.
    const merged = pullRequest.commit;
    expect(e2e.github.parents.get(merged)).toEqual([before, base]);
    const pushes = e2e.github.pushLog.slice(pushesBefore);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ branch: pullRequest.headBranch, parents: [before, base], during: "maintain" });
    expect(await e2e.repoFile("greeting.ts")).toBe(RESOLVED[0]!.content);
    // The candidate is on the new base now, with no head to carry an approval from.
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: merged, candidateDigest: after.candidate!.digest });
    expect(after.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(after.candidate!.repositories[0]).toMatchObject({ baseCommitSha: base });
    expect(after.reviewBase).toEqual([{ repositoryId: "demo", baseCommitSha: base }]);
    // Told to the person once, and the merge counted once for the day.
    expect(milestones(e2e, "fixing")).toEqual([expect.objectContaining({ text: "The branch conflicts with main, so Rovara is resolving it (try 1 of 2)." })]);
    expect(said(e2e).some((text) => /^The pull request's branch conflicts with the base branch \(greeting\.ts\)\./u.test(text))).toBe(true);
    // The next pass reads a branch that has the base.
    await trackAndRun(e2e, 1);
    expect(tracking(e2e)).toMatchObject({ syncs: { count: 1 }, branch: "up_to_date", headSha: merged });
    expect(dispatchRows(e2e)).toEqual([]);
  });

  it("15.5 a conflict fix pushed as a merge commit whose second parent is not the base commit is refused: the pull request keeps the head and code it had, and the task says the push failed", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    const base = await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    // The merge (the first maintain run) is as it was; GitHub shows the fix's push (the second) with another second parent.
    e2e.worker.rewriteNextResult("maintain", (result) => result);
    e2e.worker.rewriteNextResult("maintain", (result) => {
      const pushed = (result as { commit: string }).commit;
      e2e.github.parents.set(pushed, [before, "e".repeat(40)]);
      return result;
    });
    await trackAndRun(e2e);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: before, candidateDigest: beforeDigest });
    expect(after.pullRequestUpdateFailure?.numbers).toEqual([pullRequest.number]);
    // The fix's candidate was made on the base commit that conflicted (its reviewers saw the diff against it); the pull request still holds the code it had.
    expect(after.candidate!.repositories[0]!.baseCommitSha).toBe(base);
    expect(after.pullRequests?.[0]?.candidateDigest).toBe(beforeDigest);
  });

  it("15.6 two conflict rounds that did not help stop with the exact text and a stuck milestone, and no machine starts", async () => {
    const { e2e, github } = await waitingForMerge();
    await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    const stored = task(e2e);
    e2e.db.set({ ...stored, workflow: { ...(stored.workflow as object), fixRounds: { ci: 0, conflict: 2, feedbackAuto: 0 } } });
    const invocationsBefore = e2e.invocations.length;
    await trackAndRun(e2e, 2);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: branchConflictStopMessage("main") });
    expect(e2e.invocations).toHaveLength(invocationsBefore);
    expect(milestones(e2e, "stuck")).toEqual([expect.objectContaining({ text: "The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task." })]);
    expect(dispatchRows(e2e)).toEqual([]);
  });

  it("15.7 GitHub refusing the push because the base changed CI workflow files stops with the exact text, and is not a conflict round", async () => {
    const { e2e, github } = await waitingForMerge();
    await e2e.advanceBase(".github/workflows/ci.yml", "name: ci\n");
    github.state.baseAhead = true;
    e2e.worker.failNext("maintain", "RUNTIME_UNAVAILABLE: ! [remote rejected] HEAD -> agentx/x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)");
    const pushesBefore = e2e.github.pushLog.length;
    await trackAndRun(e2e, 3);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_WORKFLOW_FILES_MESSAGE });
    expect(after.fixRounds).toBeUndefined();
    expect(after.branchSync).toBeUndefined();
    expect(milestones(e2e, "stuck")).toEqual([expect.objectContaining({ text: BRANCH_WORKFLOW_FILES_MESSAGE })]);
    expect(milestones(e2e, "fixing")).toEqual([]);
    expect(e2e.github.pushLog).toHaveLength(pushesBefore);
    // It does not go on trying: the task waits for a person (a block is not woken by the schedule), and the merge is still followed.
    expect(dispatchRows(e2e)).toEqual([]);
  });

  /** The task's frozen recipe says how far Rovara may go on its own. */
  const freezeAutonomy = (e2e: WorkflowE2E, autonomy: "suggest" | "prepare" | "run") =>
    e2e.db.set({ ...taskRecipeKey(e2e.taskId()), entityType: "TASK_RECIPE", orgId: TEST_ORG, recipe: { ...structuredClone(EMPTY_RECIPE), autonomy }, digest: "d".repeat(64) });

  it("15.9 with the agent set to suggest a conflict is asked about, not left silent: no machine starts; the owner's Retry (the MCP tool) lets the next pass resolve it, once", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    freezeAutonomy(e2e, "suggest");
    const base = await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    const invocationsBefore = e2e.invocations.length;
    await trackAndRun(e2e, 2);
    const asked = e2e.workflow();
    expect(asked).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: branchConflictAskMessage("main") });
    expect(e2e.invocations).toHaveLength(invocationsBefore);
    expect(said(e2e).at(-1)).toBe(asked.blockReason + TASK_LINK_RETRY);
    expect(milestones(e2e, "stuck")).toHaveLength(1);
    expect((await e2e.mcp("agentx_get_task", { task_id: e2e.taskId() })).text ?? "").toContain("agentx_retry_workflow");

    const done = await e2e.mcp("agentx_retry_workflow", { task_id: e2e.taskId(), request_id: "11111111-2222-4333-8444-555555555561", instructions: "Resolve it.", expected_revision: asked.revision });
    expect(done.isError, JSON.stringify(done)).not.toBe(true);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", conflictApproved: [before] });
    await trackAndRun(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { conflict: 1 } });
    expect(e2e.workflow().conflictApproved).toBeUndefined();
    expect(e2e.github.parents.get(pullRequest.commit)).toEqual([before, base]);
  }, 240_000);

  it("15.10 autonomy is read again where the paid round would start: switched to suggest while the merge was queued, the conflict is asked about and no coding run starts", async () => {
    const { e2e, github, prompts } = await waitingForMerge();
    await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    expect(e2e.workflow()).toMatchObject({ state: "READY", branchSync: { reason: "conflict" } });
    freezeAutonomy(e2e, "suggest");
    const promptsBefore = prompts.length;
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: branchConflictAskMessage("main") });
    expect(prompts).toHaveLength(promptsBefore);
    expect(milestones(e2e, "fixing")).toEqual([]);
    expect(milestones(e2e, "stuck")).toHaveLength(1);
  }, 240_000);

  it("15.11 a behind merge that really fails is tried twice on the same head, then gives up once, in fixed words, without blocking the task: it stays behind and CI fixes still run", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const head = pullRequest.commit;
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    const maintains = () => e2e.invocations.filter((invocation) => invocation.kind === "maintain" && invocation.payload.action === "sync").length;
    e2e.worker.failNext("maintain", "CONFIG_INVALID: one or more registered readiness checks failed");
    await trackAndRun(e2e, 3);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", syncFailures: { headSha: head, count: 1 } });
    expect(milestones(e2e, "stuck")).toEqual([]);
    e2e.worker.failNext("maintain", "CONFIG_INVALID: one or more registered readiness checks failed");
    await trackAndRun(e2e, 3);
    const text = "Rovara couldn't bring the branch up to date: the project's checks fail once the base is merged in. Update it on GitHub.";
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", syncFailures: { headSha: head, count: 2 } });
    expect(e2e.workflow().blockReason).toBeUndefined();
    expect(milestones(e2e, "stuck")).toEqual([expect.objectContaining({ text })]);
    expect(maintains()).toBe(2);
    // A day later it is still not tried again, and a failing CI is fixed all the same.
    e2e.clock.advance(26 * 60 * 60_000);
    github.state.red = true;
    await trackAndRun(e2e);
    expect(maintains()).toBe(2);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { ci: 1 } });
    expect(milestones(e2e, "stuck")).toHaveLength(1);
  }, 240_000);

  it("15.12 a failure that is not the merge's (GitHub, a lost machine) never stops it: it is tried again later and goes through", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const base = await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    for (let failure = 0; failure < 3; failure += 1) {
      e2e.worker.failNext("maintain", "RUNTIME_UNAVAILABLE: GitHub answered 503");
      await trackAndRun(e2e, 3);
      expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", syncFailures: { count: 0, transient: failure + 1 } });
      expect(milestones(e2e, "stuck")).toEqual([]);
      e2e.clock.advance(7 * 60 * 60_000);
    }
    await trackAndRun(e2e, 3);
    expect(e2e.github.parents.get(pullRequest.commit)).toEqual([before, base]);
    expect(e2e.workflow().syncFailures).toBeUndefined();
  }, 240_000);

  it("15.13 a conflict merge that really fails twice blocks the task, and the owner's Retry (MCP) is one more try", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const base = await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    for (let failure = 0; failure < 2; failure += 1) {
      e2e.worker.failNext("maintain", "CONFIG_INVALID: one or more registered readiness checks failed");
      await trackAndRun(e2e, 3);
    }
    const stopped = e2e.workflow();
    expect(stopped).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: branchSyncGiveUpMessage("checks") });
    expect(milestones(e2e, "stuck")).toHaveLength(1);
    expect((await e2e.mcp("agentx_get_task", { task_id: e2e.taskId() })).text ?? "").toContain("agentx_retry_workflow");
    const done = await e2e.mcp("agentx_retry_workflow", { task_id: e2e.taskId(), request_id: "11111111-2222-4333-8444-555555555571", instructions: "Try again.", expected_revision: stopped.revision });
    expect(done.isError, JSON.stringify(done)).not.toBe(true);
    expect(e2e.workflow()).toMatchObject({ state: "WAITING", syncFailures: { count: 1 } });
    await trackAndRun(e2e);
    expect(e2e.github.parents.get(pullRequest.commit)).toEqual([before, base]);
  }, 240_000);

  it("15.14 GitHub unreadable through the whole retry budget after a lost merge ends with a visible stop, never a silent stall", async () => {
    const { e2e, github } = await waitingForMerge();
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    e2e.worker.crashNext("maintain", { afterPush: true });
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    await e2e.runRecovery();
    await e2e.settle();
    e2e.github.failNext("getPullRequestFeedback", 503, 1_000);
    for (let round = 0; round < 14; round += 1) {
      await e2e.runRecovery();
      await e2e.settle();
      e2e.clock.advance(3 * 60 * 60_000);
    }
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_SYNC_UNSURE_MESSAGE });
    expect(e2e.workflow().branchSync).toBeUndefined();
    expect(milestones(e2e, "stuck")).toEqual([expect.objectContaining({ text: BRANCH_SYNC_UNSURE_MESSAGE })]);
  }, 240_000);

  it("15.15 a CI or feedback fix starts from the pull request's head (so an abandoned conflict round's files are gone); a conflict round does not, it works on the merge's files", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const head = pullRequest.commit;
    github.state.red = true;
    await trackAndRun(e2e);
    const fixRun = e2e.invocations.find((invocation) => invocation.kind === "task" && invocation.payload.workflowFix?.source === "ci");
    expect(fixRun?.kind === "task" && fixRun.payload.workflowFix).toEqual({ source: "ci", startFrom: head });
    github.state.red = false;
    await e2e.advanceBase("greeting.ts", BASE_GREETING);
    github.state.conflicted = true;
    await trackAndRun(e2e);
    const conflictRun = e2e.invocations.find((invocation) => invocation.kind === "task" && invocation.payload.workflowFix?.source === "conflict");
    expect(conflictRun?.kind === "task" && conflictRun.payload.workflowFix).toEqual({ source: "conflict" });
  }, 240_000);

  it("15.8 a merge whose machine is lost after its push is judged from what GitHub shows: exactly [recorded head, asked base] is recorded as the new candidate (decision 67b), with no approval to carry, and checked again", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const base = await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    // The worker pushes, then its machine is lost: no callback of any kind.
    e2e.worker.crashNext("maintain", { afterPush: true });
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.github.parents.get(pullRequest.commit)).toEqual([before, base]);
    // Until the reconciler ends the lost run and the sweep judges it, the task is still merging: nothing else is decided about the new head.
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    await e2e.runRecovery();
    await e2e.runRecovery();
    await e2e.settle();
    const after = e2e.workflow();
    // Rovara's own merge is on the pull request: it is the new candidate, blocked until its checks and reviews run again, and the head is Rovara's (not "someone else pushed").
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    expect(after.branchSync).toBeUndefined();
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: pullRequest.commit, candidateDigest: after.candidate!.digest });
    expect(after.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(after.candidate!.repositories[0]).toMatchObject({ commitSha: pullRequest.commit, baseCommitSha: base });
    expect(after.verification).toBeUndefined();
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(pullRequest.commit);
    await trackAndRun(e2e, 1);
    expect(tracking(e2e)).toMatchObject({ headByRovara: true, headSha: pullRequest.commit });
    expect(said(e2e).some((text) => text.startsWith("Someone else pushed"))).toBe(false);
    // The owner's Retry checks and the reviews follow, then the task waits for the merge.
    await retryChecks(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  });

  it("15.8b a lost merge GitHub does not show as exactly the merge asked for is not recorded: the record keeps the head, and the head is read as someone else's", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    e2e.worker.crashNext("maintain", { afterPush: true });
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    await e2e.runRecovery();
    await e2e.settle();
    // GitHub shows the pushed commit with another second parent.
    e2e.github.parents.set(pullRequest.commit, [before, "e".repeat(40)]);
    await e2e.runRecovery();
    await e2e.runRecovery();
    await e2e.settle();
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: before, candidateDigest: beforeDigest });
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(before);
    await trackAndRun(e2e, 1);
    expect(tracking(e2e)).toMatchObject({ headByRovara: false, headSha: pullRequest.commit });
  });

  it("15.19 a Send back from the recheck of a merged base is a coding run that may leave the code as it is: it is not refused as a fix that changed nothing, and it is checked, reviewed and waits for the merge", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const base = await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    await trackAndRun(e2e);
    const merged = e2e.workflow();
    expect(merged).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    const mergedCommit = pullRequest.commit;
    expect(actionIds(e2e.slack.posts.at(-1)!)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
    const pushes = e2e.github.pushLog.length;
    await e2e.click("agentx_workflow_send_back");
    if (e2e.slack.views.length > 0) await e2e.submitView({});
    await e2e.settle();
    for (let round = 0; round < 4; round += 1) { await e2e.runRecovery(); await e2e.settle(); }
    const after = e2e.workflow();
    // Not "the approved fix didn't change any code": the coding run, its checks and its reviews ran, and the task waits for the merge with the pull request holding the code it holds.
    expect(after.blockReason).not.toBe(WORKFLOW_BLOCK_REASONS.fixChangedNothing);
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: mergedCommit, candidateDigest: after.candidate!.digest });
    expect(after.verification?.candidateDigest).toBe(after.candidate!.digest);
    expect(e2e.github.pushLog).toHaveLength(pushes);
    expect(base).toBeDefined();
  });

  it("15.16 a merge of the base is not called ready before its checks and reviews pass again: a draft stays a draft until then", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    await trackAndRun(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    // The pull request is a draft that was not marked ready yet (undone here, as a pull request that never had its first pass).
    const { readyAt: _readyAt, ...rest } = tracking(e2e)! as Record<string, unknown>;
    void _readyAt;
    e2e.db.set(rest);
    pullRequest.draft = true;
    // Green CI on the merged head, a head that is Rovara's: still a draft, while the merged code is unchecked.
    await trackAndRun(e2e, 2);
    expect(pullRequest.draft).toBe(true);
    expect(tracking(e2e)).toMatchObject({ headByRovara: true });
    // The checks pass, the reviews pass, the task waits for the merge: the next pass takes it out of draft.
    await retryChecks(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await trackAndRun(e2e, 2);
    expect(pullRequest.draft).toBe(false);
  });

  it("15.17 the merged code is checked on the code the host shows: a workspace that holds other code than the merge is refused, and nothing is recorded as checked", async () => {
    const { e2e, github } = await waitingForMerge();
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    await trackAndRun(e2e);
    const merged = e2e.workflow();
    expect(merged).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    // Extra changes the merge on the host does not have are in the workspace.
    await writeFile(join(e2e.repoDirectory, "extra.ts"), "export const extra = 1;\n");
    await retryChecks(e2e);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checkedOtherCode });
    expect(after.candidate!.digest).toBe(merged.candidate!.digest);
    expect(after.verification).toBeUndefined();
    expect(after.reviews ?? []).toEqual([]);
  });

  it("15.18 a merge pushed with parents that are not the recorded head and the base commit is refused at the callback: the record keeps the head, and nothing is recorded", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge();
    const before = pullRequest.commit;
    const beforeDigest = e2e.workflow().candidate!.digest;
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    // GitHub shows the pushed merge with another second parent.
    e2e.worker.rewriteNextResult("maintain", (result) => {
      e2e.github.parents.set((result as { commit: string }).commit, [before, "e".repeat(40)]);
      return result;
    });
    e2e.clock.advance(16 * 60_000);
    await e2e.runMergeRecovery();
    for (let round = 0; round < 4; round += 1) { await e2e.runRecovery(); await e2e.settle(); }
    expect(pullRequestRecord(e2e).expectedHeadCommit).toBe(before);
    const after = e2e.workflow();
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: before, candidateDigest: beforeDigest });
    expect(after.candidate!.digest).toBe(beforeDigest);
    expect(after.stage).not.toBe("VERIFY");
  });

  // ---- decision 70(c): the checks re-run by themselves after a merge of the base

  const ON = { enabled: true, capUsd: 15, roundEstimateUsd: 3 };
  const autoRetries = (e2e: WorkflowE2E) => e2e.workflow().decisions.filter((decision) => decision.source === "AUTO_RETRY");
  const autofixRows = (e2e: WorkflowE2E) => dispatchRows(e2e).filter((row) => row.kind === "AUTOFIX");
  const checkRuns = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "CHECKS");

  it("15.20 where Rovara may act, the merged code's checks re-run by themselves, then the reviews, then the task waits for the merge, with one automatic retry recorded", async () => {
    const { e2e, github, pullRequest } = await waitingForMerge({ autofix: ON });
    freezeAutonomy(e2e, "run");
    const before = e2e.workflow().candidate!.digest;
    const base = await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    const pushesBefore = e2e.github.pushLog.length;
    const checksBefore = checkRuns(e2e).length;
    await trackAndRun(e2e);
    // No owner press: the block committed with its AUTOFIX row, the look ran right after, the checks and the reviews followed.
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.candidate!.digest).not.toBe(before);
    expect(after.candidate!.repositories[0]).toMatchObject({ commitSha: pullRequest.commit, baseCommitSha: base });
    expect(after.verification?.candidateDigest).toBe(after.candidate!.digest);
    expect(after.reviews?.length).toBeGreaterThan(0);
    expect(after.reviews?.every((review) => review.candidateDigest === after.candidate!.digest)).toBe(true);
    expect(checkRuns(e2e).length).toBeGreaterThan(checksBefore);
    // One automatic retry, as Rovara, for the merged candidate; nothing was pushed but the merge.
    expect(autoRetries(e2e)).toHaveLength(1);
    expect(autoRetries(e2e)[0]).toMatchObject({ actorRole: "AGENTX", decision: "REQUEST_CHANGES", auto: { stage: "VERIFY", candidateDigest: after.candidate!.digest } });
    expect(autofixRows(e2e)).toEqual([]);
    expect(e2e.github.pushLog.slice(pushesBefore)).toHaveLength(1);
    // The pull request may now be called ready (only here), and the head is Rovara's.
    await trackAndRun(e2e, 2);
    expect(tracking(e2e)).toMatchObject({ headByRovara: true, headSha: pullRequest.commit });
  });

  it("15.21 set to suggest when the merge lands, Rovara asks and does not re-run the checks; the owner's Retry still does", async () => {
    const { e2e, github } = await waitingForMerge({ autofix: ON });
    freezeAutonomy(e2e, "run");
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    // The merge was queued where Rovara may act; by the time its result lands the autonomy is lowered (the autonomy is read again where the re-run would start).
    e2e.worker.rewriteNextResult("maintain", (result) => { freezeAutonomy(e2e, "suggest"); return result; });
    const checksBefore = checkRuns(e2e).length;
    await trackAndRun(e2e);
    const asked = e2e.workflow();
    expect(asked).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    expect(task(e2e).autofixAsk).toMatchObject({ reason: "autonomy-suggest", codes: ["base-merged"] });
    expect(checkRuns(e2e)).toHaveLength(checksBefore);
    expect(autoRetries(e2e)).toEqual([]);
    expect(autofixRows(e2e)).toEqual([]);
    // The owner's own Retry runs them, as before.
    await retryChecks(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  });

  it("15.22 with the task's spend at the automatic cap, Rovara asks (spend) and does not re-run the checks", async () => {
    const { e2e, github } = await waitingForMerge({ autofix: { enabled: true, capUsd: 0, roundEstimateUsd: 3 } });
    freezeAutonomy(e2e, "run");
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    const checksBefore = checkRuns(e2e).length;
    await trackAndRun(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    expect(task(e2e).autofixAsk).toMatchObject({ reason: "spend-cap", codes: ["base-merged"] });
    expect(checkRuns(e2e)).toHaveLength(checksBefore);
    expect(autoRetries(e2e)).toEqual([]);
  });

  it("15.23 a re-run that fails is the normal rules: no second automatic retry for the same code, the owner decides", async () => {
    let failing = false;
    const { e2e, github } = await waitingForMerge({ autofix: ON, checkResult: (command) => (failing && JSON.stringify(command) === JSON.stringify(E2E_CHECK) ? { exitCode: 1, stdout: "", stderr: "AssertionError: the merged code fails\n" } : undefined) });
    freezeAutonomy(e2e, "run");
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    failing = true;
    await trackAndRun(e2e);
    const after = e2e.workflow();
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(after.blockReason).not.toBe(WORKFLOW_BLOCK_REASONS.baseMergedRecheck);
    // The one automatic retry was spent on this code; the failed re-run is blocked with no further automatic move (a pull request is open: the owner decides).
    expect(autoRetries(e2e)).toHaveLength(1);
    const runsBefore = checkRuns(e2e).length;
    await trackAndRun(e2e, 3);
    expect(checkRuns(e2e)).toHaveLength(runsBefore);
    expect(autoRetries(e2e)).toHaveLength(1);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  });

  it("15.24 with automatic fixing off nothing re-runs by itself: the owner's Retry is the way, as before", async () => {
    const { e2e, github } = await waitingForMerge();
    freezeAutonomy(e2e, "run");
    await e2e.advanceBase("upstream.ts", "export const upstream = 1;\n");
    github.state.baseAhead = true;
    const checksBefore = checkRuns(e2e).length;
    await trackAndRun(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck });
    expect(checkRuns(e2e)).toHaveLength(checksBefore);
    expect(autofixRows(e2e)).toEqual([]);
  });

});
