// K1 lane D, D2: the worker's half of "the spec is published to the meta repository". It uses the same publication steps as a code publication: the workspace is contained (nothing the task started is left running)
// before the push credential is fetched, the commit is pushed by its id to the registered URL from a throwaway repository, and the pull request is opened through the broker's callback, which checks it against GitHub.
//
// What is different: the commit is built from the files in the invocation, on the broker's `specBaseCommit` (the task's `knowledgeCommit`), and nothing is taken from the workspace's files. No check runs. A file
// that already exists at its path in the base is refused: a spec is a new folder, never an edit of another spec.
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentXError, PullRequestResultSchema, agentXError, specPathProblem, type PullRequestResult, type SpecFile } from "@agentx/contracts";
import { AGENTX_GIT_EMAIL, AGENTX_GIT_NAME } from "./git.js";
import { assertCredentialFreeRemote, pushCommitFromIsolatedRepository } from "./git-auth.js";
import { candidateLayout } from "./isolated-git.js";
import { runIsolatedGit } from "./isolated-repository.js";
import { assertContained, containWorkspace, containedPath, loadCompleteManifest, repositoryGit, sanitizeGitError, type PublishWorkspaceOptions } from "./publish.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
import { sweepWorkspaceContainers } from "./workspace-containers.js";

const MAX_GIT_OUTPUT = 1_048_576;
const TOTAL_SPEC_BYTES_MAX = 256 * 1024;

/** `data <length>` blocks for git fast-import: exact byte lengths, so no content can end a block early. */
function dataBlock(text: string | Buffer): Buffer {
  const body = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  return Buffer.concat([Buffer.from(`data ${String(body.byteLength)}\n`), body, Buffer.from("\n")]);
}

/**
 * One commit on `baseCommit` that adds `files`, on the ref `refs/heads/<headBranch>`, made without touching the workspace's files or index (git fast-import). Returns its id. Refuses a path that is
 * not a safe relative path, a path that is already in the base, and a set of files over the total bound.
 */
export async function prepareSpecPublicationCommit(input: {
  directory: string;
  baseCommit: string;
  headBranch: string;
  title: string;
  files: readonly SpecFile[];
}): Promise<string> {
  const git = repositoryGit(input.directory);
  await git(["cat-file", "-e", `${input.baseCommit}^{commit}`]).catch(() => {
    throw agentXError("WORKSPACE_NOT_READY", "the meta repository's commit is missing from the workspace");
  });
  let total = 0;
  const seen = new Set<string>();
  for (const file of input.files) {
    if (specPathProblem(file.path) !== undefined || seen.has(file.path)) throw agentXError("CONFIG_INVALID", "a spec file path is not allowed");
    seen.add(file.path);
    total += Buffer.byteLength(file.content, "utf8");
    // Present in the base: either a file at this path, or a file where one of its folders would go. A spec adds a new folder; it never replaces anything.
    const parts = file.path.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      const present = await git(["cat-file", "-e", `${input.baseCommit}:${prefix}`]).then(() => true, () => false);
      if (present && depth === parts.length) throw agentXError("CONFIG_INVALID", "the meta repository already has a file at a spec path");
      if (present && depth < parts.length) {
        const type = (await git(["cat-file", "-t", `${input.baseCommit}:${prefix}`]).catch(() => "")).trim();
        if (type !== "tree") throw agentXError("CONFIG_INVALID", "the meta repository has a file where a spec folder goes");
      }
    }
  }
  if (total > TOTAL_SPEC_BYTES_MAX) throw agentXError("CONFIG_INVALID", "the spec is larger than the publication allows");
  const message = `AgentX: ${input.title}`.replace(/[\r\n]+/gu, " ").slice(0, 200);
  const when = Math.floor(Date.now() / 1000);
  const identity = `${AGENTX_GIT_NAME} <${AGENTX_GIT_EMAIL}> ${String(when)} +0000`;
  const stream = Buffer.concat([
    Buffer.from(`commit refs/heads/${input.headBranch}\ncommitter ${identity}\n`),
    dataBlock(message),
    Buffer.from(`from ${input.baseCommit}\n`),
    ...input.files.flatMap((file) => [Buffer.from(`M 100644 inline ${file.path}\n`), dataBlock(file.content)]),
    Buffer.from("done\n"),
  ]);
  try {
    await runIsolatedGit(input.directory, ["fast-import", "--quiet", "--done", "--date-format=raw"], { input: stream, timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT, index: "none", mode: "write", refs: true });
  } catch (error) {
    throw agentXError("CONFIG_INVALID", sanitizeGitError(error instanceof Error ? error.message : "Git could not write the spec commit"));
  }
  return (await git(["rev-parse", `refs/heads/${input.headBranch}`])).trim();
}

