// Setup and test health SH28: the joints. Each is undefined or a no-op with the `nh` switch off, so the callers' flow is today's flow.
import { describe, expect, it } from "vitest";
import { AUTO_FIX_CODES, projectMetaKey, type AutoFixCode, type OrgId } from "@agentx/contracts";
import { withTestingNotice } from "../../packages/broker/src/aws/developer-tasks/health-notice.js";
import { blockedByEnvironmentHook, blockedReasonsOf, healthPortsOf, recordNightlyResultWithHealth, setupProvedHook } from "../../packages/broker/src/test-env/health-wiring.js";
import { noteBlockedTask, readProjectHealth } from "../../packages/broker/src/test-env/health.js";
import { nightlyHooks } from "../../packages/broker/src/test-env/nightly-wiring.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "partner-service";
const T0 = Date.UTC(2026, 10, 5, 6, 0, 0);
const ON = { NIGHTLY_HEALTH_ENABLED: "1", TEST_ENVIRONMENT_ENABLED: "1" } as NodeJS.ProcessEnv;
const approved = (nightlyEnabled = false) => ({ revision: 2, environment: { nightly: { enabled: nightlyEnabled, cronUtc: "0 6 * * *", branch: "main" } } }) as never;

function harness() {
  const db = new FakeDynamoDb();
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const deps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capturingAuditDeps({ db }).audit };
  return { db, deps };
}
const stateOf = async (h: ReturnType<typeof harness>) => (await readProjectHealth(h.deps, ORG, PROJECT))?.state;
const task = (taskId: string, withOrg = true) => ({ taskId, orgId: withOrg ? ORG : undefined, project: PROJECT });

describe("which auto-fix codes make a task 'Blocked by environment'", () => {
  it("maps environment codes to their reasons, once each", () => {
    expect(blockedReasonsOf(["host-blocked", "login-failed", "host-blocked"])).toEqual(["host_blocked", "login_failed"]);
    expect(blockedReasonsOf(["setup-failed-in-task", "build-host-offline"])).toEqual(["setup_failed_in_task", "build_host_offline"]);
  });

  it("is empty when any code is the change's fault, a test that fails on the original code, or not yet decided: code wins, as in the result classifier", () => {
    expect(blockedReasonsOf(["host-blocked", "check-failed"])).toEqual([]);
    expect(blockedReasonsOf(["host-blocked", "regression-found"])).toEqual([]);
    expect(blockedReasonsOf(["host-blocked", "fails-on-original-code"])).toEqual([]);
    expect(blockedReasonsOf(["login-failed", "check-failed-cause-unknown"])).toEqual([]);
  });

  it("ignores codes that are about reviews, the owner or the pull request, and answers for every code without throwing", () => {
    expect(blockedReasonsOf(["review-findings", "cancelled-by-owner", "pull-request-open"])).toEqual([]);
    expect(blockedReasonsOf(["host-blocked", "review-not-run"])).toEqual(["host_blocked"]);
    for (const code of AUTO_FIX_CODES as readonly AutoFixCode[]) expect(() => blockedReasonsOf([code]), code).not.toThrow();
  });
});

describe("the auto-fix hook", () => {
  it("is undefined while nh (or the test environment) is off", () => {
    const h = harness();
    expect(blockedByEnvironmentHook(h.deps, {})).toBeUndefined();
    expect(blockedByEnvironmentHook(h.deps, { NIGHTLY_HEALTH_ENABLED: "1" })).toBeUndefined();
    expect(blockedByEnvironmentHook(h.deps, { TEST_ENVIRONMENT_ENABLED: "1" })).toBeUndefined();
    expect(blockedByEnvironmentHook(h.deps, ON)).toBeTypeOf("function");
  });

  it("counts a task once per environment cause, and the third task sets 'Setup needs repair'", async () => {
    const h = harness();
    const hook = blockedByEnvironmentHook(h.deps, ON)!;
    await hook(task("task_1"), ["host-blocked"]);
    await hook(task("task_1"), ["host-blocked"]);
    await hook(task("task_2"), ["host-blocked", "login-failed"]);
    expect(await stateOf(h)).toBe("unknown");
    await hook(task("task_3"), ["host-blocked"]);
    expect(await stateOf(h)).toBe("needs_repair");
  });

  it("records nothing for a task whose fault is the code's, for a task with no company, and for faults that are not the setup's", async () => {
    const h = harness();
    const hook = blockedByEnvironmentHook(h.deps, ON)!;
    for (const id of ["task_1", "task_2", "task_3"]) {
      await hook(task(id), ["host-blocked", "check-failed"]);
      await hook(task(id, false), ["host-blocked"]);
      await hook(task(id), ["runner-busy"]);
    }
    expect(await readProjectHealth(h.deps, ORG, PROJECT)).toBeUndefined();
  });
});

