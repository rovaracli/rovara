// Setup and test health SH21: the environment key from a project's repository files (lockfile change changes the key; an unrelated file does not).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SAVED_ENV_MAX_KEY_FILES } from "@agentx/contracts";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import {
  environmentKeyFromRepositories, hashWorkspaceFile, keyFilePaths, type KeyRepository,
} from "../../packages/worker/src/saved-env/key.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
type Files = Record<string, string>;
const repo = (repositoryId: string, files: Files, unreadable: readonly string[] = []): KeyRepository => ({
  repositoryId,
  paths: Object.keys(files),
  hashFile: (file) => Promise.resolve(unreadable.includes(file) || files[file] === undefined ? undefined : sha(files[file])),
});
async function keyOf(files: Files, options: { globs?: readonly string[]; secretNames?: string[]; revision?: number; unreadable?: string[] } = {}) {
  return environmentKeyFromRepositories({
    repositories: [repo("svc", files, options.unreadable)], detectorGlobs: options.globs ?? [], testEnvRevision: options.revision ?? 1, secretNames: options.secretNames ?? [], baseImageDigest: DIGEST,
  });
}
const keyString = async (files: Files, options?: Parameters<typeof keyOf>[1]): Promise<string> => {
  const result = await keyOf(files, options);
  if (!result.ok) throw new Error(result.reason);
  return result.key;
};

const omit = (files: Files, name: string): Files => Object.fromEntries(Object.entries(files).filter(([key]) => key !== name));
const NODE: Files = {
  "package.json": '{"name":"a","dependencies":{"left-pad":"1.0.0"}}',
  "package-lock.json": '{"lockfileVersion":3}',
  "src/index.js": "console.log(1)\n",
  "README.md": "# hello\n",
};

