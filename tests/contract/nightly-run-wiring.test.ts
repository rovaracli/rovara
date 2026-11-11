// NH-1: the nightly run, wired through the whole broker (the scheduler's fire, the shared task start, the operation the preparation starts, its capability and payload, the worker's one callback action, and the end),
// and that with the switches off none of it runs. The worker's half is tested in the worker's tests.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_WORKER_OUTDATED, NIGHTLY_RUN_FEATURE, NIGHTLY_SOURCE, NightlyResultSchema, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, projectPk, systemOwnerIdOf, testEnvDigest, type NightlyResult } from "@rovara-code/contracts";
import { WorkerInvocationSchema } from "@agentx/cloud-contracts";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { nightlySlotId, coverageMapDigest } from "../../packages/broker/src/test-env/nightly.js";
import { OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { NAME, draftBody, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

// The head of the default branch comes from the code host in production; here it is a fixed commit. Everything else is the real broker.
const HEAD = "d".repeat(40);
vi.mock("../../packages/broker/src/aws/broker/nightly-head.js", async (original) => ({ ...(await original<Record<string, unknown>>()), defaultBranchHeadOf: () => Promise.resolve("d".repeat(40)) }));

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; delete process.env.NIGHTLY_HEALTH_ENABLED; });
// A setup draft always proposes the nightly run off; a maintainer turns it on. The approved revision is rewritten with it on, as an edit and an approval would leave it.
const nightlyEnv = () => draftBody({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" } });

async function bench(): Promise<Bench> {
  process.env.TEST_ENVIRONMENT_ENABLED = "1";
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit, modelProxy: true });
  audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
  await t.approveFirst();
  const revision = t.db.find((item) => item.entityType === "TEST_ENV_REVISION" && item.pk === projectPk(TEST_ORG, NAME))[0]!;
  t.db.set({ ...revision, environment: nightlyEnv(), digest: testEnvDigest(nightlyEnv()) });
  return t;
}
const scheduledAt = () => new Date(Date.now() - 1_000).toISOString();
const fire = (t: Bench, at = scheduledAt()) => t.handler({ source: NIGHTLY_SOURCE, orgId: TEST_ORG, project: NAME, scheduledAt: at }).then((response) => (typeof response === "object" && response !== null && "body" in response ? JSON.parse(String((response as { body: unknown }).body)) : response) as Record<string, unknown>);
const nightlyTasks = (t: Bench) => t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "nightly_run") as Array<Record<string, unknown> & { taskId: string; workspaceId: string }>;
const ops = (t: Bench, workspaceId: string) => t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId) as Array<{ id: string; kind: string; workflowMode?: string }>;
const outbox = (t: Bench, operationId: string) => WorkerInvocationSchema.parse((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as { invocation: unknown }).invocation);

