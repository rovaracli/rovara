import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 15: a run starts from a frozen recipe. The person's start (the app route, the AI-tool route and the Slack start all go through
// the developer task start) resolves the agent before any budget or workspace charge, then writes the task, the RECIPE snapshot, the AGENT_RUN
// of an agent-step recipe, the agent's task index and the run's request item in the one start transaction. `startAgentRun` is the same start
// for a caller that is not a person at a keyboard (H2): it is idempotent on its request id and takes the run limit, the payer and the
// result contract. The broker is built with `agents: {}` as the deployed handler is, so the real project members answer.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun, readTaskRecipe, type AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { agentXError } from "@rovara-code/contracts";
import { StartDeveloperTaskRequestSchema } from "@rovara-code/contracts";
import { AgentRunStateSchema, SHORTENED_MARKER, renderRunInput, type RunInput } from "@rovara-code/contracts";
import { ResolvedRecipeSchema, codingProgram, recipeDigest, type RecipeOverlay } from "@rovara-code/contracts";
import { PER_TASK_BUDGET_USD } from "../../packages/cloud-contracts/src/org-budget-node.js";
import { agentTasksKey, projectAgentKey, projectMemberKey, projectRevisionKey, runRequestKey } from "@rovara-code/contracts";
import { orgMemberKey, orgRemovedKey } from "../../packages/cloud-contracts/src/org-node.js";
import type { ProjectRole } from "@rovara-code/contracts";
import type { AgentId } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";
const HEAD = "a".repeat(40);
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// The broker module reads its environment when it loads, which loadSlackBroker sets up first.
let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const agentStep = (id: string) => ({ id, name: id, kind: "agent" as const, workspace: "none" as const });
const TRIAGE: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [agentStep("work")] };
const CODING: RecipeOverlay = {
  instructions: "Make the change the request asks for.",
  sequence: [
    { id: "plan", name: "Plan", kind: "plan" },
    { id: "build", name: "Build", kind: "build" },
    { id: "check", name: "Check", kind: "check" },
    { id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 2 } },
  ],
};

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
/** The refusal a promise ends in: its code and its message without the `CODE: ` prefix the error class adds. */
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

async function setup(options: { proxy?: boolean; agents?: Record<string, unknown>; brokerExtra?: Record<string, unknown>; memberLimit?: number } = {}) {
  const access = options.proxy === true ? fakeModelAccess() : undefined;
  const h = await createDeveloperTaskBroker({
    orgResolver,
    ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }),
    brokerExtra: { agents: { ...options.agents }, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }), ...options.brokerExtra },
  });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
  }
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  /** Publishes `overlay` as the agent's next version directly in the store (the routes' guardrail checks are Task 8's tests). */
  const publishNext = async (agentId: AgentId, overlay: RecipeOverlay) => {
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
  };
  const putOnRoster = (agentId: AgentId, project = "payments") => h.db.set({
    ...projectAgentKey(TEST_ORG, project, agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project, agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z",
  });
  /** An agent made by Maya; published (version 1) and on the payments roster unless told otherwise. */
  const agentOf = async (overlay: RecipeOverlay, options: { name?: string; publish?: boolean; roster?: boolean } = {}): Promise<AgentId> => {
    const created = await call(MAYA, "POST", "/v1/app/agents", { name: options.name ?? `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    if (options.publish !== false) await publishNext(agentId, overlay);
    if (options.roster !== false) putOnRoster(agentId);
    return agentId;
  };
  const run = (who: Developer, agentId: string, body: Record<string, unknown> = {}) => call(who, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", input: { text: "Look at the new ticket" }, ...body });
  type TaskView = { taskId: string; status: string; agent?: { agentId: string; name: string; version: number | string; builtin: boolean }; workflow?: unknown; outcome?: string };
  const taskOf = (reply: Reply) => reply.body.task as TaskView;
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; agent?: Record<string, unknown>; origin?: string; budgetUsd?: number; maxPerRunUsd?: number; developerId: string;
    workflow?: { path: string; program?: unknown; stage: string }; budgetPause?: Record<string, unknown>; outcome?: string;
  };
  const recipeItem = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "RECIPE") as { orgId: string; recipe: unknown; digest: string } | undefined;
  /** The run state of an agent-step run, as the engine reads it (the item without its key attributes). */
  const agentRunItem = (taskId: string) => {
    const item = h.db.get(`DEVTASK#${taskId}`, "AGENT_RUN");
    if (item === undefined) return undefined;
    const { pk: _pk, sk: _sk, entityType: _type, ...state } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- only the key attributes are dropped
    return state;
  };
  const agentTasks = (agentId: AgentId) => h.db.find((item) => item.pk === agentTasksKey(TEST_ORG, agentId, "2026-01-01T00:00:00.000Z", "x").pk);
  const pointer = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "DEVELOPER_TASK_POINTER")[0] as { pendingPrompt?: string } | undefined;
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const charges = () => h.db.find((item) => item.entityType === "DEVELOPER_LIMIT" || item.entityType === "SLACK_LIMIT");
  const taskCount = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
  const outboxes = () => h.db.find((item) => item.entityType === "OUTBOX");
  const workspaces = () => h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("WORKSPACE#") && item.sk === "META");
  const setupWatches = () => h.db.find((item) => item.entityType === "SETUP_WATCH");
  const starter = () => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no agent run starter");
    return found;
  };
  const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, ...extra,
  });
  return { ...h, access, store, call, agentOf, publishNext, putOnRoster, run, taskOf, meta, recipeItem, agentRunItem, agentTasks, pointer, operations, charges, taskCount, outboxes, workspaces, setupWatches, starter, request };
}

