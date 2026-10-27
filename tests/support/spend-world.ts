// Plan 3 Tasks 32 and 33: the world the spend request tests share. A hosted broker with agents, the model proxy and a cloud install; Ada owns the org,
// Deb is an admin, Ben maintains payments and Carl contributes to it; Maya and Omar are the harness's developers. Helpers start, pause and end tasks the way
// the worker and the mint do, and read what the requests wrote.
import { createHash, randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { expect } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import type { AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { AgentRunStarter } from "../../packages/broker/src/agents/runs.js";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import { decideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, ownerBudgetKey, type AgentId, type OrgId, type PauseScope, type SpendRequestRecord } from "@agentx/contracts";
import { recipeDigest, type RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { projectAgentKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { DEV_ISSUER, MAYA, createSingleAnswerPlanBroker, seedMembership, type Developer } from "./developer-task-broker.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { TEST_ORG } from "./orgs.js";
import { loadSlackBroker } from "./slack-broker.js";

export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const PROXY_URL = "http://internal-proxy.example.test:4000";
export const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
export const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.split(" ")[0]!.toLowerCase()}` });
/** The org's owner (the successor of a removed member). */
export const ADA = person("1", "Ada Owner");
/** A maintainer of payments. */
export const BEN = person("2", "Ben Maintainer");
/** A contributor on payments. */
export const CARL = person("3", "Carl Contributor");
/** An org admin. */
export const DEB = person("5", "Deb Admin");
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const CELL = new URL(DEV_ISSUER).origin;

export const agentStep = (id: string) => ({ id, name: id, kind: "agent" as const, workspace: "none" as const });
export const TRIAGE: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [agentStep("investigate"), agentStep("report")] };
export const CODING: RecipeOverlay = {
  instructions: "Make the change the request asks for.",
  sequence: [{ id: "plan", name: "Plan", kind: "plan" }, { id: "build", name: "Build", kind: "build" }, { id: "check", name: "Check", kind: "check" }],
};

let broker: Promise<typeof BrokerModule> | undefined;
/** The broker module, loaded once after the Slack harness has set up the environment it reads when it loads. */
const brokerModule = (): Promise<typeof BrokerModule> => (broker ??= loadSlackBroker().then(() => import("../../packages/broker/src/aws/broker.js")));

export type Reply = { status: number; body: Record<string, unknown> };
export const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
export const month = () => new Date().toISOString().slice(0, 7);

export async function setup(options: {
  decide?: boolean; secondAdmin?: boolean; plan?: "team" | "trial";
  /** Task 36: which org each caller belongs to (default: every caller is in the install's org). */
  orgResolver?: OrgResolver;
  /** Task 36: the agent route dependencies' extras (default `{}`), such as `modelSources`. */
  agents?: Record<string, unknown>;
  /** Task 36: more broker input, spread last (connections, connector types, cloud project defaults). */
  extra?: Record<string, unknown>;
} = {}) {
  const { createAgentRouteDependencies, createAgentRunStarter } = await brokerModule();
  const access = fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({
    ...(options.orgResolver === undefined ? {} : { orgResolver: options.orgResolver }),
    brokerExtra: { agents: options.agents ?? {}, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true, ...(options.decide === true ? { decide: {} } : {}), ...options.extra },
  });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const people: Array<[Developer, "owner" | "admin" | "member"]> = [[ADA, "owner"], [BEN, "member"], [CARL, "member"], ...(options.secondAdmin === false ? [] : [[DEB, "admin"] as [Developer, "admin"]])];
  for (const [who, role] of people) {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  }
  if (options.plan === "trial") h.db.set({ ...h.db.get(`ORG#${TEST_ORG}`, "META")!, plan: "trial" });
  const grantRole = (who: Developer, role: "maintainer" | "contributor" | "viewer") =>
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: role });
  grantRole(BEN, "maintainer");
  grantRole(CARL, "contributor");
  const deps = (clock?: () => number): AgentRouteDependencies => {
    const built = createAgentRouteDependencies(h.brokerInput as never);
    if (built === undefined) throw new Error("the broker has no agent route dependencies");
    return clock === undefined ? built : { ...built, now: clock };
  };
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const api = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const caller = (who: Developer, orgRole: AgentCaller["orgRole"] = "member", orgId: OrgId = TEST_ORG): AgentCaller => ({ orgId, developerId: who.developerId, orgRole });
  const roleOf = (who: Developer): AgentCaller["orgRole"] => (who === ADA ? "owner" : who === DEB ? "admin" : "member");
  /** Decides a request as `who` (the function the page and the route call), with a fresh request id unless one is given. */
  const decide = (who: Developer, spendRequestId: string, decision: "APPROVE" | "DENY" = "APPROVE", extra: Record<string, unknown> = {}) =>
    decideSpendRequest(deps(), caller(who, roleOf(who)), spendRequestId, { requestId: randomUUID(), decision, ...extra });

  // ---- agents
  const publishNext = async (agentId: AgentId, overlay: RecipeOverlay, by: Developer = MAYA) => {
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: by.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: by.developerId });
  };
  /** An agent made by `by` (Maya), published and on the payments roster unless told otherwise. */
  const agentOf = async (overlay: RecipeOverlay = TRIAGE, options: { by?: Developer; name?: string; publish?: boolean; owner?: Record<string, unknown>; accountable?: Developer } = {}): Promise<AgentId> => {
    const by = options.by ?? MAYA;
    const created = await api(by, "POST", "/v1/app/agents", {
      name: options.name ?? `Agent ${randomUUID().slice(0, 8)}`, overlay,
      ...(options.owner === undefined ? {} : { owner: options.owner }), ...(options.accountable === undefined ? {} : { accountable: { developerId: options.accountable.developerId } }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    if (options.publish !== false) await publishNext(agentId, overlay, by);
    h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: by.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return agentId;
  };
  const setBudget = (who: Developer, agentId: string, body: Record<string, unknown>) => api(who, "PUT", `/v1/app/agents/${agentId}/budget`, body);
  /** Lets `who` run an agent of Maya's. */
  const shareWith = async (agentId: string, who: Developer) => {
    const shared = await api(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: who.developerId }, level: "use" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  };
  /** An agent of `by` with a monthly budget of `usd`, set through the route (it fits the cap). */
  const budgeted = async (usd: number, by: Developer = MAYA, overlay: RecipeOverlay = TRIAGE): Promise<AgentId> => {
    const agentId = await agentOf(overlay, { by });
    const set = await setBudget(by, agentId, { monthlyUsd: usd });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    return agentId;
  };
  const ownerTotal = (who: Developer) => (h.db.get(ownerBudgetKey(TEST_ORG, who.developerId).pk, "TOTAL") as { totalUsd?: number } | undefined)?.totalUsd ?? 0;
  const agentItem = (agentId: string) => h.db.get(`ORG#${TEST_ORG}#AGENT#${agentId}`, "META") as Record<string, unknown> & { monthlyBudgetUsd?: number; maxPerRunUsd?: number; status: string; owner: Record<string, unknown>; accountable?: { developerId: string } } | undefined;
  const agentEvents = (agentId: string, kind: string) => h.db.find((item) => item.entityType === "AGENT_EVENT" && item.agentId === agentId && item.kind === kind);

  // ---- tasks
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; budgetUsd?: number; maxPerRunUsd?: number; budgetPause?: { scope: PauseScope; firstDispatch?: { operationId: string } }; budgetBaselineUsd?: number;
    origin?: string; payer?: Record<string, unknown>; workflow?: { stage: string; state: string; blockReason?: string; revision: number }; modelKeyIds?: string[]; releasedAt?: string;
  };
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Record<string, unknown> & { id: string; kind: string; status: string; fence: number; programStepId?: string; workflowMode?: string; createdAt: string }>;
  const taskOps = (workspaceId: string) => operations(workspaceId).filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence);
  const activeOf = (workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const outboxOf = (operationId: string) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  const set = (taskId: string, expression: string, values: Record<string, unknown> = {}, names?: Record<string, string>) => h.db.send(new UpdateCommand({
    TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, UpdateExpression: expression,
    ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }), ...(names === undefined ? {} : { ExpressionAttributeNames: names }),
  }));
  /** A plain Rovara Code task of Maya's whose preparation finished: its task operation is the active one. */
  const plainTask = async (who: Developer = MAYA) => {
    const started = await h.dev(who, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = meta(taskId);
    await h.finish(workspaceId, activeOf(workspaceId), "SUCCEEDED", PREPARED);
    return { taskId, workspaceId, operationId: activeOf(workspaceId) };
  };
  /** A run of `agentId` as `who` on payments (draft for a test run); the preparation finished. */
  const runOf = async (agentId: string, options: { who?: Developer; version?: "draft" } = {}) => {
    const reply = await api(options.who ?? MAYA, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", input: { text: "Look at the new ticket" }, ...(options.version === undefined ? {} : { version: options.version }) });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { workspaceId } = meta(taskId);
    const prepare = operations(workspaceId).find((operation) => operation.kind === "prepare")!;
    await h.finish(workspaceId, prepare.id, "SUCCEEDED", PREPARED);
    return { taskId, workspaceId };
  };
  /** The task paused on `scope` (as the mint writes it), then its running task operation ends out of budget, as the worker reports it. */
  const pauseAndEnd = async (task: { taskId: string; workspaceId: string }, scope: PauseScope | "none" = { kind: "task", taskId: task.taskId }) => {
    if (scope !== "none") await set(task.taskId, "SET budgetPause = :pause", { ":pause": { scope, at: new Date().toISOString() } });
    const running = taskOps(task.workspaceId).filter((operation) => !["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(operation.status)).at(-1)!;
    await h.finish(task.workspaceId, running.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    return running.id;
  };
  const requests = (): SpendRequestRecord[] => h.db.find((item) => item.entityType === "SPEND_REQUEST") as unknown as SpendRequestRecord[];
  const requestOf = (taskId: string, kind?: string) => requests().filter((record) => record.taskId === taskId && (kind === undefined || record.kind === kind));
  const openItems = () => h.db.find((item) => item.entityType === "SPEND_REQUEST_OPEN");
  const view = async (who: Developer, taskId: string) => (await api(who, "GET", `/v1/dev/tasks/${taskId}`)).body.task as Record<string, unknown> & {
    paused?: { reason: string; spendRequestId?: string; scope: Record<string, string>; message?: string }; planningSoFar?: string; testOffer?: { capUsd: number }; events: Array<{ text?: string; message?: string }>;
    workflow?: { blockReason?: string };
  };
  const taskEvents = (taskId: string) => h.db.find((item) => item.pk === `DEVTASK#${taskId}` && typeof item.sk === "string" && item.sk.startsWith("EVENT#")).map((item) => String(item.text));
  const starter = (): AgentRunStarter => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no agent run starter");
    return found;
  };
  const actions: DeveloperTaskActions = h.actions; // named here so the declaration of `setup` can refer to it
  // The harness's own fields the tests use, by name: a spread of the whole harness would carry the broker's input types into this module's declaration.
  return {
    db: h.db, actions, handler: h.handler, dev: h.dev, events: h.events, finish: h.finish, artifact: h.artifact, orgOf: h.orgOf, access, store, deps, api, caller, decide, agentOf, publishNext, setBudget, shareWith, budgeted, ownerTotal, agentItem, agentEvents, grantRole,
    meta, operations, taskOps, activeOf, outboxOf, set, plainTask, runOf, pauseAndEnd, requests, requestOf, openItems, view, taskEvents, starter,
  };
}
export type World = Awaited<ReturnType<typeof setup>>;
