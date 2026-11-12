// The controller runs this before packaging a release (and before building the next integration branch's release candidate):
//   node scripts/release-ancestry-check.ts [--remote private] [--head <ref>] [--pattern <regex>]
// Every release tag on the private remote (default: v0.5.<n>) must be an ancestor of the integration head. A release tag that is not means commits that
// were installed somewhere (staging, a customer) are missing from the code about to be installed next, and the next install would silently take them out.
// That happened with 0.5.15: integ/0515 branched from 0.5.14's history before its five release fixes (the Slack image build and the sign-in grant), and
// installing it would have removed the live sign-in grant. For each tag that is not an ancestor, this prints the missing commits (`git cherry`) and exits 1.
// Exit codes: 0 every tag is an ancestor, 1 at least one is not, 2 the check itself could not run (bad arguments, no remote, a tag commit not fetched).
// Node's own modules only (Node runs this file directly), and no type syntax that Node's type stripping cannot erase.
import { spawnSync } from "node:child_process";

export const DEFAULT_TAG_PATTERN = "^v0\\.5\\.\\d+$";

export interface TagCommit { tag: string; commit: string }
export interface MissingTag { tag: string; commit: string; cherry: string[] }
export interface AncestryResult { checked: TagCommit[]; missing: MissingTag[] }
/** What the check needs from git, so a test can answer from fake refs. */
export interface GitPort {
  /** The text of `git ls-remote --tags <remote>`. */
  lsRemoteTags: () => string;
  /** Whether the commit exists in this clone (a tag fetched from the remote but never merged is still present only after a fetch). */
  hasCommit: (commit: string) => boolean;
  /** `git merge-base --is-ancestor <commit> <head>`. */
  isAncestor: (commit: string) => boolean;
  /** `git cherry -v <head> <commit>`, one line per commit of the tag that the head lacks ("+ sha subject"; "- sha subject" means a patch-equal commit is already there). */
  cherry: (commit: string) => string[];
}

/** The commit each matching tag points at, from `git ls-remote --tags` output (an annotated tag lists its commit on the peeled `^{}` line; a lightweight tag only has the plain line). */
export function tagCommits(lsRemote: string, pattern: RegExp): TagCommit[] {
  const plain = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/u.exec(line.trim());
    if (match === null) continue;
    (match[3] === undefined ? plain : peeled).set(match[2]!, match[1]!);
  }
  return [...plain.keys()]
    .filter((tag) => pattern.test(tag))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((tag) => ({ tag, commit: peeled.get(tag) ?? plain.get(tag)! }));
}

/** Which release tags are not ancestors of the head, with the commits each is missing. Throws when a tag's commit is not in this clone (fetch first): "not an ancestor" would be a guess. */
export function checkAncestry(git: GitPort, pattern: RegExp): AncestryResult {
  const checked = tagCommits(git.lsRemoteTags(), pattern);
  if (checked.length === 0) throw new Error(`no release tag on the remote matches ${String(pattern)}`);
  const unfetched = checked.filter(({ commit }) => !git.hasCommit(commit));
  if (unfetched.length > 0) throw new Error(`these release tags point at commits this clone does not have (run git fetch <remote> --tags): ${unfetched.map(({ tag, commit }) => `${tag} ${commit}`).join(", ")}`);
  const missing = checked.filter(({ commit }) => !git.isAncestor(commit)).map(({ tag, commit }) => ({ tag, commit, cherry: git.cherry(commit) }));
  return { checked, missing };
}

/** The report the controller reads. */
export function formatReport(result: AncestryResult, head: string): string {
  if (result.missing.length === 0) return `OK: all ${String(result.checked.length)} release tags (${result.checked[0]!.tag} .. ${result.checked.at(-1)!.tag}) are ancestors of ${head}.`;
  const lines = [`FAIL: ${String(result.missing.length)} of ${String(result.checked.length)} release tags are not ancestors of ${head}. Merge each tag's commit into the integration branch before packaging.`];
  for (const { tag, commit, cherry } of result.missing) {
    lines.push("", `${tag} (${commit}) is not an ancestor of ${head}; commits it has that ${head} lacks (git cherry -v ${head} ${commit}; "-" means the same change is already there under another sha):`);
    lines.push(...(cherry.length === 0 ? ["  (git cherry printed nothing: every commit is patch-equal to one already there, but the tag's own history is still not merged)"] : cherry.map((line) => `  ${line}`)));
  }
  return lines.join("\n");
}

function git(args: string[]): { status: number; stdout: string } {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined) throw run.error;
  return { status: run.status ?? 1, stdout: run.stdout };
}

/** The real git behind the port, for one remote and one head. */
export function realGit(remote: string, head: string): GitPort {
  return {
    lsRemoteTags: () => {
      const run = git(["ls-remote", "--tags", remote]);
      if (run.status !== 0) throw new Error(`git ls-remote --tags ${remote} failed (is the remote configured and reachable?)`);
      return run.stdout;
    },
    hasCommit: (commit) => git(["cat-file", "-e", `${commit}^{commit}`]).status === 0,
    isAncestor: (commit) => git(["merge-base", "--is-ancestor", commit, head]).status === 0,
    cherry: (commit) => git(["cherry", "-v", head, commit]).stdout.split("\n").filter((line) => line !== ""),
  };
}

export function parseArgs(argv: readonly string[]): { remote: string; head: string; pattern: RegExp } {
  const options: Record<string, string> = { remote: "private", head: "HEAD", pattern: DEFAULT_TAG_PATTERN };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/u, "");
    const value = argv[index + 1];
    if (name === undefined || !Object.hasOwn(options, name) || !argv[index]!.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`usage: node scripts/release-ancestry-check.ts [--remote private] [--head <ref>] [--pattern <regex>] (got ${argv.join(" ")})`);
    options[name] = value;
  }
  return { remote: options.remote!, head: options.head!, pattern: new RegExp(options.pattern!, "u") };
}

if (process.argv[1]?.endsWith("release-ancestry-check.ts")) {
  try {
    const { remote, head, pattern } = parseArgs(process.argv.slice(2));
    const result = checkAncestry(realGit(remote, head), pattern);
    console.log(formatReport(result, head));
    process.exitCode = result.missing.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`release-ancestry-check could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