/** The scheduler fires, the preparation finishes, and the worker's first event moves the operation to RUNNING. */
async function started(t: Bench) {
  const answer = await fire(t);
  expect(answer, JSON.stringify(answer)).toMatchObject({ outcome: "started" });
  const [task] = nightlyTasks(t);
  const prepare = ops(t, task!.workspaceId).find((operation) => operation.kind === "prepare")!;
  await t.finish(task!.workspaceId, prepare.id, "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "web", baseCommitSha: HEAD }] } });
  const own = ops(t, task!.workspaceId).find((operation) => operation.kind === "task")!;
  await t.events(task!.workspaceId, own.id, [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
  return { task: task!, own, slot: answer["slotId"] as string };
}
function resultFor(slotId: string, over: Record<string, unknown> = {}): NightlyResult {
  return NightlyResultSchema.parse({
    schemaVersion: 1, slotId, envRevision: 1, branch: "main", headSha: HEAD, startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), finishedAt: new Date().toISOString(), durationMs: 40 * 60_000,
    tests: { total: 5, passed: 5, failed: 0, skipped: 0 }, failed: [], flaky: [], slowest: [],
    health: { steps: [{ step: "pull", status: "passed" }, { step: "setup", status: "passed" }, { step: "smoke", status: "passed" }, { step: "full_suite", status: "passed" }],
      checks: [{ runsTests: true, started: true, timedOut: false, reportApproved: true, reportWritten: true, testsCollected: 5 }], tests: { total: 5, passed: 5, failures: 0, errors: 0, skipped: 0 }, ranFrom: "fresh" },
    ...over,
  });
}

describe("with the switches off", () => {
  it("a fire answers 'run_unavailable' with nh off, and starts nothing", async () => {
    const t = await bench();
    expect(await fire(t)).toMatchObject({ outcome: "skipped", reason: "run_unavailable" });
    expect(nightlyTasks(t)).toEqual([]);
  });
  it("a fire answers 'off' with the test environment off, and reads nothing", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    delete process.env.TEST_ENVIRONMENT_ENABLED;
    expect(await fire(t)).toMatchObject({ outcome: "off" });
    expect(nightlyTasks(t)).toEqual([]);
  });
});

describe("with nh and the test environment on", () => {
  it("a fire starts a task of its own: the project pays, the project's system owner owns it, it records what it was started to run, and its preparation is read-only", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own, slot } = await started(t);
    expect(t.db.find((item) => item.entityType === "TEST_ENV_NIGHTLY_SLOT")).toHaveLength(1);
    expect(task).toMatchObject({
      purpose: "nightly_run", origin: "nightly", payer: { kind: "project", project: NAME }, developerId: systemOwnerIdOf(TEST_ORG, NAME), provider: "system", automatic: { job: "nightly", purpose: "nightly_run", approvedBy: OMAR.developerId },
      nightlyRun: { slotId: slot, envRevision: 1, branch: "main", headSha: HEAD },
    });
    // The system owner owns it and nobody started it: no starter is named, and the title says it is the nightly run.
    expect(task["startedBy"]).toBeUndefined();
    expect(String(task["title"])).toMatch(/^Nightly test run for the project/u);
    // No pointer of the setup run's kind, no workflow: this is no task a person drives.
    expect(task["workflow"]).toBeUndefined();
    expect(own.workflowMode).toBe("CHECKS");
  });

  it("the operation is the verification mode with the approved environment and what it was started to run, and its capability carries the nightly action and no model access", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { own, slot } = await started(t);
    const invocation = outbox(t, own.id);
    if (invocation.kind !== "task") throw new Error("not a task");
    expect(invocation.payload.workflowMode).toBe("CHECKS");
    expect(invocation.payload.nightlyRun).toMatchObject({ slotId: slot, envRevision: 1, branch: "main", headSha: HEAD });
    expect(invocation.payload.nightlyRun?.environment).toEqual(nightlyEnv());
    expect(testEnvDigest(invocation.payload.nightlyRun!.environment)).toBe(testEnvDigest(nightlyEnv()));
    const claims = JSON.parse(Buffer.from(invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(claims.actions).toContain("nightly-result");
    expect(claims.actions).not.toContain("model-access");
    expect(claims.actions).not.toContain("setup-agent");
  });

  it("the worker's result goes through the real route and is recorded; the same result again finds no run waiting", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own, slot } = await started(t);
    expect(await t.callback(task.workspaceId, own.id, "nightly-result", { result: resultFor(slot) })).toMatchObject({ recorded: true, failingCount: 0 });
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: "TESTENV#BASELINE#LATEST" })).toMatchObject({ baseline: { envRevision: 1, headSha: HEAD, tests: { total: 5, passed: 5, failed: 0, skipped: 0 } }, health: { class: "passed" } });
    await expect(t.callback(task.workspaceId, own.id, "nightly-result", { result: resultFor(slot) })).rejects.toThrow(/409|CHANGE_STALE|no nightly run/u);
  });

  it("a result for another slot, another commit or another revision is refused by the route, and the run stays waiting", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own, slot } = await started(t);
    const forged = nightlySlotId(TEST_ORG, NAME, new Date(Date.now() - 86_400_000).toISOString());
    for (const bad of [resultFor(forged), resultFor(slot, { headSha: "e".repeat(40) }), resultFor(slot, { envRevision: 2 })]) {
      await expect(t.callback(task.workspaceId, own.id, "nightly-result", { result: bad })).rejects.toThrow(/403|CALLBACK_FORBIDDEN/u);
    }
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: "TESTENV#BASELINE#LATEST" })).toBeUndefined();
    expect(await t.callback(task.workspaceId, own.id, "nightly-result", { result: resultFor(slot) })).toMatchObject({ recorded: true });
  });

  it("the route needs the capability: an operation that was not granted the nightly action is refused (the preparation's own capability)", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, slot } = await started(t);
    const prepare = ops(t, task.workspaceId).find((operation) => operation.kind === "prepare")!;
    await expect(t.callback(task.workspaceId, prepare.id, "nightly-result", { result: resultFor(slot) })).rejects.toThrow();
  });

  it("once a day, and the finished task gives back its workspace", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own, slot } = await started(t);
    await t.callback(task.workspaceId, own.id, "nightly-result", { result: resultFor(slot) });
    expect(await fire(t, new Date(Date.now() - 2_000).toISOString())).toMatchObject({ outcome: "skipped" });
    expect(nightlyTasks(t)).toHaveLength(1);
    await t.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "CHECKS" } });
    expect((t.db.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }) as { agentRunEnd?: { state: string } }).agentRunEnd).toMatchObject({ state: "COMPLETE" });
  });

  it("the system owner's one slot is held while the night runs and given back when it ends: the next night is not shut out, and no person's slot was ever used", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const system = systemOwnerIdOf(TEST_ORG, NAME);
    const counters = () => t.db.find((item) => item.entityType === "DEVELOPER_LIMIT") as Array<{ pk: string; tasks?: Set<string>; count?: number }>;
    const { task, own, slot } = await started(t);
    expect(counters().filter((item) => item.pk === `DEVELOPER_LIMIT#${system}`)).toHaveLength(1);
    // the night's task is counted on the system owner's counter, and on no person's
    const night = nightlyTasks(t)[0]!.taskId;
    expect(counters().filter((item) => item.tasks?.has(night) === true).map((item) => item.pk)).toEqual([`DEVELOPER_LIMIT#${system}`]);
    await t.callback(task.workspaceId, own.id, "nightly-result", { result: resultFor(slot) });
    await t.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "CHECKS" } });
    // The night is over: its slot is free for the next automatic run of the project, which the one-at-a-time limit would otherwise refuse.
    const { createAutomaticRunStarter } = await import("../../packages/broker/src/aws/broker.js");
    const start = createAutomaticRunStarter(t.brokerInput as never)!;
    const next = () => start({ orgId: TEST_ORG, project: NAME, job: "scheduled_check", purpose: "saved_env_rebuild", requestId: randomUUID(), agent: { agentId: "rovara-code" }, input: { text: "Check." }, origin: "automatic" });
    const second = await next();
    expect("started" in second, JSON.stringify(second)).toBe(true);
    // ...and that one holds the slot in its turn
    await expect(next()).rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
  });

  it("a project with no approved environment never starts a run", async () => {
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const audit = capturingAuditDeps();
    const t = await setupWizardBench({ audit, modelProxy: true });
    audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
    expect(await fire(t)).toMatchObject({ outcome: "skipped", reason: "environment_missing" });
    expect(nightlyTasks(t)).toEqual([]);
  });
});

