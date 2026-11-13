import { describe, expect, it } from "vitest";
import { machineTimeOnceKey } from "@agentx/cloud-contracts";
import { recordMachineTime } from "../../packages/broker/src/org/trial.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { workspaceSessionKey, type OrgId } from "@rovara-code/contracts";
import { machineTimeMonthKey, openComputeKey } from "@agentx/cloud-contracts";
import { readTaskMachineMeter } from "../../packages/broker/src/agents/task-machine-meter.js";
import { machineHourlyUsd } from "../../packages/cloud-contracts/src/machine-prices.js";
import { SessionManager, machineTimeRecorder } from "../../packages/broker/src/aws/sessions.js";
import { pageTask, PRIYA, SAM } from "../support/page-tasks.js";
const START = Date.parse("2026-10-31T23:00:00.000Z");
const STOP = START + 7_200_000;

describe("task machine meter receipts", () => {
  it("records the launch and generation alongside the existing once receipt in its transaction", async () => {
    const db = new FakeDynamoDb();
    const input = { orgId: TEST_ORG, workspaceId: "workspace-a", instanceType: "m6g.large", startedAt: START, stoppedAt: STOP, generation: 1 };
    await recordMachineTime({ documentClient: db, tableName: "state" }, input);
    expect(db.get(machineTimeOnceKey(TEST_ORG, input.workspaceId, STOP))).toMatchObject({
      entityType: "MACHINE_TIME_ONCE", seconds: 7200, instanceType: "m6g.large", startedAt: START, stoppedAt: STOP, generation: 1,
    });
    expect(db.commandNames()).toEqual(["TransactWriteCommand"]);
  });
});


const REGION = "us-west-2";
function world() {
  const w = pageTask();
  const workspaceId = String(w.db.get(`DEVTASK#${w.taskId}`, "META")!.workspaceId);
  const workspaceKey = { pk: `WORKSPACE#${workspaceId}`, sk: "META" };
  w.db.set({ ...workspaceKey, entityType: "WORKSPACE", orgId: TEST_ORG, id: workspaceId });
  const d = { documentClient: w.db, tableName: "state" };
  const session = (extra: Record<string, unknown> = {}) => w.db.set({
    ...workspaceSessionKey(workspaceId), entityType: "SESSION", workspaceId, state: "STOPPED", generation: 1,
    launchedAt: new Date(START).toISOString(), ...extra,
  });
  const stop = async (extra: Record<string, unknown> = {}) => recordMachineTime(d, {
    orgId: TEST_ORG, workspaceId, instanceType: "m6g.large", startedAt: START, stoppedAt: STOP, generation: 1, ...extra,
  });
  session();
  const read = () => readTaskMachineMeter(w.deps, PRIYA, w.taskId, REGION);
  return { ...w, workspaceId, workspaceKey, d, session, stop, read };
}

