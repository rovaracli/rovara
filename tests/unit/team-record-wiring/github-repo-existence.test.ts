// SRL-5a: the check that a recorded GitHub repository is still held by its installation. It must never be fooled into a tombstone (it cannot be undone): errors, refusals, unclear or empty lists,
// narrowed installations and mass "missing" all remove nothing.
import { describe, expect, it } from "vitest";
import {
  checkRecordedRepositories, REPOSITORY_MAX_MISSING_SHARE, REPOSITORY_MIN_FOR_SHARE,
  type InstallationRepositoriesPort, type RecordedRepository,
} from "../../../packages/broker/src/team-record/github-repo-existence.js";

const WS = "org_aaaaaaaaaaaaaaaaaaaa";
const repo = (id: number, installationId = 9): RecordedRepository => ({ workspaceId: WS, scope: `github:repo/${id}`, repositoryId: id, installationId });
const range = (count: number, from = 1): number[] => Array.from({ length: count }, (_, index) => from + index);

function world(options: { listed?: number[]; complete?: boolean; direct?: Record<number, "exists" | "missing" | "throw">; listThrows?: boolean; removeFails?: boolean; hang?: boolean } = {}) {
  const calls = { open: 0, status: [] as number[], removed: [] as number[], signals: [] as Array<AbortSignal | undefined> };
  const installations: InstallationRepositoriesPort = {
    async open(_installation, _workspace, signal) {
      calls.open += 1;
      calls.signals.push(signal);
      // A port that ignores its signal and never answers: the check must still end at its deadline.
      if (options.hang) return new Promise<never>(() => undefined);
      if (options.listThrows) throw new Error("403");
      return {
        ids: options.listed ?? [], complete: options.complete ?? true,
        async status(repositoryId) {
          calls.status.push(repositoryId);
          const answer = options.direct?.[repositoryId] ?? "missing";
          if (answer === "throw") throw new Error("429");
          return answer;
        },
      };
    },
  };
  const deps = { installations, remove: async (repository: RecordedRepository) => { if (options.removeFails) throw new Error("table down"); calls.removed.push(repository.repositoryId); } };
  return { calls, deps };
}

describe("the repository check removes only what GitHub clearly no longer shows the installation", () => {
  it("removes a recorded repository that is not in the installation's list and whose own lookup is a clear 404", async () => {
    const w = world({ listed: range(10, 100) });
    const outcome = await checkRecordedRepositories(w.deps, [repo(1), ...range(9, 100).map((id) => repo(id))]);
    expect(w.calls.removed).toEqual([1]);
    expect(outcome).toMatchObject({ removed: 1, unknown: 0, refused: 0, failed: 0, checked: 10 });
  });

  it("leaves a repository that is listed, and one that is not listed but still answers 200 (a stale list)", async () => {
    const w = world({ listed: range(10, 100), direct: { 1: "exists" } });
    await checkRecordedRepositories(w.deps, [repo(1), repo(100), repo(101)]);
    expect(w.calls.removed).toEqual([]);
    expect(w.calls.status).toEqual([1]);
  });

  it("asks the installation about the repositories it holds, one list per installation, and never mixes installations", async () => {
    const w = world({ listed: range(10, 100) });
    await checkRecordedRepositories(w.deps, [repo(100, 9), repo(1, 8), repo(101, 8)]);
    expect(w.calls.open).toBe(2);
  });
});

