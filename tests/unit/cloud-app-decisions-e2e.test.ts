// S3 review fixes F1 and F3: a decision on a task of THIS root goes through the REAL A6 adapters (createCloudApprovers over cloudApprovalIssuers, over Cloud's people) and Code's real decision
// gate and workflow subject (the root's `createDecisionService`), on a task the core's flow really started and planned. Who decides as the task's owner is `cloudActorFor`, fed by the
// standing the approvers adapter read and put on the verified approver. The decider's LIVE standing on a task is read by `deciderRole`, which Cloud has no reader for on the core path
// yet (DEFERRED S3-CLOUD-WIRING-INPUTS): the test gives the same fixed standing the parity suite does.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskAccess } from "@rovara-code/broker/core/task-flow";
import { orgProjectCatalogKey, projectMemberKey, projectRevisionKey, type ApprovalDeciderRole as _Unused, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import type { ApprovalDeciderRole } from "@agentx/cloud-contracts";
import { fixedCodeSettings, soleOwnerPeople } from "@rovara-code/broker/core/merge";
import {
  cloudAdapter, cloudCoreRuntime, cloudSettingsFromEnvironment, createCloudApp, slackPressToken, type CloudApp, type CloudCoreWiring,
} from "../../packages/broker/src/cloud/app/index.js";
import { BROWSER_SESSION_METHOD, CHAT_SLACK_METHOD, cloudApprovalIssuers, createCloudApprovers, createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { createCallbackService } from "@rovara-code/broker";
import { PEOPLE_ORG, SLACK_TEAM, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";
import { CORE_CALLBACK_ACTIONS, cloudDeciderRole, coreInUseKey, createCoreIntentHook, cloudTaskFacts, createCoreCallbackRouter, engineStampKey } from "../../packages/broker/src/cloud/app/index.js";
import { SEAT_LIMIT_UNAVAILABLE, createSeatLimits } from "../../packages/broker/src/cloud/app/index.js";
import { resolveSlackDecisionCaller } from "../../packages/broker/src/decisions/slack-actions.js";
import { CloudSlackChannel } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { bindChannelSpace, postApprovalCard } from "@rovara-code/broker/core/channel";
import { createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

void (null as unknown as _Unused);
const PROJECT = (url: string): ProjectDefinition => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

const allowAll: TaskAccess = { checkStart: async () => ({ allowed: true }), canAct: async () => true, checkStep: async () => ({ allowed: true }) };

interface Rig { world: FakeWorld; people: PeopleWorld; app: CloudApp; standing: Map<string, ApprovalDeciderRole>; posts: string[]; /** Another root over the same world, adapters and wiring (a later Lambda container, with the switch changed). */ rebuild(options: { env: NodeJS.ProcessEnv; serveStamped?: boolean }): CloudApp }

async function rig(options: { slack?: boolean; liveRole?: boolean } = {}): Promise<Rig> {
  const world = createFakeWorld();
  const people = createPeopleWorld();
  const standing = new Map<string, ApprovalDeciderRole>();
  const approvers = createCloudApprovers({
    issuers: cloudApprovalIssuers({ routes: people.routes, slackLookups: people.slackLookups }),
    deciderRole: options.liveRole === true ? cloudDeciderRole(() => people.routes) : async (_request, decider) => standing.get(decider.developerId) ?? "none",
    place: { documentClient: people.db, tableName: "state", signInTableName: "signin", now: people.now },
  });
  const posts: string[] = [];
  // The real Slack adapter (A8), its Slack calls answered by a recording stand-in for Slack's API.
  const slackAdapter = cloudAdapter({
    point: "channel", name: "slack", lane: "A8",
    create: () => new CloudSlackChannel({ projects: ["payments"], botToken: async () => "unused", serves: async () => true, fetch: (async (_url: string, init: { body: string }) => { posts.push(String(init.body)); return new Response(JSON.stringify({ ok: true, ts: "1695500000.000009", channel: "C0CHAN" })); }) as never }),
  });
  const modules = [...world.modules.map((module) => (module.point === "approvers" ? cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => approvers }) : module)), ...(options.slack === true ? [slackAdapter] : [])];
  const identity = createCloudIdentityProvider(people.routes);
  const wiring: CloudCoreWiring = {
    settings: () => cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: true }),
    callbackSigningKey: Buffer.alloc(32, 7), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), access: allowAll,
    now: () => new Date(world.clock.now), log: () => undefined, people: soleOwnerPeople, codeSettings: fixedCodeSettings(),
    taskEnd: { readTask: async () => undefined, onTaskEnded: async () => undefined }, sessionFacts: { read: async () => undefined },
    slack: { orgOfTeam: async (teamId) => (teamId === SLACK_TEAM ? PEOPLE_ORG : undefined),
      // The Slack account's person is found by A6's own lookups (the linked, signed-in, live member), as the broker's `slackRequesterStanding` finds them in production.
      standingOf: async (_org, slackUserId) => { const member = await resolveSlackDecisionCaller(people.slackLookups(new Map()), { userId: slackUserId, userTeamId: SLACK_TEAM, workspaceTeamId: SLACK_TEAM, enterpriseId: "", userEnterpriseId: "" }); if (member === undefined) throw new Error("not a member"); return member.developerId; }, principalOf: async (orgId, personId) => await identity.getPrincipal(orgId, personId), linkWords: () => "x" },
  };
  const rebuild = (built: { env: NodeJS.ProcessEnv; serveStamped?: boolean }): CloudApp => createCloudApp({ env: built.env, modules, context: () => world.context(), nowMs: () => world.clock.now, runtime: cloudCoreRuntime(wiring), ...(built.serveStamped === true ? { serveStamped: true } : {}) });
  const app = rebuild({ env: { CLOUD_CORE_ENGINE: "on" } });
  const project = PROJECT(world.hostModel.url);
  await world.store.put({ item: { ...projectRevisionKey(PEOPLE_ORG, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(PEOPLE_ORG, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
  return { world, people, app, standing, posts, rebuild };
}

/** Starts a task as the owner and plans it: the fake worker answers the planning job through the real callback service, so the task waits at its plan review. */
async function plannedTask(r: Rig, path: "QUICK" | "FULL" = "QUICK", driver?: CloudApp): Promise<{ taskId: string; owner: Person }> {
  const owner = r.people.people.owner;
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
  const started = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a greeting.", workflow: true, workflowPath: path });
  const taskId = started.task.taskId;
  // The root that drives the rest: the one the task started under, or a later one with the switch off, whose worker callbacks come through the router.
  const drive = driver === undefined ? runtime : await driver.runtimeFor(PEOPLE_ORG);
  const registry = await r.app.registry();
  const direct = createCallbackService({ flow: runtime.flow.deps, blobs: registry.require("object-storage"), grants: { exchange: async () => { throw new Error("unused"); } } });
  const routed = driver === undefined ? undefined : createCoreCallbackRouter(driver, (key) => r.world.store.get(key) as never);
  const callbacks = async (request: Parameters<typeof direct>[0]) => (routed === undefined ? await direct(request) : (await routed(request)) ?? { statusCode: 599, headers: {}, body: "not routed" });
  const store = r.world.store;
  for (let round = 0; round < 6; round += 1) {
    await drive.flow.relayOnce();
    await drive.flow.dispatchOnce({ maxMessages: 5, waitSeconds: 0 });
    await drive.flow.sweepOnce();
    const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    const workflow = task?.workflow as { stage?: string; state?: string } | undefined;
    if (workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING") return { taskId, owner };
    const workspace = await store.get({ pk: `WORKSPACE#${(task as unknown as { workspaceId: string }).workspaceId}`, sk: "META" });
    const machineId = (workspace?.machine as { machineId?: string } | undefined)?.machineId;
    const jobs = machineId === undefined ? [] : r.world.machines.delivered(machineId);
    for (const job of jobs) {
      if (seen.has(job.operationId)) continue;
      seen.add(job.operationId);
      const post = async (action: string, body: unknown) => await callbacks({ method: "POST", path: `/v1/internal/workspaces/${job.workspaceId}/operations/${job.operationId}/${action}`, headers: { "x-agentx-callback-capability": job.callbackCapability, "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = planAnswer(planDocument({ title: "Greeting", why: [{ text: "Asked for.", author: "Maya" }], claims: [{ id: "1", text: "Add a greeting." }], decisions: [] }), { checks: { checks: [], none_reason: "The project's own check covers this change." } });
      expect((await post("artifacts", { name: "plan.md", mediaType: "text/markdown", content: text })).statusCode).toBe(200);
      expect((await post("result", { status: "SUCCEEDED" })).statusCode).toBe(200);
      r.world.machines.finish(machineId!, job.operationId);
    }
  }
  throw new Error("the task never reached its plan review");
}
const seen = new Set<string>();

async function press(r: Rig, taskId: string, who: Person, method: typeof BROWSER_SESSION_METHOD | typeof CHAT_SLACK_METHOD, outcome: "approve" | "reject" = "approve", details?: Record<string, unknown>) {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const gate = runtime.inbound.gate!;
  const found = (await gate.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
  const token = method === CHAT_SLACK_METHOD
    ? slackPressToken({ actor: { channel: "slack", tenant: SLACK_TEAM, userId: who.slackUserId ?? "U0NOBODY01" }, conversation: { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN", thread: "1695500000.000001" } })
    : who.sessionId;
  return await gate.decide({
    companyId: PEOPLE_ORG, kind: "workflow-document", subjectId: taskId, requestId: randomUUID(), outcome, seen: { revision: found.revision, artifactDigest: found.artifactDigest },
    credentials: [{ method, token, claimedAccount: { provider: "slack", tenant: SLACK_TEAM, accountId: who.slackUserId ?? "U0NOBODY01" } }], reason: "fine",
    ...(details === undefined ? {} : { details }),
  });
}

const ownerIdOf = async (r: Rig, taskId: string) => ((await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.workflow as { ownerId: string }).ownerId;
const decisionsOf = async (r: Rig, taskId: string) => ((await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.workflow as { decisions: Array<{ actorId: string; actorRole: string }> }).decisions;

describe("F3: a decision on this root goes through the real A6 adapters and the real gate", () => {
  it("the owner decides as TASK_OWNER, recorded under the owner", async () => {
    const r = await rig();
    r.standing.set(r.people.people.owner.developerId, "owner");
    const { taskId, owner } = await plannedTask(r);
    const answer = await press(r, taskId, owner, BROWSER_SESSION_METHOD);
    expect(answer.status, JSON.stringify(answer)).toBe("decided");
    // The engine knows a task's owner by the id the core gave it at the start (the task's owner key), not by the developer id.
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorId: await ownerIdOf(r, taskId), actorRole: "TASK_OWNER" }]);
  });

  it("a co-owner decides as TASK_OWNER too, recorded under the task's owner (as v2 records it)", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "co-owner");
    const { taskId } = await plannedTask(r);
    expect((await press(r, taskId, maintainer, BROWSER_SESSION_METHOD)).status).toBe("decided");
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorId: await ownerIdOf(r, taskId), actorRole: "TASK_OWNER" }]);
  });

  it("a maintainer decides the coding plan as PROJECT_ADMIN, under their own id", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    expect((await press(r, taskId, maintainer, BROWSER_SESSION_METHOD)).status).toBe("decided");
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorId: maintainer.developerId, actorRole: "PROJECT_ADMIN" }]);
  });

  it("a Full task's requirements document is the owner's alone: the owner and a co-owner decide it, a maintainer does not", async () => {
    const r = await rig();
    const { maintainer, owner } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    r.standing.set(owner.developerId, "owner");
    const { taskId } = await plannedTask(r, "FULL");
    expect(await press(r, taskId, maintainer, BROWSER_SESSION_METHOD)).toMatchObject({ status: "refused", reason: "not_approved", detail: expect.stringContaining("only the task's owner decides the requirements") as string });
    expect(await decisionsOf(r, taskId)).toEqual([]);
    const decided = await press(r, taskId, owner, BROWSER_SESSION_METHOD);
    expect(decided.status, JSON.stringify(decided)).toBe("decided");
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorId: await ownerIdOf(r, taskId), actorRole: "TASK_OWNER" }]);
  });

  it("a co-owner decides the requirements as the owner; a contributor and an approver with no standing do not", async () => {
    const r = await rig();
    const { maintainer, member, owner } = r.people.people;
    r.standing.set(maintainer.developerId, "co-owner");
    r.standing.set(member.developerId, "contributor");
    r.standing.set(owner.developerId, "none");
    const { taskId } = await plannedTask(r, "FULL");
    for (const who of [member, owner]) expect((await press(r, taskId, who, BROWSER_SESSION_METHOD)).status, who.key).toBe("refused");
    expect((await press(r, taskId, maintainer, BROWSER_SESSION_METHOD)).status).toBe("decided");
  });

  it("a contributor, and anyone whose standing is nobody's, is refused and nothing is recorded", async () => {
    const r = await rig();
    const { member, owner } = r.people.people;
    r.standing.set(member.developerId, "contributor");
    r.standing.set(owner.developerId, "none");
    const { taskId } = await plannedTask(r);
    for (const who of [member, owner]) expect((await press(r, taskId, who, BROWSER_SESSION_METHOD)).status, who.key).toBe("refused");
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });

  it("the Auditor is refused whatever their standing says (a reader decides nothing)", async () => {
    const r = await rig();
    const { auditor } = r.people.people;
    r.standing.set(auditor.developerId, "owner");
    const { taskId } = await plannedTask(r);
    expect((await press(r, taskId, auditor, BROWSER_SESSION_METHOD)).status).toBe("refused");
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });

  it("a person of nobody's standing who is not a member is refused at the issuer (a revoked sign-in)", async () => {
    const r = await rig();
    const { revoked } = r.people.people;
    r.standing.set(revoked.developerId, "owner");
    const { taskId } = await plannedTask(r);
    expect((await press(r, taskId, revoked, BROWSER_SESSION_METHOD)).status).toBe("refused");
  });
});

