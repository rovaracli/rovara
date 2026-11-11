// Plan 4 Task 28: runaway loops stop, through the REAL broker. An agent's own output never starts the work that wrote it (the bot identity of the connection, the 30-minute subject guard,
// a chain whose Linear write creates the issue its own trigger listens for); the hourly and the daily caps bound what a loop that gets past those can do; a budget that is used up
// stops a run before it starts; a disabled, ownerless or deleted trigger never fires; and a flood at a hook is bounded (the route's throttle, the hook's own limits, a flood of forged
// requests costs no write and almost no read). Every delivery here is a signed Linear or Sentry request through the broker's handler, and every start is the broker's own dispatch.
import { createHmac, randomUUID } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { orgAutonomousKey, triggerRateKey, triggerSubjectKey, TRIGGER_SUBJECT_GUARD_MINUTES, ORG_MAX_AUTONOMOUS_RUNS_PER_DAY } from "@rovara-code/contracts";
import { orgMemberKey, orgRemovedKey, spendCounterKey } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { decideApproval, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import {
  DANA, HOOK_SECRET_A, INSTALLATION_A, MAX, ORG_A, isolationWorld, sentryBody, stepCapability, type IsolationWorld, type Item,
} from "../support/chains-broker-world.js";

skipLambdaBundling();
beforeAll(async () => { await loadSlackBroker(); });

type World = IsolationWorld;
const LINEAR_ORG = "11111111-1111-4111-8111-111111111111";
const LINEAR_SECRET = "linear-signing-secret-of-org-a-0123456789";
const ONE_STEP = { start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] } as never;
const MONTH = new Date().toISOString().slice(0, 7);

/** A Linear webhook body for a new issue, as Linear sends it. `actor` is who made the issue. */
const linearBody = (identifier: string, actor: string | null, over: { dataId?: string } = {}): string => JSON.stringify({
  type: "Issue", action: "create", organizationId: LINEAR_ORG, webhookTimestamp: Date.now(), url: `https://linear.app/acme/issue/${identifier}`,
  ...(actor === null ? {} : { actor: { id: actor } }),
  data: { id: over.dataId ?? `uuid-${identifier}`, identifier, teamId: "c408e946-78aa-4db8-923e-f78053dd954f", title: `Issue ${identifier}`, url: `https://linear.app/acme/issue/${identifier}` },
});

