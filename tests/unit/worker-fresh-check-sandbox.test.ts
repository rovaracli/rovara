// TE-B1-fresh: the fresh check sandbox's run arguments (an allow-list in the style of checkSandboxArgProblems) and the clean export of the candidate commit (fresh-check-sandbox.ts). The export tests drive real git.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRESH_EXPORT_CAPS } from "../../packages/worker/src/fresh-check-export.js";
import {
  FRESH_NOT_RUN_SENTENCES, FRESH_SANDBOX_ROUND_LABEL, exportCandidateForFreshRound, freshSandboxArgProblems, freshSandboxRunArgs, removeFreshExport, type FreshSandboxRunInput,
} from "../../packages/worker/src/fresh-check-sandbox.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fresh-sbx-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function runInput(extra: Partial<FreshSandboxRunInput> = {}): FreshSandboxRunInput {
  return { name: "agentx-fresh-t1-abcd1234", taskId: "t1", image: "worker:img", rootPath: "/mnt/workspace", exportDirectory: "/mnt/workspace/.agentx/fresh-check/t1-xyz", hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3, environment: {}, ...extra };
}
const problems = (args: readonly string[], input = runInput()) => freshSandboxArgProblems(args, input);

describe("the fresh sandbox's run arguments", () => {
  it("pass the allow-list: one network, non-root, no capability, the export as the only mount, task labels", () => {
    const args = freshSandboxRunArgs(runInput());
    expect(problems(args)).toEqual([]);
    const value = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
    expect(value("--network")).toEqual(["agentx-task"]);
    expect(value("--user")).toEqual(["1000:1000"]);
    expect(value("--cap-drop")).toEqual(["ALL"]);
    expect(value("--security-opt")).toEqual(["no-new-privileges"]);
    expect(value("--volume")).toEqual(["/mnt/workspace/.agentx/fresh-check/t1-xyz:/mnt/workspace"]);
    expect(value("--label")).toContain("agentx.task=t1");
    expect(value("--label")).toContain(FRESH_SANDBOX_ROUND_LABEL);
    expect(value("--pids-limit")).toHaveLength(1);
    expect(value("--memory")).toHaveLength(1);
    expect(value("--cpus")).toHaveLength(1);
    expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--add-host|--cap-add|--pid(?!s)|--ipc|--userns|--device/u);
  });
  it("the working root is never the mount's source", () => {
    expect(() => freshSandboxRunArgs(runInput({ exportDirectory: "/mnt/workspace" }))).toThrow(/working root/u);
    expect(() => freshSandboxRunArgs(runInput({ exportDirectory: "/elsewhere/export" }))).toThrow(/working root/u);
  });
  it("the wall's pinned hosts are the only --add-host allowed, and only exactly as the wall wrote them", () => {
    const environment = { AGENTX_PRIVATE_ADDRESS_HOSTS: "registry.internal.example=10.0.0.5" };
    const args = freshSandboxRunArgs(runInput({ environment }));
    expect(args).toContain("registry.internal.example:10.0.0.5");
    expect(problems(args, runInput({ environment }))).toEqual([]);
    expect(problems([...args.slice(0, 2), "--add-host", "api.openai.com:10.9.9.9", ...args.slice(2)], runInput({ environment })).join("|")).toMatch(/add-host/u);
    // no pinned hosts: any --add-host is refused (F1-b adds its own later)
    expect(problems([...freshSandboxRunArgs(runInput()).slice(0, 2), "--add-host", "x.test:10.0.0.1", ...freshSandboxRunArgs(runInput()).slice(2)]).join("|")).toMatch(/add-host/u);
  });
  const insert = (extra: string[]) => { const args = freshSandboxRunArgs(runInput()); return [...args.slice(0, 2), ...extra, ...args.slice(2)]; };
  it.each([
    ["a second network", ["--network", "rvi-round"], /network/u],
    ["the host network", ["--network", "host"], /network/u],
    ["privileged", ["--privileged"], /privileged|flag/u],
    ["a capability", ["--cap-add", "NET_ADMIN"], /cap-add|flag/u],
    ["a second mount", ["--volume", "/mnt/workspace:/mnt/workspace"], /volume|mount/u],
    ["the docker socket", ["--volume", "/var/run/docker.sock:/var/run/docker.sock"], /volume|mount|socket/u],
    ["a tmpfs", ["--tmpfs", "/x"], /tmpfs|flag/u],
    ["the host pid namespace", ["--pid", "host"], /pid|flag/u],
    ["a device", ["--device", "/dev/kvm"], /device|flag/u],
    ["root", ["--user", "0:0"], /user/u],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(problems(insert(extra)).join("|")).toMatch(pattern);
  });
  it("refuses a missing no-new-privileges, a missing cap-drop and a different image or name", () => {
    const args = freshSandboxRunArgs(runInput());
    const without = (flag: string) => { const index = args.indexOf(flag); return [...args.slice(0, index), ...args.slice(index + 2)]; };
    expect(problems(without("--security-opt")).join("|")).toMatch(/no-new-privileges/u);
    expect(problems(without("--cap-drop")).join("|")).toMatch(/cap-drop/u);
    expect(problems(args, runInput({ image: "other:img" })).join("|")).toMatch(/image/u);
    expect(problems(args, runInput({ name: "agentx-fresh-other" })).join("|")).toMatch(/name/u);
  });
});

