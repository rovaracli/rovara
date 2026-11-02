// SH22: the saved image build. An image is built only from the fresh sandbox of a PASSING Prove run of the APPROVED environment, at the default branch head, with no secret in the tree; it is pushed with a short-lived
// login for one repository; the digest is the registry's answer for that repository. Every failure is a fixed word, and nothing is left behind.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAVED_ENV_BUILD_FAILURES, SavedEnvBuildResultSchema, SavedEnvImageManifestSchema, formatCommandLine, parseCommandLine, savedEnvRepositoryName, testEnvDigest,
  type ProjectCommand, type SavedEnvRegistryAuth, type TestEnvironmentBody,
} from "../../packages/contracts/src/index.js";
import { buildEnvironmentDraft } from "../../packages/worker/src/env-detect/propose.js";
import { emptyDetection } from "../../packages/worker/src/env-detect/types.js";
import type { ProveCommandResult, ProvePorts } from "../../packages/worker/src/prove.js";
import type { FreshSandbox } from "../../packages/worker/src/setup-agent-prove.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { gitStateOf, proveAndBuildSavedImage, savedEnvDockerfile, savedEnvTag, stageTree, type GitState, type SavedEnvBuildInput, type SavedEnvBuildPorts } from "../../packages/worker/src/saved-env/build.js";
import { scanTreeForSecrets } from "../../packages/worker/src/saved-env/secret-scan.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "saved-env-build-")); cleanup.push(dir); return dir; };

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const OTHER_REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-2" });
const COMMIT = "c".repeat(40);
const BASE_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const PASSWORD = ["login", "-", "p".repeat(30)].join("");

const cmd = (line: string, timeoutSeconds = 900): ProjectCommand => parseCommandLine(line, "svc", timeoutSeconds);
function environment(): TestEnvironmentBody {
  const detection = emptyDetection();
  detection.setupCommands.push({ value: cmd("npm ci"), source: { path: "README.md", line: 3 } });
  detection.checks.push({ value: { id: "unit", label: "unit", command: cmd("npm test", 1_800), kind: "test", reportPath: "out/junit.xml" }, source: { path: "package.json", line: 5 } });
  const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
  if ("ok" in draft) throw new Error("draft");
  return draft.environment;
}