/** A Linear hook of A's web (Max made it) and a trigger on `chainId` for new issues; returns the hook and a sender. */
async function linearTrigger(x: World, chainId: string, over: { maxRunsPerHour?: number; createdBy?: string; triggerId?: string } = {}) {
  const made = await x.w.created(x.w.api(MAX, "POST", "/v1/app/projects/web/event-hooks", { source: "linear", tenant: { organizationId: LINEAR_ORG, teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }, secret: LINEAR_SECRET }));
  const hookId = (made.hook as { hookId: string }).hookId;
  const triggerId = over.triggerId ?? `ctr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const trigger = await x.w.triggers.create({
    record: { orgId: ORG_A, triggerId, target: { kind: "chain", chainId }, project: "web", spec: { kind: "event", source: "linear", type: "issue.created" }, hookId, enabled: true, maxRunsPerHour: over.maxRunsPerHour ?? 30, createdBy: over.createdBy ?? MAX.developerId },
  });
  const send = (raw: string, options: { secret?: string; ip?: string } = {}) => x.w.deliverRaw("linear", hookId, raw, { "content-type": "application/json", "linear-signature": createHmac("sha256", options.secret ?? LINEAR_SECRET).update(raw).digest("hex") }, options.ip);
  const activity = async () => (await x.w.triggers.listActivity(ORG_A, triggerId, 200)).map((entry) => (entry.reason === undefined ? entry.outcome : `${entry.outcome}:${entry.reason}`)).reverse();
  return { hookId, trigger, triggerId, send, activity };
}
const eventRuns = (x: World, chainId?: string): Item[] => x.w.db.find((item) => item.entityType === "CHAIN_RUN" && item.origin === "event" && (chainId === undefined || item.chainId === chainId));
/** Frees the workspace a started run holds (a person may hold three), as the step's end does. */
const finishRuns = async (x: World, chainId: string) => { for (const run of eventRuns(x, chainId)) if (x.w.stepTask(String(run.runId)) !== undefined && x.w.runItem(String(run.runId))?.["status"] === "running") await x.w.endStep(String(run.runId)); };
const actorOfL = (x: World): string => String((x.w.db.find((item) => item.entityType === "ORG_CONNECTION" && item.connectionId === x.L)[0] as { actorId?: string }).actorId);

// ---- what an agent's own output starts

describe("a chain whose Linear write makes the issue its own trigger listens for", () => {
  it("starts exactly one run: the issue it created is its own account's, and no trigger starts work for that", async () => {
    const x = await isolationWorld();
    const { send, activity, triggerId } = await linearTrigger(x, x.P);
    const rovara = actorOfL(x);
    expect(rovara).toMatch(/\S/u);

    // A person files ENG-1: one run starts.
    const filed = await send(linearBody("ENG-1", "person-1"));
    expect([filed.statusCode, JSON.parse(filed.body)], filed.body).toEqual([202, { delivery: "ACCEPTED", events: 1 }]);
    expect(eventRuns(x, x.P)).toHaveLength(1);
    const run = eventRuns(x, x.P)[0]!;

    // Its first step writes to Linear (the write waits for a person and is made once when approved). The recorded Linear server has no label tool, which a new issue needs, so the write
    // changes an issue; what Linear reports back below is the issue the agent made, as the account of the key that made it.
    const step = await stepCapability(x, String(run.runId), "investigate");
    const listed = await step.tools();
    const schemaHash = ((listed.body.catalogs as Array<{ connector: string; tools: Array<{ upstreamName: string; scopes: Array<{ schemaHash: string }> }> }>).find((catalog) => catalog.connector === "linear")!.tools.find((tool) => tool.upstreamName === "save_issue")!.scopes[0]!.schemaHash);
    const waiting = await step.callTool({ requestId: randomUUID(), connector: "linear", scope: "eng", tool: "save_issue", schemaHash, arguments: { id: "CHA-1", title: "Follow-up found by the investigation" } });
    expect(waiting.body.result, JSON.stringify(waiting.body)).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ApprovalDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(x.w.h.brokerInput as never)!;
    const decided = await decideApproval(deps, { orgId: ORG_A, developerId: DANA.developerId, orgRole: "admin" }, String(waiting.body.approvalId), { requestId: randomUUID(), decision: "APPROVE" });
    expect(decided.status).toBe("APPROVED_DONE");
    expect(x.w.fakeLinear.calls.filter((entry) => entry.name === "save_issue")).toHaveLength(1);

    // Linear tells the hook about the issue the agent made: made by the connection's own account.
    const own = await send(linearBody("CHA-2", rovara));
    expect(own.statusCode, own.body).toBe(202);
    expect(eventRuns(x, x.P)).toHaveLength(1);
    expect(await activity()).toEqual(["started", "skipped:caused_by_rovara"]);
    // The control: the same event from a person starts a second run, so the skip above was the account and nothing else.
    expect((await send(linearBody("CHA-3", "person-2"))).statusCode).toBe(202);
    expect(eventRuns(x, x.P)).toHaveLength(2);
    expect(await activity()).toEqual(["started", "skipped:caused_by_rovara", "started"]);
    void triggerId;
  });

  it("is bounded by the subject guard and the caps where the key is a person's own (no account of Rovara's to tell)", async () => {
    const x = await isolationWorld();
    // The connection becomes a person's own key: the actor guard no longer applies to it (the subject guard and the caps are what stop a loop).
    const connection = x.w.db.find((item) => item.entityType === "ORG_CONNECTION" && item.connectionId === x.L)[0]!;
    x.w.db.set({ ...connection, identity: "personal" });
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 20 });
    const { send, activity, triggerId } = await linearTrigger(x, K, { maxRunsPerHour: 2 });
    const rovara = actorOfL(x);
    // The agent's own issues (made by the personal key's account) now start runs: issue after issue, until the trigger's hour is used up.
    const outcomes: string[] = [];
    for (const identifier of ["LOOP-1", "LOOP-2", "LOOP-3", "LOOP-4"]) {
      expect((await send(linearBody(identifier, rovara))).statusCode).toBe(202);
      outcomes.push((await activity()).at(-1)!);
      await finishRuns(x, K);
    }
    expect(outcomes).toEqual(["started", "started", "skipped:rate_limited", "skipped:rate_limited"]);
    expect(eventRuns(x, K)).toHaveLength(2);
    const hour = new Date().toISOString().slice(0, 13);
    expect(x.w.db.get(triggerRateKey(ORG_A, triggerId, hour).pk, triggerRateKey(ORG_A, triggerId, hour).sk)).toMatchObject({ count: 2 });
  });
});

describe("the subject guard", () => {
  it("does not start a trigger again for a subject it started a run for in the last 30 minutes, and does once the half hour has passed", async () => {
    const x = await isolationWorld();
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 20 });
    const { send, activity, triggerId } = await linearTrigger(x, K);
    expect((await send(linearBody("SUB-1", "person-1", { dataId: "first" }))).statusCode).toBe(202);
    await finishRuns(x, K);
    // The same issue again under another event identity (an update the vendor sent as a new event): the run that started may be what changed it.
    expect((await send(linearBody("SUB-1", "person-1", { dataId: "second" }))).statusCode).toBe(202);
    expect(await activity()).toEqual(["started", "skipped:recent_subject"]);
    expect(eventRuns(x, K)).toHaveLength(1);
    // Thirty-one minutes later the subject is open again.
    const key = triggerSubjectKey(ORG_A, triggerId, { kind: "issue", id: "SUB-1", url: "https://linear.app/acme/issue/SUB-1" });
    const marker = x.w.db.get(key.pk, key.sk) as Item;
    expect(marker).toBeDefined();
    x.w.db.set({ ...marker, at: new Date(Date.now() - (TRIGGER_SUBJECT_GUARD_MINUTES + 1) * 60_000).toISOString() });
    expect((await send(linearBody("SUB-1", "person-1", { dataId: "third" }))).statusCode).toBe(202);
    expect(await activity()).toEqual(["started", "skipped:recent_subject", "started"]);
  });
});

// ---- the caps and the budgets

describe("the caps", () => {
  it("stops a trigger at its hourly allowance and every trigger of the org at the day's, with a skip recorded and no run", async () => {
    const x = await isolationWorld();
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 20 });
    const { send, activity } = await linearTrigger(x, K, { maxRunsPerHour: 1 });
    expect((await send(linearBody("CAP-1", "person-1"))).statusCode).toBe(202);
    await finishRuns(x, K);
    expect((await send(linearBody("CAP-2", "person-1"))).statusCode).toBe(202);
    expect(await activity()).toEqual(["started", "skipped:rate_limited"]);
    expect(eventRuns(x, K)).toHaveLength(1);
    // A trigger with room is still stopped by the day's org-wide allowance.
    const other = await linearTrigger(x, K);
    const day = new Date().toISOString().slice(0, 10);
    x.w.db.set({ ...orgAutonomousKey(ORG_A, day), entityType: "ORG_AUTONOMOUS", count: ORG_MAX_AUTONOMOUS_RUNS_PER_DAY });
    expect((await other.send(linearBody("CAP-3", "person-1"))).statusCode).toBe(202);
    expect(await other.activity()).toEqual(["skipped:org_daily_limit"]);
    expect(eventRuns(x, K)).toHaveLength(1);
    expect(x.w.db.get(orgAutonomousKey(ORG_A, day).pk, orgAutonomousKey(ORG_A, day).sk)).toMatchObject({ count: ORG_MAX_AUTONOMOUS_RUNS_PER_DAY });
  });

  it("stops a run before it starts when the chain's month is used up, and starts again once there is room", async () => {
    const x = await isolationWorld();
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 5 });
    const { send, activity } = await linearTrigger(x, K);
    const counter = spendCounterKey(ORG_A, MONTH, `CHAIN#${K}`);
    x.w.db.set({ ...counter, entityType: "SPEND_COUNTER", spentUsd: 5, committedUsd: 5 });
    const tasksBefore = x.w.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
    expect((await send(linearBody("BUD-1", "person-1"))).statusCode).toBe(202);
    const [outcome] = await activity();
    expect(outcome).not.toBe("started");
    expect(eventRuns(x, K)).toEqual([]);
    expect(x.w.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(tasksBefore);
    x.w.db.set({ ...counter, entityType: "SPEND_COUNTER", spentUsd: 0, committedUsd: 0 });
    expect((await send(linearBody("BUD-2", "person-1"))).statusCode).toBe(202);
    expect(eventRuns(x, K)).toHaveLength(1);
  });

  it("turns a chain's trigger off when its budget is taken away, and nothing then starts", async () => {
    const x = await isolationWorld();
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 5 });
    const { send, trigger } = await linearTrigger(x, K);
    const removed = await x.w.api(MAX, "PUT", `/v1/app/chains/${K}/budget`, { monthlyUsd: null });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await x.w.triggers.get(ORG_A, trigger.triggerId))?.enabled).toBe(false);
    expect((await send(linearBody("OFF-1", "person-1"))).statusCode).toBe(202);
    expect(eventRuns(x, K)).toEqual([]);
  });
});

