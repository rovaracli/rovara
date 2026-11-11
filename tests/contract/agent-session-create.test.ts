// Plan 5 Task 2: a task session is created in the same transaction as the run it wraps. A person's start (the AI-tool route, the app route, the
// Slack start) and `startAgentRun` (an event, a schedule) write the session beside the task; a chain step's task is never a session; a refused start
// leaves nothing; the run's request item remembers the session id, so a repeat answers the same one.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { createTaskSessionItems, sessionStarterFor } from "../../packages/broker/src/agent-sessions/create.js";
import { readRunRequest, runRequestFingerprint, startAgentRun, type AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { recipeDigest } from "@rovara-code/contracts";
import { resolveAgent } from "../../packages/broker/src/agents/store.js";
import { AgentSessionRecordSchema, SESSION_EVENT_TEXT_MAX, SESSION_TITLE_MAX, SessionEventSchema, sessionEventId } from "@rovara-code/contracts";
import { DeveloperTaskViewSchema } from "../../packages/cloud-contracts/src/developer-tasks-node.js";
import { agentSessionKey, liveSessionKey, mySessionsKey, openAgentSessionKey, projectAgentKey, projectMemberKey, projectSessionsKey, runRequestKey, sessionEventSk, sessionLegSk, sessionBindingKey, sessionSurfaceKey } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import { DEV_ISSUER, MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const TRIGGER = "ctr_0123456789abcdefghij";
const ORIGIN = new URL(DEV_ISSUER).origin;
const GITHUB_TOKEN = `ghp_${"a1B2".repeat(9)}`;

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

type Item = Record<string, unknown>;

async function setup(options: { brokerExtra?: Record<string, unknown>; memberLimit?: number } = {}) {
  const h = await createDeveloperTaskBroker({ ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }), brokerExtra: { agents: {}, ...options.brokerExtra } });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const start = async (who: Developer, body: Record<string, unknown>) => {
    const reply = await h.dev(who, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", ...body });
    return { status: reply.status, body: reply.body, task: reply.body.task as Record<string, unknown> & { taskId: string; sessionId?: string; sessionUrl?: string } };
  };
  const starter = () => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no agent run starter");
    return found;
  };
  const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, ...extra,
  });
  const autonomous = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => {
    const { startedBy: _startedBy, ...rest } = request({ origin: "schedule", payer: { kind: "agent", agentId: "rovara-code" }, ...extra }); // eslint-disable-line @typescript-eslint/no-unused-vars -- an autonomous start has none
    return rest;
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as (Item & { sessionId?: string; developerId: string }) | undefined;
  /** Every item of every session partition, and the session's index items. */
  const sessionPartitions = () => h.db.find((item) => typeof item.pk === "string" && item.pk.includes("AGENT_SESSION#"));
  const sessionRecords = () => sessionPartitions().filter((item) => item.sk === "META");
  const indexItems = () => h.db.find((item) => typeof item.pk === "string" && /LIVE_SESSIONS|MY_SESSIONS#|PROJECT_SESSIONS#|OPEN_AGENT_SESSIONS/.test(item.pk));
  const sessionOf = (sessionId: string) => h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Item | undefined;
  /** The Put items of the transaction that wrote the task's META. */
  const startTransaction = (taskId: string): Item[] => {
    const found = h.db.transactions().filter((entries) => entries.some((entry) => (entry.Put as { Item?: Item } | undefined)?.Item?.pk === `DEVTASK#${taskId}` && (entry.Put as { Item: Item }).Item.sk === "META"));
    expect(found, "the task META is written by exactly one transaction").toHaveLength(1);
    return found[0]!.flatMap((entry) => ((entry.Put as { Item?: Item } | undefined)?.Item === undefined ? [] : [(entry.Put as { Item: Item }).Item]));
  };
  /** A custom agent made by Maya, published and (unless told otherwise) not on the payments roster. */
  const agentOf = async (name = `Agent ${randomUUID().slice(0, 8)}`, onRoster = false): Promise<string> => {
    const overlay = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "work", kind: "agent" as const, workspace: "none" as const }] };
    const created = await h.dev(MAYA, "POST", "/v1/app/agents", { requestId: randomUUID(), name, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: string }).agentId as never;
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
    if (onRoster) h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return agentId;
  };
  /** A member of the org with a contributor role on payments. */
  const addMember = async (who: Developer) => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  };
  return { ...h, store, agentOf, addMember, start, starter, request, autonomous, meta, sessionPartitions, sessionRecords, indexItems, sessionOf, startTransaction };
}

