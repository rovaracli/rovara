// Task 19: a new org's trial stays locked until GitHub is connected (one trial per GitHub account), and every org has a
// monthly allowance of EC2 machine time. Both are checked inside admitSpend, before the proxy is asked and before any charge.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentXError, errorStatus, machineTimeMonthKey, machineTimeOnceKey, orgMetaKey, trialGithubKey, type OrgId,
} from "../../packages/contracts/src/index.js";
import { createReaperHandler } from "../../packages/broker/src/aws/session-reaper.js";
import { SessionManager, machineTimeRecorder, type ComputeStop } from "../../packages/broker/src/aws/sessions.js";
import { admitSpend } from "../../packages/broker/src/org/budget.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import {
  TEAM_MACHINE_HOURS_PER_MONTH, TRIAL_MACHINE_HOURS_PER_MONTH, admitMachineTime, admitTrial, machineSecondsUsed, monthOf, recordMachineTime, unlockTrial,
} from "../../packages/broker/src/org/trial.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const LOCKED_MESSAGE = "Connect GitHub to start your free trial.";
const MACHINE_TIME_MESSAGE = "Your free machine time for this month is used up.";
const HOUR = 3600;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SLACK_USER = "U0123456789";
const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;

const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string; statusCode: number }; }
  throw new Error("expected a rejection");
};

/** An org record, as OrgStore writes one. */
function seedOrg(db: FakeDynamoDb, orgId: OrgId, plan: "trial" | "team", extra: Record<string, unknown> = {}) {
  db.set({ ...orgMetaKey(orgId), entityType: "ORG", orgId, name: "acme", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "dev1", plan, ...extra });
}

/** Machine time already recorded for the org in the UTC month of `at`. */
function seedSeconds(db: FakeDynamoDb, orgId: OrgId, at: number, seconds: number) {
  db.set({ ...machineTimeMonthKey(orgId, monthOf(at)), entityType: "MACHINE_TIME", seconds });
}

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const LAST_MONTH = Date.parse("2026-09-15T12:00:00.000Z");
const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => NOW });

describe("the trial and machine-time error codes", () => {
  it("answer 403, 409 and 402", () => {
    expect(errorStatus("TRIAL_LOCKED")).toBe(403);
    expect(errorStatus("TRIAL_GITHUB_USED")).toBe(409);
    expect(errorStatus("MACHINE_TIME_EXCEEDED")).toBe(402);
    expect(agentXError("MACHINE_TIME_EXCEEDED", "x").statusCode).toBe(402);
  });

  it("have the placeholder allowances: 20 hours for a trial, 400 for a team", () => {
    expect(TRIAL_MACHINE_HOURS_PER_MONTH).toBe(20);
    expect(TEAM_MACHINE_HOURS_PER_MONTH).toBe(400);
  });
});

