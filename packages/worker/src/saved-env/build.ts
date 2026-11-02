// Setup and test health SH22 (design setup-test-health.md, sections 5.1, 5.4 and 12): build and push the saved image of a project.
//
// The ONE entry point is `proveAndBuildSavedImage`. It makes its own fresh sandbox, runs the Prove sequence there, and builds from THAT sandbox's workspace, before the sandbox is removed. There is no function that
// takes a workspace and builds it, so an image cannot come from a task's workspace or from the setup agent's. Everything below is a precondition of the build, checked in this order, and each failure is a
// fixed word (contracts `SAVED_ENV_BUILD_FAILURES`) with no output and no value in it:
//   1. the environment is the APPROVED one: its digest is the broker's approved digest (`not_approved`);
//   2. the sandbox is new: it shares no id and no workspace with any workspace named in `notFrom` (`not_fresh`);
//   3. BEFORE the Prove run, each repository's `.git` is copied out of the sandbox's reach (the "trusted" copy, the worker's own clone). It must hold none of `REFUSED_GIT_ENTRIES` (alternates, grafts, replace
//      refs, modules, worktrees), its HEAD and `refs/remotes/origin/<default branch>` must be the commit the broker named, no index entry may carry a flag (assume-unchanged, skip-worktree), and its origin URL
//      must hold no credential (`not_default_branch`, `unsafe_tree`): ED-1, an image holds reviewed code only;
//   4. the Prove run passed for that digest (`not_proved`; a Prove that could not run is `prove_failed`);
//   5. every process of the sandbox is stopped, keeping only its workspace (`unsafe_tree`): what is checked next cannot change while it is checked;
//   6. the work tree is STAGED without its live `.git`; the trusted `.git` is installed beside it with a generated config (the origin URL only) and no hooks; the index is rebuilt from HEAD;
//   7. every tracked file of the trusted HEAD tree equals its staged file byte for byte, in the right kind and mode, with no symbolic link on the way (`not_default_branch`);
//   8. the environment key is worked out from the STAGED copy (SH21), or the build stops (`unsafe_tree`);
//   9. the staged tree holds no secret, no link that is absolute or leaves the seed, no device file, and is within the limits (`secrets_found`, `unsafe_tree`; see secret-scan.ts);
//  10. only then is an image built, with no network and nothing run in it, in a THROWAWAY builder that is removed afterwards (its cache goes with it): `FROM scratch`, a `COPY` of the seed and the manifest,
//      labels. No `RUN`, `ENV`, `ARG` or `ADD`;
//  11. a push login for THAT repository is fetched from the broker (short-lived, one repository), written to a throwaway Docker config, and used for the push alone;
//  12. the digest comes from the registry's own answer, and its repository must be the one the login was for (`digest_mismatch`).
// The login, the config, the staged copy, the trusted copy, the builder and the local images are removed whatever happens. The worker's instance role is not used for any of this and has no grant on these
// repositories.
//
// RULES FOR THE CALLER (SH24/SH25; the broker and the run wiring enforce them, this file cannot):
//   - `notFrom` comes from the worker's own live lease and sandbox registry, never from the job payload;
//   - `makeFresh` does the worker's OWN clone of the default branch (never a copy of an existing workspace);
//   - when the result is recorded, the broker compares `manifest.commits` with the code host's default branch heads;
//   - the push route belongs to the rebuild job's lease only.
//
// Nothing here runs the image, and nothing runs a command of the project outside the fresh sandbox's ports.
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ImageDigestSchema,
  SAVED_ENV_IMAGE_MANIFEST_PATH,
  SAVED_ENV_IMAGE_SEED_PATH,
  SAVED_ENV_LABEL_KEY,
  SAVED_ENV_LABEL_PROVE,
  SAVED_ENV_LABEL_REVISION,
  SavedEnvImageManifestSchema,
  SavedEnvManifestSchema,
  SavedEnvRegistryAuthSchema,
  TestEnvironmentBodySchema,
  canonicalJson,
  isSavedEnvRepositoryName,
  testEnvDigest,
  testEnvIsProved,
  type SavedEnvBuildFailure,
  type SavedEnvBuildResult,
  type SavedEnvImageManifest,
  type SavedEnvRegistryAuth,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import { proveEnvironment } from "../prove.js";