describe("a person's start creates its session in the start transaction", () => {
  it("commits the task and its session items together, with the session starting on the task", async () => {
    const t = await setup();
    const started = await t.start(MAYA, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { taskId, sessionId } = started.task;
    expect(sessionId).toMatch(/^ses_[0-9a-z]{20}$/);
    expect(t.meta(taskId)?.sessionId).toBe(sessionId);

    const items = t.startTransaction(taskId);
    const record0 = (all: Item[]) => all.find((item) => item.pk === `DEVTASK#${taskId}` && item.sk === "META")!;
    const sessionItems = items.filter((item) => typeof item.pk === "string" && item.pk.includes(sessionId!));
    const kinds = sessionItems.map((item) => (item.sk as string).split("#")[0]).sort();
    expect(kinds).toEqual(["EVENT", "LEG", "META"]);
    for (const key of [liveSessionKey(TEST_ORG, sessionId!), openAgentSessionKey(TEST_ORG, sessionId!)]) {
      expect(items.some((item) => item.pk === key.pk && item.sk === key.sk), JSON.stringify(key)).toBe(true);
    }
    expect(items.some((item) => item.pk === mySessionsKey(TEST_ORG, MAYA.developerId, record0(items).createdAt as string, sessionId!).pk && item.sessionId === sessionId)).toBe(true);
    expect(items.some((item) => typeof item.pk === "string" && item.pk.includes("PROJECT_SESSIONS#payments"))).toBe(true);

    const record = AgentSessionRecordSchema.parse(strip(t.sessionOf(sessionId!)!));
    expect(record).toMatchObject({
      orgId: TEST_ORG, sessionId, kind: "task", mode: "delegate", subject: { kind: "task", taskId }, where: { kind: "cloud" }, project: "payments",
      agent: { agentId: "rovara-code", name: "Rovara Code" }, owner: { developerId: MAYA.developerId, name: MAYA.name }, startedBy: { kind: "member", developerId: MAYA.developerId },
      origin: "cli", payer: { kind: "member", developerId: MAYA.developerId }, followerCount: 0, summaryRevision: 1, revision: 1,
      summary: { status: "starting", costUsd: 0, needsPeople: [], pendingApprovals: 0 },
    });
    expect(record.legs).toEqual([{ seq: 1, subject: { kind: "task", taskId }, where: { kind: "cloud" }, startedAt: record.createdAt }]);
    expect(record.title).toBe(started.task.title);
    expect(t.sessionPartitions()).toHaveLength(3);
  });

  it("writes the started event with its words and an expiry a year on", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, { title: "Fix retries" });
    const events = t.sessionPartitions().filter((item) => (item.sk as string).startsWith("EVENT#"));
    expect(events).toHaveLength(1);
    const event = SessionEventSchema.parse(strip(events[0]!, ["orgId", "sessionId", "indexExpiresAt"]));
    expect(event).toMatchObject({ type: "started", text: "Maya Chen started Rovara Code: Fix retries", actor: { kind: "member", developerId: MAYA.developerId, name: MAYA.name } });
    expect(event.eventId).toBe(sessionEventId("started", task.sessionId!));
    expect(events[0]!.sk).toBe(sessionEventSk(event.at, event.eventId));
    const days = (Number(events[0]!.indexExpiresAt) - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365);
  });

  it("stores the title redacted, with no mention, and the view's sessionUrl is on the issuer's origin", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, { instructions: `Rotate ${GITHUB_TOKEN} for <@U0MAYA001> now` });
    const record = t.sessionOf(task.sessionId!)!;
    expect(record.title).toContain("[REDACTED]");
    expect(String(record.title)).not.toContain(GITHUB_TOKEN);
    expect(String(record.title)).not.toContain("<@");
    const event = t.sessionPartitions().find((item) => (item.sk as string).startsWith("EVENT#"))!;
    expect(String(event.text)).not.toContain(GITHUB_TOKEN);
    expect(task.sessionUrl).toBe(`${ORIGIN}/app/sessions/${task.sessionId}`);
    expect(DeveloperTaskViewSchema.parse(task).sessionId).toBe(task.sessionId);
  });

  it("indexes the session for the live wall, its owner, its project and the sweep", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    const pks = t.indexItems().map((item) => String(item.pk).replace(`ORG#${TEST_ORG}#`, "").replace(MAYA.developerId, "<maya>")).sort();
    expect(pks).toEqual(["LIVE_SESSIONS", "MY_SESSIONS#<maya>", "OPEN_AGENT_SESSIONS", "PROJECT_SESSIONS#payments"]);
    for (const item of t.indexItems()) expect(item.sessionId ?? item.sk).toContain(task.sessionId);
  });

  it("starts an agent run for another owner with the starter's own entry too", async () => {
    const t = await setup();
    await t.start(MAYA, {});
    await t.addMember(KIT);
    const result = await startAgentRun(t.starter(), t.request({ owner: { developerId: MAYA.developerId }, startedBy: { developerId: KIT.developerId }, payer: { kind: "member", developerId: KIT.developerId } }));
    const sessionId = t.meta(result.taskId)!.sessionId!;
    const mine = t.indexItems().filter((item) => String(item.pk).includes("MY_SESSIONS#") && item.sessionId === sessionId);
    expect(mine.map((item) => item.developerId).sort()).toEqual([KIT.developerId, MAYA.developerId].sort());
    expect(t.sessionOf(sessionId)).toMatchObject({ owner: { developerId: MAYA.developerId }, startedBy: { kind: "member", developerId: KIT.developerId } });
    // M1: the started event names the person who really started the run, and who it is for.
    const event = t.sessionPartitions().find((item) => String(item.pk).includes(sessionId) && String(item.sk).startsWith("EVENT#"))!;
    expect(event.text).toBe(`Kit Alvarez started Rovara Code for Maya Chen: ${String(t.sessionOf(sessionId)!.title)}`);
    expect(event.actor).toEqual({ kind: "member", developerId: KIT.developerId, name: "Kit Alvarez" });
  });
});