// ---- a trigger that is off, ownerless or gone

describe("a trigger that is disabled, ownerless or deleted never fires", () => {
  it("does nothing for a disabled trigger, a deleted trigger and a trigger whose owner has left", async () => {
    const x = await isolationWorld();
    const K = await x.w.chainOf(MAX, ONE_STEP, { name: "One step", budgetUsd: 20 });
    const off = await linearTrigger(x, K);
    const gone = await linearTrigger(x, K);
    const orphan = await linearTrigger(x, K);
    // The control: an enabled trigger of the same chain fires.
    const live = await linearTrigger(x, K);
    expect((await live.send(linearBody("LIVE-1", "person-1"))).statusCode).toBe(202);
    expect(eventRuns(x, K)).toHaveLength(1);
    await finishRuns(x, K);

    await x.w.triggers.update({ trigger: (await x.w.triggers.get(ORG_A, off.triggerId))!, patch: { enabled: false } });
    const deleted = await x.w.api(MAX, "DELETE", `/v1/app/chains/${K}/triggers/${gone.triggerId}`, {});
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((await off.send(linearBody("OFF-1", "person-1"))).statusCode).toBe(202);
    expect((await gone.send(linearBody("GONE-1", "person-1"))).statusCode).toBe(202);
    expect(eventRuns(x, K)).toHaveLength(1);
    expect(await off.activity()).toEqual([]);

    // The chain's owner (the person its runs belong to) leaves the org: there is nobody to run as, so nothing starts, and the triggers it had are off.
    const left = await x.w.api(MAX, "POST", "/v1/app/org/leave", {});
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect((await orphan.send(linearBody("ORPHAN-1", "person-1"))).statusCode).toBe(202);
    expect((await live.send(linearBody("ORPHAN-2", "person-1"))).statusCode).toBe(202);
    expect(eventRuns(x, K)).toHaveLength(1);
    expect((await orphan.activity()).filter((entry) => entry === "started")).toEqual([]);
    expect((await live.activity()).filter((entry) => entry === "started")).toEqual(["started"]);
    void [orgMemberKey, orgRemovedKey];
  });
});