import { defaultRealPath, sharesWorkspace, type FreshSandbox } from "../setup-agent-prove.js";
import { runIsolatedGit } from "../isolated-repository.js";
import type { DockerCli } from "../swebench/containers.js";
import { environmentKeyFromRepositories, hashWorkspaceFile, type KeyRepository } from "./key.js";
import { compareTrackedFiles, minimalGitConfig, originUrlIsSafe, originUrlOf, parseLsTree, readGitConfig, unsafeGitEntries, type TreeEntry } from "./tree-check.js";
import { scanTreeForSecrets, type SecretScanResult } from "./secret-scan.js";

const BUILD_TIMEOUT_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 45 * 60_000;
const DOCKER_QUICK_MS = 2 * 60_000;
const MAX_REPOSITORIES = 16;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const SHA = /^[a-f0-9]{40}$/u;
/** The checkout's folder under the workspace root: one to four plain segments (the project's repository path), never `..`, never absolute. */
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/u;

export interface BuildRepository {
  /** The project's id for the repository (the test environment's `repositoryId`). */
  repositoryId: string;
  /** The checkout's folder name under the workspace root. */
  directory: string;
  defaultBranch: string;
  /** The commit the workspace was prepared at (the default branch head at that time). */
  commit: string;
}

export interface GitState {
  head: string;
  /** What `refs/remotes/origin/<default branch>` points at, or undefined when the ref is missing. */
  originHead: string | undefined;
  /** How many index entries carry a flag other than "H" in `git ls-files -v` (assume-unchanged, skip-worktree, ...): a flag can hide a changed file. */
  nonStandardFlags: number;
}

/** A fresh sandbox that can also be stopped: every process in it ends and only its workspace stays. */
export interface BuildSandbox extends FreshSandbox {
  /** Stops every process of the sandbox (and any container it started), keeping only its workspace. Throws when it cannot be sure. */
  stopProcesses(): Promise<void>;
}

export type { TreeEntry };

export interface SavedEnvBuildPorts {
  docker: DockerCli;
  /** A new sandbox on a new workspace holding the worker's OWN clone of each repository's default branch. Removed by this module. */
  makeFresh(): Promise<BuildSandbox>;
  /** Copies `<repositoryDirectory>/.git` to `<destination>/.git` (a real directory only: a link or a file is refused), links kept as links. */
  snapshotGit(repositoryDirectory: string, destination: string): Promise<void>;
  /** Reads HEAD, the origin ref and the index flags of the repository whose `.git` is in `repositoryDirectory`. */
  gitState(repositoryDirectory: string, defaultBranch: string): Promise<GitState>;
  /** Rebuilds the index from HEAD (`read-tree HEAD`, then refresh). */
  rebuildIndex(repositoryDirectory: string): Promise<void>;
  /** The tracked files of HEAD (`ls-tree -r`). */
  trackedTree(repositoryDirectory: string): Promise<TreeEntry[]>;
  /** Copies the work tree `source` to `destination` WITHOUT its top-level `.git`: links as links (never followed), sockets and pipes left out, nothing under a nested `.git/hooks`. Throws on a device file. */
  stage(source: string, destination: string): Promise<void>;
  /** Copies the trusted `.git` into `<destination>/.git` without hooks, index or config, and writes `config` as its config. */
  installGit(trustedRepositoryDirectory: string, destination: string, config: string): Promise<void>;
  /** `budgetMs` is how long the scan may take (the scan reads its own clock). */
  scan(root: string, options: { forbiddenValues: readonly string[]; budgetMs: number }): Promise<SecretScanResult>;
  /** The broker's push login for this repository: short-lived, one repository. Undefined when the broker refused. */
  pushSession(request: { repository: string }): Promise<SavedEnvRegistryAuth | undefined>;
  /** A new private folder; `remove` deletes it with everything in it. */
  temporaryFolder(): Promise<{ path: string; remove(): Promise<void> }>;
  now(): number;
  /** A fresh random suffix for the immutable tag and the builder's name. */
  random(): string;
}

