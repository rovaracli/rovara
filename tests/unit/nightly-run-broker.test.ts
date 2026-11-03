// NH-1: the nightly run on the broker's side. The fire starts a run (the project pays, as the person who approved the environment), the worker's result is accepted only for the run it was started for, and with the
// switches off nothing runs and nothing is read.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { NightlyResultSchema, TestEnvironmentBodySchema, agentXError, projectMetaKey, projectPk, systemOwnerIdOf, type NightlyResult, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { setAutomaticRunsCap } from "../../packages/broker/src/automatic-runs/cap.js";
import { resolvePayer } from "../../packages/broker/src/spend/payer.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { handleNightlyFire, readNightlyBaseline, coverageMapDigest, nightlySlotId, type MapStore } from "../../packages/broker/src/test-env/nightly.js";
import { handleNightlyResultCallback, nightlyRunOfOperation, type NightlyOperation } from "../../packages/broker/src/test-env/nightly-callback.js";
import { isNightlyOperation, nightlyEndItems, nightlyRequestId, nightlyRunPayloadOf, nightlyRunPort, skipReasonOf } from "../../packages/broker/src/test-env/nightly-run.js";
import { NIGHT_WORDS, readLatestNight, readNightRows } from "../../packages/broker/src/test-env/night-status.js";
import { fireTestEnvNightly } from "../../packages/broker/src/test-env/nightly-wiring.js";
import { alreadyFailingTests, failingSetIsWhole } from "../../packages/broker/src/test-env/nightly.js";
import { nightlyRunsOf, s3CoverageMapStore } from "../../packages/broker/src/aws/broker/nightly-run-wiring.js";
import { readProjectHealth } from "../../packages/broker/src/test-env/health.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "partner-service";
const HEAD = "a".repeat(40);
const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
const SCHEDULED = new Date(T0 - 5_000).toISOString();
const ON = { TEST_ENVIRONMENT_ENABLED: "1", NIGHTLY_HEALTH_ENABLED: "1" } as NodeJS.ProcessEnv;
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const SERVICE = { name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } };
const body = (withServices = false, withSmoke = false): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [...(withSmoke ? [{ id: "smoke", label: "Smoke", command: cmd("pytest", ["smoke"]), kind: "smoke" }] : []), { id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: withServices ? [SERVICE] : [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

async function harness(options: { approve?: boolean; services?: boolean; smoke?: boolean } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const clock = { now: T0 };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: capturingAuditDeps({ db }).audit, secondPerson: () => Promise.resolve({ mode: "second_person" as const, membershipVersion: 1, conditions: [] }) };
  if (options.approve !== false) {
    const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: body(options.services === true, options.smoke === true) });
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "smoke", status: "passed", durationMs: 1 }], services: [], finishedAt: "2026-11-05T00:00:00.000Z" } });
    await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-nightly-run-1", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: T0, approval: { approverId: "dev_b", signedInAtMs: T0, sessionRef: "5".repeat(64) } });
  }
  const head = { value: HEAD };
  const defaultBranch: { value: string | undefined } = { value: "main" };
  const registries: { value: boolean | undefined } = { value: false };
  const started: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- the request shape is asserted field by field
  const admitted: unknown[] = [];
  const startError: { value: Error | undefined } = { value: undefined };
  const maps = new Map<string, unknown>();
  const store: MapStore = { put: (_o, _p, map) => { const digest = coverageMapDigest(map); maps.set(digest, map); return Promise.resolve(digest); }, get: (_o, _p, digest) => Promise.resolve(maps.get(digest)) };
  const runs = nightlyRunPort({
    ...deps,
    admitProject: (input) => { admitted.push(input); return Promise.resolve(); },
    defaultBranchOf: () => Promise.resolve(defaultBranch.value),
    usesRegistries: () => Promise.resolve(registries.value),
    headOf: () => Promise.resolve(head.value),
    // The shared start, as the task start makes its records: a task of purpose nightly_run with what it was started to run, and the pointer of its workspace.
    startAgentRun: (request) => {
      if (startError.value !== undefined) return Promise.reject(startError.value);
      started.push(request as never);
      db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: request.orgId, project: request.project, workspaceId: WORKSPACE, purpose: "nightly_run", nightlyRun: request.nightlyRun, startedBy: request.startedBy, payer: { kind: "project", project: request.project } });
      db.set({ ...taskPointerKey(WORKSPACE), entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: request.owner.developerId });
      return Promise.resolve({ taskId: TASK, runLimitUsd: 1, stopAtUsd: 1, paused: false });
    },
  });
  const fire = (scheduledAt = SCHEDULED) => ({ source: "agentx.test-env-nightly", orgId: ORG, project: PROJECT, scheduledAt });
  return { db, deps, clock, head, defaultBranch, registries, started, admitted, startError, store, runs, fire, fireNow: (scheduledAt = SCHEDULED) => handleNightlyFire({ ...deps, runs }, fire(scheduledAt)) };
}
type Harness = Awaited<ReturnType<typeof harness>>;

