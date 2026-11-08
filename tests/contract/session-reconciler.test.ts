import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import {
  createReconcilerHandler,
  type ExecutionStatus,
  type InstanceView,
  type ReconcilerDependencies,
  type VolumeView,
  MAX_INSTANCE_LOOKUPS_PER_RUN,
} from "../../packages/broker/src/aws/session-reconciler.js";
import { STUCK_CANCEL_LOST_MESSAGE, sweepStuckCancels, type StuckCancelDependencies } from "../../packages/broker/src/aws/stuck-cancels.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};
const hex = () => randomUUID().replaceAll("-", "").slice(0, 17);

type Start = (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;

type SetupOptions = { instances?: InstanceView[]; volumes?: VolumeView[]; executions?: Record<string, ExecutionStatus>; ping?: ReconcilerDependencies["ping"]; sweepStuckSetups?: ReconcilerDependencies["sweepStuckSetups"]; sweepStuckCancels?: ReconcilerDependencies["sweepStuckCancels"]; expireIndexDays?: ReconcilerDependencies["expireIndexDays"]; expireLearningItems?: ReconcilerDependencies["expireLearningItems"]; sweepUnwaitedTasks?: ReconcilerDependencies["sweepUnwaitedTasks"]; qualifiedWorkerAmi?: ReconcilerDependencies["qualifiedWorkerAmi"]; describeInstance?: ReconcilerDependencies["describeInstance"]; log?: ReconcilerDependencies["log"] };

function setup(options: SetupOptions = {}) {
  const db = new FakeDynamoDb();
  const start = vi.fn<Start>(async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
  const sessions = new SessionManager({
    documentClient: db, tableName: "state",
    executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    now: () => NOW,
  });
  const state = { instances: options.instances ?? [], volumes: options.volumes ?? [], executions: options.executions ?? {} };
  const terminate = vi.fn<(instanceId: string) => Promise<void>>(async () => undefined);
  const deleteVolume = vi.fn<(volumeId: string) => Promise<void>>(async () => undefined);
  const quarantine = vi.fn<(volumeId: string) => Promise<void>>(async () => undefined);
  const emit = vi.fn<(metrics: Record<string, number>) => void>();
  const reconcile = createReconcilerHandler({
    sessions,
    instances: async () => state.instances,
    volumes: async () => state.volumes,
    executionStatus: async (arn) => state.executions[arn],
    ping: options.ping ?? (async () => "Healthy"),
    terminate, deleteVolume, quarantine,
    failActiveOperation: (workspaceId, error) => failActiveOperation(db, "state", workspaceId, error),
    closedAt: async (workspaceId) => {
      const item = db.get(`WORKSPACE#${workspaceId}`, "META");
      return item?.status === "CLOSED" ? item.closedAt as string : undefined;
    },
    binding: async () => binding,
    // Default: EC2 says the instance a listing did not show does not exist.
    describeInstance: options.describeInstance ?? (async () => undefined),
    emit,
    now: () => NOW,
    log: options.log ?? (() => undefined),
    ...(options.sweepStuckSetups === undefined ? {} : { sweepStuckSetups: options.sweepStuckSetups }),
    ...(options.sweepStuckCancels === undefined ? {} : { sweepStuckCancels: options.sweepStuckCancels }),
    ...(options.expireIndexDays === undefined ? {} : { expireIndexDays: options.expireIndexDays }),
    ...(options.expireLearningItems === undefined ? {} : { expireLearningItems: options.expireLearningItems }),
    ...(options.sweepUnwaitedTasks === undefined ? {} : { sweepUnwaitedTasks: options.sweepUnwaitedTasks }),
    ...(options.qualifiedWorkerAmi === undefined ? {} : { qualifiedWorkerAmi: options.qualifiedWorkerAmi }),
  });
  return { db, sessions, state, start, terminate, deleteVolume, quarantine, emit, reconcile };
}

/** A SESSION item with the given state and fields, and its workspace. */
function seedSession(db: FakeDynamoDb, state: string, fields: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "READY", deploymentMode: "ec2-ebs", fence: 1, ...workspace });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state, sessionState: state, generation: 1, availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa", ...fields });
  return workspaceId;
}

const ready = () => ({
  volumeId: `vol-${hex()}`, instanceId: `i-${hex()}`, privateIp: "10.42.128.10",
  launchedAt: minutesAgo(60), readyAt: minutesAgo(58), lastActivityAt: minutesAgo(1),
});
const sessionOf = (db: FakeDynamoDb, workspaceId: string) => db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;

