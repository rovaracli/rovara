// Plan 3 Task 29: every dollar has a payer and a place. `resolvePayer` names who pays from the origin of the work, `budgetScopesFor` names the budgets that
// payer and place are counted against, the start records both on the task, and the model proxy key carries them: a key is minted in a member's name
// (`user_id`) only for a member payer, and always with tags that say who pays and what ran.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun, type AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { agentUsageCounter, budgetScopesFor, paymentOfTask, resolvePayer, type ResolvePayerInput } from "../../packages/broker/src/spend/payer.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { WORK_ORIGINS, PlaceSchema, type Payer, type WorkOrigin } from "../../packages/contracts/src/agent-run.js";
import { scopeKey } from "../../packages/contracts/src/spend.js";
import { projectAgentKey, projectAiKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { AgentId } from "../../packages/contracts/src/agent.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe.js";
import { MAYA as DEV_MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const MAYA = "1".repeat(64);
const OMAR = "2".repeat(64);
const KIT = "3".repeat(64);
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa" as never;
const OTHER_AGENT = "agt_bbbbbbbbbbbbbbbbbbbbbbbb" as never;

const base = (extra: Partial<ResolvePayerInput> = {}): ResolvePayerInput => ({ origin: "app", project: "payments", projectPays: false, agentId: AGENT, startedBy: { developerId: MAYA }, ...extra });
const code = (action: () => unknown) => { try { action(); } catch (error) { return (error as { code?: string; message: string }); } throw new Error("expected a throw"); };

describe("resolvePayer", () => {
  it("makes the person who started a person-started run the payer, for every origin a person starts from", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(resolvePayer(base({ origin })), origin).toEqual({ kind: "member", developerId: MAYA });
    }
  });

  it("makes the project the payer of a person-started run when the project pays", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(resolvePayer(base({ origin, projectPays: true })), origin).toEqual({ kind: "project", project: "payments" });
    }
  });

  it("refuses a person-started run that names no one who started it", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      const { startedBy: _startedBy, ...rest } = base({ origin }); // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that it is absent
      expect(code(() => resolvePayer(rest)), origin).toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("makes the project pay for a test run, whoever started it and whether or not the project pays", () => {
    expect(resolvePayer(base({ origin: "test_run" }))).toEqual({ kind: "project", project: "payments" });
    expect(resolvePayer(base({ origin: "test_run", projectPays: true }))).toEqual({ kind: "project", project: "payments" });
  });

  it("makes the agent pay for work an event or a schedule starts, even when the project pays", () => {
    for (const origin of ["event", "schedule"] as const) {
      const { startedBy: _startedBy, ...rest } = base({ origin }); // eslint-disable-line @typescript-eslint/no-unused-vars -- no person started it
      expect(resolvePayer(rest), origin).toEqual({ kind: "agent", agentId: AGENT });
      expect(resolvePayer({ ...rest, projectPays: true }), origin).toEqual({ kind: "agent", agentId: AGENT });
    }
  });

  it("returns the chain payer the chain supplied, and refuses a chain run without one", () => {
    const chainPayer: Payer = { kind: "member", developerId: OMAR };
    expect(resolvePayer(base({ origin: "chain", chainPayer }))).toEqual(chainPayer);
    // The chain's payer wins over the project paying: Plan 4 decided it with the chain's own rules.
    expect(resolvePayer(base({ origin: "chain", chainPayer, projectPays: true }))).toEqual(chainPayer);
    expect(code(() => resolvePayer(base({ origin: "chain" })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(code(() => resolvePayer(base({ origin: "chain", projectPays: true })))).toMatchObject({ code: "CONFIG_INVALID" });
    // A chain payer is not looked at for any other origin.
    expect(resolvePayer(base({ origin: "app", chainPayer }))).toEqual({ kind: "member", developerId: MAYA });
  });

  it("makes the person who assigned a Linear issue pay, a bot's approver pay, and the project pay when no one approved", () => {
    const linear = (extra: Partial<ResolvePayerInput>) => { const { startedBy: _startedBy, ...rest } = base({ origin: "linear", ...extra }); return resolvePayer(rest); }; // eslint-disable-line @typescript-eslint/no-unused-vars -- Linear work has no starter
    expect(linear({ assignedBy: { developerId: OMAR, bot: false } })).toEqual({ kind: "member", developerId: OMAR });
    expect(linear({ assignedBy: { bot: true } })).toEqual({ kind: "project", project: "payments" });
    expect(linear({ assignedBy: { bot: true }, approvedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    // A person Rovara has no member for is treated like a bot: their approver, else the project.
    expect(linear({ assignedBy: { bot: false } })).toEqual({ kind: "project", project: "payments" });
    expect(linear({ assignedBy: { bot: false }, approvedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    // No assigner at all is the same as no one the work can be charged to but the project.
    expect(linear({})).toEqual({ kind: "project", project: "payments" });
  });

  it("lets a project that pays take a Linear run, and only a person assigner or approver is skipped by it", () => {
    const { startedBy: _startedBy, ...rest } = base({ origin: "linear", projectPays: true, assignedBy: { developerId: OMAR, bot: false } }); // eslint-disable-line @typescript-eslint/no-unused-vars -- Linear work has no starter
    expect(resolvePayer(rest)).toEqual({ kind: "project", project: "payments" });
  });

  it("makes the person who accepted an offer pay, or the project when it pays, and refuses an offer no one accepted", () => {
    const offer = (extra: Partial<ResolvePayerInput>) => { const { startedBy: _startedBy, ...rest } = base({ origin: "offer", ...extra }); return resolvePayer(rest); }; // eslint-disable-line @typescript-eslint/no-unused-vars -- an offer has no starter
    expect(offer({ acceptedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    expect(offer({ acceptedBy: { developerId: KIT }, projectPays: true })).toEqual({ kind: "project", project: "payments" });
    expect(code(() => offer({}))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("covers every origin: each one is either resolved or refused for lack of its facts, never left to a default", () => {
    const resolved: Partial<Record<WorkOrigin, Payer["kind"]>> = {};
    for (const origin of WORK_ORIGINS) {
      const chainPayer: Payer = { kind: "project", project: "payments" };
      const input = base({ origin, chainPayer, assignedBy: { developerId: OMAR, bot: false }, acceptedBy: { developerId: KIT } });
      resolved[origin] = resolvePayer(input).kind;
    }
    expect(resolved).toEqual({
      app: "member", cli: "member", mcp: "member", slack: "member", linear: "member", offer: "member",
      test_run: "project", event: "agent", schedule: "agent", chain: "project",
    });
    // And with the project paying, only the origins above projectPays in the order keep their payer.
    const paying: Partial<Record<WorkOrigin, Payer["kind"]>> = {};
    for (const origin of WORK_ORIGINS) {
      paying[origin] = resolvePayer(base({ origin, projectPays: true, chainPayer: { kind: "member", developerId: OMAR }, assignedBy: { developerId: OMAR, bot: false }, acceptedBy: { developerId: KIT } })).kind;
    }
    expect(paying).toEqual({
      app: "project", cli: "project", mcp: "project", slack: "project", linear: "project", offer: "project",
      test_run: "project", event: "agent", schedule: "agent", chain: "member",
    });
  });
});

describe("budgetScopesFor", () => {
  const keys = (scopes: ReturnType<typeof budgetScopesFor>) => scopes.map(scopeKey);
  const place = { project: "payments" };

  it("always has the org and the project, and adds the member for a member payer", () => {
    expect(keys(budgetScopesFor({ kind: "member", developerId: MAYA }, place, { agentId: AGENT }))).toEqual(["ORG", "PROJECT#payments", `MEMBER#${MAYA}`]);
  });

  it("does not add the member when the project pays", () => {
    expect(keys(budgetScopesFor({ kind: "project", project: "payments" }, place, { agentId: AGENT }))).toEqual(["ORG", "PROJECT#payments"]);
  });

  it("adds the agent only for an agent payer", () => {
    expect(keys(budgetScopesFor({ kind: "agent", agentId: AGENT }, place, { agentId: AGENT }))).toEqual(["ORG", "PROJECT#payments", `AGENT#${String(AGENT)}`]);
  });

  it("never adds the agent to work a person started, whatever budget the agent has", () => {
    for (const payer of [{ kind: "member", developerId: MAYA }, { kind: "project", project: "payments" }] as const) {
      expect(keys(budgetScopesFor(payer, place, { agentId: AGENT })).some((key) => key.startsWith("AGENT#")), payer.kind).toBe(false);
    }
  });

  it("adds the starter's testing allowance for a test run, and not the member", () => {
    expect(keys(budgetScopesFor({ kind: "project", project: "payments" }, place, { agentId: AGENT, testRunBy: MAYA }))).toEqual(["ORG", "PROJECT#payments", `TESTING#${MAYA}`]);
    // Even a member payer on a test run is counted on the allowance, not on the member's own limit.
    expect(keys(budgetScopesFor({ kind: "member", developerId: MAYA }, place, { agentId: AGENT, testRunBy: MAYA }))).toEqual(["ORG", "PROJECT#payments", `TESTING#${MAYA}`]);
  });

  it("uses the place's project, so a Slack thread's bound project is the one counted", () => {
    expect(keys(budgetScopesFor({ kind: "member", developerId: MAYA }, { project: "billing" }, { agentId: AGENT }))).toEqual(["ORG", "PROJECT#billing", `MEMBER#${MAYA}`]);
  });

  it("counts an agent payer's own agent, not the agent named in the options", () => {
    expect(keys(budgetScopesFor({ kind: "agent", agentId: AGENT }, place, { agentId: OTHER_AGENT }))).toEqual(["ORG", "PROJECT#payments", `AGENT#${String(AGENT)}`]);
  });

  it("names the usage counter every expense adds to, which is not a scope", () => {
    expect(agentUsageCounter(AGENT)).toBe(`AGENT_USAGE#${String(AGENT)}`);
  });
});

describe("the place", () => {
  it("is a project name and nothing else", () => {
    expect(PlaceSchema.parse({ project: "payments" })).toEqual({ project: "payments" });
    expect(PlaceSchema.safeParse({ project: "Not A Name!" }).success).toBe(false);
    expect(PlaceSchema.safeParse({ project: "payments", extra: 1 }).success).toBe(false);
  });
});

// ---- the start and the model key ----

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const KIT_DEV: Developer = { developerId: KIT, name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const CODING: RecipeOverlay = {
  instructions: "Make the change the request asks for.",
  sequence: [
    { id: "plan", name: "Plan", kind: "plan" },
    { id: "build", name: "Build", kind: "build" },
    { id: "check", name: "Check", kind: "check" },
    { id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 2 } },
  ],
};

async function setup(options: { agents?: boolean } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({
    brokerExtra: { ...(options.agents === false ? {} : { agents: { agentStepRuns: true } }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true },
  });
  access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const call_ = async (who: Developer, method: string, path: string, body?: Record<string, unknown>) => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    return reply;
  };
  /** An agent made by Maya, published and on the payments roster. */
  const agentOf = async (overlay: RecipeOverlay = CODING): Promise<AgentId> => {
    const created = await call_(DEV_MAYA, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    const { AgentStore, resolveAgent } = await import("../../packages/broker/src/agents/store.js");
    const { recipeDigest } = await import("../../packages/contracts/src/agent-recipe.js");
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: DEV_MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: DEV_MAYA.developerId });
    h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: DEV_MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return agentId;
  };
  const projectPays = (pays: boolean) => h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: pays, revision: 1 });
  /** Kit joins the org with a role on payments (a contributor unless told otherwise); he is a signed-in developer the starter can act as. */
  const addKit = (role: "contributor" | "viewer" | "none" = "contributor") => {
    h.db.set({ pk: `DEVELOPER#${KIT}`, sk: "META", developerId: KIT, provider: "oidc", displayName: KIT_DEV.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, KIT, { orgId: TEST_ORG, role: "member" });
    if (role !== "none") h.db.set({ ...projectMemberKey(TEST_ORG, KIT, "payments"), entityType: "MEMBERSHIP", ownerKey: KIT, projectName: "payments", grantId: randomUUID(), role: role === "viewer" ? "viewer" : "developer", projectRole: role });
  };
  const starter = () => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no agent run starter");
    return found;
  };
  const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: DEV_MAYA.developerId }, startedBy: { developerId: DEV_MAYA.developerId }, payer: { kind: "member", developerId: DEV_MAYA.developerId }, ...extra,
  });
  const autonomous = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => {
    const { startedBy: _startedBy, ...rest } = request({ origin: "schedule", ...extra }); // eslint-disable-line @typescript-eslint/no-unused-vars -- no person started it
    return rest;
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; payer?: Payer; place?: { project: string }; origin?: string; developerId: string; project: string };
  /** Finishes the task's preparation, then asks the model proxy endpoint, as the worker does, for a key; answers the input the proxy was given. */
  const mintFor = async (taskId: string) => {
    const { workspaceId } = meta(taskId);
    const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(workspaceId, active(), "SUCCEEDED", PREPARED);
    const operationId = active();
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    const before = access.mintKey.mock.calls.length;
    const reply = await call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(access.mintKey.mock.calls.length).toBe(before + 1);
    return { input: access.mintKey.mock.calls.at(-1)![0], operationId };
  };
  const taskCount = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
  return { ...h, access, call: call_, agentOf, projectPays, addKit, starter, request, autonomous, meta, mintFor, taskCount };
}

describe("a person-started run records its payer and place", () => {
  it("records the person who started it as the payer, and the project as the place, on the app route", async () => {
    const t = await setup();
    const reply = await t.call(DEV_MAYA, "POST", "/v1/app/agents/rovara-code/runs", { project: "payments", input: { text: "Fix it" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta((reply.body.task as { taskId: string }).taskId);
    expect(stored).toMatchObject({ payer: { kind: "member", developerId: DEV_MAYA.developerId }, place: { project: "payments" }, origin: "app" });
  });

  it("records them for the AI-tool route (origin cli) and for a project that pays", async () => {
    const t = await setup();
    const first = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(t.meta((first.body.task as { taskId: string }).taskId)).toMatchObject({ payer: { kind: "member", developerId: DEV_MAYA.developerId }, place: { project: "payments" }, origin: "cli" });
    t.projectPays(true);
    const second = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it again", client: "claude-code" });
    expect(t.meta((second.body.task as { taskId: string }).taskId)).toMatchObject({ payer: { kind: "project", project: "payments" }, place: { project: "payments" } });
  });

  it("writes neither field on an install without agents", async () => {
    const t = await setup({ agents: false });
    const reply = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it", client: "claude-code" });
    const stored = t.meta((reply.body.task as { taskId: string }).taskId);
    expect(stored.payer).toBeUndefined();
    expect(stored.place).toBeUndefined();
  });

  it("charges a project payer's start to the org alone: a member over their own limit still starts", async () => {
    const t = await setup();
    t.projectPays(true);
    t.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 29);
    const reply = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // Without the project paying the same member is refused.
    t.projectPays(false);
    const refused = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it more", client: "claude-code" });
    expect(refused.status).toBe(402);
  });

  it("makes a draft test run the project's expense with the starter's allowance, never the member's", async () => {
    const t = await setup();
    const agentId = await t.agentOf();
    const reply = await t.call(DEV_MAYA, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", version: "draft", input: { text: "Try it" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const stored = t.meta(taskId);
    expect(stored).toMatchObject({ origin: "test_run", payer: { kind: "project", project: "payments" }, place: { project: "payments" } });
    const payment = paymentOfTask(stored as never);
    expect(payment.scopes.map(scopeKey)).toEqual(["ORG", "PROJECT#payments", `TESTING#${DEV_MAYA.developerId}`]);
    expect(payment.scopes.some((scope) => scope.kind === "member")).toBe(false);
    const { input } = await t.mintFor(taskId);
    expect(input).not.toHaveProperty("developerId");
    expect(input.tags).toMatchObject({ payerKind: "project", payerId: "payments", origin: "test_run", project: "payments", agentId });
  });
});

describe("startAgentRun resolves the payer from the origin", () => {
  it("refuses a payer that is not the one the origin names, and writes nothing", async () => {
    const t = await setup();
    const wrong = await refusal(startAgentRun(t.starter(), t.request({ payer: { kind: "project", project: "payments" } })));
    expect(wrong).toMatchObject({ code: "CONFIG_INVALID" });
    expect(wrong?.message).toMatch(/^payer: /);
    t.addKit();
    expect(await refusal(startAgentRun(t.starter(), t.request({ payer: { kind: "member", developerId: KIT } })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await refusal(startAgentRun(t.starter(), t.request({ payer: { kind: "agent", agentId: "rovara-code" } })))).toMatchObject({ code: "CONFIG_INVALID" });
    // The project paying makes the project the only right answer.
    t.projectPays(true);
    expect(await refusal(startAgentRun(t.starter(), t.request()))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.taskCount()).toBe(0);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    expect(t.db.find((item) => item.entityType === "RUN_REQUEST")).toEqual([]);
  });

  it("accepts the project as the payer when the project pays", async () => {
    const t = await setup();
    t.projectPays(true);
    const started = await startAgentRun(t.starter(), t.request({ payer: { kind: "project", project: "payments" } }));
    expect(t.meta(started.taskId)).toMatchObject({ payer: { kind: "project", project: "payments" }, place: { project: "payments" } });
  });

  it("starts an event or schedule run the agent pays for, as its owner, with no one as the starter", async () => {
    const t = await setup();
    const agentId = await t.agentOf();
    const started = await startAgentRun(t.starter(), t.autonomous({ agent: { agentId }, payer: { kind: "agent", agentId } }));
    expect(started.paused).toBe(false);
    expect(t.meta(started.taskId)).toMatchObject({ payer: { kind: "agent", agentId }, place: { project: "payments" }, origin: "schedule", developerId: DEV_MAYA.developerId });
    const { input, operationId } = await t.mintFor(started.taskId);
    // An agent pays, so no member's name is on the key; the org's remainder caps it.
    expect(input).not.toHaveProperty("developerId");
    expect(input.tags).toEqual({ taskId: started.taskId, operationId, agentId, project: "payments", payerKind: "agent", payerId: agentId, source: "rovara", origin: "schedule" });
    const scopes = paymentOfTask(t.meta(started.taskId) as never).scopes.map(scopeKey);
    expect(scopes).toEqual(["ORG", "PROJECT#payments", `AGENT#${agentId}`]);
    for (const origin of ["event"] as const) {
      const again = await startAgentRun(t.starter(), t.autonomous({ origin, agent: { agentId }, payer: { kind: "agent", agentId } }));
      expect(t.meta(again.taskId)).toMatchObject({ payer: { kind: "agent", agentId }, origin });
    }
  });

  it("refuses an autonomous run whose payer is not its agent, and one that names a starter", async () => {
    const t = await setup();
    const agentId = await t.agentOf();
    expect(await refusal(startAgentRun(t.starter(), t.autonomous({ agent: { agentId }, payer: { kind: "member", developerId: DEV_MAYA.developerId } })))).toMatchObject({ code: "CONFIG_INVALID" });
    t.projectPays(true);
    expect(await refusal(startAgentRun(t.starter(), t.autonomous({ agent: { agentId }, payer: { kind: "project", project: "payments" } })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.taskCount()).toBe(0);
  });

  it("takes a chain run's payer from the chain and refuses any other", async () => {
    const t = await setup();
    const chain = { chainRunId: "chain-1", stepId: "triage" };
    const ok = await startAgentRun(t.starter(), t.autonomous({ origin: "chain", chain, payer: { kind: "member", developerId: DEV_MAYA.developerId } }));
    expect(t.meta(ok.taskId)).toMatchObject({ payer: { kind: "member", developerId: DEV_MAYA.developerId }, origin: "chain", chain });
    // A chain run with no payer named has no one to charge, and a person-started chain pays as the person: nothing else is guessed.
    const { payer: _payer, ...unnamed } = t.autonomous({ origin: "chain", chain }); // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that it is absent
    expect(await refusal(startAgentRun(t.starter(), unnamed))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.taskCount()).toBe(1);
  });

  it("validates the payer facts like any other part of the request", async () => {
    const t = await setup();
    for (const payerFacts of [{ acceptedBy: { developerId: "abc" } }, { assignedBy: { bot: "yes" }}, { approvedBy: { developerId: KIT, extra: 1 } }, { unknown: true }]) {
      expect(await refusal(startAgentRun(t.starter(), t.autonomous({ origin: "offer", payerFacts: payerFacts as never }))), JSON.stringify(payerFacts)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.taskCount()).toBe(0);
  });

  it("names the payer of an offered run and of a Linear run from the facts the origin carries", async () => {
    const t = await setup();
    t.addKit();
    const offered = await startAgentRun(t.starter(), t.autonomous({ origin: "offer", payerFacts: { acceptedBy: { developerId: KIT } }, payer: { kind: "member", developerId: KIT } }));
    expect(t.meta(offered.taskId)).toMatchObject({ payer: { kind: "member", developerId: KIT }, origin: "offer", developerId: DEV_MAYA.developerId });
    const linear = await startAgentRun(t.starter(), t.autonomous({ origin: "linear", payerFacts: { assignedBy: { bot: true } }, payer: { kind: "project", project: "payments" } }));
    expect(t.meta(linear.taskId)).toMatchObject({ payer: { kind: "project", project: "payments" }, origin: "linear" });
    // An offer with no acceptance named has no payer.
    expect(await refusal(startAgentRun(t.starter(), t.autonomous({ origin: "offer", payer: { kind: "member", developerId: KIT } })))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("lets a person start a run owned by someone else and bills the starter, whose name is on the key", async () => {
    const t = await setup();
    t.addKit();
    t.access.setMemberSpent(TEST_ORG, KIT, 0);
    const started = await startAgentRun(t.starter(), t.request({ owner: { developerId: KIT } }));
    expect(t.meta(started.taskId)).toMatchObject({ developerId: KIT, payer: { kind: "member", developerId: DEV_MAYA.developerId }, place: { project: "payments" } });
    const { input } = await t.mintFor(started.taskId);
    expect(input).toMatchObject({ developerId: DEV_MAYA.developerId });
    expect(input.tags).toMatchObject({ payerKind: "member", payerId: DEV_MAYA.developerId });
  });

  it("refuses a starter other than the owner who may only view the project, before anything is written", async () => {
    const t = await setup();
    t.addKit("viewer");
    const refused = await refusal(startAgentRun(t.starter(), t.request({ owner: { developerId: DEV_MAYA.developerId }, startedBy: { developerId: KIT }, payer: { kind: "member", developerId: KIT } })));
    expect(refused).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    // Even when the project pays, the starter is checked: being named must not be a way round the viewer rule.
    t.projectPays(true);
    const { payer: _payer, ...unnamed } = t.request({ startedBy: { developerId: KIT } }); // eslint-disable-line @typescript-eslint/no-unused-vars -- the payer is left to the rules
    expect(await refusal(startAgentRun(t.starter(), unnamed))).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(t.taskCount()).toBe(0);
  });

  it("refuses a member payer who is not in the org, or who may only view the project, before anything is written", async () => {
    const t = await setup();
    const stranger = "9".repeat(64);
    expect(await refusal(startAgentRun(t.starter(), t.autonomous({ origin: "offer", payerFacts: { acceptedBy: { developerId: stranger } }, payer: { kind: "member", developerId: stranger } })))).toMatchObject({ code: "FORBIDDEN" });
    t.addKit("viewer");
    const viewer = await refusal(startAgentRun(t.starter(), t.autonomous({ origin: "offer", payerFacts: { acceptedBy: { developerId: KIT } }, payer: { kind: "member", developerId: KIT } })));
    expect(viewer).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(viewer?.message).toContain(VIEWER_MESSAGE);
    expect(t.taskCount()).toBe(0);
    expect(t.db.find((item) => item.entityType === "RUN_REQUEST")).toEqual([]);
  });

  it("answers a repeat of a request from the first run, and the same id with another payer fact is a conflict", async () => {
    const t = await setup();
    t.addKit();
    const request = t.autonomous({ origin: "offer", payerFacts: { acceptedBy: { developerId: KIT } }, payer: { kind: "member", developerId: KIT } });
    const first = await startAgentRun(t.starter(), request);
    expect(await startAgentRun(t.starter(), request)).toEqual(first);
    expect(t.taskCount()).toBe(1);
    expect(await refusal(startAgentRun(t.starter(), { ...request, payerFacts: { acceptedBy: { developerId: DEV_MAYA.developerId } }, payer: { kind: "member", developerId: DEV_MAYA.developerId } }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not start when the project's payer setting changes between reading it and the start, and the retry uses the new setting", async () => {
    const t = await setup();
    const { payer: _payer, ...unnamed } = t.request(); // eslint-disable-line @typescript-eslint/no-unused-vars -- the payer is left to the rules
    // The setting flips to "project pays" right after the start's own read of it (the second read: the first is the request's early check).
    const send = t.db.send.bind(t.db);
    let reads = 0;
    t.db.send = (async (command: { constructor: { name: string }; input?: { Key?: { pk?: string } } }) => {
      const result = await send(command as never);
      if (command.constructor.name === "GetCommand" && command.input?.Key?.pk?.includes("PROJECT_AI#payments") === true) {
        reads += 1;
        if (reads === 2) t.projectPays(true);
      }
      return result;
    });
    const refused = await refusal(startAgentRun(t.starter(), unnamed));
    expect(refused).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(t.taskCount()).toBe(0);
    expect(t.db.find((item) => item.entityType === "RUN_REQUEST")).toEqual([]);
    const retried = await startAgentRun(t.starter(), unnamed);
    expect(t.meta(retried.taskId)).toMatchObject({ payer: { kind: "project", project: "payments" } });
  });
});

describe("the model key carries the payer and the tags", () => {
  it("is minted in the member's name with every tag for a member payer", async () => {
    const t = await setup();
    const reply = await t.call(DEV_MAYA, "POST", "/v1/app/agents/rovara-code/runs", { project: "payments", input: { text: "Fix it" } });
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { input, operationId } = await t.mintFor(taskId);
    expect(input).toMatchObject({ orgId: TEST_ORG, developerId: DEV_MAYA.developerId, purpose: "task", refId: taskId });
    expect(input.tags).toEqual({ taskId, operationId, agentId: "rovara-code", project: "payments", payerKind: "member", payerId: DEV_MAYA.developerId, source: "rovara", origin: "app" });
  });

  it("carries no user_id for a project payer, and the org's remainder alone caps it", async () => {
    const t = await setup();
    t.projectPays(true);
    t.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 29);
    t.access.setOrgSpent(TEST_ORG, 495);
    const reply = await t.call(DEV_MAYA, "POST", "/v1/app/agents/rovara-code/runs", { project: "payments", input: { text: "Fix it" } });
    const { input } = await t.mintFor((reply.body.task as { taskId: string }).taskId);
    expect(input).not.toHaveProperty("developerId");
    expect(input.maxBudgetUsd).toBe(5);
    expect(input.tags).toMatchObject({ payerKind: "project", payerId: "payments", project: "payments" });
    expect(t.access.upsertMember).not.toHaveBeenCalledWith(TEST_ORG, DEV_MAYA.developerId, expect.anything());
  });

  it("keeps a task from before agents, on an install with agents, in its owner's name with tags", async () => {
    const t = await setup();
    const reply = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (reply.body.task as { taskId: string }).taskId;
    // The task as it was before payers were recorded.
    const item = t.db.get(`DEVTASK#${taskId}`, "META")!;
    const { payer: _payer, place: _place, origin: _origin, agent: _agent, ...old } = item as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed to look old
    t.db.set(old);
    const { input } = await t.mintFor(taskId);
    expect(input).toMatchObject({ developerId: DEV_MAYA.developerId });
    expect(input.tags).toMatchObject({ payerKind: "member", payerId: DEV_MAYA.developerId, project: "payments", agentId: "rovara-code", origin: "cli" });
  });

  it("sends the key exactly as before, with no tags, on an install without agents", async () => {
    const t = await setup({ agents: false });
    const reply = await t.call(DEV_MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix it", client: "claude-code" });
    const { input } = await t.mintFor((reply.body.task as { taskId: string }).taskId);
    expect(input).not.toHaveProperty("tags");
    expect(input).toMatchObject({ developerId: DEV_MAYA.developerId });
  });
});

describe("Slack-thread work", () => {
  const SLACK_USER = "U0123456789";
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const linked = developerIdForSlackUser(SLACK_USER);

  function install(options: { agents?: boolean } = {}) {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { ...(options.agents === false ? {} : { agents: {} }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    return { handler, db: db, access, ready: async () => { await registerSlackProject(handler); access.setOrgSpent(TEST_ORG, 0); } };
  }
  async function slackOperation(h: ReturnType<typeof install>) {
    await h.ready();
    const workspace = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    expect(workspace.status).toBe(200);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(h.db, workspaceId);
    const conversation = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(task.status).toBe(202);
    const operationId = (task.body.operation as { id: string }).id;
    const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    return { operationId, ask };
  }

  it("counts an unlinked requester's operation as the bound project's expense: a project payer, no user_id", async () => {
    const h = install();
    const { operationId, ask } = await slackOperation(h);
    expect((await ask()).status).toBe(200);
    const input = h.access.mintKey.mock.calls[0]![0];
    expect(input).not.toHaveProperty("developerId");
    expect(input.tags).toEqual({ operationId, agentId: "rovara-code", project: "payments", payerKind: "project", payerId: "payments", source: "rovara", origin: "slack" });
  });

  it("charges a linked requester's operation to the member, unless the project pays", async () => {
    const h = install();
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.access.setMemberSpent(TEST_ORG, linked, 0);
    const { operationId, ask } = await slackOperation(h);
    expect((await ask()).status).toBe(200);
    const input = h.access.mintKey.mock.calls[0]![0];
    expect(input).toMatchObject({ developerId: linked });
    expect(input.tags).toMatchObject({ operationId, payerKind: "member", payerId: linked, project: "payments", origin: "slack" });
    h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: true, revision: 1 });
    expect((await ask()).status).toBe(200);
    const next = h.access.mintKey.mock.calls[1]![0];
    expect(next).not.toHaveProperty("developerId");
    expect(next.tags).toMatchObject({ payerKind: "project", payerId: "payments" });
  });

  it("tags an orchestrator turn the same way, with the channel's bound project as the place", async () => {
    const h = install();
    await h.ready();
    const mint = (turnId: string) => serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId });
    expect((await mint("Ev1")).status).toBe(200);
    const unlinked = h.access.mintKey.mock.calls[0]![0];
    expect(unlinked).not.toHaveProperty("developerId");
    expect(unlinked.tags).toEqual({ agentId: "rovara-code", project: "payments", payerKind: "project", payerId: "payments", source: "rovara", origin: "slack" });
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    expect((await mint("Ev2")).status).toBe(200);
    const member = h.access.mintKey.mock.calls[1]![0];
    expect(member).toMatchObject({ developerId: linked, purpose: "turn" });
    expect(member.tags).toMatchObject({ payerKind: "member", payerId: linked });
  });

  it("admits a linked member's thread against the member's limit, and against the org alone when the project pays", async () => {
    const h = install();
    await h.ready();
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.access.setMemberSpent(TEST_ORG, linked, 29);
    expect(await ensureWorkspace(h.handler, THREAD, SLACK_USER)).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: true, revision: 1 });
    expect((await ensureWorkspace(h.handler, THREAD, SLACK_USER)).status).toBe(200);
  });

  it("makes a linked member's orchestrator turn the project's when the project pays", async () => {
    const h = install();
    await h.ready();
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: true, revision: 1 });
    expect((await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev9" })).status).toBe(200);
    const input = h.access.mintKey.mock.calls[0]![0];
    expect(input).not.toHaveProperty("developerId");
    expect(input.tags).toMatchObject({ payerKind: "project", payerId: "payments", project: "payments" });
  });

  it("sends the same keys as before, with no tags, on an install without agents", async () => {
    const h = install({ agents: false });
    const { ask } = await slackOperation(h);
    expect((await ask()).status).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0]).not.toHaveProperty("tags");
  });
});