describe("an approved revision ends a repair state", () => {
  async function inRepair(h: ReturnType<typeof harness>) {
    const ports = healthPortsOf(h.deps);
    for (const id of ["task_1", "task_2", "task_3"]) await noteBlockedTask(h.deps, ports, { orgId: ORG, project: PROJECT, taskId: id, reason: "host_blocked" });
    expect(await stateOf(h)).toBe("needs_repair");
  }

  it("with nh on, the approval hook makes the project healthy again", async () => {
    const h = harness();
    await inRepair(h);
    await nightlyHooks({ health: h.deps }, ON).onApproved!(ORG, PROJECT, approved());
    expect(await stateOf(h)).toBe("healthy");
  });

  it("M1: a replay of an approval that already stood leaves 'Setup needs repair' as it is; the same approval, not replayed, ends it", async () => {
    const h = harness();
    await inRepair(h);
    await nightlyHooks({ health: h.deps }, ON).onApproved!(ORG, PROJECT, approved(), { replayed: true });
    expect(await stateOf(h)).toBe("needs_repair");
    await nightlyHooks({ health: h.deps }, ON).onApproved!(ORG, PROJECT, approved(), { replayed: false });
    expect(await stateOf(h)).toBe("healthy");
  });

  it("with nh off the approval changes nothing about health, and the hook is undefined", async () => {
    const h = harness();
    await inRepair(h);
    await nightlyHooks({ health: h.deps }, { TEST_ENVIRONMENT_ENABLED: "1" }).onApproved!(ORG, PROJECT, approved());
    expect(await stateOf(h)).toBe("needs_repair");
    expect(setupProvedHook(h.deps, {})).toBeUndefined();
  });

  it("with the test environment off nothing at all happens", async () => {
    const h = harness();
    await inRepair(h);
    await nightlyHooks({ health: h.deps }, { NIGHTLY_HEALTH_ENABLED: "1" }).onApproved!(ORG, PROJECT, approved());
    expect(await stateOf(h)).toBe("needs_repair");
  });

  it("a scheduler that fails does not keep health from following, nor the other way round; the first failure is thrown", async () => {
    const h = harness();
    await inRepair(h);
    const failing = { client: { send: () => Promise.reject(Object.assign(new Error("scheduler down"), { name: "InternalFailure" })) }, settings: { groupName: "g", roleArn: "arn:aws:iam::123456789012:role/r", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:f", queueArn: "arn:aws:sqs:us-east-1:123456789012:q" } };
    await expect(nightlyHooks({ health: h.deps, scheduling: failing }, ON).onApproved!(ORG, PROJECT, approved(true))).rejects.toThrow(/scheduler down/);
    expect(await stateOf(h)).toBe("healthy");
    // Without a health store the hook is exactly the schedule's: the same failure is thrown.
    await expect(nightlyHooks({ scheduling: failing }, ON).onApproved!(ORG, PROJECT, approved(true))).rejects.toThrow(/scheduler down/);
  });
});

describe("recording a nightly with the health listener", () => {
  it("with nh off it is recordNightlyResult and nothing else (a stale slot is refused the same way)", async () => {
    const h = harness();
    await expect(recordNightlyResultWithHealth(h.deps, {} as never, { orgId: ORG, project: PROJECT, result: {} }, {})).rejects.toThrow(/could not be read/);
    await expect(recordNightlyResultWithHealth(h.deps, {} as never, { orgId: ORG, project: PROJECT, result: {} }, ON)).rejects.toThrow(/could not be read/);
  });
});

describe("callers retry a health update that failed (F2)", () => {
  const flaky = (h: ReturnType<typeof harness>, failures: number) => {
    let left = failures;
    return { ...h.deps, documentClient: { send: (command: unknown) => (left-- > 0 ? Promise.reject(Object.assign(new Error("throttled"), { name: "ThrottlingException" })) : h.db.send(command as never)) } };
  };

  it("the auto-fix hook tries again before giving up, and counts the task once", async () => {
    const h = harness();
    const hook = blockedByEnvironmentHook(flaky(h, 2), ON)!;
    await hook(task("task_1"), ["host-blocked"]);
    expect((await readProjectHealth(h.deps, ORG, PROJECT))?.blocked).toHaveLength(1);
    const giving = harness();
    await expect(blockedByEnvironmentHook(flaky(giving, 3), ON)!(task("task_1"), ["host-blocked"])).rejects.toThrow(/throttled/);
  });

  it("the approval hook tries again too", async () => {
    const h = harness();
    const ports = healthPortsOf(h.deps);
    for (const id of ["task_1", "task_2", "task_3"]) await noteBlockedTask(h.deps, ports, { orgId: ORG, project: PROJECT, taskId: id, reason: "host_blocked" });
    await setupProvedHook(flaky(h, 1), ON)!(ORG, PROJECT);
    expect(await stateOf(h)).toBe("healthy");
  });
});

describe("the task notice never delays a start (F7)", () => {
  const view = { taskId: "t" } as never;
  it("shows no banner and returns at the deadline when the health read hangs", async () => {
    const hung = { documentClient: { send: () => new Promise<never>(() => undefined) }, tableName: "state", now: () => T0 };
    const started = Date.now();
    const answer = await withTestingNotice(hung, { orgId: ORG, project: PROJECT }, view, ON, 25);
    expect(answer).toBe(view);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("is the view itself when the switch is off, and when the read fails", async () => {
    const h = harness();
    expect(await withTestingNotice(h.deps, { orgId: ORG, project: PROJECT }, view, {})).toBe(view);
    const broken = { documentClient: { send: () => Promise.reject(new Error("down")) }, tableName: "state", now: () => T0 };
    expect(await withTestingNotice(broken, { orgId: ORG, project: PROJECT }, view, ON)).toBe(view);
  });

  it("adds the notice only when the project needs repair, within the deadline", async () => {
    const h = harness();
    const ports = healthPortsOf(h.deps);
    for (const id of ["task_1", "task_2", "task_3"]) await noteBlockedTask(h.deps, ports, { orgId: ORG, project: PROJECT, taskId: id, reason: "host_blocked" });
    expect(await withTestingNotice(h.deps, { orgId: ORG, project: PROJECT }, view, ON)).toMatchObject({ testingNotice: { state: "needs_repair" } });
  });
});
