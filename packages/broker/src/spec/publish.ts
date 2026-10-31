// K1 lane D, C1 fix: the BROKER builds the spec commit. Nothing about it comes from the builder's workspace and no worker holds a push credential to the meta repository: the broker creates the blobs, the tree
// (on the base commit's own tree), the commit (one parent: the pinned base) and the branch through GitHub's Git Data API, then asks GitHub what the commit changed and refuses anything but exactly the spec's files,
// each added, each with the blob hash the broker computed from its own content. Only then is the pull request opened, and its head is checked to be that commit.
import { createHash } from "node:crypto";
import { SPEC_FILES_MAX, SPEC_FILE_MAX_BYTES, specFileNameProblem, specFolderProblem, specPathProblem, type SpecFile } from "@agentx/contracts";

export const SPEC_TOTAL_MAX_BYTES = 256 * 1024;

/** What the broker needs of GitHub's Git Data API, for one repository, with a token that is the broker's alone. */
export interface SpecGitClient {
  /** The tree of a commit. */
  getCommit(sha: string): Promise<{ tree: string; parents: string[] }>;
  /** The commit a branch points at, or undefined when there is no such branch. */
  getBranch(branch: string): Promise<string | undefined>;
  createBlob(content: string): Promise<string>;
  createTree(baseTree: string, entries: ReadonlyArray<{ path: string; sha: string }>): Promise<string>;
  createCommit(input: { message: string; tree: string; parent: string }): Promise<string>;
  createBranch(branch: string, sha: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /** What `head` changes against `base`: the changed files (name, status, blob hash) and how many commits there are. `complete` is false when GitHub cut the list. */
  compare(base: string, head: string): Promise<{ complete: boolean; commits: number; files: Array<{ path: string; status: string; sha: string }> }>;
}

export interface SpecPullRequestOpener {
  open(input: { headBranch: string; baseBranch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  headOf(number: number): Promise<string>;
  close(number: number): Promise<void>;
}

export type SpecPublishFailure = "paths" | "github" | "verification";

export class SpecPublishError extends Error {
  constructor(readonly reason: SpecPublishFailure, readonly transient: boolean) {
    super(`spec publication refused: ${reason}`);
    this.name = "SpecPublishError";
  }
}

/** The Git blob hash of a text, as `git hash-object` gives it. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${String(bytes.byteLength)}\0`).update(bytes).digest("hex");
}

/**
 * The paths a spec publication may write: inside `folder`, new files only (checked again against GitHub below), not in a rules, steering, skills, config or automation folder, no rules/steering/ownership file names,
 * no duplicates (any case), bounded in number and size. Throws SpecPublishError("paths").
 */
export function assertSpecPaths(files: readonly SpecFile[], folder: string, forbiddenFolders: readonly string[]): void {
  const refuse = (): never => { throw new SpecPublishError("paths", false); };
  if (files.length === 0 || files.length > SPEC_FILES_MAX) refuse();
  const prefix = `${folder.replace(/\/+$/u, "")}/`;
  if (specPathProblem(folder) !== undefined || specFolderProblem(folder, forbiddenFolders) !== undefined) refuse();
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (specPathProblem(file.path) !== undefined || !file.path.startsWith(prefix) || specFileNameProblem(file.path) !== undefined || specFolderProblem(file.path.split("/").slice(0, -1).join("/"), forbiddenFolders) !== undefined
      || seen.has(file.path.toLowerCase()) || bytes > SPEC_FILE_MAX_BYTES) refuse();
    seen.add(file.path.toLowerCase());
  }
  if (total > SPEC_TOTAL_MAX_BYTES) refuse();
}

/** Checks that `head` is one commit on `base` that adds exactly `files`, each with its own hash. Throws SpecPublishError("verification"). */
async function verifyCommit(git: SpecGitClient, base: string, head: string, files: readonly SpecFile[]): Promise<void> {
  const refuse = (): never => { throw new SpecPublishError("verification", false); };
  const commit = await git.getCommit(head);
  if (commit.parents.length !== 1 || commit.parents[0] !== base) refuse();
  const changed = await git.compare(base, head);
  if (!changed.complete || changed.commits !== 1 || changed.files.length !== files.length) refuse();
  const expected = new Map(files.map((file) => [file.path, gitBlobSha(file.content)]));
  for (const file of changed.files) {
    if (file.status !== "added" || expected.get(file.path) !== file.sha) refuse();
    expected.delete(file.path);
  }
  if (expected.size !== 0) refuse();
}

/**
 * Publishes a spec: builds the commit through GitHub, verifies it, opens the pull request, checks its head. A branch that already exists (a cut-short earlier try) is verified and reused, never trusted. On a
 * verification failure the branch is deleted and no pull request is opened. GitHub errors are `transient`.
 */
export async function publishSpec(
  deps: { git: SpecGitClient; pullRequests: SpecPullRequestOpener },
  input: { files: readonly SpecFile[]; folder: string; baseCommit: string; baseBranch: string; branch: string; title: string; body: string; forbiddenFolders: readonly string[] },
): Promise<{ commit: string; number: number; url: string }> {
  assertSpecPaths(input.files, input.folder, input.forbiddenFolders);
  if (!/^[a-f0-9]{40}$/u.test(input.baseCommit) || !/^agentx\/[0-9a-f-]{36}$/u.test(input.branch)) throw new SpecPublishError("paths", false);
  let head: string | undefined;
  try {
    head = await deps.git.getBranch(input.branch);
    if (head === undefined) {
      const base = await deps.git.getCommit(input.baseCommit);
      const entries: Array<{ path: string; sha: string }> = [];
      for (const file of input.files) {
        const sha = await deps.git.createBlob(file.content);
        if (sha !== gitBlobSha(file.content)) throw new SpecPublishError("verification", false);
        entries.push({ path: file.path, sha });
      }
      const tree = await deps.git.createTree(base.tree, entries);
      head = await deps.git.createCommit({ message: input.title.replace(/[\r\n]+/gu, " ").slice(0, 200), tree, parent: input.baseCommit });
      await deps.git.createBranch(input.branch, head);
    }
    await verifyCommit(deps.git, input.baseCommit, head, input.files);
  } catch (error) {
    if (error instanceof SpecPublishError) {
      if (error.reason === "verification" && head !== undefined) await deps.git.deleteBranch(input.branch).catch(() => undefined);
      throw error;
    }
    throw new SpecPublishError("github", true);
  }
  let opened: { number: number; url: string };
  try {
    opened = await deps.pullRequests.open({ headBranch: input.branch, baseBranch: input.baseBranch, title: input.title, body: input.body });
    if (await deps.pullRequests.headOf(opened.number) !== head) {
      await deps.pullRequests.close(opened.number).catch(() => undefined);
      throw new SpecPublishError("verification", false);
    }
  } catch (error) {
    if (error instanceof SpecPublishError) throw error;
    throw new SpecPublishError("github", true);
  }
  return { commit: head, number: opened.number, url: opened.url };
}