describe("a repeated request", () => {
  it("returns the same session and writes nothing new, on the AI-tool route", async () => {
    const t = await setup();
    const requestId = randomUUID();
    const first = await t.start(MAYA, { requestId });
    const before = { items: t.db.items.size, transactions: t.db.transactions().length };
    const again = await t.start(MAYA, { requestId });
    expect(again.task.sessionId).toBe(first.task.sessionId);
    expect(again.task.sessionUrl).toBe(first.task.sessionUrl);
    expect({ items: t.db.items.size, transactions: t.db.transactions().length }).toEqual(before);
    expect(t.sessionRecords()).toHaveLength(1);
  });

  it("remembers the session on the run's request item, and a repeat of startAgentRun starts no second session", async () => {
    const t = await setup();
    const request = t.request();
    const first = await startAgentRun(t.starter(), request);
    const sessionId = t.meta(first.taskId)!.sessionId!;
    expect(t.db.get(runRequestKey(TEST_ORG, request.requestId))).toMatchObject({ taskId: first.taskId, sessionId });
    const stored = await readRunRequest({ documentClient: t.db, tableName: "state", now: Date.now }, TEST_ORG, request.requestId);
    expect(stored?.sessionId).toBe(sessionId);
    expect(stored?.result).toEqual(first);
    const before = t.db.transactions().length;
    expect(await startAgentRun(t.starter(), request)).toEqual(first);
    expect(t.db.transactions().length).toBe(before);
    expect(t.sessionRecords()).toHaveLength(1);
  });

  it("keeps the session of a request that two callers send at once", async () => {
    const t = await setup();
    const request = t.request();
    const [a, b] = await Promise.all([startAgentRun(t.starter(), request), startAgentRun(t.starter(), request)]);
    expect(b).toEqual(a);
    expect(t.sessionRecords()).toHaveLength(1);
    expect(t.sessionRecords()[0]!.sessionId).toBe(t.meta(a.taskId)!.sessionId);
  });
});

