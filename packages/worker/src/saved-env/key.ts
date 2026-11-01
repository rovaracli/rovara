// Setup and test health SH21 (design setup-test-health.md, section 5.4): the environment key of a project, worked out from its repositories' files.
//
// The key files are the ones whose change makes a saved image wrong: lockfiles, build files, toolchain files and dev container files. Which files they are comes from the detectors' `fullSuiteOn`
// (a detector says what changes the meaning of every test in its language) plus a fixed list below that holds whatever no detector covers yet. A file that matches is hashed by its BYTES, through a
// reader the caller hands in: a lockfile over the detectors' 256 KiB read limit still counts, which is why this does not use the detectors' text reader.
//
// Fail closed: a key file that cannot be hashed, or more key files than a key can hold, gives no key at all (the caller then treats the saved image as out of date), never a key over fewer files.
// Nothing here runs a command, reads a secret's value or keeps a path: the result is one hash.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SAVED_ENV_MAX_KEY_FILES, computeEnvironmentKey, type EnvKeyFile, type EnvironmentKeyInput } from "@agentx/contracts";
import { globRegExp } from "../verification/selection.js";

/** Files whose content decides what a saved environment contains, in every language Rovara knows and a few it does not detect yet. A glob without a slash matches that name in any directory. */
export const SAVED_ENV_FIXED_KEY_GLOBS: readonly string[] = [
  // Node
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc", ".yarnrc.yml", ".nvmrc", ".node-version",
  // Python
  "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "requirements*.txt", ".python-version",
  // Java
  "pom.xml", "mvnw", ".mvn/**", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "gradle.lockfile", "gradle/libs.versions.toml", "gradle/wrapper/gradle-wrapper.properties", "gradlew", ".java-version", ".sdkmanrc",
  // Go, Rust, Ruby, PHP
  "go.mod", "go.sum", "go.work", "go.work.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
  // Brazil
  "Config",
  // Toolchain managers and dev containers
  ".tool-versions", "mise.toml", ".mise.toml", ".devcontainer/**", ".devcontainer.json", "devcontainer.json",
];

/**
 * Never key files, whatever a detector lists: installed dependencies, virtual environments and VCS data (they are what the image holds, not what it was built from), CI configuration (it does not change an image),
 * and test data (it changes often and no dependency lives in it). Replaces, for this one key only: the design's "key files from the detectors' fullSuiteOn", which would otherwise hash `**\/testdata/**` and `.github/**`.
 */
export const SAVED_ENV_KEY_EXCLUDED_GLOBS: readonly string[] = [
  "node_modules/**", "**/node_modules/**", ".git/**", "**/.git/**", ".venv/**", "**/.venv/**", "venv/**", "**/venv/**", "**/site-packages/**", "vendor/**", "**/target/**",
  ".github/**", ".gitlab-ci.yml", "**/testdata/**",
];

/** The longest glob a detector may hand in; a longer one is dropped (a detector's globs are short). */
const GLOB_MAX = 256;

/** `conftest.py` in a glob list means any directory's; a glob with a slash is a path from the root (the same reading as test selection). */
function matches(filePath: string, glob: string): boolean {
  const expression = globRegExp(glob);
  return expression.test(filePath) || (!glob.includes("/") && expression.test(path.posix.basename(filePath)));
}

/** The paths (repository-relative, POSIX) that are key files: matched by a detector's glob or the fixed list, and not excluded. Sorted. */
export function keyFilePaths(paths: readonly string[], detectorGlobs: readonly string[]): string[] {
  const globs = [...SAVED_ENV_FIXED_KEY_GLOBS, ...detectorGlobs.filter((glob) => glob.length > 0 && glob.length <= GLOB_MAX)];
  return [...new Set(paths)].filter((file) => !SAVED_ENV_KEY_EXCLUDED_GLOBS.some((glob) => matches(file, glob)) && globs.some((glob) => matches(file, glob))).sort();
}

export interface KeyRepository {
  /** The project's id for this repository (the test environment's `repositoryId`). */
  repositoryId: string;
  /** Repository-relative POSIX paths, files only (the same list the detectors read). */
  paths: readonly string[];
  /** sha256 hex of the file's bytes, or undefined when the file cannot be read as a regular file. Never throws. */
  hashFile(filePath: string): Promise<string | undefined>;
}

export interface EnvironmentKeyRequest {
  repositories: readonly KeyRepository[];
  /** `Detection.fullSuiteOn` values from the detectors. */
  detectorGlobs: readonly string[];
  testEnvRevision: number;
  /** The NAMES of the project's secrets; never values. */
  secretNames: readonly string[];
  baseImageDigest: string;
}

export type EnvironmentKeyResult =
  | { ok: true; key: string; keyFileCount: number }
  | { ok: false; reason: "too_many_key_files" | "key_file_unreadable" | "invalid_input" };

export async function environmentKeyFromRepositories(request: EnvironmentKeyRequest): Promise<EnvironmentKeyResult> {
  const selected = request.repositories.map((repository) => ({ repository, files: keyFilePaths(repository.paths, request.detectorGlobs) }));
  if (selected.reduce((sum, item) => sum + item.files.length, 0) > SAVED_ENV_MAX_KEY_FILES) return { ok: false, reason: "too_many_key_files" };
  const keyFiles: EnvKeyFile[] = [];
  for (const { repository, files } of selected) {
    for (const file of files) {
      let hash: string | undefined;
      try { hash = await repository.hashFile(file); } catch { hash = undefined; }
      if (hash === undefined) return { ok: false, reason: "key_file_unreadable" };
      keyFiles.push({ repositoryId: repository.repositoryId, path: file, sha256: hash });
    }
  }
  const input: EnvironmentKeyInput = { keyFiles, testEnvRevision: request.testEnvRevision, secretNames: [...request.secretNames], baseImageDigest: request.baseImageDigest };
  try { return { ok: true, key: computeEnvironmentKey(input), keyFileCount: keyFiles.length }; } catch { return { ok: false, reason: "invalid_input" }; }
}

/** The most bytes of one key file that are hashed; a larger file is unreadable (a key file is a manifest, not data). */
export const SAVED_ENV_KEY_FILE_MAX_BYTES = 64 * 1_048_576;

/**
 * sha256 hex of a file in a repository checkout, or undefined. Only a regular file whose real path is exactly `root/relativePath` is hashed: a symbolic link (as the file or as any directory above it) is refused,
 * so a checkout cannot make the key read a file outside itself.
 */
export async function hashWorkspaceFile(root: string, relativePath: string): Promise<string | undefined> {
  try {
    if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
    const realRoot = await realpath(root);
    const full = path.join(realRoot, relativePath);
    const [info, real] = await Promise.all([lstat(full), realpath(full)]);
    if (!info.isFile() || info.isSymbolicLink() || real !== full || info.size > SAVED_ENV_KEY_FILE_MAX_BYTES) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
