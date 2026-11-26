// L9 Opus review test: the SHIPPED floors file judged against this repository's real release tags with real `git merge-base --is-ancestor` (read-only git).
// Proves the release-mode deviation does not block any current release, that older tags are refused, and documents that the digest floor is a deny-list only.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cloudFloors, judgeDigest, judgeRef, loadFloors } from "../../ops/pipeline/lib/floors.ts";
import type { Ports } from "../../ops/pipeline/types.ts";
import { localGateOnly } from "../support/local-gate-only.ts";
import { makePorts, newState } from "./pipeline-stage-fakes.ts";

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
const hasTag = (tag: string): boolean => { try { git("rev-parse", "--verify", `${tag}^{commit}`); return true; } catch { return false; } };
const realPorts = (): Ports => {
  const ports = makePorts(newState());
  ports.fs.exists = () => true;
  ports.fs.readText = (p: string) => execFileSync("cat", [p], { encoding: "utf8" });
  ports.git.isAncestor = (a: string, d: string) => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", a, d], { stdio: "ignore" }); return Promise.resolve(true); } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 1) return Promise.resolve(false);
      return Promise.reject(new Error(`git could not compare ${a}`));
    }
  };
  return ports;
};
const tags = ["v0.13.10", "v0.13.11", "v0.13.17", "v0.13.19"];
// @local-gate-only: needs this repository's release tags v0.13.* and the history below them, and every Cloud floor commit.
// In CI (no tags, depth 2) this file skips with one counted `LOCAL-GATE-ONLY:` line; the local gate runs it with ROVARA_REQUIRE_GIT_HISTORY=1, where a missing tag or commit THROWS (tests/support/local-gate-only.ts).
const runnable = localGateOnly(import.meta.filename, { tags, commits: cloudFloors(loadFloors(realPorts(), process.cwd())).flatMap((floor) => (floor.sha === null ? [] : [floor.sha])) });

describe.skipIf(!runnable)("review: shipped rollback floors vs the real repository", () => {
  const ports = realPorts();
  const floors = loadFloors(ports, process.cwd());

  // The Bedrock no_answer floor (59edd60f2bff, Cloud train 40: the web and gateway rows) is the newest: v0.13.26 is the first release tag at or above it.
  const BEDROCK_FLOOR = /below the (web|gateway) floor 59edd60f2bff: older readers reject the stored Bedrock model state no_answer/u;
  it("every release tag from v0.13.26 on is at or above every floor (a current release is never blocked by the floor gate)", async () => {
    let judged = 0;
    for (let n = 26; n <= 99; n++) {
      const tag = `v0.13.${n}`;
      if (!hasTag(tag)) continue;
      const verdict = await judgeRef(ports, floors, { tag, sha: git("rev-parse", `${tag}^{commit}`) });
      expect(verdict.failures, tag).toEqual([]);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });

  it("v0.13.11 to v0.13.25 are refused, by both the web and the gateway row of the Bedrock floor", async () => {
    for (let n = 11; n <= 25; n++) {
      const tag = `v0.13.${n}`;
      if (!hasTag(tag)) continue;
      const verdict = await judgeRef(ports, floors, { tag, sha: git("rev-parse", `${tag}^{commit}`) });
      expect(verdict.failures.filter((failure) => BEDROCK_FLOOR.test(failure)).map((failure) => failure.match(BEDROCK_FLOOR)![1]).sort(), tag).toEqual(["gateway", "web"]);
    }
  });

  it("v0.13.10 and older are refused with the web floor's reason (train 11)", async () => {
    for (const tag of ["v0.13.10", "v0.13.0"]) {
      if (!hasTag(tag)) continue;
      const verdict = await judgeRef(ports, floors, { tag, sha: git("rev-parse", `${tag}^{commit}`) });
      expect(verdict.failures.join(" "), tag).toMatch(/below the web floor fbe943520414: web train 11/u);
    }
  });

  it("a rollback to v0.13.17 is refused by the Bedrock floor, and the pending v0.13.19 row is still reported but not enforced", async () => {
    const verdict = await judgeRef(ports, floors, { tag: "v0.13.17", sha: git("rev-parse", "v0.13.17^{commit}") });
    expect(verdict.failures).toHaveLength(2);
    for (const failure of verdict.failures) expect(failure).toMatch(BEDROCK_FLOOR);
    expect(verdict.notes.join(" ")).toMatch(/pending floor \(not enforced\): web v0\.13\.19 once Code train 27 is live/u);
  });

  it("the gateway floor commit carries the same gateway image context as the tree image 2cc25438 was built from (59f223218)", () => {
    const diff = git("diff", "--name-only", "465e372f105b7d413db71259eaa020b499a3796c", "59f22321821530f3e0b61ceeac9efe0c2b418fc5", "--", "packages/model-gateway", "environments/model-gateway", "tsconfig.base.json");
    expect(diff).toBe("");
  });

  it("FINDING (documented, not enforced): the digest floor is a deny-list, so any unlisted digest passes", () => {
    expect(judgeDigest(floors, `sha256:${"0".repeat(64)}`)).toEqual([]);
    expect(judgeDigest(floors, "sha256:68af1b9e9f2639e55f627f3604c829b6926f48be90cc06e37fd8bed923724292")).toHaveLength(1);
  });
});
