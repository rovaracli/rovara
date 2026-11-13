// Convergence S0 WIRING: the root's realtime publisher, MergePeople from Cloud's member directory, the end of a core task on close and on merge, Cloud's ChannelWork and
// Slack intake, and the CHANNEL_TENANTS backfill as a data move. Everything here stays behind CLOUD_CORE_ENGINE: the module list adds nothing unless asked for.
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { readTaskThread } from "@rovara-code/broker/core/channel";
import { taskSessionId } from "@rovara-code/broker/core/sessions";
import { orgMemberKey } from "@agentx/cloud-contracts";
import type { ChannelDecision, InboundMessage, Principal, RealtimeBatch, RealtimePublisher } from "@rovara-code/contracts";
import {
  PAGE_NOTICE_TYPES, cloudAdapterModules, cloudPageNotices, coreTaskEndWiring, createCloudChannelWork, createCloudMergePeople, createSlackIntake, requestIdOf, slackSwitchReadiness,
  tenantsBackfillPending, type CloudModuleDeps,
} from "../../packages/broker/src/cloud/app/index.js";
import { channelTenantsBackfill, memoryResume, runDataMove, type MoveContext } from "../../packages/broker/src/cloud/migrations/index.js";
import { tenantRowKey } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { AppSyncEventsPublisher } from "../../packages/broker/src/cloud-adapters/realtime-appsync/publisher.js";
import { linkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const MAYA = "a".repeat(64);
const PRIYA = "b".repeat(64);
const AUDITOR = "c".repeat(64);

describe("WIRING: the realtime publisher speaks Cloud's pages' vocabulary", () => {
  const recording = (): RealtimePublisher & { batches: RealtimeBatch[] } => {
    const batches: RealtimeBatch[] = [];
    return { batches, capabilities: { remoteListeners: true, entriesPerRequest: 5 }, async publish(batch) { batches.push(batch); return { sent: batch.entries.length, failed: 0 }; } };
  };
  const person = { kind: "person", personId: MAYA } as const;
  const entry = (type: string, extra: Record<string, string | number> = {}) => ({ audience: person, notice: { type, ...extra } });

  it("the pages understand exactly four notices", () => {
    expect([...PAGE_NOTICE_TYPES].sort()).toEqual(["device.command", "home.changed", "session.event", "session.updated"]);
  });

  it("passes what the pages know and does not send the core's own attention.changed, which counts as sent", async () => {
    const inner = recording();
    const result = await cloudPageNotices(inner).publish({ companyId: ORG, entries: [entry("session.updated", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 3 }), entry("attention.changed", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "needs_you" }), entry("home.changed", { revision: 4 })] });
    expect(inner.batches[0]?.entries.map((e) => e.notice.type)).toEqual(["session.updated", "home.changed"]);
    expect(result).toEqual({ sent: 3, failed: 0 });
  });

  it("a batch of nothing the pages know never reaches the events service", async () => {
    const inner = recording();
    expect(await cloudPageNotices(inner).publish({ companyId: ORG, entries: [entry("attention.changed", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "done" })] })).toEqual({ sent: 1, failed: 0 });
    expect(inner.batches).toEqual([]);
  });

  it("a failure of the events service is still counted as failed, and what was dropped is not", async () => {
    const failing: RealtimePublisher = { capabilities: { remoteListeners: true, entriesPerRequest: 5 }, publish: async (batch) => ({ sent: 0, failed: batch.entries.length }) };
    expect(await cloudPageNotices(failing).publish({ companyId: ORG, entries: [entry("home.changed", { revision: 1 }), entry("attention.changed", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "failed" })] })).toEqual({ sent: 1, failed: 1 });
  });

  it("over A8's real publisher only the known notice is posted, on the person's channel", async () => {
    const posts: Array<{ channel: string; events: string[] }> = [];
    const fetched: typeof fetch = async (_url, init) => { posts.push(JSON.parse(String(init?.body as string)) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); };
    const publisher = cloudPageNotices(new AppSyncEventsPublisher({ endpoint: "https://abc.appsync-api.us-west-2.amazonaws.com/event", credentials: async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }), fetch: fetched }));
    await publisher.publish({ companyId: ORG, entries: [entry("home.changed", { revision: 2 }), entry("attention.changed", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "done" })] });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events.map((e) => (JSON.parse(e) as { type: string }).type)).toEqual(["home.changed"]);
    expect(posts[0]!.channel.startsWith("/rovara/o-aaaaaaaaaaaaaaaaaaaa/u/")).toBe(true);
  });
});