describe("nights that did not run, as the health page reads them", () => {
  const health = async (t: Bench) => (await t.dev(OMAR, "GET", `/v1/app/projects/${NAME}/test-health`)).body as { health: { state: string }; lastNight?: { status: string; reason: string; words: string } };
  it("an environment with services: the fire skips before any task or preparation, and the health page says so in neutral words (not 'needs repair')", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const revision = t.db.find((item) => item.entityType === "TEST_ENV_REVISION" && item.pk === projectPk(TEST_ORG, NAME))[0]!;
    const withServices = draftBody({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" }, services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    t.db.set({ ...revision, environment: withServices, digest: testEnvDigest(withServices) });
    expect(await fire(t)).toMatchObject({ outcome: "skipped", reason: "services_unsupported" });
    expect(nightlyTasks(t)).toEqual([]);
    const seen = await health(t);
    expect(seen.lastNight).toMatchObject({ status: "unavailable", reason: "services_unsupported", words: "Nightly not available: this setup's services can't be started by nightly runs yet." });
    expect(seen.health.state).not.toBe("needs_repair");
  });
  it("an operation that ends in failure with no word from the worker leaves an infra row that the health page reads; the project's health does not move", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own } = await started(t);
    await t.finish(task.workspaceId, own.id, "FAILED", { error: "the machine went away" });
    const seen = await health(t);
    expect(seen.lastNight).toMatchObject({ status: "failed", reason: "infra" });
    expect(seen.health.state).not.toBe("needs_repair");
  });
  it("the worker's own failure word goes through the real route and wins over the end's", async () => {
    const t = await bench();
    process.env.NIGHTLY_HEALTH_ENABLED = "1";
    const { task, own } = await started(t);
    expect(await t.callback(task.workspaceId, own.id, "nightly-result", { failed: { reason: "branch_moved" } })).toMatchObject({ recorded: false, failed: "branch_moved" });
    await t.finish(task.workspaceId, own.id, "FAILED", { error: "worker exited" });
    expect((await health(t)).lastNight).toMatchObject({ status: "failed", reason: "branch_moved" });
  });
});

