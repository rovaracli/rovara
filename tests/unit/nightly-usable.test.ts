// Setup and test health SH17 (Opus re-check M4): the nightly baseline is "what already fails" only while it is recent (7 days), from the branch the tasks are based on, whole and readable. Otherwise it excuses nothing and
// no mark is offered from it. Also: with no usable baseline, a check that failed before has only unconfirmed failing tests, so a mark is never offered and the result is Code failed (owner decision M2).
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, NightlyBaselineSchema, projectPk, projectRevisionKey } from "@agentx/contracts";
import { NIGHTLY_BASELINE_MAX_AGE_MS, projectBaseBranch, taskBaseBranches, usableNightlyFailing } from "../../packages/broker/src/test-env/nightly-usable.js";
import { alreadyFailingForResults, knownFailingKey } from "../../packages/broker/src/test-env/known-failing.js";
import { failingOnOriginalTests } from "../../packages/broker/src/test-env/fix-setup.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"f".repeat(20)}`;
const PROJECT = "web";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86_400_000;

function bench(over: { branch?: string; ageMs?: number; base?: Array<string | undefined>; failed?: string[]; failedCount?: number; noBaseline?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const deps = { documentClient: db, tableName: "state", now: () => NOW };
  const base = over.base ?? ["main"];
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: base.map((defaultBranch, n) => ({ name: `r${String(n)}`, url: "https://github.com/acme/web.git", path: `repo/r${String(n)}`, defaultBranch })) } });
  if (over.noBaseline !== true) {
    const failed = over.failed ?? ["Y"];
    const finished = new Date(NOW - (over.ageMs ?? DAY)).toISOString();
    const baseline = NightlyBaselineSchema.parse({
      recordedAt: finished, envRevision: 1, branch: over.branch ?? "main", headSha: "a".repeat(40), finishedAt: finished,
      tests: { total: 100, passed: 100 - (over.failedCount ?? failed.length), failed: over.failedCount ?? failed.length, skipped: 0 }, failed, flaky: [],
    });
    db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: ORG, project: PROJECT, baseline });
  }
  return { db, deps };
}

describe("usableNightlyFailing", () => {
  it("is the failing list of a recent baseline from the tasks' base branch", async () => {
    const t = bench();
    expect(await projectBaseBranch(t.deps, ORG, PROJECT)).toBe("main");
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT)).toEqual(["Y"]);
    expect(await usableNightlyFailing(bench({ ageMs: NIGHTLY_BASELINE_MAX_AGE_MS }).deps, ORG, PROJECT)).toEqual(["Y"]);
  });

  it("is nothing for a stale baseline (older than 7 days), however it ran", async () => {
    expect(await usableNightlyFailing(bench({ ageMs: NIGHTLY_BASELINE_MAX_AGE_MS + 60_000 }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ ageMs: 30 * DAY }).deps, ORG, PROJECT)).toBeUndefined();
  });

  it("is nothing for a baseline from another branch than the tasks' base branch", async () => {
    expect(await usableNightlyFailing(bench({ branch: "release" }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ base: ["develop"] }).deps, ORG, PROJECT)).toBeUndefined();
  });

  it("is nothing when the repositories do not agree on a base branch, none is named, there is no baseline, it claims to be from the future, or its failing list did not fit", async () => {
    expect(await usableNightlyFailing(bench({ base: ["main", "develop"] }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ base: [undefined] }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ noBaseline: true }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ ageMs: -2 * 3_600_000 }).deps, ORG, PROJECT)).toBeUndefined();
    expect(await usableNightlyFailing(bench({ failed: ["Y"], failedCount: 3 }).deps, ORG, PROJECT)).toBeUndefined();
  });
});

