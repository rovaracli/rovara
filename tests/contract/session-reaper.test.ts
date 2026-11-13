import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "@rovara-code/contracts";
import { SessionManager, parkedOutboxIds } from "../../packages/broker/src/aws/sessions.js";
import { createReaperHandler, readRecycleMarks, type ReaperDependencies, type StopProgress } from "../../packages/broker/src/aws/session-reaper.js";
import { PRIVATE_ADDRESS_NOTHING_OPEN } from "@agentx/cloud-contracts";
import { COMPUTE_LOST_ERROR } from "../../packages/broker/src/aws/compute-lost.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
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

type Start = (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;

function setup(overrides: Partial<ReaperDependencies> = {}) {
  const db = new FakeDynamoDb();
  const start = vi.fn<Start>(async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
  const sessions = new SessionManager({
    documentClient: db,
    tableName: "state",
    executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    now: () => NOW,
  });
  let progress: StopProgress = { instanceGone: false, instanceLive: false, volumeAvailable: false };
  const terminate = vi.fn<(instanceId: string) => Promise<void>>(async () => undefined);
  const emit = vi.fn<(metrics: Record<string, number>) => void>();
  const reap = createReaperHandler({
    sessions,
    activeOperation: async (workspaceId) => typeof db.get(`WORKSPACE#${workspaceId}`, "META")?.activeOperationId === "string",
    ping: async () => "Healthy",
    terminate,
    progress: async () => progress,
    binding: async () => binding,
    emit,
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  });
  return { db, sessions, start, terminate, emit, reap, setProgress: (next: StopProgress) => { progress = next; } };
}

/** A READY session and its workspace, last active `idleMinutes` ago. */
function seedReady(db: FakeDynamoDb, options: { idleMinutes: number; launchedMinutesAgo?: number; activeOperationId?: string | null }) {
  const workspaceId = randomUUID();
  db.set({
    pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 1, status: "READY",
    ...(options.activeOperationId === undefined ? {} : { activeOperationId: options.activeOperationId }),
  });
  db.set({
    pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 1,
    volumeId: "vol-0123456789abcdef0", availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa",
    instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10",
    launchedAt: minutesAgo(options.launchedMinutesAgo ?? 30), readyAt: minutesAgo(options.launchedMinutesAgo ?? 30), lastActivityAt: minutesAgo(options.idleMinutes),
  });
  return workspaceId;
}

const sessionOf = (db: FakeDynamoDb, workspaceId: string) => db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;

describe("idle reaper", () => {
  it("stops a session idle over five minutes, then marks it STOPPED once the instance is gone and the volume free", async () => {
    const { db, reap, terminate, emit, setProgress } = setup();
    const idle = seedReady(db, { idleMinutes: 6 });
    const active = seedReady(db, { idleMinutes: 1 });

    const first = await reap();
    expect(first.claimed).toEqual([idle]);
    expect(terminate).toHaveBeenCalledExactlyOnceWith("i-0123456789abcdef0");
    expect(sessionOf(db, idle)).toMatchObject({ state: "STOPPING", sessionState: "STOPPING" });
    expect(sessionOf(db, active)).toMatchObject({ state: "READY" });
    expect(first.stillStopping).toEqual([idle]);
    expect(emit).toHaveBeenLastCalledWith({ SessionsStopped: 0, SessionsStopping: 1 });

    setProgress({ instanceGone: true, instanceLive: false, volumeAvailable: true });
    const second = await reap();
    expect(second.stopped).toEqual([idle]);
    expect(sessionOf(db, idle)).toMatchObject({ state: "STOPPED", sessionState: "STOPPED", volumeId: "vol-0123456789abcdef0" });
    expect(sessionOf(db, idle)).not.toHaveProperty("instanceId");
    expect(sessionOf(db, idle)).not.toHaveProperty("privateIp");
    expect(emit).toHaveBeenLastCalledWith({ SessionsStopped: 1, SessionsStopping: 0 });
    // The workspace's own status is never changed.
    expect(db.get(`WORKSPACE#${idle}`, "META")).toMatchObject({ status: "READY" });
  });

  it("stops a session launched over 14 days ago even when recently active", async () => {
    const { db, reap } = setup();
    const old = seedReady(db, { idleMinutes: 1, launchedMinutesAgo: 14 * 24 * 60 + 1 });
    expect((await reap()).claimed).toEqual([old]);
  });

  it("never reaps a workspace with an active operation or a worker reporting HealthyBusy", async () => {
    const busyWorkspace = setup();
    const withOperation = seedReady(busyWorkspace.db, { idleMinutes: 30, activeOperationId: randomUUID() });
    expect((await busyWorkspace.reap()).skippedBusy).toEqual([withOperation]);
    expect(sessionOf(busyWorkspace.db, withOperation)).toMatchObject({ state: "READY" });

    const busyWorker = setup({ ping: async () => "HealthyBusy" });
    const working = seedReady(busyWorker.db, { idleMinutes: 30 });
    expect((await busyWorker.reap()).skippedBusy).toEqual([working]);
    expect(busyWorker.terminate).not.toHaveBeenCalled();
  });

  it("treats a stored null activeOperationId as no operation", async () => {
    const { db, reap } = setup();
    const workspaceId = seedReady(db, { idleMinutes: 30, activeOperationId: null });
    expect((await reap()).claimed).toEqual([workspaceId]);
  });

  it("loses to a dispatch that touches the session between its read and its claim", async () => {
    const race = { workspaceId: "" };
    const { db, sessions, reap, terminate } = setup({
      // The dispatcher's ensureSession lands while the reaper probes the worker.
      ping: async () => {
        await sessions.ensureSession({ workspaceId: race.workspaceId, binding });
        return "Healthy";
      },
    });
    const raced = race.workspaceId = seedReady(db, { idleMinutes: 10 });
    const report = await reap();
    expect(report.lostRace).toEqual([raced]);
    expect(sessionOf(db, raced)).toMatchObject({ state: "READY", lastActivityAt: NOW.toISOString() });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("loses to a task that takes the workspace between its read and its claim", async () => {
    const race = { workspaceId: "" };
    const { db, reap, terminate } = setup({
      ping: async () => {
        db.get(`WORKSPACE#${race.workspaceId}`, "META")!.activeOperationId = randomUUID();
        return "Healthy";
      },
    });
    const raced = race.workspaceId = seedReady(db, { idleMinutes: 10 });
    expect((await reap()).lostRace).toEqual([raced]);
    expect(sessionOf(db, raced)).toMatchObject({ state: "READY" });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("starts the next generation at once when work was parked while stopping", async () => {
    const { db, sessions, reap, start, setProgress } = setup();
    const workspaceId = seedReady(db, { idleMinutes: 10 });
    await reap();
    const outboxId = randomUUID();
    db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "QUEUED", workspaceId, deploymentMode: "ec2-ebs", invocation: { kind: "prepare", payload: {} } });
    expect(await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId })).toMatchObject({ ready: false, state: "STOPPING" });

    setProgress({ instanceGone: true, instanceLive: false, volumeAvailable: true });
    const report = await reap();
    expect(report.stopped).toEqual([workspaceId]);
    expect(report.restarted).toEqual([workspaceId]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "PROVISIONING", generation: 2, volumeId: "vol-0123456789abcdef0" });
    // S2: parked as a marker beside the session (or in its old set).
    expect(await parkedOutboxIds(db as never, "state", workspaceId, sessionOf(db, workspaceId))).toEqual([outboxId]);
    expect(start.mock.calls[0]![0].name).toBe(`ws-${workspaceId}-gen-2`);
  });

  it("keeps a session STOPPING and sends the terminate again while its instance is still live", async () => {
    const { db, reap, terminate, setProgress } = setup();
    terminate.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "RequestLimitExceeded" }));
    const workspaceId = seedReady(db, { idleMinutes: 10 });
    await reap();
    setProgress({ instanceGone: false, instanceLive: true, volumeAvailable: false });
    const report = await reap();
    expect(report.stillStopping).toEqual([workspaceId]);
    // The claim's terminate failed; the next tick saw the instance live and sent it again.
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPING" });
  });
});

