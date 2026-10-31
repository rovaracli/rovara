// Proof and test environment E6: the nightly full baseline (schedule, fire decisions, recording a result, what the baseline feeds).
import { describe, expect, it } from "vitest";
import { agentXError, CoverageMapSchema, NightlyBaselineSchema, TestEnvironmentBodySchema, projectMetaKey, type CoverageMapData, type TestEnvironmentBody } from "@agentx/contracts";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport } from "../../packages/broker/src/org/test-environment.js";
import {
  NIGHTLY_FIRE_MAX_AGE_MS, alreadyFailingTests, coverageMapDigest, deleteNightlySchedule, handleNightlyFire, lastNightlyFailures, mapAgeDays, nightlyExpression, nightlyScheduleName, nightlySlotId,
  putNightlySchedule, readCoverageMap, readNightlyBaseline, recordNightlyResult, splitFailures, syncNightlySchedule, type MapStore, type NightlyDeps,
} from "../../packages/broker/src/test-env/nightly.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeSchedulerClient } from "../support/fake-scheduler.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const PROJECT = "partner-service";
const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
const SCHEDULED = new Date(T0 - 5_000).toISOString();
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (nightly: Partial<TestEnvironmentBody["nightly"]> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main", ...nightly },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
});

async function harness(nightly: Partial<TestEnvironmentBody["nightly"]> = {}) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const clock = { now: T0 };
  const heads: { value: string | undefined; throws: boolean } = { value: HEAD1, throws: false };
  const started: Array<Record<string, unknown>> = [];
  const startFails = { value: false };
  const admitted: Array<Record<string, unknown>> = [];
  const admitError: { value: Error | undefined } = { value: undefined };
  const deps: NightlyDeps = {
    documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit,
    secondPerson: () => Promise.resolve({ mode: "second_person" as const, membershipVersion: 1, conditions: [] }),
    runs: {
      admit: (input) => { admitted.push(input); return admitError.value === undefined ? Promise.resolve() : Promise.reject(admitError.value); },
      headOf: () => (heads.throws ? Promise.reject(new Error("github down")) : Promise.resolve(heads.value)),
      startRun: (input) => { if (startFails.value) return Promise.reject(new Error("no capacity")); started.push(input); return Promise.resolve(); },
    },
  };
  const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: body(nightly) });
  await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "smoke", status: "passed", durationMs: 1 }], services: [], finishedAt: "2026-11-05T00:00:00.000Z" } });
  await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-nightly-1", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: T0, approval: { approverId: "dev_b", signedInAtMs: T0, sessionRef: "5".repeat(64) } });
  const maps = new Map<string, unknown>();
  const store: MapStore = { put: (_o, _p, map) => { const digest = coverageMapDigest(map); maps.set(digest, map); return Promise.resolve(digest); }, get: (_o, _p, digest) => Promise.resolve(maps.get(digest)) };
  const fire = (scheduledAt = SCHEDULED) => ({ source: "agentx.test-env-nightly", orgId: ORG, project: PROJECT, scheduledAt });
  return { db, deps, clock, heads, started, startFails, admitted, admitError, maps, store, fire };
}

const map = (builtAt = new Date(T0).toISOString()): CoverageMapData => ({ builtAt, files: { "src/match.py": ["tests/test_a.py::t1"], "src/rank.py": ["tests/test_b.py::t2"] } });
function result(slotId: string, over: Record<string, unknown> = {}) {
  const coverage = map();
  return {
    result: { schemaVersion: 1, slotId, envRevision: 1, branch: "main", headSha: HEAD1, startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 40 * 60_000).toISOString(), durationMs: 40 * 60_000,
      tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["tests/test_x.py::bad1", "tests/test_x.py::bad2"], flaky: ["tests/test_y.py::flaky1"], coverageMapRef: coverageMapDigest(coverage), slowest: [{ id: "tests/test_z.py::slow", durationMs: 9_000 }], ...over },
    coverageMap: coverage,
  };
}

