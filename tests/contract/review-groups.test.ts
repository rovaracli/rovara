// Review groups (owner decision 9, A-22, DN-5, S-23): a project's groups of reviewers, and claim / release / reassign of a task's waiting review. Per role (maintainer, group member,
// a project member outside the group, viewer, a company member with no project role, the Auditor), with live roles, company scoping, the code host asked for the right reviewer,
// idempotency, stale fences, audit, and the rule that a claim never grants approval. The routes' dispatcher rules (browser only) are in review-groups-routes.test.ts.
import { describe, expect, it } from "vitest";
import { agentXError, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import {
  REVIEW_AGE_NUDGE_HOURS, REVIEW_GROUP_MESSAGES as W, TaskReviewViewSchema, ReviewGroupsViewSchema, reviewClaimKey, reviewGroupsKey,
  type MergeTrackingItem, type OrgRole, type ReviewGroupsView, type TaskReviewView,
} from "@agentx/cloud-contracts";
import { getReviewGroups, putReviewGroups, type ReviewCaller } from "../../packages/broker/src/review-groups/groups.js";
import { claimReview, getTaskReview, reassignReview, releaseReview, reviewKeyOf, type ReviewClaimDeps, type ReviewTask } from "../../packages/broker/src/review-groups/claims.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-11-11T12:00:00.000Z");
const HOUR = 3_600_000;
const id = (c: string) => c.repeat(64);
const MAINT = id("a"), ALICE = id("b"), BOB = id("c"), CARL = id("d"), VERA = id("e"), MEMO = id("f"), AUDI = id("1"), OWEN = id("2"), OLGA = id("3");
const NAMES: Record<string, string> = { [MAINT]: "Maya", [ALICE]: "Alice", [BOB]: "Bob", [CARL]: "Carl", [VERA]: "Vera", [MEMO]: "Memo", [AUDI]: "Audrey", [OWEN]: "Owen", [OLGA]: "Olga" };
let counter = 0;
const rid = () => `22222222-2222-4222-8222-${String(++counter).padStart(12, "0")}`;

interface World {
  db: FakeDynamoDb;
  audit: ReturnType<typeof capturingAuditDeps>;
  clock: { now: number };
  orgRoles: Map<string, OrgRole>;
  projectRoles: Map<string, ProjectRole>;
  logins: Map<string, string>;
  tracking: MergeTrackingItem[];
  task: ReviewTask;
  owners: string[];
  selfApproval: boolean;
  hostAnswer: "requested" | "refused" | "unavailable" | "throw";
  asked: Array<{ repositoryId: string; number: number; login: string }>;
  deps: ReviewClaimDeps;
  caller(who: string, orgId?: OrgId): ReviewCaller;
}

function trackingItem(repositoryId: string, number: number, over: Partial<MergeTrackingItem> = {}): MergeTrackingItem {
  return {
    orgId: ORG, taskId: TASK, repositoryId, number, version: 1, headSha: "1".repeat(40), draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true,
    failingChecks: [], review: "requested", branch: "up_to_date", headByRovara: true, readyAt: new Date(START - 2 * HOUR).toISOString(), nudges: { count: 0 }, syncs: { day: "2026-11-11", count: 0 },
    decisionDigest: "d".repeat(64), observedAt: new Date(START).toISOString(), ...over,
  };
}