describe("WIRING: the module list adds nothing unless asked for", () => {
  const base = { tableName: "state" } as unknown as CloudModuleDeps;
  const points = (deps: CloudModuleDeps) => cloudAdapterModules(deps).map((module) => `${module.point}/${module.name}`);

  it("no realtime and no Slack by default", () => {
    expect(points(base).filter((name) => name.startsWith("realtime") || name.startsWith("channel"))).toEqual([]);
  });

  it("the realtime adapter is there once the events service is given", () => {
    expect(points({ ...base, realtime: { endpoint: "https://abc.appsync-api.us-west-2.amazonaws.com/event", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }) } })).toContain("realtime/appsync");
  });

  it("the Slack channel is registered only when the readiness facts say ready", () => {
    const options = { projects: ["payments"], botToken: async () => "x", serves: async () => true } as never;
    const notReady = { options, facts: { tenantsBackfillPending: 2, bindWritesTenants: true, inboundWired: true } };
    const ready = { options, facts: { tenantsBackfillPending: 0, bindWritesTenants: true, inboundWired: true } };
    expect(points({ ...base, slack: notReady })).not.toContain("channel/slack");
    expect(points({ ...base, slack: ready })).toContain("channel/slack");
    expect(slackSwitchReadiness(notReady.facts).blockers).toEqual(["the CHANNEL_TENANTS backfill would still move 2 rows"]);
  });
});

describe("WIRING: MergePeople from Cloud's member directory", () => {
  async function directory(): Promise<ReturnType<typeof createCloudMergePeople>> {
    const db = new FakeDynamoDb();
    const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-12T10:00:00.000Z") };
    db.set({ ...orgMemberKey(ORG, MAYA), role: "owner" });
    db.set({ ...orgMemberKey(ORG, PRIYA), role: "member" });
    db.set({ ...orgMemberKey(ORG, AUDITOR), role: "auditor" });
    await linkGithubMember(deps, ORG, MAYA, "1001");
    await linkGithubMember(deps, ORG, PRIYA, "1002");
    await linkGithubMember(deps, ORG, AUDITOR, "1003");
    return createCloudMergePeople(deps);
  }
  const task = (over: Record<string, unknown> = {}) => ({ taskId: "t", project: "p", startingRevision: 1, workspaceId: "w", ownerId: MAYA, ownerName: "Maya", creatorId: MAYA, ...over }) as never;

  it("a linked writer counts, an Auditor's account counts for nothing, an unlinked account is nobody", async () => {
    const people = await directory();
    expect(await people.linkedAmong(ORG, ["1001", "1002", "1003", "9999"])).toEqual(new Set(["1001", "1002"]));
    expect(await people.nonWritersAmong(ORG, ["1001", "1003", "9999"])).toEqual(new Set(["1003"]));
  });

  it("the requesters are the creator, the starter and the owner, or unlinked when any has no account", async () => {
    const people = await directory();
    expect(await people.requestersOf(ORG, task())).toEqual(["1001"]);
    expect(await people.requestersOf(ORG, task({ startedBy: { developerId: PRIYA } }))).toEqual(["1001", "1002"]);
    expect(await people.requestersOf(ORG, task({ startedBy: { developerId: "d".repeat(64) } }))).toBe("unlinked");
  });

  it("a person's account, and another company's link is nobody's", async () => {
    const people = await directory();
    expect(await people.hostAccountOf(ORG, PRIYA)).toBe("1002");
    expect(await people.hostAccountsOf?.(ORG, PRIYA)).toEqual(["1002"]);
    expect(await people.hostAccountOf(ORG, "e".repeat(64))).toBeUndefined();
    expect(await people.linkedAmong(OTHER, ["1001"])).toEqual(new Set());
  });
});