describe("the schedule", () => {
  const settings = { groupName: "rovara-test-schedules", roleArn: "arn:aws:iam::123456789012:role/scheduler", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:broker", queueArn: "arn:aws:sqs:us-east-1:123456789012:dlq" };
  it("converts the cron to the scheduler's six fields, one of the two day fields a question mark, weekdays shifted to 1-7", () => {
    expect(nightlyExpression("0 6 * * *")).toBe("cron(0 6 * * ? *)");
    expect(nightlyExpression("30 2 15 * *")).toBe("cron(30 2 15 * ? *)");
    expect(nightlyExpression("0 6 * * 1-5")).toBe("cron(0 6 ? * 2,3,4,5,6 *)");
    expect(nightlyExpression("0 6 * * 0")).toBe("cron(0 6 ? * 1 *)");
    expect(nightlyExpression("0 6 * * 7")).toBe("cron(0 6 ? * 1 *)");
    expect(nightlyExpression("0 */6 * * 6,0")).toBe("cron(0 */6 ? * 1,7 *)");
  });
  it("refuses a cron the scheduler would refuse or that could run wild", () => {
    for (const bad of ["0 6 * *", "0 6 1 * 1", "61 6 * * *", "0 25 * * *", "0 6 * 13 *", "0 6 * * 8", "a b c d e", "0 6 * * */0", "5-3 6 * * *", ""]) expect(() => nightlyExpression(bad), bad).toThrow(/cron|nightly|both/);
  });
  it("creates once, updates after, and turns off without deleting; delete is repeatable", async () => {
    const client = new FakeSchedulerClient();
    const deps = { client: client as never, settings };
    await syncNightlySchedule(deps, { orgId: ORG, project: PROJECT, nightly: { enabled: true, cronUtc: "0 6 * * *" } });
    const name = nightlyScheduleName(ORG, PROJECT);
    expect(client.get(settings.groupName, name)?.state).toBe("ENABLED");
    expect(name).toMatch(/^tenightly-[0-9a-f]{40}$/u);
    await syncNightlySchedule(deps, { orgId: ORG, project: PROJECT, nightly: { enabled: false, cronUtc: "30 5 * * *" } });
    const held = client.get(settings.groupName, name);
    expect(held?.state).toBe("DISABLED");
    expect(held?.input["ScheduleExpression"]).toBe("cron(30 5 * * ? *)");
    expect(client.commands("CreateScheduleCommand")).toHaveLength(2);
    const target = held?.input["Target"] as { Input: string };
    expect(JSON.parse(target.Input)).toEqual({ source: "agentx.test-env-nightly", orgId: ORG, project: PROJECT, scheduledAt: "<aws.scheduler.scheduled-time>" });
    await deleteNightlySchedule(deps, { orgId: ORG, project: PROJECT });
    await deleteNightlySchedule(deps, { orgId: ORG, project: PROJECT });
    expect(client.get(settings.groupName, name)).toBeUndefined();
    await expect(putNightlySchedule(deps, { orgId: ORG, project: PROJECT, cronUtc: "bad", enabled: true })).rejects.toThrow();
    client.down = new Error("outage");
    await expect(putNightlySchedule(deps, { orgId: ORG, project: PROJECT, cronUtc: "0 6 * * *", enabled: true })).rejects.toThrow("outage");
  });
  it("names are per project and stable", () => {
    expect(nightlyScheduleName(ORG, "a")).toBe(nightlyScheduleName(ORG, "a"));
    expect(nightlyScheduleName(ORG, "a")).not.toBe(nightlyScheduleName(ORG, "b"));
    expect(nightlyScheduleName(ORG, "a")).not.toBe(nightlyScheduleName("org_bbbbbbbbbbbbbbbbbbbb", "a"));
  });
});

describe("a fire", () => {
  it("starts one run for the branch head, once per slot", async () => {
    const h = await harness();
    const first = await handleNightlyFire(h.deps, h.fire());
    expect(first).toEqual({ outcome: "started", slotId: nightlySlotId(ORG, PROJECT, SCHEDULED) });
    expect(h.started).toEqual([{ orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD1, envRevision: 1, slotId: nightlySlotId(ORG, PROJECT, SCHEDULED), payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" }]);
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "already_handled" });
    expect(h.started).toHaveLength(1);
  });
  it("two fires at the same moment start one run", async () => {
    const h = await harness();
    const both = await Promise.all([handleNightlyFire(h.deps, h.fire()), handleNightlyFire(h.deps, h.fire())]);
    expect(both.filter((one) => one.outcome === "started")).toHaveLength(1);
    expect(h.started).toHaveLength(1);
  });
  it("skips, with a fixed reason, when nothing merged, the head cannot be read, nightly is off, or there is no environment", async () => {
    const h = await harness();
    h.heads.throws = true;
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    h.heads.throws = false;
    h.heads.value = "not-a-sha";
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    h.heads.value = undefined;
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(h.started).toHaveLength(0);
    const off = await harness({ enabled: false });
    expect(await handleNightlyFire(off.deps, off.fire())).toEqual({ outcome: "skipped", reason: "nightly_off" });
    const none = await harness();
    const other = { ...none.fire(), project: "other-project" };
    expect(await handleNightlyFire(none.deps, other)).toEqual({ outcome: "skipped", reason: "environment_missing" });
  });
  it("skips a stale fire, and a fire from the future, and refuses what is not a fire", async () => {
    const h = await harness();
    expect(await handleNightlyFire(h.deps, h.fire(new Date(T0 - NIGHTLY_FIRE_MAX_AGE_MS - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "stale_fire" });
    expect(await handleNightlyFire(h.deps, h.fire(new Date(T0 + 3_600_000).toISOString()))).toEqual({ outcome: "skipped", reason: "stale_fire" });
    await expect(handleNightlyFire(h.deps, { source: "other" })).rejects.toThrow(/not a nightly fire/);
    expect(h.started).toHaveLength(0);
  });
  it("does not start a second run while one is in flight, but does once it is long over", async () => {
    const h = await harness();
    await handleNightlyFire(h.deps, h.fire());
    h.clock.now += 3_600_000;
    expect(await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "still_running" });
    h.clock.now += 29 * 3_600_000;
    expect((await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 1_000).toISOString()))).outcome).toBe("started");
  });
  it("charges the night to the project before anything is claimed, as 'nightly baseline'", async () => {
    const h = await harness();
    await handleNightlyFire(h.deps, h.fire());
    expect(h.admitted).toEqual([{ orgId: ORG, project: PROJECT, purpose: "nightly_baseline" }]);
  });
  it("is skipped, not retried and not started, when the project's budget has no room; it starts when there is room again", async () => {
    const h = await harness();
    h.admitError.value = agentXError("PROJECT_BUDGET_EXCEEDED", "The partner-service project's monthly AI budget is used up.");
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "budget" });
    expect(h.started).toHaveLength(0);
    expect(h.db.find((item) => String(item.sk).startsWith("TESTENV#NIGHTLY#"))).toHaveLength(0);
    h.admitError.value = undefined;
    expect((await handleNightlyFire(h.deps, h.fire())).outcome).toBe("started");
  });
  it("a fault that is not a budget refusal is thrown for the scheduler to retry, with nothing claimed", async () => {
    const h = await harness();
    h.admitError.value = new Error("ledger unavailable");
    await expect(handleNightlyFire(h.deps, h.fire())).rejects.toThrow("ledger unavailable");
    expect(h.db.find((item) => String(item.sk).startsWith("TESTENV#NIGHTLY#"))).toHaveLength(0);
  });
  it("starts at most one run per project per day, however often the cron fires and however often the head moves", async () => {
    const h = await harness({ cronUtc: "* * * * *" });
    const first = await handleNightlyFire(h.deps, h.fire());
    if (first.outcome !== "started") throw new Error("not started");
    const data = result(first.slotId);
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.heads.value = HEAD2;
    for (let minute = 1; minute <= 5; minute += 1) {
      h.clock.now = T0 + minute * 60_000;
      expect(await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "ran_recently" });
    }
    expect(h.started).toHaveLength(1);
    h.clock.now = T0 + 21 * 3_600_000;
    expect((await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 1_000).toISOString()))).outcome).toBe("started");
  });
  it("the 20 hour gap holds across midnight: a run that finished at 22:40 UTC is not followed by one at 06:00 the next day, but is after the gap", async () => {
    const h = await harness();
    h.clock.now = Date.UTC(2026, 10, 5, 22, 0, 5);
    const first = await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 5_000).toISOString()));
    if (first.outcome !== "started") throw new Error("not started");
    const finished = Date.UTC(2026, 10, 5, 22, 40, 0);
    const data = result(first.slotId, { startedAt: new Date(h.clock.now).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - h.clock.now });
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.heads.value = HEAD2;
    // 06:00 on the next UTC day: a new day, a moved head, an idle project, but only 7 h 20 min since the last run finished.
    h.clock.now = Date.UTC(2026, 10, 6, 6, 0, 5);
    expect(await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 5_000).toISOString()))).toEqual({ outcome: "skipped", reason: "ran_recently" });
    expect(h.started).toHaveLength(1);
    expect(h.admitted).toHaveLength(1);
    // 20 h after it finished (18:40) the next night may run.
    h.clock.now = Date.UTC(2026, 10, 6, 18, 41, 0);
    expect((await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 5_000).toISOString()))).outcome).toBe("started");
  });
  it("the day's claim is made in the database, so two fires that raced past the other checks start one run", async () => {
    const h = await harness();
    h.db.set({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: `TESTENV#NIGHTLY#DAY#${new Date(T0).toISOString().slice(0, 10)}`, slotId: "f".repeat(64) });
    expect(await handleNightlyFire(h.deps, h.fire())).toEqual({ outcome: "skipped", reason: "ran_recently" });
    expect(h.started).toHaveLength(0);
    expect(h.db.get({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: "TESTENV#NIGHTLY#ACTIVE" })).toBeUndefined();
  });
  it("throws, and lets the scheduler retry the slot, when the run cannot be started", async () => {
    const h = await harness();
    h.startFails.value = true;
    await expect(handleNightlyFire(h.deps, h.fire())).rejects.toThrow("no capacity");
    h.startFails.value = false;
    expect((await handleNightlyFire(h.deps, h.fire())).outcome).toBe("started");
    expect(h.started).toHaveLength(1);
  });
});

