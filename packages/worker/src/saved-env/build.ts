// Setup and test health SH22 (design setup-test-health.md, sections 5.1, 5.4 and 12): build and push the saved image of a project.
//
// The ONE entry point is `proveAndBuildSavedImage`. It makes its own fresh sandbox, runs the Prove sequence there, and builds from THAT sandbox's workspace, before the sandbox is removed. There is no function that
// takes a workspace and builds it, so an image cannot come from a task's workspace or from the setup agent's. Everything below is a precondition of the build, checked in this order, and each failure is a
// fixed word (contracts `SAVED_ENV_BUILD_FAILURES`) with no output and no value in it:
//   1. the environment is the APPROVED one: its digest is the broker's approved digest (`not_approved`);
//   2. the sandbox is new: it shares no id and no workspace with any workspace named in `notFrom` (`not_fresh`);
//   3. the Prove run passed for that digest (`not_proved`; a Prove that could not run is `prove_failed`);
//   4. every repository is exactly at the head of its default branch, with no tracked file changed (`not_default_branch`): ED-1, an image holds reviewed code only;
//   5. the environment key is worked out from the files of that checkout (SH21), or the build stops (`unsafe_tree`);
//   6. the staged tree holds no secret (`secrets_found`; see secret-scan.ts), and no device file or tree over the limits (`unsafe_tree`);
//   7. only then is an image built, with no network and nothing run in it: `FROM scratch`, a `COPY` of the seed and the manifest, labels. No `RUN`, `ENV`, `ARG` or `ADD`;
//   8. a push login for THAT repository is fetched from the broker (it is short-lived and scoped to one repository), written to a throwaway Docker config, and used for the push alone;
//   9. the digest comes from the registry's own answer, and its repository must be the one the login was for (`digest_mismatch`).
// The login, the config and the staged copy are removed whatever happens. The worker's instance role is not used for any of this and has no grant on these repositories.
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
import { scanTreeForSecrets, type SecretScanResult } from "./secret-scan.js";

const BUILD_TIMEOUT_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 45 * 60_000;
const DOCKER_QUICK_MS = 2 * 60_000;
const MAX_REPOSITORIES = 16;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

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
  /** Whether any tracked file differs from HEAD (untracked files are not counted: installed dependencies are untracked). */
  trackedChanges: boolean;
  /** Tracked files, POSIX, repository-relative. */
  files: string[];
}

export interface SavedEnvBuildPorts {
  docker: DockerCli;
  /** A new sandbox on a new workspace (as `proveAfterAgent` makes one). Removed by this module. */
  makeFresh(): Promise<FreshSandbox>;
  gitState(repositoryDirectory: string, defaultBranch: string): Promise<GitState>;
  /** Copies `source` to `destination`, links as links (never followed), leaving out sockets and pipes and everything under `.git/hooks`. Throws on a device file. */
  stage(source: string, destination: string): Promise<void>;
  /** `budgetMs` is how long the scan may take (the scan reads its own clock). */
  scan(root: string, options: { forbiddenValues: readonly string[]; budgetMs: number }): Promise<SecretScanResult>;
  /** The broker's push login for this repository: short-lived, one repository. Undefined when the broker refused. */
  pushSession(request: { repository: string }): Promise<SavedEnvRegistryAuth | undefined>;
  /** A new private folder; `remove` deletes it with everything in it. */
  temporaryFolder(): Promise<{ path: string; remove(): Promise<void> }>;
  now(): number;
  /** A fresh random suffix for the immutable tag. */
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

