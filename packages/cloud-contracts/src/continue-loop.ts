// "Continue in your own tool", the server side (decision 4; E-28..E-31, owner Q13; DEFERRED-CHECKS CONTINUE-IN-TOOL-BROKER). Cloud-only shapes: nothing here is a name Rovara Code's contracts export.
//
//   - `ContinueLoopViewSchema`: what the task view says about the task's working branch, a push that did not come from Rovara ("Changed outside Rovara · checks needed", with the pusher's GitHub login) and
//     whether THIS reader may publish the branch or ask for a re-check. Browser-safe: the web app reads it.
//   - the two requests of the owner/co-owner actions: publish the working branch, and Recheck.
//
// A login is the host's own pusher name (never an email, never the commit author, which anyone can forge).
import { z } from "zod";

const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
/** A GitHub login as the host spells it: letters, digits and single hyphens, up to 39 characters, plus the `[bot]` suffix of an app's own account. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
export const GithubLoginSchema = z.string().max(45).regex(GITHUB_LOGIN_PATTERN);

/** The words of the state, for every surface (the task page and the tools say the same thing). */
export const CHANGED_OUTSIDE_LABEL = "Changed outside Rovara · checks needed";

/** The worker feature that adopts a head pushed outside Rovara (a read-only maintain run). */
export const OUTSIDE_RECHECK_WORKER_FEATURE = "maintain.workflowAdopt.v1" as const;
/** Said, word for word, where this install's workers cannot adopt an outside head yet. */
export const OUTSIDE_RECHECK_WORKER_MISSING = "This install's workers can't re-check outside changes yet.";

/** Said on a published branch's outside row: a re-check runs on a pull request's head only (owner decision for 0.5.15; see the API note). */
export const RECHECK_NEEDS_PULL_REQUEST_NOTE = "Rovara re-checks once a pull request exists.";
/** Said beside a published branch: Rovara's own pull request is opened from its own run branch, so pushes to the published branch do not reach it. */
export const PUBLISHED_BRANCH_NOTE = "Rovara's pull request will come from its own branch. To have Rovara re-check your changes, push them to the pull request's branch.";

/** Rovara's own working branch for a task is `agentx/<taskId>`: one branch per task and repository, the shape Rovara's host reads accept (`agentx/<uuid>`). */
export const workingBranchName = (taskId: string): string => `agentx/${taskId.toLowerCase()}`;

export const ContinueLoopBranchSchema = z.object({
  repository: z.string().min(1).max(200),
  /** The branch to push to: `agentx/<uuid>`. */
  branch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/iu),
  /** `pull_request`: the branch Rovara opened a pull request from. `published`: a branch made on request, before any pull request. */
  source: z.enum(["pull_request", "published"]),
  /** The commit Rovara last put on it (a published branch starts at the task's base commit). */
  headSha: GitShaSchema.optional(),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().url().max(2048) }).strict().optional(),
}).strict();
export type ContinueLoopBranch = z.infer<typeof ContinueLoopBranchSchema>;

export const ContinueLoopOutsideSchema = z.object({
  repository: z.string().min(1).max(200),
  /** Absent for a branch with no pull request yet. */
  number: z.number().int().positive().optional(),
  /** The head the host shows now, which Rovara did not make. */
  headSha: GitShaSchema,
  /** The pusher's login, only when the host's own push event named it for this very head. */
  lastPushedBy: z.object({ login: GithubLoginSchema, at: z.string().datetime() }).strict().optional(),
  /** Whether Rovara can re-check this head now (a pull request exists and the task is waiting for the merge). */
  canRecheck: z.boolean(),
  /** Rovara is re-checking this head now (it took it as the task's code and its checks are starting or running): show "Re-checking", no button. */
  rechecking: z.literal(true).optional(),
  /** Why there is no Recheck for this row when the reason is the row's own (not the reader's role): word for word. */
  recheckNote: z.literal(RECHECK_NEEDS_PULL_REQUEST_NOTE).optional(),
}).strict();
export type ContinueLoopOutside = z.infer<typeof ContinueLoopOutsideSchema>;

export const ContinueLoopViewSchema = z.object({
  branches: z.array(ContinueLoopBranchSchema).max(32),
  /** One row per branch whose head is not one Rovara made. Empty when nothing changed outside. */
  outside: z.array(ContinueLoopOutsideSchema).max(32),
  /** The words of the state, so no surface invents its own. Present with `outside`. */
  label: z.literal(CHANGED_OUTSIDE_LABEL).optional(),
  /** Whether THIS reader may publish the working branch of a repository that has none yet (owner or co-owner, and only on a task that is open and prepared). The route checks again. */
  canPublishBranch: z.boolean(),
  /** With `canPublishBranch`: the repositories that have no branch yet and can get one, each at the commit the branch would be made at. */
  publishable: z.array(z.object({ repository: z.string().min(1).max(200), baseSha: GitShaSchema }).strict()).max(32).optional(),
  /** Present when a published branch is listed: word for word (Rovara's pull request comes from its own branch). */
  publishedBranchNote: z.literal(PUBLISHED_BRANCH_NOTE).optional(),
  /** Whether THIS reader may ask for a re-check (owner or co-owner). The route checks again. */
  canRecheck: z.boolean(),
}).strict();
export type ContinueLoopView = z.infer<typeof ContinueLoopViewSchema>;

export const PublishWorkingBranchRequestSchema = z.object({
  requestId: z.string().uuid(),
  /** The repository's name in the project (`repository` of a pull request), as the view lists it. */
  repository: z.string().min(1).max(200),
}).strict();
export type PublishWorkingBranchRequest = z.infer<typeof PublishWorkingBranchRequestSchema>;

export const PublishWorkingBranchResultSchema = z.object({
  repository: z.string().min(1).max(200),
  branch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/iu),
  commit: GitShaSchema,
  /** False when the branch was already there (a repeat of the same request, or an earlier press): nothing was changed. */
  created: z.boolean(),
}).strict();
export type PublishWorkingBranchResult = z.infer<typeof PublishWorkingBranchResultSchema>;

export const RecheckRequestSchema = z.object({
  requestId: z.string().uuid(),
  repository: z.string().min(1).max(200),
  number: z.number().int().positive(),
  /** The head the person saw as changed outside: the re-check is for exactly it, and a head that moved since is refused. */
  headSha: GitShaSchema,
}).strict();
export type RecheckRequest = z.infer<typeof RecheckRequestSchema>;

/** What a host's push event records for a pull request or branch, read only to say who pushed which head. Stored as `DEVTASK#<taskId>` / `OUTSIDE_PUSH#<repository>#<number or branch>`. */
export const OutsidePushHintSchema = z.object({
  headSha: GitShaSchema,
  login: GithubLoginSchema,
  at: z.string().datetime(),
}).strict();
export type OutsidePushHint = z.infer<typeof OutsidePushHintSchema>;
