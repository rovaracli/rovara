// S3-4: the broker's way into the Cloud root (cloud/app/entry.ts, slack-ingress-hook.ts, rovara-code/intent.ts's hook). Everything is behind the combined switch; with it off nothing is built,
// no hook is installed and every start and Slack request is what it was.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentXError, SessionIdSchema, agentXError, type Admission, type CodeIntentRequest, type DocumentStore, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import { bindChannelSpace, readTaskThread } from "@rovara-code/broker/core/channel";
import { taskSessionId } from "@rovara-code/broker/core/sessions";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import { fixedCodeSettings, soleOwnerPeople } from "@rovara-code/broker/core/merge";
import { localOwnerPrincipal } from "@rovara-code/broker/ports";
import { orgProjectCatalogKey, projectRevisionKey, when } from "@rovara-code/contracts";
import { createCloudAdmission } from "../../packages/broker/src/cloud-adapters/money/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { BROKER_SETTINGS, SLACK_NOT_A_MEMBER_NOTICE, orgMetaKey, projectAiKey, type DeveloperTaskView } from "@agentx/cloud-contracts";
import { DEFAULT_CODE_SETTINGS, codeSettingsKey } from "@rovara-code/contracts";
import {
  CORE_ADMISSION_ACTIONS, CORE_SLACK_ACTION, cloudAdapter, cloudAdmissionLevels, cloudLevelSources, cloudRefusalWords, taskPayerKey, cloudCoreRuntime, cloudSettingsFromEnvironment, coreIntentApplies, coreSlackFromIngress, cloudCoreWiringFromBroker, createCloudApp, createCloudCoreEntry, createCoreIntentHook,
  createCoreSlackConsumer, isCoreSlackRequestEvent, type CloudApp, type CloudCoreWiring, type TaskStopRead,
} from "../../packages/broker/src/cloud/app/index.js";
import { startCodeIntent } from "../../packages/broker/src/rovara-code/intent.js";
import { CloudSlackChannel } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const MAYA = "a".repeat(64);
const TENANT = "T0TEAM";
const SPACE = "C0CHAN";
const THREAD = "1695500000.000001";
const OTHER_COMPANY = "org_s3other000000000000z";

const intent = (over: Partial<CodeIntentRequest> = {}): CodeIntentRequest => ({ requestId: randomUUID(), project: "payments", input: { text: "Add a greeting." }, source: "app", path: "QUICK", ...over });

const PROJECT = (url: string): ProjectDefinition => ({ name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] });

async function registerProject(world: FakeWorld): Promise<void> {
  const project = PROJECT(world.hostModel.url);
  await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
}

interface Rig { world: FakeWorld; app: CloudApp; logs: Array<Record<string, unknown>> }

function rig(options: { env?: NodeJS.ProcessEnv; without?: readonly string[]; member?: boolean; orgOfTeam?: (teamId: string) => Promise<string | undefined>; understand?: boolean; admission?: Admission } = {}): Rig {
  const world = createFakeWorld({ ...(options.without === undefined ? {} : { without: options.without }), ...(options.admission === undefined ? {} : { admission: options.admission }) });
  const logs: Rig["logs"] = [];
  const slack = cloudAdapter({ point: "channel", name: "slack", lane: "A8", create: () => new CloudSlackChannel({ projects: ["payments", "ghost"], botToken: async () => "unused", serves: async () => true, fetch: (async () => new Response(JSON.stringify({ ok: true, ts: "1695500000.000009", channel: SPACE }))) }) });
  const wiring: CloudCoreWiring = {
    settings: () => cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: false }),
    callbackSigningKey: Buffer.alloc(32, 7), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), access: createOwnerTaskAccess(),
    now: () => new Date(world.clock.now), log: (entry) => logs.push(entry), people: soleOwnerPeople, codeSettings: fixedCodeSettings(),
    taskEnd: { readTask: async () => undefined, onTaskEnded: async () => undefined }, sessionFacts: { read: async () => undefined },
    slack: {
      orgOfTeam: (options.orgOfTeam ?? (async () => FAKE_COMPANY)), standingOf: async () => { if (options.member === false) throw new Error("not a member"); return MAYA; },
      principalOf: async (orgId) => localOwnerPrincipal({ companyId: orgId }), linkWords: () => "Link first.",
    },
  };
  const app = createCloudApp({ env: options.env ?? { CLOUD_CORE_ENGINE: "on" }, modules: [...world.modules, slack], context: () => world.context(), nowMs: () => world.clock.now, runtime: cloudCoreRuntime(wiring) });
  return { world, app, logs };
}