describe("a person starts a run on the app route", () => {
  it("stores the frozen recipe, the digest of the agent's current version, the agent on the task and its view, and the agent's task index", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { name: "Ticket looker" });
    const reply = await t.run(MAYA, agentId);
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    expect(task.agent).toEqual({ agentId, name: "Ticket looker", version: 1, builtin: false });
    const snapshot = t.recipeItem(task.taskId)!;
    expect(snapshot.orgId).toBe(TEST_ORG);
    expect(snapshot.digest).toBe(recipeDigest(await resolveAgent(t.store, TEST_ORG, agentId, "current")));
    expect(recipeDigest(ResolvedRecipeSchema.parse(snapshot.recipe))).toBe(snapshot.digest);
    expect(t.meta(task.taskId)).toMatchObject({ origin: "app", developerId: MAYA.developerId, agent: { agentId, name: "Ticket looker", version: 1, builtin: false, digest: snapshot.digest } });
    expect(t.meta(task.taskId).maxPerRunUsd).toBeUndefined();
    const indexed = t.agentTasks(agentId);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ orgId: TEST_ORG, taskId: task.taskId });
    // The index item expires on its own, about 90 days on.
    const days = (Number(indexed[0]!.indexExpiresAt) - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });

  it("keeps the digest of the version that was current at the start when the owner publishes version 2 during the run", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const task = t.taskOf(await t.run(MAYA, agentId));
    const before = t.recipeItem(task.taskId)!.digest;
    await t.publishNext(agentId, { instructions: "Something quite different.", sequence: [agentStep("work")] });
    expect(recipeDigest(await resolveAgent(t.store, TEST_ORG, agentId, "current"))).not.toBe(before);
    expect(t.recipeItem(task.taskId)!.digest).toBe(before);
    expect(t.meta(task.taskId).agent).toMatchObject({ version: 1, digest: before });
    const view = await t.call(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect((view.body.task as { agent: unknown }).agent).toMatchObject({ version: 1 });
  });

  it("writes AGENT_RUN and no workflow for a built-in agent-step agent, and starts nothing on the worker", async () => {
    const t = await setup();
    const reply = await t.run(MAYA, "ticket-triage", { input: { text: "Triage LIN-12", context: [{ kind: "ticket", ref: "LIN-12", title: "Login fails" }] } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    expect(task.agent).toMatchObject({ agentId: "ticket-triage", builtin: true });
    const stored = t.meta(task.taskId);
    expect(stored.workflow).toBeUndefined();
    const state = AgentRunStateSchema.parse(t.agentRunItem(task.taskId));
    expect(state).toMatchObject({ orgId: TEST_ORG, revision: 1, state: "RUNNING", cursor: 0, reports: [] });
    expect(state.input).toEqual({ text: "Triage LIN-12", context: [{ kind: "ticket", ref: "LIN-12", title: "Login fails" }] });
    expect(state.steps.length).toBeGreaterThan(0);
    expect(state.steps.every((step) => step.status === "pending" && step.operationIds.length === 0 && step.approvalIds.length === 0)).toBe(true);
    // The raw request is not queued as a coding task: the first operation after setup is the engine's (Task 22), never Pi's task run.
    expect(t.pointer(stored.workspaceId)?.pendingPrompt).toBeUndefined();
    expect(t.operations(stored.workspaceId).map((operation) => operation.kind)).toEqual(["prepare"]);
  });

  it("runs Rovara Code as a workflow whose request is the text unchanged, with its pinned version's snapshot and no program", async () => {
    const t = await setup();
    const reply = await t.run(MAYA, "rovara-code", { input: { text: "Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    const stored = t.meta(task.taskId);
    expect(stored.workflow).toMatchObject({ path: "QUICK", stage: "PLAN" });
    expect(stored.workflow?.program).toBeUndefined();
    expect(t.pointer(stored.workspaceId)?.pendingPrompt).toBe("Fix the retry bug");
    expect(stored.requestText).toBe("Fix the retry bug");
    expect(t.agentRunItem(task.taskId)).toBeUndefined();
    const pinned = (await t.store.ensureBuiltinSettings(TEST_ORG, "rovara-code")).pinnedVersion;
    expect(task.agent).toMatchObject({ agentId: "rovara-code", version: pinned, builtin: true });
    expect(t.recipeItem(task.taskId)!.digest).toBe(recipeDigest(await resolveAgent(t.store, TEST_ORG, "rovara-code", "current")));
  });

  it("gives a custom coding agent its own sequence as the workflow program", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING);
    const task = t.taskOf(await t.run(MAYA, agentId));
    const recipe = ResolvedRecipeSchema.parse(t.recipeItem(task.taskId)!.recipe);
    expect(codingProgram(recipe)).toBeDefined();
    expect(t.meta(task.taskId).workflow).toMatchObject({ program: codingProgram(recipe), programStepId: "plan" });
  });

  it("starts a coding run with the rendered request when the input has context, shortened to the request limit when it does not fit", async () => {
    const t = await setup();
    const input: RunInput = { text: "Review the failing deploy", context: [{ kind: "deploy", ref: "deploy-77", title: "Deploy 77", body: "The health check failed." }] };
    const task = t.taskOf(await t.run(MAYA, "rovara-code", { input }));
    expect(t.pointer(t.meta(task.taskId).workspaceId)?.pendingPrompt).toBe(renderRunInput(input));
    const body = "x".repeat(16_384);
    const big: RunInput = { text: "Read all of it", context: Array.from({ length: 10 }, (_, index) => ({ kind: "text" as const, ref: `note-${String(index)}`, body })) };
    const long = t.taskOf(await t.run(MAYA, "rovara-code", { input: big }));
    const prompt = t.pointer(t.meta(long.taskId).workspaceId)!.pendingPrompt!;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(65_536);
    expect(prompt.endsWith(SHORTENED_MARKER)).toBe(true);
    expect(prompt.startsWith("Request:\nRead all of it")).toBe(true);
  });

  it("refuses an agent that is not on the project's roster with the exact text, and charges nothing and writes no task", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { name: "Off roster", roster: false });
    const reply = await t.run(MAYA, agentId);
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: "AGENT_NOT_ON_PROJECT", message: "Off roster isn't working on payments yet. Ask a project maintainer to add it." });
    expect(t.charges()).toEqual([]);
    expect(t.taskCount()).toBe(0);
    expect(t.workspaces()).toEqual([]);
    expect(t.agentTasks(agentId)).toEqual([]);
  });

  it("resolves the agent before the budget is asked about: a refused agent never reaches the model proxy", async () => {
    const t = await setup({ proxy: true });
    const agentId = await t.agentOf(TRIAGE, { name: "Off roster", roster: false });
    const callsToProxy = () => [t.access!.spend, t.access!.orgSpend, t.access!.upsertOrg, t.access!.upsertMember].reduce((total, mock) => total + mock.mock.calls.length, 0);
    const before = callsToProxy();
    expect((await t.run(MAYA, agentId)).status).toBe(403);
    expect(callsToProxy()).toBe(before);
    // The budget is asked about for a run that is allowed.
    expect((await t.run(MAYA, "rovara-code")).status).toBe(202);
    expect(callsToProxy()).toBeGreaterThan(before);
  });

  it("treats a draft run by the agent's owner as a test run, allowed off the roster", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { name: "Draft agent", roster: false });
    const reply = await t.run(MAYA, agentId, { version: "draft" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    expect(task.agent).toMatchObject({ agentId, version: "draft", builtin: false });
    expect(t.meta(task.taskId)).toMatchObject({ origin: "test_run", agent: { version: "draft", draftRevision: expect.any(Number) as number } });
    expect(t.recipeItem(task.taskId)).toBeDefined();
  });

  it("starts one run for the same request ID sent twice, and refuses the same ID for a different request", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const requestId = randomUUID();
    const first = await t.run(MAYA, agentId, { requestId });
    const second = await t.run(MAYA, agentId, { requestId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(t.taskOf(second).taskId).toBe(t.taskOf(first).taskId);
    expect(t.taskCount()).toBe(1);
    expect(t.agentTasks(agentId)).toHaveLength(1);
    const other = await t.run(MAYA, agentId, { requestId, input: { text: "Something else" } });
    expect(other.status).toBe(409);
    expect(errorOf(other).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(t.taskCount()).toBe(1);
    // The request item is the org's own: its key is built from the org and it expires.
    const item = t.db.get(runRequestKey(TEST_ORG, requestId))!;
    expect(item).toMatchObject({ orgId: TEST_ORG, taskId: t.taskOf(first).taskId, paused: false });
    expect(String(item.pk)).toContain(TEST_ORG);
    expect(typeof item.indexExpiresAt).toBe("number");
  });

  it("answers an agent of another org with the same 404 as one that does not exist, and writes nothing", async () => {
    const t = await setup();
    seedMembership(t.db, OMAR.developerId, { orgId: ORG_B, role: "owner" });
    const foreign = (await t.call(OMAR, "POST", "/v1/app/agents", { name: "Other org agent", overlay: TRIAGE })).body.agent as { agentId: AgentId };
    expect(foreign.agentId).toMatch(/^agt_/);
    const crossed = await t.run(MAYA, foreign.agentId);
    const missing = await t.run(MAYA, `agt_${"0".repeat(20)}`);
    expect(crossed.status).toBe(404);
    expect(crossed.body).toEqual(missing.body);
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
  });

  it("refuses a project viewer with the viewer message before anything is written", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    await t.orgOf(KIT);
    t.db.set({ pk: `SESSION#${KIT.sessionId}`, sk: "META", sessionId: KIT.sessionId, developerId: KIT.developerId, amr: KIT.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    t.db.set({ pk: `DEVELOPER#${KIT.developerId}`, sk: "META", developerId: KIT.developerId, provider: "oidc", displayName: KIT.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(t.db, KIT.developerId, { orgId: TEST_ORG, role: "member" });
    const role: ProjectRole = "viewer";
    t.db.set({ ...projectMemberKey(TEST_ORG, KIT.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: KIT.developerId, projectName: "payments", grantId: randomUUID(), role: "viewer", projectRole: role });
    const reply = await t.run(KIT, agentId);
    expect(reply.status).toBe(403);
    expect(errorOf(reply).message).toContain(VIEWER_MESSAGE);
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
  });

  it("checks the recipe against the company's guardrails with the models the deployment serves", async () => {
    const t = await setup({ agents: { servableModels: async () => [{ provider: "openai", modelId: "gpt-6.1-sol" }] } });
    const agentId = await t.agentOf({ instructions: "Look.", sequence: [{ ...agentStep("work"), settings: { model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } } }] });
    const reply = await t.run(MAYA, agentId);
    expect(reply.status, JSON.stringify(reply.body)).toBe(403);
    expect(errorOf(reply).code).toBe("MODEL_NOT_ALLOWED");
    expect(t.taskCount()).toBe(0);
  });

  it("records a run whose owner left the org as creator_removed at its first dispatch, with no model key and no task operation", async () => {
    const t = await setup({ proxy: true });
    const reply = await t.run(MAYA, "rovara-code");
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    const { workspaceId } = t.meta(task.taskId);
    // The removal: the member record is gone and the tombstone is there (OrgStore writes both in one transaction).
    await t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) }));
    t.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" });
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    expect(t.operations(workspaceId).filter((operation) => operation.kind === "task")).toEqual([]);
    expect(t.meta(task.taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(t.access!.mintKey).not.toHaveBeenCalled();
  });
});

describe("the AI-tool route and the Slack start", () => {
  it("store Rovara Code at the org's pinned version for a start that names no agent, with the origin of the surface", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const task = t.taskOf(started);
    const pinned = (await t.store.ensureBuiltinSettings(TEST_ORG, "rovara-code")).pinnedVersion;
    expect(task.agent).toEqual({ agentId: "rovara-code", name: "Rovara Code", version: pinned, builtin: true });
    expect(t.meta(task.taskId)).toMatchObject({ origin: "cli", agent: { agentId: "rovara-code", version: pinned } });
    expect(t.recipeItem(task.taskId)!.digest).toBe(recipeDigest(await resolveAgent(t.store, TEST_ORG, "rovara-code", "current")));
    // No agent and no workflow is the plain task it always was: no workflow, no AGENT_RUN, the instructions as they were sent.
    expect(t.meta(task.taskId).workflow).toBeUndefined();
    expect(t.agentRunItem(task.taskId)).toBeUndefined();
    expect(t.pointer(t.meta(task.taskId).workspaceId)?.pendingPrompt).toBe("Fix the retry bug");
  });

  it("start an agent by name on /v1/dev/tasks, and refuse an agent when agents are not set up", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { name: "Named one" });
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Look", agent: { agentId }, input: { text: "Look" }, client: "test-client" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(t.taskOf(started).agent).toMatchObject({ agentId, name: "Named one" });
    const plain = await createDeveloperTaskBroker();
    const refused = await plain.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Look", agent: { agentId: "ticket-triage" }, client: "test-client" });
    expect(refused.status).toBe(400);
    expect((refused.body.error as { code: string }).code).toBe("CONFIG_INVALID");
  });

  it("refuses a workflow for an agent that does not write code, and an agent-step run whose instructions are too long to be its input", async () => {
    const t = await setup();
    const workflow = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Look", agent: { agentId: "ticket-triage" }, workflow: true, workflowPath: "QUICK", client: "test-client" });
    expect(workflow.status).toBe(400);
    expect(errorOf(workflow)).toEqual({ code: "CONFIG_INVALID", message: "Ticket triage doesn't write code, so it can't run as a coding workflow" });
    const long = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "x".repeat(9_000), agent: { agentId: "ticket-triage" }, client: "test-client" });
    expect(long.status).toBe(400);
    expect(errorOf(long).code).toBe("CONFIG_INVALID");
    expect(errorOf(long).message).toMatch(/^input: /);
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
    // The same long text is fine for a coding run, which is asked it as written.
    const coding = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "x".repeat(9_000), client: "test-client" });
    expect(coding.status, JSON.stringify(coding.body)).toBe(200);
  });

  it("changes the start request's shape only by an optional agent and input, and requires the instructions to equal the input's text", () => {
    const base = { requestId: randomUUID(), project: "payments", instructions: "Look", client: "c" };
    expect(StartDeveloperTaskRequestSchema.safeParse(base).success).toBe(true);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, agent: { agentId: "ticket-triage", version: "draft" }, input: { text: "Look" } }).success).toBe(true);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, agent: { agentId: "ticket-triage", version: 2 } }).success).toBe(true);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, input: { text: "Something else" } }).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, agent: { agentId: "not an id" } }).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, agent: { agentId: "ticket-triage", version: 0 } }).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...base, agent: { agentId: "ticket-triage", extra: 1 } }).success).toBe(false);
  });
});