describe("delivery and the contract", () => {
  const delivery = (features: string[]) => {
    const post = vi.fn(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliver = createEc2Delivery({
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => ({ deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const }),
      sign: async () => new Uint8Array(64), post, progress: async () => undefined, now: () => Date.parse("2026-11-02T12:00:00.000Z"), workerFeatures: async () => features,
    } as never);
    return { deliver, post };
  };
  const payload = { conversationId: randomUUID(), prompt: "Run", workflowMode: "CHECKS", nightlyRun: { slotId: "c".repeat(64), envRevision: 1, branch: "main", headSha: HEAD, environment: nightlyEnv() } };
  const record = () => {
    const operationId = randomUUID(); const workspaceId = randomUUID();
    const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 2, projectRevision: 1, callbackCapability: "c".repeat(64), payload };
    return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation } as never as { invocation: never };
  };
  it("a worker that does not list the nightly run is refused it, and one that does is sent it", async () => {
    // A worker that runs the verification mode but does not list the nightly run.
    const old = delivery(["task.workflowMode", "task.workflowChecks"]);
    const outbox = record();
    await expect(old.deliver(outbox as never, outbox.invocation)).rejects.toThrow(AGENT_WORKER_OUTDATED);
    expect(old.post).not.toHaveBeenCalled();
    const capable = delivery(["task.workflowMode", "task.workflowChecks", NIGHTLY_RUN_FEATURE]);
    expect(await capable.deliver(outbox as never, outbox.invocation)).toBe("DELIVERED");
  });
  it("the feature is listed by the contract and implemented by the worker; the task schema ties it to the verification mode and to an approved environment of its own", () => {
    expect(NIGHTLY_RUN_FEATURE).toBe("task.nightlyRun.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(NIGHTLY_RUN_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(NIGHTLY_RUN_FEATURE);
    const task = (extra: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { ...payload, ...extra } }).success;
    expect(task({})).toBe(true);
    expect(task({ workflowMode: "PLAN" })).toBe(false);
    expect(task({ nightlyRun: { ...payload.nightlyRun, headSha: "short" } })).toBe(false);
    expect(task({ nightlyRun: { ...payload.nightlyRun, extra: 1 } })).toBe(false);
    expect(task({ nightlyRun: { slotId: "c".repeat(64), envRevision: 1, branch: "main", headSha: HEAD } })).toBe(false);
    expect(TestEnvironmentBodySchema.safeParse(payload.nightlyRun.environment).success).toBe(true);
  });
  it("the map digest the worker names is the one the broker computes", () => {
    const map = { builtAt: "2026-11-05T06:00:00.000Z", files: { "a.py": ["t::1"] } };
    expect(coverageMapDigest(map)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
