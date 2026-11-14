// TE-B1-fresh: the fresh check sandbox's run arguments (an allow-list in the style of checkSandboxArgProblems) and the clean export of the candidate commit (fresh-check-sandbox.ts). The export tests drive real git.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { WorkspaceSafety, withWorkspaceSafety } from "../../packages/worker/src/workspace-safety.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRESH_EXPORT_CAPS, FreshExportError, materializeVerified } from "../../packages/worker/src/fresh-check-export.js";
import {
  FRESH_SWEEP_LIMITS, sweepFreshExports, FRESH_NOT_RUN_SENTENCES, FRESH_SANDBOX_ROUND_LABEL, exportCandidateForFreshRound, freshSandboxArgProblems, freshSandboxRunArgs, removeFreshExport, type FreshSandboxRunInput,
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
    expect(FRESH_EXPORT_CAPS.maxTreeBytes).toBeLessThanOrEqual(4 * 1024 ** 2);
    expect(FRESH_EXPORT_CAPS.maxTreeBytesTotal).toBeLessThanOrEqual(32 * 1024 ** 2);
    expect(FRESH_EXPORT_CAPS.maxTreeEntries).toBeLessThanOrEqual(200_000);
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
  // ---- the second review: memory, caps across repositories, errors, links
  /** Writes a loose object by hand (the way an agent with write access to .git/objects can) and returns its id. */
  function looseObject(repo: string, type: "blob" | "tree" | "commit", content: Buffer): string {
    const body = Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content]);
    const sha = createHash("sha1").update(body).digest("hex");
    const dirPath = join(repo, ".git", "objects", sha.slice(0, 2));
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, sha.slice(2)), deflateSync(body), { mode: 0o644 });
    return sha;
  }
  const treeOf = (entries: Array<{ mode: string; name: string; sha: string }>) => Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, "hex")]));
  const commitOf = (repo: string, tree: string) => looseObject(repo, "commit", Buffer.from(`tree ${tree}\nauthor t <t@e.test> 1 +0000\ncommitter t <t@e.test> 1 +0000\n\nm\n`));
  function emptyRepository() {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    return repo;
  }

  it("MEDIUM: a tiny repository whose one tree has a huge name, referenced 16 times, is refused before it is read, and memory stays small", async () => {
    const repo = emptyRepository();
    const blob = looseObject(repo, "blob", Buffer.from("x"));
    const huge = looseObject(repo, "tree", treeOf([{ mode: "100644", name: "a".repeat(40 * 1024 * 1024), sha: blob }]));
    const rootTree = looseObject(repo, "tree", treeOf(Array.from({ length: 16 }, (_unused, index) => ({ mode: "40000", name: `d${String(index)}`, sha: huge }))));
    const commit = commitOf(repo, rootTree);
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
    try {
      const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [{ repositoryId: "repo", path: "repo", directory: repo, commitSha: commit, treeSha: rootTree }] });
      expect(exported).toEqual({ ok: false, reason: "too_large" });
    } finally { clearInterval(sampler); }
    expect(peak - before).toBeLessThan(96 * 1024 * 1024);
    expect(left()).toEqual([]);
  });
  it("a 16 MiB tree of tiny entries is refused unread, and parsing an entry-heavy tree stops at the entry budget: memory stays small", async () => {
    const repo = emptyRepository();
    const unit = Buffer.concat([Buffer.from("100644 a\0"), Buffer.alloc(20, 7)]);
    const count = Math.floor((16 * 1024 * 1024) / unit.length);
    const bytes = Buffer.alloc(count * unit.length);
    for (let index = 0; index < count; index += 1) unit.copy(bytes, index * unit.length);
    const heavy = looseObject(repo, "tree", bytes);
    const rootTree = looseObject(repo, "tree", treeOf([{ mode: "40000", name: "d0", sha: heavy }]));
    const commit = commitOf(repo, rootTree);
    const measure = async (caps: Parameters<typeof exportCandidateForFreshRound>[0]["caps"]) => {
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
      try {
        const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [{ repositoryId: "repo", path: "repo", directory: repo, commitSha: commit, treeSha: rootTree }], caps });
        return { exported, growth: peak - before };
      } finally { clearInterval(sampler); }
    };
    // by the lane's own caps: refused by size before it is read
    const sized = await measure(undefined);
    expect(sized.exported).toEqual({ ok: false, reason: "too_large" });
    expect(sized.growth).toBeLessThan(96 * 1024 * 1024);
    // with the size caps lifted (a tree this size could be admitted by a later change), the entry budget stops the parse early
    const parsed = await measure({ maxTreeBytes: 64 * 1024 * 1024, maxTreeBytesTotal: 64 * 1024 * 1024, maxTreeEntries: 1_000 });
    expect(parsed.exported).toEqual({ ok: false, reason: "too_large" });
    expect(parsed.growth).toBeLessThan(96 * 1024 * 1024);
    expect(left()).toEqual([]);
  });
  it("a tree is read once however many times it is referenced, and the bytes of all trees are capped", async () => {
    const repo = emptyRepository();
    const blob = looseObject(repo, "blob", Buffer.from("x"));
    const small = looseObject(repo, "tree", treeOf([{ mode: "100644", name: "f", sha: blob }]));
    const rootTree = looseObject(repo, "tree", treeOf(Array.from({ length: 8 }, (_unused, index) => ({ mode: "40000", name: `d${String(index)}`, sha: small }))));
    const commit = commitOf(repo, rootTree);
    const dest = join(root, "dest-shared");
    mkdirSync(dest);
    const common = { repositoryRoot: repo, commitSha: commit, treeSha: rootTree, destination: dest, scratchRoot: join(root, "scratch"), signal: signal() };
    expect(await materializeVerified({ ...common })).toEqual([]);
    // the 8 references cost the tree's bytes ONCE: 29 bytes for the small tree and 232 for the root fit a cap of 300 only when a tree is read once
    const once = join(root, "dest-once");
    mkdirSync(once);
    expect(await materializeVerified({ ...common, destination: once, caps: { maxTreeBytesTotal: 300 } })).toEqual([]);
    expect(readdirSync(dest).sort()).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]);
    await expect(materializeVerified({ ...common, destination: (() => { const d = join(root, "dest2"); mkdirSync(d); return d; })(), caps: { maxTreeBytesTotal: 10 } })).rejects.toMatchObject({ reason: "too_large" });
    await expect(materializeVerified({ ...common, destination: (() => { const d = join(root, "dest3"); mkdirSync(d); return d; })(), caps: { maxTreeBytes: 10 } })).rejects.toMatchObject({ reason: "too_large" });
  });
  it("a tree entry name over the name cap is refused in fixed words", async () => {
    const repo = emptyRepository();
    // the blob does not exist: only the name cap, which is checked before anything is fetched, gives 'export_failed' here
    const rootTree = looseObject(repo, "tree", treeOf([{ mode: "100644", name: "n".repeat(300), sha: "1".repeat(40) }]));
    expect(await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [{ repositoryId: "repo", path: "repo", directory: repo, commitSha: commitOf(repo, rootTree), treeSha: rootTree }] })).toEqual({ ok: false, reason: "export_failed" });
    expect(left()).toEqual([]);
  });
  it("only a FreshExportError is ever thrown: a path too long for the disk and a duplicate name are mapped", async () => {
    const repo = emptyRepository();
    const blob = looseObject(repo, "blob", Buffer.from("x"));
    let tree = looseObject(repo, "tree", treeOf([{ mode: "100644", name: "f", sha: blob }]));
    for (let depth = 0; depth < 60; depth += 1) tree = looseObject(repo, "tree", treeOf([{ mode: "40000", name: String(depth).padStart(2, "0").repeat(50), sha: tree }]));
    const dest = join(root, "dest-deep");
    mkdirSync(dest);
    await expect(materializeVerified({ repositoryRoot: repo, commitSha: commitOf(repo, tree), treeSha: tree, destination: dest, scratchRoot: join(root, "scratch"), signal: signal() })).rejects.toBeInstanceOf(FreshExportError);
    const other = looseObject(repo, "blob", Buffer.from("y"));
    const dup = looseObject(repo, "tree", treeOf([{ mode: "100644", name: "same", sha: blob }, { mode: "100644", name: "same", sha: other }]));
    const dest2 = join(root, "dest-dup");
    mkdirSync(dest2);
    await expect(materializeVerified({ repositoryRoot: repo, commitSha: commitOf(repo, dup), treeSha: dup, destination: dest2, scratchRoot: join(root, "scratch"), signal: signal() })).rejects.toBeInstanceOf(FreshExportError);
  });
  it("the caps apply to the whole export, across repositories", async () => {
    const planted = plantedRepository();
    const two = (path: string) => ({ repositoryId: path, path, directory: planted.repo, commitSha: planted.commitSha, treeSha: planted.treeSha });
    const one = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [two("a")], caps: { maxFiles: 6 } });
    expect(one.ok).toBe(true);
    if (one.ok) await removeFreshExport(root, one.directory);
    expect(await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [two("a"), two("b")], caps: { maxFiles: 6 } })).toEqual({ ok: false, reason: "too_large" });
    expect(await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: [two("a"), two("b")], caps: { maxTotalBytes: 40 } })).toEqual({ ok: false, reason: "too_large" });
    expect(left()).toEqual([]);
  });
  it("making an export removable never follows a link: a link a check left to a folder outside keeps that folder's mode", async () => {
    const planted = plantedRepository();
    const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: "t1", signal: signal(), repositories: repositoryOf(planted) });
    if (!exported.ok) throw new Error("export refused");
    const outside = join(root, "outside-folder");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    chmodSync(outside, 0o500);
    symlinkSync(outside, join(exported.directory, "repo", "link-to-outside"));
    symlinkSync(join(outside, "keep.txt"), join(exported.directory, "repo", "link-to-file"));
    chmodSync(join(outside, "keep.txt"), 0o400);
    await removeFreshExport(root, exported.directory);
    expect(existsSync(exported.directory)).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
    expect(statSync(join(outside, "keep.txt")).mode & 0o777).toBe(0o400);
    chmodSync(outside, 0o700);
  });
  it("every refusal sentence starts with 'not run' and never says sealed without 'not'", () => {
    for (const sentence of Object.values(FRESH_NOT_RUN_SENTENCES)) {
      expect(sentence.startsWith("not run")).toBe(true);
      expect(/(?<!not )sealed/iu.test(sentence)).toBe(false);
    }
  });
});