describe("reconciler: instances", () => {
  it("terminates instances no session owns, after a grace period, and leaves owned ones alone", async () => {
    const owned = ready();
    const { db, state, reconcile, terminate } = setup();
    const readyWorkspace = seedSession(db, "READY", owned);
    const stoppedWorkspace = seedSession(db, "STOPPED", { volumeId: `vol-${hex()}` });
    state.instances = [
      { instanceId: owned.instanceId, state: "running", workspaceId: readyWorkspace, launchedAt: minutesAgo(60) },
      { instanceId: "i-0000000000000000a", state: "running", workspaceId: stoppedWorkspace, launchedAt: minutesAgo(30) },
      { instanceId: "i-0000000000000000b", state: "running", workspaceId: randomUUID(), launchedAt: minutesAgo(20) },
      { instanceId: "i-0000000000000000c", state: "running", launchedAt: minutesAgo(20) },
      { instanceId: "i-0000000000000000d", state: "pending", workspaceId: randomUUID(), launchedAt: minutesAgo(5) },
    ];
    const report = await reconcile();
    expect(report.orphanInstances.sort()).toEqual(["i-0000000000000000a", "i-0000000000000000b", "i-0000000000000000c"]);
    expect(terminate).not.toHaveBeenCalledWith(owned.instanceId);
    expect(terminate).not.toHaveBeenCalledWith("i-0000000000000000d");
  });

  it("marks a READY session whose instance is gone STOPPED and fails the operation it was running", async () => {
    const lost = ready();
    const operationId = randomUUID();
    const { db, state, reconcile } = setup();
    const workspaceId = seedSession(db, "READY", lost, { status: "BUSY", activeOperationId: operationId });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "RUNNING", fence: 1 });
    state.instances = [];

    const report = await reconcile();
    expect(report.lostInstances).toEqual([lost.instanceId]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPED", sessionState: "STOPPED", volumeId: lost.volumeId });
    expect(sessionOf(db, workspaceId)).not.toHaveProperty("instanceId");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
  });

  it("terminates a READY session's stopped instance and treats it as lost", async () => {
    const lost = ready();
    const { db, state, reconcile, terminate } = setup();
    const workspaceId = seedSession(db, "READY", lost);
    state.instances = [{ instanceId: lost.instanceId, state: "stopped", workspaceId, launchedAt: minutesAgo(60) }];
    expect((await reconcile()).lostInstances).toEqual([lost.instanceId]);
    expect(terminate).toHaveBeenCalledWith(lost.instanceId);
  });

  it("replaces a worker after three consecutive failed probes, and forgets failures after a good one", async () => {
    const worker = ready();
    let healthy = false;
    const { db, state, reconcile, terminate } = setup({ ping: async () => { if (!healthy) throw new Error("timeout"); return "Healthy"; } });
    const workspaceId = seedSession(db, "READY", worker);
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];

    await reconcile();
    await reconcile();
    expect(sessionOf(db, workspaceId)).toMatchObject({ pingFailures: 2 });
    healthy = true;
    await reconcile();
    expect(sessionOf(db, workspaceId)).not.toHaveProperty("pingFailures");

    healthy = false;
    await reconcile();
    await reconcile();
    const third = await reconcile();
    expect(third.unresponsiveInstances).toEqual([worker.instanceId]);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(worker.instanceId);
  });
});

