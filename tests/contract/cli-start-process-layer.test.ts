// "How we work": a start through `POST /v1/dev/tasks` (the CLI's `session start`, the AI tools' `agentx_start`, `agentx_start_task` and `agentx_start_workflow`, and a script token's start)
// names no agent, so it must run the project's published process layer exactly as the app's start does (`startCodeIntent` asks `projectProcessOf`). Before this, those starts ran the built-in
// Rovara Code and the project's layer never reached the task (0.5.17 SI-4, BUG-CLI-START-IGNORES-HOW-WE-WORK). An explicit agent keeps today's rule; a broken pointer refuses, as on the web.
import { fixtureActor, seedMaintainerGrant } from "../support/money-authority.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { ROVARA_CODE_AGENT_ID, projectAgentKey, projectPlaybookKey, recipeDigest, PROCESS_START_REFUSED_MESSAGE, type AgentId } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

type TaskView = { taskId: string; agent?: { agentId: string; version: number | string; builtin: boolean } };
type Meta = Record<string, unknown> & { agent?: Record<string, unknown>; origin?: string; workflow?: unknown };
type Recipe = { recipe: { chain: Array<{ agentId: string; name: string; builtin?: boolean }> } };

async function setup() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true } } });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, ROVARA_CODE_AGENT_ID);
  const publishNext = async (agentId: AgentId) => {
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
  };
  const layerOf = async (options: { publish?: boolean; purpose?: "process"; project?: string } = {}): Promise<AgentId> => {
    const created = await store.create({
      orgId: TEST_ORG, name: `payments ${options.purpose ?? "agent"} ${randomUUID().slice(0, 6)}`, owner: { kind: "project", project: options.project ?? "payments" }, accountable: { developerId: MAYA.developerId },
      extends: ROVARA_CODE_AGENT_ID, overlay: { instructions: "Always run the linter." }, ...(options.purpose === undefined ? {} : { purpose: options.purpose }), createdBy: MAYA.developerId,
    });
    if (options.publish !== false) await publishNext(created.agentId);
    // An ordinary agent works on the project only once it is on the roster; a process layer never is.
    if (options.purpose === undefined) h.db.set({ ...projectAgentKey(TEST_ORG, options.project ?? "payments", created.agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: options.project ?? "payments", agentId: created.agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return created.agentId;
  };
  const processLayer = (options: { publish?: boolean; project?: string } = {}) => layerOf({ ...options, purpose: "process" });
  const point = (agentId: AgentId | undefined, project = "payments") => h.db.set({
    ...projectPlaybookKey(TEST_ORG, project), entityType: "PROJECT_PLAYBOOK", orgId: TEST_ORG, revision: 1,
    defaultProcess: agentId === undefined ? { kind: "builtin" } : { kind: "project_process", agentId },
  });
  /** What the CLI's `session start` sends (packages/cli/src/developer/sessions.ts), and what the AI tools send when they name no agent. */
  const start = (extra: Record<string, unknown> = {}, project = "payments", requestId: string = randomUUID()) =>
    h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId, project, instructions: "Fix the retry bug", client: "agentx-cli", ...extra });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Meta;
  const recipe = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "RECIPE") as Recipe;
  const taskCount = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
  const sessions = () => h.db.find((item) => item.entityType === "AGENT_SESSION");
  const charges = () => h.db.find((item) => item.entityType === "DEVELOPER_LIMIT" || item.entityType === "SLACK_LIMIT");
  return { ...h, store, layerOf, processLayer, publishNext, point, start, meta, recipe, taskCount, sessions, charges };
}

const chainIds = (t: Awaited<ReturnType<typeof setup>>, taskId: string) => t.recipe(taskId).recipe.chain.map((entry) => entry.agentId);