const slotOf = (scheduledAt = SCHEDULED) => nightlySlotId(ORG, PROJECT, scheduledAt);
const OPERATION: NightlyOperation = { kind: "task", workflowMode: "CHECKS", status: "RUNNING", workspaceId: WORKSPACE, orgId: ORG };
function result(over: Record<string, unknown> = {}, healthOver: Record<string, unknown> = {}): { result: NightlyResult; coverageMap?: unknown } {
  const coverageMap = { builtAt: new Date(T0).toISOString(), files: { "src/match.py": ["tests/test_a.py::t1"] } };
  return { coverageMap, result: NightlyResultSchema.parse({
    schemaVersion: 1, slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD, startedAt: new Date(T0 - 40 * 60_000).toISOString(), finishedAt: new Date(T0).toISOString(), durationMs: 40 * 60_000,
    tests: { total: 10, passed: 8, failed: 1, skipped: 1 }, failed: ["tests/test_x.py::bad1"], flaky: [], coverageMapRef: coverageMapDigest(coverageMap), slowest: [],
    health: { steps: [{ step: "pull", status: "passed" }, { step: "setup", status: "passed" }, { step: "build", status: "passed" }, { step: "smoke", status: "passed" }, { step: "full_suite", status: "failed" }],
      checks: [{ runsTests: true, started: true, timedOut: false, reportApproved: true, reportWritten: true, testsCollected: 10 }], tests: { total: 10, passed: 8, failures: 1, errors: 0, skipped: 1 }, ranFrom: "fresh", ...healthOver },
    ...over,
  }) };
}
const record = (h: Harness, sent: { result: unknown; coverageMap?: unknown }, operation: NightlyOperation = OPERATION, env: NodeJS.ProcessEnv = ON) =>
  handleNightlyResultCallback({ ...h.deps, maps: h.store }, operation, sent, env);