interface Recorded { calls: string[][]; contexts: Array<{ files: string[]; dockerfile: string; manifest: string; configDuringPush?: string | undefined }>; }
function fakeDocker(rec: Recorded, over: { build?: number; push?: number; inspect?: (args: string[]) => string; tag?: number; digestRepository?: string } = {}): DockerCli {
  return {
    async run(args) {
      const list = [...args];
      rec.calls.push(list);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (list[0] === "build") {
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
        rec.contexts.push({ files, dockerfile: await readFile(join(context, "Dockerfile"), "utf8"), manifest: await readFile(join(context, "manifest.json"), "utf8") });
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

function proveOk(log: string[]): ProvePorts {
  let t = 1_000_000;
  return {
    runCommand: async (command): Promise<ProveCommandResult> => { log.push(formatCommandLine(command)); t += 1_000; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; },
    startMock: async () => undefined, probePreprod: async () => true, mockUnmatched: async () => [], buildCoverageMap: async () => undefined, suiteTestCount: async () => 3, now: () => t,
  };
}

interface World {
  input: SavedEnvBuildInput; ports: SavedEnvBuildPorts; rec: Recorded; log: string[]; fresh: { disposed: number; root: string }; sessions: number; temp: string[];
}

async function world(over: {
  files?: Record<string, string>; git?: Partial<GitState>; docker?: Parameters<typeof fakeDocker>[1]; env?: TestEnvironmentBody; approvedDigest?: string; session?: () => Promise<SavedEnvRegistryAuth | undefined>;
  notFrom?: SavedEnvBuildInput["notFrom"]; prove?: (log: string[]) => ProvePorts; forbidden?: string[]; makeFreshThrows?: boolean; repoDir?: string;
} = {}): Promise<World> {
  const rec: Recorded = { calls: [], contexts: [] };
  const log: string[] = [];
  const root = await scratch();
  const tempParent = await scratch();
  const fresh = { disposed: 0, root };
  const files = over.files ?? { "svc/package.json": '{"name":"svc"}', "svc/package-lock.json": "{}", "svc/src/index.js": "module.exports = 1;\n", "svc/node_modules/dep/index.js": "x\n", "svc/.git/config": '[remote "origin"]\n\turl = https://github.com/acme/svc.git\n', "svc/.git/hooks/pre-commit": "#!/bin/sh\necho hook\n", "svc/.git/HEAD": "ref: refs/heads/main\n" };
  for (const [name, content] of Object.entries(files)) { await mkdir(join(root, name, ".."), { recursive: true }); await writeFile(join(root, name), content); }
  const env = over.env ?? environment();
  const state: GitState = { head: COMMIT, originHead: COMMIT, trackedChanges: false, files: ["package.json", "package-lock.json", "src/index.js"], ...over.git };
  const sandbox: FreshSandbox = { id: "fresh-1", rootPath: root, ports: (over.prove ?? proveOk)(log), dispose: async () => { fresh.disposed += 1; } };
  const world: World = { rec, log, fresh, sessions: 0, temp: [], input: undefined as never, ports: undefined as never };
  world.ports = {
    docker: fakeDocker(rec, over.docker),
    makeFresh: async () => { if (over.makeFreshThrows === true) throw new Error("no"); return sandbox; },
    gitState: async () => state,
    stage: stageTree,
    scan: (dir, options) => scanTreeForSecrets(dir, options),
    pushSession: async () => { world.sessions += 1; return over.session === undefined ? { registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 900_000).toISOString() } : over.session(); },
    temporaryFolder: async () => { const dir = await mkdtemp(join(tempParent, "t-")); world.temp.push(dir); return { path: dir, remove: () => rm(dir, { recursive: true, force: true }) }; },
    now: () => NOW,
    random: () => "0123456789abcdef",
  };
  world.input = {
    repository: REPOSITORY, environment: env, approved: { revision: 4, digest: over.approvedDigest ?? testEnvDigest(env) },
    repositories: [{ repositoryId: "svc", directory: over.repoDir ?? "svc", defaultBranch: "main", commit: COMMIT }],
    detectorGlobs: [], secretNames: ["PUBLISH_TOKEN"], baseImageDigest: BASE_DIGEST, notFrom: over.notFrom ?? [{ id: "task-1", rootPath: "/mnt/task-1" }], forbiddenValues: over.forbidden ?? [],
    signal: new AbortController().signal, proveDeadlineMs: 3_600_000,
  };
  return world;
}

const dockerVerbs = (rec: Recorded) => rec.calls.map((call) => (call[0] === "--config" ? call[2] : call[0] === "image" ? "inspect" : call[0]));

describe("a passing, approved, default-branch build", () => {
  it("builds from the fresh sandbox after its Prove run and returns the registry's digest and a manifest", async () => {
    const w = await world();
    const result = await proveAndBuildSavedImage(w.input, w.ports);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SavedEnvBuildResultSchema.safeParse(result).success).toBe(true);
    expect(result.imageDigest).toBe(IMAGE_DIGEST);
    expect(result.repository).toBe(REPOSITORY);
    expect(result.manifest).toMatchObject({ schemaVersion: 1, testEnvRevision: 4, imageDigest: IMAGE_DIGEST, commits: [{ repositoryId: "svc", sha: COMMIT }] });
    expect(result.manifest.builtAt).toBe("2026-11-02T12:00:00.000Z");
    // the Prove ran the approved commands in the fresh sandbox first
    expect(w.log).toEqual(["npm ci", "npm test"]);
    expect(dockerVerbs(w.rec)).toEqual(["build", "tag", "push", "inspect", "rmi", "rmi"]);
    // a tag is unique and carries no org or project
    expect(result.tag).toMatch(/^k[a-f0-9]{16}-20261102120000-01234567$/u);
  });

  it("the image is FROM scratch: a COPY of the seed and the manifest and labels; no RUN, ENV, ARG or ADD; built with no network and nothing pulled", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    const { dockerfile } = w.rec.contexts[0]!;
    expect(dockerfile.split("\n").filter((line) => line !== "").map((line) => line.split(" ")[0])).toEqual(["FROM", "COPY", "COPY", "LABEL"]);
    expect(dockerfile).toMatch(/^FROM scratch$/mu);
    expect(dockerfile).not.toMatch(/\b(RUN|ENV|ARG|ADD|ENTRYPOINT|CMD|USER|EXPOSE)\b/u);
    const build = w.rec.calls[0]!;
    expect(build).toEqual(expect.arrayContaining(["--network", "none", "--pull=false"]));
  });

  it("the build context holds the repository with its dependencies and caches, without git hooks, and a manifest with no digest and no secret name", async () => {
    const w = await world();
    await proveAndBuildSavedImage(w.input, w.ports);
    const context = w.rec.contexts[0]!;
    expect(context.files).toEqual(expect.arrayContaining(["Dockerfile", "manifest.json", "seed/svc/package.json", "seed/svc/node_modules/dep/index.js", "seed/svc/.git/config"]));
    expect(context.files).not.toContain("seed/svc/.git/hooks/pre-commit");
    const manifest = SavedEnvImageManifestSchema.parse(JSON.parse(context.manifest));
    expect(manifest.commits).toEqual([{ repositoryId: "svc", sha: COMMIT }]);
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

describe("what stops a build", () => {
  const expectNothingBuilt = (w: World) => { expect(w.rec.calls.filter((call) => call[0] === "build" || call.includes("push"))).toEqual([]); expect(w.sessions).toBe(0); };

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
    const failing = await world({ prove: (log) => ({ ...proveOk(log), runCommand: async () => ({ exitCode: 1, timedOut: false, stdout: "boom", stderr: "" }) }) });
    expect(await proveAndBuildSavedImage(failing.input, failing.ports)).toEqual({ ok: false, reason: "not_proved" });
    expect(failing.fresh.disposed).toBe(1);
    expectNothingBuilt(failing);
  });

  it("a checkout that is not exactly the default branch head is refused: a different head, a different origin head, a missing origin ref, a changed tracked file", async () => {
    for (const git of [{ head: "a".repeat(40) }, { originHead: "a".repeat(40) }, { originHead: undefined }, { trackedChanges: true }]) {
      const w = await world({ git });
      expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "not_default_branch" });
      expectNothingBuilt(w);
      expect(w.fresh.disposed).toBe(1);
    }
  });

  it("a secret in the tree ends the build before docker is run: a token in a source file, a .env, a value the machine held", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const held = ["clone", "-", "w".repeat(24)].join("");
    for (const files of [{ "svc/src/ci.js": `const t = "${token}";\n` }, { "svc/.env": "A=1\n" }, { "svc/node_modules/dep/state.json": `{"c":"${held}"}` }]) {
      const w = await world({ files: { "svc/package.json": "{}", ...files }, git: { files: ["package.json"] }, forbidden: [held] });
      expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "secrets_found" });
      expect(w.rec.calls).toEqual([]);
      expect(w.temp.every((dir) => !existsSync(dir))).toBe(true);
    }
  });

  it("a secret in git's own config (a credential in a remote URL) is found too", async () => {
    const url = ["https://", "ci:", "p".repeat(12), "@git.example.com/o/r.git"].join("");
    const w = await world({ files: { "svc/package.json": "{}", "svc/.git/config": `[remote "origin"]\n\turl = ${url}\n` }, git: { files: ["package.json"] } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "secrets_found" });
    expect(w.rec.calls).toEqual([]);
  });

  it("no push login, a login for another repository, or one about to expire: no push", async () => {
    const other = await world({ session: async () => ({ registry: REGISTRY, repository: OTHER_REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 900_000).toISOString() }) });
    expect(await proveAndBuildSavedImage(other.input, other.ports)).toEqual({ ok: false, reason: "no_push_session" });
    const none = await world({ session: async () => undefined });
    expect(await proveAndBuildSavedImage(none.input, none.ports)).toEqual({ ok: false, reason: "no_push_session" });
    const late = await world({ session: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(NOW + 30_000).toISOString() }) });
    expect(await proveAndBuildSavedImage(late.input, late.ports)).toEqual({ ok: false, reason: "no_push_session" });
    for (const w of [other, none, late]) expect(w.rec.calls.some((call) => call.includes("push"))).toBe(false);
  });

  it("a failed push removes the login and the local images", async () => {
    const w = await world({ docker: { push: 1 } });
    expect(await proveAndBuildSavedImage(w.input, w.ports)).toEqual({ ok: false, reason: "push_failed" });
    expect(w.temp.every((dir) => !existsSync(dir))).toBe(true);
    expect(w.rec.calls.filter((call) => call[0] === "rmi")).toHaveLength(2);
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
    for (const bad of [{ repository: "rovara-env/test/*" }, { repositories: [{ repositoryId: "svc", directory: "../x", defaultBranch: "main", commit: COMMIT }] }, { repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main;rm", commit: COMMIT }] }, { repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main", commit: "abc" }] }, { repositories: [] }]) {
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
  it("staging keeps links as links, leaves out a socket's place, and does not copy .git/hooks", async () => {
    const src = await scratch();
    const dst = join(await scratch(), "out");
    await mkdir(join(src, ".git", "hooks"), { recursive: true });
    await writeFile(join(src, ".git", "hooks", "post-checkout"), "x");
    await writeFile(join(src, "a.txt"), "a");
    await symlink("/usr/bin/python3", join(src, "python"));
    await stageTree(src, dst);
    expect((await lstat(join(dst, "python"))).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dst, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(await readFile(join(dst, "a.txt"), "utf8")).toBe("a");
  });
  it("the real git state reads HEAD, the origin ref, tracked changes and tracked files without trusting the repository's own config", async () => {
    await expect(gitStateOf("/nonexistent-dir-for-test", "main;x")).rejects.toThrow();
  });
});