describe("unlockTrial", () => {
  function setup() {
    const db = new FakeDynamoDb();
    seedOrg(db, TEST_ORG, "trial");
    seedOrg(db, ORG_B, "trial");
    return { db, d: deps(db) };
  }

  it("unlocks the org and claims the GitHub account for it, in one transaction", async () => {
    const { db, d } = setup();
    await expect(admitTrial(d, TEST_ORG)).rejects.toMatchObject({ code: "TRIAL_LOCKED" });
    const before = db.commandNames().length;
    await unlockTrial(d, { orgId: TEST_ORG, githubUserId: "123" });
    expect(db.commandNames().slice(before)).toContain("TransactWriteCommand");
    expect(db.get(trialGithubKey("123"))).toMatchObject({ pk: "TRIAL_GITHUB#123", sk: "ORG", orgId: TEST_ORG });
    expect(db.get(orgMetaKey(TEST_ORG))).toMatchObject({ trialUnlockedAt: NOW, trialGithubUserId: "123" });
    await expect(admitTrial(d, TEST_ORG)).resolves.toBeUndefined();
  });

  it("refuses a GitHub account that already unlocked another org with TRIAL_GITHUB_USED, and the other org stays locked", async () => {
    const { db, d } = setup();
    await unlockTrial(d, { orgId: TEST_ORG, githubUserId: "123" });
    const error = await rejection(unlockTrial(d, { orgId: ORG_B, githubUserId: "123" }));
    expect(error).toMatchObject({ code: "TRIAL_GITHUB_USED", statusCode: 409 });
    expect(db.get(orgMetaKey(ORG_B))).not.toHaveProperty("trialUnlockedAt");
    expect(db.get(trialGithubKey("123"))).toMatchObject({ orgId: TEST_ORG });
    expect((await rejection(admitTrial(d, ORG_B))).code).toBe("TRIAL_LOCKED");
  });

  it("is a no-op for an org that is already unlocked, even from another GitHub account, and claims nothing more", async () => {
    const { db, d } = setup();
    await unlockTrial(d, { orgId: TEST_ORG, githubUserId: "123" });
    await unlockTrial(d, { orgId: TEST_ORG, githubUserId: "123" });
    await unlockTrial(d, { orgId: TEST_ORG, githubUserId: "456" });
    expect(db.get(orgMetaKey(TEST_ORG))).toMatchObject({ trialUnlockedAt: NOW, trialGithubUserId: "123" });
    expect(db.get(trialGithubKey("456"))).toBeUndefined();
    // The account that was not used can still unlock another org.
    await unlockTrial(d, { orgId: ORG_B, githubUserId: "456" });
    expect(db.get(orgMetaKey(ORG_B))).toMatchObject({ trialGithubUserId: "456" });
  });

  it("lets a retry after losing the race to another callback finish quietly, with the claim rolled back", async () => {
    const { db, d } = setup();
    // The org is unlocked between unlockTrial's read and its transaction.
    const real = db.send;
    let raced = false;
    const racing = { ...d, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand" && !raced) {
        raced = true;
        db.set({ ...db.get(orgMetaKey(TEST_ORG))!, trialUnlockedAt: NOW - 1, trialGithubUserId: "777" });
      }
      return real(command as never);
    } } };
    await unlockTrial(racing, { orgId: TEST_ORG, githubUserId: "123" });
    expect(db.get(orgMetaKey(TEST_ORG))).toMatchObject({ trialGithubUserId: "777" });
    expect(db.get(trialGithubKey("123"))).toBeUndefined();
  });

  it("refuses an unknown org and an empty GitHub id, writing nothing", async () => {
    const { db, d } = setup();
    expect((await rejection(unlockTrial(d, { orgId: "org_cccccccccccccccccccc", githubUserId: "123" }))).code).toBe("NOT_FOUND");
    expect((await rejection(unlockTrial(d, { orgId: TEST_ORG, githubUserId: " " }))).code).toBe("CONFIG_INVALID");
    expect(db.find((item) => String(item.pk).startsWith("TRIAL_GITHUB#"))).toEqual([]);
  });

  it("works against the org a real OrgStore created: a new trial org is locked, then unlocked", async () => {
    const db = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => NOW });
    const orgId = await orgs.createOrgWithOwner({ name: "acme", developerId: "dev1" });
    const d = deps(db);
    expect((await rejection(admitTrial(d, orgId))).message).toBe(`TRIAL_LOCKED: ${LOCKED_MESSAGE}`);
    await unlockTrial(d, { orgId, githubUserId: "9" });
    expect(await orgs.getOrg(orgId)).toMatchObject({ plan: "trial", trialUnlockedAt: NOW, trialGithubUserId: "9" });
  });
});

describe("admitTrial", () => {
  it("passes an org on any other plan, and an org with no record", async () => {
    const db = new FakeDynamoDb();
    seedOrg(db, TEST_ORG, "team");
    await expect(admitTrial(deps(db), TEST_ORG)).resolves.toBeUndefined();
    await expect(admitTrial(deps(db), ORG_B)).resolves.toBeUndefined();
  });
});

