// S3 review fixes F1 and F3: a decision on a task of THIS root goes through the REAL A6 adapters (createCloudApprovers over cloudApprovalIssuers, over Cloud's people) and Code's real decision
// gate and workflow subject (the root's `createDecisionService`), on a task the core's flow really started and planned. Who decides as the task's owner is `cloudActorFor`, fed by the
// standing the approvers adapter read and put on the verified approver. The decider's LIVE standing on a task is read by `deciderRole`, which Cloud has no reader for on the core path
// yet (DEFERRED S3-CLOUD-WIRING-INPUTS): the test gives the same fixed standing the parity suite does.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskAccess } from "@rovara-code/broker/core/task-flow";
import { orgProjectCatalogKey, projectRevisionKey, type ApprovalDeciderRole as _Unused, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import type { ApprovalDeciderRole } from "@agentx/cloud-contracts";
import { fixedCodeSettings, soleOwnerPeople } from "@rovara-code/broker/core/merge";
import {
  cloudAdapter, cloudCoreRuntime, cloudSettingsFromEnvironment, createCloudApp, slackPressToken, type CloudApp, type CloudCoreWiring,
} from "../../packages/broker/src/cloud/app/index.js";
import { BROWSER_SESSION_METHOD, CHAT_SLACK_METHOD, cloudApprovalIssuers, createCloudApprovers, createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { createCallbackService } from "@rovara-code/broker";
import { PEOPLE_ORG, SLACK_TEAM, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";
import { createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

void (null as unknown as _Unused);
const PROJECT = (url: string): ProjectDefinition => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

const allowAll: TaskAccess = { checkStart: async () => ({ allowed: true }), canAct: async () => true, checkStep: async () => ({ allowed: true }) };

interface Rig { world: FakeWorld; people: PeopleWorld; app: CloudApp; standing: Map<string, ApprovalDeciderRole> }

async function rig(): Promise<Rig> {
  const world = createFakeWorld();
  const people = createPeopleWorld();
  const standing = new Map<string, ApprovalDeciderRole>();
  const approvers = createCloudApprovers({
    issuers: cloudApprovalIssuers({ routes: people.routes, slackLookups: people.slackLookups }),
    deciderRole: async (_request, decider) => standing.get(decider.developerId) ?? "none",
    place: { documentClient: people.db, tableName: "state", signInTableName: "signin", now: people.now },
  });
  const modules = world.modules.map((module) => (module.point === "approvers" ? cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => approvers }) : module));
  const identity = createCloudIdentityProvider(people.routes);
  const wiring: CloudCoreWiring = {
    settings: () => cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: true }),
    callbackSigningKey: Buffer.alloc(32, 7), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), access: allowAll,
    now: () => new Date(world.clock.now), log: () => undefined, people: soleOwnerPeople, codeSettings: fixedCodeSettings(),
    taskEnd: { readTask: async () => undefined, onTaskEnded: async () => undefined }, sessionFacts: { read: async () => undefined },
    slack: { orgOfTeam: async () => PEOPLE_ORG, standingOf: async () => people.people.member.developerId, principalOf: async (orgId, personId) => await identity.getPrincipal(orgId, personId), linkWords: () => "x" },
  };
  const app = createCloudApp({ env: { CLOUD_CORE_ENGINE: "on" }, modules, context: () => world.context(), nowMs: () => world.clock.now, runtime: cloudCoreRuntime(wiring) });
  const project = PROJECT(world.hostModel.url);
  await world.store.put({ item: { ...projectRevisionKey(PEOPLE_ORG, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(PEOPLE_ORG, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
  return { world, people, app, standing };
}

/** Starts a task as the owner and plans it: the fake worker answers the planning job through the real callback service, so the task waits at its plan review. */
async function plannedTask(r: Rig, path: "QUICK" | "FULL" = "QUICK"): Promise<{ taskId: string; owner: Person }> {
  const owner = r.people.people.owner;
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
  const started = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a greeting.", workflow: true, workflowPath: path });
  const taskId = started.task.taskId;
  const registry = await r.app.registry();
  const callbacks = createCallbackService({ flow: runtime.flow.deps, blobs: registry.require("object-storage"), grants: { exchange: async () => { throw new Error("unused"); } } });
  const store = r.world.store;
  for (let round = 0; round < 6; round += 1) {
    await runtime.flow.relayOnce();
    await runtime.flow.dispatchOnce({ maxMessages: 5, waitSeconds: 0 });
    await runtime.flow.sweepOnce();
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

async function press(r: Rig, taskId: string, who: Person, method: typeof BROWSER_SESSION_METHOD | typeof CHAT_SLACK_METHOD, outcome: "approve" | "reject" = "approve") {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const gate = runtime.inbound.gate!;
  const found = (await gate.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
  const token = method === CHAT_SLACK_METHOD
    ? slackPressToken({ actor: { channel: "slack", tenant: SLACK_TEAM, userId: who.slackUserId ?? "U0NOBODY01" }, conversation: { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN", thread: "1695500000.000001" } })
    : who.sessionId;
  return await gate.decide({
    companyId: PEOPLE_ORG, kind: "workflow-document", subjectId: taskId, requestId: randomUUID(), outcome, seen: { revision: found.revision, artifactDigest: found.artifactDigest },
    credentials: [{ method, token, claimedAccount: { provider: "slack", tenant: SLACK_TEAM, accountId: who.slackUserId ?? "U0NOBODY01" } }], reason: "fine",
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

  it("a Full task's requirements document is decided by nobody on the core path today: A6 has no approval rule for it (DEFERRED S3-A6-REQUIREMENTS-KIND, a switch-on blocker)", async () => {
    const r = await rig();
    const { maintainer, owner } = r.people.people;
    r.standing.set(maintainer.developerId, "maintainer");
    r.standing.set(owner.developerId, "owner");
    const { taskId } = await plannedTask(r, "FULL");
    for (const who of [maintainer, owner]) expect(await press(r, taskId, who, BROWSER_SESSION_METHOD), who.key).toMatchObject({ status: "refused", reason: "not_approved", detail: expect.stringContaining("no Cloud approval rule") as string });
    expect(await decisionsOf(r, taskId)).toEqual([]);
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

  it("an unlinked Slack account, and a press from another workspace, are refused by the real issuer", async () => {
    const r = await rig();
    const { member } = r.people.people;
    r.standing.set(member.developerId, "owner");
    const approvers = (await r.app.registry()).require("approvers");
    const request = { companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: randomUUID() }, revision: 2, artifactDigest: "b".repeat(64), risk: "low" as const, outcome: "approve" as const };
    const proofFor = (tenant: string) => ({ proofId: randomUUID(), method: CHAT_SLACK_METHOD, requestId: request.requestId, revision: 2, artifactDigest: request.artifactDigest, token: slackPressToken({ actor: { channel: "slack", tenant, userId: member.slackUserId! }, conversation: { channel: "slack", tenant, space: "C0CHAN", thread: "1.1" } }) });
    expect((await approvers.verify(request, proofFor(SLACK_TEAM))).approved).toBe(false);
    r.people.linkSlack(member);
    expect((await approvers.verify({ ...request, requestId: randomUUID() }, { ...proofFor("T0ELSEWHR"), requestId: "x" })).approved).toBe(false);
  });
});

describe("F3: a person who is not a member of the company starts and decides nothing through the Slack path", () => {
  it("a Slack account that is nobody's in this company: the message starts no task and the decision is refused", async () => {
    const r = await rig();
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    const principalOf = createCloudIdentityProvider(r.people.routes);
    expect(await principalOf.getPrincipal(PEOPLE_ORG, r.people.people.stranger.developerId)).toBeUndefined();
    expect(runtime.inbound.slack).toBeUndefined();
  });
});