const notEnrolled = async (): Promise<TaskStopRead> => ({ enrolled: false, fence: [] });
const hookOf = (r: Rig, log: Rig["logs"] = r.logs, taskStop: () => Promise<TaskStopRead> = notEnrolled) => createCoreIntentHook({ app: r.app, taskStop, principalOf: async (caller) => localOwnerPrincipal({ companyId: caller.orgId }), origin: "https://rovara.example.test", now: () => r.world.clock.now, log: (entry) => log.push(entry) });
const caller = { orgId: FAKE_COMPANY, developerId: MAYA } as never;
const ownedTask = async (_caller: unknown, taskId: string) => ({ taskId }) as unknown as DeveloperTaskView;
const tasksOf = async (r: Rig) => (await (await r.app.runtimeFor(FAKE_COMPANY)).flow.list({ principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test" })).tasks.length;

describe("S3-4 a: the start hook", () => {
  it("takes a person's own coding start and nothing that needs the payer rules, a follow-up, a hand-off or attached context", () => {
    expect(coreIntentApplies(intent())).toBe(true);
    for (const source of ["cli", "mcp", "slack"] as const) expect(coreIntentApplies(intent({ source })), source).toBe(true);
    for (const source of ["linear", "offer"] as const) expect(coreIntentApplies(intent({ source })), source).toBe(false);
    expect(coreIntentApplies(intent({ retryOf: randomUUID() }))).toBe(false);
    expect(coreIntentApplies(intent({ designFirst: true }))).toBe(false);
    expect(coreIntentApplies(intent({ startAt: { repository: "demo", commit: "a".repeat(40), summary: "x" } }))).toBe(false);
    expect(coreIntentApplies(intent({ input: { text: "x", context: [{ kind: "text", title: "t", text: "c" }] } as never }))).toBe(false);
  });

  it("with the switch on for the company, the start runs on the core and answers as startCodeIntent does", async () => {
    const r = rig();
    await registerProject(r.world);
    const started = await hookOf(r).start({ caller, request: intent(), ownedTask });
    expect(started).toBeDefined();
    expect(await tasksOf(r)).toBe(1);
    const taskId = (started!.task as { taskId: string }).taskId;
    expect(started!.sessionId).toBe(SessionIdSchema.parse(taskSessionId(taskId)));
    expect(started!.sessionUrl).toContain("https://rovara.example.test/");
  });

  it("the same request id again starts nothing new", async () => {
    const r = rig();
    await registerProject(r.world);
    const request = intent();
    await hookOf(r).start({ caller, request, ownedTask });
    await hookOf(r).start({ caller, request, ownedTask });
    expect(await tasksOf(r)).toBe(1);
  });

  it("a start from a Slack thread remembers the thread, so the task is told there", async () => {
    const r = rig();
    await registerProject(r.world);
    const started = await hookOf(r).start({ caller, request: intent({ source: "slack", binding: { kind: "slack_thread", teamId: TENANT, channelId: SPACE, threadTs: THREAD } as never }), ownedTask });
    const thread = await readTaskThread(r.world.store, FAKE_COMPANY, started!.sessionId!);
    expect(thread).toEqual({ conversation: { channel: "slack", tenant: TENANT, space: SPACE, thread: THREAD }, personId: MAYA });
  });

  it("M-2: the start's admission records the payer in the start's own commit (a person-paid task here), and holds the project's AI settings as read", async () => {
    const holder: { store?: DocumentStore } = {};
    const admissionOver = (client: unknown): Admission => {
      const sources = cloudLevelSources({ documentClient: client, tableName: "state", now: () => 0 } as never);
      return createCloudAdmission({ get store() { return holder.store!; }, levels: cloudAdmissionLevels(sources), capture: sources.capture!, actions: CORE_ADMISSION_ACTIONS, words: cloudRefusalWords });
    };
    const r = rig({ admission: admissionOver(new FakeDynamoDb()) });
    holder.store = r.world.store;
    await registerProject(r.world);
    const started = await hookOf(r).start({ caller, request: intent(), ownedTask });
    const taskId = (started as { task: { taskId: string } }).task.taskId;
    expect(await r.world.store.get(taskPayerKey(taskId))).toMatchObject({ entityType: "TASK_PAYER", orgId: FAKE_COMPANY, payer: { kind: "member", developerId: expect.any(String) as string } });
    // A project switched to paying between the capture's read and the commit stops the start, and nothing is recorded.
    const dynamo = new FakeDynamoDb();
    const racing = { send: async (command: { input?: { Key?: { pk?: string } } }) => {
      const found = await (dynamo as unknown as { send(c: unknown): Promise<unknown> }).send(command);
      if (command.input?.Key?.pk?.includes("PROJECT_AI") === true || JSON.stringify(command.input?.Key).includes("AI")) await racy.world.store.put({ item: { ...projectAiKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_AI", projectPays: true, revision: 1 } });
      return found;
    } };
    const racy = rig({ admission: admissionOver(racing) });
    holder.store = racy.world.store;
    await registerProject(racy.world);
    await expect(hookOf(racy).start({ caller, request: intent(), ownedTask })).rejects.toBeDefined();
    expect(await tasksOf(racy)).toBe(0);
  });

  it("L-3: the spending-stop read is required, and a read that fails keeps the start on Cloud's path (nothing is assumed about a company's money)", async () => {
    const r = rig();
    await registerProject(r.world);
    expect(await hookOf(r, r.logs, async () => { throw new Error("table down"); }).start({ caller, request: intent(), ownedTask })).toBeUndefined();
    expect(await tasksOf(r)).toBe(0);
  });

  it("M-3: the core start is fenced on the spending-stop rows as they were read: a policy that changed since the read stops the start, and nothing is written", async () => {
    const r = rig();
    await registerProject(r.world);
    const policyKey = { pk: "SETTINGS#probe", sk: "FENCE" };
    // Read as absent; a policy then appears before the start commits.
    const read = async (): Promise<TaskStopRead> => { await r.world.store.put({ item: { ...policyKey, entityType: "PROBE" } }); return { enrolled: false, fence: [{ kind: "check", key: policyKey, condition: when.absent() }] }; };
    await expect(hookOf(r, r.logs, read).start({ caller, request: intent(), ownedTask })).rejects.toBeDefined();
    expect(await tasksOf(r)).toBe(0);
    // The same fence over a row that is as it was read: the start commits.
    const same = async (): Promise<TaskStopRead> => ({ enrolled: false, fence: [{ kind: "check", key: { pk: "SETTINGS#other", sk: "FENCE" }, condition: when.absent() }] });
    expect(await hookOf(r, r.logs, same).start({ caller, request: intent(), ownedTask })).toBeDefined();
    expect(await tasksOf(r)).toBe(1);
  });

  it("a company enrolled in per-task spending stops keeps Cloud's start (which captures the stop): nothing is started on the core, and a company that is not enrolled starts as before", async () => {
    const r = rig();
    await registerProject(r.world);
    expect(await hookOf(r, r.logs, async () => ({ enrolled: true, fence: [] })).start({ caller, request: intent(), ownedTask })).toBeUndefined();
    expect(await tasksOf(r)).toBe(0);
    expect(r.logs.some((entry) => entry["event"] === "core_entry.task_stop_enrolled")).toBe(true);
    expect(await hookOf(r, r.logs, notEnrolled).start({ caller, request: intent(), ownedTask })).toBeDefined();
    expect(await tasksOf(r)).toBe(1);
  });

  it("with the switch off (the default) it answers nothing and builds nothing", async () => {
    const r = rig({ env: {} });
    expect(await hookOf(r).start({ caller, request: intent(), ownedTask })).toBeUndefined();
    expect(r.world.created).toEqual([]);
  });

  it("with the switch on for other companies only, the start stays on Cloud's path and writes nothing", async () => {
    const r = rig({ env: { CLOUD_CORE_ENGINE: `on:${OTHER_COMPANY}` } });
    expect(await hookOf(r).start({ caller, request: intent(), ownedTask })).toBeUndefined();
    expect(r.world.created).toEqual([]);
  });

  it("a root that cannot be built leaves the start on Cloud's path (the point is named in the log), and nobody is refused for it", async () => {
    const r = rig({ without: ["queue"] });
    expect(await hookOf(r).start({ caller, request: intent(), ownedTask })).toBeUndefined();
    expect(r.logs.some((entry) => entry["event"] === "core_entry.runtime_unavailable")).toBe(true);
  });

  it("a refusal of the core is thrown as it is, for the caller to answer as any refusal", async () => {
    const r = rig();
    await expect(hookOf(r).start({ caller, request: intent({ project: "ghost" }), ownedTask })).rejects.toBeInstanceOf(AgentXError);
  });

  it("startCodeIntent asks the hook after its own checks and before the agent: an answer ends it, `undefined` goes on as before", async () => {
    const plain: unknown[] = [];
    const deps = (coreStart?: { start: () => Promise<undefined | { task: unknown }> }) => ({
      starter: undefined, startPlainTask: async (_caller: unknown, body: unknown) => { plain.push(body); return { task: { taskId: "plain" } }; }, ownedTask, projectProcess: async () => ({}), origin: "https://x.test",
      ...(coreStart === undefined ? {} : { coreStart }),
    }) as never;
    await startCodeIntent(deps(), caller, intent());
    await startCodeIntent(deps({ start: async () => undefined }), caller, intent());
    expect(plain).toHaveLength(2);
    const answered = await startCodeIntent(deps({ start: async () => ({ task: { taskId: "core" } }) }), caller, intent());
    expect((answered.task as unknown as { taskId: string }).taskId).toBe("core");
    expect(plain).toHaveLength(2);
  });
});

describe("S3-4 b: the Slack consumer", () => {
  const message = (text = "quick: Add a greeting") => ({ version: 1, eventId: `Ev${randomUUID().replaceAll("-", "").slice(0, 12)}`, thread: { teamId: TENANT, channelId: SPACE, threadTs: THREAD }, userId: "U0MAYA", text, receivedAt: "2026-11-12T10:00:00.000Z" }) as never;
  async function consumer(options: Parameters<typeof rig>[0] = {}, project = "payments") {
    const r = rig(options);
    await registerProject(r.world);
    await bindChannelSpace({ store: r.world.store, orgId: FAKE_COMPANY, now: () => r.world.clock.now }, { channel: "slack", tenant: TENANT, space: SPACE }, project);
    return { r, consume: createCoreSlackConsumer({ taskStop: notEnrolled, app: r.app, orgOfTeam: async (team) => (team === TENANT ? FAKE_COMPANY : undefined), log: (entry) => r.logs.push(entry) }) };
  }

  it("takes a plain request of a company on the core: handled, and a task started", async () => {
    const { r, consume } = await consumer();
    expect(await consume(message())).toEqual({ handled: true });
    expect(await tasksOf(r)).toBe(1);
  });

  it("a plain message with no prefix and Understand off starts as Quick (item e), not as a refusal for want of a path", async () => {
    const { r, consume } = await consumer();
    expect(await consume(message("Add a greeting"))).toEqual({ handled: true });
    expect(await tasksOf(r)).toBe(1);
  });

  it("L-3: a spending-stop read that fails keeps a plain request on Cloud's path (handled false), and it is started under the read's fence", async () => {
    const { r } = await consumer();
    const unread = createCoreSlackConsumer({ app: r.app, taskStop: async () => { throw new Error("table down"); }, orgOfTeam: async () => FAKE_COMPANY, log: () => undefined });
    expect(await unread(message())).toEqual({ handled: false });
    expect(await tasksOf(r)).toBe(0);
    const fenced = createCoreSlackConsumer({ app: r.app, orgOfTeam: async () => FAKE_COMPANY, log: () => undefined, taskStop: async () => ({ enrolled: false, fence: [{ kind: "check", key: { pk: "SETTINGS#probe", sk: "FENCE" }, condition: when.eq("revision", 1) }] }) });
    // A tripped fence is a refusal told in the thread (try again), never a task on stale money rules.
    expect(await fenced(message())).toMatchObject({ handled: true, reply: expect.any(String) as string });
    expect(await tasksOf(r)).toBe(0);
  });

  it("an enrolled company's plain request is Cloud's (handled false): no task is started on the core", async () => {
    const { r } = await consumer();
    const enrolled = createCoreSlackConsumer({ app: r.app, orgOfTeam: async () => FAKE_COMPANY, log: () => undefined, taskStop: async () => ({ enrolled: true, fence: [] }) });
    expect(await enrolled(message())).toEqual({ handled: false });
    expect(await tasksOf(r)).toBe(0);
  });

  it("a refusal of the core is told in the thread in Cloud's words and never escapes, so the queue does not retry it", async () => {
    const { consume } = await consumer({}, "ghost");
    const answer = await consume(message());
    expect(answer).toEqual({ handled: true, reply: "project `ghost` doesn't exist in this AgentX" });
  });

  it("a fault that is not a refusal still fails the call, so a transient fault is retried", async () => {
    const r = rig();
    const consume = createCoreSlackConsumer({ taskStop: notEnrolled, app: { ...r.app, active: true, flags: r.app.flags, runtimeFor: async () => ({ flow: { deps: { store: { put: async () => ({ applied: true }) } } }, inbound: { slack: async () => { throw new Error("boom"); } } }) } as never, orgOfTeam: async () => FAKE_COMPANY, log: () => undefined });
    await expect(consume(message())).rejects.toThrow("boom");
    const unavailable = createCoreSlackConsumer({ taskStop: notEnrolled, app: { ...r.app, active: true, flags: r.app.flags, runtimeFor: async () => ({ flow: { deps: { store: { put: async () => ({ applied: true }) } } }, inbound: { slack: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "down"); } } }) } as never, orgOfTeam: async () => FAKE_COMPANY, log: () => undefined });
    await expect(unavailable(message())).rejects.toBeInstanceOf(AgentXError);
  });

  it("is Cloud's (handled false) with the switch off, for a team no company is bound to, for another company's team, and when the root cannot be built", async () => {
    expect(await (await consumer({ env: {} })).consume(message())).toEqual({ handled: false });
    const unbound = await consumer();
    expect(await createCoreSlackConsumer({ taskStop: notEnrolled, app: unbound.r.app, orgOfTeam: async () => undefined, log: () => undefined })(message())).toEqual({ handled: false });
    const elsewhere = await consumer({ env: { CLOUD_CORE_ENGINE: `on:${OTHER_COMPANY}` } });
    expect(await elsewhere.consume(message())).toEqual({ handled: false });
    expect(await tasksOf(elsewhere.r).catch(() => 0)).toBe(0);
    expect(await (await consumer({ without: ["queue"] })).consume(message())).toEqual({ handled: false });
  });

  it("a person who is not a member starts nothing and the request is still the core's (the account is told how to link)", async () => {
    const { r, consume } = await consumer({ member: false });
    expect(await consume(message())).toEqual({ handled: true });
    expect(await tasksOf(r)).toBe(0);
  });
});

describe("S3-4 b: the ingress's half", () => {
  const reply = (body: unknown, statusCode = 200) => ({ statusCode, body: JSON.stringify(body) });
  const thread = { teamId: TENANT, channelId: SPACE, threadTs: THREAD };
  const message = { version: 1, eventId: "EvAbcd1234", thread, userId: "U0MAYA", text: "hi", receivedAt: "2026-11-12T10:00:00.000Z" } as never;

  it("is nothing while the switch is off: the ingress wires no hook and behaves as before", () => {
    expect(coreSlackFromIngress({ env: {}, active: false, invokeBroker: async () => reply({}), post: async () => undefined })).toBeUndefined();
  });

  it("asks the broker; a request the core took is not queued, and its refusal is posted in the thread", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const posted: string[] = [];
    const via = coreSlackFromIngress({ env: {}, active: true, invokeBroker: async (event) => { sent.push(event); return reply({ handled: true, reply: "no project" }); }, post: async (_thread, text) => { posted.push(text); } })!;
    expect(await via(message)).toBe(true);
    expect(sent[0]).toMatchObject({ source: "agentx.slack-ingress", action: CORE_SLACK_ACTION });
    expect(posted).toEqual(["no project"]);
  });

  it("a request that is Cloud's is queued as before (false), with nothing posted", async () => {
    const posted: string[] = [];
    const via = coreSlackFromIngress({ env: {}, active: true, invokeBroker: async () => reply({ handled: false }), post: async (_t, text) => { posted.push(text); } })!;
    expect(await via(message)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("a failed broker call fails the ingress, which releases the event for Slack's retry", async () => {
    const via = coreSlackFromIngress({ env: {}, active: true, invokeBroker: async () => reply({}, 500), post: async () => undefined })!;
    await expect(via(message)).rejects.toThrow();
  });

  it("the broker recognises only the ingress's own event", () => {
    expect(isCoreSlackRequestEvent({ source: "agentx.slack-ingress", action: CORE_SLACK_ACTION, message: {} })).toBe(true);
    expect(isCoreSlackRequestEvent({ source: "agentx.slack-ingress", action: CORE_SLACK_ACTION, message: {}, requestContext: {} })).toBe(false);
    expect(isCoreSlackRequestEvent({ source: "someone", action: CORE_SLACK_ACTION, message: {} })).toBe(false);
    expect(isCoreSlackRequestEvent({ source: "agentx.slack-ingress", action: "start-workflow", message: {} })).toBe(false);
  });
});

describe("S3-4 c: the Lambda entry", () => {
  const sources = (env: NodeJS.ProcessEnv, moduleDeps: () => never) => ({
    env, broker: { documentClient: { send: async (command: { input?: { Key?: { pk?: string; sk?: string } } }) => (command.input?.Key?.pk === orgMetaKey(FAKE_COMPANY).pk && command.input.Key.sk === orgMetaKey(FAKE_COMPANY).sk ? { Item: { ...command.input.Key, orgId: FAKE_COMPANY } } : {}) }, tableName: "state", callbackSigningKey: "k".repeat(32), repositoryGrants: {} } as never, routes: () => undefined, now: () => new Date("2026-11-13T10:00:00.000Z"), log: () => undefined,
    inputs: { moduleDeps, sessionFacts: { read: async () => undefined } }, installCompanyId: FAKE_COMPANY as never,
  });

  it("with the switch off the entry is inert for new work: nothing is asked for or built, a start and a Slack request are Cloud's, and a job with no core task to serve is skipped", async () => {
    let asked = 0;
    const entry = createCloudCoreEntry(sources({}, () => { asked += 1; return {} as never; }))!;
    expect(entry).toBeDefined();
    expect(await entry.intentHook.start({ caller: { orgId: FAKE_COMPANY, developerId: MAYA } as never, request: intent(), ownedTask })).toBeUndefined();
    expect(await entry.slackRequest({ version: 1, eventId: "EvAbcd1234", thread: { teamId: TENANT, channelId: SPACE, threadTs: THREAD }, userId: "U0MAYA", text: "hi", receivedAt: "2026-11-12T10:00:00.000Z" } as never)).toEqual({ handled: false });
    expect(await entry.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" })).toEqual({ skipped: "off" });
    expect(await entry.routeCallback({ method: "POST", path: `/v1/internal/workspaces/${randomUUID()}/operations/${randomUUID()}/events`, headers: {} })).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("with the switch on but an input missing, the first use says why and the start stays on Cloud's path", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const entry = createCloudCoreEntry({ ...sources({ CLOUD_CORE_ENGINE: "on" }, () => { throw new TypeError("no clients"); }), log: (entry) => logs.push(entry) })!;
    expect(await entry.intentHook.start({ caller: { orgId: FAKE_COMPANY, developerId: MAYA } as never, request: intent(), ownedTask })).toBeUndefined();
    expect(logs.filter((entry) => entry["event"] === "core_entry.not_configured").length).toBeGreaterThan(0);
  });

  it("with the switch on it answers the core's scheduled jobs and leaves every other event alone; a job that cannot run fails alone", async () => {
    const entry = createCloudCoreEntry(sources({ CLOUD_CORE_ENGINE: "on:" + FAKE_COMPANY }, () => ({ tableName: "state" }) as never))!;
    expect(entry).toBeDefined();
    expect(entry.isScheduledJob({ source: "agentx.core-job", job: "merge-tracking" })).toBe(true);
    expect(entry.isScheduledJob({ source: "aws.events" })).toBe(false);
    expect(await entry.handleScheduledJob({ source: "aws.events" })).toBeUndefined();
    expect(await entry.handleScheduledJob({ source: "agentx.core-job", job: "nobody-knows" })).toEqual({ skipped: "unknown_job" });
    // The deployment's clients are not given, so the registry cannot be built: the run is reported failed for the company, never thrown.
    const ran = await entry.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }) as { companies: Array<{ outcome: string }> };
    expect(ran.companies.map((company) => company.outcome)).toEqual(["failed"]);
    // And the same unbuildable root leaves a start on Cloud's path.
    expect(await entry.intentHook.start({ caller: { orgId: FAKE_COMPANY, developerId: MAYA } as never, request: intent(), ownedTask })).toBeUndefined();
  });
});

describe("S3-4 d: the lighter-flow setting is a packed setting a deployment can set", () => {
  it("is `lf`, read as LIGHTER_FLOW_ENABLED by the root's settings mapping, and no two settings share a code", () => {
    expect(BROKER_SETTINGS.lighterFlow).toEqual({ code: "lf", variable: "LIGHTER_FLOW_ENABLED" });
    const codes = Object.values(BROKER_SETTINGS).map((spec) => spec.code);
    const repeated = codes.filter((code, index) => codes.indexOf(code) !== index);
    // `ak` and `pe` were already shared before this change; the new code must not add to them.
    expect(repeated.filter((code) => code === "lf")).toEqual([]);
    expect(cloudSettingsFromEnvironment({ [BROKER_SETTINGS.lighterFlow.variable]: "false" }, { recipeStepKinds: undefined, connectorWritesBehindApproval: false }).lighterFlow).toBe(false);
    expect(cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: false }).lighterFlow).toBe(true);
  });
});

describe("S3-4 f: Cloud's own rules for the core, from the broker's dependencies", () => {
  const FakeDb = (async () => (await import("../support/fake-dynamodb.js")).FakeDynamoDb);
  const wiringOver = async (routes?: unknown) => {
    const db = new (await FakeDb())();
    const wiring = cloudCoreWiringFromBroker({
      env: {}, now: () => new Date("2026-11-13T10:00:00.000Z"), log: () => undefined, routes: () => routes as never,
      broker: { documentClient: db, tableName: "state", callbackSigningKey: "k".repeat(32), repositoryGrants: {} } as never,
      inputs: { moduleDeps: () => ({}) as never, sessionFacts: { read: async () => undefined } },
    });
    return { db, wiring };
  };

  it("code settings are the project's own item, read fresh, else Cloud's defaults", async () => {
    const { db, wiring } = await wiringOver();
    const org = FAKE_COMPANY as never;
    const before = await wiring.codeSettings.read(org, "payments");
    expect(before).toEqual(DEFAULT_CODE_SETTINGS);
    db.set({ ...codeSettingsKey(org, "payments"), entityType: "CODE_SETTINGS", allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 3 });
    expect(await wiring.codeSettings.read(org, "payments")).toMatchObject({ allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 3 });
  });

  it("the end of a task is read from the task's own record", async () => {
    const { db, wiring } = await wiringOver();
    expect(await wiring.taskEnd.readTask("t-1")).toBeUndefined();
    db.set({ pk: "DEVTASK#t-1", sk: "META", entityType: "DEVTASK", orgId: FAKE_COMPANY, taskId: "t-1" });
    expect(await wiring.taskEnd.readTask("t-1")).toMatchObject({ taskId: "t-1" });
  });

  it("an unlinked Slack account is told what Cloud tells it today, never a link code", async () => {
    const { wiring } = await wiringOver();
    expect(wiring.slack!.linkWords("ABCD-1234")).toBe(SLACK_NOT_A_MEMBER_NOTICE);
    expect(wiring.slack!.linkWords("ABCD-1234")).not.toContain("ABCD-1234");
  });

  it("task access: a person who cannot be found as a member of the company starts nothing and acts on nothing (the rules themselves are in cloud-app-task-access.test.ts)", async () => {
    const { wiring } = await wiringOver({ agents: undefined });
    const principal = (personId: string, roles: string[]) => ({ companyId: FAKE_COMPANY, personId, roles }) as never;
    expect(await wiring.access.checkStart(principal(MAYA, ["member"]), "payments")).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(await wiring.access.canAct(principal(MAYA, ["owner"]), { developerId: MAYA, project: "payments", taskId: randomUUID() } as never)).toBe(false);
    expect(await wiring.access.canAct(principal(MAYA, ["owner"]), { developerId: MAYA, project: "payments" })).toBe(false);
    expect(await wiring.access.checkStep({ taskId: randomUUID(), developerId: MAYA, project: "payments", orgId: FAKE_COMPANY } as never)).toMatchObject({ allowed: false });
  });

  it("S3-9 review M2: the reviewer (and so the lighter flow) is given only with TIER_REVIEW_ENABLED=1; without it the broker's root gets no reviewer, even with the reviewer call, routing and ledger", async () => {
    const db = new (await FakeDb())();
    const access = { reviewCompletion: async () => ({ text: "[]", model: "m" }) };
    const broker = { documentClient: db, tableName: "state", callbackSigningKey: "k".repeat(32), repositoryGrants: {}, agents: {}, modelAccess: { access, proxyUrl: "" }, cloud: true } as never;
    const wiringWith = (env: NodeJS.ProcessEnv) => cloudCoreWiringFromBroker({ env, now: () => new Date(), log: () => undefined, routes: () => undefined, broker, inputs: { moduleDeps: () => ({}) as never, sessionFacts: { read: async () => undefined } } });
    for (const env of [{}, { TIER_REVIEW_ENABLED: "0" }, { LEARNING_COMPLETION_ENABLED: "1" }, { TEAM_RECORD_ENABLED: "1" }]) expect(wiringWith(env).tierReview!(FAKE_COMPANY as never), JSON.stringify(env)).toBeUndefined();
    const ports = wiringWith({ TIER_REVIEW_ENABLED: "1" }).tierReview!(FAKE_COMPANY);
    expect(ports).toBeDefined();
    expect(typeof ports!.calls.claim).toBe("function");
  });

  it("the settings carry what Cloud knows: the connector writes behind approval, the install's workspace limits, the pinned recipe", async () => {
    const db = new (await FakeDb())();
    const wiring = cloudCoreWiringFromBroker({
      env: { AGENTX_ROVARA_CODE_V2_ENABLED: "true" }, now: () => new Date(), log: () => undefined, routes: () => undefined,
      broker: { documentClient: db, tableName: "state", callbackSigningKey: "k".repeat(32), repositoryGrants: {}, slack: { orchestratorRoleArn: "arn", memberWorkspaceLimit: 4, organizationWorkspaceLimit: 40 } } as never,
      inputs: { moduleDeps: () => ({}) as never, sessionFacts: { read: async () => undefined }, recipeStepKinds: () => ["plan_critic"] },
    });
    expect(wiring.settings(FAKE_COMPANY as never)).toMatchObject({ rovaraCodeV2Live: true, recipeStepKinds: ["plan_critic"], connectorWritesBehindApproval: true, workspaceLimits: { member: 4, organization: 40 } });
  });
});