describe("landing: bounded crash-export sweep", () => {
  const okDocker = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const parent = () => join(root, ".agentx", "fresh-check");
  const old = (name: string) => {
    const path = join(parent(), name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "report"), "report");
    utimesSync(path, new Date(0), new Date(0));
    return path;
  };
  it("removes old exports only; preserves recent, scratch and outside symlink targets", async () => {
    const stale = old("task-abcdef");
    const scratch = old("scratch");
    const recent = old("task-recent");
    utimesSync(recent, new Date(), new Date());
    const outside = join(root, "outside");
    mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep");
    symlinkSync(outside, join(stale, "link"));
    symlinkSync(outside, join(parent(), "task-link"));
    utimesSync(stale, new Date(0), new Date(0));
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toMatchObject({ kind: "complete", removed: 1 });
    expect(existsSync(stale)).toBe(false);
    for (const path of [scratch, recent, join(outside, "keep"), join(parent(), "task-link")]) expect(existsSync(path)).toBe(true);
  });
  it.each(["busy", "unreadable"] as const)("leaves all exports when Docker is %s, with no echoed error", async (reason) => {
    const stale = old("task-abcdef");
    const result = await sweepFreshExports({ rootPath: root, signal: new AbortController().signal, docker: { run: async () => ({ exitCode: reason === "busy" ? 0 : 1, stdout: "private-input", stderr: "private-input" }) } });
    expect(result).toEqual({ kind: "skipped", reason, removed: 0 });
    expect(existsSync(stale)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-input");
  });
  it("refuses a symlinked parent without touching its target", async () => {
    mkdirSync(join(root, ".agentx"));
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, parent());
    const stale = old("task-abcdef");
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "skipped", reason: "unreadable", removed: 0 });
    expect(existsSync(stale)).toBe(true);
  });
  it("caps TOTAL entries before deletion and completes a large input within a bounded time", async () => {
    const stale = old("task-abcdef");
    for (let i = 0; i < FRESH_SWEEP_LIMITS.maxEntries; i++) writeFileSync(join(stale, `f${i}`), "");
    utimesSync(stale, new Date(0), new Date(0));
    const start = performance.now();
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "skipped", reason: "limit", removed: 0 });
    expect(performance.now() - start).toBeLessThan(5000);
    expect(readdirSync(stale)).toHaveLength(FRESH_SWEEP_LIMITS.maxEntries + 1);
  });
  it("caps total exports and total path bytes before deleting any part", async () => {
    for (let i = 0; i <= FRESH_SWEEP_LIMITS.maxExports; i++) old(`task-${i}`);
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "skipped", reason: "limit", removed: 0 });
    expect(readdirSync(parent())).toHaveLength(FRESH_SWEEP_LIMITS.maxExports + 1);
    rmSync(parent(), { recursive: true });
    const stale = old("task-deep");
    const nested = join(stale, "a".repeat(200), "b".repeat(200), "c".repeat(200));
    mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 1400; i++) writeFileSync(join(nested, `${"f".repeat(200)}${i}`), "");
    utimesSync(stale, new Date(0), new Date(0));
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "skipped", reason: "limit", removed: 0 });
    expect(readdirSync(nested)).toHaveLength(1400);
  });
  it("checks the latch and the directory identity before mutations", async () => {
    const stale = old("task-abcdef");
    let reads = 0;
    const result = await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal, clock: () => {
      if (++reads === 11) { renameSync(stale, join(root, "old-copy")); mkdirSync(stale); writeFileSync(join(stale, "report"), "keep"); }
      return 0;
    } });
    expect(result).toEqual({ kind: "skipped", reason: "unreadable", removed: 0 });
    expect(readFileSync(join(stale, "report"), "utf8")).toBe("keep");
  });
  it("an unsafe workspace is never swept", async () => {
    const stale = old("task-abcdef");
    await withWorkspaceSafety(new WorkspaceSafety(), async () => {
      new RunnerKillUnconfirmedError({ kind: "local" });
      expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "skipped", reason: "unsafe", removed: 0 });
      expect(existsSync(stale)).toBe(true);
    });
  });
  it("the exact entry limit still works", async () => {
    const stale = old("task-abcdef");
    for (let i = 0; i < FRESH_SWEEP_LIMITS.maxEntries - 2; i++) writeFileSync(join(stale, `f${i}`), "");
    utimesSync(stale, new Date(0), new Date(0));
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal })).toEqual({ kind: "complete", removed: 1 });
    expect(existsSync(stale)).toBe(false);
  });
  it("stops before deletion at the total deadline or on cancellation", async () => {
    const stale = old("task-abcdef");
    let clock = 0;
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: new AbortController().signal, clock: () => { clock += FRESH_SWEEP_LIMITS.maxMs; return clock; } })).toEqual({ kind: "skipped", reason: "limit", removed: 0 });
    const stop = new AbortController(); stop.abort();
    expect(await sweepFreshExports({ rootPath: root, docker: okDocker, signal: stop.signal })).toEqual({ kind: "skipped", reason: "stopped", removed: 0 });
    expect(existsSync(stale)).toBe(true);
  });
});