describe("WIRING: a core task's end reaches Cloud's end handlers on close and on merge", () => {
  const record = { taskId: "t1", companyId: ORG, project: "payments" };
  function wiring() {
    const told: Array<[string, string]> = [];
    const wired = coreTaskEndWiring({ readTask: async () => record, onTaskEnded: async (task, outcome) => { told.push([String(task["taskId"]), outcome]); } });
    return { wired, told };
  }

  it("a close records the end as closed", async () => {
    const { wired, told } = wiring();
    await wired.onClose({ orgId: ORG, taskId: "t1" });
    expect(told).toEqual([["t1", "closed"]]);
  });

  it("a merged milestone records the end as merged, and any other milestone does nothing", async () => {
    const { wired, told } = wiring();
    const milestone = (kind: string) => ({ kind, orgId: ORG, taskId: "t1", at: "2026-11-12T10:00:00.000Z", text: "x" }) as never;
    await wired.onMerged.on(milestone("pr_ready"));
    await wired.onMerged.on(milestone("approved"));
    expect(told).toEqual([]);
    await wired.onMerged.on(milestone("merged"));
    expect(told).toEqual([["t1", "merged"]]);
    expect(wired.onMerged.name).toMatch(/^[a-z0-9_]+$/u);
  });

  it("a merge and then the close both reach Cloud's bookkeeping, which keeps the first end (its own once-only rule)", async () => {
    const { wired, told } = wiring();
    await wired.onMerged.on({ kind: "merged", orgId: ORG, taskId: "t1", at: "2026-11-12T10:00:00.000Z", text: "x" } as never);
    await wired.onClose({ orgId: ORG, taskId: "t1" });
    expect(told.map(([, outcome]) => outcome)).toEqual(["merged", "closed"]);
  });

  it("the milestone handler registers with the core's milestones once", async () => {
    const { createDocumentMilestones } = await import("@rovara-code/broker/core/milestones");
    const store = new MemoryDocumentStore();
    const milestones = createDocumentMilestones({ store, now: () => Date.now() });
    const { wired } = wiring();
    const off = milestones.register(wired.onMerged);
    expect(() => milestones.register(wired.onMerged)).toThrow(/already registered/u);
    off();
  });
});

