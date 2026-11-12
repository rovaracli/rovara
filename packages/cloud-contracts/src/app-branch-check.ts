// The default-branch check (0.5.16): when a project is added, Rovara reads each code repository's default branch on GitHub before any setup work starts. A branch that holds no files is told to the person,
// with the branches that do have code, so a project is not set up against an empty tree. Names, branch names and dates only: nothing from inside a repository.
import { z } from "zod";
import { GitBranchNameSchema } from "@rovara-code/contracts";
import { AppProjectDetailSchema } from "./app-projects.js";

/**
 * `has_files`: the branch has code. `empty`: it exists but its tree is empty (a repository with only an "Initial commit"). `missing`: the project's branch is not in the repository (deleted or renamed).
 * `no_code`: neither this branch nor any other holds a file (an empty repository). `unchecked`: GitHub could not answer; nothing is known, and nothing is blocked.
 */
export const BRANCH_CHECK_STATES = ["has_files", "empty", "missing", "no_code", "unchecked"] as const;
export const BranchCheckStateSchema = z.enum(BRANCH_CHECK_STATES);
export type BranchCheckState = z.infer<typeof BranchCheckStateSchema>;

/** The most branches offered as a suggestion, and the most Rovara looks at to find them (the first 12 of the repository's first 100). */
export const BRANCH_SUGGESTIONS_MAX = 5;
export const BRANCH_INSPECTED_MAX = 12;
export const BRANCH_CHECK_REPOSITORIES_MAX = 8;

export const BranchCandidateSchema = z.object({ name: GitBranchNameSchema, lastCommitAt: z.string().optional() }).strict();
export type BranchCandidate = z.infer<typeof BranchCandidateSchema>;

export const RepositoryBranchCheckSchema = z.object({
  repository: z.string().min(1).max(140),
  fullName: z.string().min(1).max(140),
  branch: GitBranchNameSchema,
  state: BranchCheckStateSchema,
  /** Branches that have files, newest commit first. Present only when `branch` has none. */
  alternatives: z.array(BranchCandidateSchema).max(BRANCH_SUGGESTIONS_MAX),
  /** False when the repository has more branches than were looked at, so "no other branch has code" is not certain. */
  searchedAll: z.boolean(),
  /** The person chose to go on with this branch as it is (for this exact repository and branch). */
  continued: z.boolean(),
}).strict();
export type RepositoryBranchCheck = z.infer<typeof RepositoryBranchCheckSchema>;

/** `GET /v1/app/projects/{name}/branch-check`. `blocked` is the one word the page and the server's gate agree on: a repository is empty or missing or has no code, and the person has not chosen to continue. */
export const BranchCheckResponseSchema = z.object({
  revision: z.number().int().positive(),
  repositories: z.array(RepositoryBranchCheckSchema).max(BRANCH_CHECK_REPOSITORIES_MAX),
  blocked: z.boolean(),
}).strict();
export type BranchCheckResponse = z.infer<typeof BranchCheckResponseSchema>;

/** `PUT /v1/app/projects/{name}/default-branch`: use another branch of one repository. `expectedRevision` is the revision the person was looking at. */
export const SetDefaultBranchBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  repository: z.string().min(1).max(140),
  branch: GitBranchNameSchema,
}).strict();
export type SetDefaultBranchBody = z.infer<typeof SetDefaultBranchBodySchema>;

/** The answer to choosing another branch: the project as it is now, and the same check run on the branch chosen. */
export const SetDefaultBranchResponseSchema = z.object({ project: AppProjectDetailSchema, check: BranchCheckResponseSchema }).strict();
export type SetDefaultBranchResponse = z.infer<typeof SetDefaultBranchResponseSchema>;

/** `POST /v1/app/projects/{name}/branch-check/continue`: the person explicitly goes on with a branch that has no files. */
export const ContinueBranchBodySchema = z.object({
  repository: z.string().min(1).max(140),
  branch: GitBranchNameSchema,
}).strict();
export type ContinueBranchBody = z.infer<typeof ContinueBranchBodySchema>;

/** What the empty-branch refusal of a draft or a setup run says; the page shows the check instead. */
export const BRANCH_GATE_MESSAGE = "This project's default branch has no files yet. Choose a branch with code, or continue anyway, before Rovara drafts the setup.";