describe("a baseline older than 7 days (a quiet repository) and the task's own base branch", () => {
  const SAME = "a".repeat(40);
  const head = (sha: string | undefined) => async () => sha;

  it("is used when the branch's head now is the head the baseline ran on, and not when it moved, cannot be read, or nobody can read it", async () => {
    const t = bench({ ageMs: 30 * DAY });
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT, { currentHead: head(SAME) })).toEqual(["Y"]);
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT, { currentHead: head("b".repeat(40)) })).toBeUndefined();
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT, { currentHead: head(undefined) })).toBeUndefined();
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT, { currentHead: async () => { throw new Error("host down"); } })).toBeUndefined();
    expect(await usableNightlyFailing(t.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("asks for the head of the BASELINE's branch, and still needs the branch, whole list and sane clock", async () => {
    const asked: string[] = [];
    expect(await usableNightlyFailing(bench({ ageMs: 30 * DAY }).deps, ORG, PROJECT, { currentHead: async (branch) => { asked.push(branch); return SAME; } })).toEqual(["Y"]);
    expect(asked).toEqual(["main"]);
    expect(await usableNightlyFailing(bench({ ageMs: 30 * DAY, branch: "release" }).deps, ORG, PROJECT, { currentHead: head(SAME) })).toBeUndefined();
    expect(await usableNightlyFailing(bench({ ageMs: 30 * DAY, failed: ["Y"], failedCount: 3 }).deps, ORG, PROJECT, { currentHead: head(SAME) })).toBeUndefined();
    expect(await usableNightlyFailing(bench({ ageMs: -2 * 3_600_000 }).deps, ORG, PROJECT, { currentHead: head(SAME) })).toBeUndefined();
  });

  it("compares the nightly's branch with the TASK's base branch, not with the project's default", async () => {
    // A task on 'release' gets nothing from a nightly of 'main'; a task on 'main' does; the task's own branch wins over the project's default either way.
    expect(await usableNightlyFailing(bench().deps, ORG, PROJECT, { taskBranches: ["release"] })).toBeUndefined();
    expect(await usableNightlyFailing(bench().deps, ORG, PROJECT, { taskBranches: ["main"] })).toEqual(["Y"]);
    expect(await usableNightlyFailing(bench({ branch: "release" }).deps, ORG, PROJECT, { taskBranches: ["release"] })).toEqual(["Y"]);
    expect(await usableNightlyFailing(bench({ base: ["develop"] }).deps, ORG, PROJECT, { taskBranches: ["main"] })).toEqual(["Y"]);
    // Pull requests to two branches: the nightly of one is not the baseline of the other.
    expect(await usableNightlyFailing(bench().deps, ORG, PROJECT, { taskBranches: ["main", "release"] })).toBeUndefined();
    // No branch of its own (no open pull request yet): the project's default, as before.
    expect(await usableNightlyFailing(bench().deps, ORG, PROJECT, { taskBranches: [] })).toEqual(["Y"]);
    expect(await usableNightlyFailing(bench({ base: ["develop"] }).deps, ORG, PROJECT, { taskBranches: [] })).toBeUndefined();
  });

  it("reads the task's base branches from its open pull requests only", async () => {
    const t = bench();
    const row = (n: number, state: string, baseBranch: string) => t.db.set({ pk: "DEVTASK#t1", sk: `MERGE_TRACKING#repo#${String(n)}`, entityType: "MERGE_TRACKING", state, baseBranch });
    expect(await taskBaseBranches(t.deps, "t1")).toEqual([]);
    row(1, "open", "release"); row(2, "merged", "main"); row(3, "open", "release");
    expect(await taskBaseBranches(t.deps, "t1")).toEqual(["release"]);
    row(4, "open", "main");
    expect((await taskBaseBranches(t.deps, "t1")).sort()).toEqual(["main", "release"]);
    expect(await taskBaseBranches(t.deps, "t2")).toEqual([]);
  });
});

describe("what the result may excuse", () => {
  it("takes the usable nightly and the maintainers' marks, and only the marks when the nightly is stale or from another branch", async () => {
    const mark = { name: "M", checkId: "unit", markedBy: "dev_a", markedAt: "2026-11-09T00:00:00.000Z", epoch: 1 };
    for (const [label, t] of [["usable", bench()], ["stale", bench({ ageMs: 9 * DAY })], ["other branch", bench({ branch: "release" })]] as const) {
      t.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", marks: [mark], version: 1, updatedAt: mark.markedAt });
      const set = await alreadyFailingForResults(t.deps, ORG, PROJECT);
      expect(set, label).toEqual(label === "usable" ? ["Y", { name: "M", checkId: "unit" }] : [{ name: "M", checkId: "unit" }]);
    }
  });
});

describe("what a Fix setup card may offer", () => {
  const pack = (names: string[], newTests: string[] = []) => EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: "c".repeat(64), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: [{ checkId: "unit", kind: "test", label: "unit", before: "failed", after: "failed", class: "already_failing", durationMs: 5, tests: { total: 10, passed: 10 - names.length, failed: names.length, skipped: 0, errored: 0, newTests, names: names.map((name) => ({ name, status: "failed" })) } }],
    selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
  });

  it("offers Y when the usable nightly lists it, and calls it the code's fault (nothing offered) when Z is also failing", () => {
    expect(failingOnOriginalTests(pack(["Y"]), ["Y"])).toEqual({ tests: [{ name: "Y", checkId: "unit" }], unconfirmed: 0, codeFault: false });
    expect(failingOnOriginalTests(pack(["Y", "Z"]), ["Y"])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
  });

  it("with no usable nightly every failing test of a check that failed before is unconfirmed: nothing offered, the code's fault", () => {
    expect(failingOnOriginalTests(pack(["Y"]), [])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
  });

  it("a test check with no usable per-test data is the code's fault, not a setup problem (no counts, a zero count, a name twice); a lint with none offers nothing", () => {
    const noTests = pack(["Y"]);
    delete (noTests.checks[0] as { tests?: unknown }).tests;
    expect(failingOnOriginalTests(noTests, ["Y"])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
    const zero = pack(["Y"]);
    zero.checks[0]!.tests = { ...zero.checks[0]!.tests!, failed: 0, passed: 10, total: 10, names: [] };
    expect(failingOnOriginalTests(zero, ["Y"])).toMatchObject({ codeFault: true });
    expect(failingOnOriginalTests(pack(["Y", "Y"]), ["Y"])).toMatchObject({ tests: [], codeFault: true });
    const lint = pack(["Y"]);
    lint.checks[0] = { ...lint.checks[0]!, kind: "lint" };
    delete (lint.checks[0] as { tests?: unknown }).tests;
    expect(failingOnOriginalTests(lint, ["Y"])).toBeUndefined();
  });

  it("a test the change added is the code's fault even when the nightly lists the name; failing tests the pack does not name are unconfirmed", () => {
    expect(failingOnOriginalTests(pack(["Y", "C"], ["C"]), ["Y", "C"])).toMatchObject({ tests: [], codeFault: true });
    const unnamed = pack(["Y"]);
    unnamed.checks[0]!.tests = { ...unnamed.checks[0]!.tests!, failed: 3, passed: 7 };
    expect(failingOnOriginalTests(unnamed, ["Y"])).toMatchObject({ unconfirmed: 3, codeFault: true }); // the data cannot say which 3 failed: all are unconfirmed
  });
});