describe("the check has a real deadline (R1)", () => {
  it("a port that never answers ends at the deadline with nothing removed, and the installations after it are skipped, not waited for", async () => {
    const w = world({ hang: true });
    const started = Date.now();
    const outcome = await checkRecordedRepositories(w.deps, [repo(1, 8), repo(2, 9)], { signal: AbortSignal.timeout(150) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.calls.removed).toEqual([]);
    expect(outcome).toMatchObject({ unknown: 1, skipped: 1, removed: 0 });
  });

  it("hands the deadline's signal to the port, so the GitHub calls themselves are aborted", async () => {
    const w = world({ listed: range(10, 100) });
    const signal = AbortSignal.timeout(5_000);
    await checkRecordedRepositories(w.deps, [repo(100)], { signal });
    expect(w.calls.signals).toEqual([signal]);
  });

  it("opens each installation ONCE (one token), however many of its repositories are looked up", async () => {
    const w = world({ listed: range(10, 100) });
    await checkRecordedRepositories(w.deps, [repo(1), repo(2), ...range(8, 100).map((id) => repo(id))]);
    expect(w.calls.open).toBe(1);
    expect(w.calls.status).toEqual([1, 2]);
  });
});

describe("errors, refusals and unclear answers never remove anything", () => {
  it("a list that cannot be read (a 403, a revoked or suspended installation) removes nothing", async () => {
    const w = world({ listThrows: true });
    const outcome = await checkRecordedRepositories(w.deps, [repo(1)]);
    expect(w.calls.removed).toEqual([]);
    expect(outcome.unknown).toBe(1);
  });

  it("a list that may have more pages is not believed", async () => {
    const w = world({ listed: range(1000, 5000), complete: false });
    await checkRecordedRepositories(w.deps, [repo(1)]);
    expect(w.calls.removed).toEqual([]);
    expect(w.calls.status).toEqual([]);
  });

  it("an EMPTY list is the canary failing (what a narrowed or revoked installation looks like): nothing is removed, even though the repository is surely absent", async () => {
    const w = world({ listed: [] });
    const outcome = await checkRecordedRepositories(w.deps, [repo(1)]);
    expect(w.calls.removed).toEqual([]);
    expect(outcome.unknown).toBe(1);
  });

  it("a direct lookup that is not a clear 404 (a refusal, a rate limit, a server error) ends the installation's check with nothing removed, even for repositories that did answer 404 before it", async () => {
    const w = world({ listed: range(10, 100), direct: { 1: "missing", 2: "throw" } });
    const outcome = await checkRecordedRepositories(w.deps, [repo(1), repo(2), ...range(8, 100).map((id) => repo(id))]);
    expect(w.calls.removed).toEqual([]);
    expect(outcome.unknown).toBe(1);
  });

  it("removals that no durable path took are counted and do not stop the rest", async () => {
    const w = world({ listed: range(30, 100), removeFails: true });
    const outcome = await checkRecordedRepositories(w.deps, [repo(1), ...range(29, 100).map((id) => repo(id))]);
    expect(outcome).toMatchObject({ removed: 0, failed: 1 });
  });
});

describe("the brakes: a narrowed installation looks exactly like mass deletion", () => {
  it(`more than ${REPOSITORY_MAX_MISSING_SHARE * 100} percent of an installation's recorded repositories "not held" removes nothing (and costs no per-repository lookups)`, async () => {
    const w = world({ listed: range(5, 100) });
    // 10 recorded, 3 not listed: 30 percent.
    const outcome = await checkRecordedRepositories(w.deps, [repo(1), repo(2), repo(3), ...range(7, 100).map((id) => repo(id))]);
    expect(w.calls.removed).toEqual([]);
    expect(w.calls.status).toEqual([]);
    expect(outcome.refused).toBe(1);
  });

  it("exactly at the share is allowed (2 of 10)", async () => {
    const w = world({ listed: range(10, 100) });
    await checkRecordedRepositories(w.deps, [repo(1), repo(2), ...range(8, 100).map((id) => repo(id))]);
    expect(w.calls.removed.sort()).toEqual([1, 2]);
  });

  it(`under ${REPOSITORY_MIN_FOR_SHARE} recorded repositories an installation loses at most one per check`, async () => {
    const w = world({ listed: range(3, 100) });
    const refused = await checkRecordedRepositories(w.deps, [repo(1), repo(2), repo(100), repo(101)]);
    expect(w.calls.removed).toEqual([]);
    expect(refused.refused).toBe(1);
    const one = world({ listed: range(3, 100) });
    await checkRecordedRepositories(one.deps, [repo(1), repo(100), repo(101)]);
    expect(one.calls.removed).toEqual([1]);
  });

  it("a brake on one installation does not stop another", async () => {
    const w = world({ listed: range(10, 100) });
    await checkRecordedRepositories(w.deps, [repo(1, 8), repo(2, 8), repo(100, 8), repo(500, 9), ...range(9, 101).map((id) => repo(id, 9))]);
    // Installation 8: 2 of 3 not held (refused). Installation 9: repository 500 is not listed (1 of 10): removed.
    expect(w.calls.removed).toEqual([500]);
  });
});