const baselineOf = (h: Harness) => readNightlyBaseline(h.deps, ORG, PROJECT);
const codeOf = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe("a fire starts the run", () => {
  it("as the project's system owner (no person), with the project as payer, for the commit the broker read; the budget is asked first", async () => {
    const h = await harness();
    expect(await h.fireNow()).toEqual({ outcome: "started", slotId: slotOf() });
    expect(h.admitted).toEqual([{ orgId: ORG, project: PROJECT }]);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({
      requestId: nightlyRequestId(slotOf()), orgId: ORG, project: PROJECT, origin: "nightly", owner: { developerId: systemOwnerIdOf(ORG, PROJECT) }, automatic: { job: "nightly", approvedBy: "dev_a" },
      payer: { kind: "project", project: PROJECT }, nightlyRun: { slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD },
    });
    expect((h.started[0]!["input"] as { text: string }).text).toContain(PROJECT);
    expect(nightlyRequestId(slotOf())).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("the approver is on the record as who approved the setup and owns nothing: the owner is the system owner, and no one started it", async () => {
    const h = await harness();
    await h.fireNow();
    expect(h.started[0]!["owner"]).toEqual({ developerId: systemOwnerIdOf(ORG, PROJECT) });
    expect(h.started[0]!["automatic"]).toEqual({ job: "nightly", approvedBy: "dev_a" });
    expect(h.started[0]!["startedBy"]).toBeUndefined();
    expect((h.started[0]!["input"] as { text: string }).text).toMatch(/^Nightly test run for the project/u);
  });

  it("the nightly origin is the project's own work whatever the project's AI settings say about paying for tasks", () => {
    const input = { origin: "nightly" as const, project: PROJECT, startedBy: { developerId: "dev_a" } };
    expect(resolvePayer({ ...input, projectPays: false })).toEqual({ kind: "project", project: PROJECT });
    expect(resolvePayer({ ...input, projectPays: true })).toEqual({ kind: "project", project: PROJECT });
  });

  it("once per day: a second fire the same day starts nothing", async () => {
    const h = await harness();
    await h.fireNow();
    h.clock.now = T0 + 3_600_000;
    const again = await h.fireNow(new Date(T0 + 3_595_000).toISOString());
    expect(again.outcome).toBe("skipped");
    expect(h.started).toHaveLength(1);
  });

  it("once per day, even when the branch moved: after a night was recorded, a second fire inside the day starts nothing; the next day it may", async () => {
    const h = await harness();
    await h.fireNow();
    await record(h, result());
    h.head.value = "f".repeat(40);
    h.clock.now = T0 + 6 * 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toEqual({ outcome: "skipped", reason: "ran_recently" });
    expect(h.started).toHaveLength(1);
    h.clock.now = T0 + 24 * 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "started" });
    expect(h.started).toHaveLength(2);
  });

  it("the project's monthly cap on automatic runs pauses the nights: the night is skipped with automatic_cap, nothing is started and the claims are given back; a raised cap lets the next night run", async () => {
    const h = await harness();
    const cap = (value: number, requestId: string) => setAutomaticRunsCap(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", changedBy: "dev_a", cap: value, requestId });
    await cap(1, "request-cap-0001");
    await h.fireNow();
    await record(h, result());
    h.head.value = "f".repeat(40);
    h.clock.now = T0 + 24 * 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toEqual({ outcome: "skipped", reason: "automatic_cap" });
    expect(h.started).toHaveLength(1);
    // nothing stays claimed by the refused night: raising the cap lets the same fire go on
    await cap(2, "request-cap-0002");
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "started" });
    expect(h.started).toHaveLength(2);
  });

  it("main branch only (ED-1): a nightly whose branch is not the repository's default branch is skipped, with nothing charged or claimed; an unreadable default branch is a skipped night too", async () => {
    const h = await harness();
    h.defaultBranch.value = "develop";
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "branch_not_default" });
    h.defaultBranch.value = undefined;
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
    h.defaultBranch.value = "main";
    expect(await h.fireNow()).toMatchObject({ outcome: "started" });
  });

  it("a project with private package registries is skipped with a clear reason (the read-only preparation carries no registry pointer), and so is one that cannot be read; nothing is charged, claimed or started", async () => {
    const h = await harness();
    h.registries.value = true;
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "registries_unsupported" });
    h.registries.value = undefined;
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
    h.registries.value = false;
    expect(await h.fireNow()).toMatchObject({ outcome: "started" });
  });

  it("no approved environment means no run, no charge and no claim", async () => {
    const h = await harness({ approve: false });
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "environment_missing" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it("a person who can no longer start work: the night is skipped, nothing is held, and the next fire may run", async () => {
    const h = await harness();
    h.startError.value = agentXError("FORBIDDEN", "not a member");
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "owner_unavailable" });
    h.startError.value = undefined;
    expect(await h.fireNow(new Date(T0 + 60_000 - 5_000).toISOString())).toMatchObject({ outcome: "started" });
  });

  it("a full budget or workspace limit at the start is a skipped night; a fault that may pass is thrown and gives the claims back", async () => {
    const h = await harness();
    for (const [code, reason] of [["ORG_BUDGET_EXCEEDED", "budget"], ["TASK_STOP_ZERO", "budget"], ["WORKSPACE_LIMIT", "workspace_limit"], ["PROJECT_ARCHIVED", "owner_unavailable"]] as const) {
      h.startError.value = agentXError(code, "refused");
      expect(await h.fireNow(), code).toEqual({ outcome: "skipped", reason });
    }
    h.startError.value = new Error("dispatch down");
    await expect(h.fireNow()).rejects.toThrow("dispatch down");
    h.startError.value = undefined;
    expect(await h.fireNow()).toMatchObject({ outcome: "started" });
    expect(skipReasonOf(new Error("plain"))).toBeUndefined();
  });

  it("an environment revision whose record names no approver still runs: the system owner owns it, and the record names nobody as approver", async () => {
    const h = await harness();
    const skipped = await nightlyRunPort({ ...h.deps, admitProject: () => Promise.resolve(), startAgentRun: (request) => { h.started.push(request as never); return Promise.resolve({ taskId: TASK, runLimitUsd: 1, stopAtUsd: 1, paused: false }); }, defaultBranchOf: () => Promise.resolve("main"), usesRegistries: () => Promise.resolve(false), headOf: () => Promise.resolve(HEAD) })
      .startRun({ orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD, envRevision: 9, slotId: slotOf(), payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" });
    expect(skipped).toBeUndefined();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!["automatic"]).toEqual({ job: "nightly" });
  });

  it("the worker is sent the approved environment of the revision the run was started for, and nothing else is accepted", async () => {
    const h = await harness();
    const run = { slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD };
    expect((await nightlyRunPayloadOf(h.deps, ORG, PROJECT, run)).environment).toEqual(body());
    expect(await codeOf(nightlyRunPayloadOf(h.deps, ORG, PROJECT, { ...run, envRevision: 4 }))).toBe("CHANGE_STALE");
    expect(await codeOf(nightlyRunPayloadOf(h.deps, ORG, PROJECT, { ...run, branch: "develop" }))).toBe("CHANGE_STALE");
  });
});

