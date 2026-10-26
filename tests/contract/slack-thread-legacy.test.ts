import { slackTeamOrgKey } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveSlackThreadKey, slackThreadKey } from "../../packages/broker/src/aws/slack-thread-key.js";
import { workspaceOwner } from "../../packages/broker/src/aws/admin-reads.js";
import { legacySlackThread } from "../support/legacy-slack-thread.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_TEAM, SLACK_CHANNEL, createBroker, ensureWorkspace, finishOperation, lazyEnsureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const user = "U0123456789";
beforeAll(loadSlackBroker);
afterEach(() => vi.unstubAllEnvs());

describe("K1: pre-org Slack workspaces", () => {
  it("reuses the original legacy row and charge, stops and closes it, and never reopens it", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const first = await ensureWorkspace(handler, subject, user);
    expect(first.body.outcome).toBe("WORKSPACE");
    const workspaceId = String(first.body.workspaceId);
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, subject, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    expect(conversation.status, JSON.stringify(conversation.body)).toBe(201);
    const task = await serviceCall(handler, subject, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "synthetic work" });
    expect(task.status).toBe(202);
    const legacy = legacySlackThread(db, workspaceId);
    const charges = structuredClone(db.find((row) => row.entityType === "SLACK_LIMIT"));
    const again = await lazyEnsureWorkspace(handler, subject, user);
    expect(again.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, created: false });
    expect(db.find((row) => row.entityType === "SLACK_LIMIT")).toEqual(charges);
    expect(db.find((row) => row.entityType === "SLACK_THREAD")).toEqual([legacy]);
    const stopped = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, userId: user });
    expect(JSON.parse(stopped.body)).toMatchObject({ outcome: "CANCEL_REQUESTED", workspaceId });
    await finishOperation(handler, db, workspaceId, (task.body.operation as { id: string }).id, "CANCELLED");
    markReady(db, workspaceId);
    const close = await serviceCall(handler, subject, user, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.body).toMatchObject({ outcome: "PREFLIGHT", workspaceId });
    await finishOperation(handler, db, workspaceId, String(close.body.operationId), "SUCCEEDED", { safeToClose: true, repositories: [] });
    expect((await serviceCall(handler, subject, user, "POST", "/v1/service/threads/workspace/close/complete", { requestId: randomUUID(), operationId: close.body.operationId })).body).toMatchObject({ outcome: "CLOSED", workspaceId });
    expect((await lazyEnsureWorkspace(handler, subject, user)).body).toMatchObject({ outcome: "CLOSED", workspaceId });
    expect(db.find((row) => row.entityType === "SLACK_THREAD")).toHaveLength(1);
    expect(db.find((row) => row.entityType === "SLACK_LIMIT").every((row) => row.count === 0)).toBe(true);
  });
  it("does not assign a pre-org legacy row to a different org", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = String((await ensureWorkspace(handler, subject, user)).body.workspaceId);
    const row = legacySlackThread(db, workspaceId);
    const owner = String(db.get(`WORKSPACE#${workspaceId}`, "META")!.ownerKey);
    const table = { documentClient: db, tableName: "state" };
    const before = structuredClone(db.find(() => true));
    expect(await resolveSlackThreadKey(table, "org_bbbbbbbbbbbbbbbbbbbb", owner)).toEqual(slackThreadKey("org_bbbbbbbbbbbbbbbbbbbb", owner));
    expect(await resolveSlackThreadKey(table, TEST_ORG, owner, TEST_ORG)).toEqual({ pk: row.pk, sk: row.sk });
    expect(db.find(() => true)).toEqual(before);
    const foreign = "org_bbbbbbbbbbbbbbbbbbbb";
    const other = createBroker({ extra: { documentClient: db, orgResolver: async () => foreign } });
    db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: foreign });
    await registerSlackProject(other.handler);
    const prior = structuredClone(db.get(`WORKSPACE#${workspaceId}`, "META"));
    const reply = await lazyEnsureWorkspace(other.handler, subject, user);
    expect(reply.body).toMatchObject({ outcome: "WORKSPACE", created: true });
    expect(reply.body.workspaceId).not.toBe(workspaceId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(prior);
    expect(db.get(String(row.pk), String(row.sk))).toEqual(row);

  });
});

it("K1 keeps admin provenance for a pre-org thread", async () => {
  vi.stubEnv("AGENTX_ENV", "staging");
  const { db, handler } = createBroker();
  await registerSlackProject(handler);
  const workspaceId = String((await ensureWorkspace(handler, subject, user)).body.workspaceId);
  legacySlackThread(db, workspaceId);
  const answer = await workspaceOwner({ documentClient: db, tableName: "state", limitDefaults: { member: 3, organization: 20 } }, db.get(`WORKSPACE#${workspaceId}`, "META") as never);
  expect(answer.owner).toMatchObject({ slackUserId: user, slackTeamId: SLACK_TEAM });
});