describe("recording a result, and what it feeds", () => {
  it("is skipped as 'no merges' after a run for the same head, and runs again when the head moves", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId);
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.clock.now += 24 * 3_600_000;
    const next = new Date(h.clock.now - 1_000).toISOString();
    expect(await handleNightlyFire(h.deps, h.fire(next))).toEqual({ outcome: "skipped", reason: "no_merges" });
    h.heads.value = HEAD2;
    expect((await handleNightlyFire(h.deps, h.fire(next))).outcome).toBe("started");
  });
  it("stores the baseline, the already-failing set, the flaky set and the coverage map, bound to their digest", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId);
    expect(await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).toEqual({ recorded: true, flakyCount: 1, failingCount: 2 });
    const baseline = NightlyBaselineSchema.parse(await readNightlyBaseline(h.deps, ORG, PROJECT));
    expect(baseline).toMatchObject({ envRevision: 1, headSha: HEAD1, flaky: ["tests/test_y.py::flaky1"], coverageMapRef: coverageMapDigest(data.coverageMap) });
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual(["tests/test_x.py::bad1", "tests/test_x.py::bad2"]);
    expect(await lastNightlyFailures(h.deps, ORG, PROJECT)).toEqual(["tests/test_x.py::bad1", "tests/test_x.py::bad2"]);
    expect(CoverageMapSchema.safeParse(await readCoverageMap(h.deps, h.store, ORG, PROJECT)).success).toBe(true);
    expect(mapAgeDays(baseline, T0 + 8 * 86_400_000)).toBe(8);
    expect(mapAgeDays(undefined, T0)).toBeUndefined();
    // The flaky test is not excused as already failing: a flake is not a known failure.
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).not.toContain("tests/test_y.py::flaky1");
  });
  it("a tampered stored map reads as no map", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId);
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.maps.set(coverageMapDigest(data.coverageMap), { ...data.coverageMap, files: { "src/match.py": [] } });
    expect(await readCoverageMap(h.deps, h.store, ORG, PROJECT)).toBeUndefined();
  });
  it("refuses a result for a slot nobody is waiting for, one recorded twice, an unreadable one, and a map that is not the one named", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId);
    const record = (over: { result?: unknown; coverageMap?: unknown }) => recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: over.result ?? data.result, coverageMap: "coverageMap" in over ? over.coverageMap : data.coverageMap });
    await expect(record({ result: result("f".repeat(64)).result })).rejects.toThrow(/no nightly run is waiting/);
    await expect(record({ result: { nonsense: 1 } })).rejects.toThrow(/could not be read/);
    await expect(record({ coverageMap: { ...data.coverageMap, files: { "src/other.py": ["t"] } } })).rejects.toThrow(/does not match/);
    await expect(record({ coverageMap: undefined })).rejects.toThrow(/did not send/);
    expect(await readNightlyBaseline(h.deps, ORG, PROJECT)).toBeUndefined();
    await record({});
    await expect(record({})).rejects.toThrow(/no nightly run is waiting/);
  });
  it("refuses a result from before an environment change", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId, { envRevision: 2 });
    await expect(recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).rejects.toThrow(/environment changed/);
  });
  it("keeps the last good map when a run records none, and excuses no failure when the baseline is damaged", async () => {
    const h = await harness();
    const first = await handleNightlyFire(h.deps, h.fire());
    if (first.outcome !== "started") throw new Error("not started");
    const one = result(first.slotId);
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: one.result, coverageMap: one.coverageMap });
    h.clock.now += 24 * 3_600_000;
    h.heads.value = HEAD2;
    const second = await handleNightlyFire(h.deps, h.fire(new Date(h.clock.now - 1_000).toISOString()));
    if (second.outcome !== "started") throw new Error("not started");
    const noMap = result(second.slotId, { headSha: HEAD2, coverageMapRef: undefined, failed: [], tests: { total: 10, passed: 9, failed: 0, skipped: 1 } });
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: noMap.result });
    const baseline = await readNightlyBaseline(h.deps, ORG, PROJECT);
    expect(baseline?.coverageMapRef).toBe(coverageMapDigest(one.coverageMap));
    expect(baseline?.coverageMapBuiltAt).toBe(one.coverageMap.builtAt);
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual([]);
    h.db.set({ ...h.db.get({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: "TESTENV#BASELINE#LATEST" })!, baseline: "garbage" });
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual([]);
    await expect(readNightlyBaseline(h.deps, ORG, PROJECT)).rejects.toThrow(/could not be read/);
  });
  it("excuses nothing when the baseline's failing set did not fit", async () => {
    const h = await harness();
    const started = await handleNightlyFire(h.deps, h.fire());
    if (started.outcome !== "started") throw new Error("not started");
    const many = result(started.slotId, { tests: { total: 3_000, passed: 2_000, failed: 1_000, skipped: 0 }, failed: Array.from({ length: 500 }, (_, index) => `t.py::f${String(index)}`) });
    await recordNightlyResult(h.deps, h.store, { orgId: ORG, project: PROJECT, result: many.result, coverageMap: many.coverageMap });
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual([]);
    expect(await lastNightlyFailures(h.deps, ORG, PROJECT)).toHaveLength(500);
  });
  it("validates a result's own arithmetic and splits first-run failures into failing and flaky", () => {
    expect(splitFailures(["a", "b", "c", "a"], ["b", "x"])).toEqual({ failed: ["b"], flaky: ["a", "c"] });
    const bad = (over: Record<string, unknown>) => { try { return recordNightlyResult({ documentClient: new FakeDynamoDb(), tableName: "state", now: () => T0 }, {} as MapStore, { orgId: ORG, project: PROJECT, result: result("a".repeat(64), over).result }); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("x")); } };
    return Promise.all([
      expect(bad({ tests: { total: 9, passed: 7, failed: 2, skipped: 1 } })).rejects.toThrow(/could not be read/),
      expect(bad({ flaky: ["tests/test_x.py::bad1"] })).rejects.toThrow(/could not be read/),
      expect(bad({ finishedAt: new Date(T0 - 1_000).toISOString() })).rejects.toThrow(/could not be read/),
    ]).then(() => undefined);
  });
});
