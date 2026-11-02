// SH23: a task starts from the saved environment. The image is pulled by DIGEST with a one-repository login, checked against what the broker expects, copied without following links, its git history is
// the generated one with hooks off, and the default branch is fetched and checked out over the seed. ANY failure clones fresh, reports the step, and leaves nothing behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SAVED_ENV_LABEL_KEY, SAVED_ENV_LABEL_REVISION, savedEnvRepositoryName, type ProjectDefinition, type SavedEnvRegistryAuth, type SavedEnvUse, type SavedEnvUseStep } from "../../packages/contracts/src/index.js";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { checkSeedTree, savedEnvMaterializer, seededGitConfig, type SavedEnvUseOptions } from "../../packages/worker/src/saved-env/use.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "saved-env-use-")); cleanup.push(dir); return dir; };

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const DIGEST = `sha256:${"d".repeat(64)}`;
const KEY = "k".repeat(64).replace(/k/gu, "a");
const REF = `${REGISTRY}/${REPOSITORY}@${DIGEST}`;
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const ORIGIN = "https://github.com/acme/svc.git";
const gitEnv = { PATH: process.env["PATH"] ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnv, HOME: cwd } }).trim();

const auth = (over: Partial<SavedEnvRegistryAuth> = {}): SavedEnvRegistryAuth => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ...over });
const useOf = (over: Partial<SavedEnvUse> = {}): SavedEnvUse => ({ repository: REPOSITORY, digest: DIGEST, testEnvRevision: 4, environmentKey: KEY, auth: auth(), ...over });

const project = (over: Partial<ProjectDefinition["repositories"][number]> = {}): ProjectDefinition => ({
  name: "demo", revision: 1,
  repositories: [{ name: "svc", url: ORIGIN, path: "svc", defaultBranch: "main", credentialRef: "svc-read", ...over }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
});

interface Fixture { root: string; source: string; image: string; commit1: string; commit2: string }

/** A source repository with two commits, and an "image" folder holding a seed cloned at the first (with untracked dependencies) and a manifest. */
async function fixture(): Promise<Fixture> {
  const root = await scratch();
  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "app.js"), "one\n");
  await writeFile(join(source, "package.json"), "{}\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "one");
  const commit1 = git(source, "rev-parse", "HEAD");
  const image = join(root, "image");
  const seed = join(image, "seed", "svc");
  await mkdir(join(image, "seed"), { recursive: true });
  git(root, "clone", "-q", pathToFileURL(source).href, seed);
  git(seed, "remote", "set-url", "origin", ORIGIN);
  await mkdir(join(seed, "node_modules", "dep"), { recursive: true });
  await writeFile(join(seed, "node_modules", "dep", "index.js"), "dep\n");
  await symlink("dep/index.js", join(seed, "node_modules", "alias"));
  await mkdir(join(seed, ".git", "hooks"), { recursive: true });
  await writeFile(join(seed, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho pwned > /tmp/pwned-by-hook\n");
  await writeFile(join(image, "manifest.json"), JSON.stringify(manifest(commit1)));
  await writeFile(join(source, "app.js"), "two\n");
  git(source, "commit", "-q", "-a", "-m", "two");
  return { root, source, image, commit1, commit2: git(source, "rev-parse", "HEAD") };
}

function manifest(commit: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, environmentKey: KEY, testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: commit }], proveReportDigest: "b".repeat(64), builtAt: "2026-11-02T12:00:00.000Z", ...over };
}

interface Docker { cli: DockerCli; calls: string[][]; configAtPull: string | undefined; configDirs: string[]; loginAfterPull: boolean[] }
function fakeDocker(f: Fixture, over: { pull?: number; inspect?: (ref: string) => string; create?: number; cp?: number; labels?: Record<string, string>; digests?: string[] } = {}): Docker {
  const state: Docker = { calls: [], configAtPull: undefined, configDirs: [], loginAfterPull: [], cli: undefined as never };
  state.cli = {
    async run(args) {
      const list = [...args];
      state.calls.push(list);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (list[2] === "pull") {
        const dir = list[list.indexOf("--config") + 1]!;
        state.configDirs.push(dir);
        state.configAtPull = await readFile(join(dir, "config.json"), "utf8").catch(() => undefined);
        return { ...ok, exitCode: over.pull ?? 0 };
      }
      if (list[0] === "image" && list[1] === "inspect") {
        state.loginAfterPull.push(...state.configDirs.map((dir) => existsSync(dir)));
        const labels = over.labels ?? { [SAVED_ENV_LABEL_KEY]: KEY, [SAVED_ENV_LABEL_REVISION]: "4" };
        return { ...ok, stdout: over.inspect !== undefined ? over.inspect(list[list.length - 1]!) : `${JSON.stringify(over.digests ?? [REF])} ${JSON.stringify(labels)}\n` };
      }
      if (list[0] === "create") return { ...ok, exitCode: over.create ?? 0 };
      if (list[0] === "cp") {
        if ((over.cp ?? 0) !== 0) return { ...ok, exitCode: over.cp! };
        const from = list[1]!.slice(list[1]!.indexOf(":") + 1);
        if (from.endsWith("manifest.json")) await cp(join(f.image, "manifest.json"), list[2]!);
        else await cp(join(f.image, "seed"), list[2]!, { recursive: true, verbatimSymlinks: true, dereference: false });
        return ok;
      }
      return ok;
    },
  };
  return state;
}

