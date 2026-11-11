// Review groups (owner decision 9, requirement A-22, DN-5, S-23): a project's named groups of reviewers, and who has claimed a task's waiting review.
//
// Two separate things decide reviews. The code host decides who may APPROVE (CODEOWNERS, write permission, a linked account, the sole approver can't merge, stale approvals): nothing here
// changes that. Review groups only share the WORK: a group member claims a waiting review and becomes the requested reviewer on the code host; they release it back to the group; a
// maintainer reassigns it to another member. A claim never grants approval rights.
//
//   GET  /v1/app/projects/{p}/review-groups                anyone who can see the project: the groups, their members, and whether the caller may change them.
//   PUT  /v1/app/projects/{p}/review-groups                a maintainer (or an org owner or admin), browser only: the whole list of groups, under the revision read.
//   GET  /v1/app/tasks/{t}/review                          anyone who can read the task: the waiting review, its claim, its age, and what the caller may do.
//   POST /v1/app/tasks/{t}/review/(claim|release|reassign) browser only, under the claim's revision and the review's key (its pull requests and their heads).
//
// Browser-safe: nothing here imports `node:*`. Words, ids, counts and times only.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";

export const REVIEW_GROUPS_PATH = /^\/v1\/app\/projects\/([^/]+)\/review-groups$/u;
export const TASK_REVIEW_PATH = /^\/v1\/app\/tasks\/([0-9a-fA-F-]{36})\/review$/u;
export const TASK_REVIEW_ACTION_PATH = /^\/v1\/app\/tasks\/([0-9a-fA-F-]{36})\/review\/(claim|release|reassign)$/u;

/** The most groups one project keeps (the whole list is one stored document). */
export const REVIEW_GROUPS_MAX = 20;
/** The most people in one group. */
export const REVIEW_GROUP_MEMBERS_MAX = 50;
/** The most different people across all of a project's groups (each is looked up live on every read). */
export const REVIEW_GROUPS_PEOPLE_MAX = 200;
/** The longest group name, in code points. */
export const REVIEW_GROUP_NAME_MAX = 60;
/**
 * The age nudge: a review that has waited this long since the reviewers were asked (or the pull request became ready) is flagged `aged`, claimed or not. The same 24 hours as the
 * code host's first reviewer reminder (`REVIEW_NUDGE_FIRST_HOURS`), so the page's flag and the reminder agree.
 */
export const REVIEW_AGE_NUDGE_HOURS = 24;

export const REVIEW_CLAIM_ACTIONS = ["claim", "release", "reassign"] as const;
export type ReviewClaimAction = (typeof REVIEW_CLAIM_ACTIONS)[number];

/** A member's id (64 lowercase hex), as everywhere else. */
const PersonIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const ReviewGroupIdSchema = z.string().regex(/^rgp_[a-f0-9]{16}$/u);
const RequestIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().min(0).max(1_000_000_000);
/** The review's key: a digest of the pull requests that wait for review and their heads. A change moved under the caller is refused (`CHANGE_STALE`). */
export const ReviewKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** A group's name: printable words, no control or format characters, trimmed. */
export const ReviewGroupNameSchema = z.string().trim().min(1).refine((name) => [...name].length <= REVIEW_GROUP_NAME_MAX, `at most ${String(REVIEW_GROUP_NAME_MAX)} characters`)
  .refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name), "has a character that can't be shown");

export const ReviewGroupInputSchema = z.object({
  /** An existing group's id; absent for a new group (the server gives it one). */
  groupId: ReviewGroupIdSchema.optional(),
  name: ReviewGroupNameSchema,
  members: z.array(PersonIdSchema).max(REVIEW_GROUP_MEMBERS_MAX),
}).strict();
export type ReviewGroupInput = z.infer<typeof ReviewGroupInputSchema>;

/** `PUT .../review-groups`: the whole list, as it should be after the change. */
export const ReviewGroupsBodySchema = z.object({
  requestId: RequestIdSchema,
  expectedRevision: RevisionSchema,
  groups: z.array(ReviewGroupInputSchema).max(REVIEW_GROUPS_MAX),
}).strict();
export type ReviewGroupsBody = z.infer<typeof ReviewGroupsBodySchema>;

export const ReviewGroupMemberViewSchema = z.object({
  developerId: PersonIdSchema,
  /** Their display name ("A former member" for someone erased). */
  name: z.string().min(1).max(200),
  /** False when the person is no longer a contributor or maintainer of the project: they can't claim, and a claim they hold has gone back to the group. */
  eligible: z.boolean(),
}).strict();

export const ReviewGroupViewSchema = z.object({
  groupId: ReviewGroupIdSchema,
  name: z.string().min(1).max(400),
  members: z.array(ReviewGroupMemberViewSchema).max(REVIEW_GROUP_MEMBERS_MAX),
}).strict();
export type ReviewGroupView = z.infer<typeof ReviewGroupViewSchema>;

export const ReviewGroupsViewSchema = z.object({
  /** 0: no groups were ever saved. */
  revision: RevisionSchema,
  groups: z.array(ReviewGroupViewSchema).max(REVIEW_GROUPS_MAX),
  /** Whether the caller may change the groups (a maintainer, or an org owner or admin). */
  canManage: z.boolean(),
}).strict();
export type ReviewGroupsView = z.infer<typeof ReviewGroupsViewSchema>;
export const ReviewGroupsViewReaderSchema = forwardReader(ReviewGroupsViewSchema);

