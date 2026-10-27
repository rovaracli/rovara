// Rovara Code (Plan 6 Task 17), through the whole broker: a version 2 task's pull request falls behind a base that requires an up-to-date branch (with a person's approval) or conflicts with it. The
// schedule's tracking pass queues a merge of the base, the dispatch sweep starts it, the worker (real Git) merges exactly the base commit, and the broker records what GitHub shows. A clean merge keeps
// the pull request's head a fast-forward and moves the candidate to the new base; a conflict becomes one coding round, checked, reviewed and pushed as a merge commit whose parents are the old head and
// the base commit; GitHub refusing workflow files stops with its text. Nothing is rebased, nothing is force-pushed, and a person's push wins.
import { describe, expect, it } from "vitest";
import { CI_OUTPUT_BLOCK_HEADER, BRANCH_SYNC_UNSURE_MESSAGE, BRANCH_WORKFLOW_FILES_MESSAGE, branchSyncGiveUpMessage, branchConflictAskMessage, CONFLICT_PATHS_BLOCK_HEADER, EMPTY_RECIPE, WorkflowSnapshotSchema, branchConflictStopMessage, type WorkflowProgram } from "@agentx/contracts";
import { taskRecipeKey } from "../../../packages/broker/src/developer/task-records.js";
import { TEST_ORG } from "../../support/orgs.js";
import { mergeTrackingKey } from "../../../packages/contracts/src/org-scoped-keys.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, FIXED, PLAN, atPlanReview, journeySuite, said } from "../../support/workflow-e2e-journeys.js";

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const RESOLVED = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n" }];
const BASE_GREETING = "export function greet(name: string): string {\n  return 'Hi ' + name;\n}\n";

const task = (e2e: WorkflowE2E) => e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!;
const dispatchRows = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const milestones = (e2e: WorkflowE2E, kind: string) => e2e.db.find((item) => item.entityType === "CODE_MILESTONE" && item.kind === kind);
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
async function waitingForMerge(options: { resolves?: boolean } = {}) {
  const holder: { e2e?: WorkflowE2E } = {};
  const github = syncGithub(() => holder.e2e!);
  const prompts: string[] = [];
  const e2e = (holder.e2e = await createWorkflowE2E({
    model: { plan: PLAN, edits: (latest) => { prompts.push(latest); return latest.includes(CONFLICT_PATHS_BLOCK_HEADER) && options.resolves !== false ? RESOLVED : latest.includes(CI_OUTPUT_BLOCK_HEADER) ? FIXED : EDITS; } },
    trackingGithub: github.methods,
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
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
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
    expect(after.verification?.candidateDigest).toBe(after.candidate!.digest);
    expect(after.reviews?.every((review) => review.candidateDigest === after.candidate!.digest)).toBe(true);
    // The day's merge is counted once, the row is gone, no fix round was used and nothing was said as stuck.
    expect(dispatchRows(e2e).filter((row) => row.kind === "SYNC")).toEqual([]);
    expect(after.fixRounds).toBeUndefined();
    expect(milestones(e2e, "stuck")).toEqual([]);
    // The thread says so once, in its own words (a merge of the base is not a fix).
    expect(said(e2e).at(-1)).toBe(`Brought PR #${pullRequest.number} up to date with its base branch. Approve the PR on GitHub, then press Merge in Rovara; I'll finish this task when it's merged.`);
    // The workspace is on the merge, with the base's file.
    expect(await e2e.repoFile("upstream.ts")).toBe("export const upstream = 1;\n");
    // It does not merge again: the next pass reads a branch that has the base, on a head that is Rovara's.
    const rows = dispatchRows(e2e).length;
    await trackAndRun(e2e, 2);
    expect(tracking(e2e)).toMatchObject({ syncs: { count: 1 }, headSha: merged, branch: "up_to_date", headByRovara: true });
    expect(dispatchRows(e2e)).toHaveLength(rows);
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
    expect(said(e2e).at(-1)).toBe(asked.blockReason);
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

  it("15.8 a merge whose machine is lost after its push is judged from what GitHub shows: the merge is recorded as Rovara's own (with no approval to carry), and nothing false is said", async () => {
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
    expect(after).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.branchSync).toBeUndefined();
    expect(after.pullRequests?.[0]).toMatchObject({ headSha: pullRequest.commit, candidateDigest: after.candidate!.digest });
    expect(after.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(after.candidate!.repositories[0]).toMatchObject({ commitSha: pullRequest.commit, baseCommitSha: base });
    // The head is Rovara's own: the thread never says someone else pushed, and a red CI on it is fixed.
    await trackAndRun(e2e, 1);
    expect(tracking(e2e)).toMatchObject({ headByRovara: true, headSha: pullRequest.commit });
    expect(said(e2e).some((text) => text.startsWith("Someone else pushed"))).toBe(false);
    github.state.red = true;
    await trackAndRun(e2e);
    expect(e2e.workflow().fixRounds).toMatchObject({ ci: 1 });
  });
});
