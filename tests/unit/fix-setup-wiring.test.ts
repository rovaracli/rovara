// Setup and test health SH17: the dispatch wiring of the Fix setup port: absent with vx off, and with it on it records the cause the policy's own codes name (never text), with no tests to mark unless the broker's own
// evidence pack gives them (the proof switch is off here, so there is none).
import { describe, expect, it } from "vitest";
import { fixSetupDependencies } from "../../packages/broker/src/aws/broker/fix-setup-wiring.js";
import { fixSetupItemsFor } from "../../packages/broker/src/test-env/fix-setup.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"b".repeat(20)}`;
const task = { taskId: "11111111-1111-4111-8111-111111111111", orgId: ORG, project: "web", ownerKey: "dev_a", workspaceId: "ws", workflow: { candidate: { digest: "d".repeat(64) } } } as unknown as DeveloperTaskRecord;

describe("fixSetupDependencies", () => {
  it("gives the runner no port while vx is off, whatever the other switches say", () => {
    const db = new FakeDynamoDb();
    for (const value of [undefined, "", "0", "true", " 1"]) expect(fixSetupDependencies({ documentClient: db, tableName: "state" } as never, value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value }), String(value)).toEqual({});
  });

  it("records the first environment code of an ask, and nothing for an ask with none", async () => {
    const db = new FakeDynamoDb();
    const port = fixSetupDependencies({ documentClient: db, tableName: "state" } as never, { VERIFY_RESULTS_ENABLED: "1" }).fixSetup!;
    await port.record(task, { reason: "needs-a-person", codes: ["build-failed"], stage: "VERIFY" });
    expect(db.find(() => true)).toEqual([]);
    await port.record(task, { reason: "retry-limit", codes: ["check-runner-failed", "setup-failed-in-task"], stage: "VERIFY" });
    const items = await fixSetupItemsFor({ store: { documentClient: db, tableName: "state", now: Date.now }, maintainedProjects: async () => ["web"], task: async () => undefined }, { orgId: ORG, developerId: "dev_a" }, { VERIFY_RESULTS_ENABLED: "1" });
    expect(items).toMatchObject([{ kind: "fix_setup", cause: "check-runner-failed", step: "Check runner", taskCount: 1 }]);
  });

  it("offers no tests to mark without the broker's evidence pack and nightly data (the original-code cause, proof switch off)", async () => {
    const db = new FakeDynamoDb();
    const port = fixSetupDependencies({ documentClient: db, tableName: "state" } as never, { VERIFY_RESULTS_ENABLED: "1" }).fixSetup!;
    await port.record(task, { reason: "original-code-also-fails", codes: ["fails-on-original-code"], stage: "VERIFY" });
    const [item] = await fixSetupItemsFor({ store: { documentClient: db, tableName: "state", now: Date.now }, maintainedProjects: async () => ["web"], task: async () => undefined }, { orgId: ORG, developerId: "dev_a" }, { VERIFY_RESULTS_ENABLED: "1" });
    expect(item).toMatchObject({ cause: "fails-on-original-code", knownFailingTests: 0 });
  });
});

// Opus re-check M2/M4: what the wiring records from the broker's pack and the USABLE nightly baseline.
import { EvidencePackSchema, NightlyBaselineSchema, projectPk, projectRevisionKey } from "@agentx/contracts";