describe("with the switches off nothing runs and nothing changes", () => {
  it("no ports are made unless nh and the test environment are both on", () => {
    const dependencies = { documentClient: {}, tableName: "t", developer: undefined } as never;
    for (const env of [{}, { NIGHTLY_HEALTH_ENABLED: "1" }, { TEST_ENVIRONMENT_ENABLED: "1" }, { NIGHTLY_HEALTH_ENABLED: "true", TEST_ENVIRONMENT_ENABLED: "true" }] as NodeJS.ProcessEnv[]) {
      expect(nightlyRunsOf(dependencies, {} as never, undefined, env)).toBeUndefined();
    }
    // Both on, but this install cannot start runs (no developer sign-in): still none.
    expect(nightlyRunsOf(dependencies, {} as never, undefined, ON)).toBeUndefined();
  });

  it("a fire answers 'run_unavailable' with no ports, charging and claiming nothing", async () => {
    const h = await harness();
    const send = vi.spyOn(h.db, "send");
    expect(await fireTestEnvNightly(h.deps, h.fire(), undefined, ON)).toEqual({ outcome: "skipped", reason: "run_unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(h.started).toEqual([]);
  });

  it("the result route answers CALLBACK_FORBIDDEN and reads nothing", async () => {
    const h = await harness();
    await h.fireNow();
    const send = vi.spyOn(h.db, "send");
    for (const env of [{}, { NIGHTLY_HEALTH_ENABLED: "1" }, { TEST_ENVIRONMENT_ENABLED: "1" }] as NodeJS.ProcessEnv[]) {
      expect(await codeOf(record(h, result(), OPERATION, env))).toBe("CALLBACK_FORBIDDEN");
    }
    expect(send).not.toHaveBeenCalled();
    expect(await baselineOf(h)).toBeUndefined();
  });
});

describe("the result route", () => {
  it("records the night for the run it was started for: the baseline, the coverage map, the classification and the project's health; the lock is released", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await record(h, result())).toEqual({ recorded: true, flakyCount: 0, failingCount: 1 });
    expect(await baselineOf(h)).toMatchObject({ envRevision: 1, branch: "main", headSha: HEAD, tests: { total: 10, passed: 8, failed: 1, skipped: 1 }, failed: ["tests/test_x.py::bad1"] });
    expect((await readProjectHealth(h.deps, ORG, PROJECT))?.state).toBeDefined();
    // The lock is gone: the same result again finds no run waiting.
    expect(await codeOf(record(h, result()))).toBe("CHANGE_STALE");
  });

  it("the org and the project come from the task, not from anything the worker says", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await nightlyRunOfOperation(h.deps, OPERATION)).toMatchObject({ orgId: ORG, project: PROJECT, taskId: TASK });
    // The body has no place to name an org or a project: a strict body refuses one.
    expect(await codeOf(record(h, { ...result(), orgId: OTHER_ORG, project: "elsewhere" } as never))).toBe("CONFIG_INVALID");
  });

  it("a forged slot id is refused: a valid operation cannot record a night for another slot, and the real slot stays waiting", async () => {
    const h = await harness();
    await h.fireNow();
    const forged = nightlySlotId(ORG, PROJECT, new Date(T0 - 86_400_000).toISOString());
    expect(await codeOf(record(h, result({ slotId: forged })))).toBe("CALLBACK_FORBIDDEN");
    expect(await baselineOf(h)).toBeUndefined();
    expect(await record(h, result())).toMatchObject({ recorded: true });
  });

  it("another company's operation is refused", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await codeOf(record(h, result(), { ...OPERATION, orgId: OTHER_ORG }))).toBe("CALLBACK_FORBIDDEN");
    // A workspace that no nightly task points at (another company's, or a setup run's) records nothing either.
    expect(await codeOf(record(h, result(), { ...OPERATION, workspaceId: "55555555-5555-4555-8555-555555555555" }))).toBe("CALLBACK_FORBIDDEN");
    h.db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG, project: PROJECT, workspaceId: WORKSPACE, purpose: "setup_agent", nightlyRun: { slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD } });
    expect(await codeOf(record(h, result()))).toBe("CALLBACK_FORBIDDEN");
    expect(await baselineOf(h)).toBeUndefined();
  });

  it("an operation that is not running, not a task operation, not the verification mode, or whose task has closed, is refused", async () => {
    const h = await harness();
    await h.fireNow();
    for (const operation of [{ ...OPERATION, status: "SUCCEEDED" }, { ...OPERATION, kind: "prepare" }, { ...OPERATION, workflowMode: "IMPLEMENT" }, { ...OPERATION, workflowMode: undefined }]) {
      expect(await codeOf(record(h, result(), operation)), JSON.stringify(operation)).toBe("CALLBACK_FORBIDDEN");
    }
    h.db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG, project: PROJECT, workspaceId: WORKSPACE, purpose: "nightly_run", nightlyRun: { slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD }, closedAt: "2026-11-05T07:00:00.000Z" });
    expect(await codeOf(record(h, result()))).toBe("CALLBACK_FORBIDDEN");
  });

  it("a stale or other revision is refused: a result for another revision than the run was started for, and a run whose environment changed after it started", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await codeOf(record(h, result({ envRevision: 2 })))).toBe("CALLBACK_FORBIDDEN");
    expect(await baselineOf(h)).toBeUndefined();
    // The environment moves on (a second revision is approved) while the night runs: the result is stale and nothing is recorded.
    const proposal = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: { ...body(), roundBudgetMin: 45 } });
    await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "smoke", status: "passed", durationMs: 1 }], services: [], finishedAt: "2026-11-05T00:00:00.000Z" } });
    await approveTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 1, requestId: "request-nightly-run-2", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: T0, approval: { approverId: "dev_b", signedInAtMs: T0, sessionRef: "5".repeat(64) } });
    expect(await codeOf(record(h, result()))).toBe("CHANGE_STALE");
    expect(await baselineOf(h)).toBeUndefined();
  });

  it("another commit than the one the run was started for is refused", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await codeOf(record(h, result({ headSha: "b".repeat(40) })))).toBe("CALLBACK_FORBIDDEN");
    expect(await codeOf(record(h, result({ branch: "develop" })))).toBe("CALLBACK_FORBIDDEN");
    expect(await baselineOf(h)).toBeUndefined();
  });

  it("a finishedAt more than five minutes in the future is refused, and the run stays waiting", async () => {
    const h = await harness();
    await h.fireNow();
    const future = result({ finishedAt: new Date(T0 + 10 * 60_000).toISOString() });
    expect(await codeOf(record(h, future))).toBe("CONFIG_INVALID");
    expect(await baselineOf(h)).toBeUndefined();
    // Inside the skew it is taken.
    expect(await record(h, result({ finishedAt: new Date(T0 + 4 * 60_000).toISOString() }))).toMatchObject({ recorded: true });
  });

  it("the counts and the step words agree: a worker's night is read by its own words, never as 'steps_disagree'", async () => {
    const h = await harness();
    await h.fireNow();
    await record(h, result());
    const stored = h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST" }) as { health?: { class: string; cause?: string } } | undefined;
    expect(stored?.health?.class).toBe("tests");
    expect(stored?.health?.cause).toBeUndefined();
    // The same night with a health block whose counts are not the result's own reads as unclear.
    const h2 = await harness();
    await h2.fireNow();
    await record(h2, result({}, { tests: { total: 10, passed: 9, failures: 0, errors: 0, skipped: 1 } }));
    const stored2 = h2.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST" }) as { health?: { class: string; cause?: string } } | undefined;
    expect(stored2?.health).toMatchObject({ class: "unclear", cause: "steps_disagree" });
  });
});