export interface SavedEnvBuildInput {
  /** The repository the broker derived for this org and project (`savedEnvRepositoryName`); the push login must be for exactly this one. */
  repository: string;
  environment: TestEnvironmentBody;
  /** The broker's approved revision and digest. The environment must be exactly that. */
  approved: { revision: number; digest: string };
  repositories: readonly BuildRepository[];
  /** `Detection.fullSuiteOn` values for the key (SH21). */
  detectorGlobs: readonly string[];
  /** The NAMES of the project's secrets; never values. */
  secretNames: readonly string[];
  /** The base image (the worker image or the dev container image) by digest. It is in the key and the manifest; the image itself holds no base. */
  baseImageDigest: string;
  /** Workspaces the fresh sandbox must not share: every task's workspace and the setup agent's. */
  notFrom: ReadonlyArray<{ id: string; rootPath: string }>;
  /** Exact secret values this machine holds (the clone credentials, a model key, the values of credential-shaped environment variables): none may be in the image. */
  forbiddenValues: readonly string[];
  signal: AbortSignal;
  /** The most the Prove run may take, in milliseconds. */
  proveDeadlineMs: number;
  /** The most the scan may take. */
  scanDeadlineMs?: number;
  /** The BuildKit image of the throwaway builder, by digest (`repository@sha256:...`); the install's mirror of `moby/buildkit`. Absent: the builder driver's default. */
  builderImage?: string;
}

const fail = (reason: SavedEnvBuildFailure, step?: string): SavedEnvBuildResult => ({ ok: false, reason, ...(step === undefined ? {} : { step }) });

/** The Dockerfile. Fixed text with three validated values; no `RUN`, `ENV`, `ARG`, `ADD`, `FROM` of anything but `scratch`. Exported for the test that pins exactly this. */
export function savedEnvDockerfile(label: { key: string; revision: number; proveReportDigest: string }): string {
  if (!/^[a-f0-9]{64}$/u.test(label.key) || !/^[a-f0-9]{64}$/u.test(label.proveReportDigest) || !Number.isInteger(label.revision) || label.revision < 1) throw new RangeError("not a valid label value");
  return [
    "FROM scratch",
    `COPY --chown=1000:1000 seed ${SAVED_ENV_IMAGE_SEED_PATH}`,
    `COPY --chown=0:0 manifest.json ${SAVED_ENV_IMAGE_MANIFEST_PATH}`,
    `LABEL ${SAVED_ENV_LABEL_KEY}="${label.key}" ${SAVED_ENV_LABEL_REVISION}="${String(label.revision)}" ${SAVED_ENV_LABEL_PROVE}="${label.proveReportDigest}"`,
    "",
  ].join("\n");
}

/** The tag of one build: unique (tags are immutable), no org or project in it. */
export function savedEnvTag(key: string, nowMs: number, random: string): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return `k${key.slice(0, 16)}-${stamp}-${random.replace(/[^a-f0-9]/gu, "").slice(0, 8).padEnd(8, "0")}`;
}

function validRepositories(repositories: readonly BuildRepository[]): boolean {
  return repositories.length >= 1 && repositories.length <= MAX_REPOSITORIES
    && new Set(repositories.map((repository) => repository.directory)).size === repositories.length
    && new Set(repositories.map((repository) => repository.repositoryId)).size === repositories.length
    && repositories.every((repository) => SAFE_DIRECTORY.test(repository.directory) && BRANCH_NAME.test(repository.defaultBranch) && SHA.test(repository.commit) && repository.repositoryId.length > 0 && repository.repositoryId.length <= 200);
}

const BUILDER_IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/u;

/**
 * Proves the approved environment in a fresh sandbox and, if it passes and the checkout is the default branch head, builds and pushes the saved image from that sandbox. See the top of the file.
 * Resolves (never rejects) with the image digest and manifest, or one fixed failure word.
 */
