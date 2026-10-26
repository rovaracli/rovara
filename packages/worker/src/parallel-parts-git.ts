import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";
import { isolatedGitEnvironment } from "./git.js";
import { candidateLayout, copyObjectsOut, withIsolatedGit } from "./isolated-git.js";
import { withIsolatedRepository } from "./isolated-repository.js";
import type { IntegrationResult } from "./parallel-parts.js";
import { readCandidateRepositories } from "./verification/candidate.js";

const execFile = promisify(execFileCallback);

// The git work behind parallel parts (see parallel-parts.ts). Every part is a small repository of its own, in a folder outside every project repository, whose objects borrow the
// project repository's (alternates), so a part sees the code and can write its own files, and nothing it does reaches the project repository until its tree is merged in. Git
// never runs in a repository the agent can write except through isolated-git.ts's throwaway repositories, as everywhere else in the worker. A part's folder is
// `<root>/.agentx/parts/<itemId>/<repository>`; `.agentx` is the worker's own folder, not a repository's, so `git status` in a project repository never lists it.

/**
 * Everything that writes the project repository's objects or files goes one at a time: the throwaway repositories copy their new objects into one object directory, and two
 * copies at once race on its sub-folders. Parts still build side by side; only these short git steps queue.
 */
const queues = new Map<string, Promise<unknown>>();
function inRepository<T>(repositoryDirectory: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(repositoryDirectory);
  const next = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

/** Where the parts' working copies live, under the workspace root. */
export const PARTS_DIRECTORY = ".agentx/parts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const ITEM_ID = /^[a-f0-9-]{36}$/u;

/** The folder of one part's working copy, refusing anything that could leave the parts folder. */
export function partDirectory(rootPath: string, itemId: string, repositoryId: string): string {
  const segments = repositoryId.split("/");
  if (!ITEM_ID.test(itemId) || segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    throw agentXError("CONFIG_INVALID", "a work breakdown part has an unsafe folder name");
  }
  return join(resolve(rootPath), PARTS_DIRECTORY, itemId, ...segments);
}

export interface PartWorkingCopy {
  readonly directory: string;
  readonly repositoryId: string;
  /** Removes the working copy and its item folder (the shared parts folder stays). Safe to call twice. */
  remove(): Promise<void>;
}

const GIT_IDENTITY = ["-c", "user.name=Rovara", "-c", "user.email=rovara@noreply.local"] as const;

/** Makes the working copy of one part: a repository at `treeSha`, borrowing `repositoryDirectory`'s objects. */
export async function createPartWorkingCopy(input: { rootPath: string; repositoryDirectory: string; repositoryId: string; itemId: string; treeSha: string }): Promise<PartWorkingCopy> {
  if (!HEX40.test(input.treeSha)) throw new Error("part start tree is invalid");
  const directory = partDirectory(input.rootPath, input.itemId, input.repositoryId);
  const itemFolder = join(resolve(input.rootPath), PARTS_DIRECTORY, input.itemId);
  const main = await candidateLayout(input.repositoryDirectory);
  // A folder a stopped run left behind is not trusted.
  await rm(itemFolder, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const copy: PartWorkingCopy = {
    directory, repositoryId: input.repositoryId,
    remove: async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(itemFolder, { recursive: true, force: true });
    },
  };
  try {
    await execFile("git", ["init", "--quiet", "--template=", directory], { env: isolatedGitEnvironment(directory), cwd: resolve(input.rootPath) });
    await mkdir(join(directory, ".git", "objects", "info"), { recursive: true });
    await writeFile(join(directory, ".git", "objects", "info", "alternates"), `${main.objects}\n`, { mode: 0o600 });
    // A commit whose tree is the start tree, written into the project repository's objects, so the part's HEAD names something every git call can read.
    const commit = await inRepository(input.repositoryDirectory, () => withIsolatedGit(input.repositoryDirectory, "write", async (git) =>
      (await git.text([...GIT_IDENTITY, "commit-tree", input.treeSha, "-m", "Rovara part start"], { index: "none" })).trim()));
    if (!HEX40.test(commit)) throw new Error("part start commit is invalid");
    await writeFile(join(directory, ".git", "HEAD"), `${commit}\n`, { mode: 0o600 });
    // The files, and an index that agrees with them, so the agent's own `git status` in the part is clean.
    await withIsolatedGit(directory, "read", async (git) => {
      await git.text(["read-tree", commit]);
      await git.text(["checkout-index", "--all", "--force", "-u"]);
      await copyFile(git.temporaryIndex, join(directory, ".git", "index"));
    });
  } catch (error) {
    await copy.remove().catch(() => undefined);
    throw error;
  }
  return copy;
}

/** The tree of everything the part holds now (its files as they are), with its new objects copied into the project repository so a merge can use them. */
export async function capturePartTree(part: PartWorkingCopy, repositoryDirectory: string): Promise<string> {
  const identities = await readCandidateRepositories([{ repositoryId: part.repositoryId, directory: part.directory }]);
  const treeSha = identities[0]?.treeSha;
  if (identities.length !== 1 || treeSha === undefined) throw new Error("a part's tree could not be read");
  await inRepository(repositoryDirectory, async () => copyObjectsOut((await candidateLayout(part.directory)).objects, await candidateLayout(repositoryDirectory)));
  return treeSha;
}

/**
 * Three-way merge of a part's tree into the integrated tree, with `baseTreeSha` as the common ancestor (`git merge-tree --write-tree`, Git's own text merge, no repository
 * driver). Exit status 1 is a conflict, which is returned and never resolved by guesswork; any other failure is thrown.
 */
export async function integrateTrees(repositoryDirectory: string, input: { integratedTreeSha: string; baseTreeSha: string; partTreeSha: string }): Promise<IntegrationResult> {
  for (const tree of [input.integratedTreeSha, input.baseTreeSha, input.partTreeSha]) if (!HEX40.test(tree)) throw new Error("a tree to merge is invalid");
  if (input.integratedTreeSha === input.baseTreeSha || input.partTreeSha === input.baseTreeSha || input.partTreeSha === input.integratedTreeSha) {
    return { ok: true, treeSha: input.integratedTreeSha === input.baseTreeSha ? input.partTreeSha : input.integratedTreeSha };
  }
  return inRepository(repositoryDirectory, () => withIsolatedGit(repositoryDirectory, "write", async (git) => {
    try {
      const output = await git.text(["merge-tree", "--write-tree", "--no-messages", `--merge-base=${input.baseTreeSha}`, input.integratedTreeSha, input.partTreeSha], { index: "none" });
      const treeSha = output.split("\n")[0]?.trim() ?? "";
      if (!HEX40.test(treeSha)) throw new Error("the merge did not name a tree");
      return { ok: true as const, treeSha };
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return { ok: false as const };
      throw error;
    }
  }));
}

/**
 * Makes the project repository's files, and its index, hold `toTreeSha` when they hold `fromTreeSha` now: a two-tree `read-tree -m -u`, which removes what `to` lacks and
 * refuses (rather than overwrites) a file that is not as `from` says. Refs and HEAD are not moved; the candidate is committed later, as for any run.
 */
export async function checkoutIntegratedTree(repositoryDirectory: string, fromTreeSha: string, toTreeSha: string): Promise<void> {
  if (!HEX40.test(fromTreeSha) || !HEX40.test(toTreeSha)) throw new Error("a tree to check out is invalid");
  const current = (await readCandidateRepositories([{ repositoryId: "checkout", directory: repositoryDirectory }]))[0]?.treeSha;
  if (current !== fromTreeSha) throw agentXError("OPERATION_INTERRUPTED", "the repository changed while parts were being built, so the merged work was not checked out");
  await inRepository(repositoryDirectory, () => withIsolatedRepository(repositoryDirectory, "write", { index: "persist" }, async (repository) => {
    await repository.text(["read-tree", fromTreeSha], { index: "work" });
    // The index now names `from`'s files without their file stamps; refreshing records them, and fails (so nothing is overwritten) if a file is not as `from` says.
    await repository.text(["update-index", "-q", "--refresh"], { index: "work" });
    await repository.text(["read-tree", "-m", "-u", fromTreeSha, toTreeSha], { index: "work" });
  }));
}