describe("reconciler: workers on another AMI than the qualified one (AUTOREQUALIFY AR-4)", () => {
  const PINNED = "ami-0aaaaaaaaaaaaaaaa";
  const STALE = "ami-0bbbbbbbbbbbbbbbb";

  /** One READY worker running `imageId`, its session seeded as the provisioner leaves it. */
  function readyWorker(options: SetupOptions, imageId: string | undefined, workspace: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
    const harness = setup(options);
    // Idle for 10 minutes unless a test says otherwise: past the recycle threshold.
    const worker = { ...ready(), lastActivityAt: minutesAgo(10) };
    const workspaceId = seedSession(harness.db, "READY", { ...worker, ...fields }, workspace);
    harness.state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60), ...(imageId === undefined ? {} : { imageId }) }];
    return { ...harness, worker, workspaceId };
  }

  it("stops an idle worker on another AMI so the next dispatch provisions the pinned one, and counts it", async () => {
    const { db, reconcile, emit, workspaceId, terminate } = readyWorker({ qualifiedWorkerAmi: async () => PINNED }, STALE);
    const report = await reconcile();
    expect(report.recycledStaleAmi).toEqual([workspaceId]);
    // The same READY -> STOPPING claim the idle reaper makes; the reaper terminates and finishes it.
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPING", sessionState: "STOPPING" });
    expect(terminate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerRecycledStaleAmi: 1 }));
  });

  it("recycles per worker: only the one on another AMI", async () => {
    const harness = setup({ qualifiedWorkerAmi: async () => PINNED });
    const stale = { ...ready(), lastActivityAt: minutesAgo(10) };
    const current = { ...ready(), lastActivityAt: minutesAgo(10) };
    const staleWorkspace = seedSession(harness.db, "READY", stale);
    const currentWorkspace = seedSession(harness.db, "READY", { ...current, privateIp: "10.42.128.11" });
    harness.state.instances = [
      { instanceId: stale.instanceId, state: "running", workspaceId: staleWorkspace, launchedAt: minutesAgo(60), imageId: STALE },
      { instanceId: current.instanceId, state: "running", workspaceId: currentWorkspace, launchedAt: minutesAgo(60), imageId: PINNED },
    ];
    expect((await harness.reconcile()).recycledStaleAmi).toEqual([staleWorkspace]);
    expect(sessionOf(harness.db, staleWorkspace)).toMatchObject({ state: "STOPPING" });
    expect(sessionOf(harness.db, currentWorkspace)).toMatchObject({ state: "READY" });
  });

  const cases: Array<[string, string | undefined, () => Promise<string | undefined>]> = [
    ["is on the pinned AMI", PINNED, async () => PINNED],
    ["has no pin yet (before the first automatic requalification)", STALE, async () => undefined],
    ["reports no AMI", undefined, async () => PINNED],
  ];
  it.each(cases)("leaves a worker alone when it %s", async (_case, imageId, qualifiedWorkerAmi) => {
    const { db, reconcile, workspaceId } = readyWorker({ qualifiedWorkerAmi }, imageId);
    const report = await reconcile();
    expect(report.recycledStaleAmi).toEqual([]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
  });

  it("waits until the worker has been idle for 5 minutes, like the reaper, so a warm worker is not cold-started mid-session", async () => {
    const recent = readyWorker({ qualifiedWorkerAmi: async () => PINNED }, STALE, {}, { lastActivityAt: minutesAgo(4) });
    expect((await recent.reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(recent.db, recent.workspaceId)).toMatchObject({ state: "READY" });

    const settled = readyWorker({ qualifiedWorkerAmi: async () => PINNED }, STALE, {}, { lastActivityAt: minutesAgo(6) });
    expect((await settled.reconcile()).recycledStaleAmi).toEqual([settled.workspaceId]);
  });

  it("rolls a renewal gradually: at most 2 idle workers per run, the rest on the next runs", async () => {
    const harness = setup({ qualifiedWorkerAmi: async () => PINNED });
    const workspaces: string[] = [];
    harness.state.instances = [];
    for (let index = 0; index < 5; index += 1) {
      const worker = { ...ready(), lastActivityAt: minutesAgo(10), privateIp: `10.42.128.${10 + index}` };
      const workspaceId = seedSession(harness.db, "READY", worker);
      workspaces.push(workspaceId);
      harness.state.instances.push({ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60), imageId: STALE });
    }
    const stoppingNow = () => workspaces.filter((id) => sessionOf(harness.db, id).state === "STOPPING");
    const first = await harness.reconcile();
    expect(first.recycledStaleAmi).toHaveLength(2);
    expect(stoppingNow()).toHaveLength(2);
    expect(harness.emit).toHaveBeenLastCalledWith(expect.objectContaining({ ReconcilerRecycledStaleAmi: 2 }));
    // The two stopped workers' instances leave (as after the reaper's terminate); the rest wait their turn.
    harness.state.instances = harness.state.instances.filter((instance) => !stoppingNow().includes(instance.workspaceId!));
    expect((await harness.reconcile()).recycledStaleAmi).toHaveLength(2);
    expect(workspaces.filter((id) => sessionOf(harness.db, id).state === "STOPPING")).toHaveLength(4);
  });

  it("never touches a worker that reports busy, however stale its AMI", async () => {
    const { db, reconcile, workspaceId } = readyWorker({ qualifiedWorkerAmi: async () => PINNED, ping: async () => "HealthyBusy" }, STALE);
    expect((await reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
  });

  it("never touches a worker that cannot be probed (the unresponsive path owns it)", async () => {
    const { db, reconcile, workspaceId } = readyWorker({ qualifiedWorkerAmi: async () => PINNED, ping: async () => { throw new Error("timeout"); } }, STALE);
    expect((await reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
  });

  it("never stops a worker whose workspace has an operation in progress, or work parked for it", async () => {
    const running = readyWorker({ qualifiedWorkerAmi: async () => PINNED }, STALE, { status: "BUSY", activeOperationId: randomUUID() });
    expect((await running.reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(running.db, running.workspaceId)).toMatchObject({ state: "READY" });

    const parked = readyWorker({ qualifiedWorkerAmi: async () => PINNED }, STALE, {}, { waitingOutboxIds: new Set([randomUUID()]) });
    expect((await parked.reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(parked.db, parked.workspaceId)).toMatchObject({ state: "READY" });
  });

  it("loses to a dispatch that touched the session after the reconciler read it", async () => {
    let touch = () => undefined as unknown;
    // The ping is where a dispatch can land between the session read and the claim.
    const harness = readyWorker({ qualifiedWorkerAmi: async () => PINNED, ping: async () => { touch(); return "Healthy"; } }, STALE);
    touch = () => harness.db.set({ ...sessionOf(harness.db, harness.workspaceId), lastActivityAt: NOW.toISOString() });
    expect((await harness.reconcile()).recycledStaleAmi).toEqual([]);
    expect(sessionOf(harness.db, harness.workspaceId)).toMatchObject({ state: "READY" });
  });

  it("when the pin cannot be read, recycles nothing, logs only the error name, and still repairs the rest", async () => {
    const log = vi.fn<(entry: Record<string, unknown>) => void>();
    const { db, reconcile, workspaceId, emit } = readyWorker({ qualifiedWorkerAmi: async () => { throw new Error("WORKER_AMI_PARAMETER_MALFORMED secret-looking-text"); }, log }, STALE);
    const lost = ready();
    const lostWorkspace = seedSession(db, "READY", lost);
    const report = await reconcile();
    expect(report.recycledStaleAmi).toEqual([]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
    // The ordinary lost-instance repair still ran.
    expect(report.lostInstances).toEqual([lost.instanceId]);
    expect(sessionOf(db, lostWorkspace)).toMatchObject({ state: "STOPPED" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "reconciler.qualified_ami_unreadable", errorName: "Error" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-looking-text");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerQualifiedAmiReadFailures: 1, ReconcilerRecycledStaleAmi: 0 }));
  });

  it("changes nothing where the pin is not wired (report and metrics as before)", async () => {
    const { db, reconcile, emit, workspaceId } = readyWorker({}, STALE);
    const report = await reconcile();
    expect(report).not.toHaveProperty("recycledStaleAmi");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
    expect(Object.keys(emit.mock.calls[0]![0])).not.toContain("ReconcilerRecycledStaleAmi");
  });
});

describe("reconciler: stuck transitions", () => {
  it("fails a provisioning whose execution ended, terminating its instance and failing parked work", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-x-gen-1";
    const { db, state, reconcile, terminate } = setup({ executions: { [executionArn]: "FAILED" } });
    const operationId = randomUUID();
    const outboxId = randomUUID();
    const workspaceId = seedSession(db, "PROVISIONING", { executionArn, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", waitingOutboxIds: new Set([outboxId]) }, { status: "PREPARING", activeOperationId: operationId });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "prepare", status: "DISPATCHING", fence: 1 });
    db.set({
      pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "WAITING_FOR_SESSION", operationId, workspaceId, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {} },
    });
    state.instances = [];

    expect((await reconcile()).stuckProvisioning).toEqual([workspaceId]);
    expect(terminate).toHaveBeenCalledWith("i-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "FAILED", volumeId: "vol-0123456789abcdef0" });
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
  });

  it("trusts a running provisioner, and restarts one whose start was never recorded", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-y-gen-1";
    const { db, reconcile, start } = setup({ executions: { [executionArn]: "RUNNING" } });
    const running = seedSession(db, "PROVISIONING", { executionArn });
    const unstarted = seedSession(db, "PROVISIONING");
    const report = await reconcile();
    expect(report.stuckProvisioning).toEqual([]);
    expect(sessionOf(db, running)).toMatchObject({ state: "PROVISIONING" });
    expect(report.restartedProvisioning).toEqual([unstarted]);
    expect(start.mock.calls[0]![0].name).toBe(`ws-${unstarted}-gen-1`);
  });

  it("finishes a deletion whose deleter stopped: terminate, then delete the volume and mark DELETED", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:deleter:ws-z-delete";
    const { db, state, reconcile, terminate, deleteVolume } = setup({ executions: { [executionArn]: "FAILED" } });
    const workspaceId = seedSession(db, "DELETING", { executionArn, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0" });
    state.instances = [{ instanceId: "i-0123456789abcdef0", state: "running", workspaceId, launchedAt: minutesAgo(90) }];
    state.volumes = [{ volumeId: "vol-0123456789abcdef0", state: "in-use", workspaceId, createdAt: minutesAgo(120), quarantined: false }];

    expect((await reconcile()).stuckDeleting).toEqual([workspaceId]);
    expect(terminate).toHaveBeenCalledWith("i-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "DELETING" });

    state.instances = [];
    state.volumes = [{ volumeId: "vol-0123456789abcdef0", state: "available", workspaceId, createdAt: minutesAgo(120), quarantined: false }];
    await reconcile();
    expect(deleteVolume).toHaveBeenCalledWith("vol-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "DELETED" });
  });

  it("re-sends work still parked on a READY session", async () => {
    const worker = ready();
    const outboxId = randomUUID();
    const { db, state, reconcile } = setup();
    const workspaceId = seedSession(db, "READY", { ...worker, waitingOutboxIds: new Set([outboxId]) });
    db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "WAITING_FOR_SESSION", workspaceId });
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];
    expect((await reconcile()).requeued).toEqual([outboxId]);
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
  });
});

describe("reconciler: volumes", () => {
  it("deletes a closed workspace's volume after an hour, quarantines unclaimed ones, and never touches claimed or new ones", async () => {
    const { db, state, reconcile, deleteVolume, quarantine, emit } = setup();
    const stopped = seedSession(db, "STOPPED", { volumeId: "vol-000000000000000a1" });
    const closedLongAgo = seedSession(db, "DELETED", {}, { status: "CLOSED", closedAt: minutesAgo(120) });
    const closedRecently = seedSession(db, "DELETED", {}, { status: "CLOSED", closedAt: minutesAgo(30) });
    state.volumes = [
      { volumeId: "vol-000000000000000a1", state: "available", workspaceId: stopped, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a2", state: "available", workspaceId: closedLongAgo, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a3", state: "available", workspaceId: closedRecently, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a4", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a5", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(5), quarantined: false },
      { volumeId: "vol-000000000000000a6", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(600), quarantined: true },
    ];
    const report = await reconcile();
    expect(report.closedVolumesDeleted).toEqual(["vol-000000000000000a2"]);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith("vol-000000000000000a2");
    expect(quarantine).toHaveBeenCalledExactlyOnceWith("vol-000000000000000a4");
    expect(report.quarantinedVolumes.sort()).toEqual(["vol-000000000000000a4", "vol-000000000000000a6"]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerClosedVolumesDeleted: 1, ReconcilerQuarantinedVolumes: 2, ReconcilerOrphanInstances: 0 }));
  });
});

describe("failing an active operation", () => {
  it("restores a close preflight's previous status, and leaves a finished operation alone", async () => {
    const db = new FakeDynamoDb();
    const workspaceId = randomUUID();
    const closeId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "CLOSING", activeOperationId: closeId, fence: 3 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${closeId}`, kind: "close", status: "RUNNING", fence: 3, closePreviousStatus: "STOPPED" });
    expect(await failActiveOperation(db, "state", workspaceId, "lost")).toBe(closeId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "STOPPED" });

    const taskId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "BUSY", activeOperationId: taskId, fence: 4 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${taskId}`, kind: "task", status: "SUCCEEDED", fence: 4 });
    expect(await failActiveOperation(db, "state", workspaceId, "lost")).toBeUndefined();
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskId}`)).toMatchObject({ status: "SUCCEEDED" });
  });
});

describe("reconciler: stuck setups (spec 025 FR-055)", () => {
  it("runs the sweep last, reports what it failed and counts it", async () => {
    const failedWorkspace = randomUUID();
    const sweep = vi.fn(async () => ({ failed: [failedWorkspace], dropped: 0, kept: 0 }));
    const logs: Array<Record<string, unknown>> = [];
    const { reconcile, emit } = setup({ sweepStuckSetups: sweep, log: (entry) => { logs.push(entry); } });
    const report = await reconcile();
    expect(sweep).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(report.stuckSetups).toEqual([failedWorkspace]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetups: 1 }));
    // The sweep logs each failed setup itself (stuck_setup.failed); the reconciler does not repeat it.
    expect(logs.filter((entry) => JSON.stringify(entry).includes(failedWorkspace))).toEqual([]);
  });

  it("still emits the EC2 repair metrics when the sweep throws, counts the error, and fails the run (F17)", async () => {
    const orphan: InstanceView = { instanceId: `i-${hex()}`, state: "running", launchedAt: minutesAgo(30) };
    const logs: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("PLANTED-SWEEP-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const { reconcile, emit, terminate } = setup({ instances: [orphan], sweepStuckSetups: async () => { throw failure; }, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).rejects.toBe(failure);
    expect(terminate).toHaveBeenCalledWith(orphan.instanceId);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerOrphanInstances: 1, ReconcilerStuckSetups: 0, ReconcilerStuckSetupErrors: 1 }));
    expect(logs).toContainEqual({ event: "reconciler.stuck_setup_sweep_failed", errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-SWEEP-MESSAGE");
  });

  it("counts the setup checks the sweep could not close, for the StuckSetupChecks alarm (follow-up N4)", async () => {
    const { reconcile, emit } = setup({ sweepStuckSetups: async () => ({ failed: [], keptChecks: 3 }) });
    await reconcile();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetupChecksKept: 3 }));
  });

  it("emits no kept checks when the sweep reports none or none is wired", async () => {
    const { reconcile, emit } = setup({ sweepStuckSetups: async () => ({ failed: [] }) });
    await reconcile();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetupChecksKept: 0 }));
    const unwired = setup();
    await unwired.reconcile();
    expect(unwired.emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetupChecksKept: 0 }));
  });

  it("reports no stuck setups and no sweep errors when no sweep is wired", async () => {
    const { reconcile, emit } = setup();
    expect((await reconcile()).stuckSetups).toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetups: 0, ReconcilerStuckSetupErrors: 0 }));
  });

  it("still runs the index expiry when the sweep throws, and still rethrows the sweep's error (A6, F17)", async () => {
    const failure = Object.assign(new Error("PLANTED-SWEEP-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const expireIndexDays = vi.fn(async () => ({ deleted: 0 }));
    const { reconcile, emit } = setup({ sweepStuckSetups: async () => { throw failure; }, expireIndexDays });
    await expect(reconcile()).rejects.toBe(failure);
    expect(expireIndexDays).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerStuckSetupErrors: 1 }));
  });

  it("runs the learning sweep beside the index expiry, even when the index expiry fails, and a failed learning sweep is logged by name only and does not fail the run (v1.2 B1)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const expireIndexDays = vi.fn(async () => { throw Object.assign(new Error("PLANTED-EXPIRY-MESSAGE"), { name: "ThrottlingException" }); });
    const expireLearningItems = vi.fn(async () => { throw Object.assign(new Error("PLANTED-LEARNING-TEXT"), { name: "ProvisionedThroughputExceededException" }); });
    const { reconcile, emit } = setup({ expireIndexDays, expireLearningItems, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(expireLearningItems).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(logs).toContainEqual({ event: "reconciler.learning_expiry_failed", errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-LEARNING-TEXT");
    const baseline = setup();
    await baseline.reconcile();
    expect(Object.keys(emit.mock.calls[0]![0])).toEqual(Object.keys(baseline.emit.mock.calls[0]![0]));
  });

  it("runs the index expiry, and a failed expiry is logged and does not fail the run (A6)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const expireIndexDays = vi.fn(async () => { throw Object.assign(new Error("PLANTED-EXPIRY-MESSAGE"), { name: "ThrottlingException" }); });
    const { reconcile, emit } = setup({ expireIndexDays, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(expireIndexDays).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(logs).toContainEqual({ event: "reconciler.index_expiry_failed", errorName: "ThrottlingException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-EXPIRY-MESSAGE");
    // A6: the metrics are the same set as before; the expiry adds none.
    expect(Object.keys(emit.mock.calls[0]![0])).not.toContain("ReconcilerIndexExpiry");
    const baseline = setup();
    await baseline.reconcile();
    expect(Object.keys(emit.mock.calls[0]![0])).toEqual(Object.keys(baseline.emit.mock.calls[0]![0]));
  });
});

describe("reconciler: stuck cancels (issue 195)", () => {
  /** A workspace whose task has been CANCEL_REQUESTED for 31 minutes, on a session in `state`. */
  function seedStuckCancel(db: FakeDynamoDb, state: string, fields: Record<string, unknown> = {}) {
    const operationId = randomUUID();
    const workspaceId = seedSession(db, state, fields, { status: "BUSY", activeOperationId: operationId, fence: 2 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "CANCEL_REQUESTED", fence: 2, updatedAt: minutesAgo(31) });
    return { workspaceId, operationId, operation: () => db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)! };
  }

  it("hands the sweep every listed workspace with what is known of its compute", async () => {
    const sweep = vi.fn<NonNullable<ReconcilerDependencies["sweepStuckCancels"]>>(async () => ({ retried: [], ended: [], interrupted: [], unretried: [], failed: [] }));
    const { db, state, reconcile } = setup({ sweepStuckCancels: sweep });
    const alive = ready();
    const aliveWorkspace = seedSession(db, "READY", alive);
    const lost = ready();
    const lostWorkspace = seedSession(db, "READY", lost);
    const stopped = seedSession(db, "STOPPED", { volumeId: `vol-${hex()}` });
    const failed = seedSession(db, "FAILED");
    const provisioning = seedSession(db, "PROVISIONING", { executionArn: "arn:aws:states:us-east-1:111122223333:execution:provisioner:run" });
    const stopping = seedSession(db, "STOPPING", { volumeId: `vol-${hex()}`, instanceId: `i-${hex()}` });
    state.instances = [
      { instanceId: alive.instanceId, state: "running", workspaceId: aliveWorkspace, launchedAt: minutesAgo(60) },
      { instanceId: lost.instanceId, state: "stopped", workspaceId: lostWorkspace, launchedAt: minutesAgo(60) },
    ];
    state.executions = { "arn:aws:states:us-east-1:111122223333:execution:provisioner:run": "RUNNING" };
    await reconcile();
    expect(sweep).toHaveBeenCalledTimes(1);
    const [candidates, at] = sweep.mock.calls[0]!;
    expect(at).toEqual(NOW);
    expect([...candidates].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      // Issue 202: a live worker's own answer to this run's ping comes with it.
      { workspaceId: aliveWorkspace, compute: "alive", worker: "idle", pingedAt: NOW.getTime() },
      { workspaceId: lostWorkspace, compute: "gone" },
      { workspaceId: stopped, compute: "gone" },
      { workspaceId: failed, compute: "gone" },
      { workspaceId: provisioning, compute: "unknown" },
      { workspaceId: stopping, compute: "unknown" },
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)));
  });

  it("ends a stuck cancel on a stopped session, re-queues one on a live worker, and counts each", async () => {
    const retryCancel = vi.fn<NonNullable<StuckCancelDependencies["retryCancel"]>>(async () => ({ outcome: "REQUEUED", cancelOperationId: randomUUID() }));
    const table: { db?: FakeDynamoDb } = {};
    const { db, state, reconcile, emit } = setup({ sweepStuckCancels: (candidates, now) => sweepStuckCancels({ client: table.db!, tableName: "state", retryCancel }, candidates, now) });
    table.db = db;
    const stopped = seedStuckCancel(db, "STOPPED", { volumeId: `vol-${hex()}` });
    const worker = ready();
    const live = seedStuckCancel(db, "READY", worker);
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId: live.workspaceId, launchedAt: minutesAgo(60) }];
    const report = await reconcile();
    expect(report.stuckCancels).toEqual({ retried: [live.operationId], ended: [stopped.operationId], interrupted: [], unretried: [], failed: [] });
    expect(stopped.operation()).toMatchObject({ status: "FAILED", error: STUCK_CANCEL_LOST_MESSAGE });
    expect(db.get(`WORKSPACE#${stopped.workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(retryCancel).toHaveBeenCalledExactlyOnceWith(live.workspaceId, live.operationId);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ReconcilerStuckCancelRetries: 1, ReconcilerStuckCancelsEnded: 1, ReconcilerStuckCancelsInterrupted: 0, ReconcilerStuckCancelsUnretried: 0, ReconcilerStuckCancelFailures: 0,
    }));
  });

  it("issue 202: passes each READY worker's ping answer (idle or busy) to the sweep, and none for a failed ping", async () => {
    const sweep = vi.fn<NonNullable<ReconcilerDependencies["sweepStuckCancels"]>>(async () => ({ retried: [], ended: [], interrupted: [], unretried: [], failed: [] }));
    const answers: Record<string, string | Error> = { "10.0.0.1": "Healthy", "10.0.0.2": "HealthyBusy", "10.0.0.3": new Error("timeout"), "10.0.0.4": "Starting" };
    const { db, state, reconcile } = setup({ sweepStuckCancels: sweep, ping: async (url) => {
      const answer = answers[new URL(url).hostname]!;
      if (answer instanceof Error) throw answer;
      return answer;
    } });
    const workers = Object.keys(answers).map((privateIp) => {
      const worker = { ...ready(), privateIp };
      const workspaceId = seedSession(db, "READY", worker);
      state.instances.push({ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) });
      return workspaceId;
    });
    await reconcile();
    const candidates = new Map([...sweep.mock.calls[0]![0]].map((candidate) => [candidate.workspaceId, candidate]));
    expect(candidates.get(workers[0]!)).toEqual({ workspaceId: workers[0], compute: "alive", worker: "idle", pingedAt: NOW.getTime() });
    expect(candidates.get(workers[1]!)).toEqual({ workspaceId: workers[1], compute: "alive", worker: "busy", pingedAt: NOW.getTime() });
    expect(candidates.get(workers[2]!)).toEqual({ workspaceId: workers[2], compute: "alive" });
    expect(candidates.get(workers[3]!)).toEqual({ workspaceId: workers[3], compute: "alive" });
  });

  it("issue 202: frees the workspace an INTERRUPTED task holds after a failed cancel in the same run that finds its compute lost", async () => {
    const table: { db?: FakeDynamoDb } = {};
    const { db, state, reconcile, emit } = setup({ sweepStuckCancels: (candidates, now) => sweepStuckCancels({ client: table.db!, tableName: "state" }, candidates, now) });
    table.db = db;
    const operationId = randomUUID();
    const lost = ready();
    const workspaceId = seedSession(db, "READY", lost, { status: "BUSY", activeOperationId: operationId, fence: 2 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "INTERRUPTED", fence: 2, updatedAt: minutesAgo(1) });
    state.instances = [];
    const report = await reconcile();
    // The lost-compute path fails only live operations, so it leaves this one to the sweep.
    expect(report.lostInstances).toEqual([lost.instanceId]);
    expect(report.stuckCancels?.interrupted).toEqual([operationId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "compute-gone" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerStuckCancelsInterrupted: 1, ReconcilerStuckCancelFailures: 0 }));
  });

  it("issue 202: counts a failed cancel held by a busy worker past 30 minutes as a failure, so the StuckCancels alarm fires", async () => {
    const table: { db?: FakeDynamoDb } = {};
    const { db, state, reconcile, emit } = setup({ ping: async () => "HealthyBusy", sweepStuckCancels: (candidates, now) => sweepStuckCancels({ client: table.db!, tableName: "state" }, candidates, now) });
    table.db = db;
    const operationId = randomUUID();
    const worker = ready();
    const workspaceId = seedSession(db, "READY", worker, { status: "BUSY", activeOperationId: operationId, fence: 2 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "INTERRUPTED", fence: 2, updatedAt: minutesAgo(31) });
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];
    expect((await reconcile()).stuckCancels?.failed).toEqual([operationId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: operationId });
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerStuckCancelsInterrupted: 0, ReconcilerStuckCancelFailures: 1 }));
  });

  describe("P1 stop-close: a session is marked lost only on evidence the compute is gone", () => {
    /** A READY workspace whose INTERRUPTED task (a failed cancel) still holds it, the sweep wired to the real stuck-cancel code. */
    function held(options: { describeInstance: ReconcilerDependencies["describeInstance"]; ping?: ReconcilerDependencies["ping"] }) {
      const table: { db?: FakeDynamoDb } = {};
      const harness = setup({ describeInstance: options.describeInstance, ...(options.ping === undefined ? {} : { ping: options.ping }), sweepStuckCancels: (candidates, now) => sweepStuckCancels({ client: table.db!, tableName: "state" }, candidates, now) });
      table.db = harness.db;
      const operationId = randomUUID();
      const worker = ready();
      const workspaceId = seedSession(harness.db, "READY", worker, { status: "BUSY", activeOperationId: operationId, fence: 2 });
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "INTERRUPTED", fence: 2, updatedAt: minutesAgo(1) });
      harness.state.instances = []; // the listing shows nothing
      return { ...harness, worker, workspaceId, operationId, operation: () => harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)! };
    }

    it("a transient gap in the listing (the instance still runs when asked by ID) does not mark the session lost, fail its operation or free the hold", async () => {
      const probe = { state: "running" };
      const { db, reconcile, worker, workspaceId, operationId, operation, terminate } = held({ describeInstance: async (instanceId) => ({ instanceId, state: probe.state, workspaceId: "w", launchedAt: minutesAgo(60) }) });
      const report = await reconcile();
      expect(report.lostInstances).toEqual([]);
      expect(terminate).not.toHaveBeenCalled();
      expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY", instanceId: worker.instanceId });
      expect(operation()).toMatchObject({ status: "INTERRUPTED" });
      expect(operation()).not.toHaveProperty("workspaceReleasedAt");
      // The worker is judged as the running instance it is: its idle answer is the sweep's only evidence, and the 10-minute wait has not passed.
      expect(report.stuckCancels?.interrupted).toEqual([]);
      expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: operationId });
    });

    it("a lookup that cannot answer leaves the session READY and its compute unknown to the sweep, so no hold is freed", async () => {
      const logs: Array<Record<string, unknown>> = [];
      const sweep = vi.fn<NonNullable<ReconcilerDependencies["sweepStuckCancels"]>>(async () => ({ retried: [], ended: [], interrupted: [], unretried: [], failed: [] }));
      const { db, state, reconcile } = setup({ describeInstance: async () => { throw Object.assign(new Error("PLANTED-MESSAGE"), { name: "ThrottlingException" }); }, sweepStuckCancels: sweep, log: (entry) => { logs.push(entry); } });
      const worker = ready();
      const workspaceId = seedSession(db, "READY", worker);
      state.instances = [];
      const report = await reconcile();
      expect(report.lostInstances).toEqual([]);
      expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
      expect([...sweep.mock.calls[0]![0]]).toEqual([{ workspaceId, compute: "unknown" }]);
      expect(logs).toContainEqual({ event: "reconciler.instance_unconfirmed", workspaceId, instanceId: worker.instanceId, errorName: "ThrottlingException" });
      expect(JSON.stringify(logs)).not.toContain("PLANTED-MESSAGE");
    });

    it("EC2 saying the instance does not exist marks the session lost, and the sweep frees the hold as compute-gone", async () => {
      const { db, reconcile, workspaceId, operationId, operation, worker } = held({ describeInstance: async () => undefined });
      const report = await reconcile();
      expect(report.lostInstances).toEqual([worker.instanceId]);
      expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPED" });
      expect(operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "compute-gone" });
      expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
      expect(report.stuckCancels?.interrupted).toEqual([operationId]);
    });

    it("EC2 reporting the instance terminated (still kept for about an hour) marks the session lost without another terminate call", async () => {
      const { db, reconcile, workspaceId, worker, terminate } = held({ describeInstance: async (instanceId) => ({ instanceId, state: "terminated", launchedAt: minutesAgo(60) }) });
      expect((await reconcile()).lostInstances).toEqual([worker.instanceId]);
      expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPED" });
      expect(terminate).not.toHaveBeenCalled();
    });

    it("caps the lookups per run: sessions past the cap stay READY with compute unknown, are logged as skipped, and are looked up on the next run", async () => {
      const logs: Array<Record<string, unknown>> = [];
      const looked: string[] = [];
      const sweep = vi.fn<NonNullable<ReconcilerDependencies["sweepStuckCancels"]>>(async () => ({ retried: [], ended: [], interrupted: [], unretried: [], failed: [] }));
      const { db, reconcile } = setup({ describeInstance: async (instanceId) => { looked.push(instanceId); return { instanceId, state: "running", launchedAt: minutesAgo(60) }; }, sweepStuckCancels: sweep, log: (entry) => { logs.push(entry); } });
      const total = MAX_INSTANCE_LOOKUPS_PER_RUN + 3;
      const workspaces = Array.from({ length: total }, () => seedSession(db, "READY", ready()));
      const report = await reconcile();
      expect(looked).toHaveLength(MAX_INSTANCE_LOOKUPS_PER_RUN);
      expect(logs).toContainEqual({ event: "reconciler.instance_lookups_capped", skipped: 3, cap: MAX_INSTANCE_LOOKUPS_PER_RUN });
      expect(report.lostInstances).toEqual([]);
      for (const workspaceId of workspaces) expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
      const computes = [...sweep.mock.calls[0]![0]].map((candidate) => candidate.compute);
      expect(computes.filter((compute) => compute === "unknown")).toHaveLength(3);
      expect(computes.filter((compute) => compute === "alive")).toHaveLength(MAX_INSTANCE_LOOKUPS_PER_RUN);
      // Next run: the ones already judged are listed-by-lookup again (the listing is still empty), so the lookups go to the rest as well.
      looked.length = 0;
      await reconcile();
      expect(looked).toHaveLength(MAX_INSTANCE_LOOKUPS_PER_RUN);
    });

    it("a listed instance needs no lookup (a listed stopped one is terminated, then marked lost, as before)", async () => {
      const describeInstance = vi.fn<ReconcilerDependencies["describeInstance"]>(async () => undefined);
      const { db, state, reconcile, terminate } = setup({ describeInstance });
      const worker = ready();
      const workspaceId = seedSession(db, "READY", worker);
      state.instances = [{ instanceId: worker.instanceId, state: "stopped", workspaceId, launchedAt: minutesAgo(60) }];
      expect((await reconcile()).lostInstances).toEqual([worker.instanceId]);
      expect(terminate).toHaveBeenCalledWith(worker.instanceId);
      expect(describeInstance).not.toHaveBeenCalled();
    });

    it("the gap passes: on the next run, once the listing shows the instance again, nothing was lost in between", async () => {
      let found = true;
      const { db, state, reconcile, worker, workspaceId } = held({ describeInstance: async (instanceId) => found ? { instanceId, state: "running", launchedAt: minutesAgo(60) } : undefined });
      await reconcile();
      state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];
      found = false;
      expect((await reconcile()).lostInstances).toEqual([]);
      expect(sessionOf(db, workspaceId)).toMatchObject({ state: "READY" });
    });
  });

  it("logs and counts a sweep that throws, and the run goes on", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("PLANTED-CANCEL-MESSAGE"), { name: "ThrottlingException" });
    const orphan: InstanceView = { instanceId: `i-${hex()}`, state: "running", launchedAt: minutesAgo(30) };
    const { reconcile, emit, terminate } = setup({ instances: [orphan], sweepStuckCancels: async () => { throw failure; }, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(terminate).toHaveBeenCalledWith(orphan.instanceId);
    expect(logs).toContainEqual({ event: "reconciler.stuck_cancel_sweep_failed", errorName: "ThrottlingException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-CANCEL-MESSAGE");
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerOrphanInstances: 1, ReconcilerStuckCancelRetries: 0, ReconcilerStuckCancelFailures: 1 }));
  });
});

