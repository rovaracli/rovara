// Setup and test health SH17 (quiet repository): the production reader of a project's default-branch head, and what it does to a nightly baseline older than 7 days. It exists only while `vx` is on, asks the code host
// the repository's record names through `baseBranchHead`, answers only for a one-repository project, and any failure is "unknown" (the stale baseline is then refused, as without the reader).
import { describe, expect, it } from "vitest";
import { NightlyBaselineSchema, projectPk, projectRevisionKey } from "@rovara-code/contracts";
import { nightlyHeadDependencies, nightlyHeadReaderOf } from "../../packages/broker/src/aws/broker/nightly-head.js";
import { fixSetupDependencies } from "../../packages/broker/src/aws/broker/fix-setup-wiring.js";
import { alreadyFailingForResults } from "../../packages/broker/src/test-env/known-failing.js";
import { nightlyOptionsFor, usableNightlyFailing } from "../../packages/broker/src/test-env/nightly-usable.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"f".repeat(20)}` as never;
const PROJECT = "web";
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const HEAD = "a".repeat(40);
const ON = { VERIFY_RESULTS_ENABLED: "1" };

function world(options: { repositories?: number; head?: string | (() => Promise<string>); ageMs?: number } = {}) {
  const db = new FakeDynamoDb();
  const repositories = Array.from({ length: options.repositories ?? 1 }, (_, n) => ({ name: `r${String(n)}`, url: `https://github.com/acme/r${String(n)}.git`, path: `repo/r${String(n)}`, defaultBranch: "main" }));
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories } });
  const finished = new Date(NOW - (options.ageMs ?? 30 * DAY)).toISOString();
  db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", baseline: NightlyBaselineSchema.parse({
    recordedAt: finished, envRevision: 1, branch: "main", headSha: HEAD, finishedAt: finished, tests: { total: 10, passed: 9, failed: 1, skipped: 0 }, failed: ["Y"], flaky: [] }) });
  const asked: Array<{ url: string; branch: string }> = [];
  const head = options.head ?? HEAD;
  const dependencies = {
    documentClient: db, tableName: "state",
    githubPullRequests: { getDefaultBranchHead: async (url: string, branch: string) => { asked.push({ url, branch }); return typeof head === "function" ? head() : head; } },
  } as never;
  return { db, dependencies, asked, deps: { documentClient: db, tableName: "state", now: () => NOW } };
}

describe("the production reader of the default branch's head", () => {
  it("is nothing while vx is off, and a reader (on exactly '1') while it is on", () => {
    const w = world();
    for (const env of [{}, { VERIFY_RESULTS_ENABLED: "0" }, { VERIFY_RESULTS_ENABLED: "true" }]) {
      expect(nightlyHeadReaderOf(w.dependencies, env)).toBeUndefined();
      expect(nightlyHeadDependencies(w.dependencies, env)).toEqual({});
    }
    expect(nightlyHeadReaderOf(w.dependencies, ON)).toBeTypeOf("function");
    expect(nightlyHeadDependencies(w.dependencies, ON).nightlyHead).toBeTypeOf("function");
  });

  it("asks the host's baseBranchHead for the baseline's branch of the project's one repository", async () => {
    const w = world();
    expect(await nightlyHeadReaderOf(w.dependencies, ON)!(ORG, PROJECT)("main")).toBe(HEAD);
    expect(w.asked).toEqual([{ url: "https://github.com/acme/r0.git", branch: "main" }]);
  });

  it("is unknown (undefined) for a project with several repositories, an unknown project, or a host that fails", async () => {
    expect(await nightlyHeadReaderOf(world({ repositories: 2 }).dependencies, ON)!(ORG, PROJECT)("main")).toBeUndefined();
    const w = world();
    expect(await nightlyHeadReaderOf(w.dependencies, ON)!(ORG, "nope")("main")).toBeUndefined();
    expect(await nightlyHeadReaderOf(world({ head: () => Promise.reject(new Error("host down")) }).dependencies, ON)!(ORG, PROJECT)("main")).toBeUndefined();
    expect(world().asked).toEqual([]);
  });
});

describe("with the reader wired, a baseline older than 7 days on an unchanged head counts", () => {
  it("is used when the host says the branch is still at the baseline's head", async () => {
    const w = world();
    const reader = nightlyHeadReaderOf(w.dependencies, ON);
    const options = await nightlyOptionsFor(w.deps, { taskId: "t1", orgId: ORG, project: PROJECT }, reader);
    expect(await usableNightlyFailing(w.deps, ORG, PROJECT, options)).toEqual(["Y"]);
    expect(await alreadyFailingForResults(w.deps, ORG, PROJECT, options)).toEqual(["Y"]);
  });

  it("is refused when the branch moved, the read fails, there is no reader (vx off), or the project has several repositories", async () => {
    for (const w of [world({ head: "b".repeat(40) }), world({ head: () => Promise.reject(new Error("host down")) }), world({ repositories: 2 })]) {
      const options = await nightlyOptionsFor(w.deps, { taskId: "t1", orgId: ORG, project: PROJECT }, nightlyHeadReaderOf(w.dependencies, ON));
      expect(await usableNightlyFailing(w.deps, ORG, PROJECT, options)).toBeUndefined();
    }
    const w = world();
    expect(await usableNightlyFailing(w.deps, ORG, PROJECT, await nightlyOptionsFor(w.deps, { taskId: "t1", orgId: ORG, project: PROJECT }, nightlyHeadReaderOf(w.dependencies, {})))).toBeUndefined();
  });

  it("does not ask the host for a baseline that is recent anyway", async () => {
    const w = world({ ageMs: DAY });
    const options = await nightlyOptionsFor(w.deps, { taskId: "t1", orgId: ORG, project: PROJECT }, nightlyHeadReaderOf(w.dependencies, ON));
    expect(await usableNightlyFailing(w.deps, ORG, PROJECT, options)).toEqual(["Y"]);
    expect(w.asked).toEqual([]);
  });

  it("reaches the Fix setup wiring: the check's failing test is confirmed by a stale baseline on the unchanged head, and not once the branch moved", async () => {
    const pack = (await import("@rovara-code/contracts")).EvidencePackSchema.parse({
      schemaVersion: 1, candidateDigest: "d".repeat(64), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
      checks: [{ checkId: "unit", kind: "test", label: "unit", before: "failed", after: "failed", class: "already_failing", durationMs: 5, tests: { total: 10, passed: 9, failed: 1, skipped: 0, errored: 0, newTests: [], names: [{ name: "Y", status: "failed" }] } }],
      selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
    });
    const task = { taskId: "11111111-1111-4111-8111-111111111111", orgId: ORG, project: PROJECT, ownerKey: "dev_a", workspaceId: "ws", workflow: { candidate: { digest: "d".repeat(64) } } } as unknown as DeveloperTaskRecord;
    const run = async (w: ReturnType<typeof world>, env: NodeJS.ProcessEnv) => fixSetupDependencies({ ...(w.dependencies as object), now: () => NOW } as never, env, async () => pack).newFailingChecks!(task, undefined);
    // Date.now is the wiring's clock, so the baseline age is relative to the real clock here.
    const real = Date.now;
    Date.now = () => NOW;
    try {
      expect(await run(world(), ON)).toEqual([]);
      expect(await run(world({ head: "b".repeat(40) }), ON)).toEqual(["unit"]);
      expect(await run(world({ head: () => Promise.reject(new Error("down")) }), ON)).toEqual(["unit"]);
    } finally { Date.now = real; }
  });
});