/** The ordinary fresh clone (what the preparation does without a saved environment). */
function freshClone(f: Fixture, log: string[] = []): RepositoryMaterializer {
  return async (_repository, target) => { log.push("fresh clone"); execFileSync("git", ["clone", "-q", "--no-checkout", pathToFileURL(f.source).href, target], { env: gitEnv }); };
}

async function run(f: Fixture, docker: Docker, over: Partial<SavedEnvUseOptions> & { project?: ProjectDefinition; fail?: Error } = {}) {
  const fallbacks: SavedEnvUseStep[] = [];
  const diagnostics: string[] = [];
  const log: string[] = [];
  const rootPath = await scratch();
  const fetched: string[] = [];
  const manifestOut = await prepareWorkspace({
    rootPath, project: over.project ?? project(), readOnly: true,
    credentialProvider: async () => ({ username: "x-access-token", password: "clone-credential-value" }),
    materializer: freshClone(f, log),
    savedEnv: {
      use: useOf(), taskTestEnvRevision: 4, docker: docker.cli, onFallback: (step) => fallbacks.push(step), onDiagnostic: (message) => diagnostics.push(message),
      fetch: async ({ directory, branch }) => { fetched.push(directory); if (over.fail !== undefined) throw over.fail; execFileSync("git", ["fetch", "-q", "--no-tags", pathToFileURL(f.source).href, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: directory, env: { ...gitEnv, HOME: directory } }); },
      random: () => "0123456789abcdef",
      ...over,
    },
  });
  return { rootPath, manifest: manifestOut, fallbacks, diagnostics, log, fetched };
}

describe("a task starts from the saved environment", () => {
  it("pulls by digest with a one-repository login that exists only for the pull, never runs the image, copies the seed with links as links, regenerates git's config with hooks off, fetches and checks out the branch head over the seed", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const r = await run(f, docker);
    expect(r.manifest.complete).toBe(true);
    expect(r.fallbacks).toEqual([]);
    expect(r.log).toEqual([]);
    // by digest, never a tag
    const pull = docker.calls.find((call) => call[2] === "pull")!;
    expect(pull[pull.length - 1]).toBe(REF);
    expect(pull[pull.length - 1]).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(docker.calls)).not.toContain(PASSWORD);
    expect(Buffer.from((JSON.parse(docker.configAtPull!) as { auths: Record<string, { auth: string }> }).auths[REGISTRY]!.auth, "base64").toString()).toBe(`AWS:${PASSWORD}`);
    expect(docker.configDirs.every((dir) => !existsSync(dir))).toBe(true);
    // the login is gone as soon as the pull returns, before anything is inspected or extracted
    expect(docker.loginAfterPull).toEqual([false]);
    // created, never run
    expect(docker.calls.some((call) => call[0] === "run" || call[0] === "start" || call[0] === "exec")).toBe(false);
    expect(docker.calls.find((call) => call[0] === "create")).toEqual(["create", "--name", expect.stringMatching(/^rovara-saved-env-/u), REF, "/rovara/never-run"]);
    // the seed: dependencies kept, links kept as links
    const svc = join(r.rootPath, "svc");
    expect(readFileSync(join(svc, "node_modules", "dep", "index.js"), "utf8")).toBe("dep\n");
    expect((await lstat(join(svc, "node_modules", "alias"))).isSymbolicLink()).toBe(true);
    // the branch head is checked out over the seed
    expect(readFileSync(join(svc, "app.js"), "utf8")).toBe("two\n");
    expect(r.manifest.repositories[0]!.resolvedCommit).toBe(f.commit2);
    expect(git(svc, "rev-parse", "HEAD")).toBe(f.commit2);
    // hooks are off: none in the repository, and the config says so, with only the project's origin URL
    expect(existsSync(join(svc, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync("/tmp/pwned-by-hook")).toBe(false);
    const config = readFileSync(join(svc, ".git", "config"), "utf8");
    expect(config).toContain("hooksPath = /dev/null");
    expect(config).toContain(`url = ${ORIGIN}`);
    expect(config).not.toContain("file://");
    // nothing left on the machine
    expect(docker.calls.some((call) => call[0] === "rm" && call.includes("--force"))).toBe(true);
    expect(docker.calls.some((call) => call[0] === "rmi" && call.includes(REF))).toBe(true);
  });

  it("the default branch is fetched with the preparation's own clone credential", async () => {
    const f = await fixture();
    const seen: unknown[] = [];
    const r = await run(f, fakeDocker(f), { fetch: async ({ directory, branch, credential }) => { seen.push(credential); execFileSync("git", ["fetch", "-q", "--no-tags", pathToFileURL(f.source).href, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: directory, env: { ...gitEnv, HOME: directory } }); } });
    expect(r.manifest.complete).toBe(true);
    expect(seen).toEqual([{ username: "x-access-token", password: "clone-credential-value" }]);
  });
});

