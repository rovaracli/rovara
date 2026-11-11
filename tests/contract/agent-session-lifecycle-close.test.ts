// Plan 5 Task 21: closing an org through the real broker. The last owner leaves, which closes a cloud org: its sessions' live index, work entries, devices and change feeds go and the rest
// expires in 30 days, and another org's rows of every kind are left as they are. A close whose session clearing fails stops before the org is closed, and leaving again finishes it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, changesKey, endedSessionWorkKey, liveSessionKey, mySessionsKey, openAgentSessionKey, projectSessionsKey, type OrgId } from "@rovara-code/contracts";
import { deviceKey, memberDevicesKey, orgMetaKey } from "@agentx/cloud-contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const AT = "2026-10-22T08:00:00.000Z";
const DAY = new Date().toISOString().slice(0, 10);

async function company() {
  const h = await createDeveloperTaskBroker({
    register: false, orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG),
    brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() } },
  });
  for (const [who, orgId] of [[MAYA, TEST_ORG], [OMAR, ORG_B]] as const) {
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role: "owner" });
  }
  const seed = (orgId: OrgId, owner: string, letter: string) => {
    const sessionId = `ses_${letter.repeat(20)}`;
    const deviceId = `dvc_${letter.repeat(20)}`;
    h.db.set({
      ...agentSessionKey(orgId, sessionId, "META"), entityType: "AGENT_SESSION", orgId, sessionId, kind: "task", owner: { developerId: owner, name: "Someone" }, startedBy: { kind: "member", developerId: owner },
      project: "payments", createdAt: AT, updatedAt: AT, revision: 1, followerCount: 0,
    });
    h.db.set({ ...agentSessionKey(orgId, sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_1"), entityType: "AGENT_SESSION_EVENT", orgId, text: "started" });
    h.db.set({ ...liveSessionKey(orgId, sessionId), entityType: "LIVE_SESSION", orgId, sessionId });
    h.db.set({ ...openAgentSessionKey(orgId, sessionId), entityType: "OPEN_AGENT_SESSION", orgId, sessionId });
    h.db.set({ ...endedSessionWorkKey(DAY, orgId, sessionId), entityType: "ENDED_AGENT_SESSION", orgId, sessionId });
    h.db.set({ ...mySessionsKey(orgId, owner, AT, sessionId), entityType: "MY_SESSION", orgId, sessionId, developerId: owner, createdAt: AT });
    h.db.set({ ...projectSessionsKey(orgId, "payments", AT, sessionId), entityType: "PROJECT_SESSION", orgId, sessionId, project: "payments", createdAt: AT });
    h.db.set({ ...deviceKey(orgId, deviceId), entityType: "DEVICE", orgId, deviceId, developerId: owner });
    h.db.set({ ...memberDevicesKey(orgId, owner, deviceId), entityType: "MEMBER_DEVICE", orgId, deviceId, developerId: owner });
    h.db.set({ ...changesKey(orgId, owner, AT, 1), entityType: "CHANGE_NOTICE", orgId, type: "session_shared", sessionId });
    return { sessionId, deviceId };
  };
  return { h, mine: seed(TEST_ORG, MAYA.developerId, "a"), theirs: seed(ORG_B, OMAR.developerId, "b") };
}

describe("closing an org with sessions", () => {
  it("deletes the org's live index, work entries, devices and change feeds, shortens the rest, and leaves another org's alone", async () => {
    const { h, mine, theirs } = await company();
    const before = JSON.stringify(h.db.find((item) => String(item.pk).includes(ORG_B) || String(item.sk).includes(ORG_B)));
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    expect(h.db.get(liveSessionKey(TEST_ORG, mine.sessionId))).toBeUndefined();
    expect(h.db.get(openAgentSessionKey(TEST_ORG, mine.sessionId as never))).toBeUndefined();
    expect(h.db.get(endedSessionWorkKey(DAY, TEST_ORG, mine.sessionId as never))).toBeUndefined();
    expect(h.db.get(deviceKey(TEST_ORG, mine.deviceId as never))).toBeUndefined();
    expect(h.db.get(memberDevicesKey(TEST_ORG, MAYA.developerId, mine.deviceId as never))).toBeUndefined();
    expect(h.db.get(changesKey(TEST_ORG, MAYA.developerId, AT, 1))).toBeUndefined();
    for (const key of [agentSessionKey(TEST_ORG, mine.sessionId, "META"), agentSessionKey(TEST_ORG, mine.sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_1"), mySessionsKey(TEST_ORG, MAYA.developerId, AT, mine.sessionId), projectSessionsKey(TEST_ORG, "payments", AT, mine.sessionId)]) {
      const expires = h.db.get(key)?.["indexExpiresAt"];
      expect(typeof expires, key.sk).toBe("number");
      expect(Number(expires) - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * 86_400);
      expect(Number(expires) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30 * 86_400 + 5);
    }
    expect(h.db.get(orgMetaKey(TEST_ORG))?.["closedAt"]).toBeDefined();
    expect(JSON.stringify(h.db.find((item) => String(item.pk).includes(ORG_B) || String(item.sk).includes(ORG_B)))).toBe(before);
    expect(h.db.get(liveSessionKey(ORG_B, theirs.sessionId))).toBeDefined();
  });

  it("stops before the org is closed when its sessions cannot be cleared, and leaving again finishes", async () => {
    const { h, mine } = await company();
    h.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input).includes("LIVE_SESSIONS"), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    const failed = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h.db.get(orgMetaKey(TEST_ORG))?.["closedAt"]).toBeUndefined();
    expect(h.db.get(liveSessionKey(TEST_ORG, mine.sessionId))).toBeDefined();
    const again = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(h.db.get(liveSessionKey(TEST_ORG, mine.sessionId))).toBeUndefined();
    expect(h.db.get(orgMetaKey(TEST_ORG))?.["closedAt"]).toBeDefined();
  });
});

describe("closing an org stops the work that is running (Review M-6)", () => {
  const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
  type Item = Record<string, unknown>;

  async function runningRun() {
    const h = await createDeveloperTaskBroker({ orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG), brokerExtra: { cloud: true, agents: {} } });
    await h.orgOf(MAYA);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; kind: string; fence: number; status: string }>;
    const reply = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { workspaceId, sessionId } = h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workspaceId: string; sessionId: string };
    await h.finish(workspaceId, String(operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    return { h, operations, workspaceId, sessionId, taskId };
  }

  it("asks the running step to stop, once, through the task's own cancel, and the close still completes", async () => {
    const { h, operations, workspaceId, sessionId } = await runningRun();
    const step = () => operations(workspaceId).filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence)[0]!;
    expect(step().status).not.toBe("CANCEL_REQUESTED");
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    expect(step().status).toBe("CANCEL_REQUESTED");
    expect(operations(workspaceId).filter((operation) => operation.kind === "cancel")).toHaveLength(1);
    expect(h.db.get(orgMetaKey(TEST_ORG))?.["closedAt"]).toBeDefined();
    expect(h.db.get(openAgentSessionKey(TEST_ORG, sessionId))).toBeUndefined();
  });
});

describe("the store's stop of running work (Review M-6)", () => {
  it("runs after triggers and hooks are cleared and before the sessions go, and a failure of it never stops the close", async () => {
    const db = new FakeDynamoDb();
    const store = new OrgStore({ documentClient: db, tableName: "T", now: () => Date.parse("2026-10-24T12:00:00.000Z"), newOrgId: () => "org_cccccccccccccccccccc" });
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "dev-1" });
    const order: string[] = [];
    await store.closeOrg(orgId, {
      stopWork: async () => { order.push("stop"); throw new Error("a stop that fails"); },
      archiveProjects: async () => { order.push("archive"); },
      clearEgress: async () => { order.push("egress"); },
      clearTriggers: async () => { order.push("triggers"); },
      clearHooks: async () => { order.push("hooks"); },
      clearSessions: async () => { order.push("sessions"); },
    });
    // Triggers, schedules and hooks that could start new runs are cleared before the running ones are asked to stop (Re-check R-2).
    expect(order).toEqual(["archive", "egress", "triggers", "hooks", "stop", "sessions"]);
    expect(db.get(orgMetaKey(orgId))?.["closedAt"]).toBeDefined();
  });
});