describe("task machine meter", () => {
  it("counts a stop twice only once, by type, across UTC months and restarts", async () => {
    const w = world();
    await w.stop(); await w.stop();
    await w.stop({ instanceType: "m7i.xlarge", generation: 2, startedAt: STOP, stoppedAt: STOP + 3_600_000 });
    w.session({ generation: 2, launchedAt: new Date(STOP).toISOString() });
    expect(await w.read()).toMatchObject({ minutes: 180, usd: 0.3556, complete: true, scope: "workspace", label: "Per workspace", byInstanceType: {
      "m6g.large": { seconds: 7200, minutes: 120, usd: 0.154 }, "m7i.xlarge": { seconds: 3600, minutes: 60, usd: 0.2016 },
    } });
    expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-10"))).toBeUndefined();
    expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-11"))).toMatchObject({ seconds: 10800 });
  });

  it("reads the actual session generation through the real stop path", async () => {
    const w = world();
    w.session({ state: "STOPPING", instanceId: "i-0123456789abcdef0", instanceType: "m6g.large", subnetId: "subnet-01234567", volumeId: "vol-01234567", availabilityZone: "us-west-2a" });
    const manager = new SessionManager({ ...w.d, now: () => new Date(STOP), recordCompute: machineTimeRecorder(w.db, "state", TEST_ORG) });
    await manager.markStopped(w.workspaceId, 1);
    expect(await w.read()).toMatchObject({ complete: true, minutes: 120 });
  });

  it("returns only recorded time so far for an open run, never extrapolates", async () => {
    const w = world(); await w.stop();
    w.session({ state: "READY", instanceId: "running", generation: 2, launchedAt: new Date(STOP).toISOString() });
    expect(await w.read()).toMatchObject({ minutes: 120, complete: false, label: "Per workspace, so far" });
  });

  it("detects missing stops even after the old open marker was removed or replaced", async () => {
    const w = world(); await w.stop();
    await w.stop({ generation: 3, startedAt: STOP + 1000, stoppedAt: STOP + 3_601_000 });
    w.session({ generation: 3, launchedAt: new Date(STOP + 1000).toISOString() });
    expect(await w.read()).toMatchObject({ minutes: 180, complete: false });
  });

  it("does not call duplicate generation receipts complete", async () => {
    const w = world(); await w.stop();
    await w.stop({ generation: 3, startedAt: STOP, stoppedAt: STOP + 1000 });
    await w.stop({ generation: 3, startedAt: STOP + 1000, stoppedAt: STOP + 2000 });
    w.session({ generation: 3, launchedAt: new Date(STOP).toISOString() });
    expect((await w.read()).complete).toBe(false);
  });

  it("does not call an orphan, open marker, or mismatched launch complete", async () => {
    const w = world(); await w.stop();
    w.db.delete(workspaceSessionKey(w.workspaceId));
    expect((await w.read()).complete).toBe(false);
    w.session({ launchedAt: new Date(START + 1000).toISOString() });
    expect((await w.read()).complete).toBe(false);
    w.session();
    w.db.set({ ...openComputeKey(TEST_ORG, w.workspaceId), startedAt: START });
    expect((await w.read()).complete).toBe(false);
  });

  it("never completes a session changing while its receipts are read", async () => {
    const w = world(); await w.stop();
    const send = w.deps.documentClient.send.bind(w.deps.documentClient);
    let reads = 0;
    w.deps.documentClient = { send: async (command: unknown) => {
      if (command instanceof GetCommand && command.input.Key?.sk === "SESSION" && ++reads === 2) w.session({ state: "DELETED" });
      return send(command);
    } };
    expect((await w.read()).complete).toBe(false);
    expect(reads).toBe(2);
  });

  it.each(["unpriced.large", "__proto__", "constructor"])("keeps unknown type %s dollars unknown without polluting objects", async (instanceType) => {
    const w = world(); await w.stop({ instanceType });
    const result = await w.read();
    expect(result.usd).toBeNull();
    expect(result.byInstanceType[instanceType]).toMatchObject({ seconds: 7200, usd: null });
    expect(Object.getPrototypeOf(result.byInstanceType)).toBeNull();
    expect({}).not.toHaveProperty("seconds");
  });

  it("requires a verified region and keeps a mixed known/unknown total unknown", async () => {
    const w = world(); await w.stop();
    expect((await readTaskMachineMeter(w.deps, PRIYA, w.taskId, "eu-west-1")).usd).toBeNull();
    await w.stop({ instanceType: "unknown", startedAt: STOP, stoppedAt: STOP + 1000, generation: 2 });
    expect((await w.read()).usd).toBeNull();
    expect(machineHourlyUsd("m6g.large", REGION)).toBe(0.077);
    expect(machineHourlyUsd("m7i.xlarge", REGION)).toBe(0.2016);
    expect(machineHourlyUsd("m6g.large", "")).toBeUndefined();
  });

  it("preserves second rounding, tiny durations and zero semantics", async () => {
    const w = world();
    await w.stop({ stoppedAt: START + 499 });
    expect(await w.read()).toMatchObject({ minutes: 0, usd: 0, complete: false });
    expect(w.db.get(machineTimeOnceKey(TEST_ORG, w.workspaceId, START + 499))).toBeUndefined();
    await w.stop({ stoppedAt: START + 500 });
    const result = await w.read();
    expect(result.minutes).toBe(1 / 60);
    expect(result.usd).toBeCloseTo(0.077 / 3600, 12);
    expect(result.usd).toBeGreaterThan(0);
  });

  it("reads real writer output in the v1 shape without backfill or migration", async () => {
    const w = world(); await w.stop();
    const key = machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP);
    const receipt = w.db.get(key)!;
    delete receipt.startedAt; delete receipt.stoppedAt; delete receipt.generation;
    w.db.set(receipt);
    const before = w.db.commandNames().length;
    expect(await w.read()).toMatchObject({ minutes: 120, usd: 0.154, complete: false });
    expect(w.db.commandNames().slice(before).every(name => name === "GetCommand" || name === "QueryCommand")).toBe(true);
    await w.stop();
    expect(w.db.get(key)).toEqual(receipt);
    expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-11"))).toMatchObject({ seconds: 7200 });
  });

  it("keeps two tasks sharing one workspace explicitly per workspace", async () => {
    const w = world(); await w.stop();
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    w.db.set({ ...w.db.get(`DEVTASK#${w.taskId}`, "META")!, pk: `DEVTASK#${taskId}`, taskId });
    expect(await readTaskMachineMeter(w.deps, PRIYA, taskId, REGION)).toEqual(await w.read());
  });

  it("refuses nonowners and another company before reading meter rows", async () => {
    const w = world(); await w.stop();
    for (const caller of [SAM, { ...PRIYA, orgId: "org_bbbbbbbbbbbbbbbbbbbb" as OrgId }]) {
      const before = w.db.commandNames().length;
      await expect(readTaskMachineMeter(w.deps, caller, w.taskId, REGION)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(w.db.commandNames().slice(before)).not.toContain("QueryCommand");
    }
    expect((await w.read()).minutes).toBe(120);
  });

  it("refuses another company's workspace or a missing workspace", async () => {
    const w = world(); await w.stop();
    w.db.set({ ...w.db.get(w.workspaceKey)!, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    await expect(w.read()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    w.db.delete(w.workspaceKey);
    await expect(w.read()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("does not read another workspace or tenant's stop receipts", async () => {
    const w = world(); await w.stop();
    await w.stop({ workspaceId: w.workspaceId + "suffix" });
    await w.stop({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", startedAt: START - 3_600_000 });
    expect((await w.read()).minutes).toBe(120);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_VALUE])("refuses malformed stored seconds %s", async seconds => {
    const w = world(); await w.stop();
    const key = machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP);
    w.db.set({ ...w.db.get(key)!, seconds });
    await expect(w.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("fails closed on an unreadable receipt query", async () => {
    const w = world(); await w.stop();
    w.db.injectFault({ command: "QueryCommand", error: { name: "InternalServerError", message: "customer text" } });
    await expect(w.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: Machine time could not be read." });
  });

  it("keeps a failed transaction atomic with the org counter", async () => {
    const w = world();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.stop()).rejects.toThrow();
    expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-11"))).toBeUndefined();
    expect(w.db.get(machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP))).toBeUndefined();
    expect((await w.read()).complete).toBe(false);
  });

  it("bounds pagination and labels partial totals so far", async () => {
    const w = world();
    for (let i = 0; i < 1001; i++) await w.stop({ startedAt: STOP + i * 1000, stoppedAt: STOP + (i + 1) * 1000, generation: i + 1 });
    w.session({ generation: 1000, launchedAt: new Date(STOP + 999_000).toISOString() });
    const before = w.db.commandNames().length;
    const result = await w.read();
    expect(result).toMatchObject({ complete: false, label: "Per workspace, so far" });
    expect(result.minutes).toBe(1000 / 60);
    expect(w.db.commandNames().slice(before).filter(name => name === "QueryCommand")).toHaveLength(10);
  });
});

it("does not lose allowance seconds when optional generation metadata is unreadable or has moved on", async () => {
  for (const unreadable of [false, true]) {
    const w = world();
    w.session({ generation: 2, launchedAt: new Date(STOP).toISOString() });
    if (unreadable) w.db.injectFault({ command: "GetCommand", match: input => (input.Key as { sk?: string }).sk === "SESSION", error: { name: "InternalServerError" } });
    await machineTimeRecorder(w.db, "state", TEST_ORG)({ workspaceId: w.workspaceId, instanceType: "m6g.large", startedAt: START, stoppedAt: STOP });
    expect(w.db.get(machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP))).not.toHaveProperty("generation");
    expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-11"))).toMatchObject({ seconds: 7200 });
    expect(await w.read()).toMatchObject({ minutes: 120, complete: false });
  }
});

it.each([{ state: "PROVISIONING" }, { instanceId: "still-running" }, { generation: 2 }])("refuses to complete inconsistent session state %j", async extra => {
  const w = world(); await w.stop(); w.session(extra);
  expect((await w.read()).complete).toBe(false);
});

it("requires generation coverage starting at one", async () => {
  const w = world(); await w.stop({ generation: 2 }); w.session();
  expect((await w.read()).complete).toBe(false);
});

it("refuses workspace identifiers that can alter a key prefix", async () => {
  const w = world();
  w.db.set({ ...w.db.get(`DEVTASK#${w.taskId}`, "META")!, workspaceId: "other#workspace" });
  w.db.set({ pk: "WORKSPACE#other#workspace", sk: "META", orgId: TEST_ORG });
  await expect(w.read()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
});

it.each([0, -1, 0.5, Infinity, "1"])("does not attach invalid optional generation %s", async generation => {
  const w = world(); w.session({ generation });
  await machineTimeRecorder(w.db, "state", TEST_ORG)({ workspaceId: w.workspaceId, instanceType: "m6g.large", startedAt: START, stoppedAt: STOP });
  expect(w.db.get(machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP))).not.toHaveProperty("generation");
  expect(w.db.get(machineTimeMonthKey(TEST_ORG, "2026-11"))).toMatchObject({ seconds: 7200 });
});

it.each([
  { pk: "wrong" }, { sk: "wrong" }, { sk: "ONCE#replace#not-time" }, { sk: "ONCE#replace#9007199254740992" },
  { startedAt: STOP + 1 }, { stoppedAt: STOP + 1 }, { seconds: 1 }, { entityType: "OTHER" },
  { instanceType: "" }, { instanceType: 42 }, { generation: 0 }, { startedAt: Infinity },
])("refuses malformed receipt metadata %j", async change => {
  const w = world(); await w.stop();
  const key = machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP);
  const send = w.deps.documentClient.send.bind(w.deps.documentClient);
  w.deps.documentClient = { send: async (command: unknown) => {
    const result = await send(command);
    return command instanceof QueryCommand ? { ...result as object, Items: [{ ...w.db.get(key)!, ...change,
      ...("sk" in change ? { sk: change.sk.replace("replace", w.workspaceId) } : {}),
    }] } : result;
  } };
  await expect(w.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("refuses aggregate overflow instead of returning an imprecise printed number", async () => {
  const w = world();
  for (const at of [STOP, STOP + 1]) w.db.set({ ...machineTimeOnceKey(TEST_ORG, w.workspaceId, at), entityType: "MACHINE_TIME_ONCE", instanceType: "m6g.large", seconds: Number.MAX_SAFE_INTEGER });
  await expect(w.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("uses consistent reads for the workspace and session", async () => {
  const w = world(); await w.stop();
  const eventual = new FakeDynamoDb({ consistency: "eventual" });
  for (const item of w.db.items.values()) eventual.set(item);
  for (const key of [w.workspaceKey, workspaceSessionKey(w.workspaceId)]) {
    const item = eventual.get(key)!;
    eventual.delete(key);
    await eventual.send(new PutCommand({ TableName: "state", Item: item }));
  }
  w.deps.documentClient = eventual;
  expect(await w.read()).toMatchObject({ minutes: 120, complete: true });
});

it("uses a consistent receipt query instead of accepting an empty stale result", async () => {
  const w = world(); await w.stop();
  const send = w.deps.documentClient.send.bind(w.deps.documentClient);
  w.deps.documentClient = { send: async (command: unknown) => {
    if (command instanceof QueryCommand && command.input.ConsistentRead !== true) return { Items: [] };
    return send(command);
  } };
  expect(await w.read()).toMatchObject({ minutes: 120, complete: true });
});

it("refuses an unsafe legacy receipt timestamp", async () => {
  const w = world();
  w.db.set({ pk: machineTimeOnceKey(TEST_ORG, w.workspaceId, STOP).pk, sk: `ONCE#${w.workspaceId}#9007199254740992`, entityType: "MACHINE_TIME_ONCE", instanceType: "m6g.large", seconds: 7200 });
  await expect(w.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});