export async function proveAndBuildSavedImage(input: SavedEnvBuildInput, ports: SavedEnvBuildPorts): Promise<SavedEnvBuildResult> {
  // 1. The approved environment.
  const parsedEnvironment = TestEnvironmentBodySchema.safeParse(input.environment);
  if (!parsedEnvironment.success || !isSavedEnvRepositoryName(input.repository) || !validRepositories(input.repositories) || !Number.isInteger(input.approved.revision) || input.approved.revision < 1) return fail("not_approved", "input");
  const digest = testEnvDigest(parsedEnvironment.data);
  if (digest !== input.approved.digest) return fail("not_approved");
  if (!ImageDigestSchema.safeParse(input.baseImageDigest).success) return fail("base_not_pinned");
  if (input.builderImage !== undefined && !BUILDER_IMAGE.test(input.builderImage)) return fail("base_not_pinned", "builder");

  type Folder = Awaited<ReturnType<SavedEnvBuildPorts["temporaryFolder"]>>;
  let fresh: BuildSandbox | undefined;
  let trusted: Folder | undefined;
  let staged: Folder | undefined;
  let docker: Folder | undefined;
  let builder: string | undefined;
  const localTags: string[] = [];
  try {
    // 2. A fresh sandbox.
    try { fresh = await ports.makeFresh(); } catch { return fail("fresh_sandbox_failed"); }
    for (const other of input.notFrom) {
      if (fresh.id === other.id || await sharesWorkspace(fresh.rootPath, other.rootPath, defaultRealPath)) return fail("not_fresh");
    }

    // 3. The clone's `.git`, out of the sandbox's reach, BEFORE anything of the project runs.
    trusted = await ports.temporaryFolder();
    const configs = new Map<string, string>();
    for (const repository of input.repositories) {
      const copy = path.join(trusted.path, repository.directory);
      try {
        await ports.snapshotGit(path.join(fresh.rootPath, repository.directory), copy);
        if ((await unsafeGitEntries(path.join(copy, ".git"))).length > 0) return fail("unsafe_tree", "git");
        const state = await ports.gitState(copy, repository.defaultBranch);
        if (state.head !== repository.commit || state.originHead !== repository.commit || state.nonStandardFlags > 0) return fail("not_default_branch");
        const origin = originUrlOf((await readGitConfig(copy)) ?? "");
        if (origin === undefined || !originUrlIsSafe(origin)) return fail("unsafe_tree", "origin");
        configs.set(repository.directory, minimalGitConfig(origin));
      } catch { return fail("not_default_branch", "git"); }
    }

    // 4. The Prove run, in that sandbox, for that digest.
    let report;
    try { report = await proveEnvironment(fresh.ports, { proposalDigest: digest, environment: parsedEnvironment.data, signal: input.signal, deadlineMs: input.proveDeadlineMs }); } catch { return fail("prove_failed"); }
    if (!testEnvIsProved(report, digest)) return fail("not_proved");
    const proveReportDigest = createHash("sha256").update(canonicalJson(report)).digest("hex");

    // 5. Nothing of the sandbox runs from here on: what is checked next cannot change while it is checked.
    try { await fresh.stopProcesses(); } catch { return fail("unsafe_tree", "stop"); }

    // 6. Stage the work tree without its live `.git`, install the trusted one.
    staged = await ports.temporaryFolder();
    const seedRoot = path.join(staged.path, "seed");
    await mkdir(seedRoot, { recursive: true });
    const keyRepositories: KeyRepository[] = [];
    for (const repository of input.repositories) {
      const target = path.join(seedRoot, repository.directory);
      try {
        await ports.stage(path.join(fresh.rootPath, repository.directory), target);
        await ports.installGit(path.join(trusted.path, repository.directory), target, configs.get(repository.directory)!);
        await ports.rebuildIndex(target);
      } catch { return fail("unsafe_tree", "stage"); }
      // The staged `.git` is the trusted one: it must still be clean of the refused entries and say the same thing.
      if ((await unsafeGitEntries(path.join(target, ".git"))).length > 0) return fail("unsafe_tree", "git");
      let entries: TreeEntry[];
      try {
        const state = await ports.gitState(target, repository.defaultBranch);
        if (state.head !== repository.commit || state.originHead !== repository.commit || state.nonStandardFlags > 0) return fail("not_default_branch");
        entries = await ports.trackedTree(target);
      } catch { return fail("not_default_branch", "git"); }
      // 7. Every tracked file equals the committed one.
      const compared = await compareTrackedFiles(entries, target);
      if (!compared.ok) return fail("not_default_branch", `tracked:${compared.reason}`);
      keyRepositories.push({
        repositoryId: repository.repositoryId,
        paths: entries.map((entry) => entry.path),
        // Only a regular file inside the staged copy (the same test the key's hash uses), and a small one: a dev container file.
        readText: async (file) => { try { return (await hashWorkspaceFile(target, file)) === undefined ? undefined : (await readFile(path.join(target, file), "utf8")).slice(0, 1_048_576); } catch { return undefined; } },
        hashFile: (file) => hashWorkspaceFile(target, file),
      });
    }

    // 8. The environment key, from the staged copy.
    const key = await environmentKeyFromRepositories({ repositories: keyRepositories, detectorGlobs: input.detectorGlobs, testEnvRevision: input.approved.revision, secretNames: input.secretNames, baseImageDigest: input.baseImageDigest });
    if (!key.ok) return fail("unsafe_tree", "key");

    // 9. Scan the staged seed.
    const scanned = await ports.scan(seedRoot, { forbiddenValues: input.forbiddenValues, budgetMs: input.scanDeadlineMs ?? 20 * 60_000 });
    if (!scanned.ok) return scanned.reason === "found" ? fail("secrets_found") : fail("unsafe_tree", "scan");

    // The manifest inside the image has no digest (an image cannot hold its own).
    const builtAt = new Date(ports.now()).toISOString();
    const imageManifest: SavedEnvImageManifest = SavedEnvImageManifestSchema.parse({
      schemaVersion: 1, environmentKey: key.key, testEnvRevision: input.approved.revision,
      commits: input.repositories.map((repository) => ({ repositoryId: repository.repositoryId, sha: repository.commit })),
      proveReportDigest, builtAt,
    });
    await writeFile(path.join(staged.path, "manifest.json"), `${JSON.stringify(imageManifest)}\n`, { mode: 0o644 });
    await writeFile(path.join(staged.path, "Dockerfile"), savedEnvDockerfile({ key: key.key, revision: input.approved.revision, proveReportDigest }), { mode: 0o644 });

    // 10. Build, in a throwaway builder: no network, nothing run in it, no cache kept (the builder and its state are removed in `finally`).
    const local = `rovara-saved-env-build:${randomBytes(8).toString("hex")}`;
    localTags.push(local);
    const name = `rovara-build-${ports.random().replace(/[^a-f0-9]/gu, "").slice(0, 16).padEnd(16, "0")}`;
    const created = await ports.docker.run(["buildx", "create", "--name", name, "--driver", "docker-container", ...(input.builderImage === undefined ? [] : ["--driver-opt", `image=${input.builderImage}`]), "--bootstrap"], { timeoutMs: DOCKER_QUICK_MS * 5, signal: input.signal });
    builder = name;
    if (created.exitCode !== 0) return fail("build_failed", "builder");
    const built = await ports.docker.run(["buildx", "build", "--builder", name, "--network", "none", "--pull=false", "--provenance=false", "--no-cache", "--load", "--tag", local, "--file", path.join(staged.path, "Dockerfile"), staged.path], { timeoutMs: BUILD_TIMEOUT_MS, signal: input.signal });
    if (built.exitCode !== 0) return fail("build_failed");

    // The seed is in the image; the sandbox and the staged copy are no longer needed, and the scan's disk is returned before the push.
    await rm(staged.path, { recursive: true, force: true }).catch(() => undefined);

    // 11. The push login, for this repository, used for the push alone.
    const login = await ports.pushSession({ repository: input.repository }).catch(() => undefined);
    const auth = SavedEnvRegistryAuthSchema.safeParse(login);
    if (!auth.success || auth.data.repository !== input.repository || Date.parse(auth.data.expiresAt) <= ports.now() + 60_000) return fail("no_push_session");
    docker = await ports.temporaryFolder();
    await writeFile(path.join(docker.path, "config.json"), JSON.stringify({ auths: { [auth.data.registry]: { auth: Buffer.from(`${auth.data.username}:${auth.data.password}`).toString("base64") } } }), { mode: 0o600 });
    const tag = savedEnvTag(key.key, ports.now(), ports.random());
    const remote = `${auth.data.registry}/${input.repository}:${tag}`;
    localTags.push(remote);
    const tagged = await ports.docker.run(["tag", local, remote], { timeoutMs: DOCKER_QUICK_MS });
    if (tagged.exitCode !== 0) return fail("push_failed", "tag");
    const pushed = await ports.docker.run(["--config", docker.path, "push", remote], { timeoutMs: PUSH_TIMEOUT_MS, signal: input.signal });
    if (pushed.exitCode !== 0) return fail("push_failed");

    // 12. The digest, from the registry's answer, and its repository must be the one the login was for.
    const inspected = await ports.docker.run(["image", "inspect", "--format", "{{json .RepoDigests}}", remote], { timeoutMs: DOCKER_QUICK_MS });
    if (inspected.exitCode !== 0) return fail("digest_mismatch", "inspect");
    const expectedPrefix = `${auth.data.registry}/${input.repository}@`;
    let digests: unknown;
    try { digests = JSON.parse(inspected.stdout.trim() || "[]"); } catch { return fail("digest_mismatch", "inspect"); }
    const matching = (Array.isArray(digests) ? digests : []).filter((value): value is string => typeof value === "string" && value.startsWith(expectedPrefix));
    const imageDigest = matching.length === 1 ? ImageDigestSchema.safeParse(matching[0]!.slice(expectedPrefix.length)) : undefined;
    if (imageDigest === undefined || !imageDigest.success) return fail("digest_mismatch");

    const manifest = SavedEnvManifestSchema.parse({ ...imageManifest, imageDigest: imageDigest.data });
    return { ok: true, repository: input.repository, tag, imageDigest: imageDigest.data, manifest };
  } catch {
    return fail("build_failed", "unexpected");
  } finally {
    // Whatever happened: the login, the staged and trusted copies, the builder and its cache, the local images and the sandbox go.
    await docker?.remove().catch(() => undefined);
    await staged?.remove().catch(() => undefined);
    await trusted?.remove().catch(() => undefined);
    if (builder !== undefined) await ports.docker.run(["buildx", "rm", "--force", builder], { timeoutMs: DOCKER_QUICK_MS }).catch(() => undefined);
    for (const tag of localTags) await ports.docker.run(["rmi", "--force", tag], { timeoutMs: DOCKER_QUICK_MS }).catch(() => undefined);
    await fresh?.dispose().catch(() => undefined);
  }
}

