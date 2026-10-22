// Plan 3, Task 22: a run that looks at a pull request has the pull request's head commit checked out when its workspace is prepared: detached, at exactly the
// commit the run recorded, with the repository's own default branch commit left as the manifest's resolved commit. A head that moved since the run started
// fails the preparation, and a repository the run names no pull request for is prepared as it always was.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { ProjectDefinition } from "@agentx/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";

const run = promisify(execFile);
const git = (directory: string, ...args: string[]) => run("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args]).then((result) => result.stdout.trim());

/** A repository whose default branch is `main`, and whose `refs/pull/12/head` is a commit that is not on it. */
async function repositoryWithPullRequest() {
  const directory = await mkdtemp(join(tmpdir(), "agentx-pr-source-"));
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(join(directory, "README.md"), "main\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "main");
  const main = await git(directory, "rev-parse", "HEAD");
  await git(directory, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(directory, "feature.txt"), "the pull request's change\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "the change");
  const head = await git(directory, "rev-parse", "HEAD");
  await git(directory, "update-ref", "refs/pull/12/head", head);
  await git(directory, "checkout", "--quiet", "main");
  return { directory, main, head };
}

function project(): ProjectDefinition {
  return {
    name: "payments", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "demo-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}

const materializer = (source: string) => async (_repository: unknown, destination: string) => {
  await run("git", ["clone", "--quiet", "--no-checkout", source, destination]);
};

// The fixture repositories are local, which the worker's hardened Git refuses unless a test allows it.
let undoFileTransport: (() => void) | undefined;
beforeAll(() => { undoFileTransport = allowGitFileTransportForTests(); });
afterAll(() => { undoFileTransport?.(); });

describe("preparing a workspace for a run that looks at a pull request", () => {
  it("checks the pull request's head out detached at exactly the recorded commit, and records it beside the default branch's", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 12, headSha: source.head }],
    });
    const repository = join(root, "repo", "demo");
    expect(await git(repository, "rev-parse", "HEAD")).toBe(source.head);
    expect(await readFile(join(repository, "feature.txt"), "utf8")).toBe("the pull request's change\n");
    expect(await git(repository, "symbolic-ref", "-q", "HEAD").catch(() => "detached")).toBe("detached");
    expect(manifest.repositories[0]).toMatchObject({ name: "demo", resolvedCommit: source.main, checkedOut: { pullRequest: 12, headSha: source.head } });
  });

  it("fails the preparation when the pull request's head is not the commit the run recorded", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    await mkdir(root, { recursive: true });
    await expect(prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 12, headSha: "a".repeat(40) }],
    })).rejects.toThrow("pull request 12 has a new commit since the run started");
  });

  it("fails when the pull request does not exist, and never falls back to the default branch", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    await expect(prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 99, headSha: source.head }],
    })).rejects.toThrow();
  });

  it("prepares the repository as it always was when the run names no pull request for it", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "another", pullRequest: 12, headSha: source.head }],
    });
    expect(await git(join(root, "repo", "demo"), "rev-parse", "HEAD")).toBe(source.main);
    expect(manifest.repositories[0]!.checkedOut).toBeUndefined();
  });
});
