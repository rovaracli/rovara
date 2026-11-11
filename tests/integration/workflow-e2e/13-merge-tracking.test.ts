// Rovara Code (Plan 6 Task 14), through the whole broker: a version 2 task's recovery row becomes its tracking row when its first pull request opens, the merge-recovery
// schedule runs the tracking pass beside the merge pass, GitHub's check and status deliveries wake the row, and a version 1 task keeps the row it always had.
import { describe, expect, it } from "vitest";
import { mergeTrackingKey, prHeadKey } from "@rovara-code/contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { PLAN, atPlanReview, editsOrFix, journeySuite } from "../../support/workflow-e2e-journeys.js";
import { TEST_ORG } from "../../support/orgs.js";

const recovery = (e2e: WorkflowE2E) => e2e.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${e2e.taskId()}`);
const task = (e2e: WorkflowE2E) => e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!;

/** The fake GitHub's pull request, as merge tracking's reads see it. */
function trackingGithub(e2e: () => WorkflowE2E) {
  const calls: string[] = [];
  const pullRequest = (number: number) => e2e().github.pullRequests.find((entry) => entry.number === number)!;
  return {
    calls,
    methods: {
      getPullRequestStatus: async (_url: string, number: number) => {
        calls.push(`status:${String(number)}`);
        const found = pullRequest(number);
        return {
          number, state: found.state, draft: found.draft === true, headSha: found.commit, baseBranch: found.baseBranch, mergeableState: "clean" as const, mergeable: true, behindBy: 0,
          checks: [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }],
          requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 0, reviews: [],
        };
      },
      getRepositoryPermission: async () => "none" as const,
      markPullRequestReady: async (_url: string, number: number) => { calls.push(`ready:${String(number)}`); pullRequest(number).draft = false; return "ready" as const; },
      requestReviewers: async () => "requested" as const,
    },
  };
}

async function openDraftPrAs(e2e: WorkflowE2E, version: "1.0.0" | "1.1.0") {
  await atPlanReview(e2e);
  const current = task(e2e);
  e2e.db.set({ ...current, workflow: { ...(current.workflow as object), definitionVersion: version } });
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  return e2e.github.pullRequests[0]!;
}

describe("Suite 13: merge tracking", () => {
  journeySuite();

  it("13.1 a version 2 task's first pull request makes its recovery row its tracking row, and indexes the head by commit and branch", async () => {
    const holder: { e2e?: WorkflowE2E } = {};
    const github = trackingGithub(() => holder.e2e!);
    const e2e = (holder.e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, trackingGithub: github.methods }));
    const pullRequest = await openDraftPrAs(e2e, "1.1.0");
    expect(recovery(e2e)).toMatchObject({ kind: "tracking", dispatchDuePk: "WORKFLOW_MERGE_TRACKING", attempts: 0 });
    const lead = e2e.db.get(prHeadKey(TEST_ORG, "example/demo", pullRequest.commit));
    expect(lead).toMatchObject({ taskId: e2e.taskId(), orgId: TEST_ORG, number: pullRequest.number });
    expect(e2e.db.get(prHeadKey(TEST_ORG, "example/demo", `branch:${pullRequest.headBranch}`))).toMatchObject({ taskId: e2e.taskId() });
  }, 120_000);

  it("13.2 a version 1 task keeps the merge row it always had, and no head index", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPrAs(e2e, "1.0.0");
    expect(recovery(e2e)?.kind).toBeUndefined();
    expect(recovery(e2e)?.dispatchDuePk).toBe("WORKFLOW_MERGE_RECOVERY");
    expect(e2e.db.get(prHeadKey(TEST_ORG, "example/demo", pullRequest.commit))).toBeUndefined();
    expect(e2e.db.find((item) => item.entityType === "MERGE_TRACKING")).toEqual([]);
    // The schedule runs the tracking pass too, and finds nothing of this task's.
    e2e.clock.advance(5 * 60_000);
    const response = await e2e.runMergeRecovery();
    expect(response.body).toMatchObject({ attempted: 1, tracking: { attempted: 0 } });
  }, 120_000);

  it("13.3 the schedule's tracking pass reads GitHub, keeps the item, marks the draft ready, and a merge on GitHub is recorded at the old cadence", async () => {
    const holder: { e2e?: WorkflowE2E } = {};
    const github = trackingGithub(() => holder.e2e!);
    const e2e = (holder.e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, trackingGithub: github.methods }));
    const pullRequest = await openDraftPrAs(e2e, "1.1.0");
    expect(pullRequest.draft).toBe(true);
    e2e.clock.advance(60_000);
    const first = await e2e.runMergeRecovery();
    expect(first.body).toMatchObject({ tracking: { attempted: 1, reconciled: 1 } });
    expect(github.calls).toContain(`ready:${String(pullRequest.number)}`);
    expect(e2e.db.get(mergeTrackingKey(e2e.taskId(), "demo", pullRequest.number))).toMatchObject({ state: "open", draft: false, ci: "passing", headByRovara: true, version: 1 });
    expect(e2e.db.get(mergeTrackingKey(e2e.taskId(), "demo", pullRequest.number))?.readyAt).toBeDefined();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });

    // GitHub says the pull request merged: the next tracking pass runs today's merge observation, which records the merge.
    e2e.github.merge(pullRequest.number);
    e2e.clock.advance(15 * 60_000);
    await e2e.runMergeRecovery();
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    // The finished task gives its slot and workspace back, and its row is retired, as for any task.
    await e2e.runRecovery();
    await e2e.settle();
    e2e.clock.advance(60_000);
    await e2e.runMergeRecovery();
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.releasedAt).toBeDefined();
  }, 120_000);

  it("13.4 a check_run delivery for the pull request's head brings the row forward, and one for another commit changes nothing", async () => {
    const holder: { e2e?: WorkflowE2E } = {};
    const github = trackingGithub(() => holder.e2e!);
    const e2e = (holder.e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, trackingGithub: github.methods }));
    const pullRequest = await openDraftPrAs(e2e, "1.1.0");
    e2e.clock.advance(60_000);
    await e2e.runMergeRecovery();
    const settled = recovery(e2e)!;
    expect(settled.nextAttemptAt).toBe(e2e.clock.now() + 15 * 60_000);
    const send = (head: string, branch: string | null) => e2e.signedWebhook("check_run", { action: "completed", check_run: { head_sha: head, check_suite: { head_branch: branch } } });
    // A commit and branch no task follows: ignored, and the row is as it was.
    const stranger = await send("9".repeat(40), "feature/x");
    expect(stranger.status).toBe(202);
    expect(stranger.body).toMatchObject({ delivery: "IGNORED" });
    expect(recovery(e2e)).toEqual(settled);
    // The pull request's head: accepted, and the row is due 30 seconds from now.
    const woken = await send(pullRequest.commit, null);
    expect(woken.status).toBe(200);
    expect(woken.body).toMatchObject({ delivery: "ACCEPTED" });
    expect(recovery(e2e)).toMatchObject({ wakeAt: e2e.clock.now(), nextAttemptAt: e2e.clock.now() + 30_000 });
    // Five more for the same head leave the due time where it is.
    const due = recovery(e2e)!.nextAttemptAt;
    for (let delivery = 0; delivery < 5; delivery += 1) await send(pullRequest.commit, null);
    expect(recovery(e2e)!.nextAttemptAt).toBe(due);
    // The pass after the wake reads GitHub once more.
    github.calls.length = 0;
    e2e.clock.advance(60_000);
    expect((await e2e.runMergeRecovery()).body).toMatchObject({ tracking: { attempted: 1 } });
    expect(github.calls.filter((call) => call.startsWith("status"))).toEqual([`status:${String(pullRequest.number)}`]);
  }, 120_000);
});