describe("reconciler: unwaited Slack tasks (#173)", () => {
  it("hands the sweep every live session's workspace, reports what it cancelled and counts it", async () => {
    const worker = ready();
    const sweep = vi.fn(async () => ({ cancelled: ["op-1"], failed: ["op-2"], readFailures: [], noteFailures: 1 }));
    const { db, reconcile, emit } = setup({
      sweepUnwaitedTasks: sweep,
      instances: [{ instanceId: worker.instanceId, state: "running", launchedAt: worker.launchedAt }],
    });
    const readyWorkspace = seedSession(db, "READY", worker);
    db.get(`WORKSPACE#${readyWorkspace}`, "SESSION")!.instanceId = worker.instanceId;
    const live = seedSession(db, "STOPPED", { volumeId: `vol-${hex()}` });
    const provisioning = seedSession(db, "PROVISIONING", { executionArn: "arn:aws:states:us-east-1:111122223333:execution:provisioner:x" });
    const deleted = seedSession(db, "DELETED");
    const report = await reconcile();
    expect(sweep).toHaveBeenCalledOnce();
    const [workspaceIds, at] = sweep.mock.calls[0]! as unknown as [Iterable<string>, Date];
    // READY, the state of a running task, is the main one; a DELETED session holds no worker.
    expect([...workspaceIds].sort()).toEqual([readyWorkspace, live, provisioning].sort());
    expect([...workspaceIds]).not.toContain(deleted);
    expect(at).toEqual(NOW);
    expect(report.unwaitedTasks).toEqual({ cancelled: ["op-1"], failed: ["op-2"], readFailures: [], noteFailures: 1 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerUnwaitedTasksCancelled: 1, ReconcilerUnwaitedTaskFailures: 1, ReconcilerUnwaitedTaskReadFailures: 0, ReconcilerUnwaitedTaskNoteFailures: 1 }));
  });

  it("logs a sweep that throws by its error name, counts it, and still finishes the run", async () => {
    const orphan: InstanceView = { instanceId: `i-${hex()}`, state: "running", launchedAt: minutesAgo(30) };
    const logs: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("PLANTED-UNWAITED-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const expireIndexDays = vi.fn(async () => ({ deleted: 0 }));
    const { reconcile, emit, terminate } = setup({ instances: [orphan], sweepUnwaitedTasks: async () => { throw failure; }, expireIndexDays, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(terminate).toHaveBeenCalledWith(orphan.instanceId);
    expect(expireIndexDays).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerOrphanInstances: 1, ReconcilerUnwaitedTasksCancelled: 0, ReconcilerUnwaitedTaskFailures: 0, ReconcilerUnwaitedTaskReadFailures: 1 }));
    expect(logs).toContainEqual({ event: "reconciler.unwaited_task_sweep_failed", errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-UNWAITED-MESSAGE");
  });

  it("adds no metric and no report field where the backstop is not wired (the legacy deployment)", async () => {
    const { reconcile, emit } = setup();
    const report = await reconcile();
    expect(report).not.toHaveProperty("unwaitedTasks");
    expect(Object.keys(emit.mock.calls[0]![0]).filter((name) => name.includes("Unwaited"))).toEqual([]);
  });
});