describe("the last night that left no result clears once a night is recorded (F3)", () => {
  const monday = (h: Harness) => h.fireNow();
  /** A recorded night for the fire that was scheduled at `scheduled`, finished at the harness's clock, on the harness's head. */
  const goodNight = (h: Harness, scheduled: string) => result({ slotId: nightlySlotId(ORG, PROJECT, scheduled), headSha: h.head.value, finishedAt: new Date(h.clock.now).toISOString(), startedAt: new Date(h.clock.now - 40 * 60_000).toISOString(), coverageMapRef: undefined });
  it("an infrastructure failure on Monday followed by good nights reads nothing; a failure after the good night shows again", async () => {
    const h = await harness();
    await monday(h);
    await record(h, { failed: { reason: "infra" } } as never);
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ status: "failed", reason: "infra" });
    // Tuesday: a retry is not needed; a normal fire starts and its night is recorded.
    for (const day of [1, 2]) {
      h.clock.now = T0 + day * 24 * 3_600_000;
      h.head.value = String(day).repeat(40);
      const scheduled = new Date(h.clock.now - 5_000).toISOString();
      expect(await h.fireNow(scheduled)).toMatchObject({ outcome: "started" });
      await record(h, { result: goodNight(h, scheduled).result });
      expect(await readLatestNight(h.deps, ORG, PROJECT), `day ${String(day)}`).toBeUndefined();
    }
    // Wednesday: the night fails again, and that one is the latest.
    h.clock.now = T0 + 3 * 24 * 3_600_000;
    h.head.value = "3".repeat(40);
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "started" });
    await handleNightlyResultCallback({ ...h.deps, maps: h.store }, OPERATION, { failed: { reason: "wall_clock" } }, ON);
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ status: "failed", reason: "wall_clock" });
  });
  it("the same-day retry rule does not see an infra failure that a recorded night has answered", async () => {
    const h = await harness();
    await monday(h);
    await record(h, { failed: { reason: "infra" } } as never);
    h.clock.now = T0 + 3_600_000;
    const scheduled = new Date(h.clock.now - 5_000).toISOString();
    expect(await h.fireNow(scheduled)).toMatchObject({ outcome: "started" });
    await record(h, { result: goodNight(h, scheduled).result });
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toBeUndefined();
  });
});

