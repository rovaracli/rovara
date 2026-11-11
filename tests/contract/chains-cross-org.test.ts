// Plan 4 Task 28: chains, triggers, hooks, schedules and connections never cross organizations, through the REAL broker. Org A has a published chain C (INVESTIGATE_THEN_FIX) with
// three triggers (GitHub pull request opened, a Sentry hook H, a weekly schedule S), a run R waiting at its gate (approval G), a Sentry connection N and a connector `sentry` on `web`.
// Org B has a project `web` of its own and its own people. Every call a member of B makes for A's objects answers 404 NOT_FOUND exactly as an id nobody has does, and writes nothing
// (no write command reaches the table and no item of it changes). A control of the same call by A's own people shows the object is there, so no refusal is only a bad fixture.
import { randomUUID } from "node:crypto";
import { decideApproval, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { beforeAll, describe, expect, it } from "vitest";
import { hookKey } from "@rovara-code/contracts";
import { loadSlackBroker } from "../support/slack-broker.js";
import { OMAR } from "../support/developer-task-broker.js";
import { OTHER_TOPIC_ARN, SNS_ACCOUNT, SNS_TOPIC_ARN, confirmationFields, notificationFields, signSns } from "../support/sns-fixtures.js";
import {
  ARJUN, BETH, CARL, DANA, HOOK_SECRET_A, HOOK_SECRET_B, INSTALLATION_A, INSTALLATION_A2, INSTALLATION_B, LINEAR_KEY, MAX, ORG_A, ORG_B, WRITES, isolationWorld, SENTRY_CONNECTOR, sentryBody, stepCapability,
  type ChainsWorld, type IsolationWorld, type Item, type Reply,
} from "../support/chains-broker-world.js";

beforeAll(async () => { await loadSlackBroker(); });

/** An alarm state change as CloudWatch writes it (an offset without a colon), a moment ago. */
const stateChange = (): string => new Date(Date.now() - 5_000).toISOString().replace("Z", "+0000");
const NOT_FOUND = { status: 404, code: "NOT_FOUND" } as const;

type World = IsolationWorld;
let shared: World;
beforeAll(async () => { shared = await isolationWorld(); }, 120_000);

/** Runs `request` and holds it to what every refusal owes: the answer, no write command, and no item of any table changed. */
async function refused(w: World, label: string, request: () => Promise<Reply>, expected: { status: number; code: string }): Promise<Reply> {
  const commands = w.w.db.commandNames().length;
  const before = w.fingerprint();
  const reply = await request();
  expect({ label, status: reply.status, code: (reply.body.error as { code?: string } | undefined)?.code ?? "" }).toEqual({ label, ...expected });
  expect(w.w.db.commandNames().slice(commands).filter((name) => WRITES.test(name)), `${label}: the table was written`).toEqual([]);
  expect(w.fingerprint() === before, `${label}: an item changed`).toBe(true);
  return reply;
}

describe("the controls: org A's own people reach every object the suite asks B for", () => {
  it("reads the chain, its version, draft, triggers and the trigger's activity, the run, its events and the connection", async () => {
    const { w, C, T, R, N } = shared;
    for (const path of [
      `/v1/app/chains/${C}`, `/v1/app/chains/${C}/versions/1`, `/v1/app/chains/${C}/draft`, `/v1/app/chains/${C}/triggers`, `/v1/app/chains/${C}/triggers/${T.hook.triggerId}/activity`,
      `/v1/app/chain-runs/${R}`, `/v1/app/chain-runs/${R}/events`, `/v1/app/connections/${N}`, "/v1/app/projects/web/event-hooks",
    ]) {
      const reply = await w.api(MAX, "GET", path);
      expect(reply.status, `${path}: ${JSON.stringify(reply.body)}`).toBe(200);
    }
    expect((await w.api(DANA, "GET", `/v1/app/connections/${N}`)).status).toBe(200);
  });
});

describe("a member of org B asks for org A's chain, run, gate, connection and hooks", () => {
  const ids = (s: World) => ({ C: s.C, R: s.R, G: s.G, N: s.N, H: s.H, T: s.T.hook.triggerId });
  const MISSING = { C: "chn_zzzzzzzzzzzzzzzzzzzz", R: "crn_zzzzzzzzzzzzzzzzzzzz", G: "apr_zzzzzzzzzzzzzzzzzzzz", N: "con_zzzzzzzzzzzzzzzzzzzz", H: `hk_${"z".repeat(26)}`, T: "ctr_zzzzzzzzzzzzzzzzzzzz" };

  interface Case { name: string; request: (i: ReturnType<typeof ids>) => [method: string, path: string, body?: Record<string, unknown>]; adminOnly?: boolean }
  const cases: Case[] = [
    { name: "show the chain", request: (i) => ["GET", `/v1/app/chains/${i.C}`] },
    { name: "show a version", request: (i) => ["GET", `/v1/app/chains/${i.C}/versions/1`] },
    { name: "show the draft", request: (i) => ["GET", `/v1/app/chains/${i.C}/draft`] },
    { name: "list its triggers", request: (i) => ["GET", `/v1/app/chains/${i.C}/triggers`] },
    { name: "read a trigger's activity", request: (i) => ["GET", `/v1/app/chains/${i.C}/triggers/${i.T}/activity`] },
    { name: "start a run of it on B's web", request: (i) => ["POST", `/v1/app/chains/${i.C}/runs`, { project: "web" }] },
    { name: "read the run", request: (i) => ["GET", `/v1/app/chain-runs/${i.R}`] },
    { name: "read the run's events", request: (i) => ["GET", `/v1/app/chain-runs/${i.R}/events`] },
    { name: "cancel the run", request: (i) => ["POST", `/v1/app/chain-runs/${i.R}/cancel`, {}] },
    { name: "decide the run's gate", request: (i) => ["POST", `/v1/app/approvals/${i.G}/decide`, { decision: "APPROVE" }] },
    { name: "read the connection", request: (i) => ["GET", `/v1/app/connections/${i.N}`] },
    { name: "check the connection", request: (i) => ["POST", `/v1/app/connections/${i.N}/check`, {}], adminOnly: true },
  ];

  for (const who of [OMAR, BETH]) {
    it.each(cases)(`${who.name}: $name`, async (entry) => {
      const s = shared;
      const [method, path, body] = entry.request(ids(s));
      const [methodTwin, pathTwin, bodyTwin] = entry.request(MISSING);
      // An admin's route is refused to B's plain member for the role first, as it is to A's member; for B's owner the org line is what answers.
      const expected = entry.adminOnly === true && who === OMAR ? { status: 403, code: "FORBIDDEN" } : NOT_FOUND;
      const theirs = await refused(s, `${who.name}: ${entry.name}`, () => s.w.api(who, method, path, body), expected);
      const absent = await refused(s, `${who.name}: ${entry.name} (an id no org has)`, () => s.w.api(who, methodTwin, pathTwin, bodyTwin), expected);
      const same = (reply: Reply, from: typeof MISSING | ReturnType<typeof ids>) => JSON.stringify(reply.body).split(from.C).join("C").split(from.R).join("R").split(from.G).join("G").split(from.N).join("N").split(from.T).join("T");
      expect(same(theirs, ids(s))).toBe(same(absent, MISSING));
    });
  }

  it("lists none of A's hooks to B's maintainer, and none of A's chains or runs", async () => {
    const s = shared;
    const hooks = await s.w.api(OMAR, "GET", "/v1/app/projects/web/event-hooks");
    expect(hooks.status).toBe(200);
    expect((hooks.body.hooks as Array<{ hookId: string }>).map((hook) => hook.hookId)).toEqual([s.BH]);
    const chains = await s.w.api(OMAR, "GET", "/v1/app/chains");
    expect(JSON.stringify(chains.body)).not.toContain(s.C);
    const runs = await s.w.api(OMAR, "GET", "/v1/app/chain-runs?project=web");
    expect(JSON.stringify(runs.body)).not.toContain(s.R);
  });

  it("refuses B's trigger naming A's hook, and B's project connector naming A's connection, as a thing that is not B's", async () => {
    const s = shared;
    const aBefore = s.aState();
    const triggerPut = await s.w.api(OMAR, "PUT", `/v1/app/chains/${s.BC}/triggers/ctr_${"x".repeat(20)}`, { project: "web", spec: { kind: "event", source: "sentry", type: "issue.created" }, hookId: s.H });
    expect(triggerPut.status, JSON.stringify(triggerPut.body)).toBe(404);
    const connector = await s.w.api(OMAR, "PUT", "/v1/app/projects/web/connectors/sentry", { expectedRevision: 1, connector: SENTRY_CONNECTOR(s.N) });
    expect(connector.status, JSON.stringify(connector.body)).toBe(400);
    expect((connector.body.error as { message: string }).message).toContain("no sentry connection called");
    expect(JSON.stringify([triggerPut.body, connector.body])).not.toContain("A Sentry");
    // Nothing was stored: B has no trigger of that id and no connector.
    expect(await s.w.triggers.get(ORG_B, `ctr_${"x".repeat(20)}`)).toBeUndefined();
    // B's own request items may be written (R18); nothing of A's changes.
    expect(s.aState() === aBefore).toBe(true);
  });

  it("keeps A's objects as they were after all of it", () => {
    const { w, C, T, R } = shared;
    expect(w.runItem(R)).toMatchObject({ status: "waiting" });
    expect(JSON.stringify(w.attempts(R).map((attempt) => attempt.status))).toBe(JSON.stringify(["succeeded", "waiting"]));
    void [C, T, ARJUN, CARL, LINEAR_KEY, sentryBody, hookKey, randomUUID, INSTALLATION_B, ORG_B, HOOK_SECRET_B, INSTALLATION_A2];
  });
});


// ---- across paths: the hooks, the schedule and the events

describe("across paths", () => {
  let x: World;
  beforeAll(async () => { x = await isolationWorld(); }, 120_000);
  const FORBIDDEN = JSON.stringify({ error: { code: "FORBIDDEN", message: "signature check failed" } });
  const runs = () => x.w.db.find((item) => item.entityType === "CHAIN_RUN");
  const activity = async (triggerId: string) => x.w.triggers.listActivity(ORG_A, triggerId, 100);

  it("answers a body for hook H signed with B's hook secret with 403, and a forged request writes nothing", async () => {
    const mark = x.w.db.commandNames().length;
    const before = x.fingerprint();
    const forged = await x.w.deliver("sentry", x.H, sentryBody(INSTALLATION_A, "9001"), { secret: HOOK_SECRET_B });
    expect([forged.statusCode, forged.body]).toEqual([403, FORBIDDEN]);
    const unsigned = await x.w.deliver("sentry", x.H, sentryBody(INSTALLATION_A, "9001"), { secret: null });
    expect([unsigned.statusCode, unsigned.body]).toEqual([403, FORBIDDEN]);
    // B's own hook id with A's secret is the same refusal, and so is an id nobody has.
    expect((await x.w.deliver("sentry", x.BH, sentryBody(INSTALLATION_B, "9001"), { secret: HOOK_SECRET_A })).statusCode).toBe(403);
    expect((await x.w.deliver("sentry", `hk_${"z".repeat(26)}`, sentryBody(INSTALLATION_A, "9001"), { secret: HOOK_SECRET_A })).statusCode).toBe(403);
    expect(x.w.db.commandNames().slice(mark).filter((name) => WRITES.test(name))).toEqual([]);
    expect(x.fingerprint() === before).toBe(true);
    expect(runs()).toHaveLength(1);
  });

  it("answers a body signed with A's secret but naming B's installation as a refusal too, with nothing started", async () => {
    const reply = await x.w.deliver("sentry", x.H, sentryBody(INSTALLATION_B, "9002"), { secret: HOOK_SECRET_A });
    expect(reply.statusCode).toBe(403);
    expect(runs()).toHaveLength(1);
  });

  it("starts, for an event on one of A's two Sentry hooks, only the trigger bound to that hook", async () => {
    const reply = await x.w.deliver("sentry", x.H, sentryBody(INSTALLATION_A, "9100"), { secret: HOOK_SECRET_A });
    expect(reply.statusCode, reply.body).toBe(202);
    expect(await activity(x.T.hook2.triggerId)).toEqual([]);
    expect(await activity(x.T.github.triggerId)).toEqual([]);
    expect(await activity(x.T.hook.triggerId)).toMatchObject([{ outcome: "started" }]);
    const started = runs().filter((run) => (run.startedBy as { kind?: string }).kind === "event");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ orgId: ORG_A, startedBy: { kind: "event", triggerId: x.T.hook.triggerId, source: "sentry" } });
    // The other hook's event starts the other trigger, and not this one.
    const second = await x.w.deliver("sentry", x.H2, sentryBody(INSTALLATION_A2, "9101"), { secret: HOOK_SECRET_A });
    expect(second.statusCode, second.body).toBe(202);
    expect(await activity(x.T.hook2.triggerId)).toMatchObject([{ outcome: "started" }]);
    expect(await activity(x.T.hook.triggerId)).toHaveLength(1);
  });

  it("starts nothing in B for an event on A's hook, and B's hook has no trigger to start", async () => {
    expect(x.w.db.find((item) => item.entityType === "CHAIN_RUN" && item.orgId === ORG_B)).toEqual([]);
    const reply = await x.w.deliver("sentry", x.BH, sentryBody(INSTALLATION_B, "9200"), { secret: HOOK_SECRET_B });
    expect(reply.statusCode).toBe(202);
    expect(x.w.db.find((item) => item.entityType === "CHAIN_RUN" && item.orgId === ORG_B)).toEqual([]);
    expect(await activity(x.T.hook.triggerId)).toHaveLength(1);
  });

  it("answers an SNS notification to A's CloudWatch hook from a topic in another AWS account with 403, and starts nothing", async () => {
    x.w.connectedAwsAccounts.add(`${ORG_A}|${SNS_ACCOUNT}`);
    const made = await x.w.created(x.w.api(MAX, "POST", "/v1/app/projects/web/event-hooks", { source: "cloudwatch", tenant: { awsAccountId: SNS_ACCOUNT, topicArn: SNS_TOPIC_ARN } }));
    const hookId = (made.hook as { hookId: string }).hookId;
    const sns = (body: string, topic: string, type = "Notification") => x.w.deliverRaw("cloudwatch", hookId, body, { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-topic-arn": topic, "x-amz-sns-message-type": type });
    // The subscription is confirmed by a message signed for the hook's own topic.
    const confirmed = await sns(signSns(confirmationFields("SubscriptionConfirmation", { timestamp: new Date().toISOString() })), SNS_TOPIC_ARN, "SubscriptionConfirmation");
    expect([confirmed.statusCode, JSON.parse(confirmed.body)]).toEqual([202, { delivery: "SUBSCRIPTION_CONFIRMED" }]);
    await x.w.triggers.create({ record: { orgId: ORG_A, triggerId: `ctr_${"c".repeat(20)}`, target: { kind: "chain", chainId: x.C }, project: "web", spec: { kind: "event", source: "cloudwatch", type: "alarm.fired" }, hookId, enabled: true, maxRunsPerHour: 30, createdBy: MAX.developerId } });
    const before = runs().length;
    const mark = x.w.db.commandNames().length;
    // A validly signed notification from another account's topic, sent to this hook (with that topic's header and with this hook's).
    const foreign = signSns(notificationFields({ topicArn: OTHER_TOPIC_ARN, messageId: "foreign-1", timestamp: new Date().toISOString(), alarm: { at: stateChange() } }));
    for (const header of [OTHER_TOPIC_ARN, SNS_TOPIC_ARN]) {
      const reply = await sns(foreign, header);
      expect([reply.statusCode, reply.body], header).toEqual([403, FORBIDDEN]);
    }
    expect(x.w.db.commandNames().slice(mark).filter((name) => WRITES.test(name))).toEqual([]);
    expect(runs()).toHaveLength(before);
    // The control: the same message from the hook's own topic starts the run.
    const own = await sns(signSns(notificationFields({ messageId: "own-1", timestamp: new Date().toISOString(), alarm: { at: stateChange() } })), SNS_TOPIC_ARN);
    expect([own.statusCode, JSON.parse(own.body)], own.body).toEqual([202, { delivery: "ACCEPTED", events: 1 }]);
    expect(runs()).toHaveLength(before + 1);
  });

  it("starts no run for a schedule invocation naming B's org with A's trigger id, and leaves A's schedule and trigger as they were", async () => {
    const before = x.aState();
    const slot = new Date(Date.now() - 5_000).toISOString();
    const reply = await x.w.h.handler({ source: "agentx.chain-schedule", orgId: ORG_B, triggerId: x.T.schedule.triggerId, scheduledAt: slot });
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((reply as { body: string }).body)).toMatchObject({ outcome: "stale" });
    expect(runs().filter((run) => (run.startedBy as { kind?: string }).kind === "schedule")).toEqual([]);
    expect(x.w.schedulerClient.get("agentx-staging-chain-triggers", x.T.schedule.triggerId)).toBeDefined();
    expect(x.aState() === before).toBe(true);
    // The control: A's own invocation of the same trigger does start its run (so the refusal above was the org line).
    const own = await x.w.h.handler({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: x.T.schedule.triggerId, scheduledAt: slot });
    expect(JSON.parse((own as { body: string }).body)).toMatchObject({ outcome: "started" });
    expect(runs().filter((run) => (run.startedBy as { kind?: string }).kind === "schedule")).toHaveLength(1);
  });
});


