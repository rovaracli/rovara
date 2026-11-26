// "Local gate only" tests: tests that judge this repository against its real release tags and older commits, or against a Rovara Code clone. CI's checkout (the public CI copy, depth 2, no tags,
// no Code clone) can hold none of them, so in CI such a test SKIPS, and says so: ONE stderr line `LOCAL-GATE-ONLY: <file> skipped ...` per file, which anyone can grep and count. It never skips silently.
// The local gate (briefs/lead4/light-gate.sh, CLOUD=1) finds every such file by the marker line below and runs it with ROVARA_REQUIRE_GIT_HISTORY=1; under that variable a missing tag, commit or
// Code clone THROWS instead of skipping, so a skip there fails the gate.
//
// A test file declares itself with this comment line at the top (the gate greps for it at the start of a line):
//   // @local-gate-only: <what it needs>
// and gates its describe with `localGateOnly(import.meta.filename, { tags, commits, codeCommits })` (see tests/contract/pipeline-rollback-floors-real-git.review.test.ts).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { inCi } from "./gitleaks-required.ts";

/** The line a local-gate-only test file starts with; the light gate greps `^// @local-gate-only`. */
export const LOCAL_GATE_ONLY_MARKER = "// @local-gate-only";
/** Set by the local gate: a missing need is then a failure, not a skip. */
export const REQUIRE_ENV = "ROVARA_REQUIRE_GIT_HISTORY";
/** The Code clone, named the way the release pipeline names it. */
export const CODE_REPO_ENV = "ROVARA_CODE_REPO";
/** Every skip line starts with this; the gate counts them. */
export const SKIP_PREFIX = "LOCAL-GATE-ONLY:";

export interface LocalGateNeeds {
  /** Release tags of this repository that must resolve to a commit. */
  readonly tags?: readonly string[];
  /** Commits of this repository that must be present and comparable (`git merge-base --is-ancestor`) with every tag above. */
  readonly commits?: readonly string[];
  /** Commits that must be present in the Rovara Code clone named by ROVARA_CODE_REPO (which must be set). */
  readonly codeCommits?: readonly string[];
}

/** Runs `git <args>` (in `cwd`, default the current directory) and returns its exit status (null when git could not start). */
export type GitStatus = (args: readonly string[], cwd?: string) => number | null;

const realGit: GitStatus = (args, cwd) => spawnSync("git", [...args], { stdio: "ignore", ...(cwd === undefined ? {} : { cwd }) }).status;
type Env = Readonly<Record<string, string | undefined>>;
const isOn = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** What the checkout lacks, one plain sentence each; empty when the test can run. Exit status 1 of `--is-ancestor` is a real answer ("no"); anything else is missing history. */
export function missingNeeds(needs: LocalGateNeeds, env: Env = process.env, git: GitStatus = realGit): string[] {
  const missing: string[] = [];
  const tags: string[] = [];
  const commits: string[] = [];
  for (const tag of needs.tags ?? []) { if (git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]) === 0) tags.push(tag); else missing.push(`the tag ${tag} is missing`); }
  for (const sha of new Set(needs.commits ?? [])) { if (git(["cat-file", "-e", `${sha}^{commit}`]) === 0) commits.push(sha); else missing.push(`the commit ${sha.slice(0, 12)} is missing`); }
  for (const tag of tags) for (const sha of commits) {
    const status = git(["merge-base", "--is-ancestor", sha, tag]);
    if (status !== 0 && status !== 1) missing.push(`git cannot tell whether ${sha.slice(0, 12)} is an ancestor of ${tag}: the history between them is missing`);
  }
  if ((needs.codeCommits ?? []).length > 0) {
    const repo = env[CODE_REPO_ENV];
    if (repo === undefined || repo === "") missing.push(`${CODE_REPO_ENV} is not set (a Rovara Code clone)`);
    else for (const sha of new Set(needs.codeCommits)) if (git(["cat-file", "-e", `${sha}^{commit}`], repo) !== 0) missing.push(`the Code commit ${sha.slice(0, 12)} is not in the clone at ${CODE_REPO_ENV}`);
  }
  return missing;
}

/**
 * True when every need is there. When one is not: with ROVARA_REQUIRE_GIT_HISTORY set (the local gate) it THROWS; otherwise it returns false after ONE counted line on stderr
 * (`LOCAL-GATE-ONLY: <file> skipped in CI: ...`, or `skipped here:` on a developer machine), so the caller skips its describe.
 */
export function localGateOnly(file: string, needs: LocalGateNeeds, env: Env = process.env, git: GitStatus = realGit, note: (text: string) => void = (text) => void process.stderr.write(text)): boolean {
  const missing = missingNeeds(needs, env, git);
  if (missing.length === 0) return true;
  const name = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  if (isOn(env[REQUIRE_ENV])) throw new Error(`${SKIP_PREFIX} ${name} cannot run and ${REQUIRE_ENV} is set, so this is a failure: ${missing.join("; ")}`);
  note(`${SKIP_PREFIX} ${name} skipped ${inCi(env) ? "in CI" : "here"}: ${missing.join("; ")}\n`);
  return false;
}
