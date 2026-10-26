import { slackTeamOrgKey } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveSlackThreadKey, slackThreadKey } from "../../packages/broker/src/aws/slack-thread-key.js";
import { workspaceOwner } from "../../packages/broker/src/aws/admin-reads.js";
import { legacySlackThread } from "../support/legacy-slack-thread.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_TEAM, SLACK_CHANNEL, createBroker, ensureWorkspace, finishOperation, lazyEnsureWorkspace, loadSlackBroker, markReady, prepareThread, registerSlackProject, serviceCall } from "../support/slack-broker.js";

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
  const answer = await workspaceOwner({ documentClient: db, tableName: "state", limitDefaults: { member: 3, organization: 20 }, now: Date.now, log: () => undefined }, db.get(`WORKSPACE#${workspaceId}`, "META") as never);
  expect(answer.owner).toMatchObject({ slackUserId: user, slackTeamId: SLACK_TEAM });
});

describe("I2: scoped thread rows cannot confer workspace authority", () => {
  it.each(["org", "owner"] as const)("refuses prepare/close for a scoped mapping with a foreign %s", async (field) => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const own = String((await lazyEnsureWorkspace(handler, subject, user)).body.workspaceId);
    const workspace = db.get(`WORKSPACE#${own}`, "META")!;
    const foreignId = randomUUID();
    const foreign = { ...workspace, pk: `WORKSPACE#${foreignId}`, id: foreignId, ...(field === "org" ? { orgId: "org_bbbbbbbbbbbbbbbbbbbb" } : { ownerKey: "f".repeat(64) }) };
    db.set(foreign);
    const row = db.find((item) => item.entityType === "SLACK_THREAD" && item.workspaceId === own)[0]!;
    db.set({ ...row, workspaceId: foreignId });
    for (const item of db.find((item) => item.entityType === "DEFAULT_WORKSPACE")) db.delete({ pk: String(item.pk), sk: String(item.sk) });
    const data = structuredClone(db.find(() => true));
    const before = db.commandNames().length;
    expect(await prepareThread(handler, subject, user)).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect((await serviceCall(handler, subject, user, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() })).body).toEqual({ outcome: "NOT_FOUND", requestId: expect.any(String) as unknown });
    expect(db.commandNames().slice(before).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
    expect(db.find(() => true)).toEqual(data);
    // Restoring this same mapping to its own workspace admits preparation, rather than a blanket refusal.
    db.set(row);
    expect((await prepareThread(handler, subject, user)).body).toMatchObject({ outcome: "WORKSPACE", workspaceId: own });
    expect(db.get(`WORKSPACE#${foreignId}`, "META")).toEqual(foreign);
  });
  it.each(["org", "owner"] as const)("refuses Slack stop when a scoped mapping names a foreign %s", async (field) => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = String((await ensureWorkspace(handler, subject, user)).body.workspaceId);
    markReady(db, workspaceId);
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    db.set({ ...workspace, ...(field === "org" ? { orgId: "org_bbbbbbbbbbbbbbbbbbbb" } : { ownerKey: "f".repeat(64) }) });
    const data = structuredClone(db.find(() => true));
    const before = db.commandNames().length;
    const reply = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, userId: user });
    expect(reply.statusCode).toBe(403);
    expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(db.commandNames().slice(before).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
    expect(db.find(() => true)).toEqual(data);
  });
});

// C43 c (Task 24 re-check): a workspace record written before records named their org belongs to the install's single org, and only to it. `getThreadWorkspace` (prepare, close) and
// `stopSlackThreadTask` both rest on that fallback.
describe("K1: the install-org fallback for a workspace record with no org", () => {
  const foreign = "org_bbbbbbbbbbbbbbbbbbbb";
  const withoutOrg = (db: ReturnType<typeof createBroker>["db"], workspaceId: string) => {
    const workspace = { ...db.get(`WORKSPACE#${workspaceId}`, "META")! };
    delete workspace.orgId;
    db.set(workspace);
    return workspace;
  };
  const stop = (handler: ReturnType<typeof createBroker>["handler"]) =>
    handler({ source: "agentx.slack-ingress", action: "stop-task", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, userId: user });
  /** The install org's thread row and workspace, moved under another org's scope: that org's Slack team now finds a workspace that carries no org. */
  async function movedToForeignOrg() {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = String((await ensureWorkspace(handler, subject, user)).body.workspaceId);
    markReady(db, workspaceId);
    const workspace = withoutOrg(db, workspaceId);
    const row = db.find((item) => item.entityType === "SLACK_THREAD" && item.workspaceId === workspaceId)[0]!;
    db.set({ ...row, ...slackThreadKey(foreign, String(workspace.ownerKey)), orgId: foreign });
    db.delete({ pk: String(row.pk), sk: String(row.sk) });
    for (const item of db.find((entry) => entry.entityType === "DEFAULT_WORKSPACE")) db.delete({ pk: String(item.pk), sk: String(item.sk) });
    db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: foreign });
    const other = createBroker({ extra: { documentClient: db, orgResolver: async () => foreign } });
    await registerSlackProject(other.handler);
    return { db, other, workspaceId };
  }

  it("stop: a workspace with no org record is the install org's, so the install org's team can stop it", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = String((await ensureWorkspace(handler, subject, user)).body.workspaceId);
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, subject, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const task = await serviceCall(handler, subject, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "synthetic work" });
    expect(task.status).toBe(202);
    withoutOrg(db, workspaceId);
    const reply = await stop(handler);
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ outcome: "CANCEL_REQUESTED", workspaceId });
  });

  it("stop: the same workspace is refused for any other org's team, and nothing is written", async () => {
    const { db, other } = await movedToForeignOrg();
    const data = structuredClone(db.find(() => true));
    const before = db.commandNames().length;
    const reply = await stop(other.handler);
    expect(reply.statusCode).toBe(403);
    expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(db.commandNames().slice(before).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
    expect(db.find(() => true)).toEqual(data);
  });

  it("prepare and close: a thread row under another org does not find the install org's no-org workspace", async () => {
    const { db, other } = await movedToForeignOrg();
    const data = structuredClone(db.find(() => true));
    const before = db.commandNames().length;
    expect(await prepareThread(other.handler, subject, user)).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect((await serviceCall(other.handler, subject, user, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() })).body).toEqual({ outcome: "NOT_FOUND", requestId: expect.any(String) as unknown });
    expect(db.commandNames().slice(before).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
    expect(db.find(() => true)).toEqual(data);
  });

  it("prepare: the install org's team still finds its no-org workspace", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = String((await lazyEnsureWorkspace(handler, subject, user)).body.workspaceId);
    withoutOrg(db, workspaceId);
    expect((await prepareThread(handler, subject, user)).body).toMatchObject({ outcome: "WORKSPACE", workspaceId });
  });
});