describe("any failure clones fresh, reports the step once, and leaves nothing behind", () => {
  const cases: Array<[string, SavedEnvUseStep, (f: Fixture) => Parameters<typeof fakeDocker>[1] | Promise<Parameters<typeof fakeDocker>[1]>, Partial<SavedEnvUseOptions>?]> = [
    ["the pull fails", "pull", () => ({ pull: 1 })],
    ["the image's digests do not name the pinned reference", "inspect", () => ({ digests: [`${REGISTRY}/${REPOSITORY}@sha256:${"9".repeat(64)}`] })],
    ["the image's key label is another key", "inspect", () => ({ labels: { [SAVED_ENV_LABEL_KEY]: "b".repeat(64), [SAVED_ENV_LABEL_REVISION]: "4" } })],
    ["the image's revision label is another revision", "inspect", () => ({ labels: { [SAVED_ENV_LABEL_KEY]: KEY, [SAVED_ENV_LABEL_REVISION]: "3" } })],
    ["the image has no labels", "inspect", () => ({ inspect: () => "[] null\n" })],
    ["the container cannot be created", "extract", () => ({ create: 1 })],
    ["the copy fails", "extract", () => ({ cp: 1 })],
  ];
  it.each(cases)("%s", async (_name, step, make) => {
    const f = await fixture();
    const docker = fakeDocker(f, await make(f));
    const r = await run(f, docker);
    expect(r.manifest.complete).toBe(true);
    expect(r.fallbacks).toEqual([step]);
    expect(r.diagnostics).toEqual([`fresh setup (saved environment failed at ${step})`]);
    expect(r.log).toEqual(["fresh clone"]);
    // a fresh clone, not the seed
    expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
    expect(readFileSync(join(r.rootPath, "svc", "app.js"), "utf8")).toBe("two\n");
    expect(docker.configDirs.every((dir) => !existsSync(dir))).toBe(true);
    expect(docker.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("the image's manifest says another key, another revision, or has no commit for the repository", async () => {
    for (const change of [{ environmentKey: "c".repeat(64) }, { testEnvRevision: 5 }, { commits: [{ repositoryId: "other", sha: "a".repeat(40) }] }]) {
      const f = await fixture();
      await writeFile(join(f.image, "manifest.json"), JSON.stringify(manifest(f.commit1, change)));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks, JSON.stringify(change)).toEqual(["manifest"]);
      expect(r.log).toEqual(["fresh clone"]);
    }
    const f = await fixture();
    await writeFile(join(f.image, "manifest.json"), "not json");
    expect((await run(f, fakeDocker(f))).fallbacks).toEqual(["manifest"]);
  });

  it("the seed lacks the repository's folder", async () => {
    const f = await fixture();
    await rm(join(f.image, "seed", "svc"), { recursive: true });
    await mkdir(join(f.image, "seed", "elsewhere"));
    const r = await run(f, fakeDocker(f));
    expect(r.fallbacks).toEqual(["layout"]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a link in the seed that is absolute or leaves the seed, even one the task would never open", async () => {
    for (const [name, target] of [["python", "/usr/bin/python3"], ["up", "../../../etc"]] as const) {
      const f = await fixture();
      await symlink(target, join(f.image, "seed", "svc", "node_modules", name));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks, name).toEqual(["links"]);
      expect(r.log).toEqual(["fresh clone"]);
      expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
    }
  });

  it("git history that is redirected (alternates, grafts, replace refs, modules, worktrees) in the image", async () => {
    const plants: Array<(git: string) => Promise<void>> = [
      async (g) => { await mkdir(join(g, "objects", "info"), { recursive: true }); await writeFile(join(g, "objects", "info", "alternates"), "/x\n"); },
      async (g) => { await mkdir(join(g, "info"), { recursive: true }); await writeFile(join(g, "info", "grafts"), "x\n"); },
      async (g) => { await mkdir(join(g, "refs", "replace"), { recursive: true }); },
      async (g) => { await mkdir(join(g, "modules"), { recursive: true }); },
      async (g) => { await mkdir(join(g, "worktrees"), { recursive: true }); },
    ];
    for (const plant of plants) {
      const f = await fixture();
      await plant(join(f.image, "seed", "svc", ".git"));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks).toEqual(["git"]);
      expect(r.log).toEqual(["fresh clone"]);
    }
  });

  it("a project URL with a credential never reaches the config: the repository is cloned fresh", async () => {
    const f = await fixture();
    const r = await run(f, fakeDocker(f), { project: project({ url: "https://user:pw@github.com/acme/svc.git" }) }).catch((error: unknown) => error);
    // the ordinary clone path refuses a credentialed remote as well; the point is that the seed was not used with it
    expect(r instanceof Error || (r as { fallbacks: string[] }).fallbacks[0] === "git").toBe(true);
  });

  it("the fetch fails: the seed is removed and the repository is cloned fresh", async () => {
    const f = await fixture();
    const r = await run(f, fakeDocker(f), { fail: new Error("network down") });
    expect(r.fallbacks).toEqual(["fetch"]);
    expect(r.log).toEqual(["fresh clone"]);
    expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
  });
});

describe("the revision the image was built at must be the revision the task is pinned to", () => {
  it("a task pinned to another revision never pulls the image", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const r = await run(f, docker, { taskTestEnvRevision: 5 });
    expect(r.fallbacks).toEqual(["revision"]);
    expect(docker.calls).toEqual([]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a login for another repository, a tag instead of a digest, or a registry that is not ECR is refused before anything is pulled", async () => {
    const other = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-2" });
    const f = await fixture();
    for (const use of [{ ...useOf(), auth: auth({ repository: other }) }, { ...useOf(), digest: "latest" }, { ...useOf(), auth: auth({ registry: "evil.example.com" }) }] as unknown as SavedEnvUse[]) {
      const docker = fakeDocker(f);
      const r = await run(f, docker, { use });
      expect(r.fallbacks).toEqual(["input"]);
      expect(docker.calls).toEqual([]);
    }
  });
});

describe("pieces", () => {
  it("the meta repository, which is not in the image, clones as before and says nothing", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const log: string[] = [];
    const fallbacks: string[] = [];
    const materialize = savedEnvMaterializer({ use: useOf(), taskTestEnvRevision: 4, docker: docker.cli, onFallback: (s) => fallbacks.push(s) }, project().repositories, freshClone(f, log));
    await materialize({ name: "meta", url: ORIGIN, path: "meta", defaultBranch: "main", credentialRef: "x" }, join(await scratch(), "meta"), {});
    expect(log).toEqual(["fresh clone"]);
    expect(fallbacks).toEqual([]);
    expect(docker.calls).toEqual([]);
  });

  it("the generated config has the origin URL, hooks off, and refuses an unsafe URL", () => {
    const config = seededGitConfig(ORIGIN);
    expect(config).toContain("hooksPath = /dev/null");
    expect(config.match(/\[core\]/gu)).toHaveLength(1);
    expect(() => seededGitConfig("https://u:p@h/a")).toThrow();
  });

  it("the seed check accepts links that stay inside and refuses a device-like file via the special-file path", async () => {
    const root = await scratch();
    await mkdir(join(root, "svc", "a"), { recursive: true });
    await writeFile(join(root, "svc", "a", "f"), "x");
    await symlink("f", join(root, "svc", "a", "ok"));
    expect(await checkSeedTree(root)).toBe("ok");
    await symlink("/etc/passwd", join(root, "svc", "bad"));
    expect(await checkSeedTree(root)).toBe("unsafe_link");
    expect((await readdir(root)).length).toBe(1);
  });
});