function world(): World {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  const audit = capturingAuditDeps({ db, now: () => clock.now });
  const w = {
    db, audit, clock,
    orgRoles: new Map<string, OrgRole>([[MAINT, "member"], [ALICE, "member"], [BOB, "member"], [CARL, "member"], [VERA, "member"], [MEMO, "member"], [AUDI, "auditor"], [OWEN, "member"], [OLGA, "admin"]]),
    projectRoles: new Map<string, ProjectRole>([[MAINT, "maintainer"], [ALICE, "contributor"], [BOB, "contributor"], [CARL, "contributor"], [VERA, "viewer"], [OWEN, "contributor"], [OLGA, "maintainer"]]),
    logins: new Map<string, string>([[ALICE, "alice-gh"], [BOB, "bob-gh"], [CARL, "carl-gh"], [MAINT, "maya-gh"], [OWEN, "owen-gh"]]),
    tracking: [trackingItem("repo_web", 7)],
    task: { taskId: TASK, orgId: ORG, project: "web", startingRevision: 3, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } },
    owners: [OWEN],
    selfApproval: false,
    hostAnswer: "requested",
    asked: [] as World["asked"],
  } as World;
  // A person's live role: their company role first (the Auditor and a non-member have none), then their project role.
  const live = (orgId: OrgId, project: string, who: string): ProjectRole | undefined => {
    const orgRole = w.orgRoles.get(who);
    if (orgId !== ORG || project !== "web" || orgRole === undefined || orgRole === "auditor") return undefined;
    return w.projectRoles.get(who);
  };
  w.deps = {
    documentClient: db, tableName: "state", now: () => clock.now, audit: audit.audit,
    projectFor: async (caller, raw) => {
      const role = live(caller.orgId, raw, caller.developerId);
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: raw, role };
    },
    liveProjectRole: async (orgId, project, who) => live(orgId, project, who),
    nameOf: async (_orgId, who) => NAMES[who] ?? "A former member",
    taskFor: async (caller, taskId) => {
      if (taskId !== TASK || caller.orgId !== ORG || live(caller.orgId, w.task.project, caller.developerId) === undefined) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      return { task: w.task, ownerIds: w.owners };
    },
    readTracking: async (taskId, orgId) => w.tracking.filter((item) => item.taskId === taskId && item.orgId === orgId),
    allowSelfApproval: async () => w.selfApproval,
    githubLoginOf: async (_orgId, who) => w.logins.get(who),
    requestReviewer: async (_task, pr, login) => {
      if (w.hostAnswer === "throw") throw new Error("host down");
      w.asked.push({ repositoryId: pr.repositoryId, number: pr.number, login });
      return w.hostAnswer;
    },
  };
  w.caller = (who, orgId = ORG) => ({ developerId: who, orgId, orgRole: w.orgRoles.get(who) ?? "member" });
  return w;
}