// ---- the real ports

/** `cp` with links kept as links, sockets and pipes left out, device files refused, no top-level `.git` (the trusted one is installed instead), and nothing under a nested `.git/hooks`. */
export async function stageTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, dereference: false, preserveTimestamps: false,
    filter: async (from) => {
      const relative = path.relative(source, from).split(path.sep).join("/");
      if (relative === ".git" || relative.startsWith(".git/")) return false;
      if (/(?:^|\/)\.git\/hooks(?:\/|$)/u.test(relative)) return false;
      const info = await lstat(from);
      if (info.isSymbolicLink() || info.isFile() || info.isDirectory()) return true;
      if (info.isSocket() || info.isFIFO()) return false;
      throw new Error("a device file cannot be saved");
    },
  });
}

/** Copies `<repositoryDirectory>/.git` to `<destination>/.git`. A `.git` that is not a plain directory (a link, or a file pointing elsewhere) is refused. */
export async function snapshotGitOf(repositoryDirectory: string, destination: string): Promise<void> {
  const source = path.join(repositoryDirectory, ".git");
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(".git is not a plain directory");
  await mkdir(destination, { recursive: true });
  await cp(source, path.join(destination, ".git"), { recursive: true, verbatimSymlinks: true, dereference: false, force: false, errorOnExist: true });
}

