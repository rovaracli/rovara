// Test environment (wire-testenv): the nightly full run as far as it is connected. The schedule follows the approved environment, only while the switch is on; the fire is routed to the decision, and it
// charges nothing and claims nothing while no run can be started.
import { CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { describe, expect, it, vi } from "vitest";
import { NIGHTLY_SOURCE, TestEnvironmentBodySchema, projectMetaKey, projectPk, testEnvDigest, type OrgId, type TestEnvironment, type TestEnvironmentBody } from "@agentx/contracts";
import type { TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { fireTestEnvNightly, isTestEnvNightlyEvent, nightlyHooks, nightlyScheduleDependencies } from "../../packages/broker/src/test-env/nightly-wiring.js";
import { nightlyScheduleName, type NightlyRunPort } from "../../packages/broker/src/test-env/nightly.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { TEST_ENVIRONMENT_ENABLED: "1" };
const SCHEDULER_ENV = {
  ...ON, AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AWS_LAMBDA_FUNCTION_NAME: "agentx-staging-broker",
  CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx-staging-chain-schedule", CHAIN_SCHEDULE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-chain-schedule",
} as NodeJS.ProcessEnv;
const cmd = { cwd: "service", executable: "pytest", args: ["-q"], timeoutSeconds: 600 };
const body = (nightly = { enabled: true, cronUtc: "0 6 * * *", branch: "main" }): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd, kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const approved = (nightly?: Parameters<typeof body>[0]): TestEnvironment => ({ revision: 1, approvedAt: "2026-11-02T10:00:00.000Z", environment: body(nightly) });

function scheduler() {
  const sent: unknown[] = [];
  return { sent, client: { send: vi.fn(async (command: unknown) => { sent.push(command); return {}; }) } };
}

describe("the nightly event", () => {
  it("is the scheduler's own invocation: its source, and no request context", () => {
    expect(isTestEnvNightlyEvent({ source: NIGHTLY_SOURCE, orgId: ORG })).toBe(true);
    expect(isTestEnvNightlyEvent({ source: NIGHTLY_SOURCE, requestContext: {} })).toBe(false);
    expect(isTestEnvNightlyEvent({ source: "agentx.chain-schedule" })).toBe(false);
    expect(isTestEnvNightlyEvent(null)).toBe(false);
    expect(isTestEnvNightlyEvent("agentx.test-env-nightly")).toBe(false);
  });
});

describe("the schedule follows the approved environment", () => {
  it("makes one schedule for a project that turned the nightly run on, in the install's schedule group, with the project's own time", async () => {
    const s = scheduler();
    await nightlyHooks({ scheduling: nightlyScheduleDependencies(SCHEDULER_ENV, s.client) }, SCHEDULER_ENV).onApproved!(ORG, PROJECT, approved());
    expect(s.sent).toHaveLength(1);
    const command = s.sent[0] as CreateScheduleCommand;
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input).toMatchObject({ Name: nightlyScheduleName(ORG, PROJECT), State: "ENABLED", ScheduleExpression: "cron(0 6 * * ? *)", ScheduleExpressionTimezone: "UTC" });
    expect(command.input.GroupName).toContain("staging");
    expect(JSON.parse(command.input.Target!.Input!)).toMatchObject({ source: NIGHTLY_SOURCE, orgId: ORG, project: PROJECT });
  });

  it("deletes the project's schedule when the approved environment has it off, and makes none for a project that never had it on", async () => {
    const s = scheduler();
    await nightlyHooks({ scheduling: nightlyScheduleDependencies(SCHEDULER_ENV, s.client) }, SCHEDULER_ENV).onApproved!(ORG, PROJECT, approved({ enabled: false, cronUtc: "0 6 * * *", branch: "main" }));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toBeInstanceOf(DeleteScheduleCommand);
    expect(s.sent.some((command) => command instanceof CreateScheduleCommand)).toBe(false);
  });

  it("with the switch off nothing is made, deleted or asked, whatever the environment says", async () => {
    const s = scheduler();
    for (const env of [{ ...SCHEDULER_ENV, TEST_ENVIRONMENT_ENABLED: "0" }, { ...SCHEDULER_ENV, TEST_ENVIRONMENT_ENABLED: "true" }, { ...SCHEDULER_ENV, TEST_ENVIRONMENT_ENABLED: undefined }] as NodeJS.ProcessEnv[]) {
      await nightlyHooks({ scheduling: nightlyScheduleDependencies(SCHEDULER_ENV, s.client) }, env).onApproved!(ORG, PROJECT, approved());
    }
    expect(s.sent).toEqual([]);
  });

  it("an install with no schedule group settings makes nothing", async () => {
    const s = scheduler();
    expect(nightlyScheduleDependencies({ ...ON }, s.client)).toBeUndefined();
    await nightlyHooks({}, { ...ON }).onApproved!(ORG, PROJECT, approved());
    expect(s.sent).toEqual([]);
  });

  it("an hourly cron is refused by the scheduler's own rules before anything is sent", async () => {
    const s = scheduler();
    await expect(nightlyHooks({ scheduling: nightlyScheduleDependencies(SCHEDULER_ENV, s.client) }, SCHEDULER_ENV).onApproved!(ORG, PROJECT, approved({ enabled: true, cronUtc: "0 6 1 * 1", branch: "main" }))).rejects.toThrow(/day of the month or the day of the week/);
    expect(s.sent).toEqual([]);
  });
});

describe("a nightly fire", () => {
  function world() {
    const db = new FakeDynamoDb();
    db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
    const environment = body();
    db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001", entityType: "TEST_ENV_REVISION", orgId: ORG, project: PROJECT, revision: 1, approvedAt: "2026-11-02T10:00:00.000Z", digest: testEnvDigest(environment), environment });
    db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#LATEST", entityType: "TEST_ENV_LATEST", orgId: ORG, project: PROJECT, revision: 1, digest: testEnvDigest(environment) });
    const now = Date.UTC(2026, 10, 3, 6, 0, 30);
    const reads = vi.fn(db.send.bind(db));
    const deps: TestEnvDeps = { documentClient: { send: reads }, tableName: "state", now: () => now };
    const fire = { source: NIGHTLY_SOURCE, orgId: ORG, project: PROJECT, scheduledAt: new Date(Date.UTC(2026, 10, 3, 6, 0, 0)).toISOString() };
    return { db, deps, reads, fire };
  }
  const runs = (over: Partial<NightlyRunPort> = {}): NightlyRunPort & { started: unknown[]; admitted: unknown[] } => {
    const started: unknown[] = [];
    const admitted: unknown[] = [];
    return { started, admitted, admit: async (input) => { admitted.push(input); }, headOf: async () => "a".repeat(40), startRun: async (input) => { started.push(input); }, ...over };
  };

  it("with the switch off reads nothing", async () => {
    const w = world();
    for (const env of [{}, { TEST_ENVIRONMENT_ENABLED: "0" }, { TEST_ENVIRONMENT_ENABLED: "true" }]) expect(await fireTestEnvNightly(w.deps, w.fire, runs(), env)).toEqual({ outcome: "off" });
    expect(w.reads).not.toHaveBeenCalled();
  });

  it("with the switch on and no way to start a run, charges nothing and claims nothing", async () => {
    const w = world();
    const before = w.db.find(() => true).length;
    expect(await fireTestEnvNightly(w.deps, w.fire, undefined, ON)).toEqual({ outcome: "skipped", reason: "run_unavailable" });
    expect(w.reads).not.toHaveBeenCalled();
    expect(w.db.find(() => true)).toHaveLength(before);
  });

  it("with a way to start a run, decides from what is stored: charges the project, claims the slot, starts one run, and a repeat of the same fire starts nothing", async () => {
    const w = world();
    const r = runs();
    expect(await fireTestEnvNightly(w.deps, w.fire, r, ON)).toMatchObject({ outcome: "started" });
    expect(r.admitted).toEqual([{ orgId: ORG, project: PROJECT, purpose: "nightly_baseline" }]);
    expect(r.started).toHaveLength(1);
    expect(r.started[0]).toMatchObject({ project: PROJECT, branch: "main", envRevision: 1, payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" });
    expect(await fireTestEnvNightly(w.deps, w.fire, r, ON)).toMatchObject({ outcome: "skipped" });
    expect(r.started).toHaveLength(1);
  });

  it("a project whose approved environment has the nightly run off starts nothing", async () => {
    const w = world();
    const off = body({ enabled: false, cronUtc: "0 6 * * *", branch: "main" });
    w.db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001", entityType: "TEST_ENV_REVISION", orgId: ORG, project: PROJECT, revision: 1, approvedAt: "2026-11-02T10:00:00.000Z", digest: testEnvDigest(off), environment: off });
    const r = runs();
    expect(await fireTestEnvNightly(w.deps, w.fire, r, ON)).toEqual({ outcome: "skipped", reason: "nightly_off" });
    expect(r.started).toEqual([]);
    expect(r.admitted).toEqual([]);
  });
});