  let fresh: FreshSandbox | undefined;
  let staged: Awaited<ReturnType<SavedEnvBuildPorts["temporaryFolder"]>> | undefined;
  let docker: Awaited<ReturnType<SavedEnvBuildPorts["temporaryFolder"]>> | undefined;
  const localTags: string[] = [];
  try {
    // 2. A fresh sandbox.
    try { fresh = await ports.makeFresh(); } catch { return fail("fresh_sandbox_failed"); }
    for (const other of input.notFrom) {
      if (fresh.id === other.id || await sharesWorkspace(fresh.rootPath, other.rootPath, defaultRealPath)) return fail("not_fresh");
    }

    // 3. The Prove run, in that sandbox, for that digest.
    let report;
    try { report = await proveEnvironment(fresh.ports, { proposalDigest: digest, environment: parsedEnvironment.data, signal: input.signal, deadlineMs: input.proveDeadlineMs }); } catch { return fail("prove_failed"); }
    if (!testEnvIsProved(report, digest)) return fail("not_proved");
    const proveReportDigest = createHash("sha256").update(canonicalJson(report)).digest("hex");

    // 4. Every repository at the head of its default branch.
    const keyRepositories: KeyRepository[] = [];
    for (const repository of input.repositories) {
      const directory = path.join(fresh.rootPath, repository.directory);
      let state: GitState;
      try { state = await ports.gitState(directory, repository.defaultBranch); } catch { return fail("not_default_branch", "git"); }
      if (state.head !== repository.commit || state.originHead !== repository.commit || state.trackedChanges) return fail("not_default_branch");
      keyRepositories.push({
        repositoryId: repository.repositoryId,
        paths: state.files,
        readText: async (file) => {
          // Only a regular file inside the checkout (the same test the key's hash uses), and a small one: a dev container file.
          try { return (await hashWorkspaceFile(directory, file)) === undefined ? undefined : (await readFile(path.join(directory, file), "utf8")).slice(0, 1_048_576); } catch { return undefined; }
        },
        hashFile: (file) => hashWorkspaceFile(directory, file),
      });
    }

    // 5. The environment key, from the same checkout.
    const key = await environmentKeyFromRepositories({ repositories: keyRepositories, detectorGlobs: input.detectorGlobs, testEnvRevision: input.approved.revision, secretNames: input.secretNames, baseImageDigest: input.baseImageDigest });
    if (!key.ok) return fail("unsafe_tree", "key");

    // 6. Stage the seed and scan it.
    staged = await ports.temporaryFolder();
    const seedRoot = path.join(staged.path, "seed");
    await mkdir(seedRoot, { recursive: true });
    try {
      for (const repository of input.repositories) await ports.stage(path.join(fresh.rootPath, repository.directory), path.join(seedRoot, repository.directory));
    } catch { return fail("unsafe_tree", "stage"); }
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

    // 7. Build: no network, nothing run in it.
    const local = `rovara-saved-env-build:${randomBytes(8).toString("hex")}`;
    localTags.push(local);
    const built = await ports.docker.run(["build", "--network", "none", "--pull=false", "--provenance=false", "--tag", local, "--file", path.join(staged.path, "Dockerfile"), staged.path], { timeoutMs: BUILD_TIMEOUT_MS, signal: input.signal });
    if (built.exitCode !== 0) return fail("build_failed");

    // The seed is in the image; the sandbox and the staged copy are no longer needed, and the scan's disk is returned before the push.
    await rm(staged.path, { recursive: true, force: true }).catch(() => undefined);

    // 8. The push login, for this repository, used for the push alone.
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

    // 9. The digest, from the registry's answer, and its repository must be the one the login was for.
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
    // Whatever happened: the login, the staged copy, the local images and the sandbox go.
    await docker?.remove().catch(() => undefined);
    await staged?.remove().catch(() => undefined);
    for (const tag of localTags) await ports.docker.run(["rmi", "--force", tag], { timeoutMs: DOCKER_QUICK_MS }).catch(() => undefined);
    await fresh?.dispose().catch(() => undefined);
  }
}

// ---- the real ports

/** `cp` with links kept as links, sockets and pipes left out, device files refused, and nothing under `.git/hooks`. */
export async function stageTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, dereference: false, preserveTimestamps: false,
    filter: async (from) => {
      const relative = path.relative(source, from).split(path.sep).join("/");
      if (relative === ".git/hooks" || relative.startsWith(".git/hooks/")) return false;
      const info = await lstat(from);
      if (info.isSymbolicLink() || info.isFile() || info.isDirectory()) return true;
      if (info.isSocket() || info.isFIFO()) return false;
      throw new Error("a device file cannot be saved");
    },
  });
  // The hooks folder itself stays, empty: a repository without one is still a repository.
  await mkdir(path.join(destination, ".git", "hooks"), { recursive: true }).catch(() => undefined);
}

export async function gitStateOf(repositoryDirectory: string, defaultBranch: string): Promise<GitState> {
  if (!BRANCH_NAME.test(defaultBranch)) throw new RangeError("not a branch name");
  const one = async (args: string[]) => (await runIsolatedGit(repositoryDirectory, args, { timeout: 120_000 })).trim();
  const head = await one(["rev-parse", "HEAD"]);
  const originHead = await one(["rev-parse", "--verify", "-q", `refs/remotes/origin/${defaultBranch}`]).catch(() => undefined);
  const dirty = await runIsolatedGit(repositoryDirectory, ["status", "--porcelain=v1", "--untracked-files=no"], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const listed = await runIsolatedGit(repositoryDirectory, ["ls-files", "-z"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { head, originHead: originHead === undefined || originHead === "" ? undefined : originHead, trackedChanges: dirty.trim() !== "", files: listed.split("\u0000").filter((name) => name !== "") };
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
    gitState: gitStateOf,
    stage: stageTree,
    scan: (root, options) => scanTreeForSecrets(root, { forbiddenValues: options.forbiddenValues, deadlineAtMs: Date.now() + options.budgetMs }),
    temporaryFolder: () => temporaryFolderIn(rest.temporaryParent),
    now: () => Date.now(),
    random: () => createHash("sha256").update(randomBytes(16)).digest("hex"),
  };
}
