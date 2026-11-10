// Rovara Code (Plan 6 Task 19): a person approves, and a person presses Merge. `humanApprovalOf` decides whose approval counts, `mergeReadiness` whether a task's pull requests may be
// merged, `pressMerge` turns a press into one pending change that its presser decides on Plan 3's confirmation page, and the change's handler re-reads GitHub for every pull request
// before it claims and merges them, in order, once.
import { describe, expect, it } from "vitest";
import {
  MERGE_NOT_READY_MESSAGES as M, WORKFLOW_BLOCK_REASONS, MergeViewSchema, NeedsConfirmationReaderSchema, NeedsConfirmationSchema, agentXError, githubMemberKey, memberGithubKey, mergeTrackingKey, orgMemberKey,
} from "../../packages/contracts/src/index.js";
import type { PullRequestReview } from "../../packages/broker/src/github-pull-status.js";
import { getApprovalSubjectHandler, getAnyApproval, mayDecideApproval } from "../../packages/broker/src/agents/approvals.js";
import { requesterGithubIds, requesterIds } from "../../packages/broker/src/rovara-code/approval.js";
import { developerReply } from "../../packages/broker/src/aws/json-reply.js";
import { humanApprovalOf, mergeReadiness, mergeViewFromReadiness, mergeViewOf, pressMerge, type HumanApproval, type MergePullRequestFacts } from "../../packages/broker/src/rovara-code/merge.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, CELL, MAX, OLA, ORG_A, ORG_B, PRIYA, ZED } from "../support/agent-session-world.js";
import { GH, HEAD_A, HEAD_B, HEAD_C, LOGIN, OLD_HEAD, mergeWorld, pullStatus, type MergeWorld } from "../support/rovara-code-merge-world.js";

// ---- whose approval counts

const AT = "2026-10-22T08:40:00.000Z";
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const review = (who: keyof typeof GH, state: PullRequestReview["state"], extra: Partial<PullRequestReview> = {}): PullRequestReview => ({
  githubUserId: GH[who], login: LOGIN[who], userType: "User", state, commitId: HEAD_A, submittedAt: AT, ...extra,
});
const permissions = () => new Map<string, "admin" | "write" | "read" | "none">([
  [LOGIN.arjun, "write"], [LOGIN.max, "write"], [LOGIN.priya, "write"], [LOGIN.stranger, "write"], [LOGIN.reader, "read"], [LOGIN.bot, "write"],
]);
const approvalInput = (overrides: Partial<Parameters<typeof humanApprovalOf>[0]> = {}): Parameters<typeof humanApprovalOf>[0] => ({
  reviews: [review("arjun", "APPROVED")], headSha: HEAD_A, syncedFrom: undefined, ciPassingOnHead: true, permissions: permissions(), requesterGithubUserIds: [GH.priya],
  linkedGithubUserIds: new Set([GH.arjun, GH.priya, GH.max]), allowSelfApproval: false, ...overrides,
});
const refused = (reason: string) => ({ approved: false, reason });

describe("humanApprovalOf: whose approval counts", () => {
  it("counts a write-access person who is a member and not a requester, on the head", () => {
    expect(humanApprovalOf(approvalInput())).toEqual({ approved: true, by: { githubUserId: GH.arjun, login: LOGIN.arjun }, commitId: HEAD_A, approvers: [{ githubUserId: GH.arjun, login: LOGIN.arjun }] });
  });

  it("does not count the App's approval, a bot's, or any account that is not a person", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("bot", "APPROVED", { userType: "Bot" })], linkedGithubUserIds: new Set([GH.bot]) }))).toEqual(refused("none"));
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED")], appUserId: GH.arjun }))).toEqual(refused("none"));
  });

  it("does not count a read-only member's approval: no_write", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("reader", "APPROVED")], linkedGithubUserIds: new Set([GH.reader]) }))).toEqual(refused("no_write"));
    // A login the permission lookup did not answer for is read as no access.
    expect(humanApprovalOf(approvalInput({ permissions: new Map() }))).toEqual(refused("no_write"));
  });

  it("does not count the requester's own approval when self-approval is off: self_only; it does when it is on", () => {
    const own = approvalInput({ reviews: [review("priya", "APPROVED")] });
    expect(humanApprovalOf(own)).toEqual(refused("self_only"));
    expect(humanApprovalOf({ ...own, allowSelfApproval: true })).toMatchObject({ approved: true, by: { githubUserId: GH.priya } });
  });

  it("does not count an approval when a requester has no linked GitHub account: unlinked_requester (self-approval off only)", () => {
    expect(humanApprovalOf(approvalInput({ requesterGithubUserIds: "unlinked" }))).toEqual(refused("unlinked_requester"));
    expect(humanApprovalOf(approvalInput({ requesterGithubUserIds: "unlinked", allowSelfApproval: true }))).toMatchObject({ approved: true });
  });

  it("does not let a dismissed second approval revive the first (each reviewer's latest review decides)", () => {
    const input = approvalInput({ reviews: [review("arjun", "APPROVED"), review("arjun", "DISMISSED", { submittedAt: later(5) })] });
    expect(humanApprovalOf(input)).toEqual(refused("none"));
  });

  it("takes the latest of a reviewer's reviews whatever the order they are listed in", () => {
    const input = approvalInput({ reviews: [review("arjun", "DISMISSED", { submittedAt: later(5) }), review("arjun", "APPROVED")] });
    expect(humanApprovalOf(input)).toEqual(refused("none"));
  });

  it("counts an APPROVED followed by the same reviewer's COMMENTED (comments say nothing)", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED"), review("arjun", "COMMENTED", { submittedAt: later(5) })] }))).toMatchObject({ approved: true });
  });

  it("refuses an approval of earlier code: stale; a Rovara fix push moved the head", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED", { commitId: OLD_HEAD })] }))).toEqual(refused("stale"));
  });

  it("keeps an approval across a clean sync of the base when CI passes on the merged head, and not when it does not", () => {
    const carried = approvalInput({ reviews: [review("arjun", "APPROVED", { commitId: OLD_HEAD })], syncedFrom: OLD_HEAD, headSha: HEAD_B });
    expect(humanApprovalOf(carried)).toMatchObject({ approved: true, commitId: OLD_HEAD });
    expect(humanApprovalOf({ ...carried, ciPassingOnHead: false })).toEqual(refused("stale"));
    // An approval of some other earlier head does not ride on the sync.
    expect(humanApprovalOf({ ...carried, reviews: [review("arjun", "APPROVED", { commitId: HEAD_C })] })).toEqual(refused("stale"));
    // And a pull request that was never synced carries nothing.
    expect(humanApprovalOf({ ...carried, syncedFrom: undefined })).toEqual(refused("stale"));
  });

  it("refuses when a write-access reviewer asked for changes after (or instead of) approving; a read-only reviewer's request is ignored", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED"), review("max", "CHANGES_REQUESTED", { submittedAt: later(5) })] }))).toEqual(refused("changes_requested"));
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED"), review("reader", "CHANGES_REQUESTED", { submittedAt: later(5) })] }))).toMatchObject({ approved: true });
    // The same reviewer's later approval clears their own request.
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "CHANGES_REQUESTED"), review("arjun", "APPROVED", { submittedAt: later(5) })] }))).toMatchObject({ approved: true });
  });

  it("does not count an approval from a write-access account that is linked to no member when self-approval is off; it does when it is on", () => {
    const stranger = approvalInput({ reviews: [review("stranger", "APPROVED")] });
    expect(humanApprovalOf(stranger)).toEqual(refused("none"));
    expect(humanApprovalOf({ ...stranger, allowSelfApproval: true })).toMatchObject({ approved: true, by: { githubUserId: GH.stranger } });
  });

  it("names every counted approver, the first being the latest approval", () => {
    const result = humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED"), review("max", "APPROVED", { submittedAt: later(3) })] })) as Extract<HumanApproval, { approved: true }>;
    expect(result.approved).toBe(true);
    expect(result.by.githubUserId).toBe(GH.max);
    expect(result.approvers.map((entry) => entry.githubUserId).sort()).toEqual([GH.arjun, GH.max].sort());
  });

  it("matches a login in any case when it looks up the permission", () => {
    expect(humanApprovalOf(approvalInput({ reviews: [review("arjun", "APPROVED", { login: "ARJUN-GH" })] }))).toMatchObject({ approved: true });
  });
});

