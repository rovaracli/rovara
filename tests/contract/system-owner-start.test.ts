// The system owner of automatic runs (owner decision 2026-11-02): the start, through the real broker. A project's automatic run is OWNED by a non-person ("Rovara (project: X)"): its task record, its slot, its
// task-list row and its payer are the project's, no person's; and nothing can act AS it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun, type AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { AUTOMATIC_RUNS_AT_ONCE, isSystemOwnerId, systemOwnerIdOf, systemOwnerName } from "@rovara-code/contracts";
import { systemOwnerCaller } from "../../packages/broker/src/developer/system-owner.js";
import { projectMetaKey } from "@rovara-code/contracts";
import { taskIndexKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { call } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const PROJECT = "payments";
const SYSTEM = systemOwnerIdOf(TEST_ORG, PROJECT);
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

async function setup() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const starter = () => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no agent run starter");
    return found;
  };
  const automatic = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    requestId: randomUUID(), orgId: TEST_ORG, project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Nightly test run." }, origin: "automatic",
    owner: { developerId: SYSTEM }, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild", approvedBy: MAYA.developerId }, payer: { kind: "project", project: PROJECT }, ...extra,
  });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a stored row is asserted field by field
  return { ...h, starter, automatic, meta };
}

describe("a system-owned start", () => {
  it("is owned by the project's system owner, not a person: the record, the slot, the pointer and the payer", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), t.automatic());
    const task = t.meta(started.taskId);
    expect(task).toMatchObject({ developerId: SYSTEM, provider: "system", developerName: systemOwnerName(PROJECT), automatic: { job: "image_rebuild", purpose: "saved_env_rebuild", approvedBy: MAYA.developerId }, origin: "automatic", payer: { kind: "project", project: PROJECT } });
    expect(task.startedBy).toBeUndefined();
    expect(task.slackUserId).toBeUndefined();
    expect(task.sessionId).toBeUndefined();
    expect(isSystemOwnerId(task.developerId)).toBe(true);
    const pointer = t.db.find((item) => item.pk === `WORKSPACE#${task.workspaceId as string}` && item.entityType === "DEVELOPER_TASK_POINTER")[0] as Record<string, unknown>;
    expect(pointer.developerId).toBe(SYSTEM);
    expect(pointer.requester).toBeUndefined();
    // its slot is the system owner's own counter, never a person's
    const counters = t.db.find((item) => item.entityType === "DEVELOPER_LIMIT");
    expect(counters.map((item) => item.pk)).toContain(`DEVELOPER_LIMIT#${SYSTEM}`);
    expect(counters.map((item) => item.pk)).not.toContain(`DEVELOPER_LIMIT#${MAYA.developerId}`);
    // no spending-stop window and no model funding: an automatic run has no model key to spend
    expect(task.spendingStop).toBeUndefined();
    expect(task.fundingProof).toBeUndefined();
  });

  it("is in nobody's task list, and the approver's list stays empty", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), t.automatic());
    const created = t.meta(started.taskId).createdAt as string;
    expect(t.db.get(taskIndexKey(MAYA.developerId, created, started.taskId).pk, taskIndexKey(MAYA.developerId, created, started.taskId).sk)).toBeUndefined();
    const listed = await t.dev(MAYA, "GET", "/v1/dev/tasks");
    expect(JSON.stringify(listed.body)).not.toContain(started.taskId);
  });

  it("holds one slot per project: a second automatic run of the same project waits (WORKSPACE_LIMIT), another project's does not", async () => {
    const t = await setup();
    expect(AUTOMATIC_RUNS_AT_ONCE).toBe(1);
    await startAgentRun(t.starter(), t.automatic());
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const refused = await refusal(startAgentRun(t.starter(), t.automatic()));
    const lines = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
    expect(refused).toMatchObject({ code: "WORKSPACE_LIMIT" });
    // a refused automatic start is no AI tool's request: it keeps no turn record, and does not try to (a failed write of one raises the turn-record alarm)
    expect(lines.some((line) => line.includes("turn_record_failed"))).toBe(false);
    expect(t.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused")).toHaveLength(0);
  });

  it("the approver's own personal slots are untouched", async () => {
    const t = await setup();
    await startAgentRun(t.starter(), t.automatic());
    const counters = t.db.find((item) => item.entityType === "DEVELOPER_LIMIT" && item.pk === `DEVELOPER_LIMIT#${MAYA.developerId}`);
    expect(counters).toHaveLength(0);
  });
});

