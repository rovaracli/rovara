import { describe, expect, it } from "vitest";
import { localGateOnly, missingNeeds, REQUIRE_ENV, SKIP_PREFIX, type GitStatus } from "../support/local-gate-only.ts";

const SHA = "a".repeat(40);
const CODE_SHA = "b".repeat(40);
const CODE = "/code";
const have = (tags: readonly string[], commits: readonly string[], ancestry: number | null = 1, codeCommits: readonly string[] = []): GitStatus => (args, cwd) => {
  if (args[0] === "rev-parse") return tags.some((tag) => args.includes(`${tag}^{commit}`)) ? 0 : 1;
  if (args[0] === "cat-file") return (cwd === CODE ? codeCommits : commits).some((sha) => args.includes(`${sha}^{commit}`)) ? 0 : 128;
  return ancestry;
};
const needs = { tags: ["v1", "v2"], commits: [SHA] };
const none = () => undefined;

describe("tests that need release tags, history or a Code clone say so when they skip, and fail where the local gate demands them", () => {
  it("is satisfied when every tag and commit is there and comparable (both is-ancestor answers, 0 and 1, count)", () => {
    expect(missingNeeds(needs, {}, have(["v1", "v2"], [SHA], 0))).toEqual([]);
    expect(missingNeeds(needs, {}, have(["v1", "v2"], [SHA], 1))).toEqual([]);
  });

  it("names each missing tag and commit", () => {
    expect(missingNeeds(needs, {}, have(["v1"], []))).toEqual(["the tag v2 is missing", `the commit ${SHA.slice(0, 12)} is missing`]);
  });

  it("treats a failing is-ancestor (shallow history) as missing, not as 'no'", () => {
    expect(missingNeeds(needs, {}, have(["v1", "v2"], [SHA], 128))).toHaveLength(2);
    expect(missingNeeds(needs, {}, have(["v1", "v2"], [SHA], null))[0]).toContain("history between them is missing");
  });

  it("a Code commit needs ROVARA_CODE_REPO set and the commit in that clone", () => {
    const codeNeeds = { codeCommits: [CODE_SHA] };
    expect(missingNeeds(codeNeeds, {}, have([], []))).toEqual(["ROVARA_CODE_REPO is not set (a Rovara Code clone)"]);
    expect(missingNeeds(codeNeeds, { ROVARA_CODE_REPO: CODE }, have([], [], 1, []))).toEqual([`the Code commit ${CODE_SHA.slice(0, 12)} is not in the clone at ROVARA_CODE_REPO`]);
    expect(missingNeeds(codeNeeds, { ROVARA_CODE_REPO: CODE }, have([], [], 1, [CODE_SHA]))).toEqual([]);
  });

  it("in CI it SKIPS with one counted line that names the file and what is missing (it does not fail the CI run)", () => {
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      const notes: string[] = [];
      expect(localGateOnly("tests/contract/x.test.ts", needs, env, have([], []), (text) => notes.push(text))).toBe(false);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^LOCAL-GATE-ONLY: tests\/contract\/x\.test\.ts skipped in CI: the tag v1 is missing; the tag v2 is missing; /u);
      expect(notes[0]!.startsWith(SKIP_PREFIX)).toBe(true);
    }
  });

  it("on a developer machine it skips with the same line, saying 'here'", () => {
    const notes: string[] = [];
    expect(localGateOnly("x.test.ts", needs, {}, have([], []), (text) => notes.push(text))).toBe(false);
    expect(notes[0]).toMatch(/^LOCAL-GATE-ONLY: x\.test\.ts skipped here: /u);
  });

  it("with ROVARA_REQUIRE_GIT_HISTORY set (the local gate) a missing need THROWS, in CI or not, and writes no skip line", () => {
    for (const env of [{ [REQUIRE_ENV]: "1" }, { [REQUIRE_ENV]: "1", CI: "true" }]) {
      const notes: string[] = [];
      expect(() => localGateOnly("x.test.ts", needs, env, have([], []), (text) => notes.push(text))).toThrow(/LOCAL-GATE-ONLY: x\.test\.ts cannot run and ROVARA_REQUIRE_GIT_HISTORY is set.*the tag v1 is missing/u);
      expect(notes).toEqual([]);
    }
  });

  it("'0' and 'false' do not count as setting ROVARA_REQUIRE_GIT_HISTORY", () => {
    for (const value of ["0", "false", ""]) expect(localGateOnly("x.test.ts", needs, { [REQUIRE_ENV]: value }, have([], []), none)).toBe(false);
  });

  it("runs, with or without the variable and in CI or not, when everything is present, and writes nothing", () => {
    const notes: string[] = [];
    for (const env of [{ CI: "true" }, {}, { [REQUIRE_ENV]: "1" }]) expect(localGateOnly("x.test.ts", needs, env, have(["v1", "v2"], [SHA], 0), (text) => notes.push(text))).toBe(true);
    expect(notes).toEqual([]);
  });
});
