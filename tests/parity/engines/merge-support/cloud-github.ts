// The fake GitHub as Cloud's merge tracking reads it (the `trackingGithub` seam of the journey harness): whether the base is ahead, whether the branch
// conflicts, whether a person approved. The same shape tests/integration/workflow-e2e/15-branch-sync.test.ts uses (`syncGithub`), kept here so the parity
// suite drives Cloud's tracking exactly as its own branch-sync journeys do.
import type { WorkflowE2E } from "../../../support/workflow-e2e.js";

export interface TrackingGithubState { baseAhead: boolean; conflicted: boolean; approved: boolean }

export function trackingGithub(e2e: () => WorkflowE2E) {
  const state: TrackingGithubState = { baseAhead: false, conflicted: false, approved: true };
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
          checks: [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "https://github.com/example/demo/actions/runs/1/job/1" }],
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