const err = (promise: Promise<unknown>) => promise.then(() => ({ code: "NONE", message: "" }), (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const groupsBody = (expectedRevision: number, groups: Array<{ groupId?: string; name: string; members: string[] }>) => ({ requestId: rid(), expectedRevision, groups });

/** A world with one group, "Payments reviewers": Alice and Bob. */
async function withGroup(): Promise<{ w: World; groupId: string; view: ReviewGroupsView }> {
  const w = world();
  const view = await putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(0, [{ name: "Payments reviewers", members: [ALICE, BOB] }]));
  return { w, groupId: view.groups[0]!.groupId, view };
}
const reviewOf = (w: World, who: string): Promise<TaskReviewView> => getTaskReview(w.deps, w.caller(who), TASK);
async function claimAs(w: World, who: string, groupId: string, over: Record<string, unknown> = {}) {
  const view = await reviewOf(w, who);
  return claimReview(w.deps, w.caller(who), TASK, { requestId: rid(), expectedRevision: view.revision, reviewKey: view.reviewKey ?? "0".repeat(64), groupId, ...over });
}
async function releaseAs(w: World, who: string, over: Record<string, unknown> = {}) {
  const view = await reviewOf(w, who);
  return releaseReview(w.deps, w.caller(who), TASK, { requestId: rid(), expectedRevision: view.revision, ...over });
}
async function reassignAs(w: World, who: string, groupId: string, to: string, over: Record<string, unknown> = {}) {
  const view = await reviewOf(w, who);
  return reassignReview(w.deps, w.caller(who), TASK, { requestId: rid(), expectedRevision: view.revision, reviewKey: view.reviewKey ?? "0".repeat(64), groupId, to, ...over });
}

describe("review groups: who may read and change them", () => {
  it("a maintainer saves a group of contributors; the view lists names and live standing, and anyone who can see the project reads it", async () => {
    const { w, view } = await withGroup();
    expect(ReviewGroupsViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({ revision: 1, canManage: true, groups: [{ name: "Payments reviewers", members: [{ developerId: ALICE, name: "Alice", eligible: true }, { developerId: BOB, name: "Bob", eligible: true }] }] });
    expect(view.groups[0]!.groupId).toMatch(/^rgp_[a-f0-9]{16}$/u);
    for (const who of [ALICE, CARL, VERA]) expect(await getReviewGroups(w.deps, w.caller(who), "web")).toMatchObject({ revision: 1, canManage: false });
    expect(await getReviewGroups(w.deps, w.caller(OLGA), "web")).toMatchObject({ canManage: true });
    for (const who of [MEMO, AUDI]) expect(await err(getReviewGroups(w.deps, w.caller(who), "web"))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("refuses a group member, a project member outside it, a viewer, a company member with no project role and the Auditor; lets an org admin", async () => {
    const { w } = await withGroup();
    for (const who of [ALICE, CARL, VERA]) expect(await err(putReviewGroups(w.deps, w.caller(who), "web", groupsBody(1, [])))).toEqual({ code: "FORBIDDEN", message: W.maintainersOnly });
    for (const who of [MEMO, AUDI]) expect(await err(putReviewGroups(w.deps, w.caller(who), "web", groupsBody(1, [])))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect((await putReviewGroups(w.deps, w.caller(OLGA), "web", groupsBody(1, []))).revision).toBe(2);
  });

  it("every person added must be a live contributor or maintainer: a viewer, a company member with no project role, the Auditor and an outsider are refused, by position only", async () => {
    const w = world();
    for (const who of [VERA, MEMO, AUDI, id("9")]) {
      const answer = await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(0, [{ name: "Core", members: [ALICE, who] }])));
      expect(answer).toEqual({ code: "CONFIG_INVALID", message: "groups.0.members.1: that person isn't a contributor or maintainer of this project" });
      expect(answer.message).not.toContain(who);
    }
    expect(w.db.get(reviewGroupsKey(ORG, "web"))).toBeUndefined();
  });

  it("someone already in a group who lost their standing reads as not eligible, and is dropped on the next save", async () => {
    const { w, groupId } = await withGroup();
    w.projectRoles.set(BOB, "viewer");
    expect((await getReviewGroups(w.deps, w.caller(MAINT), "web")).groups[0]!.members.find((m) => m.developerId === BOB)).toMatchObject({ eligible: false });
    const saved = await putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(1, [{ groupId, name: "Payments reviewers", members: [ALICE, BOB] }]));
    expect(saved.groups[0]!.members.map((m) => m.developerId)).toEqual([ALICE]);
  });

  it("is revision-fenced, idempotent, refuses a reused request id with another body, and checks names and duplicates", async () => {
    const { w, groupId } = await withGroup();
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(0, [])))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    const body = groupsBody(1, [{ groupId, name: "Payments reviewers", members: [ALICE] }]);
    const first = await putReviewGroups(w.deps, w.caller(MAINT), "web", body);
    const again = await putReviewGroups(w.deps, w.caller(MAINT), "web", body);
    expect(again).toEqual(first);
    expect(first.revision).toBe(2);
    expect(w.audit.recordedBy("review_groups.changed")).toHaveLength(2);
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", { ...body, groups: [] }))).toEqual({ code: "CONFIG_INVALID", message: W.requestReused });
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(2, [{ name: "A", members: [] }, { name: "a", members: [] }])))).toMatchObject({ code: "CONFIG_INVALID", message: "groups.1.name: another group has this name" });
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(2, [{ name: "A", members: [ALICE, ALICE] }])))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(2, [{ groupId: "rgp_0000000000000000", name: "A", members: [] }])))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(2, [{ name: "bad\u0007", members: [] }])))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a lost race at the write is CHANGE_STALE and leaves the winner's document", async () => {
    const { w, groupId } = await withGroup();
    const send = w.db.send;
    let raced = false;
    w.deps = { ...w.deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (!raced && command.constructor.name === "TransactWriteCommand") { raced = true; w.db.set({ ...w.db.get(reviewGroupsKey(ORG, "web"))!, revision: 2 }); }
      return send(command as never);
    } } };
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(1, [{ groupId, name: "Renamed", members: [ALICE] }])))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(w.db.get(reviewGroupsKey(ORG, "web"))).toMatchObject({ revision: 2, groups: [{ name: "Payments reviewers" }] });
  });

  it("audits a change in the same transaction, with counts only", async () => {
    const { w } = await withGroup();
    const [event] = w.audit.recordedBy("review_groups.changed");
    expect(event).toMatchObject({ target: { kind: "project", name: "web" }, facts: { revision: 1, groups: 1, members: 2, added: 2, removed: 0 } });
    expect(JSON.stringify(event)).not.toContain(ALICE);
    const tx = w.db.transactions().at(-1)!;
    expect(tx.some((entry) => JSON.stringify(entry).includes("AUDIT_PENDING#"))).toBe(true);
  });

  it("is company-scoped: another company's project of the same name has its own document, and its people can't be named", async () => {
    const { w } = await withGroup();
    expect(await err(getReviewGroups(w.deps, w.caller(MAINT, OTHER_ORG), "web"))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(w.db.get(reviewGroupsKey(OTHER_ORG, "web"))).toBeUndefined();
    expect(reviewGroupsKey(ORG, "web").pk).not.toBe(reviewGroupsKey(OTHER_ORG, "web").pk);
  });

  it("an unreadable stored document fails closed: reads and writes refuse, nothing is overwritten", async () => {
    const { w } = await withGroup();
    w.db.set({ ...w.db.get(reviewGroupsKey(ORG, "web"))!, groups: "garbage" });
    expect(await err(getReviewGroups(w.deps, w.caller(MAINT), "web"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await err(putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(1, [])))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await err(reviewOf(w, ALICE))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("a task's review: claim, release, reassign", () => {
  it("reads the waiting review, its key, its age and what each role may do", async () => {
    const { w, groupId } = await withGroup();
    const alice = await reviewOf(w, ALICE);
    expect(TaskReviewViewSchema.parse(alice)).toEqual(alice);
    expect(alice).toMatchObject({ waiting: true, revision: 0, aged: false, ageHours: 2, canClaim: true, canRelease: false, canReassign: false, claimableGroups: [{ groupId, name: "Payments reviewers" }] });
    expect(alice.reviewKey).toBe(reviewKeyOf(w.tracking));
    expect(alice.approvalNote).toContain("doesn't let anyone approve");
    expect(await reviewOf(w, CARL)).toMatchObject({ canClaim: false, claimableGroups: [], canReassign: false });
    expect(await reviewOf(w, VERA)).toMatchObject({ canClaim: false, canReassign: false });
    expect(await reviewOf(w, MAINT)).toMatchObject({ canClaim: false, canReassign: true });
    for (const who of [MEMO, AUDI]) expect(await err(reviewOf(w, who))).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("the age nudge: a review waiting at least REVIEW_AGE_NUDGE_HOURS is flagged, claimed or not", async () => {
    const { w, groupId } = await withGroup();
    w.clock.now = START + (REVIEW_AGE_NUDGE_HOURS - 2) * HOUR - 1;
    expect((await reviewOf(w, ALICE)).aged).toBe(false);
    w.clock.now = START + (REVIEW_AGE_NUDGE_HOURS - 2) * HOUR;
    expect(await reviewOf(w, ALICE)).toMatchObject({ aged: true, ageHours: REVIEW_AGE_NUDGE_HOURS });
    await claimAs(w, ALICE, groupId);
    expect(await reviewOf(w, MAINT)).toMatchObject({ aged: true, claim: { developerId: ALICE } });
    // `reviewersRequestedAt` wins over `readyAt`.
    w.tracking = [trackingItem("repo_web", 7, { reviewersRequestedAt: new Date(w.clock.now - HOUR).toISOString() })];
    expect(await reviewOf(w, MAINT)).toMatchObject({ aged: false, ageHours: 1 });
  });

  it("a group member claims: the claim is stored, audited, and the code host is asked for exactly that member's login on every waiting pull request", async () => {
    const { w, groupId } = await withGroup();
    w.tracking = [trackingItem("repo_web", 7), trackingItem("repo_api", 3, { headSha: "2".repeat(40) }), trackingItem("repo_docs", 9, { draft: true }), trackingItem("repo_ui", 4, { review: "approved" })];
    const view = await claimAs(w, ALICE, groupId);
    expect(view).toMatchObject({ revision: 1, claim: { developerId: ALICE, name: "Alice", groupId, groupName: "Payments reviewers", hostSync: "requested" }, canRelease: true, canClaim: false });
    expect(w.asked).toEqual([{ repositoryId: "repo_api", number: 3, login: "alice-gh" }, { repositoryId: "repo_web", number: 7, login: "alice-gh" }]);
    const [event] = w.audit.recordedBy("review.claim_changed");
    expect(event).toMatchObject({ target: { kind: "task", id: TASK }, facts: { change: "claimed", revision: 1, groupId, pullRequests: 2, hostSync: "pending" } });
    expect(JSON.stringify(event!.facts)).not.toContain(ALICE);
    expect(event!.actor).toEqual({ kind: "member", id: ALICE });
    expect(event!.details).toContainEqual({ subject: "org", fields: { holder: ALICE } });
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toMatchObject({ holder: ALICE, groupId, revision: 1, hostSync: "requested" });
  });

  it("refuses a project member outside the group, a viewer, a company member with no project role and the Auditor", async () => {
    const { w, groupId } = await withGroup();
    expect(await err(claimAs(w, CARL, groupId))).toEqual({ code: "FORBIDDEN", message: W.notInGroup });
    expect(await err(claimAs(w, VERA, groupId))).toEqual({ code: "FORBIDDEN", message: W.notInGroup });
    for (const who of [MEMO, AUDI]) expect(await err(claimReview(w.deps, w.caller(who), TASK, { requestId: rid(), expectedRevision: 0, reviewKey: reviewKeyOf(w.tracking), groupId }))).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(w.asked).toEqual([]);
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toBeUndefined();
  });

  it("a group member who was demoted to viewer can no longer claim, though the stored group still lists them", async () => {
    const { w, groupId } = await withGroup();
    w.projectRoles.set(BOB, "viewer");
    expect(await err(claimAs(w, BOB, groupId))).toEqual({ code: "FORBIDDEN", message: W.notInGroup });
  });

  it("refuses when nothing waits for review, and a group of another project", async () => {
    const { w, groupId } = await withGroup();
    w.tracking = [trackingItem("repo_web", 7, { review: "changes_requested" })];
    expect(await err(claimAs(w, ALICE, groupId))).toEqual({ code: "CONFIG_INVALID", message: W.notWaiting });
    w.tracking = [trackingItem("repo_web", 7)];
    w.task = { ...w.task, workflow: { stage: "VERIFY", state: "RUNNING" } };
    expect(await err(claimAs(w, ALICE, groupId))).toEqual({ code: "CONFIG_INVALID", message: W.notWaiting });
    w.task = { ...w.task, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } };
    expect(await err(claimAs(w, ALICE, "rgp_0000000000000000"))).toEqual({ code: "CONFIG_INVALID", message: W.noGroup });
  });

  it("stale claims are fenced: a moved head (the review's key) and a moved revision are CHANGE_STALE", async () => {
    const { w, groupId } = await withGroup();
    const before = await reviewOf(w, ALICE);
    w.tracking = [trackingItem("repo_web", 7, { headSha: "9".repeat(40) })];
    expect(await err(claimReview(w.deps, w.caller(ALICE), TASK, { requestId: rid(), expectedRevision: 0, reviewKey: before.reviewKey, groupId }))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    await claimAs(w, ALICE, groupId);
    await releaseAs(w, ALICE);
    const fresh = await reviewOf(w, BOB);
    expect(await err(claimReview(w.deps, w.caller(BOB), TASK, { requestId: rid(), expectedRevision: 1, reviewKey: fresh.reviewKey, groupId }))).toEqual({ code: "CHANGE_STALE", message: W.stale });
  });

  it("a lost race at the claim's write is CHANGE_STALE and asks the code host nothing", async () => {
    const { w, groupId } = await withGroup();
    const view = await reviewOf(w, ALICE);
    const send = w.db.send;
    let raced = false;
    w.deps = { ...w.deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (!raced && command.constructor.name === "TransactWriteCommand") {
        raced = true;
        w.db.set({ ...reviewClaimKey(ORG, TASK), entityType: "REVIEW_CLAIM", orgId: ORG, taskId: TASK, project: "web", revision: 1, holder: BOB, groupId, claimedAt: new Date(START).toISOString(), hostSync: "requested" });
      }
      return send(command as never);
    } } };
    expect(await err(claimReview(w.deps, w.caller(ALICE), TASK, { requestId: rid(), expectedRevision: view.revision, reviewKey: view.reviewKey, groupId }))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toMatchObject({ holder: BOB });
    expect(w.asked).toEqual([]);
  });

  it("a lost race over an existing claim (released, then claimed by someone else under you) is CHANGE_STALE", async () => {
    const { w, groupId } = await withGroup();
    await claimAs(w, ALICE, groupId);
    await releaseAs(w, ALICE);
    const view = await reviewOf(w, BOB);
    expect(view.revision).toBe(2);
    const send = w.db.send;
    let raced = false;
    w.deps = { ...w.deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (!raced && command.constructor.name === "TransactWriteCommand") { raced = true; w.db.set({ ...w.db.get(reviewClaimKey(ORG, TASK))!, revision: 3, holder: ALICE, groupId, claimedAt: new Date(START).toISOString(), hostSync: "requested" }); }
      return send(command as never);
    } } };
    expect(await err(claimReview(w.deps, w.caller(BOB), TASK, { requestId: rid(), expectedRevision: 2, reviewKey: view.reviewKey, groupId }))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toMatchObject({ holder: ALICE, revision: 3 });
  });

  it("a second member can't take a held claim; the holder claiming again changes nothing", async () => {
    const { w, groupId } = await withGroup();
    await claimAs(w, ALICE, groupId);
    expect(await err(claimAs(w, BOB, groupId))).toEqual({ code: "CHANGE_STALE", message: W.alreadyClaimed });
    const again = await claimAs(w, ALICE, groupId);
    expect(again.revision).toBe(1);
    expect(w.audit.recordedBy("review.claim_changed")).toHaveLength(1);
  });

  it("is idempotent: a repeat of the same request answers the same and writes nothing; the same id with another body is refused", async () => {
    const { w, groupId } = await withGroup();
    const view = await reviewOf(w, ALICE);
    const body = { requestId: rid(), expectedRevision: 0, reviewKey: view.reviewKey, groupId };
    const first = await claimReview(w.deps, w.caller(ALICE), TASK, body);
    const again = await claimReview(w.deps, w.caller(ALICE), TASK, body);
    expect(again).toEqual(first);
    expect(w.audit.recordedBy("review.claim_changed")).toHaveLength(1);
    expect(w.asked).toHaveLength(1);
    expect(await err(claimReview(w.deps, w.caller(ALICE), TASK, { ...body, groupId: "rgp_0000000000000000" }))).toEqual({ code: "CONFIG_INVALID", message: W.requestReused });
  });

  it("a host request that did not go through stays `pending`/`unavailable`, and a repeat of the same request asks again", async () => {
    const { w, groupId } = await withGroup();
    w.hostAnswer = "throw";
    const view = await reviewOf(w, ALICE);
    const body = { requestId: rid(), expectedRevision: 0, reviewKey: view.reviewKey, groupId };
    expect((await claimReview(w.deps, w.caller(ALICE), TASK, body)).claim).toMatchObject({ hostSync: "unavailable" });
    w.hostAnswer = "requested";
    expect((await claimReview(w.deps, w.caller(ALICE), TASK, body)).claim).toMatchObject({ hostSync: "requested" });
    expect(w.asked).toEqual([{ repositoryId: "repo_web", number: 7, login: "alice-gh" }]);
    w.hostAnswer = "refused";
    await releaseAs(w, ALICE);
    expect((await claimAs(w, BOB, groupId)).claim).toMatchObject({ developerId: BOB, hostSync: "refused" });
  });

  it("a member with no linked GitHub account can't claim (the claim would make no one the requested reviewer)", async () => {
    const { w, groupId } = await withGroup();
    w.logins.delete(ALICE);
    expect(await err(claimAs(w, ALICE, groupId))).toEqual({ code: "CONFIG_INVALID", message: W.linkGithub });
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toBeUndefined();
  });

  it("the task's owner doesn't claim their own review unless the project allows self-approval", async () => {
    const w = world();
    const { groups } = await putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(0, [{ name: "Core", members: [OWEN, ALICE] }]));
    const groupId = groups[0]!.groupId;
    expect((await reviewOf(w, OWEN)).canClaim).toBe(false);
    expect(await err(claimAs(w, OWEN, groupId))).toEqual({ code: "FORBIDDEN", message: W.ownTask });
    expect(await err(reassignAs(w, MAINT, groupId, OWEN))).toEqual({ code: "CONFIG_INVALID", message: W.targetOwnTask });
    w.selfApproval = true;
    expect((await claimAs(w, OWEN, groupId)).claim).toMatchObject({ developerId: OWEN });
  });

  it("only the holder releases; the review goes back to the group and the release is audited", async () => {
    const { w, groupId } = await withGroup();
    expect(await err(releaseAs(w, ALICE))).toEqual({ code: "CONFIG_INVALID", message: W.nothingToRelease });
    await claimAs(w, ALICE, groupId);
    for (const who of [BOB, MAINT]) expect(await err(releaseAs(w, who))).toEqual({ code: "FORBIDDEN", message: W.notHolder });
    expect(await err(releaseAs(w, ALICE, { expectedRevision: 0 }))).toEqual({ code: "CHANGE_STALE", message: W.stale });
    const released = await releaseAs(w, ALICE);
    expect(released).toMatchObject({ revision: 2, canClaim: true });
    expect(released.claim).toBeUndefined();
    expect(w.audit.recordedBy("review.claim_changed").map((event) => event.facts?.["change"])).toEqual(["claimed", "released"]);
    expect((await claimAs(w, BOB, groupId)).claim).toMatchObject({ developerId: BOB });
  });

  it("a maintainer (or an org admin) reassigns to another eligible member of the group; the code host is asked for the new holder", async () => {
    const { w, groupId } = await withGroup();
    await claimAs(w, ALICE, groupId);
    w.asked = [];
    const view = await reassignAs(w, MAINT, groupId, BOB);
    expect(view).toMatchObject({ revision: 2, claim: { developerId: BOB, hostSync: "requested" } });
    expect(w.asked).toEqual([{ repositoryId: "repo_web", number: 7, login: "bob-gh" }]);
    expect(w.audit.recordedBy("review.claim_changed").at(-1)).toMatchObject({ facts: { change: "reassigned", revision: 2 }, details: [{ subject: "org", fields: { holder: BOB } }] });
    expect((await reassignAs(w, OLGA, groupId, ALICE)).claim).toMatchObject({ developerId: ALICE });
  });

  it("refuses reassign by a group member, a project member outside it and a viewer, and to someone outside the group, demoted, or with no GitHub account", async () => {
    const { w, groupId } = await withGroup();
    for (const who of [ALICE, CARL, VERA]) expect(await err(reassignAs(w, who, groupId, BOB))).toEqual({ code: "FORBIDDEN", message: W.reassignMaintainers });
    expect(await err(reassignAs(w, MAINT, groupId, CARL))).toEqual({ code: "CONFIG_INVALID", message: W.targetNotInGroup });
    w.projectRoles.set(BOB, "viewer");
    expect(await err(reassignAs(w, MAINT, groupId, BOB))).toEqual({ code: "CONFIG_INVALID", message: W.targetNotInGroup });
    w.projectRoles.set(BOB, "contributor");
    w.logins.delete(BOB);
    expect(await err(reassignAs(w, MAINT, groupId, BOB))).toEqual({ code: "CONFIG_INVALID", message: W.targetNoGithub });
    expect(w.db.get(reviewClaimKey(ORG, TASK))).toBeUndefined();
  });

  it("a removed person's claim returns to the group: taken out of the group, demoted, or gone from the company", async () => {
    for (const remove of ["group", "viewer", "company"] as const) {
      const { w, groupId } = await withGroup();
      await claimAs(w, ALICE, groupId);
      if (remove === "group") await putReviewGroups(w.deps, w.caller(MAINT), "web", groupsBody(1, [{ groupId, name: "Payments reviewers", members: [BOB] }]));
      if (remove === "viewer") w.projectRoles.set(ALICE, "viewer");
      if (remove === "company") w.orgRoles.delete(ALICE);
      const view = await reviewOf(w, BOB);
      expect(view, remove).toMatchObject({ returned: true, canClaim: true });
      expect(view.claim, remove).toBeUndefined();
      expect((await claimAs(w, BOB, groupId)).claim, remove).toMatchObject({ developerId: BOB });
    }
  });

  it("is company-scoped: a task the fake hands back from another company is not found, and keys are built from the caller's company", async () => {
    const { w, groupId } = await withGroup();
    w.task = { ...w.task, orgId: OTHER_ORG };
    expect(await err(reviewOf(w, ALICE))).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await err(claimAs(w, ALICE, groupId))).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(reviewClaimKey(ORG, TASK).pk).not.toBe(reviewClaimKey(OTHER_ORG, TASK).pk);
    expect(await err(getTaskReview(w.deps, w.caller(ALICE, OTHER_ORG), TASK))).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("refuses a body with fields it doesn't take, without echoing values", async () => {
    const { w, groupId } = await withGroup();
    const answer = await err(claimReview(w.deps, w.caller(ALICE), TASK, { requestId: rid(), expectedRevision: 0, reviewKey: reviewKeyOf(w.tracking), groupId, extra: "secret-value" }));
    expect(answer.code).toBe("CONFIG_INVALID");
    expect(answer.message).not.toContain("secret-value");
  });
});