describe("a start through POST /v1/dev/tasks (CLI, AI tools) runs the project's process", () => {
  it("runs the published process layer: the task records it and its frozen recipe chain includes it", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = (reply.body.task as TaskView).taskId;
    expect(t.meta(taskId)).toMatchObject({ origin: "cli", agent: { agentId: layer, version: 1, builtin: false } });
    expect(chainIds(t, taskId)).toEqual(expect.arrayContaining([layer, ROVARA_CODE_AGENT_ID]));
    expect(t.sessions()).toHaveLength(1);
  });

  it("runs the layer's newest published version", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const agent = (await t.store.get(TEST_ORG, layer))!;
    await t.store.saveDraft({ orgId: TEST_ORG, agentId: layer, overlay: { instructions: "Also run the formatter." }, expectedRevision: agent.draftRevision, by: MAYA.developerId });
    await t.publishNext(layer);
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.meta((reply.body.task as TaskView).taskId).agent).toMatchObject({ agentId: layer, version: 2 });
  });

  it("applies to the plan-first workflow start too (--workflow / workflow_path), and to a start with a run input", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const workflow = await t.start({ workflow: true, workflowPath: "QUICK" });
    expect(workflow.status, JSON.stringify(workflow.body)).toBe(200);
    expect(t.meta((workflow.body.task as TaskView).taskId).agent).toMatchObject({ agentId: layer, builtin: false });
    const withInput = await t.start({ input: { text: "Fix the retry bug" } });
    expect(withInput.status, JSON.stringify(withInput.body)).toBe(200);
    expect(t.meta((withInput.body.task as TaskView).taskId).agent).toMatchObject({ agentId: layer, builtin: false });
  });

  it("is unchanged for a project with no playbook document, or one that says built-in, or another project's pointer", async () => {
    const t = await setup();
    const none = await t.start();
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(t.meta((none.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    expect(chainIds(t, (none.body.task as TaskView).taskId)).toEqual([ROVARA_CODE_AGENT_ID]);
    t.point(undefined);
    const builtin = await t.start();
    expect(t.meta((builtin.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    const other = await t.processLayer({ project: "ops" });
    t.point(other, "ops");
    const elsewhere = await t.start();
    expect(t.meta((elsewhere.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    expect(chainIds(t, (elsewhere.body.task as TaskView).taskId)).toEqual([ROVARA_CODE_AGENT_ID]);
  });

  it("keeps the explicit-agent rule: a named agent runs as named, the process is not substituted, and naming the layer itself is still refused", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const ordinary = await t.layerOf();
    const named = await t.start({ agent: { agentId: ordinary } });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(t.meta((named.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ordinary, builtin: false });
    expect(chainIds(t, (named.body.task as TaskView).taskId)).not.toContain(layer);
    // The built-in named on purpose stays the built-in, as the web's agent runs route does.
    const builtin = await t.start({ agent: { agentId: ROVARA_CODE_AGENT_ID } });
    expect(builtin.status, JSON.stringify(builtin.body)).toBe(200);
    expect(t.meta((builtin.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    // Naming the process layer by id is refused, as before (a process layer is only run as the project's process).
    const direct = await t.start({ agent: { agentId: layer } });
    expect(direct.status).toBe(404);
  });

  it("refuses with the web's one message when the pointer is to a layer archived since, and starts nothing", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    seedMaintainerGrant(t.db, TEST_ORG, MAYA.developerId, "payments");
    await t.store.archive(TEST_ORG, layer, MAYA.developerId, undefined, { actor: fixtureActor(t.store, TEST_ORG, MAYA.developerId) });
    const reply = await t.start();
    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: PROCESS_START_REFUSED_MESSAGE });
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toHaveLength(0);
    expect(t.charges()).toHaveLength(0);
  });

  it("refuses for an unpublished layer and an unreadable document rather than running the built-in", async () => {
    const t = await setup();
    t.point(await t.processLayer({ publish: false }));
    expect((await t.start()).body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: PROCESS_START_REFUSED_MESSAGE });
    t.db.set({ ...projectPlaybookKey(TEST_ORG, "payments"), entityType: "PROJECT_PLAYBOOK", orgId: TEST_ORG, revision: 2, defaultProcess: { kind: "somewhere_else" } });
    expect((await t.start()).body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: PROCESS_START_REFUSED_MESSAGE });
    expect(t.taskCount()).toBe(0);
  });

  it("answers a repeat of the same request with the first task, even after the layer published again", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const requestId = randomUUID();
    const first = await t.start({}, "payments", requestId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const agent = (await t.store.get(TEST_ORG, layer))!;
    await t.store.saveDraft({ orgId: TEST_ORG, agentId: layer, overlay: { instructions: "Changed." }, expectedRevision: agent.draftRevision, by: MAYA.developerId });
    await t.publishNext(layer);
    const again = await t.start({}, "payments", requestId);
    expect((again.body.task as TaskView).taskId).toBe((first.body.task as TaskView).taskId);
    expect(t.taskCount()).toBe(1);
  });
});

describe("only a person's own plain start takes the project's process", () => {
  it("a replay copy (a start passed run options, naming no agent) stays on the built-in Rovara Code, as a copy is a plain start", async () => {
    const t = await setup();
    const layer = await t.processLayer();
    t.point(layer);
    const starter = createAgentRunStarter(t.brokerInput as never)!;
    const caller = (await starter.callerFor(TEST_ORG, MAYA.developerId))!;
    const copy = await starter.startTask(caller, { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code" },
      { origin: "cli", autonomous: false, startedBy: { developerId: MAYA.developerId }, runLimitUsd: 2, evalReplay: { memory: { mode: "off" }, sourceTaskId: "past-1" } });
    expect(t.meta(copy.task.taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    expect(chainIds(t, copy.task.taskId)).toEqual([ROVARA_CODE_AGENT_ID]);
  });
});