describe("failing tests whose ids are not valid (F5)", () => {
  const oneOdd = () => result({ tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["tests/test_x.py::bad1"], failedUnlisted: 1, coverageMapRef: undefined }, { tests: { total: 10, passed: 7, failures: 2, errors: 0, skipped: 1 } });
  it("one odd id does not disable the baseline: the listed failing tests are still excused, and the count says one was left out", async () => {
    const h = await harness();
    await h.fireNow();
    await record(h, { result: oneOdd().result });
    const baseline = (await baselineOf(h))!;
    expect(baseline).toMatchObject({ failed: ["tests/test_x.py::bad1"], failedUnlisted: 1, tests: { failed: 2 } });
    expect(failingSetIsWhole(baseline)).toBe(true);
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual(["tests/test_x.py::bad1"]);
  });
  it("a set that does not add up (the cap cut it) is still refused whole", () => {
    const whole = { failed: ["a", "b"], failedUnlisted: 1, tests: { total: 10, passed: 7, failed: 3, skipped: 0 } };
    expect(failingSetIsWhole(whole)).toBe(true);
    expect(failingSetIsWhole({ ...whole, tests: { ...whole.tests, failed: 4 } })).toBe(false);
    expect(failingSetIsWhole({ failed: ["a"], tests: { total: 3, passed: 1, failed: 2, skipped: 0 } })).toBe(false);
  });
  it("a result that claims more left-out tests than there are failing tests is refused", () => {
    const bad = oneOdd().result;
    expect(NightlyResultSchema.safeParse({ ...bad, failedUnlisted: 5 }).success).toBe(false);
  });
});

describe("a skipped smoke step", () => {
  const passingNight = () => result({ tests: { total: 10, passed: 9, failed: 0, skipped: 1 }, failed: [], flaky: [], coverageMapRef: undefined }, {
    steps: [{ step: "pull", status: "passed" }, { step: "setup", status: "passed" }, { step: "smoke", status: "skipped" }, { step: "full_suite", status: "passed" }], tests: { total: 10, passed: 9, failures: 0, errors: 0, skipped: 1 },
  });
  const stored = (h: Harness) => h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST" }) as { health?: { class: string; cause?: string } } | undefined;
  it("is fine when the broker's own approved environment defines no smoke check: the night reads as passed", async () => {
    const h = await harness();
    await h.fireNow();
    const night = passingNight();
    await record(h, { result: night.result });
    expect(stored(h)?.health).toMatchObject({ class: "passed" });
  });
  it("is NOT fine when the approved environment defines a smoke check, whatever the worker says: the night is incomplete", async () => {
    const h = await harness({ smoke: true });
    await h.fireNow();
    await record(h, { result: passingNight().result });
    expect(stored(h)?.health).toMatchObject({ class: "unclear", cause: "incomplete_run" });
  });
});