describe("recordMachineTime", () => {
  const stop = (extra: Record<string, unknown> = {}) => ({ orgId: TEST_ORG, workspaceId: "ws-1", instanceType: "m7g.large", startedAt: NOW - 2 * HOUR * 1000, stoppedAt: NOW, ...extra });

  it("adds the run's seconds to the stop month, and the same stop recorded twice counts once", async () => {
    const db = new FakeDynamoDb();
    await recordMachineTime(deps(db), stop());
    await recordMachineTime(deps(db), stop());
    expect(db.get(machineTimeMonthKey(TEST_ORG, "2026-10"))).toMatchObject({ seconds: 2 * HOUR, seconds_m7g_large: 2 * HOUR });
    expect(db.get(machineTimeOnceKey(TEST_ORG, "ws-1", NOW))).toMatchObject({ seconds: 2 * HOUR, instanceType: "m7g.large" });
    expect(await machineSecondsUsed(deps(db), TEST_ORG, "2026-10")).toBe(2 * HOUR);
  });

  it("counts a different stop of the same workspace, and the same stop time of another workspace", async () => {
    const db = new FakeDynamoDb();
    await recordMachineTime(deps(db), stop());
    await recordMachineTime(deps(db), stop({ startedAt: NOW + 1000, stoppedAt: NOW + HOUR * 1000 + 1000 }));
    await recordMachineTime(deps(db), stop({ workspaceId: "ws-2" }));
    expect(await machineSecondsUsed(deps(db), TEST_ORG, "2026-10")).toBe(5 * HOUR);
  });

  it("attributes a run that spans a month boundary whole to the month it stopped in", async () => {
    const db = new FakeDynamoDb();
    const stoppedAt = Date.parse("2026-11-01T01:00:00.000Z");
    await recordMachineTime(deps(db), stop({ startedAt: Date.parse("2026-10-31T23:00:00.000Z"), stoppedAt }));
    expect(await machineSecondsUsed(deps(db), TEST_ORG, "2026-11")).toBe(2 * HOUR);
    expect(await machineSecondsUsed(deps(db), TEST_ORG, "2026-10")).toBe(0);
  });

  it("keeps each org's time apart, and writes nothing for a run of no length", async () => {
    const db = new FakeDynamoDb();
    await recordMachineTime(deps(db), stop());
    await recordMachineTime(deps(db), stop({ orgId: ORG_B, workspaceId: "ws-3", startedAt: NOW, stoppedAt: NOW }));
    expect(await machineSecondsUsed(deps(db), ORG_B, "2026-10")).toBe(0);
    expect(db.get(machineTimeOnceKey(ORG_B, "ws-3", NOW))).toBeUndefined();
    expect(await machineSecondsUsed(deps(db), TEST_ORG, "2026-10")).toBe(2 * HOUR);
  });
});

describe("admitMachineTime", () => {
  function setup(plan: "trial" | "team" = "trial") {
    const db = new FakeDynamoDb();
    seedOrg(db, TEST_ORG, plan, { trialUnlockedAt: 1 });
    return { db, d: deps(db) };
  }

  it("refuses a trial org at 20 hours this month with 402 MACHINE_TIME_EXCEEDED and the exact message", async () => {
    const { db, d } = setup();
    seedSeconds(db, TEST_ORG, NOW, 20 * HOUR);
    expect(await rejection(admitMachineTime(d, TEST_ORG))).toMatchObject({ code: "MACHINE_TIME_EXCEEDED", statusCode: 402, message: `MACHINE_TIME_EXCEEDED: ${MACHINE_TIME_MESSAGE}` });
    seedSeconds(db, TEST_ORG, NOW, 21 * HOUR);
    expect((await rejection(admitMachineTime(d, TEST_ORG))).code).toBe("MACHINE_TIME_EXCEEDED");
  });

  it("passes a trial org at 19.9 hours", async () => {
    const { db, d } = setup();
    seedSeconds(db, TEST_ORG, NOW, 19.9 * HOUR);
    await expect(admitMachineTime(d, TEST_ORG)).resolves.toBeUndefined();
  });

  it("does not count hours recorded last month", async () => {
    const { db, d } = setup();
    seedSeconds(db, TEST_ORG, LAST_MONTH, 500 * HOUR);
    await expect(admitMachineTime(d, TEST_ORG)).resolves.toBeUndefined();
  });

  it("allows a team org 400 hours", async () => {
    const { db, d } = setup("team");
    seedSeconds(db, TEST_ORG, NOW, 399 * HOUR);
    await expect(admitMachineTime(d, TEST_ORG)).resolves.toBeUndefined();
    seedSeconds(db, TEST_ORG, NOW, 400 * HOUR);
    expect((await rejection(admitMachineTime(d, TEST_ORG))).code).toBe("MACHINE_TIME_EXCEEDED");
  });

  it("does not limit an org with no record", async () => {
    const db = new FakeDynamoDb();
    seedSeconds(db, TEST_ORG, NOW, 9999 * HOUR);
    await expect(admitMachineTime(deps(db), TEST_ORG)).resolves.toBeUndefined();
  });

  it("reads the month from the clock it is given, so the allowance starts again on the 1st (UTC)", async () => {
    const { db } = setup();
    seedSeconds(db, TEST_ORG, NOW, 20 * HOUR);
    const lastSecondOfMonth = { ...deps(db), now: () => Date.parse("2026-10-31T23:59:59.000Z") };
    const firstSecondOfNext = { ...deps(db), now: () => Date.parse("2026-11-01T00:00:00.000Z") };
    expect((await rejection(admitMachineTime(lastSecondOfMonth, TEST_ORG))).code).toBe("MACHINE_TIME_EXCEEDED");
    await expect(admitMachineTime(firstSecondOfNext, TEST_ORG)).resolves.toBeUndefined();
  });
});