describe("F1: a Slack press carries the token A6's chat-slack issuer reads", () => {
  it("the press token is exactly the issuer's strict press fields, and a linked member's press is approved by the real approvers", async () => {
    const r = await rig();
    const { member } = r.people.people;
    r.people.linkSlack(member);
    r.standing.set(member.developerId, "owner");
    const { taskId } = await plannedTask(r);
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const found = (await runtime.inbound.gate!.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
    // The same bytes the people world builds for a real press.
    const decision = { actor: { channel: "slack", tenant: SLACK_TEAM, userId: member.slackUserId! }, conversation: { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN", thread: "1695500000.000001" } } as never;
    expect(JSON.parse(slackPressToken(decision))).toEqual(JSON.parse(r.people.slackPress(member)));
    // Through the real approvers (the issuer parses the token strictly): a low or medium plan pressed in Slack is accepted when the person is linked.
    const approvers = (await r.app.registry()).require("approvers");
    const request = { companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: randomUUID() }, revision: found.revision, artifactDigest: found.artifactDigest, risk: "low" as const, outcome: "approve" as const };
    const proof = { proofId: randomUUID(), method: CHAT_SLACK_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token: slackPressToken(decision) };
    expect((await approvers.verify(request, proof)).approved).toBe(true);
  });

  it("an unlinked Slack account is refused by the real issuer; once linked the same press is approved (positive control); a press from another workspace is refused by the issuer, not by a mismatched request", async () => {
    const r = await rig();
    const { member } = r.people.people;
    r.standing.set(member.developerId, "owner");
    const approvers = (await r.app.registry()).require("approvers");
    const requestOf = () => ({ companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: randomUUID() }, revision: 2, artifactDigest: "b".repeat(64), risk: "low" as const, outcome: "approve" as const });
    const proofOf = (request: ReturnType<typeof requestOf>, tenant: string) => ({
      proofId: randomUUID(), method: CHAT_SLACK_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest,
      token: slackPressToken({ actor: { channel: "slack", tenant, userId: member.slackUserId! }, conversation: { channel: "slack", tenant, space: "C0CHAN", thread: "1.1" } }),
    });
    const first = requestOf();
    expect((await approvers.verify(first, proofOf(first, SLACK_TEAM))).approved).toBe(false);
    r.people.linkSlack(member);
    const linked = requestOf();
    expect((await approvers.verify(linked, proofOf(linked, SLACK_TEAM))).approved).toBe(true);
    const elsewhere = requestOf();
    const refusal = await approvers.verify(elsewhere, proofOf(elsewhere, "T0ELSEWHR"));
    // Past every check that precedes the issuer (request, revision, digest, method), and refused by it.
    expect(refusal).toEqual({ approved: false, reason: "the proof did not check out with its issuer" });
  });
});

describe("F3: a person who is not a member of the company starts and decides nothing through the real Slack adapter", () => {
  const TENANT = SLACK_TEAM;
  const conversation = { channel: "slack", tenant: TENANT, space: "C0CHAN", thread: "1695500000.000001" } as const;
  const message = (userId: string) => ({ version: 1, eventId: `Ev${randomUUID().replaceAll("-", "").slice(0, 12)}`, thread: { teamId: TENANT, channelId: "C0CHAN", threadTs: conversation.thread }, userId, text: "quick: Add a greeting", receivedAt: "2026-11-12T10:00:00.000Z" }) as never;
  const tasksOf = async (r: Rig, who: Person = r.people.people.member) => (await (await r.app.runtimeFor(PEOPLE_ORG)).flow.list({ principal: (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, who.developerId))!, client: "test" })).tasks.length;

  async function slackRig() {
    const r = await rig({ slack: true });
    await bindChannelSpace({ store: r.world.store, orgId: PEOPLE_ORG, now: () => r.world.clock.now }, { channel: "slack", tenant: TENANT, space: "C0CHAN" }, "payments");
    return r;
  }

  it("a Slack account nobody linked starts no task, and is told so through the adapter", async () => {
    const r = await slackRig();
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    await runtime.inbound.slack!(message("U0MEMBER01"));
    expect(await tasksOf(r)).toBe(0);
    // Said privately to that person alone (the post names the user), in the sink's words with the root's link words.
    expect(r.posts.join("\n")).toContain('"user":"U0MEMBER01"');
    expect(r.posts.join("\n")).toContain("I don't know who you are in Rovara yet.");
  });

  it("once the member's Slack sign-in is linked, the same message starts a task as that person", async () => {
    const r = await slackRig();
    r.people.linkSlack(r.people.people.member);
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    await runtime.inbound.slack!(message("U0MEMBER01"));
    expect(await tasksOf(r)).toBe(1);
  });

  it("a Slack account of a revoked person starts nothing even when linked", async () => {
    const r = await slackRig();
    r.people.linkSlack({ ...r.people.people.revoked, slackUserId: "U0REVOKED1" });
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    await runtime.inbound.slack!(message("U0REVOKED1"));
    for (const who of [r.people.people.member, r.people.people.owner, r.people.people.maintainer]) expect(await tasksOf(r, who), who.key).toBe(0);
    // Told as an unknown person, privately; the revoked sign-in is not a member.
    expect(r.posts.join("\n")).toContain('"user":"U0REVOKED1"');
  });

  it("an unlinked account's press on a card is refused before the gate: nothing is decided", async () => {
    const r = await slackRig();
    r.standing.set(r.people.people.owner.developerId, "owner");
    const { taskId } = await plannedTask(r);
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const found = (await runtime.inbound.gate!.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
    const adapter = (await r.app.registry()).get("channel", "slack")!;
    const posted = await postApprovalCard({ store: r.world.store, orgId: PEOPLE_ORG, now: () => r.world.clock.now, companyOf: async () => PEOPLE_ORG },
      { channel: "slack", adapter, conversation, kind: "plan_approval", subject: { type: "workflow-document", id: taskId }, revision: found.revision, artifactDigest: found.artifactDigest, risk: "low", text: "ready", actions: [{ decision: "APPROVE", label: "Approve" }] });
    await runtime.inbound.slackSink!.decision({
      version: 1, channel: "slack", eventId: "EvPressUnlinked", conversation, actor: { channel: "slack", tenant: TENANT, userId: "U0MEMBER01" }, requestId: posted.requestId,
      expectedRevision: found.revision, artifactDigest: found.artifactDigest, decision: "APPROVE", reason: "fine", receivedAt: "2026-11-12T10:00:00.000Z",
    } as never);
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });
});

describe("switch blocker 8: only the Slack path presents chat-slack", () => {
  it("the gate a client surface is given refuses chat-slack and passes every other method", async () => {
    const r = await rig();
    const { member, owner } = r.people.people;
    r.people.linkSlack(member);
    r.standing.set(member.developerId, "owner");
    r.standing.set(owner.developerId, "owner");
    const { taskId } = await plannedTask(r);
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const found = (await runtime.inbound.gate!.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
    const attemptWith = (method: string, token: string) => ({
      companyId: PEOPLE_ORG, kind: "workflow-document", subjectId: taskId, requestId: randomUUID(), outcome: "approve" as const, seen: { revision: found.revision, artifactDigest: found.artifactDigest },
      credentials: [{ method, token, claimedAccount: { provider: "slack", tenant: SLACK_TEAM, accountId: member.slackUserId! } }], reason: "fine",
    });
    const press = slackPressToken({ actor: { channel: "slack", tenant: SLACK_TEAM, userId: member.slackUserId! }, conversation: { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN", thread: "1.1" } });
    expect(await runtime.inbound.clientGate!.decide(attemptWith(CHAT_SLACK_METHOD, press))).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect(await decisionsOf(r, taskId)).toEqual([]);
    // A forged press made up by a client is the same refusal, whatever it says.
    expect(await runtime.inbound.clientGate!.decide(attemptWith(CHAT_SLACK_METHOD, JSON.stringify({ userId: "U0ANYONE01" })))).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    // Every other method still goes through the client gate to the one gate.
    expect((await runtime.inbound.clientGate!.decide(attemptWith(BROWSER_SESSION_METHOD, owner.sessionId))).status).toBe("decided");
  });

  it("no code in the root presents chat-slack except the Slack work", async () => {
    const directory = join(import.meta.dirname, "../../packages/broker/src/cloud/app");
    const offenders = readdirSync(directory).filter((name) => name.endsWith(".ts") && name !== "slack-work.ts").filter((name) => {
      const code = readFileSync(join(directory, name), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join("\n");
      return /CHAT_SLACK_METHOD|["']chat-slack["']/u.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

describe("switch blocker 4: the decider's standing is read live from Cloud's own records", () => {
  afterEach(() => { delete process.env["DECISION_CARDS_ENABLED"]; });
  /** The core's task row and Cloud's project records are one table in production; here the task row is copied beside the people world's records. */
  async function live(setup: (r: Rig) => void = () => undefined) {
    process.env["DECISION_CARDS_ENABLED"] = "1";
    const r = await rig({ liveRole: true });
    const { taskId } = await plannedTask(r);
    const task = await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    r.people.db.set({ ...task });
    r.people.db.set({ ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", definition: { name: "payments", revision: 1, repositories: [{ name: "demo", url: "https://github.com/acme/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
    r.people.db.set({ ...orgProjectCatalogKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    setup(r);
    return { r, taskId };
  }
  const grant = (r: Rig, who: Person, role: "developer" | "viewer") => r.people.db.set({ ...projectMemberKey(PEOPLE_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", role });

  it("the task's owner decides, as TASK_OWNER", async () => {
    const { r, taskId } = await live();
    // The task's creator is the owner the flow was started for (people world's owner).
    expect((await press(r, taskId, r.people.people.owner, BROWSER_SESSION_METHOD)).status).toBe("decided");
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorRole: "TASK_OWNER" }]);
  });

  it("a project maintainer who is not the owner (a company admin) decides the coding plan as PROJECT_ADMIN", async () => {
    const { r, taskId } = await live();
    const answer = await press(r, taskId, r.people.people.maintainer, BROWSER_SESSION_METHOD);
    expect(answer.status, JSON.stringify(answer)).toBe("decided");
    expect(await decisionsOf(r, taskId)).toMatchObject([{ actorId: r.people.people.maintainer.developerId, actorRole: "PROJECT_ADMIN" }]);
  });

  it("a contributor, a viewer and a member with no grant decide nothing", async () => {
    const { r, taskId } = await live((rig) => grant(rig, rig.people.people.member, "developer"));
    expect((await press(r, taskId, r.people.people.member, BROWSER_SESSION_METHOD)).status).toBe("refused");
    grant(r, r.people.people.member, "viewer");
    expect((await press(r, taskId, r.people.people.member, BROWSER_SESSION_METHOD)).status).toBe("refused");
    r.people.db.delete?.(projectMemberKey(PEOPLE_ORG, r.people.people.member.developerId, "payments") as never);
    expect((await press(r, taskId, r.people.people.member, BROWSER_SESSION_METHOD)).status).toBe("refused");
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });

  it("a person who is revoked or of another company stands nowhere, whatever their old role was", async () => {
    const { r, taskId } = await live();
    for (const who of [r.people.people.revoked, r.people.people.stranger]) expect((await press(r, taskId, who, BROWSER_SESSION_METHOD)).status, who.key).toBe("refused");
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });

  it("the reader's own answers, person by person, now", async () => {
    const { r, taskId } = await live((rig) => grant(rig, rig.people.people.member, "developer"));
    const read = cloudDeciderRole(() => r.people.routes);
    const request = { companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: taskId }, revision: 1, artifactDigest: "b".repeat(64) };
    const decider = (who: Person) => ({ developerId: who.developerId, sessionId: who.sessionId, amr: who.amr, name: who.name, orgId: who.orgId, orgRole: who.role });
    const { owner, maintainer, member, revoked, stranger } = r.people.people;
    expect(await read(request, decider(owner))).toBe("owner");
    expect(await read(request, decider(maintainer))).toBe("maintainer");
    expect(await read(request, decider(member))).toBe("contributor");
    grant(r, member, "viewer");
    expect(await read(request, decider(member))).toBe("viewer");
    expect(await read(request, decider(revoked))).toBe("none");
    expect(await read(request, decider(stranger))).toBe("none");
    // Not a task, another company's request, and an unreadable task are nobody's seat.
    expect(await read({ ...request, subject: { type: "design", id: taskId } }, decider(owner))).toBe("none");
    expect(await read({ ...request, companyId: "org_s3other000000000000z" }, decider(owner))).toBe("none");
    expect(await read({ ...request, subject: { type: "task", id: randomUUID() } }, decider(owner))).toBe("none");
    // With the decision cards off a maintainer who is not the owner has no seat (v2's rollout switch), and reads as nothing.
    delete process.env["DECISION_CARDS_ENABLED"];
    expect(await read(request, decider(maintainer))).toBe("none");
  });
});

describe("switch blocker 5: v2's limits on a maintainer's seat", () => {
  const SEAT = "a project maintainer decides a coding plan only";
  it("a maintainer's decision that accepts a run limit or closes the plan as answered is refused, and nothing is written", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    for (const details of [{ acknowledgedRunLimitUsd: 5 }, { closeAsAnswered: true }]) {
      const answer = await press(r, taskId, maintainer, BROWSER_SESSION_METHOD, "approve", details);
      expect(answer, JSON.stringify(details)).toMatchObject({ status: "refused", detail: expect.stringContaining(SEAT) as string });
    }
    expect(await decisionsOf(r, taskId)).toEqual([]);
  });

  it("the same maintainer's plain approval still decides (the limit is the two details, not the seat)", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    expect((await press(r, taskId, maintainer, BROWSER_SESSION_METHOD, "approve", { selectedOptionalCheckIds: [] })).status).toBe("decided");
  });

  it("the owner's decision with the same details is not stopped by the seat rule (the engine judges it)", async () => {
    const r = await rig();
    const { owner } = r.people.people;
    r.standing.set(owner.developerId, "owner");
    const { taskId } = await plannedTask(r);
    const answer = await press(r, taskId, owner, BROWSER_SESSION_METHOD, "approve", { acknowledgedRunLimitUsd: 5 });
    expect(JSON.stringify(answer)).not.toContain(SEAT);
  });

  it("a co-owner is the owner's seat, and carries no maintainer limit", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "co-owner");
    const { taskId } = await plannedTask(r);
    const answer = await press(r, taskId, maintainer, BROWSER_SESSION_METHOD, "approve", { acknowledgedRunLimitUsd: 5 });
    expect(JSON.stringify(answer)).not.toContain(SEAT);
  });
});

describe("switch blocker 10: Cloud's own task facts for the core's sessions", () => {
  async function planned() {
    const r = await rig();
    const { taskId, owner } = await plannedTask(r);
    const task = await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    r.people.db.set({ ...task });
    // The workspace and its operations are the same table in production; here they are copied beside the people world's records.
    const workspaceId = (task as unknown as { workspaceId: string }).workspaceId;
    for (const row of (await r.world.store.query({ pk: `WORKSPACE#${workspaceId}` })).items) r.people.db.set(row);
    // Cloud's workspace reads, over those rows (the people world has no task actions of its own).
    const store = r.world.store;
    (r.people.routes as unknown as { tasks: unknown }).tasks = {
      workspace: async (id: string) => await store.get({ pk: `WORKSPACE#${id}`, sk: "META" }),
      operations: async (id: string) => (await store.query({ pk: `WORKSPACE#${id}`, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items,
    };
    return { r, taskId, owner, facts: cloudTaskFacts(() => r.people.routes) };
  }

  it("a planned task's facts: its project, owner, workflow, step and run, read from the rows the core wrote", async () => {
    const { taskId, owner, facts } = await planned();
    const read = (await facts.read(PEOPLE_ORG, taskId))!;
    expect(read).toMatchObject({ companyId: PEOPLE_ORG, taskId, project: "payments", ownerDeveloperId: owner.developerId, workflow: { stage: "PLAN_REVIEW", state: "WAITING" }, step: "Waiting for your approval", pendingApprovals: 0 });
    expect(read.runStatus).toBe("SUCCEEDED");
    expect(Number.isNaN(Date.parse(read.updatedAt))).toBe(false);
  });

  it("a task of another company, and a task that does not exist, have none", async () => {
    const { taskId, facts } = await planned();
    expect(await facts.read("org_s3other000000000000z", taskId)).toBeUndefined();
    expect(await facts.read(PEOPLE_ORG, randomUUID())).toBeUndefined();
  });

  it("a task whose owner is no longer a member still has facts, with an idle run", async () => {
    const { r, taskId, facts } = await planned();
    const row = r.people.db.get({ pk: `DEVTASK#${taskId}`, sk: "META" }) as Record<string, unknown>;
    r.people.db.set({ ...row, developerId: r.people.people.revoked.developerId, ownerKey: undefined });
    const read = await facts.read(PEOPLE_ORG, taskId);
    expect(read).toBeDefined();
    expect(read!.runStatus).toBe("IDLE");
  });

  it("a closed task is ended: closedAt and endedAt are carried", async () => {
    const { r, taskId, facts } = await planned();
    const row = r.people.db.get({ pk: `DEVTASK#${taskId}`, sk: "META" }) as Record<string, unknown>;
    r.people.db.set({ ...row, closedAt: "2026-11-13T12:00:00.000Z" });
    expect(await facts.read(PEOPLE_ORG, taskId)).toMatchObject({ closedAt: "2026-11-13T12:00:00.000Z", endedAt: "2026-11-13T12:00:00.000Z" });
  });
});

describe("switch blocker 7 (callbacks): a worker's callback on a core-stamped task goes to Code's callback service", () => {
  const post = (workspaceId: string, operationId: string, action: string, capability: string, body: unknown) => ({
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${action}`, headers: { "x-agentx-callback-capability": capability, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  async function started() {
    const r = await rig();
    const owner = r.people.people.owner;
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
    const { task } = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a greeting.", workflow: true, workflowPath: "QUICK" });
    for (let round = 0; round < 3; round += 1) { await runtime.flow.relayOnce(); await runtime.flow.dispatchOnce({ maxMessages: 5, waitSeconds: 0 }); await runtime.flow.sweepOnce(); }
    const row = await r.world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    const workspaceId = (row as unknown as { workspaceId: string }).workspaceId;
    const machineId = ((await r.world.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))?.machine as { machineId: string }).machineId;
    const job = r.world.machines.delivered(machineId)[0]!;
    return { r, job, workspaceId, taskId: task.taskId };
  }

  it("a core task's artifact callback is answered by the core: the document is stored", async () => {
    const { r, job } = await started();
    const route = createCoreCallbackRouter(r.app, (key) => r.world.store.get(key) as never);
    const text = planAnswer(planDocument({ title: "Greeting", why: [{ text: "Asked for.", author: "Maya" }], claims: [{ id: "1", text: "Add a greeting." }], decisions: [] }), { checks: { checks: [], none_reason: "Covered." } });
    const answer = await route(post(job.workspaceId, job.operationId, "artifacts", job.callbackCapability, { name: "plan.md", mediaType: "text/markdown", content: text }));
    expect(answer?.statusCode).toBe(200);
  });

  it("the core still checks the capability: a wrong one is refused by the core, not handed to Cloud", async () => {
    const { r, job } = await started();
    const answer = await createCoreCallbackRouter(r.app, (key) => r.world.store.get(key) as never)(post(job.workspaceId, job.operationId, "events", "not-a-capability", { events: [] }));
    expect(answer).toBeDefined();
    expect(answer!.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("a task with no core stamp, an action the core does not serve, and any other path are Cloud's (undefined)", async () => {
    const { r, job, taskId } = await started();
    const route = createCoreCallbackRouter(r.app, (key) => r.world.store.get(key) as never);
    expect(await route(post(job.workspaceId, job.operationId, "model-access", job.callbackCapability, {}))).toBeUndefined();
    expect(await route({ method: "POST", path: "/v1/app/projects", headers: {} })).toBeUndefined();
    // The same task with its stamp gone is a Cloud task.
    await r.world.store.delete({ key: engineStampKey(taskId) });
    expect(await route(post(job.workspaceId, job.operationId, "events", job.callbackCapability, { events: [] }))).toBeUndefined();
  });

  it("with the switch off nothing is routed, and the served actions are held to the vendored callback service's", async () => {
    const world = createFakeWorld();
    const off = createCloudApp({ env: {}, modules: world.modules, context: () => world.context(), runtime: () => ({}) as never });
    expect(await createCoreCallbackRouter(off, async () => undefined)(post(randomUUID(), randomUUID(), "events", "x", {}))).toBeUndefined();
    const vendored = readFileSync(join(import.meta.dirname, "../../vendor/rovara-code/packages/broker/src/services/callbacks.ts"), "utf8");
    const served = /SERVED_ACTIONS[^=]*= new Set\(\[([^\]]*)\]\)/u.exec(vendored)![1]!.split(",").map((name) => name.trim().replaceAll("\"", ""));
    expect([...CORE_CALLBACK_ACTIONS].sort()).toEqual([...served, "repository-credentials"].sort());
  });
});

describe("switch blocker 7 (rollback): the switch gates NEW tasks only; a core-stamped task is served with it off", () => {
  const post = (workspaceId: string, operationId: string, action: string, capability: string, body: unknown) => ({
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${action}`, headers: { "x-agentx-callback-capability": capability, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  async function startedOnCore() {
    const r = await rig();
    r.standing.set(r.people.people.owner.developerId, "owner");
    const owner = r.people.people.owner;
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
    const { task } = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a greeting.", workflow: true, workflowPath: "QUICK" });
    for (let round = 0; round < 3; round += 1) { await runtime.flow.relayOnce(); await runtime.flow.dispatchOnce({ maxMessages: 5, waitSeconds: 0 }); await runtime.flow.sweepOnce(); }
    const row = await r.world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    const workspaceId = (row as unknown as { workspaceId: string }).workspaceId;
    const machineId = ((await r.world.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))?.machine as { machineId: string }).machineId;
    const job = r.world.machines.delivered(machineId)[0]!;
    return { r, owner, principal, taskId: task.taskId, job };
  }

  it("the first core start leaves the in-use mark, so an off root knows there is a core task to serve", async () => {
    const { r } = await startedOnCore();
    expect(await r.world.store.get(coreInUseKey(PEOPLE_ORG))).toBeDefined();
  });

  it("switch on, start, switch off: the worker's callbacks, the owner's decision and the close still work, and a new start is Cloud's", async () => {
    const r = await rig();
    const { owner } = r.people.people;
    r.standing.set(owner.developerId, "owner");
    const off = r.rebuild({ env: {}, serveStamped: true });
    expect(off.active).toBe(false);
    expect(off.engineForNewTask(PEOPLE_ORG)).toBe("cloud");
    // Started with the switch on; planned by a worker whose callbacks now come with the switch OFF, through the router.
    const { taskId } = await plannedTask(r, "QUICK", off);
    const runtime = await off.runtimeFor(PEOPLE_ORG);
    const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
    // The owner's decision, through the same gate, with the switch off.
    const found = (await runtime.inbound.gate!.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
    const decided = await runtime.inbound.clientGate!.decide({
      companyId: PEOPLE_ORG, kind: "workflow-document", subjectId: taskId, requestId: randomUUID(), outcome: "approve", seen: { revision: found.revision, artifactDigest: found.artifactDigest },
      credentials: [{ method: BROWSER_SESSION_METHOD, token: owner.sessionId }], reason: "fine",
    });
    expect(decided.status, JSON.stringify(decided)).toBe("decided");
    // The close.
    await runtime.flow.close({ principal, client: "app" }, taskId);
    const closed = await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    expect((closed as unknown as { closedAt?: string }).closedAt).toBeDefined();
    // And a NEW task is not started on the core: the switch is off.
    expect(await createCoreIntentHook({ app: off, principalOf: async () => principal, origin: "https://x.test", now: () => r.world.clock.now, log: () => undefined }).start({ caller: { orgId: PEOPLE_ORG, developerId: owner.developerId } as never, request: { requestId: randomUUID(), project: "payments", input: { text: "again" }, source: "app", path: "QUICK" } as never, ownedTask: (async () => ({})) as never })).toBeUndefined();
  });

  it("the jobs run for the install's company while the switch is off, and the root without serveStamped refuses to serve (the control)", async () => {
    const { r } = await startedOnCore();
    const off = r.rebuild({ env: {}, serveStamped: true });
    const ran = await off.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }) as { companies: Array<{ companyId: string; outcome: string }> };
    // The install's own company (the world's), whatever the switch names.
    expect(ran.companies.map((company) => [company.companyId, company.outcome])).toEqual([[r.world.context().installCompanyId, "ran"]]);
    const old = r.rebuild({ env: {} });
    await expect(old.runtimeFor(PEOPLE_ORG)).rejects.toThrow();
    expect(await old.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" })).toEqual({ skipped: "off" });
  });

  it("a core-stamped task's callback is NEVER Cloud's: with the root unable to be built it is told to retry (503), and the stamp is read with the switch off and no in-use mark", async () => {
    const { r, job } = await startedOnCore();
    const store = r.world.store;
    // A root that cannot be built (the registry's points are missing), the switch off: still a retryable refusal, not a fall-through.
    const broken = createCloudApp({ env: {}, modules: () => { throw new Error("no clients"); }, serveStamped: true, context: () => r.world.context(), runtime: () => ({}) as never });
    const answer = await createCoreCallbackRouter(broken, (key) => store.get(key) as never)(post(job.workspaceId, job.operationId, "events", job.callbackCapability, { events: [] }));
    expect(answer?.statusCode).toBe(503);
    expect(answer?.headers["retry-after"]).toBe("5");
    // And the stamp is read whatever the in-use mark says: a core task started a moment ago is served with the switch off.
    const off = r.rebuild({ env: {}, serveStamped: true });
    await store.delete({ key: coreInUseKey(PEOPLE_ORG) });
    const served = await createCoreCallbackRouter(off, (key) => store.get(key) as never)(post(job.workspaceId, job.operationId, "events", job.callbackCapability, { events: [] }));
    // Answered by the core (whatever it says of an empty batch), neither handed to Cloud nor told to retry.
    expect(served).toBeDefined();
    expect(served!.statusCode).not.toBe(503);
    expect(served!.body).not.toContain("route not found");
  });

  it("an off root that holds no core task serves nothing: no in-use mark, no callback routing", async () => {
    const r = await rig();
    const off = r.rebuild({ env: {}, serveStamped: true });
    expect(await createCoreCallbackRouter(off, (key) => r.world.store.get(key) as never)(post(randomUUID(), randomUUID(), "events", "x", {}))).toBeUndefined();
  });

  it("it fails closed: a maintainer verified for a task outside the wrapped gate is refused, and inside it only the limited details are", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    const raw = (await r.app.registry()).require("approvers");
    const seats = createSeatLimits();
    const wrapped = seats.wrap(raw);
    const request = () => ({ companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: taskId }, revision: 1, artifactDigest: "b".repeat(64), risk: "low" as const, outcome: "approve" as const });
    const proofOf = (req: ReturnType<typeof request>) => ({ proofId: randomUUID(), method: BROWSER_SESSION_METHOD, requestId: req.requestId, revision: req.revision, artifactDigest: req.artifactDigest, token: maintainer.sessionId });
    const outside = request();
    expect(await wrapped.verify(outside, proofOf(outside))).toEqual({ approved: false, reason: SEAT_LIMIT_UNAVAILABLE });
    const through = (details: unknown) => seats.gate({ decide: async () => { const req = request(); return await wrapped.verify(req, proofOf(req)); } } as never).decide({ requestId: "x", credentials: [], details } as never) as Promise<{ approved: boolean }>;
    expect((await through(undefined)).approved).toBe(true);
    expect((await through({ acknowledgedRunLimitUsd: 5 })).approved).toBe(false);
  });

  it("concurrent decisions do not see each other's details: the limited one is refused, the plain one is approved", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    const seats = createSeatLimits();
    const wrapped = seats.wrap((await r.app.registry()).require("approvers"));
    const verifyAfter = async (delayMs: number) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); const req = { companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: taskId }, revision: 1, artifactDigest: "b".repeat(64), risk: "low" as const, outcome: "approve" as const }; return await wrapped.verify(req, { proofId: randomUUID(), method: BROWSER_SESSION_METHOD, requestId: req.requestId, revision: 1, artifactDigest: req.artifactDigest, token: maintainer.sessionId }); };
    const gate = seats.gate({ decide: async (attempt: { delay: number }) => await verifyAfter(attempt.delay) } as never) as unknown as { decide(attempt: unknown): Promise<{ approved: boolean }> };
    const [limited, plain] = await Promise.all([gate.decide({ delay: 20, details: { closeAsAnswered: true } }), gate.decide({ delay: 5, details: undefined })]);
    expect([limited.approved, plain.approved]).toEqual([false, true]);
  });

  it("a maintainer's plain approval changes no run limit on the core (v2's ban on raising the owner's limit has nothing to hold): the task's money fields are as they were", async () => {
    const r = await rig();
    const { maintainer } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    const { taskId } = await plannedTask(r);
    const money = async () => { const row = await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }) as unknown as Record<string, unknown>; return JSON.stringify({ budgetUsd: row["budgetUsd"], runLimitUsd: row["runLimitUsd"], runEstimate: row["runEstimate"], charge: row["charge"], payer: row["payer"] }); };
    const before = await money();
    expect((await press(r, taskId, maintainer, BROWSER_SESSION_METHOD)).status).toBe("decided");
    expect(await money()).toBe(before);
  });

  it("the raw decision service's `actions` (built on the raw gate, which skips the seat limits) are not carried", async () => {
    const r = await rig();
    const inbound = (await r.app.runtimeFor(PEOPLE_ORG)).inbound as Record<string, unknown>;
    expect(Object.keys(inbound)).not.toContain("actions");
  });
});