describe("the end of the task and the coverage map store", () => {
  it("a finished or cancelled nightly task gives back its workspace through agentRunEnd; a failed prepare too; nothing else", () => {
    const task = { taskId: TASK, purpose: "nightly_run" as const, project: PROJECT };
    const own = nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, "2026-11-05T07:00:00.000Z");
    expect(own).toHaveLength(1);
    expect(own[0]!.Update.ExpressionAttributeValues[":end"]).toEqual({ state: "COMPLETE", at: "2026-11-05T07:00:00.000Z" });
    expect(nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "CANCELLED" }, "x")[0]!.Update.ExpressionAttributeValues[":end"]).toMatchObject({ state: "CANCELLED" });
    expect(nightlyEndItems("T", task, { kind: "prepare" }, { status: "FAILED" }, "x")).toHaveLength(1);
    expect(nightlyEndItems("T", task, { kind: "prepare" }, { status: "SUCCEEDED" }, "x")).toEqual([]);
    expect(nightlyEndItems("T", { taskId: TASK, purpose: "setup_agent" as const, project: PROJECT }, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, "x")).toEqual([]);
    expect(nightlyEndItems("T", { taskId: TASK, project: PROJECT }, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, "x")).toEqual([]);
  });

  it("the store keeps a map under its digest, per company and project, and reads it back", async () => {
    const objects = new Map<string, string>();
    const s3 = { send: (command: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
      if (command.constructor.name === "PutObjectCommand") { objects.set(command.input.Key, command.input.Body!); return Promise.resolve({}); }
      const text = objects.get(command.input.Key);
      return text === undefined ? Promise.reject(new Error("NoSuchKey")) : Promise.resolve({ Body: { transformToString: () => Promise.resolve(text) } });
    } };
    const store = s3CoverageMapStore(s3, "bucket");
    const map = { builtAt: new Date(T0).toISOString(), files: { "src/a.py": ["tests/a.py::t"] } };
    const digest = await store.put(ORG, PROJECT, map);
    expect(digest).toBe(coverageMapDigest(map));
    expect(await store.get(ORG, PROJECT, digest)).toEqual(map);
    expect(await store.get(OTHER_ORG, PROJECT, digest)).toBeUndefined();
    expect(await store.get(ORG, "elsewhere", digest)).toBeUndefined();
    expect([...objects.keys()][0]).toMatch(/^nightly-maps\/[0-9a-f]{40}\/[0-9a-f]{40}\/[0-9a-f]{64}\.json$/u);
  });
});