// Owner decision 128: a company that removed an internal address has its workers launched before the removal recycled at once, busy or not; other companies' and newer workers are left alone.
describe("recycling after an internal address removal", () => {
  const ORG_A = `org_${"a".repeat(20)}`, ORG_B = `org_${"b".repeat(20)}`;
  // `marks`: each company's latest removal, as the list revision it wrote. `reads`: the list revision each workspace's worker read when it launched (review L2); a workspace with none has no record.
  function withOrgs(marks: Map<string, number> | (() => Promise<Map<string, number>>), orgs: Map<string, string>, extra: Partial<ReaperDependencies> = {}, reads: Map<string, number> = new Map()) {
    const log = vi.fn<(entry: Record<string, unknown>) => void>();
    const launchRevision = vi.fn<(id: string, generation: number) => Promise<number | undefined>>(async (id) => reads.get(id));
    const holder: { db?: FakeDynamoDb } = {};
    const t = setup({
      privateAddressRecycle: { marks: typeof marks === "function" ? marks : async () => marks, workspaceOrg: async (id) => orgs.get(id), launchRevision, failActiveOperation: (workspaceId, error) => failActiveOperation(holder.db!, "state", workspaceId, error) },
      log, ...extra,
    });
    holder.db = t.db;
    return { ...t, log, reads, launchRevision };
  }

  it("stops an idle worker and terminates a busy one under its task, both launched before the removal; leaves the other company and a newer worker", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, {}, reads);
    const idle = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 30 });
    const busy = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 30, activeOperationId: "op-1" });
    t.db.set({ ...t.db.get(`WORKSPACE#${busy}`, "META"), fence: 4 });
    t.db.set({ pk: `WORKSPACE#${busy}`, sk: "OPERATION#op-1", kind: "inspect", status: "RUNNING", fence: 4 });
    const other = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 30 });
    const newer = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 1 });
    for (const id of [idle, busy, newer]) orgs.set(id, ORG_A);
    orgs.set(other, ORG_B);
    // The two older workers read the list at revision 4; the newer one at the removal's own revision.
    reads.set(idle, 4); reads.set(busy, 4); reads.set(newer, 5); reads.set(other, 1);
    const report = await t.reap();
    expect(new Set(report.privateAddressRecycled)).toEqual(new Set([idle, busy]));
    expect(report.claimed).toEqual([idle]);
    expect(t.terminate).toHaveBeenCalledTimes(2);
    expect((await t.sessions.get(idle))?.state).toBe("STOPPING");
    // The busy one is marked lost in the same tick, through the reconciler's own path, and its operation failed with the compute-lost error its retry knows.
    expect((await t.sessions.get(busy))?.state).toBe("STOPPED");
    expect(t.db.get(`WORKSPACE#${busy}`, "OPERATION#op-1")).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_ERROR });
    expect(t.db.get(`WORKSPACE#${busy}`, "META")?.activeOperationId).toBeUndefined();
    expect((await t.sessions.get(other))?.state).toBe("READY");
    expect((await t.sessions.get(newer))?.state).toBe("READY");
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "session.private_address_recycle_interrupted", workspaceId: busy, markedLost: true, failedOperationId: "op-1" }));
    expect(t.emit).toHaveBeenCalledWith(expect.objectContaining({ SessionsPrivateAddressRecycled: 2, SessionsPrivateAddressRecycleErrors: 0 }));
  });

  // Review L2: the revision the worker read decides, never the time it launched.
  it("recycles a worker that read the list before the removal even when it was launched long after it (a late launch)", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, {}, reads);
    // Launched 5 minutes ago, after a removal that happened (say) an hour ago: its launch still read the list at revision 4, so it still has the removed address open.
    const late = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 5 });
    orgs.set(late, ORG_A); reads.set(late, 4);
    expect((await t.reap()).privateAddressRecycled).toEqual([late]);
    expect((await t.sessions.get(late))?.state).toBe("STOPPING");
  });

  it("does not kill a worker that read the list after the removal, however close or far its launch time is to the removal", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, {}, reads);
    const justAfter = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 9, activeOperationId: "op-9" });
    const readLater = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 600 });
    const readMuchLater = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 3 });
    for (const id of [justAfter, readLater, readMuchLater]) orgs.set(id, ORG_A);
    reads.set(justAfter, 5); reads.set(readLater, 5); reads.set(readMuchLater, 9);
    const report = await t.reap();
    expect(report.privateAddressRecycled).toEqual([]);
    expect(t.terminate).not.toHaveBeenCalled();
    for (const id of [justAfter, readLater, readMuchLater]) expect((await t.sessions.get(id))?.state).toBe("READY");
    // The record asked for is the session's own generation (a record of another generation says nothing about this worker).
    expect(t.launchRevision.mock.calls.map(([id, generation]) => `${id}:${String(generation)}`).sort()).toEqual([justAfter, readLater, readMuchLater].map((id) => `${id}:1`).sort());
  });

  it("recycles a worker with no launch record, or whose record cannot be read (never assumed safe), and counts the unreadable one", async () => {
    const orgs = new Map<string, string>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, { privateAddressRecycle: { marks: async () => new Map([[ORG_A, 5]]), workspaceOrg: async (id) => orgs.get(id), launchRevision: async (id) => { if (id === unreadable) throw Object.assign(new Error("down"), { name: "ProvisionedThroughputExceededException" }); return undefined; }, failActiveOperation: async () => undefined } });
    const unrecorded = seedReady(t.db, { idleMinutes: 0 });
    const unreadable: string = seedReady(t.db, { idleMinutes: 0 });
    orgs.set(unrecorded, ORG_A); orgs.set(unreadable, ORG_A);
    const report = await t.reap();
    expect(new Set(report.privateAddressRecycled)).toEqual(new Set([unrecorded, unreadable]));
    expect(report.privateAddressRecycleErrors).toBe(1);
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "session.private_address_launch_unreadable", level: "error", workspaceId: unreadable, errorName: "ProvisionedThroughputExceededException" }));
    expect(t.emit).toHaveBeenCalledWith(expect.objectContaining({ SessionsPrivateAddressRecycleErrors: 1 }));
  });

  it("a mark with no readable revision recycles every worker of that company that has no proof", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "PRIVATEADDR#RECYCLE", sk: ORG_A, entityType: "PRIVATE_ADDRESS_RECYCLE", orgId: ORG_A, removedAt: 1 });
    db.set({ pk: "PRIVATEADDR#RECYCLE", sk: ORG_B, entityType: "PRIVATE_ADDRESS_RECYCLE", orgId: ORG_B, removedAt: 1, revision: 6 });
    db.set({ pk: "PRIVATEADDR#RECYCLE", sk: "org_cccccccccccccccccccc", entityType: "PRIVATE_ADDRESS_RECYCLE", orgId: "org_cccccccccccccccccccc", removedAt: 1, revision: "x" });
    db.set({ pk: "PRIVATEADDR#RECYCLE", sk: "junk", entityType: "PRIVATE_ADDRESS_RECYCLE", revision: 3 });
    const marks = await readRecycleMarks(db, "state");
    expect(marks.get(ORG_A)).toBe(Number.POSITIVE_INFINITY);
    expect(marks.get(ORG_B)).toBe(6);
    expect(marks.get("org_cccccccccccccccccccc")).toBe(Number.POSITIVE_INFINITY);
    expect(marks.size).toBe(3);
    // Nothing a worker read can reach Infinity, so those workers are recycled.
    const orgs = new Map<string, string>();
    const t = withOrgs(new Map([[ORG_A, Number.POSITIVE_INFINITY]]), orgs, {}, new Map());
    const worker = seedReady(t.db, { idleMinutes: 0 });
    orgs.set(worker, ORG_A); t.reads.set(worker, PRIVATE_ADDRESS_NOTHING_OPEN);
    expect((await t.reap()).privateAddressRecycled).toEqual([worker]);
  });

  it("a worker that opened nothing (recorded as nothing open) is never recycled by a removal", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, {}, reads);
    const bare = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 600 });
    orgs.set(bare, ORG_A); reads.set(bare, PRIVATE_ADDRESS_NOTHING_OPEN);
    expect((await t.reap()).privateAddressRecycled).toEqual([]);
  });

  it("recycles nothing, loudly and counted, when the marks cannot be read, and the idle reaping goes on", async () => {
    const t = withOrgs(async () => { throw Object.assign(new Error("down"), { name: "ProvisionedThroughputExceededException" }); }, new Map());
    const idle = seedReady(t.db, { idleMinutes: 30 });
    const report = await t.reap();
    expect(report.privateAddressRecycled).toEqual([]);
    expect(report.claimed).toEqual([idle]);
    expect(report.privateAddressRecycleErrors).toBe(1);
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "session.private_address_recycle_unreadable", level: "error" }));
    expect(t.emit).toHaveBeenCalledWith(expect.objectContaining({ SessionsPrivateAddressRecycleErrors: 1 }));
  });

  // Review L4: a company lookup that fails is no longer swallowed: a log line with the workspace and the error's name, a count that feeds the reaper error alarm, and the other workers are still checked.
  it("logs and counts a company lookup that fails, skips that worker for this tick, and still recycles the others", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, { privateAddressRecycle: { marks: async () => new Map([[ORG_A, 5]]), launchRevision: async (id) => reads.get(id), failActiveOperation: async () => undefined, workspaceOrg: async (id) => { if (id === broken) throw Object.assign(new Error("secret detail"), { name: "ProvisionedThroughputExceededException" }); return orgs.get(id); } } });
    const broken: string = seedReady(t.db, { idleMinutes: 0 });
    const fine = seedReady(t.db, { idleMinutes: 0 });
    orgs.set(fine, ORG_A); reads.set(fine, 4);
    const report = await t.reap();
    expect(report.privateAddressRecycled).toEqual([fine]);
    expect((await t.sessions.get(broken))?.state).toBe("READY");
    expect(report.privateAddressRecycleErrors).toBe(1);
    const entry = t.log.mock.calls.map(([e]) => e).find((e) => e.event === "session.private_address_company_unreadable");
    expect(entry).toEqual({ event: "session.private_address_company_unreadable", level: "error", workspaceId: broken, errorName: "ProvisionedThroughputExceededException" });
    expect(t.emit).toHaveBeenCalledWith(expect.objectContaining({ SessionsPrivateAddressRecycled: 1, SessionsPrivateAddressRecycleErrors: 1 }));
  });

  it("leaves a busy worker READY, to try again next tick, when its terminate fails (never marked lost while it may still run)", async () => {
    const orgs = new Map<string, string>(), reads = new Map<string, number>();
    const t = withOrgs(new Map([[ORG_A, 5]]), orgs, { terminate: async () => { throw Object.assign(new Error("throttled"), { name: "RequestLimitExceeded" }); } }, reads);
    const busy = seedReady(t.db, { idleMinutes: 0, launchedMinutesAgo: 30, activeOperationId: "op-1" });
    orgs.set(busy, ORG_A); reads.set(busy, 1);
    await t.reap();
    expect((await t.sessions.get(busy))?.state).toBe("READY");
  });

  it("reads no workspace when no company has a mark", async () => {
    const workspaceOrg = vi.fn(async () => ORG_A);
    const t = setup({ privateAddressRecycle: { marks: async () => new Map(), workspaceOrg, launchRevision: async () => undefined, failActiveOperation: async () => undefined } });
    seedReady(t.db, { idleMinutes: 0 });
    await t.reap();
    expect(workspaceOrg).not.toHaveBeenCalled();
  });
});