/** A repository at `root/repo` with a committed tree and every kind of thing a clean export must leave out. */
function plantedRepository() {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nbuild-output.txt\n");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  symlinkSync("tracked.txt", join(repo, "link-to-tracked"));
  git(repo, "add", "-A");
  // a submodule entry (gitlink), without a second repository
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor-sub`);
  git(repo, "commit", "--quiet", "-m", "candidate");
  // what the agent left behind, none of which is in the commit
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  writeFileSync(join(repo, "build-output.txt"), "ignored\n");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "// edited by the agent\n");
  writeFileSync(join(repo, "tracked.txt"), "edited after the commit\n");
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho poisoned\n", { mode: 0o755 });
  writeFileSync(join(root, "outside-the-repo.txt"), "workspace file\n");
  return { repo, commitSha: git(repo, "rev-parse", "HEAD"), treeSha: git(repo, "rev-parse", "HEAD^{tree}") };
}
const walk = (directory: string, base = directory): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path, base) : [path.slice(base.length + 1)];
});

describe("the clean export of the candidate commit", () => {
  const signal = () => new AbortController().signal;
  it("holds the committed regular files only: no untracked, ignored or edited file, no hook, no agent-edited node_modules; the symlink and the submodule are reported", async () => {
    const planted = plantedRepository();
    const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(),
      repositories: [{ repositoryId: "repo", path: "repo", directory: planted.repo, commitSha: planted.commitSha, treeSha: planted.treeSha }] });
    if (!exported.ok) throw new Error(`export refused: ${exported.reason}`);
    // the export is a new directory, never the working root, and the working sandbox's masked state directory holds it
    expect(exported.directory).not.toBe(root);
    expect(exported.directory.startsWith(join(root, ".agentx", "fresh-check") + "/")).toBe(true);
    expect(walk(exported.directory).sort()).toEqual([".gitignore", "repo/.gitignore", "repo/run.sh", "repo/src/app.js", "repo/tracked.txt"].filter((path) => path !== ".gitignore").sort());
    expect(readFileSync(join(exported.directory, "repo", "tracked.txt"), "utf8")).toBe("committed\n");
    expect((lstatSync(join(exported.directory, "repo", "run.sh")).mode & 0o111) !== 0).toBe(true);
    expect(existsSync(join(exported.directory, "repo", ".git"))).toBe(false);
    expect(existsSync(join(exported.directory, "outside-the-repo.txt"))).toBe(false);
    expect(exported.skipped.map((entry) => [entry.repositoryId, entry.path, entry.mode]).sort()).toEqual([["repo", "link-to-tracked", "120000"], ["repo", "vendor-sub", "160000"]]);
    await removeFreshExport(root, exported.directory);
    expect(existsSync(exported.directory)).toBe(false);
  });
  it("a second export of the same task is a new directory", async () => {
    const planted = plantedRepository();
    const input = { rootPath: root, taskId: "t1", signal: signal(), repositories: [{ repositoryId: "repo", path: "repo", directory: planted.repo, commitSha: planted.commitSha, treeSha: planted.treeSha }] };
    const first = await exportCandidateForFreshRound(input);
    const second = await exportCandidateForFreshRound(input);
    if (!first.ok || !second.ok) throw new Error("export refused");
    expect(first.directory).not.toBe(second.directory);
  });
  it("refuses a tree that does not match the admitted tree, writing nothing", async () => {
    const planted = plantedRepository();
    const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(),
      repositories: [{ repositoryId: "repo", path: "repo", directory: planted.repo, commitSha: planted.commitSha, treeSha: "b".repeat(40) }] });
    expect(exported).toEqual({ ok: false, reason: "tree_changed" });
    expect(existsSync(join(root, ".agentx", "fresh-check")) ? readdirSync(join(root, ".agentx", "fresh-check")).filter((name) => name !== "scratch") : []).toEqual([]);
  });
  it("refuses a repository path that leaves the workspace", async () => {
    const planted = plantedRepository();
    for (const path of ["../escape", "/abs", "a/../../b", ""]) {
      const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(),
        repositories: [{ repositoryId: "repo", path, directory: planted.repo, commitSha: planted.commitSha, treeSha: planted.treeSha }] });
      expect(exported, path).toEqual({ ok: false, reason: "export_failed" });
    }
  });
  const repositoryOf = (planted: ReturnType<typeof plantedRepository>) => [{ repositoryId: "repo", path: "repo", directory: planted.repo, commitSha: planted.commitSha, treeSha: planted.treeSha }];
  const left = () => (existsSync(join(root, ".agentx", "fresh-check")) ? readdirSync(join(root, ".agentx", "fresh-check")).filter((name) => name !== "scratch") : []);
  it("a repository over the caps is refused in plain words, never cut (files, one file, the total, the disk)", async () => {
    const planted = plantedRepository();
    const attempt = (caps: Parameters<typeof exportCandidateForFreshRound>[0]["caps"]) => exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: repositoryOf(planted), caps });
    expect(await attempt({ maxFiles: 1 })).toEqual({ ok: false, reason: "too_large" });
    expect(await attempt({ maxFileBytes: 5 })).toEqual({ ok: false, reason: "too_large" });
    expect(await attempt({ maxTotalBytes: 10 })).toEqual({ ok: false, reason: "too_large" });
    expect(await attempt({ diskMarginBytes: Number.MAX_SAFE_INTEGER })).toEqual({ ok: false, reason: "no_space" });
    expect(FRESH_NOT_RUN_SENTENCES.too_large).toBe("not run: the repository is too large for a fresh check sandbox");
    expect(left()).toEqual([]);
  });
  it("the lane's own caps are 100,000 files, 1 GiB in all and 100 MiB a file", () => {
    expect(FRESH_EXPORT_CAPS).toMatchObject({ maxFiles: 100_000, maxTotalBytes: 1024 ** 3, maxFileBytes: 100 * 1024 ** 2 });
  });

  // H1a: the object store is agent-writable. Every swap below keeps the id and changes the bytes; git itself answers them with exit 0.
  const objectPath = (repo: string, sha: string) => join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  function swapLoose(repo: string, sha: string, type: "blob" | "tree", content: Buffer) {
    const path = objectPath(repo, sha);
    chmodSync(join(repo, ".git", "objects", sha.slice(0, 2)), 0o755);
    rmSync(path, { force: true });
    writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content])), { mode: 0o644 });
  }
  const refusedWith = async (planted: ReturnType<typeof plantedRepository>, reason: string) => {
    expect(await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: repositoryOf(planted) })).toEqual({ ok: false, reason });
    expect(left()).toEqual([]);
  };
  it("H1a: a blob swapped under the same id is refused, not exported", async () => {
    const planted = plantedRepository();
    // the control: git still answers for the swapped object
    swapLoose(planted.repo, git(planted.repo, "rev-parse", "HEAD:src/app.js"), "blob", Buffer.from("module.exports = 'EVIL';\n"));
    expect(git(planted.repo, "cat-file", "-p", "HEAD:src/app.js")).toContain("EVIL");
    await refusedWith(planted, "corrupt");
  });
  it("H1a: a tree swapped under the same id is refused", async () => {
    const planted = plantedRepository();
    swapLoose(planted.repo, git(planted.repo, "rev-parse", "HEAD:src"), "tree", Buffer.concat([Buffer.from("100644 other.js\0"), Buffer.alloc(20, 1)]));
    await refusedWith(planted, "corrupt");
  });
  it("H1a: the commit swapped under the same id is refused", async () => {
    const planted = plantedRepository();
    swapLoose(planted.repo, planted.commitSha, "blob", Buffer.from("x"));
    await refusedWith(planted, "corrupt");
  });
  it("L2: a missing object is reported as missing or corrupt, not as 'too large'", async () => {
    const planted = plantedRepository();
    rmSync(objectPath(planted.repo, git(planted.repo, "rev-parse", "HEAD:src/app.js")));
    await refusedWith(planted, "corrupt");
    expect(FRESH_NOT_RUN_SENTENCES.corrupt).not.toMatch(/too large/u);
  });
  it("L2: a missing tree or commit object is reported as missing or corrupt too", async () => {
    const tree = plantedRepository();
    rmSync(objectPath(tree.repo, git(tree.repo, "rev-parse", "HEAD:src")));
    await refusedWith(tree, "corrupt");
  });
  it("H1a: an alternates file the agent wrote cannot supply swapped objects", async () => {
    const planted = plantedRepository();
    const sha = git(planted.repo, "rev-parse", "HEAD:src/app.js");
    const evil = join(root, "evil-objects");
    mkdirSync(join(evil, sha.slice(0, 2)), { recursive: true });
    writeFileSync(join(evil, sha.slice(0, 2), sha.slice(2)), deflateSync(Buffer.from("blob 5\0EVIL!")));
    rmSync(objectPath(planted.repo, sha));
    mkdirSync(join(planted.repo, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(planted.repo, ".git", "objects", "info", "alternates"), `${evil}\n`);
    await refusedWith(planted, "corrupt");
  });
  it("L5: an export a check left with 0000 and 0555 folders is still removed", async () => {
    const planted = plantedRepository();
    const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: repositoryOf(planted) });
    if (!exported.ok) throw new Error("export refused");
    mkdirSync(join(exported.directory, "repo", "locked", "inner"), { recursive: true });
    writeFileSync(join(exported.directory, "repo", "locked", "inner", "f"), "x");
    mkdirSync(join(exported.directory, "repo", "readonly"));
    writeFileSync(join(exported.directory, "repo", "readonly", "f"), "x");
    chmodSync(join(exported.directory, "repo", "locked", "inner"), 0o000);
    chmodSync(join(exported.directory, "repo", "locked"), 0o000);
    chmodSync(join(exported.directory, "repo", "readonly"), 0o555);
    chmodSync(join(exported.directory, "repo", "src"), 0o555);
    await removeFreshExport(root, exported.directory);
    expect(existsSync(exported.directory)).toBe(false);
  });
  it("every refusal sentence starts with 'not run' and never says sealed without 'not'", () => {
    for (const sentence of Object.values(FRESH_NOT_RUN_SENTENCES)) {
      expect(sentence.startsWith("not run")).toBe(true);
      expect(/(?<!not )sealed/iu.test(sentence)).toBe(false);
    }
  });
});
