// Rovara Code (Plan 6 Task 19): "Approved by <login>. Ready to merge: <session link>". Merge tracking says it once for each approval that counts: from a person with write access who
// is a member of the org and not a requester (unless the org allows self-approval), on the head.
import { afterEach, describe, expect, it } from "vitest";
import { codeSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { orgMemberKey } from "../../packages/contracts/src/index.js";
import { trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { linkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { HEAD_A, HEAD_B, SESSION_ID, TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const REQUESTER = "a".repeat(64);
const REVIEWER = "b".repeat(64);
const ORIGIN = "https://cell.example.com";
const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

const passing = [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }];
const approval = (login: string, id: string, commitId = HEAD_A) => ({ githubUserId: id, login, userType: "User", state: "APPROVED" as const, commitId, submittedAt: "2026-10-25T11:30:00.000Z" });

async function approvedWorld(options: { linked?: boolean; requesterLinked?: boolean; selfApproval?: boolean; reviews?: ReturnType<typeof approval>[] } = {}) {
  const w = world();
  w.setTask({ developerId: REQUESTER, developerName: "Priya" });
  const members = { documentClient: w.db, tableName: "state", now: () => w.now() };
  for (const developerId of [REQUESTER, REVIEWER]) w.db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  if (options.requesterLinked !== false) await linkGithubMember(members, TEST_ORG, REQUESTER, "1001");
  if (options.linked !== false) await linkGithubMember(members, TEST_ORG, REVIEWER, "1004");
  if (options.selfApproval === true) w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 });
  w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: options.reviews ?? [approval("arjun-gh", "1004")] }));
  w.github.permissions.set("arjun-gh", "write");
  w.github.permissions.set("priya-gh", "write");
  return { w, deps: { ...w.deps, origin: ORIGIN } };
}
const heard = (): string[] => {
  const list: string[] = [];
  unregister.push(registerCodeMilestoneHandler({ name: "approved_test", on: async (_deps, milestone) => { if (milestone.kind === "approved") list.push(milestone.text); } }));
  return list;
};
const milestones = (w: TrackingWorld) => w.db.find((item) => item.pk === `DEVTASK#${TASK_ID}` && String(item.sk).startsWith("CODE_MILESTONE#approved"));

describe("the approved milestone", () => {
  it("says who approved and where to press Merge, once", async () => {
    const list = heard();
    const { w, deps } = await approvedWorld();
    await trackPullRequest(deps, TASK_ID);
    expect(list).toEqual([`Approved by arjun-gh. Ready to merge: ${ORIGIN}/app/sessions/${SESSION_ID}`]);
    expect(milestones(w)).toHaveLength(1);
    expect(milestones(w)[0]).toMatchObject({ kind: "approved", sessionId: SESSION_ID, pullRequests: [{ repository: "payments", number: 7 }] });
    // Nothing new on GitHub: nothing more is said.
    await trackPullRequest(deps, TASK_ID);
    expect(list).toHaveLength(1);
    expect(milestones(w)).toHaveLength(1);
  });

  it("does not say it again when the approval stands and something else on the pull request changes", async () => {
    const list = heard();
    const { w, deps } = await approvedWorld();
    await trackPullRequest(deps, TASK_ID);
    const pending = [{ name: "test", status: "pending" as const, required: false, url: "" }];
    w.github.statuses.set(7, status({ draft: false, checks: pending, reviews: [approval("arjun-gh", "1004")] }));
    await trackPullRequest(deps, TASK_ID);
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [approval("arjun-gh", "1004")] }));
    await trackPullRequest(deps, TASK_ID);
    expect(list).toHaveLength(1);
    expect(milestones(w)).toHaveLength(1);
  });

  it("leaves the link out when the control plane has no origin to build it from", async () => {
    const list = heard();
    const { w } = await approvedWorld();
    await trackPullRequest(w.deps, TASK_ID);
    expect(list).toEqual(["Approved by arjun-gh. Ready to merge."]);
  });

  it("says it again for a new approval of new code, not for the same one", async () => {
    const list = heard();
    const { w, deps } = await approvedWorld();
    await trackPullRequest(deps, TASK_ID);
    w.github.statuses.set(7, status({ draft: false, headSha: HEAD_B, checks: passing, reviews: [approval("arjun-gh", "1004", HEAD_B)] }));
    await trackPullRequest(deps, TASK_ID);
    expect(list).toHaveLength(2);
  });

  it("says nothing for an approval that does not count: the requester's own, an account linked to no member, a requester with no link", async () => {
    const list = heard();
    const own = await approvedWorld({ reviews: [approval("priya-gh", "1001")] });
    await trackPullRequest(own.deps, TASK_ID);
    const stranger = await approvedWorld({ linked: false });
    await trackPullRequest(stranger.deps, TASK_ID);
    const unlinked = await approvedWorld({ requesterLinked: false });
    await trackPullRequest(unlinked.deps, TASK_ID);
    expect(list).toEqual([]);
    expect(milestones(own.w)).toEqual([]);
    expect(milestones(stranger.w)).toEqual([]);
    expect(milestones(unlinked.w)).toEqual([]);
  });

  it("counts the requester's own approval when the org allows self-approval", async () => {
    const list = heard();
    const { deps } = await approvedWorld({ reviews: [approval("priya-gh", "1001")], selfApproval: true });
    await trackPullRequest(deps, TASK_ID);
    expect(list).toEqual([`Approved by priya-gh. Ready to merge: ${ORIGIN}/app/sessions/${SESSION_ID}`]);
  });

  it("announces a standing approval once the org allows self-approval, and only once", async () => {
    const list = heard();
    const { w, deps } = await approvedWorld({ reviews: [approval("priya-gh", "1001")] });
    await trackPullRequest(deps, TASK_ID);
    expect(list).toEqual([]);
    w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 });
    await trackPullRequest(deps, TASK_ID);
    expect(list).toEqual([`Approved by priya-gh. Ready to merge: ${ORIGIN}/app/sessions/${SESSION_ID}`]);
    await trackPullRequest(deps, TASK_ID);
    expect(list).toHaveLength(1);
    expect(milestones(w)).toHaveLength(1);
  });

  it("announces a standing approval once the reviewer is linked to a member", async () => {
    const list = heard();
    const { w, deps } = await approvedWorld({ linked: false });
    await trackPullRequest(deps, TASK_ID);
    expect(list).toEqual([]);
    await linkGithubMember({ documentClient: w.db, tableName: "state", now: () => w.now() }, TEST_ORG, REVIEWER, "1004");
    await trackPullRequest(deps, TASK_ID);
    expect(list).toHaveLength(1);
  });

  it("keeps the session line and the milestone in one transaction with the tracking item", async () => {
    heard();
    const { w, deps } = await approvedWorld();
    await trackPullRequest(deps, TASK_ID);
    const transaction = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("CODE_MILESTONE#approved")))!;
    expect(transaction).toBeDefined();
    expect(JSON.stringify(transaction)).toContain("MERGE_TRACKING#payments#7");
  });
});