describe("which files are key files", () => {
  it("takes lockfiles, build files, toolchain files and dev container files, and nothing else", () => {
    const paths = ["package.json", "package-lock.json", "src/index.js", "README.md", ".nvmrc", ".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "docs/guide.md", "go.sum", "Cargo.lock"];
    expect(keyFilePaths(paths, [])).toEqual([".devcontainer/Dockerfile", ".devcontainer/devcontainer.json", ".nvmrc", "Cargo.lock", "go.sum", "package-lock.json", "package.json"]);
  });

  it("adds the files a detector's globs name", () => {
    expect(keyFilePaths(["tools/special.cfg", "a.txt"], [])).toEqual([]);
    expect(keyFilePaths(["tools/special.cfg", "a.txt"], ["tools/*.cfg"])).toEqual(["tools/special.cfg"]);
  });

  it("finds a manifest in a nested directory, but never inside installed dependencies, virtual environments, CI configuration or test data", () => {
    const paths = ["services/api/package.json", "node_modules/left-pad/package.json", "web/node_modules/x/package.json", ".venv/lib/site-packages/x/pyproject.toml", ".github/workflows/ci.yml", "pkg/testdata/go.mod", ".git/config"];
    expect(keyFilePaths(paths, ["**/testdata/**", ".github/**", "**"])).toEqual(["services/api/package.json"]);
  });

  it("drops an over-long glob instead of matching with it", () => {
    expect(keyFilePaths(["a.txt"], ["a".repeat(300)])).toEqual([]);
  });
});

describe("the environment key from files", () => {
  it("changes when a lockfile changes", async () => {
    const before = await keyString(NODE);
    const after = await keyString({ ...NODE, "package-lock.json": '{"lockfileVersion":3,"packages":{"x":{}}}' });
    expect(after).not.toBe(before);
  });

  it("does not change when an unrelated file changes, is added or is removed", async () => {
    const before = await keyString(NODE);
    expect(await keyString({ ...NODE, "src/index.js": "console.log(2)\n" })).toBe(before);
    expect(await keyString({ ...NODE, "src/new.js": "x" })).toBe(before);
    expect(await keyString(omit(NODE, "README.md"))).toBe(before);
  });

  it("changes when a key file appears or disappears", async () => {
    const before = await keyString(NODE);
    expect(await keyString({ ...NODE, "yarn.lock": "# yarn" })).not.toBe(before);
    expect(await keyString(omit(NODE, "package-lock.json"))).not.toBe(before);
  });

  it("does not depend on the order paths are listed in", async () => {
    const shuffled = Object.fromEntries(Object.entries(NODE).reverse());
    expect(await keyString(shuffled)).toBe(await keyString(NODE));
  });

  it("changes with the revision, the secret names and the base image, and ignores the order of secret names", async () => {
    const key = await keyString(NODE, { secretNames: ["A", "B"], revision: 2 });
    expect(await keyString(NODE, { secretNames: ["B", "A"], revision: 2 })).toBe(key);
    expect(await keyString(NODE, { secretNames: ["A", "B"], revision: 3 })).not.toBe(key);
    expect(await keyString(NODE, { secretNames: ["A"], revision: 2 })).not.toBe(key);
    const other = await environmentKeyFromRepositories({ repositories: [repo("svc", NODE)], detectorGlobs: [], testEnvRevision: 2, secretNames: ["A", "B"], baseImageDigest: `sha256:${"b".repeat(64)}` });
    expect(other.ok && other.key).not.toBe(key);
  });

  it("counts the same path in two repositories separately", async () => {
    const both = await environmentKeyFromRepositories({ repositories: [repo("one", { "package.json": "1" }), repo("two", { "package.json": "2" })], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST });
    const swapped = await environmentKeyFromRepositories({ repositories: [repo("one", { "package.json": "2" }), repo("two", { "package.json": "1" })], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST });
    expect(both.ok && swapped.ok).toBe(true);
    expect(both.ok && swapped.ok && both.key !== swapped.key).toBe(true);
  });

  it("gives no key when a key file cannot be hashed (it never keys over fewer files)", async () => {
    expect(await keyOf(NODE, { unreadable: ["package-lock.json"] })).toEqual({ ok: false, reason: "key_file_unreadable" });
  });

  it("gives no key when a hasher throws", async () => {
    const throwing: KeyRepository = { repositoryId: "svc", paths: ["package.json"], hashFile: () => Promise.reject(new Error("disk")) };
    expect(await environmentKeyFromRepositories({ repositories: [throwing], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST })).toEqual({ ok: false, reason: "key_file_unreadable" });
  });

  it("gives no key over more key files than a key holds", async () => {
    const files = Object.fromEntries(Array.from({ length: SAVED_ENV_MAX_KEY_FILES + 1 }, (_, index) => [`d${String(index)}/package.json`, "x"]));
    expect(await keyOf(files)).toEqual({ ok: false, reason: "too_many_key_files" });
  });

  it("reports an invalid input (a bad revision) as a reason, not a crash", async () => {
    expect(await keyOf(NODE, { revision: 0 })).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("uses the lists the detectors build (a nested Maven module's pom changes the key)", async () => {
    const files: Files = { "pom.xml": "<project><modules><module>a</module></modules></project>", "a/pom.xml": "<project>1</project>", "a/src/Main.java": "class Main {}" };
    const bounded = boundedReader(Object.keys(files), (file) => Promise.resolve(files[file]));
    const detection = await runDetectors(bounded.reader, "svc");
    const globs = detection.fullSuiteOn.map((item) => item.value);
    expect(globs.length).toBeGreaterThan(0);
    const before = await keyString(files, { globs });
    expect(await keyString({ ...files, "a/pom.xml": "<project>2</project>" }, { globs })).not.toBe(before);
    expect(await keyString({ ...files, "a/src/Main.java": "class Main { int x; }" }, { globs })).toBe(before);
  });
});

describe("hashing a file in a checkout", () => {
  const made: string[] = [];
  afterEach(async () => { await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  async function checkout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "saved-env-key-"));
    made.push(dir);
    return dir;
  }

  it("hashes the bytes of a regular file, even one over the detectors' read limit", async () => {
    const root = await checkout();
    await mkdir(path.join(root, "sub"));
    const big = "x".repeat(300 * 1_024);
    await writeFile(path.join(root, "sub", "package-lock.json"), big);
    expect(await hashWorkspaceFile(root, "sub/package-lock.json")).toBe(sha(big));
  });

  it("refuses a missing file, a directory, an escaping path and an absolute path", async () => {
    const root = await checkout();
    await mkdir(path.join(root, "dir"));
    expect(await hashWorkspaceFile(root, "nope.txt")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "dir")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "../x")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "/etc/hosts")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "a//b")).toBeUndefined();
  });

  it("refuses a symbolic link as the file and as a directory above it", async () => {
    const root = await checkout();
    const outside = await checkout();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "package.json"));
    await symlink(outside, path.join(root, "linked"));
    expect(await hashWorkspaceFile(root, "package.json")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "linked/secret.txt")).toBeUndefined();
  });
});
