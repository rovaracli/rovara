// What a release (and the synthesis kit made from it) is built from: one commit, a clean checkout, and build output that is not older than the source it was built from.
// `git status` leaves out ignored files, but the infrastructure imports the workspace packages through their gitignored `dist/` folders, so a local `dist/` built from other source (or an ignored
// file that changes what is built) would be in the release and in the kit while the tree "is clean". This module reads both.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Where the working tree stands. The two optional reads are skipped by a test double that does not give them. */
export interface SourceState {
  head(): string;
  /** Files that differ from the commit: modified, staged, or untracked and not ignored. */
  dirtyFiles(): string[];
  /** Ignored files and folders that are not build output or tooling (see ALLOWED_IGNORED): they can change what is built, and are in no commit. */
  unexpectedIgnoredFiles?(): string[];
  /** Build output folders (`dist/`) whose newest file is older than the newest source file beside them: built from other source. */
  staleBuildOutputs?(): string[];
}

/**
 * Ignored paths that are build output or the tool's own working files. A path whose folder is named in the first list, or that ends in one of the endings, is expected in a checkout that
 * has been built; anything else that is ignored is refused.
 */
const ALLOWED_IGNORED_FOLDERS = new Set(["node_modules", "dist", "build", "coverage", "cdk.out", ".release-synth", ".test-build", ".the-loop", ".agentx", ".codex", ".vscode", ".idea", ".superpowers"]);
const ALLOWED_IGNORED_ENDINGS = [".tsbuildinfo", ".log", ".tmp", ".swp", ".DS_Store", "Thumbs.db"];
export function isExpectedIgnoredPath(path: string): boolean {
  const clean = path.replace(/\/$/u, "");
  return clean.split("/").some((segment) => ALLOWED_IGNORED_FOLDERS.has(segment)) || ALLOWED_IGNORED_ENDINGS.some((ending) => clean.endsWith(ending)) || clean.startsWith("docs/") || clean === "docs" || clean.startsWith("tests/eval/results");
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|css|html)$/u;

export function gitSourceState(cwd: string): SourceState {
  const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ignored = (): string[] => git("status", "--porcelain", "--ignored").split("\n").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
  return {
    head: () => git("rev-parse", "HEAD").trim(),
    dirtyFiles: () => git("status", "--porcelain").split("\n").filter((line) => line !== ""),
    unexpectedIgnoredFiles: () => ignored().filter((path) => !isExpectedIgnoredPath(path)),
    staleBuildOutputs: () => {
      const stale: string[] = [];
      const tracked = git("ls-files", "-z").split("\0").filter((path) => SOURCE_FILE.test(path));
      for (const output of ignored().filter((path) => /(?:^|\/)dist\/$/u.test(path))) {
        const owner = output.slice(0, -"dist/".length);
        const newestOutput = newestModified(git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", output).split("\0").filter((path) => path !== ""), cwd);
        const newestSource = newestModified(tracked.filter((path) => path.startsWith(owner) && !path.startsWith(output)), cwd);
        // A package with no output file, or one whose source is newer than its newest output, was not built from this source.
        if (newestOutput === undefined || (newestSource !== undefined && newestSource > newestOutput)) stale.push(output);
      }
      return stale;
    },
  };
}

function newestModified(paths: readonly string[], cwd: string): number | undefined {
  let newest: number | undefined;
  for (const path of paths) {
    try {
      const time = statSync(join(cwd, path)).mtimeMs;
      if (newest === undefined || time > newest) newest = time;
    } catch {
      // a file listed but gone is not a modification time
    }
  }
  return newest;
}

/** A release, and a kit made from it, come from the release's own commit and a clean checkout: otherwise they hold source or build output that is in no commit. */
export function assertSourceIsRelease(source: SourceState, release: { gitCommit: string }): void {
  const head = source.head();
  if (head !== release.gitCommit) throw new Error(`the working tree is at ${head.slice(0, 12)} but the release was built from ${release.gitCommit.slice(0, 12)}; check out the release's commit before making its kit`);
  const dirty = source.dirtyFiles();
  if (dirty.length > 0) throw new Error(`the working tree has ${String(dirty.length)} changed file(s) (${dirty.slice(0, 3).join(", ")}); a kit is made from a clean checkout of the release's commit`);
  assertBuildIsClean(source);
}

/** The release build's own check (no commit to compare with): a clean tree, no ignored file that can change what is built, and build output not older than its source. */
export function assertBuildIsClean(source: SourceState): void {
  const ignored = source.unexpectedIgnoredFiles?.() ?? [];
  if (ignored.length > 0) throw new Error(`the checkout has ${String(ignored.length)} ignored file(s) that can change what is built (${ignored.slice(0, 3).join(", ")}); build from a fresh clone (git clean -xdf, npm ci, npm run build)`);
  const stale = source.staleBuildOutputs?.() ?? [];
  if (stale.length > 0) throw new Error(`build output older than its source (${stale.slice(0, 3).join(", ")}): it was built from other source; run npm run build on this commit`);
}

/** The release build's start: the commit it is built from, after the tree is shown to be clean. */
export function releaseCommitOfCleanTree(source: SourceState): string {
  const dirty = source.dirtyFiles();
  if (dirty.length > 0) throw new Error(`the working tree has ${String(dirty.length)} changed file(s) (${dirty.slice(0, 3).join(", ")}); a release is built from a clean checkout of its commit`);
  assertBuildIsClean(source);
  return source.head();
}
