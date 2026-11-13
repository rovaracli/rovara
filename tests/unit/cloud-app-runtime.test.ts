// S3 items 1, 4, 5 and 6: the company's core runtime composed from Code's service factories over Cloud's adapters (cloud/app/runtime.ts). Driven through `createCloudApp`, so the jobs
// run the real services over a fake world's store and the real Cloud adapter modules the world registers.
import { describe, expect, it } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import { fixedCodeSettings, soleOwnerPeople } from "@rovara-code/broker/core/merge";
import { localOwnerPrincipal } from "@rovara-code/broker/ports";
import type { Approvers } from "@rovara-code/contracts";
import { when } from "@rovara-code/contracts";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import {
  CORE_JOBS, cloudActorFor, cloudAdapter, cloudCoreRuntime, cloudSettingsFromEnvironment, createCloudApp, scheduleEventOf, type CloudApp, type CloudCoreWiring,
} from "../../packages/broker/src/cloud/app/index.js";
import { bindChannelSpace, decisionRefusalWords, postApprovalCard } from "@rovara-code/broker/core/channel";
import { STANDING_ROLE_PREFIX } from "../../packages/broker/src/cloud/adapters/people/methods.js";
import { CloudSlackChannel } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { createCloudAdmission } from "../../packages/broker/src/cloud-adapters/money/index.js";
import { CORE_ADMISSION_ACTIONS } from "../../packages/broker/src/cloud/app/cloud-modules.js";
import { cloudRefusalWords } from "../../packages/broker/src/cloud/app/refusal-words.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const MAYA = "a".repeat(64);
const PROJECT = (url: string): ProjectDefinition => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

async function registerProject(world: FakeWorld): Promise<void> {
  const project = PROJECT(world.hostModel.url);
  await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
}

interface Harness { world: FakeWorld; app: CloudApp; ended: Array<{ task: Record<string, unknown>; outcome: string }>; logs: Array<Record<string, unknown>> }

function harness(options: { slack?: boolean; wiring?: Partial<CloudCoreWiring>; slackFetch?: typeof fetch; approvers?: Approvers; settingsEnv?: Record<string, string> } = {}): Harness {
  const world = createFakeWorld();
  // The real Cloud admission adapter (not the recording wrapper), so the hold sweep is the adapter's own.
  const admission = cloudAdapter({
    point: "admission", name: "cloud", lane: "A5",
    create: () => createCloudAdmission({ store: world.store, levels: async () => [], actions: CORE_ADMISSION_ACTIONS, words: cloudRefusalWords, now: () => world.clock.now }),
  });
  const slack = cloudAdapter({ point: "channel", name: "slack", lane: "A8", create: () => new CloudSlackChannel({ projects: ["payments"], botToken: async () => "unused", serves: async () => true, fetch: options.slackFetch ?? ((async () => new Response("{}"))) }) });
  const approvers = options.approvers === undefined ? undefined : cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => options.approvers! });
  const modules = [...world.modules.map((module) => (module.point === "admission" ? admission : module.point === "approvers" && approvers !== undefined ? approvers : module)), ...(options.slack === true ? [slack] : [])];
  const ended: Harness["ended"] = [];
  const logs: Harness["logs"] = [];
  const wiring: CloudCoreWiring = {
    settings: () => cloudSettingsFromEnvironment(options.settingsEnv ?? {}, { recipeStepKinds: undefined, connectorWritesBehindApproval: false }),
    callbackSigningKey: Buffer.alloc(32, 7), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), access: createOwnerTaskAccess(),
    now: () => new Date(world.clock.now), log: (entry) => logs.push(entry),
    people: soleOwnerPeople, codeSettings: fixedCodeSettings(),
    taskEnd: {
      readTask: async (taskId) => await world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }),
      onTaskEnded: async (task, outcome) => { ended.push({ task, outcome }); },
    },
    sessionFacts: { read: async () => undefined },
    ...options.wiring,
  };
  const app = createCloudApp({ env: { CLOUD_CORE_ENGINE: "on" }, modules, context: () => world.context(), nowMs: () => world.clock.now, runtime: cloudCoreRuntime(wiring) });
  return { world, app, ended, logs };
}

