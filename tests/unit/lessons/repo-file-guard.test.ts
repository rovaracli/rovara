// Lessons in the repo, lane R2 (round 9): the repository-id check is STRUCTURE. Every exported function of the lessons file code that takes a `RepoFileTarget` wraps it in `guardTarget` first, and a guarded host calls nothing
// (but `repositoryIdentity`) until the id the host reports is the id the place pins. A test enumerates the functions, so a path added later cannot skip the check.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryMismatch, guardTarget, repositoryIdOfPlace, verifyRepository } from "../../../packages/broker/src/lessons/repo-file-host.js";
import { FakeRepoHost, passSetup } from "./repo-file-helpers.js";

const dir = join(import.meta.dirname, "../../../packages/broker/src/lessons");
const files = readdirSync(dir).filter((name) => /^repo-file-.*\.ts$/u.test(name));
const source = (name: string): string => readFileSync(join(dir, name), "utf8");

describe("every function that takes a repository target guards it first", () => {
  /** The exported functions with a RepoFileTarget parameter (in any lessons file code but the host helpers themselves, which are handed a target that is already guarded). */
  const takers = files.filter((name) => name !== "repo-file-host.ts").flatMap((name) => {
    const text = source(name);
    const found: Array<{ file: string; fn: string; head: string }> = [];
    for (const match of text.matchAll(/export (?:async )?function (\w+)\(([^)]*)\)[^{]*\{/gu)) {
      if (!/[tT]arget: RepoFileTarget/u.test(match[2]!)) continue;
      found.push({ file: name, fn: match[1]!, head: text.slice(match.index + match[0].length, match.index + match[0].length + 400) });
    }
    return found;
  });

  it("finds the entry points (so the check below cannot pass by finding nothing)", () => {
    expect(takers.map((t) => t.fn).sort()).toEqual(["closeAllRovaraPrs", "finishClosings", "runRepoFilePass", "sweepErasures", "switchRepoFileOff"]);
  });

  it.each(takers.map((t) => [`${t.file}#${t.fn}`, t.head]))("%s begins with guardTarget(...)", (_name, head) => {
    expect(head).toMatch(/guardTarget\(/u);
  });

  it("no other file of the lessons file code calls the code host directly", () => {
    const callers = files.filter((name) => /\b(?:host|target\.host)\.(?!repositoryIdentity\b|commitFiles !==|deleteBranch !==|pathKind !==|changeRequestForBranch !==)\w+\(/u.test(source(name))).sort();
    // The sweep and the pass receive guarded targets from their entry points; the host helpers take a target they are handed. A new file that calls the host must be looked at here.
    expect(callers).toEqual(["repo-file-erase.ts", "repo-file-host.ts", "repo-file-pass.ts"]);
  });
});

describe("a guarded host", () => {
  it("calls nothing but repositoryIdentity until the id matches, reads the identity once, and refuses everything on a mismatch", async () => {
    const w = passSetup();
    const guarded = guardTarget(w.target);
    expect(guardTarget(guarded)).toBe(guarded);
    await guarded.host.baseBranchHead(guarded.repository, "main", guarded.scope);
    await guarded.host.baseBranchHead(guarded.repository, "main", guarded.scope);
    expect(w.host.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);
    expect(w.host.calls.indexOf("repositoryIdentity")).toBeLessThan(w.host.calls.indexOf("baseBranchHead"));
    expect((await verifyRepository(guarded)).ok).toBe(true);
    expect(w.host.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);

    const other = new FakeRepoHost();
    other.repoId = "4242";
    const stranger = guardTarget({ ...w.target, host: other as never });
    for (const call of [
      () => stranger.host.baseBranchHead(stranger.repository, "main", stranger.scope),
      () => stranger.host.fileAtRevision(stranger.repository, ".rovara/lessons.md", "a".repeat(40), stranger.scope),
      () => stranger.host.updateChangeRequest({ repository: stranger.repository, id: "1", url: "" }, { state: "closed" }, stranger.scope),
      () => stranger.host.deleteBranch!(stranger.repository, "rovara/lessons-000000000001", stranger.scope),
      () => stranger.host.getChangeRequest({ repository: stranger.repository, id: "1", url: "" }, stranger.scope),
    ]) await expect(call()).rejects.toBeInstanceOf(RepositoryMismatch);
    expect(other.calls.filter((c) => c !== "repositoryIdentity")).toEqual([]);
    expect(other.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);
    expect((await verifyRepository(stranger)).ok).toBe(false);
  });

  it("treats a host that will not describe the repository, and a place that pins no id, as a mismatch", async () => {
    const w = passSetup();
    w.host.failCalls.add("repositoryIdentity");
    expect((await verifyRepository(w.target)).ok).toBe(false);
    w.host.failCalls.delete("repositoryIdentity");
    expect((await verifyRepository({ ...w.target, place: "github:somewhere" })).ok).toBe(false);
    expect(repositoryIdOfPlace("github:repo/1001")).toBe("1001");
    expect(repositoryIdOfPlace("github:somewhere")).toBeUndefined();
  });
});