// ---- floods

describe("a flood at a hook is bounded", () => {
  it("keeps the route's own throttle on the public hook route", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "FloodNamed", { naming: environmentNaming("staging") }));
    const stages = Object.values(template.findResources("AWS::ApiGatewayV2::Stage")) as Array<{ Properties: { RouteSettings: Record<string, { ThrottlingBurstLimit: number; ThrottlingRateLimit: number }> } }>;
    expect(stages).toHaveLength(1);
    expect(stages[0]!.Properties.RouteSettings["POST /v1/hooks/{source}/{hookId}"]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 });
  });

  it("answers 429 past a hook's 120 deliveries a minute, keeps its neighbour working, and writes nothing for the refused ones", async () => {
    const x = await isolationWorld();
    const flooded = await x.w.sentryHook("77777777-7777-4777-8777-777777777777", HOOK_SECRET_A);
    const neighbour = await x.w.sentryHook("88888888-8888-4888-8888-888888888888", HOOK_SECRET_A);
    // An event nothing is listening for (a comment, not an issue): accepted and ignored, but every one counts against the hook.
    const ignored = (hookId: string, installation: string) => x.w.deliver("sentry", hookId, sentryBody(installation, "1"), { secret: HOOK_SECRET_A, resource: "comment" });
    const replies: number[] = [];
    for (let index = 0; index < 125; index += 1) replies.push((await ignored(flooded, "77777777-7777-4777-8777-777777777777")).statusCode);
    expect(replies.slice(0, 120).every((status) => status === 202)).toBe(true);
    expect(replies.slice(120)).toEqual([429, 429, 429, 429, 429]);
    const before = x.fingerprint();
    expect((await ignored(flooded, "77777777-7777-4777-8777-777777777777")).statusCode).toBe(429);
    expect(x.fingerprint() === before, "a refused delivery changed an item").toBe(true);
    expect((await ignored(neighbour, "88888888-8888-4888-8888-888888888888")).statusCode).toBe(202);
  });

  it("answers a flood of forged requests with the one 403, writes nothing, and reads the secret only a few times", async () => {
    const x = await isolationWorld();
    const hookId = await x.w.sentryHook("99999999-9999-4999-8999-999999999999", HOOK_SECRET_A);
    const before = x.fingerprint();
    const reads = x.w.hookSecrets.reads;
    const statuses = new Set<number>();
    for (let index = 0; index < 100; index += 1) statuses.add((await x.w.deliver("sentry", hookId, sentryBody("99999999-9999-4999-8999-999999999999", String(index)), { secret: "a-secret-that-is-not-the-hooks-0123456789", ip: `198.51.100.${String(index % 200)}` })).statusCode);
    expect([...statuses]).toEqual([403]);
    expect(x.fingerprint() === before, "a forged request changed an item").toBe(true);
    expect(x.w.hookSecrets.reads - reads).toBeLessThanOrEqual(5);
    expect(eventRuns(x)).toEqual([]);
    void [INSTALLATION_A];
  });
});