const run = async (app: CloudApp, name: string) => {
  const job = CORE_JOBS.find((entry) => entry.name === name)!;
  const result = await app.handleScheduledJob(scheduleEventOf(job));
  const companies = (result as { companies: Array<{ outcome: string; report?: Record<string, unknown>; error?: string }> }).companies;
  return companies[0]!;
};

describe("S3 item 1: the services are Code's factories, wired by the root", () => {
  it("every required job runs a real service for the company (none is `service_not_wired`)", async () => {
    const { app } = harness();
    for (const name of ["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"]) {
      const company = await run(app, name);
      expect(company.outcome, `${name} ${String(company.error)}`).toBe("ran");
      expect(company.report, name).not.toHaveProperty("skipped", "service_not_wired");
    }
  });

  it("merge tracking's sweep is Code's: it reports how many rows it attempted", async () => {
    expect((await run(harness().app, "merge-tracking")).report).toEqual({ attempted: 0 });
  });

  it("the session sweep is Code's: it reports visited, updated, failed and whether it finished", async () => {
    expect((await run(harness().app, "session-sweep")).report).toMatchObject({ visited: 0, updated: 0, failed: 0, complete: true });
  });

  it("the hold sweep is the admission adapter's own and says how many holds it charged", async () => {
    expect((await run(harness().app, "admission-hold-sweep")).report).toEqual({ charged: 0 });
  });

  it("notify-deliver tells nobody when no chat or email adapter is registered, and says so", async () => {
    expect((await run(harness().app, "notify-deliver")).report).toEqual({ skipped: "nobody_can_be_told" });
  });

  it("the automation-stop job is skipped until the deployment gives the chain runner's and the unattended door's dependencies", async () => {
    expect((await run(harness().app, "automation-stop")).report).toEqual({ skipped: "service_not_wired" });
  });
});