describe("admitSpend", () => {
  function setup(plan: "trial" | "team", extra: Record<string, unknown> = {}) {
    const db = new FakeDynamoDb();
    seedOrg(db, TEST_ORG, plan, extra);
    const access = fakeModelAccess();
    access.setMemberSpent(TEST_ORG, "dev1", 0);
    access.setOrgSpent(TEST_ORG, 0);
    return { db, access, run: () => admitSpend({ documentClient: db, tableName: "state", access, now: () => NOW }, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" }) };
  }

  it("refuses a locked trial before the proxy is asked anything", async () => {
    const { access, run } = setup("trial");
    expect(await rejection(run())).toMatchObject({ code: "TRIAL_LOCKED", statusCode: 403, message: `TRIAL_LOCKED: ${LOCKED_MESSAGE}` });
    expect(access.upsertOrg).not.toHaveBeenCalled();
    expect(access.upsertMember).not.toHaveBeenCalled();
    expect(access.spend).not.toHaveBeenCalled();
  });

  it("checks the lock first, then machine time, then the budget", async () => {
    // Locked and over machine time and over budget: the lock is what is said.
    const locked = setup("trial");
    seedSeconds(locked.db, TEST_ORG, NOW, 20 * HOUR);
    locked.access.setMemberSpent(TEST_ORG, "dev1", 29);
    expect((await rejection(locked.run())).code).toBe("TRIAL_LOCKED");
    // Unlocked, over machine time and over budget: machine time.
    const open = setup("trial", { trialUnlockedAt: 1 });
    seedSeconds(open.db, TEST_ORG, NOW, 20 * HOUR);
    open.access.setMemberSpent(TEST_ORG, "dev1", 29);
    expect((await rejection(open.run())).code).toBe("MACHINE_TIME_EXCEEDED");
    expect(open.access.spend).not.toHaveBeenCalled();
    // Unlocked, with machine time left, over budget: the budget.
    const broke = setup("trial", { trialUnlockedAt: 1 });
    broke.access.setMemberSpent(TEST_ORG, "dev1", 29);
    expect((await rejection(broke.run())).code).toBe("BUDGET_EXCEEDED");
  });

  it("admits an unlocked trial with time left, and a team org that was never locked", async () => {
    expect(await setup("trial", { trialUnlockedAt: 1 }).run()).toEqual({ maxBudgetUsd: 25 });
    expect(await setup("team").run()).toEqual({ maxBudgetUsd: 25 });
  });
});

describe("a developer task start", () => {
  async function install(org: { plan: "trial" | "team"; unlocked?: boolean }) {
    const access = fakeModelAccess();
    const harness = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    seedOrg(harness.db, TEST_ORG, org.plan, org.unlocked === true ? { trialUnlockedAt: 1 } : {});
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    const start = () => harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const mark = harness.db.commandNames().length;
    return { ...harness, access, start, sent: () => harness.db.commandNames().slice(mark) };
  }
  const written = (h: { db: FakeDynamoDb }) => h.db.find((item) => ["WORKSPACE", "OPERATION", "DEVELOPER_TASK", "OUTBOX"].includes(String(item.entityType)) || String(item.pk).includes("DEVELOPER_LIMIT"));

  it("refuses a new trial org with 403 TRIAL_LOCKED and the exact message, before any charge or key", async () => {
    const h = await install({ plan: "trial" });
    expect(await h.start()).toMatchObject({ status: 403, body: { error: { code: "TRIAL_LOCKED", message: LOCKED_MESSAGE } } });
    expect(h.sent()).not.toContain("TransactWriteCommand");
    expect(written(h)).toEqual([]);
    expect(h.access.mintKey).not.toHaveBeenCalled();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
    // The refusal is audited like any other.
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused")).toHaveLength(1);
  });

  it("starts the task once GitHub is connected", async () => {
    const h = await install({ plan: "trial" });
    expect((await h.start()).status).toBe(403);
    await unlockTrial({ documentClient: h.db, tableName: "state" }, { orgId: TEST_ORG, githubUserId: "123" });
    expect((await h.start()).status).toBe(200);
  });

  it("refuses an unlocked trial org with its month's machine time used up: 402, no charge, no key", async () => {
    const h = await install({ plan: "trial", unlocked: true });
    seedSeconds(h.db, TEST_ORG, Date.now(), 20 * HOUR);
    expect(await h.start()).toMatchObject({ status: 402, body: { error: { code: "MACHINE_TIME_EXCEEDED", message: MACHINE_TIME_MESSAGE } } });
    expect(h.sent()).not.toContain("TransactWriteCommand");
    expect(written(h)).toEqual([]);
    expect(h.access.mintKey).not.toHaveBeenCalled();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
  });

  it("starts with 19.9 hours used this month, and with a lot used last month", async () => {
    const h = await install({ plan: "trial", unlocked: true });
    seedSeconds(h.db, TEST_ORG, Date.now(), 19.9 * HOUR);
    expect((await h.start()).status).toBe(200);
    const other = await install({ plan: "trial", unlocked: true });
    const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCHours(-1);
    seedSeconds(other.db, TEST_ORG, lastMonth.getTime(), 500 * HOUR);
    expect((await other.start()).status).toBe(200);
  });

  it("never locks a team org (a single-org install's org is one)", async () => {
    const h = await install({ plan: "team" });
    expect((await h.start()).status).toBe(200);
  });
});

describe("Slack-started work", () => {
  beforeAll(loadSlackBroker);
  const workspaceItems = (db: FakeDynamoDb) => db.find((item) => item.entityType === "WORKSPACE" || item.entityType === "OPERATION" || item.entityType === "OUTBOX");

  it("refuses a locked trial org with 403 before any workspace, charge or proxy call", async () => {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    await registerSlackProject(handler);
    seedOrg(db, TEST_ORG, "trial");
    const mark = db.commandNames().length;
    expect(await ensureWorkspace(handler, THREAD, SLACK_USER)).toMatchObject({ status: 403, body: { error: { code: "TRIAL_LOCKED", message: LOCKED_MESSAGE } } });
    expect(workspaceItems(db)).toEqual([]);
    expect(db.find((item) => typeof item.pk === "string" && item.pk.includes("LIMIT"))).toEqual([]);
    expect(db.commandNames().slice(mark)).not.toContain("TransactWriteCommand");
    expect(access.upsertOrg).not.toHaveBeenCalled();
    expect(access.orgSpend).not.toHaveBeenCalled();
    await unlockTrial({ documentClient: db, tableName: "state" }, { orgId: TEST_ORG, githubUserId: "123" });
    access.setOrgSpent(TEST_ORG, 0);
    expect((await ensureWorkspace(handler, THREAD, SLACK_USER)).status).toBe(200);
  });

  it("refuses an org with no machine time left with 402 before any workspace or charge", async () => {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    await registerSlackProject(handler);
    seedOrg(db, TEST_ORG, "trial", { trialUnlockedAt: 1 });
    seedSeconds(db, TEST_ORG, Date.now(), 20 * HOUR);
    const mark = db.commandNames().length;
    expect(await ensureWorkspace(handler, THREAD, SLACK_USER)).toMatchObject({ status: 402, body: { error: { code: "MACHINE_TIME_EXCEEDED", message: MACHINE_TIME_MESSAGE } } });
    expect(workspaceItems(db)).toEqual([]);
    expect(db.commandNames().slice(mark)).not.toContain("TransactWriteCommand");
    expect(access.upsertOrg).not.toHaveBeenCalled();
  });
});

describe("machine time is recorded where compute ends", () => {
  const LAUNCHED = Date.parse("2026-10-19T10:00:00.000Z");
  const binding = {
    deploymentMode: "ec2-ebs" as const,
    launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
    volumeSizeGiB: 20,
    volumeType: "gp3" as const,
  };

  function setup(options: { recordCompute?: (stop: ComputeStop) => Promise<void> } = {}) {
    const db = new FakeDynamoDb();
    let now = LAUNCHED;
    const recordCompute = vi.fn(options.recordCompute ?? machineTimeRecorder(db, "state", ORG_B));
    const sessions = new SessionManager({
      documentClient: db,
      tableName: "state",
      executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:p", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:d", start: async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:p:${name}` },
      now: () => new Date(now),
      chooseSubnet: (subnets) => subnets[0]!,
      recordCompute,
    });
    const workspaceId = randomUUID();
    // The workspace record names its org (Task 5).
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", orgId: TEST_ORG, deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 1 });
    return { db, sessions, workspaceId, recordCompute, advance: (ms: number) => { now += ms; } };
  }

  async function ready(sessions: SessionManager, workspaceId: string, instanceType: string | null = "m7g.large") {
    await sessions.ensureSession({ workspaceId, binding });
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", instanceType ?? undefined);
    await sessions.markReady(workspaceId, 1);
  }

  it("counts a stopped session from its launch to its stop, against the workspace's org and instance type", async () => {
    const { db, sessions, workspaceId, recordCompute, advance } = setup();
    await ready(sessions, workspaceId);
    advance(90 * 60_000);
    expect(await sessions.claimStop((await sessions.get(workspaceId))!)).toBe(true);
    expect(recordCompute).not.toHaveBeenCalled();
    await sessions.markStopped(workspaceId, 1);
    expect(recordCompute).toHaveBeenCalledExactlyOnceWith({ workspaceId, instanceType: "m7g.large", startedAt: LAUNCHED, stoppedAt: LAUNCHED + 90 * 60_000 });
    expect(db.get(machineTimeMonthKey(TEST_ORG, "2026-10"))).toMatchObject({ seconds: 90 * 60, seconds_m7g_large: 90 * 60 });
    // A replayed markStopped does not count it again.
    await sessions.markStopped(workspaceId, 1);
    expect(recordCompute).toHaveBeenCalledOnce();
    expect(await machineSecondsUsed({ documentClient: db, tableName: "state" }, TEST_ORG, "2026-10")).toBe(90 * 60);
  });

  it("counts a session lost from under a READY worker", async () => {
    const { sessions, workspaceId, recordCompute, advance } = setup({ recordCompute: async () => undefined });
    await ready(sessions, workspaceId);
    advance(60 * 60_000);
    expect(await sessions.markLost((await sessions.get(workspaceId))!)).toBe(true);
    expect(recordCompute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId, startedAt: LAUNCHED, stoppedAt: LAUNCHED + 3_600_000 }));
  });

  it("counts a provisioning that failed after its instance launched, and not one that never launched", async () => {
    const launched = setup({ recordCompute: async () => undefined });
    await launched.sessions.ensureSession({ workspaceId: launched.workspaceId, binding });
    await launched.sessions.markInstance(launched.workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", "m7g.large");
    launched.advance(10 * 60_000);
    await launched.sessions.markFailed(launched.workspaceId, 1, "worker did not answer /ping");
    expect(launched.recordCompute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startedAt: LAUNCHED, stoppedAt: LAUNCHED + 600_000 }));

    const never = setup({ recordCompute: async () => undefined });
    await never.sessions.ensureSession({ workspaceId: never.workspaceId, binding });
    await never.sessions.markFailed(never.workspaceId, 1, "no capacity");
    expect(never.recordCompute).not.toHaveBeenCalled();
  });

  it("counts a deleted workspace's running compute once, and a stopped one's deletion counts nothing more", async () => {
    const running = setup({ recordCompute: async () => undefined });
    await ready(running.sessions, running.workspaceId, null);
    running.advance(30 * 60_000);
    await running.sessions.deleteSession(running.workspaceId);
    await running.sessions.markDeleted(running.workspaceId);
    await running.sessions.markDeleted(running.workspaceId);
    // A session launched before the instance type was recorded counts as an unknown type.
    expect(running.recordCompute).toHaveBeenCalledExactlyOnceWith({ workspaceId: running.workspaceId, instanceType: "unknown", startedAt: LAUNCHED, stoppedAt: LAUNCHED + 1_800_000 });

    const stopped = setup({ recordCompute: async () => undefined });
    await ready(stopped.sessions, stopped.workspaceId);
    await stopped.sessions.claimStop((await stopped.sessions.get(stopped.workspaceId))!);
    await stopped.sessions.markStopped(stopped.workspaceId, 1);
    stopped.recordCompute.mockClear();
    await stopped.sessions.deleteSession(stopped.workspaceId);
    await stopped.sessions.markDeleted(stopped.workspaceId);
    expect(stopped.recordCompute).not.toHaveBeenCalled();
  });

  it("logs and keeps the transition when counting fails, naming only the error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { sessions, workspaceId, session } = (() => {
        const s = setup({ recordCompute: async () => { throw new Error("secret detail"); } });
        return { ...s, session: () => s.sessions.get(s.workspaceId) };
      })();
      await ready(sessions, workspaceId);
      await sessions.claimStop((await sessions.get(workspaceId))!);
      await expect(sessions.markStopped(workspaceId, 1)).resolves.toMatchObject({ state: "STOPPED" });
      expect(await session()).toMatchObject({ state: "STOPPED" });
      const logged = log.mock.calls.map((entry) => String(entry[0])).join("\n");
      expect(logged).toContain("session.machine_time_failed");
      expect(logged).not.toContain("secret detail");
    } finally {
      log.mockRestore();
    }
  });

  it("records nothing when no recorder is configured (the dispatcher and broker never end compute)", async () => {
    const db = new FakeDynamoDb();
    const sessions = new SessionManager({
      documentClient: db, tableName: "state", now: () => new Date(LAUNCHED),
      executions: { provisionerArn: "p", deleterArn: "d", start: async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:p:${name}` },
      chooseSubnet: (subnets) => subnets[0]!,
    });
    const workspaceId = randomUUID();
    await ready(sessions, workspaceId);
    await sessions.claimStop((await sessions.get(workspaceId))!);
    await sessions.markStopped(workspaceId, 1);
    expect(db.find((item) => String(item.pk).includes("MACHINE_TIME"))).toEqual([]);
  });

  it("falls back to the install's org for a workspace record that names none", async () => {
    const { db, sessions, workspaceId, advance } = setup();
    db.delete(`WORKSPACE#${workspaceId}`, "META");
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs" });
    await ready(sessions, workspaceId);
    advance(HOUR * 1000);
    await sessions.claimStop((await sessions.get(workspaceId))!);
    await sessions.markStopped(workspaceId, 1);
    expect(await machineSecondsUsed({ documentClient: db, tableName: "state" }, ORG_B, "2026-10")).toBe(HOUR);
  });

  it("is wired through the idle reaper: an idle session's stop counts, once, however many ticks follow", async () => {
    const { db, sessions, workspaceId, advance } = setup();
    await ready(sessions, workspaceId);
    advance(60 * 60_000);
    const state = { instanceGone: false, instanceLive: false, volumeAvailable: false };
    const reap = createReaperHandler({
      sessions,
      activeOperation: async () => false,
      ping: async () => "Healthy",
      terminate: async () => undefined,
      progress: async () => state,
      binding: async () => binding,
      emit: () => undefined,
      now: () => new Date(LAUNCHED + 60 * 60_000),
      log: () => undefined,
    });
    await reap();
    expect(await machineSecondsUsed({ documentClient: db, tableName: "state" }, TEST_ORG, "2026-10")).toBe(0);
    state.instanceGone = true;
    state.volumeAvailable = true;
    await reap();
    await reap();
    expect(await machineSecondsUsed({ documentClient: db, tableName: "state" }, TEST_ORG, "2026-10")).toBe(HOUR);
  });
});
