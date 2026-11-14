// The rig the Cloud root tests share: a task the core started and planned, deciding through the real A6 adapters and the real gate.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Approvers } from "@rovara-code/contracts";
import type { TaskAccess } from "@rovara-code/broker/core/task-flow";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import type { ApprovalDeciderRole } from "@agentx/cloud-contracts";
import { fixedCodeSettings, soleOwnerPeople } from "@rovara-code/broker/core/merge";
import { cloudAdapter, cloudCoreRuntime, cloudSettingsFromEnvironment, createCloudApp, slackPressToken, type CloudApp, type CloudCoreWiring } from "../../packages/broker/src/cloud/app/index.js";
import type { BROWSER_SESSION_METHOD} from "../../packages/broker/src/cloud/adapters/people/index.js";
import { CHAT_SLACK_METHOD, cloudApprovalIssuers, createCloudApprovers, createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { createCallbackService } from "@rovara-code/broker";
import { PEOPLE_ORG, SLACK_TEAM, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";
import { CORE_IN_USE_PARTITION, cloudDeciderRole, createCoreCallbackRouter } from "../../packages/broker/src/cloud/app/index.js";
import { createClientFacingApprovers } from "../../packages/broker/src/cloud/app/index.js";
import { resolveSlackDecisionCaller } from "../../packages/broker/src/decisions/slack-actions.js";
import { CloudSlackChannel } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";


export const PROJECT = (url: string): ProjectDefinition => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

export const allowAll: TaskAccess = { checkStart: async () => ({ allowed: true }), canAct: async () => true, checkStep: async () => ({ allowed: true }) };

export interface Rig { /** A6's approvers adapter as built, without the client-facing wrapper the root registers (for tests of A6 itself). */ approvers: Approvers; world: FakeWorld; people: PeopleWorld; app: CloudApp; standing: Map<string, ApprovalDeciderRole>; posts: string[]; /** Another root over the same world, adapters and wiring (a later Lambda container, with the switch changed). */ rebuild(options: { env: NodeJS.ProcessEnv; serveStamped?: boolean }): CloudApp }

export async function rig(options: { slack?: boolean; liveRole?: boolean; afterVerify?: () => Promise<void> | void; access?: TaskAccess; log?: (entry: Record<string, unknown>) => void } = {}): Promise<Rig> {
  const world = createFakeWorld();
  const people = createPeopleWorld();
  const standing = new Map<string, ApprovalDeciderRole>();
  const realApprovers = createCloudApprovers({
    issuers: cloudApprovalIssuers({ routes: people.routes, slackLookups: people.slackLookups }),
    deciderRole: options.liveRole === true ? cloudDeciderRole(() => people.routes) : async (_request, decider) => standing.get(decider.developerId) ?? "none",
    place: { documentClient: people.db, tableName: "state", signInTableName: "signin", now: people.now },
  });
  // A6 as built, with a hook run right after a person is verified (a change between the check and the commit).
  const approvers: Approvers = { requirement: (request) => realApprovers.requirement(request), verify: async (request, proof) => { const verdict = await realApprovers.verify(request, proof); if (verdict.approved) await options.afterVerify?.(); return verdict; } };
  const posts: string[] = [];
  // The real Slack adapter (A8), its Slack calls answered by a recording stand-in for Slack's API.
  const slackAdapter = cloudAdapter({
    point: "channel", name: "slack", lane: "A8",
    create: () => new CloudSlackChannel({ projects: ["payments"], botToken: async () => "unused", serves: async () => true, fetch: (async (_url: string, init: { body: string }) => { posts.push(String(init.body)); return new Response(JSON.stringify({ ok: true, ts: "1695500000.000009", channel: "C0CHAN" })); }) as never }),
  });
  const modules = [...world.modules.map((module) => (module.point === "approvers" ? cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => createClientFacingApprovers(approvers) }) : module)), ...(options.slack === true ? [slackAdapter] : [])];
  const identity = createCloudIdentityProvider(people.routes);
  const wiring: CloudCoreWiring = {
    settings: () => cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: true }),
    callbackSigningKey: Buffer.alloc(32, 7), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), access: options.access ?? allowAll,
    now: () => new Date(world.clock.now), log: options.log ?? (() => undefined), people: soleOwnerPeople, codeSettings: fixedCodeSettings(),
    taskEnd: { readTask: async () => undefined, onTaskEnded: async () => undefined }, sessionFacts: { read: async () => undefined },
    slack: { orgOfTeam: async (teamId) => (teamId === SLACK_TEAM ? PEOPLE_ORG : undefined),
      // The Slack account's person is found by A6's own lookups (the linked, signed-in, live member), as the broker's `slackRequesterStanding` finds them in production.
      standingOf: async (_org, slackUserId) => { const member = await resolveSlackDecisionCaller(people.slackLookups(new Map()), { userId: slackUserId, userTeamId: SLACK_TEAM, workspaceTeamId: SLACK_TEAM, enterpriseId: "", userEnterpriseId: "" }); if (member === undefined) throw new Error("not a member"); return member.developerId; }, principalOf: async (orgId, personId) => await identity.getPrincipal(orgId, personId), linkWords: () => "x" },
  };
  const rebuild = (built: { env: NodeJS.ProcessEnv; serveStamped?: boolean }): CloudApp => createCloudApp({ env: built.env, modules, context: () => world.context(), nowMs: () => world.clock.now, runtime: cloudCoreRuntime(wiring), ...(built.serveStamped === true ? { serveStamped: true, servedCompanies: async () => (await world.store.query({ pk: CORE_IN_USE_PARTITION })).items.map((item) => item["orgId"] as string) } : {}) });
  const app = rebuild({ env: { CLOUD_CORE_ENGINE: "on" } });
  // The members' records in the core's table (one table in production): the decision's transaction holds them to the roles read at verification.
  for (const person of Object.values(people.people)) await world.store.put({ item: { ...orgMemberKey(person.orgId, person.developerId), entityType: "ORG_MEMBER", role: person.role } });
  const project = PROJECT(world.hostModel.url);
  await world.store.put({ item: { ...projectRevisionKey(PEOPLE_ORG, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(PEOPLE_ORG, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
  return { approvers, world, people, app, standing, posts, rebuild };
}

/** Starts a task as the owner and plans it: the fake worker answers the planning job through the real callback service, so the task waits at its plan review. */
export async function plannedTask(r: Rig, path: "QUICK" | "FULL" = "QUICK", driver?: CloudApp): Promise<{ taskId: string; owner: Person }> {
  const owner = r.people.people.owner;
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
  const started = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a greeting.", workflow: true, workflowPath: path });
  const taskId = started.task.taskId;
  // The root that drives the rest: the one the task started under, or a later one with the switch off, whose worker callbacks come through the router.
  const drive = driver === undefined ? runtime : await driver.runtimeFor(PEOPLE_ORG);
  const registry = await r.app.registry();
  const direct = createCallbackService({ flow: runtime.flow.deps, blobs: registry.require("object-storage"), grants: { exchange: async () => { throw new Error("unused"); } } });
  const routed = driver === undefined ? undefined : createCoreCallbackRouter(driver, (key) => r.world.store.get(key));
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
export const seen = new Set<string>();

export async function press(r: Rig, taskId: string, who: Person, method: typeof BROWSER_SESSION_METHOD | typeof CHAT_SLACK_METHOD, outcome: "approve" | "reject" = "approve", details?: Record<string, unknown>) {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const gate = runtime.inbound.clientGate!;
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

export const ownerIdOf = async (r: Rig, taskId: string) => ((await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.workflow as { ownerId: string }).ownerId;