describe("S3 item 5: the end of a core task by a merge reaches Cloud's end handlers", () => {
  it("a `merged` milestone, delivered through the runtime's milestone service, records the end as merged, once per delivery", async () => {
    const { world, app, ended } = harness();
    await registerProject(world);
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const milestones = runtime.flow.deps.milestones!;
    const taskId = "11111111-1111-4111-8111-111111111111";
    await world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVTASK", companyId: FAKE_COMPANY, taskId } });
    const items = milestones.items({ kind: "merged", orgId: FAKE_COMPANY, taskId, at: new Date(world.clock.now).toISOString(), text: "The pull request was merged." }, 1);
    expect((await world.store.transact(items)).applied).toBe(true);
    await milestones.deliver(taskId);
    expect(ended.map((entry) => [entry.outcome, entry.task["taskId"], entry.task["orgId"]])).toEqual([["merged", taskId, FAKE_COMPANY]]);
  });

  it("the flow starts ordered work plans on a 1.0.0 task only where Cloud's switch says so: the root's settings mapping reaches it (G3)", async () => {
    expect((await harness().app.runtimeFor(FAKE_COMPANY)).flow.deps.workflowDependenciesEnabled).toBe(false);
    const on = harness({ settingsEnv: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" } });
    expect((await on.app.runtimeFor(FAKE_COMPANY)).flow.deps.workflowDependenciesEnabled).toBe(true);
  });

  it("the flow tells the same handler of a close (taskEnded is the root's, not unset)", async () => {
    const { app } = harness();
    expect((await app.runtimeFor(FAKE_COMPANY)).flow.deps.taskEnded).toBeTypeOf("function");
  });
});

describe("S3 item 4: Slack inbound goes through the root into the core", () => {
  const TENANT = "T0TEAM";
  const SPACE = "C0CHAN";
  const conversation = { channel: "slack", tenant: TENANT, space: SPACE, thread: "1695500000.000001" } as const;
  const request = (text: string, eventId: string) => ({ version: 1, eventId, thread: { teamId: TENANT, channelId: SPACE, threadTs: "1695500000.000001" }, userId: "U0MAYA", text, receivedAt: "2026-11-12T10:00:00.000Z" }) as never;
  const slackWiring = (member: boolean): Partial<CloudCoreWiring> => ({
    slack: {
      orgOfTeam: async () => FAKE_COMPANY, standingOf: async () => { if (!member) throw new Error("not a member"); return MAYA; },
      principalOf: async (orgId) => localOwnerPrincipal({ companyId: orgId }), linkWords: () => "Link your account in Rovara first.",
    },
  });
  const posts: string[] = [];
  const slackOver = async (member: boolean) => {
    posts.length = 0;
    const h = harness({ slack: true, wiring: slackWiring(member), slackFetch: (async (_url: string, init: { body: string }) => { posts.push(String(init.body)); return new Response(JSON.stringify({ ok: true, ts: "1695500000.000009", channel: SPACE })); }) as never });
    await registerProject(h.world);
    await bindChannelSpace({ store: h.world.store, orgId: FAKE_COMPANY, now: () => h.world.clock.now }, { channel: "slack", tenant: TENANT, space: SPACE }, "payments");
    const runtime = await h.app.runtimeFor(FAKE_COMPANY);
    const caller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test" };
    return { ...h, runtime, tasks: async () => (await runtime.flow.list(caller)).tasks.length };
  };

  it("a member's queued message starts a task on the core, and the same event again starts nothing new", async () => {
    const { runtime, tasks } = await slackOver(true);
    expect(runtime.inbound.slack).toBeTypeOf("function");
    await runtime.inbound.slack!(request("quick: Add a greet function", "EvOne"));
    expect(await tasks()).toBe(1);
    await runtime.inbound.slack!(request("quick: Add a greet function", "EvOne"));
    expect(await tasks()).toBe(1);
  });

  it("someone who is not a member starts nothing (the account is told how to link)", async () => {
    const { runtime, tasks } = await slackOver(false);
    await runtime.inbound.slack!(request("quick: Add a greet function", "EvTwo"));
    expect(await tasks()).toBe(0);
    expect(posts.join("\n")).toContain("Link your account in Rovara first.");
  });

  it("the sink is pinned to the runtime's own company: a Slack team bound to another company starts nothing here, and no card goes to it", async () => {
    const h = harness({ slack: true, wiring: { slack: { ...slackWiring(true).slack!, orgOfTeam: async () => "org_s3other000000000000z" } } });
    await registerProject(h.world);
    await bindChannelSpace({ store: h.world.store, orgId: FAKE_COMPANY, now: () => h.world.clock.now }, { channel: "slack", tenant: TENANT, space: SPACE }, "payments");
    // The channel is bound under the other company too, so only the pin stands between the message and a task.
    await bindChannelSpace({ store: h.world.store, orgId: "org_s3other000000000000z", now: () => h.world.clock.now }, { channel: "slack", tenant: TENANT, space: SPACE }, "payments");
    const runtime = await h.app.runtimeFor(FAKE_COMPANY);
    await runtime.inbound.slack!(request("quick: Add a greet function", "EvPin"));
    expect((await runtime.flow.list({ principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test" })).tasks).toHaveLength(0);
  });

  it("with no Slack adapter registered, or no Slack wiring, there is no inbound", async () => {
    for (const none of [await harness({ wiring: slackWiring(true) }).app.runtimeFor(FAKE_COMPANY), await harness({ slack: true }).app.runtimeFor(FAKE_COMPANY)]) {
      expect(none.inbound.slack).toBeUndefined();
      expect(none.inbound.slackSink).toBeUndefined();
    }
  });

  const press = (requestId: string, digest: string, decision: "APPROVE" | "REJECT") => ({
    version: 1, channel: "slack", eventId: `EvP${requestId.slice(0, 8)}${decision}`, conversation, actor: { channel: "slack", tenant: TENANT, userId: "U0MAYA" },
    requestId, expectedRevision: 1, artifactDigest: digest, decision, reason: "fine", receivedAt: "2026-11-12T10:00:00.000Z",
  }) as never;

  async function card(over: Awaited<ReturnType<typeof slackOver>>, risk: "low" | "medium" | "high") {
    const adapter = (await over.app.registry()).get("channel", "slack")!;
    const digest = "d".repeat(64);
    const posted = await postApprovalCard({ store: over.world.store, orgId: FAKE_COMPANY, now: () => over.world.clock.now, companyOf: async () => FAKE_COMPANY },
      { channel: "slack", adapter, conversation, kind: "plan_approval", subject: { type: "workflow-document", id: "11111111-1111-4111-8111-111111111111" }, revision: 1, artifactDigest: digest, risk, text: "The plan is ready.", actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REQUEST_CHANGES", label: "Ask for changes" }] });
    return { requestId: posted.requestId, digest };
  }

  it("a high plan's card has no Approve in the thread, and a press of Approve on it is refused as a step-up (the task page, with a fresh sign-in)", async () => {
    const over = await slackOver(true);
    const high = await card(over, "high");
    expect(posts.join("\n")).not.toContain("Approve");
    posts.length = 0;
    await over.runtime.inbound.slackSink!.decision(press(high.requestId, high.digest, "APPROVE"));
    expect(posts.join("\n")).toContain(decisionRefusalWords("step_up"));
  });

  it("a medium plan's card has Approve, and a press of it is not refused as a step-up: it reaches Code's decision gate", async () => {
    const over = await slackOver(true);
    const medium = await card(over, "medium");
    expect(posts.join("\n")).toContain("Approve");
    posts.length = 0;
    await over.runtime.inbound.slackSink!.decision(press(medium.requestId, medium.digest, "APPROVE"));
    expect(posts.join("\n")).not.toContain(decisionRefusalWords("step_up"));
    // The gate answered (the task behind this card does not exist, so it refuses in its own words, not the step-up's).
    expect(posts.length).toBeGreaterThan(0);
  });
});

describe("S3: who decides as the task's owner is Cloud's rule (cloudActorFor)", () => {
  const OTHER = "b".repeat(64);
  const standing = (role: string, personId = OTHER) => ({ personId, roles: ["admin", `${STANDING_ROLE_PREFIX}${role}`] });
  const quick = { ownerId: "o".repeat(64), path: "QUICK" as const };
  const full = (reviewPhase: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN") => ({ ownerId: "o".repeat(64), path: "FULL" as const, reviewPhase });

  it("an owner and a co-owner decide as TASK_OWNER under the owner's id; a maintainer as PROJECT_ADMIN under their own", () => {
    expect(cloudActorFor(standing("owner"), quick)).toEqual({ actorId: quick.ownerId, role: "TASK_OWNER" });
    expect(cloudActorFor(standing("co-owner"), quick)).toEqual({ actorId: quick.ownerId, role: "TASK_OWNER" });
    expect(cloudActorFor(standing("maintainer"), quick)).toEqual({ actorId: OTHER, role: "PROJECT_ADMIN" });
  });

  it("a maintainer decides the coding plan only, never the requirements or the design of a Full task; an owner decides each", () => {
    expect(cloudActorFor(standing("maintainer"), full("IMPLEMENTATION_PLAN"))).toEqual({ actorId: OTHER, role: "PROJECT_ADMIN" });
    expect(cloudActorFor(standing("maintainer"), full("REQUIREMENTS"))).toBeUndefined();
    expect(cloudActorFor(standing("maintainer"), full("DESIGN"))).toBeUndefined();
    expect(cloudActorFor(standing("owner"), full("DESIGN"))).toEqual({ actorId: quick.ownerId, role: "TASK_OWNER" });
  });

  it("every other standing, an approver with none named, a company role alone, and an id the engine does not know are nobody", () => {
    for (const role of ["contributor", "collaborator", "viewer", "none", "something-new"]) expect(cloudActorFor(standing(role), quick), role).toBeUndefined();
    expect(cloudActorFor({ personId: OTHER, roles: ["owner"] }, quick)).toBeUndefined();
    expect(cloudActorFor({ personId: "not-a-developer-id", roles: [`${STANDING_ROLE_PREFIX}owner`] }, quick)).toBeUndefined();
  });
});

describe("S3 item 4: a Slack press carries Cloud's chat method, never a stronger one", () => {
  it("a medium plan pressed in Slack reaches the approvers with the chat-slack method (the one Cloud's rules refuse for a high plan)", async () => {
    const proofs: Array<{ method: string; risk: string | undefined; outcome: string | undefined }> = [];
    const approvers: Approvers = {
      requirement: async () => ({ methods: ["chat-slack"], minApprovers: 1, selfApprovalAllowed: true, strongMethods: ["browser-step-up"], rejectMethods: ["chat-slack"], changesMethods: ["chat-slack"] }),
      verify: async (request, proof) => { proofs.push({ method: proof.method, risk: request.risk, outcome: request.outcome }); return { approved: false, reason: "recorded only" }; },
    };
    const SUBJECT = "s3-test-subject";
    const subject = {
      kind: SUBJECT,
      load: async () => ({ key: { pk: "S3TEST", sk: "SUBJECT" }, guard: when.absent(), waiting: true, request: { kind: "plan", subject: { type: SUBJECT, id: "x" }, revision: 1, artifactDigest: "d".repeat(64), risk: "medium" as const }, state: {} }),
      apply: () => ({ ops: [] }),
    };
    const ok = (async () => new Response(JSON.stringify({ ok: true, ts: "1695500000.000009", channel: "C0CHAN" }))) as never;
    const h = harness({ slack: true, approvers, slackFetch: ok, wiring: { decisionSubjects: [subject], slack: { orgOfTeam: async () => FAKE_COMPANY, standingOf: async () => MAYA, principalOf: async (orgId) => localOwnerPrincipal({ companyId: orgId }), linkWords: () => "x" } } });
    await bindChannelSpace({ store: h.world.store, orgId: FAKE_COMPANY, now: () => h.world.clock.now }, { channel: "slack", tenant: "T0TEAM", space: "C0CHAN" }, "payments");
    const runtime = await h.app.runtimeFor(FAKE_COMPANY);
    const conversation = { channel: "slack", tenant: "T0TEAM", space: "C0CHAN", thread: "1695500000.000001" } as const;
    const adapter = (await h.app.registry()).get("channel", "slack")!;
    const posted = await postApprovalCard({ store: h.world.store, orgId: FAKE_COMPANY, now: () => h.world.clock.now, companyOf: async () => FAKE_COMPANY },
      { channel: "slack", adapter, conversation, kind: "plan_approval", subject: { type: SUBJECT, id: "x" }, revision: 1, artifactDigest: "d".repeat(64), risk: "medium", text: "ready", actions: [{ decision: "APPROVE", label: "Approve" }] });
    await runtime.inbound.slackSink!.decision({
      version: 1, channel: "slack", eventId: "EvPressOne", conversation, actor: { channel: "slack", tenant: "T0TEAM", userId: "U0MAYA" }, requestId: posted.requestId,
      expectedRevision: 1, artifactDigest: "d".repeat(64), decision: "APPROVE", reason: "fine", receivedAt: "2026-11-12T10:00:00.000Z",
    } as never);
    expect(proofs).toEqual([{ method: "chat-slack", risk: "medium", outcome: "approve" }]);
  });
});
