import { describe, expect, it } from "vitest";
import { DEFAULT_TAG_PATTERN, checkAncestry, formatReport, parseArgs, tagCommits, type GitPort } from "../../scripts/release-ancestry-check.js";

// The controller's pre-packaging check: every v0.5.<n> tag on the private remote is an ancestor of the integration head. The logic is tested here on fake refs; no git runs.
const sha = (letter: string): string => letter.repeat(40);
const LS_REMOTE = [
  `${sha("1")}\trefs/tags/v0.5.9`, // lightweight tag: only the plain line, and it is the commit
  `${sha("a")}\trefs/tags/v0.5.10`, // annotated tag: the tag object, then the commit on the peeled line
  `${sha("b")}\trefs/tags/v0.5.10^{}`,
  `${sha("c")}\trefs/tags/v0.5.14`,
  `${sha("d")}\trefs/tags/v0.5.14^{}`,
  `${sha("e")}\trefs/tags/v0.5.0-r1`,
  `${sha("f")}\trefs/tags/release-20261101T000000Z-abcdef1`,
  `${sha("0")}\trefs/heads/integ/0515`,
].join("\n");

function fakeGit(options: { ancestors: string[]; present?: string[]; cherry?: Record<string, string[]> }): GitPort {
  return {
    lsRemoteTags: () => LS_REMOTE,
    hasCommit: (commit) => options.present === undefined || options.present.includes(commit),
    isAncestor: (commit) => options.ancestors.includes(commit),
    cherry: (commit) => options.cherry?.[commit] ?? [],
  };
}
const PATTERN = new RegExp(DEFAULT_TAG_PATTERN, "u");

describe("tagCommits", () => {
  it("takes the peeled commit for an annotated tag, the plain one for a lightweight tag, and only tags matching the pattern", () => {
    expect(tagCommits(LS_REMOTE, PATTERN)).toEqual([
      { tag: "v0.5.9", commit: sha("1") },
      { tag: "v0.5.10", commit: sha("b") },
      { tag: "v0.5.14", commit: sha("d") },
    ]);
  });

  it("orders tags by version number, not text (v0.5.9 before v0.5.10)", () => {
    expect(tagCommits(LS_REMOTE, PATTERN).map(({ tag }) => tag)).toEqual(["v0.5.9", "v0.5.10", "v0.5.14"]);
  });

  it("skips branches, release-<timestamp> tags and the pre-release suffix tag by default, and a wider pattern takes them", () => {
    expect(tagCommits(LS_REMOTE, PATTERN).map(({ tag }) => tag)).not.toContain("v0.5.0-r1");
    expect(tagCommits(LS_REMOTE, /^v0\.5\./u).map(({ tag }) => tag)).toContain("v0.5.0-r1");
  });
});

describe("checkAncestry", () => {
  it("passes when every release tag's commit is an ancestor of the head", () => {
    const result = checkAncestry(fakeGit({ ancestors: [sha("1"), sha("b"), sha("d")] }), PATTERN);
    expect(result.missing).toEqual([]);
    expect(result.checked).toHaveLength(3);
    expect(formatReport(result, "private/integ/0515")).toMatch(/^OK: all 3 release tags \(v0\.5\.9 \.\. v0\.5\.14\) are ancestors of private\/integ\/0515\./u);
  });

  it("fails on the 0.5.15 case: v0.5.14 is not an ancestor, and the commits it has that the head lacks are printed", () => {
    const cherry = { [sha("d")]: [`+ ${sha("4")} Fix: sign-in function may read SLACK_TEAM# on the State table`, `+ ${sha("5")} Fix: Slack image copies and builds @agentx/cloud-contracts`] };
    const result = checkAncestry(fakeGit({ ancestors: [sha("1"), sha("b")], cherry }), PATTERN);
    expect(result.missing).toEqual([{ tag: "v0.5.14", commit: sha("d"), cherry: cherry[sha("d")] }]);
    const report = formatReport(result, "private/integ/0515");
    expect(report).toContain("FAIL: 1 of 3 release tags are not ancestors of private/integ/0515");
    expect(report).toContain(`v0.5.14 (${sha("d")}) is not an ancestor`);
    expect(report).toContain(`  + ${sha("4")} Fix: sign-in function may read SLACK_TEAM#`);
    expect(report).toContain(`  + ${sha("5")} Fix: Slack image copies and builds @agentx/cloud-contracts`);
    expect(report).not.toContain("v0.5.9 (");
  });

  it("lists every missing tag, and says so when git cherry has nothing to print (patch-equal commits, history still unmerged)", () => {
    const result = checkAncestry(fakeGit({ ancestors: [] }), PATTERN);
    expect(result.missing.map(({ tag }) => tag)).toEqual(["v0.5.9", "v0.5.10", "v0.5.14"]);
    expect(formatReport(result, "HEAD")).toContain("git cherry printed nothing");
  });

  it("throws, instead of calling a tag missing, when a tag's commit is not in the clone", () => {
    expect(() => checkAncestry(fakeGit({ ancestors: [], present: [sha("1"), sha("b")] }), PATTERN)).toThrow(/does not have \(run git fetch <remote> --tags\): v0\.5\.14 d{40}/u);
  });

  it("throws when no tag matches (a wrong remote must not read as a pass)", () => {
    expect(() => checkAncestry(fakeGit({ ancestors: [] }), /^v9\./u)).toThrow(/no release tag on the remote matches/u);
  });
});

describe("parseArgs", () => {
  it("defaults to the private remote, HEAD and the v0.5.<n> pattern", () => {
    const parsed = parseArgs([]);
    expect(parsed).toMatchObject({ remote: "private", head: "HEAD" });
    expect(parsed.pattern.test("v0.5.14")).toBe(true);
    expect(parsed.pattern.test("v0.5.14-rc1")).toBe(false);
  });

  it("takes --remote, --head and --pattern, and refuses anything else", () => {
    expect(parseArgs(["--remote", "origin", "--head", "private/integ/0515", "--pattern", "^v0\\.6\\."])).toMatchObject({ remote: "origin", head: "private/integ/0515" });
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/usage/u);
    expect(() => parseArgs(["--head"])).toThrow(/usage/u);
    expect(() => parseArgs(["head", "x"])).toThrow(/usage/u);
  });
});
