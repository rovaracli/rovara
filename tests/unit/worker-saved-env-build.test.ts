// SH22: the saved image build. An image is built only from the fresh sandbox of a PASSING Prove run of the APPROVED environment, at the default branch head, with no secret in the tree; it is pushed with a short-lived
// login for one repository; the digest is the registry's answer for that repository. Every failure is a fixed word, and nothing is left behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAVED_ENV_BUILD_FAILURES, SavedEnvBuildResultSchema, SavedEnvImageManifestSchema, formatCommandLine, parseCommandLine, savedEnvRepositoryName, testEnvDigest,
  type ProjectCommand, type SavedEnvRegistryAuth, type TestEnvironmentBody,
} from "../../packages/contracts/src/index.js";
import { buildEnvironmentDraft } from "../../packages/worker/src/env-detect/propose.js";
import { emptyDetection } from "../../packages/worker/src/env-detect/types.js";
import type { ProveCommandResult } from "../../packages/worker/src/prove.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { gitStateOf, installGitInto, proveAndBuildSavedImage, rebuildIndexOf, savedEnvDockerfile, savedEnvTag, snapshotGitOf, stageTree, trackedTreeOf, type BuildSandbox, type SavedEnvBuildInput, type SavedEnvBuildPorts } from "../../packages/worker/src/saved-env/build.js";
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
async function makeRepository(root: string, over: { origin?: string; files?: Record<string, string> } = {}): Promise<string> {
  const dir = join(root, "svc");
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(over.files ?? FILES)) { await mkdir(join(dir, name, ".."), { recursive: true }); await writeFile(join(dir, name), content); }
  await chmod(join(dir, "run.sh"), 0o755);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "remote", "add", "origin", over.origin ?? ORIGIN);
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", commit);
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "x\n");
  return commit;
}

interface Recorded { calls: string[][]; contexts: Array<{ files: string[]; dockerfile: string; manifest: string; gitConfig: string | undefined; gitEntries: string[]; configDuringPush?: string | undefined }>; }
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
        const walk = async (dir: string, prefix: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            files.push(rel);
            if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          }
        };
        await walk(context, "");
        const gitDir = join(context, "seed", "svc", ".git");
        rec.contexts.push({
          files, dockerfile: await readFile(join(context, "Dockerfile"), "utf8"), manifest: await readFile(join(context, "manifest.json"), "utf8"),
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
  provePasses?: boolean; commitOverride?: string; builderImage?: string;
} = {}): Promise<World> {
  const rec: Recorded = { calls: [], contexts: [] };
  const log: string[] = [];
  const root = await scratch();
  const tempParent = await scratch();
  const fresh = { disposed: 0, stopped: 0, root };
  const dir = join(root, "svc");
  const commit = await makeRepository(root, { ...(over.origin === undefined ? {} : { origin: over.origin }), ...(over.files === undefined ? {} : { files: over.files }) });
  await over.afterClone?.(dir);
  const env = over.env ?? environment();
  let t = 1_000_000;
  let ran = false;
  const sandbox: BuildSandbox = {
    id: "fresh-1", rootPath: root, dispose: async () => { fresh.disposed += 1; log.push("disposed"); },
    stopProcesses: async () => { log.push("stopped"); fresh.stopped += 1; if (over.stopThrows === true) throw new Error("cannot stop"); },
    ports: {
      runCommand: async (command): Promise<ProveCommandResult> => { log.push(formatCommandLine(command)); t += 1_000; if (!ran) { ran = true; await over.during?.(dir); } return { exitCode: over.provePasses === false ? 1 : 0, timedOut: false, stdout: "", stderr: "" }; },
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
    stage: async (src, dst) => { log.push("stage"); await stageTree(src, dst); },
    installGit: installGitInto,
    scan: (dir2, options) => scanTreeForSecrets(dir2, { forbiddenValues: options.forbiddenValues, deadlineAtMs: Date.now() + options.budgetMs }),
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
    expect(w.log).toEqual(["snapshot", "npm ci", "npm test", "stopped", "stage", "disposed"]);
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

  it("untracked files (installed dependencies, caches) are free; a clone that is a link or a file for .git is refused", async () => {
    const free = await world({ during: async (dir) => { await writeFile(join(dir, "node_modules", "dep", "new.js"), "y\n"); await mkdir(join(dir, ".cache"), { recursive: true }); await writeFile(join(dir, ".cache", "x"), "z"); } });
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

  it("a secret in the tree ends the build before docker is run: a token in a source file written during the run, a .env, a value the machine held", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const held = ["clone", "-", "w".repeat(24)].join("");
    const plants: Array<(dir: string) => Promise<void>> = [
      async (dir) => { await writeFile(join(dir, "src", "ci.js"), `const t = "${token}";\n`); },
      async (dir) => { await writeFile(join(dir, ".env"), "A=1\n"); },
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
    await stageTree(src, dst);
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