describe("the wiring and the nightly baseline", () => {
  // The wiring reads the real clock, so the baselines here are made relative to it.
  const NOW = Date.now();
  const pack = (names: string[]) => EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: "d".repeat(64), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: [{ checkId: "unit", kind: "test", label: "unit", before: "failed", after: "failed", class: "already_failing", durationMs: 5, tests: { total: 10, passed: 10 - names.length, failed: names.length, skipped: 0, errored: 0, newTests: [], names: names.map((name) => ({ name, status: "failed" })) } }],
    selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
  });
  function bench(baseline: { branch?: string; ageMs?: number; failed?: string[] }) {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main" }] } });
    const failed = baseline.failed ?? ["Y"];
    const finished = new Date(NOW - (baseline.ageMs ?? 86_400_000)).toISOString();
    db.set({ pk: projectPk(ORG, "web"), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", baseline: NightlyBaselineSchema.parse({
      recordedAt: finished, envRevision: 1, branch: baseline.branch ?? "main", headSha: "a".repeat(40), finishedAt: finished, tests: { total: 100, passed: 100 - failed.length, failed: failed.length, skipped: 0 }, failed, flaky: [] }) });
    return db;
  }
  const taskOf = { taskId: "11111111-1111-4111-8111-111111111111", orgId: ORG, project: "web", ownerKey: "dev_a", workspaceId: "ws", workflow: { candidate: { digest: "d".repeat(64) } } } as unknown as DeveloperTaskRecord;
  const run = async (db: FakeDynamoDb, names: string[]) => {
    const port = fixSetupDependencies({ documentClient: db, tableName: "state", now: () => NOW } as never, { VERIFY_RESULTS_ENABLED: "1" }, async () => pack(names)).fixSetup!;
    await port.record(taskOf, { reason: "original-code-also-fails", codes: ["fails-on-original-code"], stage: "VERIFY" });
    const [item] = await fixSetupItemsFor({ store: { documentClient: db, tableName: "state", now: () => NOW }, maintainedProjects: async () => ["web"], task: async () => undefined }, { orgId: ORG, developerId: "dev_a" }, { VERIFY_RESULTS_ENABLED: "1" });
    return item as { knownFailingTests: number } | undefined;
  };

  const newFailing = async (db: FakeDynamoDb, names: string[], env: NodeJS.ProcessEnv = { VERIFY_RESULTS_ENABLED: "1" }) => {
    const deps = fixSetupDependencies({ documentClient: db, tableName: "state", now: () => NOW } as never, env, async () => pack(names));
    return deps.newFailingChecks === undefined ? undefined : deps.newFailingChecks(taskOf, undefined);
  };

  it("names the checks that failed before and also have a failing test the usable nightly does not show (the auto-fix policy sends those back), only while vx is on", async () => {
    expect(await newFailing(bench({}), ["Y", "Z"])).toEqual(["unit"]);
    expect(await newFailing(bench({}), ["Y"])).toEqual([]);
    // No usable nightly: every failing test of a check that failed before is unconfirmed.
    expect(await newFailing(bench({ ageMs: 8 * 86_400_000 }), ["Y"])).toEqual(["unit"]);
    expect(await newFailing(bench({ branch: "release" }), ["Y"])).toEqual(["unit"]);
    for (const value of [undefined, "0", "true", " 1"]) expect(await newFailing(bench({}), ["Y", "Z"], value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value }), String(value)).toBeUndefined();
  });

  it("names a check that failed on the original code when the broker has no pack for this code, or the pack does not name it (nothing about its tests is confirmed)", async () => {
    const withVerification = (rows: Array<{ checkId: string; status: string }>) => ({ ...taskOf, workflow: { candidate: { digest: "d".repeat(64) }, verification: { candidateDigest: "d".repeat(64), results: rows } } }) as unknown as DeveloperTaskRecord;
    const task2 = withVerification([{ checkId: "unit", status: "FAILED" }, { checkId: "api", status: "FAILED" }, { checkId: "lint", status: "FAILED" }, { checkId: "ok", status: "PASS" }]);
    const originals = { unit: "failed", api: "cannot-run", lint: "passed", ok: "failed" };
    const call = async (read: () => Promise<undefined | ReturnType<typeof pack>>) => (await fixSetupDependencies({ documentClient: bench({}), tableName: "state", now: () => NOW } as never, { VERIFY_RESULTS_ENABLED: "1" }, read).newFailingChecks!(task2, originals));
    // No pack: every failed check that failed on the original code. A check that passed there is not one (it is a regression, which the classifier already sends back).
    expect([...await call(async () => undefined)].sort()).toEqual(["api", "unit"]);
    // A pack that names only unit (and knows its test): api is still unconfirmed.
    expect(await call(async () => pack(["Y"]))).toEqual(["api"]);
    // Without the facts of the original run nothing is claimed.
    expect(await fixSetupDependencies({ documentClient: bench({}), tableName: "state", now: () => NOW } as never, { VERIFY_RESULTS_ENABLED: "1" }, async () => undefined).newFailingChecks!(task2, undefined)).toEqual([]);
  });

  it("compares the nightly with the task's own base branch: a task whose pull request targets another branch gets no excuse", async () => {
    const db = bench({});
    db.set({ pk: `DEVTASK#${taskOf.taskId}`, sk: "MERGE_TRACKING#repo#1", entityType: "MERGE_TRACKING", state: "open", baseBranch: "release" });
    expect(await newFailing(db, ["Y"])).toEqual(["unit"]);
    expect(await run(db, ["Y"])).toBeUndefined();
  });

  it("offers the mark for a test a usable nightly lists", async () => {
    expect(await run(bench({}), ["Y"])).toMatchObject({ knownFailingTests: 1 });
  });

  it("opens no card at all when a failing test is not on the list (Y old, Z new): it is the code's fault, not the setup's", async () => {
    expect(await run(bench({}), ["Y", "Z"])).toBeUndefined();
  });

  it("uses no stale baseline and no baseline from another branch: no card, no mark", async () => {
    expect(await run(bench({ ageMs: 8 * 86_400_000 }), ["Y"])).toBeUndefined();
    expect(await run(bench({ branch: "release" }), ["Y"])).toBeUndefined();
  });
});