describe("nights that did not finish, and nights that cannot run", () => {
  const failedBody = (reason: string) => ({ failed: { reason } });
  const rowsOf = (h: Harness) => readNightRows(h.deps, ORG, PROJECT);

  it("a failure reported by the worker is a row the health page and Home read, in fixed words; the lock is given back, the day's claim stays, and the project's health does not move", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await record(h, failedBody("wall_clock") as never)).toEqual({ recorded: false, failed: "wall_clock" });
    const latest = await readLatestNight(h.deps, ORG, PROJECT);
    expect(latest).toMatchObject({ status: "failed", reason: "wall_clock", slotId: slotOf(), words: NIGHT_WORDS.wall_clock });
    expect(latest?.words).not.toMatch(/repair/iu);
    expect(await readProjectHealth(h.deps, ORG, PROJECT)).toBeUndefined();
    expect(await baselineOf(h)).toBeUndefined();
    expect(h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#NIGHTLY#ACTIVE" })).toBeUndefined();
    expect(h.db.find((item) => item.entityType === "TEST_ENV_NIGHTLY_DAY")).toHaveLength(1);
  });

  it("a failure report is held to the same rules as a result: switches, a running nightly operation of the task, and a known word", async () => {
    const h = await harness();
    await h.fireNow();
    expect(await codeOf(record(h, failedBody("infra") as never, OPERATION, {}))).toBe("CALLBACK_FORBIDDEN");
    expect(await codeOf(record(h, failedBody("infra") as never, { ...OPERATION, status: "SUCCEEDED" }))).toBe("CALLBACK_FORBIDDEN");
    expect(await codeOf(record(h, failedBody("infra") as never, { ...OPERATION, orgId: OTHER_ORG }))).toBe("CALLBACK_FORBIDDEN");
    expect(await codeOf(record(h, failedBody("my own words") as never))).toBe("CONFIG_INVALID");
    expect(await rowsOf(h)).toEqual([]);
  });

  it("an operation that ends in failure with no word from the worker leaves an infra row; the worker's own word stands; a stop and a success leave none", async () => {
    const task = { taskId: TASK, purpose: "nightly_run" as const, project: PROJECT, orgId: ORG, nightlyRun: { slotId: slotOf(), envRevision: 1, branch: "main", headSha: HEAD } };
    const h = await harness();
    const apply = async (items: ReturnType<typeof nightlyEndItems>) => { for (const item of items) if (item.Update.Key.sk.startsWith("TESTENV#NIGHT#")) await h.db.send(new UpdateCommand(item.Update)); };
    await apply(nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "CANCELLED" }, new Date(T0).toISOString()));
    await apply(nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, new Date(T0).toISOString()));
    expect(await rowsOf(h)).toEqual([]);
    await apply(nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "FAILED" }, new Date(T0).toISOString()));
    expect((await rowsOf(h))[0]).toMatchObject({ status: "failed", reason: "infra", slotId: slotOf() });
    // The first word stands.
    await apply(nightlyEndItems("T", task, { kind: "prepare" }, { status: "FAILED" }, new Date(T0 + 1000).toISOString()));
    expect(await rowsOf(h)).toHaveLength(1);
    const h2 = await harness();
    await h2.fireNow();
    await record(h2, failedBody("branch_moved") as never);
    for (const item of nightlyEndItems("T", task, { kind: "task", workflowMode: "CHECKS" }, { status: "FAILED" }, new Date(T0).toISOString())) if (item.Update.Key.sk.startsWith("TESTENV#NIGHT#")) await h2.db.send(new UpdateCommand(item.Update));
    expect((await rowsOf(h2))[0]).toMatchObject({ reason: "branch_moved" });
  });

  it("at most ONE same-day retry, and only after an infrastructure failure", async () => {
    const h = await harness();
    await h.fireNow();
    await record(h, failedBody("infra") as never);
    h.clock.now = T0 + 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "started" });
    expect(h.started).toHaveLength(2);
    // The retry fails too: the day is done.
    await handleNightlyResultCallback({ ...h.deps, maps: h.store }, OPERATION, failedBody("infra"), ON);
    h.clock.now = T0 + 2 * 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "skipped" });
    expect(h.started).toHaveLength(2);
    // The next day is a new day.
    h.clock.now = T0 + 24 * 3_600_000;
    expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString())).toMatchObject({ outcome: "started" });
  });

  it("a failure that is not the infrastructure's (branch moved, wall clock, worker refused) is not retried the same day", async () => {
    for (const reason of ["branch_moved", "wall_clock", "worker_refused"]) {
      const h = await harness();
      await h.fireNow();
      await record(h, failedBody(reason) as never);
      h.clock.now = T0 + 3_600_000;
      expect(await h.fireNow(new Date(h.clock.now - 5_000).toISOString()), reason).toMatchObject({ outcome: "skipped" });
      expect(h.started, reason).toHaveLength(1);
    }
  });

  it("services: the fire skips with services_unsupported before any charge, preparation or task, and leaves a neutral note that is never 'needs repair'", async () => {
    const h = await harness({ services: true });
    expect(await h.fireNow()).toEqual({ outcome: "skipped", reason: "services_unsupported" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
    const latest = await readLatestNight(h.deps, ORG, PROJECT);
    expect(latest).toMatchObject({ status: "unavailable", reason: "services_unsupported", words: "Nightly not available: this setup's services can't be started by nightly runs yet." });
    expect(await readProjectHealth(h.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("the other reasons that a night cannot run leave a note too; an ordinary skip (no merges) leaves none", async () => {
    const h = await harness();
    h.registries.value = true;
    await h.fireNow();
    expect((await readLatestNight(h.deps, ORG, PROJECT))?.reason).toBe("registries_unsupported");
    const g = await harness();
    g.defaultBranch.value = "develop";
    await g.fireNow();
    expect((await readLatestNight(g.deps, ORG, PROJECT))?.reason).toBe("branch_not_default");
    const k = await harness({ approve: false });
    await k.fireNow();
    expect(await readLatestNight(k.deps, ORG, PROJECT)).toBeUndefined();
  });
});

describe("who is granted the nightly action", () => {
  it("only the verification operation of a nightly task: not another mode of it, not any operation of another task, not a task with no purpose", () => {
    expect(isNightlyOperation({ purpose: "nightly_run" }, "CHECKS")).toBe(true);
    for (const mode of ["PLAN", "IMPLEMENT", "REVIEW", "SETUP_AGENT", "SETUP_DRAFT", undefined]) expect(isNightlyOperation({ purpose: "nightly_run" }, mode), String(mode)).toBe(false);
    for (const purpose of ["setup_agent", "setup_draft", "diagnosis", undefined] as const) expect(isNightlyOperation(purpose === undefined ? {} : { purpose }, "CHECKS"), String(purpose)).toBe(false);
    expect(isNightlyOperation(undefined, "CHECKS")).toBe(false);
  });
});