describe("WIRING: Cloud's ChannelWork and the Slack intake", () => {
  const principal = (id: string): Principal => ({ companyId: ORG, personId: id, displayName: "Maya", roles: ["owner"], provider: "slack", methods: ["slack"] });
  const conversation = { channel: "slack", tenant: "T0TEAM", space: "C0CHAN", thread: "1695500000.000001" };
  const inbound = (text: string, eventId = "Ev1"): InboundMessage => ({ eventId, actor: { channel: "slack", tenant: "T0TEAM", userId: "U0MAYA" }, conversation, text }) as unknown as InboundMessage;

  function work(known: string[] = [MAYA]) {
    const starts: Array<{ caller: { principal: Principal; client: string }; request: Record<string, unknown> }> = [];
    const store = new MemoryDocumentStore();
    const gate = { decide: vi.fn(async (): Promise<{ status: string; reason?: string }> => ({ status: "decided" })) };
    const w = createCloudChannelWork({
      store, now: () => Date.parse("2026-11-12T10:00:00.000Z"), gate,
      start: async (caller, request) => { starts.push({ caller, request }); return { task: { taskId: "11111111-1111-4111-8111-111111111111" } }; },
      principalOf: async (_org, personId) => (known.includes(personId) ? principal(personId) : undefined),
    });
    return { w, starts, store, gate };
  }

  it("a message starts a task as the person, with the thread remembered", async () => {
    const { w, starts, store } = work();
    await w.message({ orgId: ORG, message: inbound("Add a greet function"), projectName: "payments", personId: MAYA });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.caller).toMatchObject({ client: "slack", principal: { personId: MAYA } });
    expect(starts[0]!.request).toMatchObject({ project: "payments", instructions: "Add a greet function", workflow: true });
    expect(starts[0]!.request).not.toHaveProperty("workflowPath");
    expect(await readTaskThread(store, ORG as never, taskSessionId("11111111-1111-4111-8111-111111111111"))).toEqual({ conversation, personId: MAYA });
  });

  it("quick: and full: choose the path and are not part of the instructions", async () => {
    const { w, starts } = work();
    await w.message({ orgId: ORG, message: inbound("quick: fix it", "Ev2"), projectName: "payments", personId: MAYA });
    await w.message({ orgId: ORG, message: inbound("Full: build it", "Ev3"), projectName: "payments", personId: MAYA });
    expect(starts.map((s) => [s.request["workflowPath"], s.request["instructions"]])).toEqual([["QUICK", "fix it"], ["FULL", "build it"]]);
  });

  it("the same Slack event always asks for the same start, so a redelivery starts nothing new", async () => {
    const { w, starts } = work();
    await w.message({ orgId: ORG, message: inbound("hello", "EvSame"), projectName: "payments", personId: MAYA });
    await w.message({ orgId: ORG, message: inbound("hello", "EvSame"), projectName: "payments", personId: MAYA });
    expect(starts[0]!.request["requestId"]).toBe(starts[1]!.request["requestId"]);
    expect(starts[0]!.request["requestId"]).toBe(requestIdOf("slack/EvSame"));
    expect(requestIdOf("slack/EvOther")).not.toBe(requestIdOf("slack/EvSame"));
    expect(requestIdOf("slack/x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("a person who is not of the company starts nothing", async () => {
    const { w, starts } = work([]);
    await w.message({ orgId: ORG, message: inbound("hello"), projectName: "payments", personId: MAYA });
    expect(starts).toEqual([]);
  });

  const card = { subject: { type: "plan_approval", id: "t1" }, requestId: "req-1", revision: 2, artifactDigest: "d".repeat(64) } as never;
  const decision = (value: string): ChannelDecision => ({ eventId: "EvD", actor: { channel: "slack", tenant: "T0TEAM", userId: "U0MAYA" }, decision: value, reason: "fine" }) as unknown as ChannelDecision;

  it("a decision goes to the gate with the Slack chat credential, bound to what the card showed", async () => {
    const { w, gate } = work();
    expect(await w.decide({ orgId: ORG, card, decision: decision("APPROVE"), personId: MAYA, projectName: "payments" })).toEqual({ status: "decided" });
    expect(gate.decide).toHaveBeenCalledWith(expect.objectContaining({
      companyId: ORG, kind: "plan_approval", subjectId: "t1", requestId: "req-1", outcome: "approve", seen: { revision: 2, artifactDigest: "d".repeat(64) },
      credentials: [{ method: "chat-slack", token: "EvD", claimedAccount: { provider: "slack", tenant: "T0TEAM", accountId: "U0MAYA" } }],
    }));
  });

  it("the gate's refusal is the answer, and a skip or a stranger never reaches the gate", async () => {
    const { w, gate } = work();
    gate.decide.mockResolvedValueOnce({ status: "refused", reason: "step_up" });
    expect(await w.decide({ orgId: ORG, card, decision: decision("REJECT"), personId: MAYA, projectName: "payments" })).toEqual({ status: "refused", reason: "step_up" });
    expect(await w.decide({ orgId: ORG, card, decision: decision("SKIP"), personId: MAYA, projectName: "payments" })).toEqual({ status: "refused", reason: "invalid" });
    const stranger = work([]);
    expect(await stranger.w.decide({ orgId: ORG, card, decision: decision("APPROVE"), personId: MAYA, projectName: "payments" })).toEqual({ status: "refused", reason: "invalid" });
    expect(stranger.gate.decide).not.toHaveBeenCalled();
  });

  it("the intake turns a queued Slack request into the sink's message and lets the sink's error through, so the queue retries", async () => {
    const seen: InboundMessage[] = [];
    const intake = createSlackIntake({ message: async (message) => { seen.push(message); } });
    await intake({ version: 1, eventId: "EvQ", thread: { teamId: "T0TEAM", channelId: "C0CHAN", threadTs: "1695500000.000001" }, userId: "U0MAYA", text: "hello", receivedAt: "2026-11-12T10:00:00.000Z" } as never);
    expect(seen[0]).toMatchObject({ eventId: "EvQ", text: "hello" });
    const failing = createSlackIntake({ message: async () => { throw new Error("later"); } });
    await expect(failing({ version: 1, eventId: "EvQ2", thread: { teamId: "T0TEAM", channelId: "C0CHAN", threadTs: "1695500000.000002" }, userId: "U0MAYA", text: "x", receivedAt: "2026-11-12T10:00:00.000Z" } as never)).rejects.toThrow("later");
  });
});

describe("WIRING: the CHANNEL_TENANTS backfill is a data move with a dry run", () => {
  const binding = (org: string, team: string, channel: string) => ({ pk: `ORG#${org}#SLACK_BINDING#${team}`, sk: `CHANNEL#${channel}`, entityType: "SLACK_BINDING", teamId: team, channelId: channel, projectName: "payments" });
  const NOW = new Date("2026-11-12T10:00:00.000Z");

  async function world() {
    const store = new MemoryDocumentStore();
    for (const row of [binding(ORG, "T0AAA", "C1"), binding(ORG, "T0AAA", "C2"), binding(OTHER, "T0BBB", "C3")]) await store.put({ item: row });
    // Code's own bind already wrote one row: it is never touched.
    await store.put({ item: { ...tenantRowKey(OTHER, "T0BBB"), entityType: "CHANNEL_TENANT", channel: "slack", tenant: "T0BBB" } });
    const context: MoveContext = { store, now: () => NOW, log: () => undefined };
    const rows = async (filter: (row: Record<string, unknown>) => boolean) => ({ items: (await store.query({ pk: "ORG#" + ORG + "#SLACK_BINDING#T0AAA" })).items.concat((await store.query({ pk: "ORG#" + OTHER + "#SLACK_BINDING#T0BBB" })).items).filter(filter) });
    const move = channelTenantsBackfill({
      scanBindings: async () => rows((row) => typeof row["sk"] === "string" && row["sk"].startsWith("CHANNEL#")),
      scanMarked: async () => ({ items: (await store.query({ pk: `ORG#${ORG}#CHANNEL_TENANTS` })).items.concat((await store.query({ pk: `ORG#${OTHER}#CHANNEL_TENANTS` })).items) }),
    });
    return { store, context, move };
  }

  it("a dry run writes nothing and says what an apply would do: one row per workspace that has none", async () => {
    const { store, context, move } = await world();
    const report = await runDataMove(move, context, { direction: "forward" });
    // Two bound channels of T0AAA: a dry run writes nothing, so it counts the workspace once per binding (an upper bound, zero when nothing is left).
    expect(report).toMatchObject({ mode: "dry-run", scanned: 3, writes: 2, done: true });
    expect(await store.get(tenantRowKey(ORG, "T0AAA"))).toBeUndefined();
    expect(await tenantsBackfillPending(move, context)).toBe(2);
  });

  it("an apply writes the missing row once, leaves Code's own row alone, and a second apply writes nothing", async () => {
    const { store, context, move } = await world();
    const resume = memoryResume();
    expect(await runDataMove(move, context, { direction: "forward", apply: true, resume })).toMatchObject({ mode: "apply", writes: 1 });
    expect(await store.get(tenantRowKey(ORG, "T0AAA"))).toMatchObject({ backfilledBy: "a8-slack-tenants", tenant: "T0AAA" });
    expect((await store.get(tenantRowKey(OTHER, "T0BBB")))?.["backfilledBy"]).toBeUndefined();
    expect(await runDataMove(move, context, { direction: "forward", apply: true })).toMatchObject({ writes: 0 });
    expect(await tenantsBackfillPending(move, context)).toBe(0);
  });

  it("readiness follows the dry run: not ready while rows would move, ready after", async () => {
    const { context, move } = await world();
    const facts = async () => ({ tenantsBackfillPending: await tenantsBackfillPending(move, context), bindWritesTenants: true, inboundWired: true });
    expect(slackSwitchReadiness(await facts()).ready).toBe(false);
    await runDataMove(move, context, { direction: "forward", apply: true });
    expect(slackSwitchReadiness(await facts()).ready).toBe(true);
  });

  it("a row that lost its mark since the scan is kept, never deleted", async () => {
    const { store, context } = await world();
    await store.put({ item: { ...tenantRowKey(ORG, "T0AAA"), entityType: "CHANNEL_TENANT", channel: "slack", tenant: "T0AAA" } });
    const stale = channelTenantsBackfill({ scanBindings: async () => ({ items: [] }), scanMarked: async () => ({ items: [{ ...tenantRowKey(ORG, "T0AAA"), backfilledBy: "a8-slack-tenants" }] }) });
    expect(await runDataMove(stale, context, { direction: "reverse", apply: true })).toMatchObject({ writes: 0, conflicts: 0, skipped: { "not a row this move wrote": 1 } });
    expect(await store.get(tenantRowKey(ORG, "T0AAA"))).toBeDefined();
  });

  it("the reverse deletes exactly the rows the forward step marked", async () => {
    const { store, context, move } = await world();
    await runDataMove(move, context, { direction: "forward", apply: true });
    expect(await runDataMove(move, context, { direction: "reverse", apply: true })).toMatchObject({ writes: 1 });
    expect(await store.get(tenantRowKey(ORG, "T0AAA"))).toBeUndefined();
    expect(await store.get(tenantRowKey(OTHER, "T0BBB"))).toBeDefined();
  });
});
