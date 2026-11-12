// Rovara Code (Plan 6 Task 1): the shapes of Understand, the plan critic, risk, merge tracking, code settings, reports, setup drafts and milestones, and the limits
// that bound them. Browser-safe on purpose: the web app reads these, so nothing here imports a Node module. What needs `node:crypto` (the tracking item's
// digest) lives in `rovara-code-node.ts`.
import { z } from "zod";
import { BRANCH_SYNC_REASONS, BRANCH_SYNCS_PER_DAY_MAX, FixSourceSchema, OrgIdSchema, REVIEW_NUDGES_MAX } from "@rovara-code/contracts";

// ---- small pieces

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const InstantSchema = z.string().datetime();
const CountSchema = z.number().int().min(0);

/** Which fix a coding run is, sent with an IMPLEMENT run (worker feature "task.workflowFix"): the run changes a pull request that is already open. */
export const WorkflowFixPayloadSchema = z.object({
  source: FixSourceSchema,
  /** A run that starts a CI or feedback fix: the head the pull request has. The worker starts from it, so what an abandoned conflict round left (markers, a local merge commit) is not what the fix begins on. */
  startFrom: GitShaSchema.optional(),
  /**
   * The same for a task with several repositories (several open pull requests): each repository starts from its pull request's head, so code a re-check took and did not keep ("Continue in your own
   * tool") is not what a fix begins on. Sent only to a worker whose /ping lists "task.workflowFixStartRepositories.v1" (dropped for an older one, which then restores a single repository as before).
   */
  startFromRepositories: z.array(z.object({ repositoryId: z.string().trim().min(1).max(200), commit: GitShaSchema }).strict()).min(1).max(32).optional(),
}).strict();
export type WorkflowFixPayload = z.infer<typeof WorkflowFixPayloadSchema>;
/** A merge of the base into one pull request's branch that is queued or running: the head it is for, and why (`approved`: a person's go-ahead started it, for an agent set to suggest). */
export const WorkflowBranchSyncSchema = z
  .object({ repositoryId: z.string().trim().min(1).max(200), number: z.number().int().positive(), expectedHeadCommit: GitShaSchema, reason: z.enum(BRANCH_SYNC_REASONS), approved: z.literal(true).optional() })
  .strict();
export type WorkflowBranchSync = z.infer<typeof WorkflowBranchSyncSchema>;

// ---- merge tracking

/** The separate item that holds what GitHub says about one pull request of a task (`DEVTASK#<taskId>` / `MERGE_TRACKING#<repositoryId>#<number>`). `decisionDigest` hashes every field but `observedAt`, `version` and itself. */
export const MergeTrackingItemSchema = z
  .object({
    orgId: OrgIdSchema,
    taskId: z.string().uuid(),
    repositoryId: z.string().min(1).max(200),
    number: z.number().int().positive(),
    version: CountSchema,
    headSha: GitShaSchema,
    draft: z.boolean(),
    state: z.enum(["open", "closed", "merged"]),
    baseBranch: z.string().min(1).max(255),
    ci: z.enum(["none", "pending", "passing", "failing"]),
    ciBasis: z.enum(["required", "all_checks"]),
    checksEverSeen: z.boolean(),
    failingChecks: z.array(z.string().min(1).max(200)).max(10),
    review: z.enum(["not_requested", "requested", "changes_requested", "approved"]),
    approval: z.object({ githubUserId: z.string().min(1).max(40), login: z.string().min(1).max(100), commitId: GitShaSchema }).strict().optional(),
    branch: z.enum(["up_to_date", "behind", "conflicted", "unknown"]),
    headByRovara: z.boolean(),
    lastRovaraPushAt: InstantSchema.optional(),
    readyAt: InstantSchema.optional(),
    reviewersRequestedAt: InstantSchema.optional(),
    nudges: z.object({ count: CountSchema.max(REVIEW_NUDGES_MAX), lastAt: InstantSchema.optional() }).strict(),
    syncs: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: CountSchema.max(BRANCH_SYNCS_PER_DAY_MAX) }).strict(),
    mergeClaim: z.object({ headSha: GitShaSchema, by: z.string().min(1).max(200), at: InstantSchema }).strict().optional(),
    decisionDigest: Sha256Schema,
    observedAt: InstantSchema,
  })
  .strict();