/** Publishes the invocation's spec files to the meta repository as one new branch and one pull request. */
export async function publishSpecFiles(options: PublishWorkspaceOptions): Promise<PullRequestResult> {
  const { invocation } = options;
  const { specFiles, specBaseCommit } = invocation.payload;
  if (specFiles === undefined || specBaseCommit === undefined) throw agentXError("CONFIG_INVALID", "the spec files are missing");
  const rootPath = await realpath(resolve(options.rootPath));
  const manifest = await loadCompleteManifest(rootPath, invocation);
  const repository = invocation.payload.project.repositories.find((candidate) => candidate.name === invocation.payload.repository);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  // The meta repository is the one the preparation recorded, at the commit the broker pinned for the task.
  const meta = manifest.meta;
  if (meta === undefined || meta.name !== repository.name || meta.path !== repository.path) throw agentXError("WORKSPACE_NOT_READY", "the workspace has no prepared meta repository by that name");
  if (meta.resolvedCommit !== specBaseCommit) throw agentXError("CONFIG_INVALID", "the spec is not based on the commit the workspace was prepared at");
  const repositoryPath = containedPath(rootPath, repository.path);
  const metadata = await stat(repositoryPath).catch(() => undefined);
  if (!metadata?.isDirectory()) throw agentXError("WORKSPACE_NOT_READY", "prepared repository checkout is missing");
  assertContained(rootPath, await realpath(repositoryPath));
  const git = repositoryGit(repositoryPath);
  const remoteUrl = (await git(["remote", "get-url", "origin"])).trim();
  assertCredentialFreeRemote(remoteUrl);
  if (remoteUrl !== repository.url) throw agentXError("CONFIG_INVALID", "repository remote does not match the registered project");

  const commit = await prepareSpecPublicationCommit({ directory: repositoryPath, baseCommit: specBaseCommit, headBranch: invocation.payload.headBranch, title: invocation.payload.title, files: specFiles });
  const objectsDirectory = (await candidateLayout(repositoryPath)).objects;
  // The push credential is fetched only once nothing the task started is left running (as for a code publication).
  await containWorkspace(rootPath, {
    sweep: options.sweepWorkspaceContainers ?? ((root: string) => sweepWorkspaceContainers({ rootPath: root })),
    stop: options.stopWorkspaceProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })),
    ...(options.otherOperationActive === undefined ? {} : { otherOperationActive: options.otherOperationActive }),
    ...(options.otherOperationWait === undefined ? {} : { otherOperationWait: options.otherOperationWait }),
  });
  const credential = await options.credentialProvider(repository);
  try {
    await pushCommitFromIsolatedRepository({
      objectsDirectory, url: repository.url, commit, branch: invocation.payload.headBranch, credential, timeout: 300_000, maxBuffer: MAX_GIT_OUTPUT,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(error instanceof Error ? error.message : "Git push failed"));
  }
  const pullRequest = await options.pullRequestSink({
    repository: repository.name, repositoryUrl: repository.url, headBranch: invocation.payload.headBranch, baseBranch: repository.defaultBranch, commit,
    title: invocation.payload.title, ...(invocation.payload.body === undefined ? {} : { body: invocation.payload.body }),
  });
  return PullRequestResultSchema.parse({
    repository: repository.name, number: pullRequest.number, url: pullRequest.url, headBranch: invocation.payload.headBranch, baseBranch: repository.defaultBranch,
    commit, checks: [], codeBuildChecks: [], reconciled: pullRequest.reconciled, ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }),
  });
}