describe("a system owner owns exactly its own project's automatic runs, which no person started", () => {
  it.each([
    ["a system owner with no automatic mark", { automatic: undefined }],
    ["an automatic mark with a person as owner", { owner: { developerId: "d".repeat(64) } }],
    ["another project's system owner", { owner: { developerId: systemOwnerIdOf(TEST_ORG, "other-project") } }],
    ["another company's system owner", { owner: { developerId: systemOwnerIdOf("org_bbbbbbbbbbbbbbbbbbbb", PROJECT) } }],
    ["a person named as having started it", { startedBy: { developerId: "d".repeat(64) } }],
    ["a person's own caller", { caller: { developerId: "d".repeat(64), sessionId: "s", amr: "oidc" as const, name: "Maya", orgId: TEST_ORG, orgRole: "member" as const } }],
  ])("refuses %s", async (_label, extra) => {
    const t = await setup();
    const request = { ...t.automatic(), ...extra } as AgentRunRequest;
    if ("automatic" in extra) delete (request as { automatic?: unknown }).automatic;
    const refused = await refusal(startAgentRun(t.starter(), request));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("refuses a payer other than the project: no person is charged for work no person started", async () => {
    const t = await setup();
    const refused = await refusal(startAgentRun(t.starter(), t.automatic({ origin: "schedule", payer: { kind: "agent", agentId: "rovara-code" } })));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("the task start refuses a system owner's caller that is not marked automatic, and an automatic mark on a person's caller, in either order", async () => {
    const t = await setup();
    const starter = t.starter();
    const body = { requestId: randomUUID(), project: PROJECT, instructions: "Nightly test run." };
    const system = systemOwnerCaller(TEST_ORG, PROJECT);
    expect(await refusal(starter.startTask(system, body, { origin: "automatic", autonomous: true }))).toMatchObject({ code: "FORBIDDEN" });
    const person = { developerId: MAYA.developerId, sessionId: "s", amr: "oidc" as const, name: "Maya", orgId: TEST_ORG, orgRole: "member" as const };
    expect(await refusal(starter.startTask(person, body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" } }))).toMatchObject({ code: "FORBIDDEN" });
    // a system owner's caller for ANOTHER project than the one it starts in
    expect(await refusal(starter.startTask(systemOwnerCaller(TEST_ORG, "other-project"), body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" } }))).toMatchObject({ code: "FORBIDDEN" });
    // a person's id with the system owner's session id, and the reverse
    expect(await refusal(starter.startTask({ ...person, sessionId: "system-owner" }, body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" } }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(starter.startTask({ ...system, sessionId: "s-forged" }, body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" } }))).toMatchObject({ code: "FORBIDDEN" });
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("the run starter finds no person for a system owner's id, even if a sign-in record and a membership were planted under it (nothing signs in as it)", async () => {
    const t = await setup();
    seedMembership(t.db, SYSTEM, { orgId: TEST_ORG, role: "admin" });
    t.db.set({ pk: `DEVELOPER#${SYSTEM}`, sk: "META", entityType: "DEVELOPER", developerId: SYSTEM, provider: "oidc", displayName: "Planted", revoked: false });
    expect(await t.starter().callerFor(TEST_ORG, SYSTEM)).toBeUndefined();
  });

  it("an archived or missing project takes no automatic run", async () => {
    const t = await setup();
    t.db.set({ ...projectMetaKey(TEST_ORG, PROJECT), entityType: "PROJECT_META", orgId: TEST_ORG, name: PROJECT, status: "archived", archivedAt: "2026-11-01T00:00:00.000Z" });
    const refused = await refusal(startAgentRun(t.starter(), t.automatic()));
    expect(refused?.code).toBeDefined();
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });
});

describe("an automatic run is model-free", () => {
  const workflowFor = (t: Awaited<ReturnType<typeof setup>>, taskId: string) => t.meta(taskId);

  it("a rebuild queues no prompt: its preparation ends and no model operation follows, and the task is no workflow", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), t.automatic());
    const task = workflowFor(t, started.taskId);
    expect(task.workflow).toBeUndefined();
    const pointer = t.db.find((item) => item.pk === `WORKSPACE#${task.workspaceId as string}` && item.entityType === "DEVELOPER_TASK_POINTER")[0] as Record<string, unknown>;
    expect(pointer.pendingPrompt).toBeUndefined();
    expect(pointer.pendingWorkflowMode).toBeUndefined();
    const prepare = String((t.db.get(`WORKSPACE#${task.workspaceId as string}`, "META") as { activeOperationId: string }).activeOperationId);
    await t.finish(task.workspaceId as string, prepare, "SUCCEEDED");
    expect(t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task")).toHaveLength(0);
  });

  it("refuses to make a workflow of it, and an agent that runs steps with a model", async () => {
    const t = await setup();
    const starter = t.starter();
    const body = { requestId: randomUUID(), project: PROJECT, instructions: "Rebuild.", agent: { agentId: "rovara-code" }, workflow: true, workflowPath: "QUICK" };
    const system = systemOwnerCaller(TEST_ORG, PROJECT);
    expect(await refusal(starter.startTask(system, body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" } }))).toMatchObject({ code: "CONFIG_INVALID" });
    const agentSteps = await refusal(startAgentRun(starter, t.automatic({ agent: { agentId: "ticket-triage" } })));
    expect(agentSteps?.code).toBeDefined();
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("every system start declares a purpose that matches what it runs: the nightly purpose goes with the night's facts, and only with them", async () => {
    const t = await setup();
    const starter = t.starter();
    const body = { requestId: randomUUID(), project: PROJECT, instructions: "Run.", agent: { agentId: "rovara-code" } };
    const system = systemOwnerCaller(TEST_ORG, PROJECT);
    expect(await refusal(starter.startTask(system, body, { origin: "nightly", autonomous: true, automatic: { job: "nightly", purpose: "nightly_run" } }))).toMatchObject({ code: "CONFIG_INVALID" });
    const nightly = { slotId: "a".repeat(64), envRevision: 1, branch: "main", headSha: "b".repeat(40) };
    expect(await refusal(starter.startTask(system, body, { origin: "automatic", autonomous: true, automatic: { job: "image_rebuild", purpose: "saved_env_rebuild" }, nightlyRun: nightly }))).toMatchObject({ code: "CONFIG_INVALID" });
    for (const extra of [{ automatic: { job: "nightly" as const, purpose: "nightly_run" as const } }, { automatic: { job: "image_rebuild" as const, purpose: "saved_env_rebuild" as const }, nightlyRun: nightly }]) {
      expect((await refusal(startAgentRun(starter, t.automatic(extra))))?.code, JSON.stringify(extra)).toBe("CONFIG_INVALID");
    }
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("the automatic origins and the automatic mark go together, both ways", async () => {
    const t = await setup();
    const person = { owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member" as const, developerId: MAYA.developerId } };
    const { automatic: _automatic, ...unmarked } = t.automatic(); // eslint-disable-line @typescript-eslint/no-unused-vars -- the mark is what is left out
    // (the one that isolates the rule: a person's run that says it is the project's own work, with the project as payer, would otherwise simply start)
    const personsNightly = { ...unmarked, ...person, origin: "nightly" as const, payer: { kind: "project" as const, project: PROJECT }, startedBy: undefined };
    for (const request of [{ ...unmarked }, personsNightly, { ...t.automatic(), ...person, origin: "automatic" as const, automatic: undefined }, { ...t.automatic(), origin: "app" as const }]) {
      expect((await refusal(startAgentRun(t.starter(), request as AgentRunRequest)))?.code).toBe("CONFIG_INVALID");
    }
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });
});

describe("a system owner is given no model key, ever", () => {
  it("an operation of a system-owned task that asks the model proxy for a key is refused, and nothing is minted (a regression that queued a prompt must not mint one either)", async () => {
    const access = fakeModelAccess();
    const t = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    const starter = createAgentRunStarter(t.brokerInput as never)!;
    const started = await startAgentRun(starter, { requestId: randomUUID(), orgId: TEST_ORG, project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Check." }, origin: "automatic",
      owner: { developerId: SYSTEM }, automatic: { job: "scheduled_check", purpose: "saved_env_rebuild" }, payer: { kind: "project", project: PROJECT } });
    const task = t.db.get(`DEVTASK#${started.taskId}`, "META") as { workspaceId: string };
    // Make the regression: a prompt queued for the task (as an ordinary coding start queues one), so its first operation is one that asks a model.
    const pointerKey = { pk: `WORKSPACE#${task.workspaceId}`, sk: "DEVELOPER_TASK" };
    t.db.set({ ...(t.db.get(pointerKey.pk, pointerKey.sk) as Record<string, unknown>), pendingPrompt: "Check." });
    const prepare = String((t.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await t.finish(task.workspaceId, prepare, "SUCCEEDED");
    const active = String((t.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    const capability = ((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === active)[0]!).invocation as { callbackCapability: string }).callbackCapability;
    const asked = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(asked.status, JSON.stringify(asked.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(asked.body)).toContain("automatic runs");
    expect(access.mintKey).not.toHaveBeenCalled();
  });
});