export type MergeTrackingItem = z.infer<typeof MergeTrackingItemSchema>;

/** The exact texts of `MERGE_NOT_READY` (409). Words for a person: nothing here carries a title, a comment or a log. */
export const MERGE_NOT_READY_MESSAGES = {
  needsOtherApproval: (requester: string): string => `This pull request needs an approval from someone other than ${requester}.`,
  needsWriteApproval: (repository: string): string => `This pull request needs an approval on GitHub from someone who can write to ${repository}.`,
  linkGithub: "Link your GitHub account so Rovara can tell your approval from a reviewer's.",
  presserApproved: "You approved this pull request, so someone else must press Merge.",
  checks: "Checks haven't passed on the latest code.",
  conflicted: (base: string): string => `The branch conflicts with ${base}. I'm resolving it.`,
  baseChanged: (branch: string): string => `The pull request's base changed to ${branch}. Change it back or close the task.`,
  draft: "The pull request is still a draft.",
  notOpen: "The pull request isn't open.",
  changing: "I'm still changing this pull request.",
  repository: (repository: string, reason: string): string => `${repository}'s pull request isn't ready yet: ${reason}`,
  // Not in the plan's list; the plan has no word for these states.
  changesRequested: "A reviewer asked for changes on this pull request.",
  staleApproval: "The approval was for earlier code. This pull request needs a new approval.",
  behind: (base: string): string => `The branch is behind ${base}, and GitHub needs it up to date. I'm bringing it up to date; press Merge again when that is done.`,
  /** A branch that is behind a base GitHub needs it up to date with, on a task whose changes need browser or API checks: Rovara does not merge the base in for it (the merged code could not be checked again), so the person does. */
  behindByHand: (base: string): string => `The branch is behind ${base}, and GitHub needs it up to date. This task's changes need browser or API checks, so I won't merge the base in myself: update the branch on GitHub, then press Merge again, or send the task back.`,
  /** The base branch was merged into the pull request: the merged code is a new candidate that needs its checks and reviews again before the task waits for the merge. */
  baseMerged: "The base branch was merged into this pull request, so the merged code needs its checks and reviews again before it can be merged.",
  taskClosed: "This task is closed.",
  presserLostRight: "You can no longer merge this task, so nothing was merged.",
  notTrackedYet: "I haven't finished reading this pull request from GitHub yet. Try again in a minute.",
  notMerged: (repository: string, reason: string): string => `${repository} didn't merge: ${reason}. Check it on GitHub, then press Merge again.`,
  changedAfterConfirm: "The pull request changed after you confirmed. Check it and press Merge again.",
  halfMerged: (merged: string, failed: string, reason: string): string => `${merged} merged, but ${failed} didn't: ${reason}. Merge it on GitHub or press Merge again.`,
  /** Where the repository has a CODEOWNERS file that covers changed paths, a code owner has to approve (owner decision 2026-10-27). `owners` are the logins and teams, as the file names them. */
  needsCodeOwner: (owners: string): string => `A code owner has to approve the files this pull request changes (${owners}).`,
  codeOwnersUnreadable: "Rovara couldn't read this repository's code owners, so it can't tell whether a code owner approved. Try again in a minute.",
  /** Lessons in the repo (decision 50.4): `.rovara/lessons.md` is the team's file and changes only through Rovara's own weekly lessons pull request, never through a task's. */
  touchesLessonsFile: "This pull request changes .rovara/lessons.md, which only the team's weekly lessons pull request may change. Take that file out of this pull request.",
  /** G-04: the company rules file (the default path, or the one the company connected) changes only through the company rules in Rovara, never through a task's pull request. */
  touchesCompanyRulesFile: "This pull request changes the company rules file, which changes only through the company rules in Rovara. Take that file out of this pull request.",
  lessonsFileUnreadable: "Rovara couldn't read the full list of files this pull request changes, so it can't tell whether it leaves .rovara/lessons.md alone. Try again in a minute.",
  riskChanged: (level: "low" | "medium" | "high"): string => `The risk of this pull request is now ${level}. Check it and press Merge again.`,
} as const;