// ---- whether the pull requests may be merged

const facts = (overrides: Partial<MergePullRequestFacts> = {}): MergePullRequestFacts => ({
  repositoryId: "payments", number: 7, headSha: HEAD_A, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false, ...overrides,
});
const approved = (by: keyof typeof GH = "arjun", approvers: Array<keyof typeof GH> = [by]): HumanApproval => ({
  approved: true, by: { githubUserId: GH[by], login: LOGIN[by] }, commitId: HEAD_A, approvers: approvers.map((who) => ({ githubUserId: GH[who], login: LOGIN[who] })),
});
const keyOf = (pr: { repositoryId: string; number: number }) => `${pr.repositoryId}#${String(pr.number)}`;
const workflowWaiting = { stage: "WAIT_FOR_MERGE", state: "WAITING" } as const;
const readiness = (overrides: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => {
  const pullRequests = overrides.pullRequests ?? [facts()];
  return mergeReadiness({
    pullRequests, approvals: new Map(pullRequests.map((pr) => [keyOf(pr), approved()])), workflow: workflowWaiting,
    recordedBases: new Map(pullRequests.map((pr) => [keyOf(pr), "main"])), presser: { githubUserId: GH.priya }, allowSelfApproval: false, requesterName: "Priya", ...overrides,
  });
};
const notReady = (message: string) => ({ ready: false, message });

describe("mergeReadiness", () => {
  it("is ready for an open, ready, green, clean, approved pull request on its recorded base", () => {
    expect(readiness()).toEqual({ ready: true });
  });

  it("is refused with the second review's words while an `on` second review that did not run is not acknowledged (SR-1)", () => {
    const words = "Second review did not run: no allowed model from a different AI company could be used. The task owner has to acknowledge it on the task page before this can be merged.";
    expect(readiness({ secondReviewWait: words })).toEqual(notReady(words));
    expect(readiness({ secondReviewWait: undefined })).toEqual({ ready: true });
    // The merge's own refusals still come first: a closed task is not told to acknowledge anything.
    expect(readiness({ workflow: { stage: "MERGED", state: "WAITING" }, secondReviewWait: words })).toEqual(notReady(M.taskClosed));
  });

  it("says why a pull request is not ready, in the exact words", () => {
    expect(readiness({ pullRequests: [facts({ baseBranch: "release" })] })).toEqual(notReady(M.baseChanged("release")));
    expect(readiness({ pullRequests: [facts({ state: "closed" })] })).toEqual(notReady(M.notOpen));
    expect(readiness({ pullRequests: [facts({ draft: true })] })).toEqual(notReady(M.draft));
    expect(readiness({ pullRequests: [facts({ ci: "failing" })] })).toEqual(notReady(M.checks));
    expect(readiness({ pullRequests: [facts({ ci: "pending" })] })).toEqual(notReady(M.checks));
    expect(readiness({ pullRequests: [facts({ branch: "conflicted" })] })).toEqual(notReady(M.conflicted("main")));
    expect(readiness({ pullRequests: [facts({ branch: "behind", behindRequired: true })] })).toEqual(notReady(M.behind("main")));
  });

  it("tells a task that needs browser or API checks to update its branch itself (Rovara does not merge the base in), and a merged base that needs its checks again to Retry checks", () => {
    const behind = { pullRequests: [facts({ branch: "behind", behindRequired: true })] };
    expect(readiness({ ...behind, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", e2e: { required: true } } })).toEqual(notReady(M.behindByHand("main")));
    expect(M.behindByHand("main")).not.toContain("I'm bringing it up to date");
    expect(readiness({ ...behind, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", e2e: { required: false } } })).toEqual(notReady(M.behind("main")));
    // The base was merged in: not "still changing", but the owner's Retry checks.
    expect(readiness({ workflow: { stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck } })).toEqual(notReady(M.baseMerged));
    expect(readiness({ workflow: { stage: "VERIFY", state: "BLOCKED", blockReason: "checks failed" } })).toEqual(notReady(M.changing));
  });

  it("does not know a pull request's base without Rovara's own record of it, and so does not merge it", () => {
    expect(readiness({ recordedBases: new Map() })).toEqual(notReady(M.baseChanged("main")));
  });

  it("lets a pull request with no CI, or one a commit behind a base that does not care, through", () => {
    expect(readiness({ pullRequests: [facts({ ci: "none" })] })).toEqual({ ready: true });
    expect(readiness({ pullRequests: [facts({ branch: "behind", behindRequired: false })] })).toEqual({ ready: true });
  });

  it("maps every reason an approval does not count to its exact message", () => {
    const one = (approval: HumanApproval, extra: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => readiness({ approvals: new Map([[keyOf(facts()), approval]]), ...extra });
    expect(one({ approved: false, reason: "none" })).toEqual(notReady(M.needsOtherApproval("Priya")));
    expect(one({ approved: false, reason: "none" }, { allowSelfApproval: true })).toEqual(notReady(M.needsWriteApproval("payments")));
    expect(one({ approved: false, reason: "no_write" })).toEqual(notReady(M.needsWriteApproval("payments")));
    expect(one({ approved: false, reason: "self_only" })).toEqual(notReady(M.needsOtherApproval("Priya")));
    expect(one({ approved: false, reason: "unlinked_requester" })).toEqual(notReady(M.linkGithub));
    expect(one({ approved: false, reason: "stale" })).toEqual(notReady(M.staleApproval));
    expect(one({ approved: false, reason: "changes_requested" })).toEqual(notReady(M.changesRequested));
  });

  it("names the repository when a task has several pull requests", () => {
    const pullRequests = [facts(), facts({ repositoryId: "billing", number: 8, ci: "failing" })];
    expect(readiness({ pullRequests })).toEqual(notReady(M.repository("billing", M.checks)));
    // Every required pull request must be ready, and the first that is not is the one named.
    expect(readiness({ pullRequests: [facts({ draft: true }), ...pullRequests.slice(1)] })).toEqual(notReady(M.repository("payments", M.draft)));
  });

  it("is not ready while Rovara is changing the pull request, whatever its pull request looks like", () => {
    for (const workflow of [
      { stage: "PULL_REQUEST", state: "RUNNING" }, { stage: "WAIT_FOR_MERGE", state: "READY" }, { stage: "WAIT_FOR_MERGE", state: "RUNNING" }, { stage: "IMPLEMENT", state: "RUNNING" },
      { stage: "WAIT_FOR_MERGE", state: "WAITING", fixSource: "ci" },
      { stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } },
      { stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "COLLECTING" } },
      { stage: "WAIT_FOR_MERGE", state: "WAITING", branchSync: { repositoryId: "payments", number: 7 } },
      // Waiting for a person to approve a plan is not waiting for the merge.
      { stage: "PLAN_REVIEW", state: "WAITING" },
    ] as const) {
      expect(readiness({ workflow: workflow })).toEqual(notReady(M.changing));
    }
  });

  it("is not ready for a task blocked on CI, or on an update of the branch, and says what a person should do", () => {
    expect(readiness({ workflow: { stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "CI is failing on test. Rovara is set to suggest, so it won't change the code on its own. Retry the fix to let it try, or fix it yourself." } })).toEqual(notReady(M.checks));
    expect(readiness({ workflow: { stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task." } }))
      .toEqual(notReady("The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task."));
    expect(readiness({ workflow: { stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "something else" } })).toEqual(notReady(M.changing));
  });

  it("is not ready for a closed or merged task", () => {
    expect(readiness({ workflow: { stage: "CLOSED", state: "SUCCEEDED" } })).toEqual(notReady(M.taskClosed));
    expect(readiness({ workflow: { stage: "MERGED", state: "SUCCEEDED" } })).toEqual(notReady(M.taskClosed));
  });

  it("skips a pull request that is already merged, and is not ready when none is left to merge", () => {
    const pullRequests = [facts({ state: "merged" }), facts({ repositoryId: "billing", number: 8 })];
    expect(readiness({ pullRequests })).toEqual({ ready: true });
    expect(readiness({ pullRequests: [facts({ state: "merged" })] })).toEqual(notReady(M.taskClosed));
  });

  it("refuses a presser who is the only approver, and one with no linked GitHub account, when self-approval is off", () => {
    const only = (by: keyof typeof GH) => readiness({ approvals: new Map([[keyOf(facts()), approved(by)]]), presser: { githubUserId: GH[by] } });
    expect(only("arjun")).toEqual(notReady(M.presserApproved));
    // With a second approver the presser is not the only one.
    expect(readiness({ approvals: new Map([[keyOf(facts()), approved("arjun", ["arjun", "max"])]]), presser: { githubUserId: GH.arjun } })).toEqual({ ready: true });
    expect(readiness({ presser: { githubUserId: undefined } })).toEqual(notReady(M.linkGithub));
    // Self-approval on is an organization admin's choice to allow one person to approve and press.
    expect(readiness({ approvals: new Map([[keyOf(facts()), approved("arjun")]]), presser: { githubUserId: GH.arjun }, allowSelfApproval: true })).toEqual({ ready: true });
    // Whoever presses must have a linked GitHub account, with self-approval on as well (controller ruling 2026-10-26).
    expect(readiness({ presser: { githubUserId: undefined }, allowSelfApproval: true })).toEqual(notReady(M.linkGithub));
  });

  it("checks the presser against every pull request's approvers", () => {
    const pullRequests = [facts(), facts({ repositoryId: "billing", number: 8 })];
    const approvals = new Map<string, HumanApproval>([[keyOf(pullRequests[0]!), approved("arjun", ["arjun", "max"])], [keyOf(pullRequests[1]!), approved("arjun")]]);
    expect(readiness({ pullRequests, approvals, presser: { githubUserId: GH.arjun } })).toEqual(notReady(M.presserApproved));
  });

  it("treats a missing approval for a pull request as none", () => {
    expect(readiness({ approvals: new Map() })).toEqual(notReady(M.needsOtherApproval("Priya")));
  });
});

// ---- pressing Merge

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const press = (w: MergeWorld, who: string = PRIYA, requestId: string = w.requestId()) => pressMerge(w.shareDeps, w.caller(who), w.sessionId, { requestId }, w.deps);
async function ready(options: Parameters<typeof mergeWorld>[0] = {}, tracking: Parameters<MergeWorld["seedTracking"]>[0] = {}): Promise<MergeWorld> {
  const w = mergeWorld(options);
  await w.linkAll();
  w.seedTracking(tracking);
  return w;
}
const mergedOf = (w: MergeWorld) => w.github.mergeCalls.map((call) => `${String(call.number)}:${call.sha.slice(0, 1)}:${call.method}`);

describe("pressing Merge", () => {
  it("answers 202 NEEDS_CONFIRMATION with the link, creates one pending change that lists every pull request and its head, and merges nothing", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    const reply = await press(w);
    expect(reply.status).toBe(202);
    const body = NeedsConfirmationSchema.parse(reply.body);
    const record = await w.approvalOf(body.confirmUrl);
    expect(record).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: PRIYA,
      subject: { kind: "pull_request_merge", taskId: w.taskId, pullRequests: [{ repositoryId: "billing", number: 8, headSha: HEAD_A }, { repositoryId: "payments", number: 7, headSha: HEAD_A }] },
      approvers: { kind: "rule", rule: "pull_request_merge", candidates: [PRIYA] },
    });
    expect(body.changes).toEqual(["Merge billing pull request 8 (squash)", "Merge payments pull request 7 (squash)"]);
    expect(w.github.mergeCalls).toEqual([]);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("answers a repeat of the same request with the same change, and a different press with another", async () => {
    const w = await ready();
    const requestId = w.requestId();
    const first = NeedsConfirmationSchema.parse((await press(w, PRIYA, requestId)).body);
    const again = NeedsConfirmationSchema.parse((await press(w, PRIYA, requestId)).body);
    expect(w.approvalIdOf(again.confirmUrl)).toBe(w.approvalIdOf(first.confirmUrl));
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("refuses with MERGE_NOT_READY and the exact words when the task is not ready, and creates nothing", async () => {
    const none = await ready({}, { review: "requested", approval: undefined as never });
    expect(await codeOf(press(none))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
    expect(none.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    const red = await ready({}, { ci: "failing", failingChecks: ["test"] });
    expect(await codeOf(press(red))).toEqual({ code: "MERGE_NOT_READY", message: M.checks });
    const draft = await ready({}, { draft: true });
    expect(await codeOf(press(draft))).toEqual({ code: "MERGE_NOT_READY", message: M.draft });
    const closed = await ready({}, { state: "closed" });
    expect(await codeOf(press(closed))).toEqual({ code: "MERGE_NOT_READY", message: M.notOpen });
    const base = await ready({}, { baseBranch: "release" });
    expect(await codeOf(press(base))).toEqual({ code: "MERGE_NOT_READY", message: M.baseChanged("release") });
  });

  it("names the repository when one of two pull requests is not ready", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] }, (pr) => (pr.number === 8 ? { ci: "failing" as const, failingChecks: ["test"] } : {}));
    expect(await codeOf(press(w))).toEqual({ code: "MERGE_NOT_READY", message: M.repository("billing", M.checks) });
  });

  it("does not count an approval from an account linked to no member, or a requester with no link, while self-approval is off", async () => {
    const stranger = await ready({}, { approval: { githubUserId: GH.stranger, login: LOGIN.stranger, commitId: HEAD_A } });
    expect(await codeOf(press(stranger))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
    const allowed = await ready({ allowSelfApproval: true }, { approval: { githubUserId: GH.stranger, login: LOGIN.stranger, commitId: HEAD_A } });
    expect((await press(allowed)).status).toBe(202);
    const unlinked = await ready({ linked: ["arjun", "max", "ola"] });
    expect(await codeOf(press(unlinked))).toEqual({ code: "MERGE_NOT_READY", message: M.linkGithub });
  });

  it("refuses the presser who is the only approver, and a presser with no linked GitHub account", async () => {
    const w = await ready({}, { approval: { githubUserId: GH.max, login: LOGIN.max, commitId: HEAD_A } });
    expect(await codeOf(press(w, MAX))).toEqual({ code: "MERGE_NOT_READY", message: M.presserApproved });
    // Priya (the requester) may press Max's approval.
    expect((await press(w, PRIYA)).status).toBe(202);
    const unlinkedMax = await ready({ linked: ["priya", "arjun", "ola"] }, { approval: { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: HEAD_A } });
    expect(await codeOf(press(unlinkedMax, MAX))).toEqual({ code: "MERGE_NOT_READY", message: M.linkGithub });
  });

  it("lets only the session's owner, a project maintainer or an org admin press; a contributor, a viewer and a stranger cannot", async () => {
    const w = await ready();
    expect((await press(w, MAX)).status).toBe(202);
    expect((await press(w, OLA)).status).toBe(202);
    expect((await press(w, PRIYA)).status).toBe(202);
    const contributor = await codeOf(press(w, ARJUN));
    expect(contributor?.code).toMatch(/FORBIDDEN|SESSION_LEVEL_REQUIRED/u);
    expect(await codeOf(press(w, ZED))).toMatchObject({ code: "NOT_FOUND" });
  });

  // C60: the words that name who asked never carry an email address (a sign-in provider with no name for someone uses their address as the name).
  it("names the requester without an email address in the refusal of a press", async () => {
    const w = await ready();
    const session = w.db.find((item) => item.pk === `ORG#${ORG_A}#AGENT_SESSION#${w.sessionId}` && item.sk === "META")[0]!;
    w.db.set({ ...session, owner: { ...(session.owner as object), name: "priya@example.com" } });
    const task = w.db.get(`DEVTASK#${w.taskId}`, "META")!;
    w.db.set({ ...task, developerName: "priya@example.com" });
    const forbidden = await codeOf(press(w, ARJUN));
    expect(forbidden?.message).not.toContain("@");
    expect(forbidden?.message).toContain("Only the person who asked, who asked for this");
  });

  it("refuses a body with a field the route does not take, and a task that is not followed for its merge", async () => {
    const w = await ready();
    expect(await codeOf(pressMerge(w.shareDeps, w.caller(PRIYA), w.sessionId, { requestId: w.requestId(), payer: "x" }, w.deps))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(pressMerge(w.shareDeps, w.caller(PRIYA), w.sessionId, {}, w.deps))).toMatchObject({ code: "CONFIG_INVALID" });
    const v1 = await ready();
    v1.setWorkflow({ definitionVersion: "1.0.0" });
    expect(await codeOf(press(v1))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("asks the tracking pass to bring a branch that GitHub needs up to date, and says so, instead of confirming", async () => {
    const w = await ready({}, { branch: "behind" });
    w.github.statuses.set(7, pullStatus(7, { mergeableState: "behind", behindBy: 2 }));
    const asked: string[] = [];
    w.host.requireSyncForMerge = async (task) => { asked.push(task.taskId); };
    expect(await codeOf(press(w))).toEqual({ code: "MERGE_NOT_READY", message: M.behind("main") });
    expect(asked).toEqual([w.taskId]);
    // A branch merely behind a base that does not care is not held up.
    const calm = await ready({}, { branch: "behind" });
    expect((await press(calm)).status).toBe(202);
  });

  it("answers APPROVAL_CLOSED to a press repeated after its change was decided, and creates nothing more", async () => {
    const w = await ready();
    const requestId = w.requestId();
    const first = NeedsConfirmationSchema.parse((await press(w, PRIYA, requestId)).body);
    const approvalId = w.approvalIdOf(first.confirmUrl);
    await w.decide(approvalId, await w.browser(PRIYA, approvalId));
    expect(await codeOf(press(w, PRIYA, requestId))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("shows the page of the pending change only to its presser, in words", async () => {
    const w = await ready();
    const body = NeedsConfirmationSchema.parse((await press(w)).body);
    const approvalId = w.approvalIdOf(body.confirmUrl);
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: OLA, approvalId })).toEqual({ status: "forbidden", who: "the person who pressed Merge, while they can still merge this task" });
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: MAX, approvalId })).toMatchObject({ status: "forbidden" });
    const open = await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId });
    expect(open).toMatchObject({ status: "open", view: { title: "Merge a pull request" } });
    expect(JSON.stringify(open)).toContain("payments pull request 7");
  });
});

// ---- confirming it

async function pressed(w: MergeWorld, who: string = PRIYA) {
  const body = NeedsConfirmationSchema.parse((await press(w, who)).body);
  return { approvalId: w.approvalIdOf(body.confirmUrl), url: body.confirmUrl };
}
async function confirm(w: MergeWorld, who: string = PRIYA, started?: { approvalId: string; url: string }) {
  const { approvalId, url } = started ?? await pressed(w, who);
  await w.decide(approvalId, await w.browser(who, approvalId));
  return { approvalId, record: await w.approvalOf(url) };
}
const eventsOf = (w: MergeWorld) => w.db.find((item) => item.pk === `ORG#${ORG_A}#AGENT_SESSION#${w.sessionId}` && String(item.sk).startsWith("EVENT#")).map((item) => String(item.text));
const milestonesOf = (w: MergeWorld, kind: string) => w.db.find((item) => item.pk === `DEVTASK#${w.taskId}` && String(item.sk).startsWith(`CODE_MILESTONE#${kind}`));

describe("confirming a merge", () => {
  it("merges the pull request with its checked head and the project's method, claims it first, and ends the change done", async () => {
    const w = await ready({ mergeMethod: "squash" });
    const { record } = await confirm(w);
    expect(record.status).toBe("APPROVED_DONE");
    expect(mergedOf(w)).toEqual(["7:a:squash"]);
    expect(w.trackingOf({ repositoryId: "payments", number: 7 })?.mergeClaim).toEqual({ headSha: HEAD_A, by: PRIYA, at: new Date(w.clock.now).toISOString() });
    expect(w.trackingOf({ repositoryId: "payments", number: 7 })?.version).toBe(2);
  });

  it("uses the merge method the project chose", async () => {
    const w = await ready({ mergeMethod: "merge" });
    await confirm(w);
    expect(mergedOf(w)).toEqual(["7:a:merge"]);
  });

  it("merges both pull requests in repository order, each with its own sha", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    w.github.statuses.set(8, pullStatus(8, { headSha: HEAD_B, reviews: [{ githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_B, submittedAt: AT }] }));
    w.setPullRequests(w.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, headSha: pr.number === 8 ? HEAD_B : HEAD_A, candidateDigest: "c".repeat(64), required: true, state: "OPEN" })));
    w.seedTracking((pr) => (pr.number === 8 ? { headSha: HEAD_B, approval: { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: HEAD_B } } : {}));
    const { record } = await confirm(w);
    expect(record.status).toBe("APPROVED_DONE");
    expect(mergedOf(w)).toEqual(["8:b:squash", "7:a:squash"]);
  });

  it("merges nothing when the CLI or an AI tool tries to decide: only the page's fresh sign-in decides", async () => {
    const w = await ready();
    const { approvalId, url } = await pressed(w);
    await expect(w.kind.decide({ orgId: ORG_A, developerId: PRIYA, approvalId }, "approve", { kind: "none" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.github.mergeCalls).toEqual([]);
    expect((await w.approvalOf(url)).status).toBe("PENDING");
  });

  it("does not let the presser decide once they can no longer press Merge on the task (read now, not when they pressed)", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId })).toMatchObject({ status: "open" });
    // Someone else took the task over: Priya is a contributor with no hold on it now.
    const task = w.db.get(taskKey(w.taskId))!;
    w.db.set({ ...task, currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: "2026-10-22T08:30:00.000Z" } });
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId })).toMatchObject({ status: "forbidden" });
    const posted = await w.decide(approvalId, await w.browser(PRIYA, approvalId));
    expect(posted.statusCode).toBe(403);
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("merges only the pull request Rovara linked to this task: a link that names another task stops everything", async () => {
    const w = await ready();
    const started = await pressed(w);
    const key = githubWorkflowPullRequestKey("acme/payments", 7);
    w.db.set({ ...w.db.get(key)!, taskId: "00000000-0000-4000-8000-000000000001" });
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.changedAfterConfirm });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("refuses a change whose task belongs to another org", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const task = w.db.get(taskKey(w.taskId))!;
    w.db.set({ ...task, orgId: ORG_B });
    await expect(getApprovalSubjectHandler("pull_request_merge")!(w.deps, { ...record!, decidedBy: PRIYA })).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
    // It stopped before it read anything from GitHub.
    expect(w.github.calls).toEqual([]);
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("does not let anyone but the presser decide, a maintainer included", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const cookie = await w.browser(MAX, approvalId);
    const posted = await w.decide(approvalId, cookie);
    expect(posted.statusCode).toBe(403);
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("re-reads every pull request: B turns red between the press and the confirmation, and nothing merges", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    const started = await pressed(w);
    w.github.statuses.set(8, pullStatus(8, { checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "" }] }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record.status).toBe("APPROVED_FAILED");
    expect(record.failure).toBe(M.repository("billing", M.checks));
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("does not trust what tracking stored: a red non-required check on an unprotected base stops the merge", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.github.statuses.set(7, pullStatus(7, { checks: [
      { name: "test", status: "completed", conclusion: "success", required: false, url: "" }, { name: "lint", status: "completed", conclusion: "failure", required: false, url: "" },
    ] }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.checks });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("merges nothing when a pull request was added to the task after the press", async () => {
    const w = await ready();
    const started = await pressed(w);
    const current = (w.db.get(taskKey(w.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    w.setPullRequests([...current, { ...current[0]!, repositoryId: "billing", number: 8, url: "https://github.com/acme/billing/pull/8" }]);
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.changedAfterConfirm });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("ends APPROVED_FAILED with the moved-head words when a head moved after the press, and merges nothing", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.github.statuses.set(7, pullStatus(7, { headSha: HEAD_B }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.changedAfterConfirm });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("re-reads the approval: one dismissed after the press no longer counts", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.github.statuses.set(7, pullStatus(7, { reviews: [
      { githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: AT },
      { githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "DISMISSED", commitId: HEAD_A, submittedAt: later(5) },
    ] }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
    expect(w.github.mergeCalls).toEqual([]);
    // A reviewer whose approval was dismissed is not looked up.
    expect(w.github.calls).not.toContain(`permission:${LOGIN.arjun}`);
  });

  it("re-reads permissions: a reviewer who lost write access since no longer approves", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.github.permissions.set(LOGIN.arjun, "read");
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsWriteApproval("payments") });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("decides from the reviews it reads at confirmation, not from the tracking item: the approval that stands is the requester's own, which does not count", async () => {
    const w = await ready({}, { approval: { githubUserId: GH.max, login: LOGIN.max, commitId: HEAD_A } });
    const started = await pressed(w, PRIYA);
    w.github.statuses.set(7, pullStatus(7, { reviews: [{ githubUserId: GH.priya, login: LOGIN.priya, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: AT }] }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("makes one GitHub merge call per pull request when two handlers race", async () => {
    const w = await ready();
    const { approvalId, url } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const handler = getApprovalSubjectHandler("pull_request_merge")!;
    const decided = { ...record!, decidedBy: PRIYA } as never;
    let nested: unknown;
    w.github.onMerge = async () => {
      w.github.onMerge = undefined;
      nested = await handler(w.deps, decided).then(() => "done", (error: { code?: string }) => error.code);
    };
    await handler(w.deps, decided);
    expect(w.github.mergeCalls).toHaveLength(1);
    // The second handler found the claim fresh and left the merge to the first (retryable, not a failure of the change).
    expect(nested).toBe("RUNTIME_UNAVAILABLE");
    expect(url).toBeDefined();
  });

  it("does nothing for a pull request GitHub already merged: a rerun after a crash is the same merge", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const handler = getApprovalSubjectHandler("pull_request_merge")!;
    await handler(w.deps, { ...record!, decidedBy: PRIYA });
    // The claim is still fresh and the pull request merged: the rerun finds it merged and merges nothing again.
    await handler(w.deps, { ...record!, decidedBy: PRIYA });
    expect(w.github.mergeCalls).toHaveLength(1);
  });

  it("claims again after a claim went stale (the claim's time is past MERGE_CLAIM_SECONDS), and not before", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const handler = getApprovalSubjectHandler("pull_request_merge")!;
    const claim = { headSha: HEAD_A, by: ARJUN, at: new Date(w.clock.now - 60_000).toISOString() };
    w.db.set({ ...w.trackingOf({ repositoryId: "payments", number: 7 })!, mergeClaim: claim });
    await expect(handler(w.deps, { ...record!, decidedBy: PRIYA })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.github.mergeCalls).toEqual([]);
    w.clock.now += 61_000;
    await handler(w.deps, { ...record!, decidedBy: PRIYA });
    expect(w.github.mergeCalls).toHaveLength(1);
    expect(w.trackingOf({ repositoryId: "payments", number: 7 })?.mergeClaim).toMatchObject({ by: PRIYA });
  });

  it("never applies a change nobody decided", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    await expect(getApprovalSubjectHandler("pull_request_merge")!(w.deps, record!)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("stops a half-merged pair with the exact words, and says stuck", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable" });
    const { record } = await confirm(w);
    expect(mergedOf(w)).toEqual(["8:a:squash", "7:a:squash"]);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.halfMerged("billing", "payments", "GitHub would not merge it") });
    const [stuck] = milestonesOf(w, "stuck");
    expect(stuck).toMatchObject({ kind: "stuck", text: M.halfMerged("billing", "payments", "GitHub would not merge it") });
  });

  it("counts what an earlier run already merged: a rerun after a crash that finds the second pull request refused still says the first merged", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const handler = getApprovalSubjectHandler("pull_request_merge")!;
    w.github.results.set(7, agentXError("RUNTIME_UNAVAILABLE", "GitHub is down"));
    await expect(handler(w.deps, { ...record!, decidedBy: PRIYA })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(mergedOf(w)).toEqual(["8:a:squash", "7:a:squash"]);
    w.clock.now += 130_000;
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable" });
    await expect(handler(w.deps, { ...record!, decidedBy: PRIYA })).rejects.toMatchObject({ code: "MERGE_NOT_READY", message: expect.stringContaining(M.halfMerged("billing", "payments", "GitHub would not merge it")) as string });
    // The rerun asked GitHub to merge the second pull request again and the first not at all.
    expect(mergedOf(w)).toEqual(["8:a:squash", "7:a:squash", "7:a:squash"]);
  });

  it("ends the change failed with the moved-head words when GitHub refuses the merge because the head moved, and does not call it half-merged when nothing merged", async () => {
    const w = await ready();
    w.github.results.set(7, { outcome: "refused", reason: "head_changed" });
    const { record } = await confirm(w);
    expect(record).toMatchObject({ status: "APPROVED_FAILED", failure: M.changedAfterConfirm });
    expect(milestonesOf(w, "stuck")).toEqual([]);
  });

  it("says which method was used when the project's was not allowed", async () => {
    const w = await ready({ mergeMethod: "squash" });
    w.github.results.set(7, { outcome: "merged", method: "merge", fellBack: true });
    const { record } = await confirm(w);
    expect(record.status).toBe("APPROVED_DONE");
    expect(eventsOf(w)).toContain("Merged payments pull request 7 using merge, because squash isn't allowed in that repository.");
  });

  it("leaves a transient GitHub failure for the sweep to run again", async () => {
    const w = await ready();
    w.github.results.set(7, agentXError("RUNTIME_UNAVAILABLE", "GitHub is down"));
    const { record } = await confirm(w);
    expect(["EXECUTING", "PENDING"]).toContain(record.status);
    expect(record.status).not.toBe("APPROVED_FAILED");
  });

  it("only merges for the task the change names, in the org that asked", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    const other = w.seedSession({ owner: PRIYA });
    const forged = { ...record!, decidedBy: PRIYA, subject: { ...(record!.subject as object), taskId: other.taskId } } as never;
    await expect(getApprovalSubjectHandler("pull_request_merge")!(w.deps, forged)).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
    expect(w.github.mergeCalls).toEqual([]);
  });
});

// ---- more the press and the confirmation refuse

const handlerOf = async (w: MergeWorld, started: { approvalId: string }, decidedBy: string = PRIYA) => {
  const record = await getAnyApproval(w.deps, ORG_A, started.approvalId);
  const run = () => getApprovalSubjectHandler("pull_request_merge")!(w.deps, { ...record!, decidedBy });
  return { record: record!, run };
};
const reviewOf = (who: keyof typeof GH, commitId = HEAD_A) => ({ githubUserId: GH[who], login: LOGIN[who], userType: "User", state: "APPROVED" as const, commitId, submittedAt: AT });

describe("what the press refuses besides readiness", () => {
  it("refuses a session whose task belongs to another org, and a task that is closed", async () => {
    const w = await ready();
    const other = w.seedSession({ taskOrgId: ORG_B });
    expect(await codeOf(pressMerge(w.shareDeps, w.caller(PRIYA), other.sessionId, { requestId: w.requestId() }, w.deps))).toMatchObject({ code: "NOT_FOUND" });
    w.db.set({ ...w.db.get(taskKey(w.taskId))!, closedAt: "2026-10-22T09:30:00.000Z" });
    expect(await codeOf(press(w))).toEqual({ code: "MERGE_NOT_READY", message: M.taskClosed });
  });

  it("asks for a sync only when the branch is why it is not ready", async () => {
    const w = await ready({}, { branch: "behind", review: "requested", approval: undefined as never });
    w.github.statuses.set(7, pullStatus(7, { mergeableState: "behind", behindBy: 2 }));
    const asked: string[] = [];
    w.host.requireSyncForMerge = async (task) => { asked.push(task.taskId); };
    expect(await codeOf(press(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
    expect(asked).toEqual([]);
  });

  it("leaves a pull request that is already merged out of the change", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] }, (pr) => (pr.number === 8 ? { state: "merged" as const } : {}));
    const current = (w.db.get(taskKey(w.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    w.setPullRequests(current.map((pr) => (pr.number === 8 ? { ...pr, state: "MERGED" } : pr)));
    const body = NeedsConfirmationSchema.parse((await press(w)).body);
    expect(await w.approvalOf(body.confirmUrl)).toMatchObject({ subject: { pullRequests: [{ repositoryId: "payments", number: 7, headSha: HEAD_A }] } });
    expect(body.changes).toEqual(["Merge payments pull request 7 (squash)"]);
  });

  it("lets nobody in another org decide the change", async () => {
    const w = await ready();
    const { approvalId } = await pressed(w);
    const record = await getAnyApproval(w.deps, ORG_A, approvalId);
    expect(await mayDecideApproval(w.deps, { orgId: ORG_B, developerId: PRIYA, orgRole: "member" }, record!)).toBe(false);
    expect(await mayDecideApproval(w.deps, { orgId: ORG_A, developerId: PRIYA, orgRole: "member" }, record!)).toBe(true);
  });
});

describe("what the confirmation refuses", () => {
  it("refuses a task that was closed after the press, before it reads anything from GitHub", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.db.set({ ...w.db.get(taskKey(w.taskId))!, closedAt: "2026-10-22T09:30:00.000Z" });
    await expect((await handlerOf(w, started)).run()).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
    expect(w.github.calls).toEqual([]);
  });

  it("refuses a task that gained a pull request at the end of the list, and one whose pull request was swapped for another of the same repository", async () => {
    const added = await ready();
    const addedStarted = await pressed(added);
    const current = (added.db.get(taskKey(added.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    added.setPullRequests([...current, { ...current[0]!, repositoryId: "zeta", number: 9, url: "https://github.com/acme/zeta/pull/9" }]);
    await expect((await handlerOf(added, addedStarted)).run()).rejects.toMatchObject({ code: "MERGE_NOT_READY", message: expect.stringContaining(M.changedAfterConfirm) as string });
    expect(added.github.calls).toEqual([]);
    const swapped = await ready();
    const swappedStarted = await pressed(swapped);
    const before = (swapped.db.get(taskKey(swapped.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    // Pull request 9 is a real, linked, tracked, approved pull request of the task now: only the change's own list says it was never asked for.
    swapped.setPullRequests([{ ...before[0]!, number: 9, url: "https://github.com/acme/payments/pull/9" }]);
    swapped.github.statuses.set(9, pullStatus(9));
    swapped.db.set({ ...swapped.db.get(githubWorkflowPullRequestKey("acme/payments", 7))!, ...githubWorkflowPullRequestKey("acme/payments", 9), number: 9, url: "https://github.com/acme/payments/pull/9" });
    swapped.db.set({ ...mergeTrackingKey(swapped.taskId, "payments", 9), entityType: "MERGE_TRACKING", ...swapped.trackingItem({ repositoryId: "payments", number: 9 }) });
    await expect((await handlerOf(swapped, swappedStarted)).run()).rejects.toMatchObject({ code: "MERGE_NOT_READY", message: expect.stringContaining(M.changedAfterConfirm) as string });
    expect(swapped.github.mergeCalls).toEqual([]);
  });

  it("refuses a pull request whose link names another address", async () => {
    const w = await ready();
    const started = await pressed(w);
    const key = githubWorkflowPullRequestKey("acme/payments", 7);
    w.db.set({ ...w.db.get(key)!, url: "https://github.com/acme/payments/pull/7?x=1" });
    expect((await confirm(w, PRIYA, started)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.changedAfterConfirm });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("does not take the answer for another pull request, and leaves it for a retry", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.github.statuses.set(7, pullStatus(99));
    await expect((await handlerOf(w, started)).run()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("reads the pull request fresh for a conflict, a draft and a changed base", async () => {
    for (const [change, message] of [
      [{ mergeableState: "dirty" as const, mergeable: false }, M.conflicted("main")],
      [{ draft: true }, M.draft],
      [{ baseBranch: "release" }, M.baseChanged("release")],
    ] as const) {
      const w = await ready();
      const started = await pressed(w);
      w.github.statuses.set(7, pullStatus(7, change));
      expect((await confirm(w, PRIYA, started)).record).toMatchObject({ status: "APPROVED_FAILED", failure: message });
      expect(w.github.mergeCalls).toEqual([]);
    }
  });

  it("does not let a merged pull request with another head hold up the rest", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    const started = await pressed(w);
    w.github.statuses.set(8, pullStatus(8, { state: "merged", headSha: HEAD_B }));
    const { record } = await confirm(w, PRIYA, started);
    expect(record.status).toBe("APPROVED_DONE");
    expect(mergedOf(w)).toEqual(["7:a:squash"]);
  });

  it("re-reads the presser's GitHub link: one who unlinked between the press and the confirmation is refused", async () => {
    const w = await ready();
    const started = await pressed(w, MAX);
    w.db.delete(memberGithubKey(ORG_A, MAX));
    w.db.delete(githubMemberKey(ORG_A, GH.max));
    expect((await confirm(w, MAX, started)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.linkGithub });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("reads the org's self-approval setting at confirmation: with it on, the requester's own approval counts", async () => {
    const w = await ready({ allowSelfApproval: true });
    const started = await pressed(w);
    w.github.statuses.set(7, pullStatus(7, { reviews: [reviewOf("priya")] }));
    expect((await confirm(w, PRIYA, started)).record.status).toBe("APPROVED_DONE");
    expect(mergedOf(w)).toEqual(["7:a:squash"]);
    const off = await ready();
    const offStarted = await pressed(off);
    off.github.statuses.set(7, pullStatus(7, { reviews: [reviewOf("priya")] }));
    expect((await confirm(off, PRIYA, offStarted)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
  });

  it("does not read an approval from a list of reviews GitHub cut short, or from a crowd of reviewers", async () => {
    const cut = await ready();
    const cutStarted = await pressed(cut);
    cut.github.statuses.set(7, pullStatus(7, { reviewsIncomplete: true }));
    expect((await confirm(cut, PRIYA, cutStarted)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
    const crowd = await ready();
    const crowdStarted = await pressed(crowd);
    crowd.github.statuses.set(7, pullStatus(7, { reviews: Array.from({ length: 9 }, (_, index) => ({ ...reviewOf("arjun"), githubUserId: String(3000 + index), login: `reviewer-${String(index)}` })) }));
    expect((await confirm(crowd, PRIYA, crowdStarted)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
    expect(crowd.github.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);
  });

  it("leaves a pull request whose tracking item is gone for a retry, merging nothing", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.db.delete(mergeTrackingKey(w.taskId, "payments", 7));
    await expect((await handlerOf(w, started)).run()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.github.mergeCalls).toEqual([]);
    expect(w.trackingOf({ repositoryId: "payments", number: 7 })).toBeUndefined();
  });

  it("merges three pull requests in repository order whatever order the task lists them in", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "billing", number: 8 }, { repositoryId: "payments", number: 7 }, { repositoryId: "alpha", number: 9 }] });
    const { record } = await confirm(w);
    expect(record.status).toBe("APPROVED_DONE");
    expect(mergedOf(w)).toEqual(["9:a:squash", "8:a:squash", "7:a:squash"]);
  });

  it("counts a pull request GitHub says was merged already as merged", async () => {
    const w = await ready();
    w.github.results.set(7, { outcome: "already_merged" });
    const { record } = await confirm(w);
    expect(record.status).toBe("APPROVED_DONE");
  });

  it("says why GitHub would not merge, for each reason it can give", async () => {
    for (const [reason, words] of [["forbidden", "GitHub did not allow Rovara to merge it"], ["closed", "it is closed"], ["not_mergeable", "GitHub would not merge it"]] as const) {
      const w = await ready();
      w.github.results.set(7, { outcome: "refused", reason });
      expect((await confirm(w)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.notMerged("payments", words) });
    }
  });
});

// ---- review fixes (Opus review of Task 19)

describe("after a half merge", () => {
  it("lets the person press Merge again and confirm it: only the pull requests still unmerged are in the change", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable" });
    expect((await confirm(w)).record.status).toBe("APPROVED_FAILED");
    // Today's observation marks the merged pull request MERGED in the workflow and in its tracking item.
    const current = (w.db.get(taskKey(w.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    w.setPullRequests(current.map((pr) => (pr.number === 8 ? { ...pr, state: "MERGED" } : pr)));
    w.db.set({ ...w.trackingOf({ repositoryId: "billing", number: 8 })!, state: "merged" });
    w.github.results.delete(7);
    w.clock.now += 130_000;
    const again = await confirm(w);
    expect(again.record).toMatchObject({ status: "APPROVED_DONE" });
    expect(mergedOf(w)).toEqual(["8:a:squash", "7:a:squash", "7:a:squash"]);
  });
});

describe("after a half merge, a second refusal", () => {
  it("still says which pull request merged, from what the workflow recorded", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    const current = (w.db.get(taskKey(w.taskId))!.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests;
    w.setPullRequests(current.map((pr) => (pr.number === 8 ? { ...pr, state: "MERGED" } : pr)));
    w.db.set({ ...w.trackingOf({ repositoryId: "billing", number: 8 })!, state: "merged" });
    w.github.statuses.set(8, pullStatus(8, { state: "merged" }));
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable" });
    expect((await confirm(w)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.halfMerged("billing", "payments", "GitHub would not merge it") });
  });
});

describe("who pressed, read again by a retry", () => {
  it("refuses a rerun for a presser who can no longer merge the task, before it reads anything from GitHub", async () => {
    const w = await ready();
    const started = await pressed(w);
    await expect((await handlerOf(w, started, ARJUN)).run()).rejects.toMatchObject({ code: "MERGE_NOT_READY", message: expect.stringContaining(M.presserLostRight) as string });
    expect(w.github.calls).toEqual([]);
  });

  it("refuses a task that was released after the press", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.db.set({ ...w.db.get(taskKey(w.taskId))!, releasedAt: "2026-10-22T09:30:00.000Z" });
    await expect((await handlerOf(w, started)).run()).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
    expect(w.github.calls).toEqual([]);
  });
});

describe("a GitHub link that outlived the membership", () => {
  it("does not count an approval from an account linked to someone who is no longer in the org (self-approval off)", async () => {
    const w = await ready();
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await codeOf(press(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
  });

  it("does not count it at confirmation either", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect((await confirm(w, PRIYA, started)).record).toMatchObject({ status: "APPROVED_FAILED", failure: M.needsOtherApproval("Priya") });
    expect(w.github.mergeCalls).toEqual([]);
  });
});

describe("what a merge leaves in the Audit Ledger", () => {
  it("records, in the claim's own transaction, who asked GitHub to merge which pull request and how", async () => {
    const w = await ready();
    const { approvalId } = await confirm(w);
    const [event] = w.audit.recordedBy("pull_request.merge_requested");
    expect(event).toMatchObject({ action: "pull_request.merge_requested", actor: { kind: "member", id: PRIYA }, facts: { number: 7, method: "squash" }, related: [approvalId] });
    const claimTransaction = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("mergeClaim")))!;
    expect(JSON.stringify(claimTransaction)).toContain("AUDIT_PENDING");
    expect(JSON.stringify(event!.target)).not.toContain("payments");
  });

  it("records nothing for a claim that was lost", async () => {
    const w = await ready();
    const started = await pressed(w);
    w.db.set({ ...w.trackingOf({ repositoryId: "payments", number: 7 })!, mergeClaim: { headSha: HEAD_A, by: ARJUN, at: new Date(w.clock.now).toISOString() } });
    await expect((await handlerOf(w, started)).run()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.audit.recordedBy("pull_request.merge_requested")).toEqual([]);
  });
});

// ---- the route

describe("POST /v1/app/sessions/{id}/merge", () => {
  const route = (w: MergeWorld, who: string, method: string, path: string, body?: unknown) => routeAgentSessionRequest(
    { ...w.shareDeps, origin: CELL, approvals: w.deps } as never, w.caller(who),
    { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(`${CELL}${path}`),
  );

  it("answers 202 with the link where the presser confirms it, and refuses a GET and an extra segment", async () => {
    const w = await ready();
    const reply = await route(w, PRIYA, "POST", `/v1/app/sessions/${w.sessionId}/merge`, { requestId: w.requestId() });
    expect(reply).toMatchObject({ statusCode: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" } });
    expect(w.github.mergeCalls).toEqual([]);
    expect(await codeOf(route(w, PRIYA, "GET", `/v1/app/sessions/${w.sessionId}/merge`))).toMatchObject({ code: "NOT_FOUND" });
    expect(await codeOf(route(w, PRIYA, "POST", `/v1/app/sessions/${w.sessionId}/merge/now`, { requestId: w.requestId() }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 409 MERGE_NOT_READY in the exact words when it is not ready", async () => {
    const w = await ready({}, { ci: "failing", failingChecks: ["test"] });
    expect(await codeOf(route(w, PRIYA, "POST", `/v1/app/sessions/${w.sessionId}/merge`, { requestId: w.requestId() }))).toEqual({ code: "MERGE_NOT_READY", message: M.checks });
  });
});

// ---- the task view

describe("the task view's merge field", () => {
  it("is not shown to a client that does not ask for the version 2 view", () => {
    const view = { taskId: "t", title: "x", project: "web", status: "RUNNING", merge: { ready: false, message: "x" } } as never;
    expect("merge" in taskViewForClient(view, {})).toBe(false);
    expect("merge" in taskViewForClient(view, { "x-agentx-task-view": "2" })).toBe(true);
  });

  it("says whether the viewer pressing Merge now would be allowed, with the viewer as the presser", async () => {
    const w = await ready({}, { approval: { githubUserId: GH.max, login: LOGIN.max, commitId: HEAD_A } });
    const task = w.db.get(taskKey(w.taskId))! as never;
    const items = [w.trackingOf({ repositoryId: "payments", number: 7 })!];
    // Priya asked for the change and Max approved it: Priya may press, Max (the only approver) may not.
    expect(await mergeViewOf(w.deps, task, items, PRIYA)).toMatchObject({ ready: true, risk: { level: "low" } });
    expect(await mergeViewOf(w.deps, task, items, MAX)).toMatchObject({ ready: false, message: M.presserApproved });
    // Nothing tracked yet: no view.
    expect(await mergeViewOf(w.deps, task, [], PRIYA)).toBeUndefined();
  });

  it("is not ready while the task is blocked, and reads nothing from GitHub to say so", async () => {
    const w = await ready({}, { ci: "failing", failingChecks: ["test"] });
    const task = w.db.get(taskKey(w.taskId))! as never;
    expect(await mergeViewOf(w.deps, task, [w.trackingOf({ repositoryId: "payments", number: 7 })!], PRIYA)).toMatchObject({ ready: false, message: M.checks });
    expect(w.github.calls).toEqual([]);
  });
});

// ---- round trip (bug E): what the broker really answers, read by the schema each client reads it with

describe("round trip: the merge answers, as the broker sends them", () => {
  it("POST …/merge answers 202 NEEDS_CONFIRMATION with the gateway's requestId, which the clients' reader reads; the strict contract holds without it", async () => {
    const w = await ready();
    const path = `/v1/app/sessions/${w.sessionId}/merge`;
    const answer = await routeAgentSessionRequest(
      { ...w.shareDeps, origin: CELL, approvals: w.deps } as never, w.caller(PRIYA), { method: "POST", path, headers: {}, requestId: "r", body: JSON.stringify({ requestId: w.requestId() }) }, new URL(`${CELL}${path}`),
    );
    const wire = developerReply(answer, "gateway-1");
    expect(wire.statusCode).toBe(202);
    const body = JSON.parse(wire.body) as Record<string, unknown>;
    expect(body.requestId).toBe("gateway-1");
    expect(NeedsConfirmationReaderSchema.safeParse(body).success).toBe(true);
    const { requestId: _gateway, ...own } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- set aside on purpose
    expect(NeedsConfirmationSchema.safeParse(own).success).toBe(true);
  });

  it("the task view's merge field is what the view's schema allows, ready or not", async () => {
    const w = await ready({}, { approval: { githubUserId: GH.max, login: LOGIN.max, commitId: HEAD_A } });
    const task = w.db.get(taskKey(w.taskId))! as never;
    const items = [w.trackingOf({ repositoryId: "payments", number: 7 })!];
    for (const who of [PRIYA, MAX]) {
      const view = await mergeViewOf(w.deps, task, items, who);
      expect(MergeViewSchema.safeParse(view).success, JSON.stringify(view)).toBe(true);
    }
  });

  it("every refusal's words fit the view at the longest names the contracts allow (a 200 character repository ID, a 255 character branch, an 80 character requester)", () => {
    const repository = "r".repeat(200);
    const branch = "b".repeat(255);
    const pullRequests = [facts({ repositoryId: repository, number: 8, baseBranch: branch }), facts({ repositoryId: "payments", number: 9 })];
    const cases = [
      readiness({ pullRequests, recordedBases: new Map(pullRequests.map((pr) => [keyOf(pr), "main"])) }),
      readiness({ pullRequests: [facts({ repositoryId: repository, baseBranch: branch, branch: "conflicted" }), facts({ repositoryId: "payments", number: 9 })] }),
      readiness({ pullRequests: [facts({ repositoryId: repository, baseBranch: branch, branch: "behind", behindRequired: true }), facts({ repositoryId: "payments", number: 9 })] }),
      readiness({ pullRequests: [facts({ repositoryId: repository }), facts({ repositoryId: "payments", number: 9 })], approvals: new Map(), requesterName: "q".repeat(80) }),
    ];
    for (const refusal of cases) {
      expect(refusal.ready).toBe(false);
      const view = mergeViewFromReadiness(refusal);
      expect(MergeViewSchema.safeParse(view).success, JSON.stringify(view)).toBe(true);
    }
    // The cut keeps the words' start, and a message that fits is passed on as it was.
    const long = mergeViewFromReadiness(cases[0]!);
    expect(long.message!.endsWith("\u2026")).toBe(true);
    expect((cases[0] as { message: string }).message.startsWith(long.message!.slice(0, -1))).toBe(true);
    expect(mergeViewFromReadiness({ ready: false, message: M.checks })).toEqual({ ready: false, message: M.checks });
    expect(mergeViewFromReadiness({ ready: true })).toEqual({ ready: true });
  });
});

// ---- who asked for the task follows the task's owner (task-owner-reads: no raw read of a take-over)

describe("the requesters of a task", () => {
  const task = (extra: Record<string, unknown> = {}) => ({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", developerId: "a".repeat(64), developerName: "Ana", provider: "oidc" as const, startedBy: { developerId: "b".repeat(64) }, ...extra }) as never;
  const taker = { developerId: "c".repeat(64), name: "Cy", provider: "oidc", since: "2026-10-25T12:00:00.000Z" };

  it("are the creator, whoever started it and the owner now, who is the taker after a take-over", () => {
    expect(requesterIds(task())).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(requesterIds(task({ currentOwner: taker }))).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
  });

  it("cannot be told when the taker's record is not whole, and no approval is then taken for a reviewer's", async () => {
    const broken = task({ currentOwner: { developerId: "c".repeat(64) } });
    expect(requesterIds(broken)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(await requesterGithubIds({} as never, ORG_A, broken)).toBe("unlinked");
  });
});