describe("the runs that get no session", () => {
  it("creates none for a chain step, whose chain run is the session", async () => {
    const t = await setup();
    const result = await startAgentRun(t.starter(), t.request({ origin: "chain", chain: { chainRunId: "crn_0123456789abcdefghij", stepId: "triage" } }));
    expect(t.meta(result.taskId)?.sessionId).toBeUndefined();
    expect(t.sessionPartitions()).toEqual([]);
    expect(t.indexItems()).toEqual([]);
    expect(t.db.find((item) => item.entityType === "RUN_REQUEST")[0]).not.toHaveProperty("sessionId");
  });

  it("leaves nothing behind when the start is refused", async () => {
    const t = await setup();
    const agentId = await t.agentOf();
    const refusal = await startAgentRun(t.starter(), t.autonomous({ agent: { agentId: agentId }, payer: { kind: "agent", agentId: agentId } })).then(() => undefined, (error: { code?: string }) => error.code);
    expect(refusal).toBe("AGENT_NOT_ON_PROJECT");
    expect(t.sessionPartitions()).toEqual([]);
    expect(t.indexItems()).toEqual([]);
    const person = await t.start(MAYA, { agent: { agentId }, input: { text: "Fix the retry bug" } });
    expect(person.status).toBeGreaterThanOrEqual(400);
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
    expect(t.sessionPartitions()).toEqual([]);
  });

  it("leaves no session when the start is refused for a full workspace limit, and keeps the charge conflict reading its own items", async () => {
    const t = await setup({ memberLimit: 1 });
    expect((await t.start(MAYA, {})).status).toBe(200);
    const second = await t.start(MAYA, {});
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect((second.body.error as { code: string }).code).toBe("WORKSPACE_LIMIT");
    expect(t.sessionRecords()).toHaveLength(1);
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
  });

  it("puts the session items after everything else the start writes, as the last items of its transaction", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    const [entries] = t.db.transactions().filter((transaction) => transaction.some((entry) => (entry.Put as { Item?: Item } | undefined)?.Item?.pk === `DEVTASK#${task.taskId}`));
    const first = entries!.findIndex((entry) => String((entry.Put as { Item?: Item } | undefined)?.Item?.pk).includes("AGENT_SESSION#"));
    expect(first).toBeGreaterThan(0);
    expect(entries!.slice(first).every((entry) => /AGENT_SESSION#|LIVE_SESSIONS|MY_SESSIONS#|PROJECT_SESSIONS#|OPEN_AGENT_SESSIONS/.test(String((entry.Put as { Item?: Item } | undefined)?.Item?.pk)))).toBe(true);
  });

  it("creates none when agents are not set up", async () => {
    const plain = await createDeveloperTaskBroker();
    const reply = await plain.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { sessionId?: string; sessionUrl?: string };
    expect(task.sessionId).toBeUndefined();
    expect(task.sessionUrl).toBeUndefined();
    expect(plain.db.find((item) => typeof item.pk === "string" && item.pk.includes("AGENT_SESSION#"))).toEqual([]);
  });

  it("creates none for an autonomous run that names no trigger, since nothing says who started it", async () => {
    const t = await setup();
    const result = await startAgentRun(t.starter(), t.autonomous());
    expect(t.meta(result.taskId)?.sessionId).toBeUndefined();
    expect(t.sessionPartitions()).toEqual([]);
  });
});

describe("an autonomous run with a trigger", () => {
  it("is started by the schedule, and the owner is whoever the caller passed", async () => {
    const t = await setup();
    const request = t.autonomous({ trigger: { kind: "schedule", triggerId: TRIGGER } });
    const result = await startAgentRun(t.starter(), request);
    const sessionId = t.meta(result.taskId)!.sessionId!;
    expect(sessionId).toMatch(/^ses_/);
    expect(t.sessionOf(sessionId)).toMatchObject({
      startedBy: { kind: "schedule", triggerId: TRIGGER }, owner: { developerId: MAYA.developerId, name: MAYA.name }, origin: "schedule", payer: { kind: "agent", agentId: "rovara-code" },
    });
    const event = t.sessionPartitions().find((item) => (item.sk as string).startsWith("EVENT#"))!;
    expect(event).toMatchObject({ type: "started", actor: { kind: "system" } });
    expect(event.text).toBe(`A schedule started Rovara Code: ${String(t.sessionOf(sessionId)!.title)}`);
    expect(t.db.get(runRequestKey(TEST_ORG, request.requestId))).toMatchObject({ sessionId });
    // The schedule's run is listed for its owner, as an owner's session is.
    expect(t.indexItems().filter((item) => String(item.pk).includes("MY_SESSIONS#"))).toHaveLength(1);
  });

  it("is started by an event when the trigger says so", async () => {
    const t = await setup();
    const result = await startAgentRun(t.starter(), t.autonomous({ origin: "event", trigger: { kind: "event", triggerId: TRIGGER } }));
    const sessionId = t.meta(result.taskId)!.sessionId!;
    expect(t.sessionOf(sessionId)).toMatchObject({ startedBy: { kind: "event", triggerId: TRIGGER }, origin: "event" });
    const event = t.sessionPartitions().find((item) => String(item.sk).startsWith("EVENT#"))!;
    expect(event.text).toBe(`An event started Rovara Code: ${String(t.sessionOf(sessionId)!.title)}`);
  });

  it("refuses a trigger on a run a person started, and a trigger that is not an id, before writing anything", async () => {
    const t = await setup();
    const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);
    expect(await code(startAgentRun(t.starter(), t.request({ trigger: { kind: "schedule", triggerId: TRIGGER } })))).toBe("CONFIG_INVALID");
    expect(await code(startAgentRun(t.starter(), t.autonomous({ trigger: { kind: "schedule", triggerId: "ctr_x#y" } })))).toBe("CONFIG_INVALID");
    expect(await code(startAgentRun(t.starter(), t.autonomous({ trigger: { kind: "cron" as never, triggerId: TRIGGER } })))).toBe("CONFIG_INVALID");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
  });

  it("treats the same request with another trigger as another request, and a request with none as it always was", async () => {
    const t = await setup();
    const request = t.autonomous({ trigger: { kind: "schedule", triggerId: TRIGGER } });
    const first = await startAgentRun(t.starter(), request);
    expect(await startAgentRun(t.starter(), request)).toEqual(first);
    const other = await startAgentRun(t.starter(), { ...request, trigger: { kind: "schedule", triggerId: "ctr_zzzzzzzzzzzzzzzzzzzz" } }).then(() => undefined, (error: { code?: string }) => error.code);
    expect(other).toBe("IDEMPOTENCY_CONFLICT");
    // A request with no trigger keeps the fingerprint it had before triggers existed, so a stored one still matches its repeat.
    const dev = "d".repeat(64);
    expect(runRequestFingerprint({
      requestId: "r", orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
      owner: { developerId: dev }, startedBy: { developerId: dev }, payer: { kind: "member", developerId: dev },
    })).toBe("6ceb7ad10209224fd400aedffbc5436b1cb60d8ef7d552ab527551ecbf87e36e");
  });
});