// ---- the permission leak (Review Focus 5): one step's grants never reach the next step of the chain

describe("a step's grants stay with its step", () => {
  let x: World;
  beforeAll(async () => { x = await isolationWorld(); }, 120_000);

  const connectorsOf = (reply: { body: Record<string, unknown> }) => ((reply.body.catalogs as Array<{ connector: string }> | undefined) ?? []).map((catalog) => catalog.connector);

  it("shows the first step its Sentry and Linear tools and the second step none, refuses the second step's direct calls, and never lets the first step's approved write be decided or replayed for it", async () => {
    const started = await x.w.api(MAX, "POST", `/v1/app/chains/${x.P}/runs`, { project: "web" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body.run as { runId: string }).runId;

    // Step 1: its catalog holds the two connectors it is granted.
    const first = await stepCapability(x, runId, "investigate");
    const listed = await first.tools();
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(connectorsOf(listed).sort()).toEqual(["linear", "sentry"]);
    // Its write waits for a person, then runs once when it is approved.
    const change = { id: "CHA-1", title: "Rename it" };
    const schemaHash = ((listed.body.catalogs as Array<{ connector: string; tools: Array<{ upstreamName: string; scopes: Array<{ schemaHash: string }> }> }>).find((catalog) => catalog.connector === "linear")!.tools.find((tool) => tool.upstreamName === "save_issue")!.scopes[0]!.schemaHash);
    const write = { requestId: randomUUID(), connector: "linear", scope: "eng", tool: "save_issue", schemaHash, arguments: change };
    const waiting = await first.callTool(write);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
    expect(waiting.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(waiting.body.approvalId);
    const saves = () => x.w.fakeLinear.calls.filter((entry) => entry.name === "save_issue");
    expect(saves()).toEqual([]);
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ApprovalDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(x.w.h.brokerInput as never)!;
    const approve = (id: string) => decideApproval(deps, { orgId: ORG_A, developerId: DANA.developerId, orgRole: "admin" }, id, { requestId: randomUUID(), decision: "APPROVE" });
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    expect(saves()).toHaveLength(1);

    // Step 2 starts when step 1 ends: its catalog has no sentry__* and no linear__* tool.
    await x.w.endStep(runId, { finalReport: "Found it." }, "investigate");
    const second = await stepCapability(x, runId, "summarize");
    expect(second.taskId).not.toBe(first.taskId);
    const catalog = await second.tools();
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    expect(catalog.body.catalogs).toEqual([]);
    expect(JSON.stringify(catalog.body)).not.toMatch(/sentry__|linear__/u);

    // A direct call with the second task's capability is AGENT_TOOL_NOT_GRANTED, for the read and for the write, before any vendor is asked.
    const sentryCalls = x.w.sentryApi.requests.length;
    const linearCalls = x.w.fakeLinear.calls.length;
    const read = await second.callTool({ requestId: randomUUID(), connector: "sentry", scope: "web", tool: "get_issue", schemaHash: "b".repeat(64), arguments: { id: "101" } });
    expect([read.status, (read.body.error as { code: string }).code]).toEqual([403, "AGENT_TOOL_NOT_GRANTED"]);
    // The first step's write, replayed byte for byte (the same request id, the same arguments) with the second task's capability.
    const replay = await second.callTool(write);
    expect([replay.status, (replay.body.error as { code: string }).code]).toEqual([403, "AGENT_TOOL_NOT_GRANTED"]);
    const again = await second.callTool({ ...write, requestId: randomUUID() });
    expect((again.body.error as { code: string }).code).toBe("AGENT_TOOL_NOT_GRANTED");
    expect(x.w.sentryApi.requests.length).toBe(sentryCalls);
    expect(x.w.fakeLinear.calls.length).toBe(linearCalls);
    expect(saves()).toHaveLength(1);
    // Nothing waits for a person on the second task's account, and the first approval stays the first task's: it is not open again and deciding it again sends nothing.
    const record = x.w.approvals().filter((item) => (item.subject as { taskId?: string } | undefined)?.taskId === second.taskId);
    expect(record).toEqual([]);
    await approve(approvalId).catch(() => undefined);
    expect(saves()).toHaveLength(1);
    expect(x.w.approvals().find((item) => item.approvalId === approvalId)).toMatchObject({ operationId: first.operationId, subject: { taskId: first.taskId } });
  });
});

// ---- the write approval of an event-started step

describe("the write approval of an event-started step", () => {
  let x: World;
  beforeAll(async () => { x = await isolationWorld(); }, 120_000);

  it("answers 404 to B's maintainer and B's owner who decide, or ask for a link to decide, the write approval of A's event-started step, and leaves it waiting for A's people", async () => {
    // An event-started run of the investigate-then-summarize chain: a Sentry issue on a third hook of A's starts it.
    const installation = "66666666-6666-4666-8666-666666666666";
    const hookId = await x.w.sentryHook(installation, HOOK_SECRET_A);
    await x.w.triggers.create({ record: { orgId: ORG_A, triggerId: `ctr_${"p".repeat(20)}`, target: { kind: "chain", chainId: x.P }, project: "web", spec: { kind: "event", source: "sentry", type: "issue.created" }, hookId, enabled: true, maxRunsPerHour: 30, createdBy: MAX.developerId } });
    const delivered = await x.w.deliver("sentry", hookId, sentryBody(installation, "7001"), { secret: HOOK_SECRET_A });
    expect(delivered.statusCode, delivered.body).toBe(202);
    const run = x.w.db.find((item) => item.entityType === "CHAIN_RUN" && item.chainId === x.P && (item.startedBy as { kind?: string }).kind === "event")[0]!;
    expect(run).toMatchObject({ orgId: ORG_A, origin: "event" });
    const step = await stepCapability(x, String(run.runId), "investigate");
    const listed = await step.tools();
    const schemaHash = ((listed.body.catalogs as Array<{ connector: string; tools: Array<{ upstreamName: string; scopes: Array<{ schemaHash: string }> }> }>).find((catalog) => catalog.connector === "linear")!.tools.find((tool) => tool.upstreamName === "save_issue")!.scopes[0]!.schemaHash);
    const waiting = await step.callTool({ requestId: randomUUID(), connector: "linear", scope: "eng", tool: "save_issue", schemaHash, arguments: { id: "CHA-1", title: "Event-started rename" } });
    expect(waiting.body.result, JSON.stringify(waiting.body)).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(waiting.body.approvalId);
    const status = () => (x.w.approvals().find((item) => item.approvalId === approvalId) as { status: string }).status;
    expect(status()).toBe("PENDING");
    const saves = () => x.w.fakeLinear.calls.filter((entry) => entry.name === "save_issue").length;
    const savesBefore = saves();
    for (const who of [OMAR, BETH]) {
      const before = x.aState();
      expect((await x.w.api(who, "POST", `/v1/app/approvals/${approvalId}/decide`, { decision: "APPROVE" })).status, who.name).toBe(404);
      expect((await x.w.api(who, "POST", `/v1/app/approvals/${approvalId}/confirm-link`, {})).status, who.name).toBe(404);
      expect((await x.w.api(who, "GET", `/v1/app/approvals/${approvalId}`)).status, who.name).toBe(404);
      expect(x.aState() === before, `${who.name}: an item of A's changed`).toBe(true);
    }
    expect(status()).toBe("PENDING");
    expect(saves()).toBe(savesBefore);
    // The control: A's own admin decides it, and the write is made once.
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ApprovalDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(x.w.h.brokerInput as never)!;
    expect((await decideApproval(deps, { orgId: ORG_A, developerId: DANA.developerId, orgRole: "admin" }, approvalId, { requestId: randomUUID(), decision: "APPROVE" })).status).toBe("APPROVED_DONE");
    expect(saves()).toBe(savesBefore + 1);
  });
});

void ({} as { w?: ChainsWorld; i?: Item });