describe("startAgentRun", () => {
  it("starts a person's run and returns the limits, and answers the same request ID again with the first answer and no second run", async () => {
    const t = await setup();
    const starter = t.starter();
    const request = t.request();
    const first = await startAgentRun(starter, request);
    expect(first).toEqual({ taskId: expect.any(String) as string, runLimitUsd: PER_TASK_BUDGET_USD, stopAtUsd: PER_TASK_BUDGET_USD, paused: false });
    const again = await startAgentRun(starter, request);
    expect(again).toEqual(first);
    expect(t.taskCount()).toBe(1);
    expect(t.meta(first.taskId)).toMatchObject({ developerId: MAYA.developerId, origin: "app", agent: { agentId: "rovara-code" } });
    expect(t.db.get(runRequestKey(TEST_ORG, request.requestId))).toMatchObject({ taskId: first.taskId, runLimitUsd: PER_TASK_BUDGET_USD, stopAtUsd: PER_TASK_BUDGET_USD, paused: false });
    const other = await refusal(startAgentRun(starter, { ...request, input: { text: "Different" } }));
    expect(other?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(t.taskCount()).toBe(1);
  });

  it("starts one run when the same request arrives twice at once", async () => {
    const t = await setup();
    const request = t.request();
    const [first, second] = await Promise.all([startAgentRun(t.starter(), request), startAgentRun(t.starter(), request)]);
    expect(second).toEqual(first);
    expect(t.taskCount()).toBe(1);
    expect(t.db.get(runRequestKey(TEST_ORG, request.requestId))).toMatchObject({ taskId: first.taskId });
  });

  it("makes the owner the task's developer, with the surface it came from", async () => {
    const t = await setup();
    const result = await startAgentRun(t.starter(), t.request({ origin: "mcp" }));
    expect(t.meta(result.taskId)).toMatchObject({ developerId: MAYA.developerId, origin: "mcp" });
  });

  it("copies the agent's max per run from its settings onto the task and stops at the smaller of it and the run limit", async () => {
    const t = await setup();
    await t.store.setBudget(TEST_ORG, "rovara-code", { maxPerRunUsd: 10 }, fixtureActor(t.store, TEST_ORG, OMAR.developerId).developerId, undefined, { ...({}), actor: fixtureActor(t.store, TEST_ORG, OMAR.developerId) });
    const capped = await startAgentRun(t.starter(), t.request());
    expect(capped).toMatchObject({ runLimitUsd: PER_TASK_BUDGET_USD, stopAtUsd: 10, paused: false });
    expect(t.meta(capped.taskId).maxPerRunUsd).toBe(10);
    const lower = await startAgentRun(t.starter(), t.request({ runLimitUsd: 4 }));
    expect(lower).toMatchObject({ runLimitUsd: 4, stopAtUsd: 4 });
    expect(t.meta(lower.taskId).maxPerRunUsd).toBe(10);
  });

  it("lets a request lower the run limit but never raise it", async () => {
    const t = await setup({ proxy: true });
    // Rovara Code runs as a Quick workflow, which starts at the $2 planning limit (Task 34).
    const lowered = await startAgentRun(t.starter(), t.request({ runLimitUsd: 1 }));
    expect(lowered).toMatchObject({ runLimitUsd: 1, stopAtUsd: 1, paused: false });
    expect(t.meta(lowered.taskId).budgetUsd).toBe(1);
    const raised = await startAgentRun(t.starter(), t.request({ runLimitUsd: 500 }));
    expect(raised).toMatchObject({ runLimitUsd: 2, stopAtUsd: 2 });
    expect(t.meta(raised.taskId).budgetUsd).toBe(2);
    expect(await refusal(startAgentRun(t.starter(), t.request({ runLimitUsd: -1 })))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("starts a run limited to zero paused: no workspace charge, nothing dispatched, and a task that still reads", async () => {
    const t = await setup({ proxy: true });
    const paused = t.request({ runLimitUsd: 0 });
    const result = await startAgentRun(t.starter(), paused);
    expect(result).toEqual({ taskId: expect.any(String) as string, runLimitUsd: 0, stopAtUsd: 0, paused: true });
    const stored = t.meta(result.taskId);
    expect(stored.budgetPause).toMatchObject({ scope: { kind: "task", taskId: result.taskId } });
    expect(stored.budgetUsd).toBe(0);
    expect(t.charges()).toEqual([]);
    expect(t.outboxes()).toEqual([]);
    expect(t.setupWatches()).toEqual([]);
    expect(t.access!.mintKey).not.toHaveBeenCalled();
    expect(t.db.get(runRequestKey(TEST_ORG, paused.requestId))).toMatchObject({ paused: true });
    const view = await t.call(MAYA, "GET", `/v1/dev/tasks/${result.taskId}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(t.taskOf(view).status).toBe("STARTING");
  });

  it("accepts only the payer the origin names (Task 29's rules are tested in payer-place.test.ts)", async () => {
    const t = await setup();
    const wrong = await refusal(startAgentRun(t.starter(), t.request({ payer: { kind: "project", project: "payments" } })));
    expect(wrong).toEqual({ code: "CONFIG_INVALID", message: "payer: this run's payer is not the one its origin names" });
    const someoneElse = await refusal(startAgentRun(t.starter(), t.request({ payer: { kind: "member", developerId: OMAR.developerId } })));
    expect(someoneElse?.code).toBe("CONFIG_INVALID");
    expect(t.taskCount()).toBe(0);
  });

  it("a payer the rules named moments ago (payerFromRules) that no longer matches is a retryable busy answer, never a charge to someone else (the setup run's start)", async () => {
    const t = await setup();
    const same = await startAgentRun(t.starter(), t.request({ payer: { kind: "member", developerId: MAYA.developerId }, payerFromRules: true }));
    expect(same.taskId).toBeTruthy();
    const moved = await refusal(startAgentRun(t.starter(), t.request({ requestId: randomUUID(), payer: { kind: "project", project: "payments" }, payerFromRules: true })));
    expect(moved).toEqual({ code: "WORKSPACE_BUSY", message: "the project's payment settings changed while starting; try again with the same request_id" });
    expect(t.taskCount()).toBe(1);
  });

  it("resolves an autonomous start through the roster first, then starts it with the agent as its payer", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { name: "Watcher", roster: false });
    const autonomous = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => {
      const { startedBy: _startedBy, ...rest } = t.request({ agent: { agentId }, origin: "schedule", payer: { kind: "agent", agentId }, ...extra }); // eslint-disable-line @typescript-eslint/no-unused-vars -- an autonomous start has none
      return rest;
    };
    expect(await refusal(startAgentRun(t.starter(), autonomous()))).toEqual({ code: "AGENT_NOT_ON_PROJECT", message: "Watcher isn't working on payments yet. Ask a project maintainer to add it." });
    t.putOnRoster(agentId);
    expect(t.taskCount()).toBe(0);
    const started = await startAgentRun(t.starter(), autonomous());
    expect(started.paused).toBe(false);
    expect(t.taskCount()).toBe(1);
    expect(t.meta(started.taskId)).toMatchObject({ origin: "schedule", developerId: MAYA.developerId, payer: { kind: "agent", agentId }, place: { project: "payments" } });
  });

  it("refuses a result contract on a coding recipe with the exact text and stores it on the run state of an agent-step recipe", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "wait", description: "Nothing to do" }] };
    expect(await refusal(startAgentRun(t.starter(), t.request({ resultContract: contract })))).toEqual({
      code: "CONFIG_INVALID", message: "resultContract: only agents with agent steps can choose a branch",
    });
    expect(t.taskCount()).toBe(0);
    const result = await startAgentRun(t.starter(), t.request({ agent: { agentId: "ticket-triage" }, resultContract: contract }));
    expect(AgentRunStateSchema.parse(t.agentRunItem(result.taskId)).resultContract).toEqual(contract);
  });

  it("validates what names something before it reads or writes anything", async () => {
    const t = await setup();
    const bad: Array<[string, Partial<AgentRunRequest>]> = [
      ["requestId", { requestId: "not-a-uuid" }],
      ["project", { project: "Not A Project/../" }],
      ["owner.developerId", { owner: { developerId: "abc" } }],
      ["input.text", { input: { text: "" } }],
      ["origin", { origin: "carrier-pigeon" as never }],
      ["runLimitUsd", { runLimitUsd: Number.NaN }],
    ];
    for (const [path, extra] of bad) {
      const refused = await refusal(startAgentRun(t.starter(), t.request(extra)));
      expect(refused?.code, path).toBe("CONFIG_INVALID");
      expect(refused?.message, path).toContain(path);
    }
    expect(t.taskCount()).toBe(0);
  });

  it("refuses a run for an owner who is not a member, and a route caller who is not the owner", async () => {
    const t = await setup();
    const stranger = "9".repeat(64);
    expect(await refusal(startAgentRun(t.starter(), t.request({ owner: { developerId: stranger }, startedBy: { developerId: stranger }, payer: { kind: "member", developerId: stranger } })))).toMatchObject({ code: "FORBIDDEN" });
    const someoneElse = { developerId: OMAR.developerId, sessionId: "s", amr: "oidc" as const, name: "Omar", orgId: TEST_ORG, orgRole: "member" as const };
    expect(await refusal(startAgentRun(t.starter(), t.request({ caller: someoneElse })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.taskCount()).toBe(0);
  });

  it("records a chain step on the task", async () => {
    const t = await setup();
    const result = await startAgentRun(t.starter(), t.request({ origin: "chain", chain: { chainRunId: "chn_1", stepId: "triage" } }));
    expect(t.meta(result.taskId)).toMatchObject({ origin: "chain", chain: { chainRunId: "chn_1", stepId: "triage" } });
  });
});

describe("a pull request in the run's context (PF16)", () => {
  const review = (ref: string) => ({ text: "Review this pull request", context: [{ kind: "pull_request" as const, ref, title: "Fix retry" }] });

  it("reads the head of a pull request of a project repository through the App for the org, and records it for the run's checkout", async () => {
    const pullRequestHead = vi.fn(async () => ({ headSha: HEAD }));
    const t = await setup({ agents: { pullRequestHead } });
    const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(pullRequestHead).toHaveBeenCalledTimes(1);
    expect(pullRequestHead).toHaveBeenCalledWith({ orgId: TEST_ORG, repositoryUrl: "https://github.com/example/demo.git", number: 12 });
    expect(AgentRunStateSchema.parse(t.agentRunItem(t.taskOf(reply).taskId)).checkout).toEqual([{ repository: "demo", pullRequest: 12, headSha: HEAD }]);
  });

  it("sends the run's preparation read-only (clone and checkout, none of the repository's code), with and without a pull request; a coding run's preparation is the usual one (runs I-2)", async () => {
    const pullRequestHead = vi.fn(async () => ({ headSha: HEAD }));
    const t = await setup({ agents: { pullRequestHead }, memberLimit: 10 });
    const prepares = () => t.outboxes().map((item) => item.invocation as { kind: string; payload: { checkout?: unknown; readOnly?: unknown } }).filter((invocation) => invocation.kind === "prepare");
    const withPullRequest = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(withPullRequest.status, JSON.stringify(withPullRequest.body)).toBe(202);
    expect(prepares()).toHaveLength(1);
    expect(prepares()[0]!.payload).toMatchObject({ readOnly: true, checkout: [{ repository: "demo", pullRequest: 12, headSha: HEAD }] });
    const withoutPullRequest = await t.run(MAYA, "code-reviewer", { input: { text: "Review the default branch" } });
    expect(withoutPullRequest.status, JSON.stringify(withoutPullRequest.body)).toBe(202);
    expect(prepares()).toHaveLength(2);
    expect(prepares()[1]!.payload.readOnly).toBe(true);
    const coding = await t.run(MAYA, "rovara-code", { input: { text: "Fix the retry bug" } });
    expect(coding.status, JSON.stringify(coding.body)).toBe(202);
    expect(prepares()).toHaveLength(3);
    expect(prepares()[2]!.payload.readOnly).toBeUndefined();
  });

  it("reads nothing for a repository that is not the project's, or for a reference that is not a pull request", async () => {
    const pullRequestHead = vi.fn(async () => ({ headSha: HEAD }));
    const t = await setup({ agents: { pullRequestHead }, memberLimit: 10 });
    for (const ref of ["someone/else#3", "example/demo", "example/demo#abc", "not a reference"]) {
      const reply = await t.run(MAYA, "code-reviewer", { input: review(ref) });
      expect(reply.status, ref).toBe(202);
      expect(AgentRunStateSchema.parse(t.agentRunItem(t.taskOf(reply).taskId)).checkout, ref).toBeUndefined();
    }
    expect(pullRequestHead).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub cannot say: the run is refused as unavailable and nothing is written or charged", async () => {
    const t = await setup({ agents: { pullRequestHead: async () => { throw new Error("GitHub is down"); } } });
    const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe("RUNTIME_UNAVAILABLE");
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
  });

  it("uses the broker's GitHub App for the org, with an agent token, when no reader is injected", async () => {
    const getAgentPullRequestHead = vi.fn(async () => ({ headSha: HEAD, state: "open" as const }));
    const t = await setup({ brokerExtra: { githubPullRequests: { getAgentPullRequestHead } } });
    const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    // The org's own scope, never the system scope the older reads of a private install pass.
    expect(getAgentPullRequestHead).toHaveBeenCalledWith("https://github.com/example/demo.git", 12, { orgId: TEST_ORG });
    expect(AgentRunStateSchema.parse(t.agentRunItem(t.taskOf(reply).taskId)).checkout?.[0]?.headSha).toBe(HEAD);
  });

  it("fails closed when the App can't read pull requests at all", async () => {
    const t = await setup({ brokerExtra: { githubPullRequests: {} } });
    const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(reply.status).toBe(503);
    expect(t.taskCount()).toBe(0);
  });

  describe("through the real GitHub App provider (PF10, PF16)", () => {
    const github = (answers: { pull?: Response; unbound?: boolean } = {}) => {
      const requests: Array<{ method: string; path: string; body?: { permissions?: Record<string, string>; repositories?: string[] } }> = [];
      const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
        requests.push({ method: init?.method ?? "GET", path: parsed.pathname, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as never } : {}) });
        if (parsed.pathname.endsWith("/installation")) return Response.json({ id: 55, account: { login: "example" } });
        if (parsed.pathname === "/app/installations/55/access_tokens") return Response.json({ token: "agent-token" }, { status: 201 });
        if (parsed.pathname === "/repos/example/demo/pulls/12") return answers.pull ?? Response.json({ number: 12, state: "open", merged: false, head: { sha: HEAD, ref: "fix" }, base: { ref: "main" } });
        return Response.json({ message: "unexpected" }, { status: 500 });
      }) as typeof fetch;
      return { fetchImplementation, requests };
    };
    const provider = (fake: ReturnType<typeof github>, bound: (orgId: OrgId) => Promise<void>) => new GitHubAppCredentialProvider({
      credentialRef: "github-app", appId: "123", getPrivateKey: async () => PRIVATE_KEY, fetchImplementation: fake.fetchImplementation,
      requireInstallationBound: async (orgId) => bound(orgId),
    });

    it("mints a token with pull requests and contents read plus metadata read, for the run's org, and records the head it read", async () => {
      const fake = github();
      const checked: OrgId[] = [];
      const t = await setup({ brokerExtra: { githubPullRequests: provider(fake, async (orgId) => { checked.push(orgId); }) } });
      const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      expect(checked).toEqual([TEST_ORG]);
      expect(fake.requests.filter((request) => request.path.endsWith("/access_tokens")).map((request) => request.body)).toEqual([
        { repositories: ["demo"], permissions: { pull_requests: "read", contents: "read", metadata: "read" } },
      ]);
      expect(AgentRunStateSchema.parse(t.agentRunItem(t.taskOf(reply).taskId)).checkout).toEqual([{ repository: "demo", pullRequest: 12, headSha: HEAD }]);
    });

    /** Pins the project's repository to an installation, as a project registered in a cloud org is. */
    const pin = (t: Awaited<ReturnType<typeof setup>>, installationId: number) => {
      const key = projectRevisionKey(TEST_ORG, "payments", 1);
      const revision = t.db.get(key.pk, key.sk) as { definition: { repositories: Array<Record<string, unknown>> } } & Record<string, unknown>;
      t.db.set({ ...revision, definition: { ...revision.definition, repositories: revision.definition.repositories.map((repository) => ({ ...repository, installationId })) } });
    };

    it("hands the project's pinned installation to the reader, and reads nothing when the repository is under another one (review M5)", async () => {
      const seen: unknown[] = [];
      const t = await setup({ agents: { pullRequestHead: async (input: unknown) => { seen.push(input); return { headSha: HEAD }; } } });
      pin(t, 55);
      expect((await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") })).status).toBe(202);
      expect(seen).toEqual([{ orgId: TEST_ORG, repositoryUrl: "https://github.com/example/demo.git", number: 12, installationId: 55 }]);

      const fake = github();
      const wrong = await setup({ brokerExtra: { githubPullRequests: provider(fake, async () => undefined) } });
      pin(wrong, 99);
      const reply = await wrong.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
      expect(reply.status).toBe(403);
      expect(errorOf(reply).code).toBe("GITHUB_NOT_CONNECTED");
      expect(fake.requests.some((request) => request.path.endsWith("/access_tokens"))).toBe(false);
      expect(wrong.taskCount()).toBe(0);

      const right = github();
      const fine = await setup({ brokerExtra: { githubPullRequests: provider(right, async () => undefined) } });
      pin(fine, 55);
      expect((await fine.run(MAYA, "code-reviewer", { input: review("example/demo#12") })).status).toBe(202);
    });

    it("reads nothing, and starts nothing, when the installation is not bound to the run's org", async () => {
      const fake = github();
      const t = await setup({ brokerExtra: { githubPullRequests: provider(fake, async () => { throw agentXError("GITHUB_NOT_CONNECTED", "GitHub isn't connected for this repository"); }) } });
      const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
      expect(reply.status).toBe(403);
      expect(errorOf(reply).code).toBe("GITHUB_NOT_CONNECTED");
      expect(fake.requests.some((request) => request.path.endsWith("/access_tokens") || request.path.includes("/pulls/"))).toBe(false);
      expect(t.taskCount()).toBe(0);
      expect(t.charges()).toEqual([]);
    });

    it("says a pull request that doesn't exist doesn't, and starts nothing", async () => {
      const fake = github({ pull: Response.json({ message: "Not Found" }, { status: 404 }) });
      const t = await setup({ brokerExtra: { githubPullRequests: provider(fake, async () => undefined) } });
      const reply = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
      expect(reply.status).toBe(400);
      expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "pull request 12 of example/demo doesn't exist" });
      expect(t.taskCount()).toBe(0);
    });
  });
});

// Plan 3 Task 16 fold-ins from the Task 15 review.
describe("what a start reads, whom it is for and what it refuses until the step engine exists", () => {
  const review = (ref: string) => ({ text: "Review this pull request", context: [{ kind: "pull_request" as const, ref, title: "Fix retry" }] });

  it("reads no pull request head for a coding run, so a GitHub outage cannot fail a Rovara Code start", async () => {
    const pullRequestHead = vi.fn(async () => { throw new Error("GitHub is down"); });
    const t = await setup({ agents: { pullRequestHead } });
    const reply = await t.run(MAYA, "rovara-code", { input: review("example/demo#12") });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(pullRequestHead).not.toHaveBeenCalled();
    expect(t.agentRunItem(t.taskOf(reply).taskId)).toBeUndefined();
    // The same outage still refuses a run that needs the head (an agent-step run).
    const needs = await t.run(MAYA, "code-reviewer", { input: review("example/demo#12") });
    expect(needs.status).toBe(503);
    expect(pullRequestHead).toHaveBeenCalledTimes(1);
  });

  it("refuses a run for an owner who is not a member of this org, writing nothing", async () => {
    const t = await setup();
    // OMAR belongs to another org here (the resolver above), so the run cannot act as him.
    const refused = await refusal(startAgentRun(t.starter(), t.request({ owner: { developerId: OMAR.developerId } })));
    expect(refused).toEqual({ code: "FORBIDDEN", message: "The person this run is for isn't a member of the organization." });
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
    expect(t.db.find((item) => item.entityType === "RUN_REQUEST")).toEqual([]);
  });

  it("admits a coding agent named on the start as the workflow it will be: QUICK unless the start asks for FULL", async () => {
    const t = await setup({ proxy: true });
    t.access!.setMemberSpent(TEST_ORG, MAYA.developerId, 27.5);
    const agentId = await t.agentOf(CODING);
    const named = (extra: Record<string, unknown>) => t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Make the change", agent: { agentId }, client: "test-client", ...extra });
    const full = await named({ workflow: true, workflowPath: "FULL" });
    expect(full.status, JSON.stringify(full.body)).toBe(402);
    expect(errorOf(full).code).toBe("BUDGET_EXCEEDED");
    expect(t.taskCount()).toBe(0);
    const quick = await named({});
    expect(quick.status, JSON.stringify(quick.body)).toBe(200);
    expect(t.meta(t.taskOf(quick).taskId).workflow).toMatchObject({ path: "QUICK" });
  });

  it("stores the snapshot, the origin and the agent of a workflow a Slack thread starts", async () => {
    const t = await setup();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000031" };
    const started = await t.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    expect(started.statusCode, started.body).toBe(200);
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const pinned = (await t.store.ensureBuiltinSettings(TEST_ORG, "rovara-code")).pinnedVersion;
    expect(t.meta(taskId)).toMatchObject({ origin: "slack", agent: { agentId: "rovara-code", version: pinned, builtin: true } });
    const snapshot = t.recipeItem(taskId)!;
    expect(snapshot.orgId).toBe(TEST_ORG);
    expect(snapshot.digest).toBe(recipeDigest(await resolveAgent(t.store, TEST_ORG, "rovara-code", "current")));
  });
});

describe("readTaskRecipe", () => {
  it("returns the frozen recipe and digest of a run, nothing for an older task, and nothing for another org's snapshot", async () => {
    const t = await setup();
    const task = t.taskOf(await t.run(MAYA, "ticket-triage"));
    const found = await readTaskRecipe({ documentClient: t.db, tableName: "state" }, task.taskId, TEST_ORG);
    expect(found?.digest).toBe(t.recipeItem(task.taskId)!.digest);
    expect(found?.recipe.chain[0]?.agentId).toBe("ticket-triage");
    expect(await readTaskRecipe({ documentClient: t.db, tableName: "state" }, randomUUID(), TEST_ORG)).toBeUndefined();
    await expect(readTaskRecipe({ documentClient: t.db, tableName: "state" }, task.taskId, ORG_B)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
