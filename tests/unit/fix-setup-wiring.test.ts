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