/** Installs the trusted `.git` into the staged repository: no hooks, no index (rebuilt), no config but the generated one. */
export async function installGitInto(trustedRepositoryDirectory: string, destination: string, config: string): Promise<void> {
  const target = path.join(destination, ".git");
  await cp(path.join(trustedRepositoryDirectory, ".git"), target, {
    recursive: true, verbatimSymlinks: true, dereference: false, force: false, errorOnExist: true,
    filter: (from) => {
      const relative = path.relative(path.join(trustedRepositoryDirectory, ".git"), from).split(path.sep).join("/");
      return relative !== "hooks" && !relative.startsWith("hooks/") && relative !== "index" && relative !== "config";
    },
  });
  await writeFile(path.join(target, "config"), config, { mode: 0o644 });
}

export async function gitStateOf(repositoryDirectory: string, defaultBranch: string): Promise<GitState> {
  if (!BRANCH_NAME.test(defaultBranch)) throw new RangeError("not a branch name");
  const one = async (args: string[]) => (await runIsolatedGit(repositoryDirectory, args, { timeout: 120_000 })).trim();
  const head = await one(["rev-parse", "HEAD"]);
  const originHead = await one(["rev-parse", "--verify", "-q", `refs/remotes/origin/${defaultBranch}`]).catch(() => undefined);
  const flags = await runIsolatedGit(repositoryDirectory, ["ls-files", "-v", "-z"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const nonStandardFlags = flags.split("\u0000").filter((record) => record !== "" && !record.startsWith("H ")).length;
  return { head, originHead: originHead === undefined || originHead === "" ? undefined : originHead, nonStandardFlags };
}

export async function rebuildIndexOf(repositoryDirectory: string): Promise<void> {
  await runIsolatedGit(repositoryDirectory, ["read-tree", "HEAD"], { timeout: 300_000, index: "persist", mode: "write" });
  await runIsolatedGit(repositoryDirectory, ["update-index", "-q", "--refresh"], { timeout: 600_000, index: "persist", mode: "write" }).catch(() => undefined);
}

export async function trackedTreeOf(repositoryDirectory: string): Promise<TreeEntry[]> {
  return parseLsTree(await runIsolatedGit(repositoryDirectory, ["ls-tree", "-r", "-z", "HEAD"], { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }));
}

export async function temporaryFolderIn(parent: string = tmpdir()): Promise<{ path: string; remove(): Promise<void> }> {
  const folder = await mkdtemp(path.join(parent, "rovara-saved-env-"));
  return { path: folder, remove: () => rm(folder, { recursive: true, force: true }) };
}

/** The ports the worker uses on EC2 (everything but the sandbox maker and the broker call, which the run wiring supplies). */
export function realBuildPorts(rest: Pick<SavedEnvBuildPorts, "docker" | "makeFresh" | "pushSession"> & { temporaryParent?: string }): SavedEnvBuildPorts {
  return {
    docker: rest.docker,
    makeFresh: rest.makeFresh,
    pushSession: rest.pushSession,
    snapshotGit: snapshotGitOf,
    gitState: gitStateOf,
    rebuildIndex: rebuildIndexOf,
    trackedTree: trackedTreeOf,
    stage: stageTree,
    installGit: installGitInto,
    scan: (root, options) => scanTreeForSecrets(root, { forbiddenValues: options.forbiddenValues, deadlineAtMs: Date.now() + options.budgetMs }),
    temporaryFolder: () => temporaryFolderIn(rest.temporaryParent),
    now: () => Date.now(),
    random: () => createHash("sha256").update(randomBytes(16)).digest("hex"),
  };
}