/** `POST .../review/claim`: claim the waiting review through one of the caller's groups. */
export const ReviewClaimBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: RevisionSchema, reviewKey: ReviewKeySchema, groupId: ReviewGroupIdSchema }).strict();
/** `POST .../review/release`: give the claim back to the group (its holder only). */
export const ReviewReleaseBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: RevisionSchema }).strict();
/** `POST .../review/reassign`: a maintainer gives the review to another member of the claim's group (or, unclaimed, of `groupId`). */
export const ReviewReassignBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: RevisionSchema, reviewKey: ReviewKeySchema, groupId: ReviewGroupIdSchema, to: PersonIdSchema }).strict();
export type ReviewClaimBody = z.infer<typeof ReviewClaimBodySchema>;
export type ReviewReleaseBody = z.infer<typeof ReviewReleaseBodySchema>;
export type ReviewReassignBody = z.infer<typeof ReviewReassignBodySchema>;

/** Whether the code host was asked to list the holder as a requested reviewer: `requested`, `refused` by the host (no access, the author), `pending` (not asked yet: replaying the request asks again), `unavailable` (the host could not be reached or has no way to ask). */
export const REVIEW_HOST_SYNC = ["requested", "refused", "pending", "unavailable"] as const;
export type ReviewHostSync = (typeof REVIEW_HOST_SYNC)[number];

export const TaskReviewPullRequestSchema = z.object({
  repositoryId: z.string().min(1).max(200),
  number: z.number().int().positive(),
  /** When the reviewers were asked (or the pull request became ready for review). */
  waitingSince: z.string().datetime().optional(),
}).strict();

export const TaskReviewViewSchema = z.object({
  /** Whether a pull request of the task waits for review now (open, out of draft, not approved and no changes asked). */
  waiting: z.boolean(),
  /** The key a claim or reassign must name; absent when nothing waits. */
  reviewKey: ReviewKeySchema.optional(),
  pullRequests: z.array(TaskReviewPullRequestSchema).max(20),
  /** The earliest `waitingSince` of the waiting pull requests. */
  waitingSince: z.string().datetime().optional(),
  /** The age nudge: waiting at least `REVIEW_AGE_NUDGE_HOURS`. */
  aged: z.boolean(),
  ageHours: z.number().int().min(0).optional(),
  /** The claim's revision: the one a claim, release or reassign names. 0: never claimed. */
  revision: RevisionSchema,
  /** The current claim, when someone live holds it. */
  claim: z.object({
    developerId: PersonIdSchema,
    name: z.string().min(1).max(200),
    groupId: ReviewGroupIdSchema,
    groupName: z.string().min(1).max(400),
    claimedAt: z.string().datetime(),
    hostSync: z.enum(REVIEW_HOST_SYNC),
  }).strict().optional(),
  /** Set when a claim was stored but its holder left the group or the project: the review is back with the group. */
  returned: z.literal(true).optional(),
  /** The groups the caller may claim through (they are an eligible member). */
  claimableGroups: z.array(z.object({ groupId: ReviewGroupIdSchema, name: z.string().min(1).max(400) }).strict()).max(REVIEW_GROUPS_MAX),
  canClaim: z.boolean(),
  canRelease: z.boolean(),
  canReassign: z.boolean(),
  /** Always the same sentence: claiming shares the work; the code host still decides who may approve. */
  approvalNote: z.string().min(1).max(300),
}).strict();
export type TaskReviewView = z.infer<typeof TaskReviewViewSchema>;
export const TaskReviewViewReaderSchema = forwardReader(TaskReviewViewSchema);

export const REVIEW_CLAIM_APPROVAL_NOTE = "Claiming a review shares the work. It doesn't let anyone approve: the code host's rules (code owners, write access) still decide who can.";

/** The fixed words of the refusals. They never echo an id or a name from the request. */
export const REVIEW_GROUP_MESSAGES = {
  maintainersOnly: "Only a project maintainer, or a company owner or admin, can change review groups.",
  stale: "This changed while you were looking. Reload and try again.",
  requestReused: "requestId: this request ID was already used for a different request",
  notWaiting: "No pull request of this task is waiting for review.",
  notInGroup: "You aren't an eligible member of that review group.",
  noGroup: "That review group isn't in this task's project.",
  alreadyClaimed: "Someone else has claimed this review. A maintainer can reassign it.",
  notHolder: "Only the person who claimed this review can release it.",
  nothingToRelease: "Nobody has claimed this review.",
  reassignMaintainers: "Only a project maintainer, or a company owner or admin, can reassign a review.",
  targetNotInGroup: "to: that person isn't an eligible member of the review group.",
  ownTask: "You asked for this task, so someone else reviews it.",
  targetOwnTask: "to: that person asked for this task, so someone else reviews it.",
  linkGithub: "Link your GitHub account to claim reviews: the claim makes you the requested reviewer on GitHub.",
  targetNoGithub: "to: that person hasn't linked a GitHub account, so they can't be the requested reviewer.",
  browserOnly: "Use a live browser session to change review groups or claims.",
} as const;
