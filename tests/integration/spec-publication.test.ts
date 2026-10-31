import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WorkerInvocationSchema, type SpecFile, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { prepareSpecPublicationCommit, publishSpecFiles } from "../../packages/worker/src/spec-publish.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
let disallowFileTransport: () => void = () => undefined;
beforeEach(async () => {
  disallowFileTransport = allowGitFileTransportForTests();
  const home = await mkdtemp(join(tmpdir(), "agentx-git-home-"));
  temporaryDirectories.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});
afterEach(async () => {
  disallowFileTransport();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(directory: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout;
}

const SPEC: SpecFile[] = [
  { path: ".kiro/specs/reset-password/requirements.md", content: "# Requirements Document\n\n- 1.1 WHEN a user asks THE SYSTEM SHALL send a link\n" },
  { path: ".kiro/specs/reset-password/tasks.md", content: "# Implementation Plan\n\n- [ ] 1. Add the route\n" },
];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentx-spec-publish-"));
  temporaryDirectories.push(root);
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "repo", "service-meta");
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await mkdir(join(seed, ".kiro/steering"), { recursive: true });
  await mkdir(join(seed, ".kiro/specs/old-feature"), { recursive: true });
  await writeFile(join(seed, "README.md"), "meta\n", "utf8");
  await writeFile(join(seed, ".kiro/steering/product.md"), "steering\n", "utf8");
  await writeFile(join(seed, ".kiro/specs/old-feature/requirements.md"), "old\n", "utf8");
  await git(seed, ["add", "-A"]);
  await git(seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  await git(seed, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(seed, ["push", "origin", "main"]);
  await mkdir(join(root, "repo"), { recursive: true });
  await git(root, ["clone", "--branch", "main", pathToFileURL(bare).href, checkout]);
  const base = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const remoteUrl = (await git(checkout, ["remote", "get-url", "origin"])).trim();
  const operationId = crypto.randomUUID();
  const project = {
    name: "demo", revision: 1,
    repositories: [{ name: "service-meta", url: remoteUrl, path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate coding work.",
  };
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "demo", projectRevision: 1, environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true,
    meta: { name: "service-meta", path: "repo/service-meta", defaultBranch: "main", resolvedCommit: base, files: 1, bytes: 1, skipped: 0, completedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }), "utf8");
  const invocation = ({
    protocolVersion: 1, kind: "publish", operationId, workspaceId: crypto.randomUUID(), fence: 2, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { mode: "create", project, repository: "service-meta", title: "Spec for reset password", body: "Spec.", headBranch: `agentx/${operationId}`, repositoryGrant: "push-grant", specFiles: SPEC, specBaseCommit: base },
  }) as unknown as Extract<WorkerInvocation, { kind: "publish" }>;
  return { root, bare, checkout, base, invocation };
}

const sink = () => vi.fn(async () => ({ number: 7, url: "https://github.com/example/service-meta/pull/7", reconciled: false }));

describe("spec publication (worker)", () => {
  it("pushes one commit on the pinned meta commit that adds exactly the spec files, and opens the pull request", async () => {
    const fixture = await createFixture();
    const pullRequestSink = sink();
    const result = await publishSpecFiles({ rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}), pullRequestSink });
    expect(result).toMatchObject({ repository: "service-meta", number: 7, headBranch: fixture.invocation.payload.headBranch, baseBranch: "main" });
    expect((await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.invocation.payload.headBranch}`])).trim()).toBe(result.commit);
    expect((await git(fixture.bare, ["rev-parse", `${result.commit}^`])).trim()).toBe(fixture.base);
    const changed = (await git(fixture.bare, ["diff", "--name-status", fixture.base, result.commit])).trim().split("\n");
    expect(changed).toEqual(["A\t.kiro/specs/reset-password/requirements.md", "A\t.kiro/specs/reset-password/tasks.md"]);
    expect(await git(fixture.bare, ["show", `${result.commit}:.kiro/specs/reset-password/requirements.md`])).toBe(SPEC[0]!.content);
    expect(pullRequestSink).toHaveBeenCalledWith(expect.objectContaining({ headBranch: fixture.invocation.payload.headBranch, baseBranch: "main", commit: result.commit }));
    // The default branch is untouched.
    expect((await git(fixture.bare, ["rev-parse", "refs/heads/main"])).trim()).toBe(fixture.base);
  });

  it("builds the commit from the invocation, not from the workspace's files", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.checkout, ".kiro/specs/reset-password"), { recursive: true });
    await writeFile(join(fixture.checkout, ".kiro/specs/reset-password/requirements.md"), "PLANTED BY THE BUILDER\n", "utf8");
    await writeFile(join(fixture.checkout, "EVIL.md"), "evil\n", "utf8");
    const result = await publishSpecFiles({ rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}), pullRequestSink: sink() });
    expect(await git(fixture.bare, ["show", `${result.commit}:.kiro/specs/reset-password/requirements.md`])).toBe(SPEC[0]!.content);
    await expect(git(fixture.bare, ["cat-file", "-e", `${result.commit}:EVIL.md`])).rejects.toThrow();
  });

  it("refuses a path that is already in the base, or sits where a base file is, before any credential or push", async () => {
    const fixture = await createFixture();
    const credentialProvider = vi.fn(async () => ({}));
    const pullRequestSink = sink();
    for (const path of [".kiro/specs/old-feature/requirements.md", "README.md/x.md", ".kiro/steering/product.md"]) {
      const invocation = { ...fixture.invocation, payload: { ...fixture.invocation.payload, specFiles: [{ path, content: "x\n" }] } } as typeof fixture.invocation;
      await expect(publishSpecFiles({ rootPath: fixture.root, invocation, credentialProvider, pullRequestSink })).rejects.toThrow(/already has a file|file where a spec folder/u);
    }
    expect(credentialProvider).not.toHaveBeenCalled();
    expect(pullRequestSink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${fixture.invocation.payload.headBranch}`])).rejects.toThrow();
  });

  it("refuses a base other than the commit the workspace was prepared at, a missing meta repo, and another repository", async () => {
    const fixture = await createFixture();
    const run = (payload: Record<string, unknown>) => publishSpecFiles({ rootPath: fixture.root, invocation: { ...fixture.invocation, payload: { ...fixture.invocation.payload, ...payload } }, credentialProvider: async () => ({}), pullRequestSink: sink() });
    await expect(run({ specBaseCommit: "b".repeat(40) })).rejects.toThrow(/prepared at/u);
    await expect(run({ repository: "other", project: { ...fixture.invocation.payload.project, repositories: [{ ...fixture.invocation.payload.project.repositories[0]!, name: "other", path: "repo/other" }] } })).rejects.toThrow(/no prepared meta repository/u);
  });

  it("refuses unsafe paths and an oversized set at the worker too", async () => {
    const fixture = await createFixture();
    for (const files of [[{ path: "../x.md", content: "x" }], [{ path: ".git/hooks/pre-push", content: "x" }], [{ path: "a/b.md", content: "x" }, { path: "a/b.md", content: "y" }], Array.from({ length: 5 }, (_, index) => ({ path: `big/${String(index)}.md`, content: "x".repeat(60 * 1024) }))]) {
      await expect(prepareSpecPublicationCommit({ directory: fixture.checkout, baseCommit: fixture.base, headBranch: fixture.invocation.payload.headBranch, title: "t", files })).rejects.toThrow(/not allowed|larger than/u);
    }
  });

  it("is a protocol feature: the worker lists it, and the invocation schema requires the files and their base together and nothing else", () => {
    expect(WORKER_IMPLEMENTED_FEATURES).toEqual(expect.arrayContaining(["task.specWrite.v1", "publish.specFiles.v1"]));
    const base = { protocolVersion: 1, kind: "publish", operationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const project = { name: "demo", revision: 1, repositories: [{ name: "m", url: "https://github.com/e/m", path: "repo/m", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    const payload = { mode: "create", project, repository: "m", title: "t", headBranch: `agentx/${crypto.randomUUID()}`, repositoryGrant: "g" };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, specFiles: SPEC } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, specBaseCommit: "a".repeat(40) } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, specFiles: SPEC, specBaseCommit: "a".repeat(40) } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, specFiles: SPEC, specBaseCommit: "a".repeat(40), mode: "replace", targetPullRequestNumber: 3 } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, specFiles: SPEC, specBaseCommit: "a".repeat(40), reportChecks: true } }).success).toBe(false);
  });
});