describe("a task shared to its Slack thread at the start", () => {
  it("binds the session to that thread in the same transaction", async () => {
    const t = await setup();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000031" };
    const started = await t.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const sessionId = t.meta(taskId)!.sessionId!;
    expect(sessionId).toMatch(/^ses_/);
    const items = t.startTransaction(taskId);
    expect(items.some((item) => item.entityType === "SHARED_TASK")).toBe(true);
    const binding = { kind: "slack_thread" as const, ...thread };
    const surface = sessionSurfaceKey(TEST_ORG, binding);
    const bound = items.filter((item) => (item.pk === surface.pk && item.sk === surface.sk) || (item.pk === sessionBindingKey(TEST_ORG, sessionId, "slack_thread").pk && item.sk === "BINDING#slack_thread"));
    expect(bound).toHaveLength(2);
    expect(t.db.get(surface)).toMatchObject({ orgId: TEST_ORG, sessionId, kind: "slack_thread" });
    expect(t.db.get(sessionBindingKey(TEST_ORG, sessionId, "slack_thread"))).toMatchObject({ orgId: TEST_ORG, sessionId, binding });
    expect(items.length).toBeLessThan(100);
  });

  it("binds nothing for a task that is not shared to a thread", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    expect(t.db.find((item) => typeof item.pk === "string" && item.pk.includes("SESSION_SURFACE"))).toEqual([]);
    expect(t.db.find((item) => typeof item.pk === "string" && item.pk.includes("SESSION_BINDING#"))).toEqual([]);
    expect(task.sessionId).toBeDefined();
  });
});

describe("createTaskSessionItems", () => {
  const table = (db: { send: (command: never) => Promise<unknown> }) => ({ documentClient: db as never, tableName: "state", now: () => Date.parse("2026-10-22T09:30:00.000Z") });
  const input = (extra: Record<string, unknown> = {}) => ({
    orgId: TEST_ORG, sessionId: "ses_0123456789abcdefghij", taskId: "5c2f4f0e-2d7e-4a53-9a3c-2f1d0f6f6b11", project: "payments",
    agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 as number | "draft" }, title: "Bump the Stripe SDK",
    owner: { developerId: MAYA.developerId, name: "Maya Chen" }, startedBy: { kind: "member" as const, developerId: MAYA.developerId },
    origin: "app" as const, payer: { kind: "member" as const, developerId: MAYA.developerId }, now: "2026-10-22T09:30:00.000Z", ...extra,
  });
  const fake = { send: async () => ({}) };
  const puts = (items: ReturnType<typeof createTaskSessionItems>) => items.map((item) => (item.Put as { Item: Item; ConditionExpression?: string }));

  it("makes the META, the first leg, the event and the four index entries, each one only if absent", () => {
    const items = puts(createTaskSessionItems(table(fake), input()));
    expect(items).toHaveLength(7);
    for (const put of items) expect(put.ConditionExpression).toBe("attribute_not_exists(pk)");
    const keys = items.map((put) => `${String(put.Item.pk)}|${String(put.Item.sk)}`);
    const id = "ses_0123456789abcdefghij";
    expect(keys).toContain(`${agentSessionKey(TEST_ORG, id, "META").pk}|META`);
    expect(keys).toContain(`${agentSessionKey(TEST_ORG, id, "META").pk}|${sessionLegSk(1)}`);
    expect(keys).toContain(`${liveSessionKey(TEST_ORG, id).pk}|${id}`);
    expect(keys).toContain(`${openAgentSessionKey(TEST_ORG, id).pk}|${openAgentSessionKey(TEST_ORG, id).sk}`);
    expect(keys).toContain(`${projectSessionsKey(TEST_ORG, "payments", "2026-10-22T09:30:00.000Z", id).pk}|${projectSessionsKey(TEST_ORG, "payments", "2026-10-22T09:30:00.000Z", id).sk}`);
    expect(keys).toContain(`${mySessionsKey(TEST_ORG, MAYA.developerId, "2026-10-22T09:30:00.000Z", id).pk}|${mySessionsKey(TEST_ORG, MAYA.developerId, "2026-10-22T09:30:00.000Z", id).sk}`);
    expect(items.every((put) => (put.Item.pk as string) === "OPEN_AGENT_SESSIONS" || (put.Item.pk as string).startsWith(`ORG#${TEST_ORG}#`))).toBe(true);
    // The global open item holds ids and the org only.
    const open = items.find((put) => put.Item.pk === "OPEN_AGENT_SESSIONS")!.Item;
    expect(Object.keys(open).sort()).toEqual(["entityType", "orgId", "pk", "sessionId", "sk"]);
  });

  it("adds the starter's own entry only when the starter is another member", () => {
    expect(createTaskSessionItems(table(fake), input({ startedBy: { kind: "member", developerId: KIT.developerId } }))).toHaveLength(8);
    expect(createTaskSessionItems(table(fake), input({ startedBy: { kind: "schedule", triggerId: TRIGGER } }))).toHaveLength(7);
  });

  it("cuts the title to its limit after redacting it, so a token cut in half can't survive", () => {
    const title = `${"x".repeat(SESSION_TITLE_MAX - 10)} ${GITHUB_TOKEN} tail`;
    const meta = puts(createTaskSessionItems(table(fake), input({ title }))).find((put) => put.Item.sk === "META")!.Item;
    expect(String(meta.title)).not.toContain("ghp_");
    expect([...String(meta.title)].length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    const long = puts(createTaskSessionItems(table(fake), input({ title: "😀".repeat(500) }))).find((put) => put.Item.sk === "META")!.Item;
    expect([...String(long.title)]).toHaveLength(SESSION_TITLE_MAX);
    expect(AgentSessionRecordSchema.safeParse(strip(long)).success).toBe(true);
    const empty = puts(createTaskSessionItems(table(fake), input({ title: "  \u0000 " }))).find((put) => put.Item.sk === "META")!.Item;
    expect(empty.title).toBe("Untitled task");
  });

  it("keeps the event inside its limit whatever the names are", () => {
    const event = puts(createTaskSessionItems(table(fake), input({ title: "t".repeat(300), owner: { developerId: MAYA.developerId, name: "n".repeat(80) } }))).find((put) => String(put.Item.sk).startsWith("EVENT#"))!.Item;
    expect([...String(event.text)].length).toBeLessThanOrEqual(SESSION_EVENT_TEXT_MAX);
    expect(String(event.text)).not.toContain("—");
  });
});

