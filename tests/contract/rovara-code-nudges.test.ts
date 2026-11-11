// Rovara Code (Plan 6 Task 18): nudging reviewers. A pull request that is waiting for review reminds the people GitHub lists as requested reviewers, and only those who are members of
// the org: the first time 24 hours after the request, then every 48 hours, on weekdays in UTC, at most three times, through Home and Slack (the milestone hook) and never as a GitHub
// comment. After the third reminder has had its window, the task's owner is told once. Everything rides the tracking pass; nothing here changes the workflow.
import { afterEach, describe, expect, it } from "vitest";
import { CODE_REVIEWERS_MAX, REVIEW_NUDGES_MAX } from "@rovara-code/contracts";
import { type MergeTrackingItem } from "../../packages/cloud-contracts/src/rovara-code.js";
import { agentSessionKey, codeMilestoneKey, codeSettingsKey, githubMemberKey, mergeTrackingKey, mySessionsKey, reviewNudgeLedgerKey, reviewWaitKey } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { nextNudgeAt, nudgesDue, reviewWaitsOf, runReviewNudges } from "../../packages/broker/src/rovara-code/nudges.js";
import { registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { linkGithubMember, unlinkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { trackPullRequest, trackTask } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { homeCards, type HomeDependencies } from "../../packages/broker/src/agent-sessions/home.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { REQUESTED_REVIEWER_IDS_MAX, requestedReviewerIds } from "../../packages/broker/src/github-pull-status.js";
import { HEAD_A, SESSION_ID, TABLE, TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { CELL, MAX, PRIYA, ZED, ORG_A, ORG_B, BO, sessionWorld } from "../support/agent-session-world.js";
import { TEST_ORG } from "../support/orgs.js";

const H = 3_600_000;
const DAY = 24 * H;
// 2026-10-26 is a Monday.
const MON = Date.parse("2026-10-26T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = "owner-dev";
const ALICE = "alice-dev";
const BOB = "bob-dev";
const passing = [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }];

const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

function item(overrides: Partial<MergeTrackingItem> = {}): MergeTrackingItem {
  return {
    orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "payments", number: 7, version: 3, headSha: HEAD_A, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "all_checks",
    checksEverSeen: true, failingChecks: [], review: "requested", branch: "up_to_date", headByRovara: true, readyAt: iso(MON), reviewersRequestedAt: iso(MON), nudges: { count: 0 },
    syncs: { day: "2026-10-26", count: 0 }, decisionDigest: "d".repeat(64), observedAt: iso(MON), ...overrides,
  };
}

describe("when a reminder is due", () => {
  it("is not due before 24 hours have passed since the request, then names the reviewers it is for", () => {
    expect(nudgesDue(item(), ["1001"], MON + 24 * H - 1)).toBeUndefined();
    expect(nudgesDue(item(), ["1001", "1002"], MON + 24 * H)).toEqual({ number: 1, githubUserIds: ["1001", "1002"] });
  });

  it("asks again every 48 hours after the last reminder, up to the third", () => {
    const tue = MON + DAY;
    const second = item({ nudges: { count: 1, lastAt: iso(tue) } });
    expect(nudgesDue(second, ["1001"], tue + 48 * H - 1)).toBeUndefined();
    expect(nudgesDue(second, ["1001"], tue + 48 * H)).toEqual({ number: 2, githubUserIds: ["1001"] });
    // Thursday 09:00 plus 48 hours is Saturday: the third waits for Monday 00:00 UTC.
    const thu = MON + 3 * DAY;
    const third = item({ nudges: { count: 2, lastAt: iso(thu) } });
    expect(nudgesDue(third, ["1001"], thu + 48 * H)).toBeUndefined();
    expect(nudgesDue(third, ["1001"], thu + 60 * H)).toBeUndefined();
    expect(nudgesDue(third, ["1001"], Date.parse("2026-11-02T00:00:00.000Z") - 1)).toBeUndefined();
    expect(nudgesDue(third, ["1001"], Date.parse("2026-11-02T00:00:00.000Z"))).toEqual({ number: 3, githubUserIds: ["1001"] });
    expect(nextNudgeAt(third)).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
  });

  it("never sends on a Saturday or a Sunday, even when it is overdue, and a request on a Friday waits for Monday", () => {
    const fri = Date.parse("2026-10-30T12:00:00.000Z");
    const asked = item({ readyAt: iso(fri), reviewersRequestedAt: iso(fri) });
    expect(nudgesDue(asked, ["1001"], fri + 25 * H)).toBeUndefined();
    expect(nudgesDue(asked, ["1001"], Date.parse("2026-11-01T23:59:59.000Z"))).toBeUndefined();
    expect(nudgesDue(asked, ["1001"], Date.parse("2026-11-02T00:00:00.000Z"))).toMatchObject({ number: 1 });
    // A sweep that was late and runs on Saturday does not send what became due on Tuesday.
    const overdue = item();
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-10-31T10:00:00.000Z"))).toBeUndefined();
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-11-02T10:00:00.000Z"))).toMatchObject({ number: 1 });
  });

  it("treats Sunday like Saturday: a time that falls on it moves to Monday, and nothing is sent on it", () => {
    const sat = Date.parse("2026-10-31T12:00:00.000Z");
    expect(nextNudgeAt(item({ readyAt: iso(sat), reviewersRequestedAt: iso(sat) }))).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
    const thu = Date.parse("2026-10-29T12:00:00.000Z");
    const overdue = item({ readyAt: iso(thu), reviewersRequestedAt: iso(thu) });
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-10-30T11:00:00.000Z"))).toBeUndefined();
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-10-30T13:00:00.000Z"))).toMatchObject({ number: 1 });
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-11-01T12:00:00.000Z"))).toBeUndefined();
    expect(nudgesDue(overdue, ["1001"], Date.parse("2026-10-31T12:00:00.000Z"))).toBeUndefined();
  });

  it("is never more than the third, and says when the owner is told: one more window after the third reminder", () => {
    const thu = MON + 3 * DAY;
    const done = item({ nudges: { count: REVIEW_NUDGES_MAX, lastAt: iso(thu) } });
    expect(nudgesDue(done, ["1001"], thu + 30 * DAY)).toBeUndefined();
    expect(nextNudgeAt(done)).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
    const monday = Date.parse("2026-11-02T09:00:00.000Z");
    expect(nextNudgeAt(item({ nudges: { count: REVIEW_NUDGES_MAX, lastAt: iso(monday) } }))).toBe(monday + 2 * DAY);
  });

  it("counts from the time the reviewers were asked when Rovara asked them, else from when the pull request became ready", () => {
    const later = iso(MON + DAY);
    expect(nextNudgeAt(item({ reviewersRequestedAt: later }))).toBe(MON + 2 * DAY);
    const { reviewersRequestedAt: _unused, ...withoutAsk } = item(); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    expect(nextNudgeAt(withoutAsk)).toBe(MON + DAY);
    const { readyAt: _ready, reviewersRequestedAt: _asked, ...never } = item(); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    expect(nextNudgeAt(never)).toBeUndefined();
  });

  it("is none once approved or changes are requested, nothing is asked for, while a draft, when not open, or with no one to remind", () => {
    const at = MON + 2 * DAY;
    for (const stopped of [
      item({ review: "approved" }), item({ review: "changes_requested" }), item({ review: "not_requested" }), item({ draft: true }), item({ state: "closed" }), item({ state: "merged" }),
    ]) {
      expect(nudgesDue(stopped, ["1001"], at), JSON.stringify([stopped.review, stopped.draft, stopped.state])).toBeUndefined();
      expect(nextNudgeAt(stopped)).toBeUndefined();
    }
    expect(nudgesDue(item(), [], at)).toBeUndefined();
  });
});

// ---- the tracking pass

const memberOf = (w: TrackingWorld, developerId: string) => w.db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
const link = async (w: TrackingWorld, developerId: string, githubUserId: string) => linkGithubMember({ documentClient: w.db, tableName: TABLE, now: () => w.now() }, TEST_ORG, developerId, githubUserId);
const itemOf = (w: TrackingWorld) => w.db.get(mergeTrackingKey(TASK_ID, "payments", 7)) as unknown as MergeTrackingItem;
const requestedBy = (w: TrackingWorld, ids: string[], more: Partial<ReturnType<typeof status>> = {}) =>
  w.github.statuses.set(7, status({ checks: passing, draft: false, requestedReviewers: ids.length, requestedReviewerIds: ids, ...more }));

/** Monday 09:00 UTC: the pull request is ready and the reviewers are asked in this pass. Alice (1001) is a linked member; the owner owns the task. */
async function waiting(options: { ids?: string[]; linked?: boolean } = {}) {
  const w = world();
  w.setNow(MON);
  w.setTask({ title: "Bump the SDK", developerId: OWNER, developerName: "Olivia", provider: "oidc" });
  memberOf(w, OWNER);
  memberOf(w, ALICE);
  if (options.linked !== false) await link(w, ALICE, "1001");
  requestedBy(w, options.ids ?? ["1001"], { requestedReviewers: 0 });
  w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["alice"], revision: 1 });
  await trackPullRequest(w.deps, TASK_ID);
  expect(itemOf(w)).toMatchObject({ draft: false, readyAt: iso(MON), reviewersRequestedAt: iso(MON), nudges: { count: 0 } });
  // GitHub now lists the people who were asked.
  requestedBy(w, options.ids ?? ["1001"]);
  return w;
}
const pass = async (w: TrackingWorld, at: number) => { w.setNow(at); return trackPullRequest(w.deps, TASK_ID); };

function hear() {
  const heard: Array<{ kind: string; text: string; to?: string[] | undefined; sessionId?: string | undefined }> = [];
  unregister.push(registerCodeMilestoneHandler({ name: "nudge_test", on: async (_deps, milestone) => { if (milestone.kind === "review_nudge" || milestone.kind === "stuck") heard.push({ kind: milestone.kind, text: milestone.text, to: milestone.to, sessionId: milestone.sessionId }); } }));
  return heard;
}
const milestonesOf = (w: TrackingWorld, kind: string) => w.db.find((stored) => typeof stored["sk"] === "string" && stored["sk"].startsWith(`CODE_MILESTONE#${kind}#`));

describe("reminders on the tracking pass", () => {
  it("reminds on Tuesday, Thursday and the next Monday, then tells the owner once, a window after the third", async () => {
    const heard = hear();
    const w = await waiting();
    await pass(w, MON + 23 * H);
    expect(heard).toEqual([]);
    await pass(w, MON + DAY);
    expect(heard).toEqual([{ kind: "review_nudge", text: "payments #7 has been waiting for your review for 1 day", to: [ALICE], sessionId: undefined }]);
    await pass(w, MON + DAY + 6 * H);
    await pass(w, MON + 2 * DAY);
    expect(heard).toHaveLength(1);
    await pass(w, MON + 3 * DAY);
    expect(heard[1]).toMatchObject({ kind: "review_nudge", text: "payments #7 has been waiting for your review for 3 days", to: [ALICE] });
    await pass(w, Date.parse("2026-10-31T09:00:00.000Z"));
    await pass(w, Date.parse("2026-11-01T09:00:00.000Z"));
    expect(heard).toHaveLength(2);
    await pass(w, Date.parse("2026-11-02T09:00:00.000Z"));
    expect(heard[2]).toMatchObject({ kind: "review_nudge", text: "payments #7 has been waiting for your review for 7 days", to: [ALICE] });
    expect(itemOf(w).nudges).toEqual({ count: 3, lastAt: "2026-11-02T09:00:00.000Z" });
    // The third reminder gets its window before the owner is told.
    await pass(w, Date.parse("2026-11-03T09:00:00.000Z"));
    expect(heard).toHaveLength(3);
    await pass(w, Date.parse("2026-11-04T09:00:00.000Z"));
    expect(heard).toHaveLength(4);
    expect(heard[3]).toEqual({ kind: "stuck", text: "Nobody has reviewed \"Bump the SDK\" after 3 reminders. You may want to ask someone directly.", to: [OWNER], sessionId: SESSION_ID });
    for (const later of ["2026-11-05T09:00:00.000Z", "2026-11-09T09:00:00.000Z", "2026-12-01T09:00:00.000Z"]) await pass(w, Date.parse(later));
    expect(heard).toHaveLength(4);
    expect(itemOf(w).nudges.count).toBe(3);
    expect(milestonesOf(w, "review_nudge")).toHaveLength(3);
    expect(milestonesOf(w, "stuck")).toHaveLength(1);
  });

  it("sends one reminder per window however often the sweep retries, even from a stale read", async () => {
    const heard = hear();
    const w = await waiting();
    const tue = MON + DAY;
    await pass(w, tue);
    await pass(w, tue + 1000);
    await pass(w, tue + 60_000);
    expect(heard.filter((entry) => entry.kind === "review_nudge")).toHaveLength(1);
    // A second runner holding the item as it was before the first one wrote: it changes nothing.
    const stale = item({ version: itemOf(w).version - 1, nudges: { count: 0 }, readyAt: iso(MON), reviewersRequestedAt: iso(MON) });
    const task = w.db.get(taskKey(TASK_ID))!;
    const before = w.db.find(() => true).length;
    const result = await runReviewNudges({ documentClient: w.db, tableName: TABLE, now: () => tue + 2000 }, {
      task: task as never, pullRequest: { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7" }, item: stale, requested: ["1001"],
    });
    expect(result.sent).toBe("none");
    expect(w.db.find(() => true)).toHaveLength(before);
    expect(itemOf(w).nudges.count).toBe(1);
  });

  it("stops at an approval, at changes requested, when the reviewer has reviewed, and when the pull request is merged or closed", async () => {
    for (const stop of [
      (w: TrackingWorld) => requestedBy(w, ["1001"], { reviews: [{ githubUserId: "2002", login: "bob", userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: iso(MON + 2 * H) }] }),
      (w: TrackingWorld) => requestedBy(w, ["1001"], { reviews: [{ githubUserId: "2002", login: "bob", userType: "User", state: "CHANGES_REQUESTED", commitId: HEAD_A, submittedAt: iso(MON + 2 * H) }] }),
      (w: TrackingWorld) => requestedBy(w, []),
      (w: TrackingWorld) => requestedBy(w, ["1001"], { state: "closed" }),
      (w: TrackingWorld) => requestedBy(w, ["1001"], { state: "merged" }),
    ]) {
      const heard = hear();
      const w = await waiting();
      w.github.permissions.set("bob", "write");
      stop(w);
      await pass(w, MON + DAY);
      await pass(w, MON + 3 * DAY);
      expect(heard, "nothing is said").toEqual([]);
      expect(itemOf(w).nudges.count).toBe(0);
      unregister.pop()!();
    }
  });

  it("stops when the task is closed or released, and for a version 1 task", async () => {
    const heard = hear();
    const w = await waiting();
    w.setTask({ closedAt: iso(MON + 2 * H) });
    await pass(w, MON + DAY);
    expect(heard).toEqual([]);
    const released = await waiting();
    released.setTask({ releasedAt: iso(MON + 2 * H) });
    await pass(released, MON + DAY);
    expect(heard).toEqual([]);
    const v1 = world({ definitionVersion: "1.0.0" });
    v1.setNow(MON + DAY);
    await trackPullRequest(v1.deps, TASK_ID);
    expect(milestonesOf(v1, "review_nudge")).toEqual([]);
  });

  it("reminds only requested reviewers who are linked members of the org: others get nothing and use up none of the three", async () => {
    const heard = hear();
    const w = await waiting({ ids: ["1001", "3003", "4004", "5005"] });
    memberOf(w, BOB);
    // 3003 has no link at all; 4004 is linked to a person who is no longer a member of the org; 5005's link is another org's.
    await linkGithubMember({ documentClient: w.db, tableName: TABLE, now: () => w.now() }, TEST_ORG, "gone-dev", "4004");
    await linkGithubMember({ documentClient: w.db, tableName: TABLE, now: () => w.now() }, "org_zzzzzzzzzzzzzzzzzzzz", BOB, "5005");
    await pass(w, MON + DAY);
    expect(heard).toEqual([{ kind: "review_nudge", text: "payments #7 has been waiting for your review for 1 day", to: [ALICE], sessionId: undefined }]);

    const nobody = await waiting({ linked: false, ids: ["1001", "3003"] });
    await pass(nobody, MON + DAY);
    await pass(nobody, MON + 3 * DAY);
    expect(heard).toHaveLength(1);
    expect(itemOf(nobody).nudges.count).toBe(0);
    // When the reviewer does link, the reminders begin (late, but not lost).
    await link(nobody, ALICE, "1001");
    await pass(nobody, MON + 4 * DAY);
    expect(heard).toHaveLength(2);
    expect(itemOf(nobody).nudges.count).toBe(1);
  });

  it("does not remind a linked person who has become an Auditor, and still reminds the member beside them (I2 re-check)", async () => {
    const heard = hear();
    const w = await waiting({ ids: ["1001", "6006"] });
    const AUDITOR = "auditor-dev";
    w.db.set({ ...orgMemberKey(TEST_ORG, AUDITOR), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: AUDITOR, role: "auditor", joinedAt: "2026-10-01T00:00:00.000Z" });
    await link(w, AUDITOR, "6006");
    await pass(w, MON + DAY);
    expect(heard).toEqual([{ kind: "review_nudge", text: "payments #7 has been waiting for your review for 1 day", to: [ALICE], sessionId: undefined }]);
  });

  it("does not remind a GitHub account whose link is only half there, and takes the reminder from someone who unlinked since", async () => {
    const heard = hear();
    const w = await waiting({ ids: ["1001", "3003", "6006"] });
    memberOf(w, BOB);
    await link(w, BOB, "3003");
    // 6006 is linked from the GitHub side only: the member's own side does not name it.
    memberOf(w, "carl-dev");
    w.db.set({ ...githubMemberKey(TEST_ORG, "6006"), entityType: "GITHUB_MEMBER", orgId: TEST_ORG, githubUserId: "6006", developerId: "carl-dev", linkedAt: iso(MON) });
    await pass(w, MON + DAY);
    expect(heard[0]!.to).toEqual([ALICE, BOB]);
    const reminded = async (who: string) => (await reviewWaitsOf({ documentClient: w.db, tableName: TABLE }, TEST_ORG, who)).length;
    expect([await reminded(ALICE), await reminded(BOB), await reminded("carl-dev")]).toEqual([1, 1, 0]);
    // Bob unlinks his account but is still listed: the next reminder is Alice's alone and Bob's Home item goes with it.
    await unlinkGithubMember({ documentClient: w.db, tableName: TABLE, now: () => w.now() }, TEST_ORG, BOB);
    await pass(w, MON + 3 * DAY);
    expect(heard[1]!.to).toEqual([ALICE]);
    expect([await reminded(ALICE), await reminded(BOB)]).toEqual([1, 0]);
  });

  it("does not trust a ledger that names another org", async () => {
    const w = await waiting({ ids: ["1001", "3003"] });
    memberOf(w, BOB);
    await link(w, BOB, "3003");
    await pass(w, MON + DAY);
    const ledger = w.db.get(reviewNudgeLedgerKey(TASK_ID, "payments", 7))!;
    w.db.set({ ...ledger, orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    requestedBy(w, ["1001"]);
    await pass(w, MON + DAY + H);
    // Bob's item stays: the ledger that would have named him is not this org's, so nothing was taken away on its word.
    expect((await reviewWaitsOf({ documentClient: w.db, tableName: TABLE }, TEST_ORG, BOB)).length).toBe(1);
  });

  it("ignores requested teams, and reminds no more than the project's reviewer limit at once", async () => {
    const heard = hear();
    const w = await waiting({ ids: [] });
    w.github.statuses.set(7, status({ checks: passing, draft: false, requestedReviewers: 2 }));
    await pass(w, MON + DAY);
    expect(heard).toEqual([]);

    const crowd = await waiting({ ids: [] });
    const ids = Array.from({ length: CODE_REVIEWERS_MAX + 5 }, (_unused, index) => String(7000 + index));
    for (const id of ids) { memberOf(crowd, `dev-${id}`); await link(crowd, `dev-${id}`, id); }
    requestedBy(crowd, ids);
    await pass(crowd, MON + DAY);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.to).toHaveLength(CODE_REVIEWERS_MAX);
  });

  it("never touches GitHub for a reminder, never changes the workflow, and says nothing personal", async () => {
    const heard = hear();
    const w = await waiting();
    const workflowBefore = structuredClone(w.task()["workflow"]);
    const tue = MON + DAY;
    const callsBefore = w.github.calls.length;
    await pass(w, tue - 1);
    const readCalls = w.github.calls.length - callsBefore;
    await pass(w, tue);
    expect(heard).toHaveLength(1);
    // The pass that sent the reminder made the same GitHub requests as the one that did not; nothing is posted, no comment is asked for.
    expect(w.github.calls.length - callsBefore - readCalls).toBe(readCalls);
    expect(w.github.calls.every((call) => /^(status|permission|ready|reviewers):/.test(call))).toBe(true);
    for (const later of [MON + 3 * DAY, Date.parse("2026-11-02T09:00:00.000Z"), Date.parse("2026-11-04T09:00:00.000Z")]) await pass(w, later);
    expect(heard).toHaveLength(4);
    expect(w.task()["workflow"]).toEqual(workflowBefore);
    for (const entry of heard) {
      expect(entry.text).not.toMatch(/alice|1001|@/iu);
    }
    // The owner's timeline gets a plain line for each reminder: how many, never who.
    const lines = w.db.find((stored) => stored["entityType"] === "AGENT_SESSION_EVENT").map((event) => event["text"]);
    expect(lines).toEqual(expect.arrayContaining([
      "Rovara reminded the requested reviewers of payments pull request 7 (reminder 1 of 3).",
      "Rovara reminded the requested reviewers of payments pull request 7 (reminder 3 of 3).",
    ]));
    expect(JSON.stringify(lines)).not.toMatch(/alice|1001/iu);
  });

  it("is a write the tracking item's version guards: a pass that lost the race sends nothing, and the next one sends once", async () => {
    const heard = hear();
    const w = await waiting();
    const tue = MON + DAY;
    w.setNow(tue);
    const read = itemOf(w);
    // Another writer moves the tracking item on after this runner read it.
    w.db.set({ ...w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))!, version: read.version + 1 });
    const lost = await runReviewNudges({ documentClient: w.db, tableName: TABLE, now: () => tue }, {
      task: w.db.get(taskKey(TASK_ID)) as never, pullRequest: { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7" }, item: read, requested: ["1001"],
    });
    expect(lost.sent).toBe("none");
    expect(heard).toEqual([]);
    expect(milestonesOf(w, "review_nudge")).toEqual([]);
    await pass(w, tue + 1000);
    expect(heard).toHaveLength(1);
  });

  it("sends nothing for a task that ended between the read and the write", async () => {
    const heard = hear();
    const w = await waiting();
    const tue = MON + DAY;
    w.setNow(tue);
    const read = itemOf(w);
    w.setTask({ closedAt: iso(tue - 1000) });
    const result = await runReviewNudges({ documentClient: w.db, tableName: TABLE, now: () => tue }, {
      task: { ...(w.db.get(taskKey(TASK_ID)) as object), closedAt: undefined } as never, pullRequest: { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7" }, item: read, requested: ["1001"],
    });
    expect(result.sent).toBe("none");
    expect(heard).toEqual([]);
    expect(itemOf(w).nudges.count).toBe(0);
    w.setTask({ closedAt: undefined, releasedAt: iso(tue - 1000) });
    expect((await runReviewNudges({ documentClient: w.db, tableName: TABLE, now: () => tue }, {
      task: { ...(w.db.get(taskKey(TASK_ID)) as object), releasedAt: undefined } as never, pullRequest: { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7" }, item: read, requested: ["1001"],
    })).sent).toBe("none");
  });

  it("keeps each pull request of a task on its own schedule, and the owner's note clear of Task 15's numbers", async () => {
    const heard = hear();
    const w = world({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "ledger", number: 3 }] });
    w.setNow(MON);
    w.setTask({ title: "Bump the SDK", developerId: OWNER, developerName: "Olivia", provider: "oidc" });
    memberOf(w, OWNER);
    memberOf(w, ALICE);
    await link(w, ALICE, "1001");
    const both = () => { for (const number of [7, 3]) w.github.statuses.set(number, status({ number, checks: passing, draft: false, requestedReviewers: 1, requestedReviewerIds: ["1001"] })); };
    both();
    await trackPullRequest(w.deps, TASK_ID);
    // A `stuck` milestone Task 15 wrote for workflow revision 9 does not stand in the way of the owner's note.
    w.db.set({ ...codeMilestoneKey(TASK_ID, "stuck", 9), entityType: "CODE_MILESTONE", n: 9, kind: "stuck", orgId: TEST_ORG, taskId: TASK_ID, at: iso(MON), text: "CI still fails", deliveredAt: iso(MON) });
    for (const at of [MON + DAY, MON + 3 * DAY, Date.parse("2026-11-02T09:00:00.000Z"), Date.parse("2026-11-04T09:00:00.000Z")]) { w.setNow(at); both(); await trackPullRequest(w.deps, TASK_ID); }
    expect(heard.filter((entry) => entry.kind === "review_nudge")).toHaveLength(6);
    expect(heard.filter((entry) => entry.kind === "stuck")).toHaveLength(2);
    expect(milestonesOf(w, "review_nudge")).toHaveLength(6);
    expect(milestonesOf(w, "stuck")).toHaveLength(3);
    expect(w.db.get(mergeTrackingKey(TASK_ID, "ledger", 3))).toMatchObject({ nudges: { count: 3 } });
  });

  it("puts no word of the task, its title included, in the text that goes to Slack: a reviewer may not be allowed to view the session", async () => {
    const heard = hear();
    const w = await waiting();
    w.setTask({ title: "Rotate the SECRET-PROJECT keys" });
    for (const at of [MON + DAY, MON + 3 * DAY, Date.parse("2026-11-02T09:00:00.000Z")]) await pass(w, at);
    const nudges = heard.filter((entry) => entry.kind === "review_nudge");
    expect(nudges.map((entry) => entry.text)).toEqual([
      "payments #7 has been waiting for your review for 1 day", "payments #7 has been waiting for your review for 3 days", "payments #7 has been waiting for your review for 7 days",
    ]);
    expect(JSON.stringify(milestonesOf(w, "review_nudge"))).not.toMatch(/SECRET-PROJECT|Rotate/u);
  });

  it("starts the 24 hours again when a decision is withdrawn and the review is asked for again, keeping the three", async () => {
    const heard = hear();
    const w = await waiting();
    w.github.permissions.set("bob", "write");
    const review = (state: "CHANGES_REQUESTED" | "APPROVED" | "DISMISSED") => [{ githubUserId: "2002", login: "bob", userType: "User", state, commitId: HEAD_A, submittedAt: iso(MON + 2 * H) }];
    await pass(w, MON + DAY);
    expect(heard).toHaveLength(1);
    requestedBy(w, ["1001"], { reviews: review("CHANGES_REQUESTED") });
    await pass(w, MON + 2 * DAY);
    expect(itemOf(w).review).toBe("changes_requested");
    // Thursday 09:00 would have been the second reminder; the review was withdrawn and asked for again, so the day starts over.
    requestedBy(w, ["1001"], { reviews: review("DISMISSED") });
    await pass(w, MON + 3 * DAY);
    expect(itemOf(w)).toMatchObject({ review: "requested", reviewersRequestedAt: iso(MON + 3 * DAY), nudges: { count: 1 } });
    expect(heard).toHaveLength(1);
    await pass(w, MON + 4 * DAY - 1);
    expect(heard).toHaveLength(1);
    await pass(w, MON + 4 * DAY);
    expect(heard).toHaveLength(2);
    expect(heard[1]!.text).toBe("payments #7 has been waiting for your review for 1 day");
    expect(itemOf(w).nudges.count).toBe(2);
    // An approval that is withdrawn and asked for again starts over the same way.
    requestedBy(w, ["1001"], { reviews: review("APPROVED") });
    await pass(w, MON + 4 * DAY + H);
    expect(itemOf(w).review).toBe("approved");
    requestedBy(w, ["1001"], { reviews: review("DISMISSED") });
    await pass(w, MON + 4 * DAY + 2 * H);
    expect(itemOf(w).reviewersRequestedAt).toBe(iso(MON + 4 * DAY + 2 * H));
  });

  it("holds the reminders while a fix round is running, and sends the one that was due when the pull request waits again", async () => {
    const heard = hear();
    const w = await waiting();
    w.setWorkflow({ stage: "IMPLEMENT", state: "RUNNING" });
    await pass(w, MON + DAY);
    await pass(w, MON + DAY + 2 * H);
    expect(heard).toEqual([]);
    expect(itemOf(w).nudges.count).toBe(0);
    w.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    await pass(w, MON + DAY + 2 * H + 1);
    expect(heard).toEqual([]);
    w.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await pass(w, MON + DAY + 3 * H);
    expect(heard).toHaveLength(1);
    // The owner's note waits too.
    const late = await waiting();
    for (const at of [MON + DAY, MON + 3 * DAY, Date.parse("2026-11-02T09:00:00.000Z")]) await pass(late, at);
    late.setWorkflow({ stage: "IMPLEMENT", state: "RUNNING" });
    await pass(late, Date.parse("2026-11-04T09:00:00.000Z"));
    expect(heard.filter((entry) => entry.kind === "stuck")).toEqual([]);
    late.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await pass(late, Date.parse("2026-11-04T10:00:00.000Z"));
    expect(heard.filter((entry) => entry.kind === "stuck")).toHaveLength(1);
  });

  it("asks to be looked at again when the next reminder is due, so a quiet pull request is not missed", async () => {
    const w = await waiting();
    w.setNow(MON + H);
    const outcome = await trackTask(w.deps, TASK_ID);
    expect(outcome.recheckAt).toBe(MON + DAY);
    w.setNow(MON + DAY);
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(MON + DAY + H);
    expect((await trackTask(w.deps, TASK_ID)).recheckAt).toBe(MON + 3 * DAY);
  });

  it("keeps the record of who was reminded in the task's own partition and the reviewer's, with the org in the reviewer's key", async () => {
    const w = await waiting();
    await pass(w, MON + DAY);
    expect(w.db.get(reviewNudgeLedgerKey(TASK_ID, "payments", 7))).toMatchObject({ orgId: TEST_ORG, taskId: TASK_ID, recipients: [{ developerId: ALICE, githubUserId: "1001" }] });
    const waits = await reviewWaitsOf({ documentClient: w.db, tableName: TABLE }, TEST_ORG, ALICE);
    expect(waits).toEqual([{ taskId: TASK_ID, repositoryId: "payments", number: 7, githubUserId: "1001", since: iso(MON), at: iso(MON + DAY), nudge: 1 }]);
    expect(reviewWaitKey(TEST_ORG, ALICE, TASK_ID, "payments", 7).pk).toContain(TEST_ORG);
    expect(await reviewWaitsOf({ documentClient: w.db, tableName: TABLE }, "org_zzzzzzzzzzzzzzzzzzzz", ALICE)).toEqual([]);
    expect(() => reviewWaitKey(TEST_ORG, "a#b", TASK_ID, "payments", 7)).toThrow();
    expect(() => reviewNudgeLedgerKey(TASK_ID, "pay#ments", 7)).toThrow();
    // The key of milestone numbers stays clear of Task 15's: the owner's note is high in the range.
    expect(milestonesOf(w, "review_nudge").map((stored) => stored["sk"])).toEqual([codeMilestoneKey(TASK_ID, "review_nudge", 0).sk]);
  });

  it("takes a reviewer's reminder away on the pass after they stop being asked, and when the review is decided", async () => {
    const w = await waiting({ ids: ["1001", "3003"] });
    memberOf(w, BOB);
    await link(w, BOB, "3003");
    await pass(w, MON + DAY);
    const reminded = async (who: string) => (await reviewWaitsOf({ documentClient: w.db, tableName: TABLE }, TEST_ORG, who)).length;
    expect([await reminded(ALICE), await reminded(BOB)]).toEqual([1, 1]);
    // Bob reviewed (comment only): GitHub no longer lists him, and his reminder goes.
    requestedBy(w, ["1001"]);
    await pass(w, MON + DAY + H);
    expect([await reminded(ALICE), await reminded(BOB)]).toEqual([1, 0]);
    // Approved: Alice's goes too.
    w.github.permissions.set("carol", "write");
    requestedBy(w, ["1001"], { reviews: [{ githubUserId: "9", login: "carol", userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: iso(MON + 2 * DAY) }] });
    await pass(w, MON + 2 * DAY);
    expect(await reminded(ALICE)).toBe(0);
  });
});

// ---- Home

const PR_URL = "https://github.com/acme/web/pull/7";

function homeWorld() {
  const w = sessionWorld();
  const seeded = w.seedSession({ owner: PRIYA });
  const createdAt = "2026-10-22T08:00:00.000Z";
  const task = w.db.get(taskKey(seeded.taskId))!;
  w.db.set({
    ...task, title: "Bump the Stripe SDK",
    workflow: {
      revision: 3, stage: "WAIT_FOR_MERGE", state: "WAITING", path: "QUICK", definitionVersion: "1.1.0", artifacts: [], decisions: [],
      pullRequests: [{ repositoryId: "r1", number: 7, url: PR_URL, candidateDigest: "c".repeat(64), required: true, state: "OPEN" }],
    },
  });
  const meta = w.db.get(agentSessionKey(ORG_A, seeded.sessionId, "META")) as Record<string, unknown> & { summary: Record<string, unknown> };
  w.db.set({ ...meta, summary: { ...meta["summary"], status: "waiting" } });
  w.db.set({ ...mySessionsKey(ORG_A, PRIYA, createdAt, seeded.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: seeded.sessionId, developerId: PRIYA, createdAt });
  const asked = Date.parse("2026-10-26T09:00:00.000Z");
  const tracked = (overrides: Partial<MergeTrackingItem> = {}): MergeTrackingItem => ({
    ...item({ orgId: ORG_A, taskId: seeded.taskId, repositoryId: "r1", readyAt: iso(asked), reviewersRequestedAt: iso(asked) }), ...overrides,
  });
  const put = (value: MergeTrackingItem) => w.db.set({ ...mergeTrackingKey(seeded.taskId, "r1", 7), entityType: "MERGE_TRACKING", ...value });
  put(tracked());
  const deps = () => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never, log: () => undefined,
  }) as unknown as HomeDependencies;
  const nudge = async (value: MergeTrackingItem, requested: string[], at: number) => {
    w.clock.now = at;
    return runReviewNudges({ documentClient: w.db, tableName: "state", now: () => at }, {
      task: w.db.get(taskKey(seeded.taskId)) as never, pullRequest: { repositoryId: "r1", number: 7, url: PR_URL }, item: value, requested,
    });
  };
  const home = (who: string, orgId = ORG_A) => homeCards(deps(), w.caller(who, orgId));
  const link = (who: string, githubUserId: string, orgId = ORG_A) => linkGithubMember({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, orgId, who, githubUserId);
  return { ...w, seeded, asked, tracked, put, nudge, home, link, deps };
}

describe("Home", () => {
  it("shows a reminded reviewer the pull request waiting for them, with the session when they may view it", async () => {
    const h = homeWorld();
    await h.link(MAX, "1001");
    expect(await h.nudge(h.tracked(), ["1001"], h.asked + DAY)).toEqual({ sent: "nudge", recheckAt: h.asked + 3 * DAY });
    const { cards } = await h.home(MAX);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "pull_request", title: "Bump the Stripe SDK", reason: "\"Bump the Stripe SDK\" has been waiting for your review for 1 day", sessionId: h.seeded.sessionId, at: iso(h.asked + DAY),
    });
    expect(cards[0]!.cardId).toMatch(/^pull_request:[A-Za-z0-9_-]+$/u);
    expect(cards[0]!.buttons).toEqual([
      { label: "Open pull request", action: "open", href: PR_URL, method: "GET" },
      { label: "Open session", action: "open", href: `${CELL}/app/sessions/${h.seeded.sessionId}`, method: "GET" },
    ]);
  });

  it("counts the days the review has waited", async () => {
    const h = homeWorld();
    await h.link(MAX, "1001");
    await h.nudge(h.tracked(), ["1001"], h.asked + DAY);
    h.clock.now = h.asked + 3 * DAY + 5 * H;
    expect((await h.home(MAX)).cards[0]!.reason).toBe("\"Bump the Stripe SDK\" has been waiting for your review for 3 days");
  });

  it("does not show the session's words or a link to it to a reviewer who may not view the session", async () => {
    const h = homeWorld();
    await h.link(ZED, "1002");
    await h.nudge(h.tracked(), ["1002"], h.asked + DAY);
    const { cards } = await h.home(ZED);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: "\"r1 #7\" has been waiting for your review for 1 day", title: "r1 #7" });
    expect(cards[0]).not.toHaveProperty("sessionId");
    expect(cards[0]!.buttons).toEqual([{ label: "Open pull request", action: "open", href: PR_URL, method: "GET" }]);
    expect(JSON.stringify(cards)).not.toContain("Bump the Stripe SDK");
    expect(JSON.stringify(cards)).not.toContain(h.seeded.sessionId);
  });

  it("shows nothing to a person who was not reminded, or who has since unlinked their GitHub account", async () => {
    const h = homeWorld();
    await h.link(MAX, "1001");
    await h.nudge(h.tracked(), ["1001"], h.asked + DAY);
    expect((await h.home(PRIYA)).cards.map((card) => card.reason)).not.toContain("\"Bump the Stripe SDK\" has been waiting for your review for 1 day");
    expect((await h.home(MAX)).cards).toHaveLength(1);
    await unlinkGithubMember({ documentClient: h.db, tableName: "state", now: () => h.clock.now }, ORG_A, MAX);
    expect((await h.home(MAX)).cards).toEqual([]);
    // Linked again to another account: the old reminder is not theirs.
    await h.link(MAX, "9999");
    expect((await h.home(MAX)).cards).toEqual([]);
  });

  it("goes away when the pull request is approved, is a draft again, is closed, or the task ends, whatever the last pass has written", async () => {
    for (const stop of [
      (h: ReturnType<typeof homeWorld>) => h.put(h.tracked({ review: "approved" })),
      (h: ReturnType<typeof homeWorld>) => h.put(h.tracked({ review: "changes_requested" })),
      (h: ReturnType<typeof homeWorld>) => h.put(h.tracked({ draft: true })),
      (h: ReturnType<typeof homeWorld>) => h.put(h.tracked({ state: "merged" })),
      (h: ReturnType<typeof homeWorld>) => h.put(h.tracked({ orgId: ORG_B })),
      (h: ReturnType<typeof homeWorld>) => h.db.set({ ...h.db.get(taskKey(h.seeded.taskId))!, closedAt: "2026-10-27T00:00:00.000Z" }),
      (h: ReturnType<typeof homeWorld>) => h.db.set({ ...h.db.get(taskKey(h.seeded.taskId))!, releasedAt: "2026-10-27T00:00:00.000Z" }),
      (h: ReturnType<typeof homeWorld>) => { const task = h.db.get(taskKey(h.seeded.taskId))! as { workflow: Record<string, unknown> }; h.db.set({ ...task, workflow: { ...task.workflow, pullRequests: [{ ...(task.workflow["pullRequests"] as object[])[0], state: "MERGED" }] } }); },
    ]) {
      const h = homeWorld();
      await h.link(MAX, "1001");
      await h.nudge(h.tracked(), ["1001"], h.asked + DAY);
      expect((await h.home(MAX)).cards).toHaveLength(1);
      stop(h);
      expect((await h.home(MAX)).cards).toEqual([]);
    }
  });

  it("is per org: another org's member linked to the same GitHub account sees nothing, and a row written for another org is not read", async () => {
    const h = homeWorld();
    await h.link(MAX, "1001");
    await h.link(BO, "1001", ORG_B);
    await h.nudge(h.tracked(), ["1001"], h.asked + DAY);
    expect((await h.home(BO, ORG_B)).cards).toEqual([]);
    const [row] = h.db.find((stored) => stored["entityType"] === "REVIEW_WAIT");
    h.db.set({ ...row!, orgId: ORG_B });
    expect((await h.home(MAX)).cards).toEqual([]);
  });

  it("tells the task's owner their pull request is waiting for review once it has been asked of someone", async () => {
    const h = homeWorld();
    const owner = async () => (await h.home(PRIYA)).cards.find((card) => card.cardId === `pull_request:${h.seeded.sessionId}`)?.reason;
    // Without a tracking item (or with nobody asked) it reads as it always did.
    h.db.delete(mergeTrackingKey(h.seeded.taskId, "r1", 7));
    expect(await owner()).toBe("Your pull request for \"Bump the Stripe SDK\" is ready for review");
    h.put(h.tracked({ review: "not_requested" }));
    expect(await owner()).toBe("Your pull request for \"Bump the Stripe SDK\" is ready for review");
    h.put(h.tracked({ review: "requested" }));
    expect(await owner()).toBe("Your pull request for \"Bump the Stripe SDK\" is waiting for review");
    // A version 1 task has no say here, whatever an item says.
    const task = h.db.get(taskKey(h.seeded.taskId))! as { workflow: Record<string, unknown> };
    h.db.set({ ...task, workflow: { ...task.workflow, definitionVersion: "1.0.0" } });
    expect(await owner()).toBe("Your pull request for \"Bump the Stripe SDK\" is ready for review");
    h.db.set(task);
    // A draft is not waiting for anyone yet.
    h.put(h.tracked({ review: "requested", draft: true }));
    expect(await owner()).toBe("Your pull request for \"Bump the Stripe SDK\" is ready for review");
  });
});

describe("who GitHub lists as asked", () => {
  it("keeps the people by their GitHub id, in order, and leaves out teams, bots, repeats and entries that do not read", () => {
    expect(requestedReviewerIds({
      requested_reviewers: [{ id: 11, type: "User" }, { id: 12 }, { id: 11, type: "User" }, { id: 13, type: "Bot" }, { id: "14", type: "User" }, { id: 0, type: "User" }, { id: 1.5 }, null, "x", { type: "User" }],
      requested_teams: [{ id: 99 }],
    })).toEqual(["11", "12"]);
    expect(requestedReviewerIds({})).toEqual([]);
    expect(requestedReviewerIds({ requested_reviewers: "all" })).toEqual([]);
    const many = Array.from({ length: REQUESTED_REVIEWER_IDS_MAX + 10 }, (_unused, index) => ({ id: index + 1, type: "User" }));
    expect(requestedReviewerIds({ requested_reviewers: many })).toHaveLength(REQUESTED_REVIEWER_IDS_MAX);
  });
});