describe("names a start never refuses", () => {
  const table = { documentClient: { send: async () => ({}) } as never, tableName: "state", now: () => Date.parse("2026-10-22T09:30:00.000Z") };
  const make = (ownerName: string, agentName = "Rovara Code") => {
    const items = createTaskSessionItems(table, {
      orgId: TEST_ORG, sessionId: "ses_0123456789abcdefghij", taskId: "5c2f4f0e-2d7e-4a53-9a3c-2f1d0f6f6b11", project: "payments",
      agent: { agentId: "rovara-code", name: agentName, version: 3 }, title: "Bump the Stripe SDK", owner: { developerId: MAYA.developerId, name: ownerName },
      startedBy: { kind: "member", developerId: MAYA.developerId }, origin: "app", payer: { kind: "member", developerId: MAYA.developerId }, now: "2026-10-22T09:30:00.000Z",
    }).map((item) => (item.Put as { Item: Item }).Item);
    const meta = items.find((item) => item.sk === "META")!;
    const event = items.find((item) => String(item.sk).startsWith("EVENT#"))!;
    return { meta, event, record: AgentSessionRecordSchema.parse(Object.fromEntries(Object.entries(meta).filter(([key]) => !["pk", "sk", "entityType"].includes(key)))) };
  };

  it("keeps a ZWJ emoji, a ZWNJ and a flag in a person's name, as they are", () => {
    for (const name of ["Priya \u{1F469}\u200D\u{1F4BB}", "\u0639\u0644\u06CC\u200C\u0631\u0636\u0627", "Sam \u{1F1EC}\u{1F1E7}", "Ana \u2764\uFE0F", "Ana \u2764\uFE0E"]) {
      const made = make(name);
      expect(made.record.owner.name, name).toBe(name);
      expect(String(made.event.text), name).toContain(name);
    }
  });

  it("says someone started a run for the owner when the starter's name can't be read, and names the starter when it can", () => {
    const build = (extra: Record<string, unknown>) => createTaskSessionItems(table, {
      orgId: TEST_ORG, sessionId: "ses_0123456789abcdefghij", taskId: "5c2f4f0e-2d7e-4a53-9a3c-2f1d0f6f6b11", project: "payments",
      agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 }, title: "Bump", owner: { developerId: MAYA.developerId, name: "Maya Chen" },
      startedBy: { kind: "member", developerId: KIT.developerId }, origin: "app", payer: { kind: "member", developerId: KIT.developerId }, now: "2026-10-22T09:30:00.000Z", ...extra,
    }).map((item) => (item.Put as { Item: Item }).Item).find((item) => String(item.sk).startsWith("EVENT#"))!;
    expect(build({})).toMatchObject({ text: "Someone started Rovara Code for Maya Chen: Bump", actor: { kind: "system" } });
    expect(build({ startedByName: "Kit\u202E Alvarez" })).toMatchObject({ text: "Kit Alvarez started Rovara Code for Maya Chen: Bump", actor: { kind: "member", developerId: KIT.developerId, name: "Kit Alvarez" } });
    expect(build({ startedByName: "\u202E" })).toMatchObject({ text: "Someone started Rovara Code for Maya Chen: Bump", actor: { kind: "system" } });
  });

  it("keeps a ZWJ emoji in an agent's name", () => {
    const agent = "Helper \u{1F9D1}\u200D\u{1F527}";
    const made = make("Maya Chen", agent);
    expect(made.record.agent?.name).toBe(agent);
    expect(String(made.event.text)).toContain(agent);
  });

  it("strips bidi, tag and other format characters from names instead of refusing the start", () => {
    // The Scottish flag is a black flag and tag characters; the tags go and the flag stays.
    expect(make("Sam \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}").record.owner.name).toBe("Sam \u{1F3F4}");
    expect(make("Eve \u202Eevil\u202C").record.owner.name).toBe("Eve evil");
    expect(make("Ann\u00ADa\u2060\uFEFF").record.owner.name).toBe("Anna");
    expect(make("Maya Chen", "Bot\u202E 2\u{E0041}").record.agent?.name).toBe("Bot 2");
    expect(make("Line\none\u0000two").record.owner.name).toBe("Line one two");
  });

  it("falls back to a plain name when nothing is left, and never throws on a long one", () => {
    expect(make("\u202E\u200B\u2060").record.owner.name).toBe("Someone");
    expect(make("Maya Chen", "\u202E").record.agent?.name).toBe("rovara-code");
    const long = make("n".repeat(300), "a".repeat(300));
    expect([...long.record.owner.name]).toHaveLength(80);
    expect([...long.record.agent!.name]).toHaveLength(80);
  });

  it("starts a run whose agent's name holds a ZWJ emoji, for a caller whose name does", async () => {
    const t = await setup();
    const agentId = await t.agentOf("Fixer \u{1F9D1}\u200D\u{1F527}", true);
    const started = await t.start(MAYA, { agent: { agentId }, input: { text: "Fix the retry bug" } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(t.sessionOf(started.task.sessionId!)).toMatchObject({ agent: { agentId, name: "Fixer \u{1F9D1}\u200D\u{1F527}" } });
  });
});

describe("who a task session names as its starter", () => {
  const member = { developerId: MAYA.developerId };
  it("is the trigger, else the person who started it, and never a guess", () => {
    expect(sessionStarterFor({ trigger: { kind: "schedule", triggerId: TRIGGER }, startedBy: undefined, chain: undefined })).toEqual({ kind: "schedule", triggerId: TRIGGER });
    expect(sessionStarterFor({ trigger: { kind: "event", triggerId: TRIGGER }, startedBy: undefined, chain: undefined })).toEqual({ kind: "event", triggerId: TRIGGER });
    expect(sessionStarterFor({ trigger: undefined, startedBy: member, chain: undefined })).toEqual({ kind: "member", developerId: MAYA.developerId });
  });

  it("is nothing for a run no one and no trigger started, and for a chain step, so a lazy creation skips them instead of throwing", () => {
    expect(sessionStarterFor({ trigger: undefined, startedBy: undefined, chain: undefined })).toBeUndefined();
    expect(sessionStarterFor({ trigger: undefined, startedBy: member, chain: { chainRunId: "crn_0123456789abcdefghij", stepId: "triage" } })).toBeUndefined();
    expect(sessionStarterFor({ trigger: { kind: "schedule", triggerId: TRIGGER }, startedBy: undefined, chain: { chainRunId: "crn_0123456789abcdefghij", stepId: "x" } })).toBeUndefined();
  });
});

describe("AgentSessionStore", () => {
  it("reads a session of its own org and nothing of another's", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    const store = new AgentSessionStore({ documentClient: t.db, tableName: "state", now: Date.now });
    expect((await store.get(TEST_ORG, task.sessionId!))?.sessionId).toBe(task.sessionId);
    expect(await store.get(ORG_B, task.sessionId!)).toBeUndefined();
    // An item under this org's key that says it belongs to another org is not read.
    t.db.set({ ...t.sessionOf(task.sessionId!)!, orgId: ORG_B });
    expect(await store.get(TEST_ORG, task.sessionId!)).toBeUndefined();
    expect(await store.get(TEST_ORG, "ses_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
  });

  it("finds a task's session by its sessionId, re-checking the org and the subject, and a chain step's through its chain run", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    const store = new AgentSessionStore({ documentClient: t.db, tableName: "state", now: Date.now });
    const record = t.meta(task.taskId)! as unknown as { orgId: OrgId; taskId: string; sessionId?: string };
    expect((await store.getForTask(TEST_ORG, record))?.sessionId).toBe(task.sessionId);
    expect(await store.getForTask(ORG_B, record)).toBeUndefined();
    expect(await store.getForTask(TEST_ORG, { ...record, orgId: ORG_B })).toBeUndefined();
    expect(await store.getForTask(TEST_ORG, { ...record, taskId: randomUUID() })).toBeUndefined();
    expect(await store.getForTask(TEST_ORG, { taskId: record.taskId, orgId: TEST_ORG })).toBeUndefined();
    // A chain run is its own session (Task 3 writes it); the step's task finds it through `chain`.
    const chainRunId = "crn_0123456789abcdefghij";
    t.db.set({ ...agentSessionKey(TEST_ORG, chainRunId, "META"), entityType: "AGENT_SESSION", ...chainRecord(chainRunId) });
    const step = { taskId: randomUUID(), orgId: TEST_ORG, chain: { chainRunId, stepId: "triage" } };
    expect((await store.getForTask(TEST_ORG, step))?.sessionId).toBe(chainRunId);
    expect(await store.getForTask(TEST_ORG, { ...step, chain: { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "x" } })).toBeUndefined();
    // A session at the chain run's id whose subject is something else is not the chain's session.
    const other = "crn_bbbbbbbbbbbbbbbbbbbb";
    t.db.set({ ...agentSessionKey(TEST_ORG, other, "META"), entityType: "AGENT_SESSION", ...chainRecord(other), kind: "task", subject: { kind: "task", taskId: randomUUID() } });
    expect(await store.getForTask(TEST_ORG, { ...step, chain: { chainRunId: other, stepId: "x" } })).toBeUndefined();
  });

  it("refuses a record that doesn't parse, instead of reading it", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    t.db.set({ ...t.sessionOf(task.sessionId!)!, surprise: true });
    const store = new AgentSessionStore({ documentClient: t.db, tableName: "state", now: Date.now });
    await expect(store.get(TEST_ORG, task.sessionId!)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("appends an event once: the same event twice is one item, and another writer's event doesn't conflict", async () => {
    const t = await setup();
    const { task } = await t.start(MAYA, {});
    const store = new AgentSessionStore({ documentClient: t.db, tableName: "state", now: () => Date.parse("2026-10-22T10:00:00.000Z") });
    const at = "2026-10-22T10:00:00.000Z";
    const comment = { eventId: sessionEventId("comment", "msg_0123456789abcdefghij"), at, type: "comment" as const, text: `Use ${GITHUB_TOKEN}` };
    expect(await store.appendEvent(TEST_ORG, task.sessionId!, comment)).toBe("appended");
    expect(await store.appendEvent(TEST_ORG, task.sessionId!, comment)).toBe("exists");
    const status = { eventId: sessionEventId("status", "run-1"), at, type: "status" as const, text: "Running" };
    expect(await store.appendEvent(TEST_ORG, task.sessionId!, status)).toBe("appended");
    const events = t.sessionPartitions().filter((item) => (item.sk as string).startsWith("EVENT#"));
    expect(events).toHaveLength(3);
    expect(String(events.find((item) => item.type === "comment")!.text)).not.toContain(GITHUB_TOKEN);
  });

  it("makes an event item that is a conditional put of its own key, with the text cut and an expiry", () => {
    const at = "2026-10-22T10:00:00.000Z";
    const store = new AgentSessionStore({ documentClient: { send: async () => ({}) }, tableName: "state", now: () => Date.parse(at) });
    const item = store.sessionEventItem({ orgId: TEST_ORG, sessionId: "ses_0123456789abcdefghij" }, { eventId: sessionEventId("step", "a"), at, type: "step", text: "s".repeat(900) });
    const put = item.Put as { Item: Item; ConditionExpression: string };
    expect(put.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(put.Item.sk).toBe(sessionEventSk(at, sessionEventId("step", "a")));
    expect([...String(put.Item.text)]).toHaveLength(SESSION_EVENT_TEXT_MAX);
    expect(put.Item.indexExpiresAt).toBe(Math.floor(Date.parse(at) / 1000) + 365 * 86_400);
  });
});

// ---- helpers

function strip(item: Item, extra: string[] = []): Item {
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key attributes are dropped
  for (const key of extra) delete rest[key];
  return rest;
}

function chainRecord(chainRunId: string): Item {
  return {
    orgId: TEST_ORG, sessionId: chainRunId, kind: "chain", mode: "delegate", subject: { kind: "chain", chainRunId }, legs: [], where: { kind: "cloud" }, title: "A chain", owner: { developerId: MAYA.developerId, name: MAYA.name },
    startedBy: { kind: "member", developerId: MAYA.developerId }, origin: "app", followerCount: 0, summaryRevision: 1, revision: 1, createdAt: "2026-10-22T09:30:00.000Z", updatedAt: "2026-10-22T09:30:00.000Z",
    summary: { status: "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: createHash("sha256").update("x").digest("hex"), computedAt: "2026-10-22T09:30:00.000Z" },
  };
}
