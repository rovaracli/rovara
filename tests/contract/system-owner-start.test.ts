// The system owner of automatic runs (owner decision 2026-11-02): the start, through the real broker. A project's automatic run is OWNED by a non-person ("Rovara (project: X)"): its task record, its slot, its
// task-list row and its payer are the project's, no person's; and nothing can act AS it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun, type AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { AUTOMATIC_RUNS_AT_ONCE, isSystemOwnerId, systemOwnerIdOf, systemOwnerName } from "@agentx/contracts";
import { systemOwnerCaller } from "../../packages/broker/src/developer/system-owner.js";
import { projectMetaKey } from "@agentx/contracts";
import { taskIndexKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
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
    requestId: randomUUID(), orgId: TEST_ORG, project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Nightly test run." }, origin: "nightly",
    owner: { developerId: SYSTEM }, automatic: { job: "nightly", approvedBy: MAYA.developerId }, payer: { kind: "project", project: PROJECT }, ...extra,
  });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a stored row is asserted field by field
  return { ...h, starter, automatic, meta };
}

describe("a system-owned start", () => {
  it("is owned by the project's system owner, not a person: the record, the slot, the pointer and the payer", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), t.automatic());
    const task = t.meta(started.taskId);
    expect(task).toMatchObject({ developerId: SYSTEM, provider: "system", developerName: systemOwnerName(PROJECT), automatic: { job: "nightly", approvedBy: MAYA.developerId }, origin: "nightly", payer: { kind: "project", project: PROJECT } });
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
    expect(await refusal(startAgentRun(t.starter(), t.automatic()))).toMatchObject({ code: "WORKSPACE_LIMIT" });
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
    if (extra.automatic === undefined && "automatic" in extra) delete (request as { automatic?: unknown }).automatic;
    const refused = await refusal(startAgentRun(t.starter(), request));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("refuses a payer other than the project: no person is charged for work no person started", async () => {
    const t = await setup();
    const refused = await refusal(startAgentRun(t.starter(), t.automatic({ origin: "app", payer: { kind: "member", developerId: MAYA.developerId } })));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("the task start refuses a system owner's caller that is not marked automatic, and an automatic mark on a person's caller, in either order", async () => {
    const t = await setup();
    const starter = t.starter();
    const body = { requestId: randomUUID(), project: PROJECT, instructions: "Nightly test run." };
    const system = systemOwnerCaller(TEST_ORG, PROJECT);
    expect(await refusal(starter.startTask(system, body, { origin: "nightly", autonomous: true }))).toMatchObject({ code: "FORBIDDEN" });
    const person = { developerId: MAYA.developerId, sessionId: "s", amr: "oidc" as const, name: "Maya", orgId: TEST_ORG, orgRole: "member" as const };
    expect(await refusal(starter.startTask(person, body, { origin: "nightly", autonomous: true, automatic: { job: "nightly" } }))).toMatchObject({ code: "FORBIDDEN" });
    // a system owner's caller for ANOTHER project than the one it starts in
    expect(await refusal(starter.startTask(systemOwnerCaller(TEST_ORG, "other-project"), body, { origin: "nightly", autonomous: true, automatic: { job: "nightly" } }))).toMatchObject({ code: "FORBIDDEN" });
    // a person's id with the system owner's session id, and the reverse
    expect(await refusal(starter.startTask({ ...person, sessionId: "system-owner" }, body, { origin: "nightly", autonomous: true, automatic: { job: "nightly" } }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(starter.startTask({ ...system, sessionId: "s-forged" }, body, { origin: "nightly", autonomous: true, automatic: { job: "nightly" } }))).toMatchObject({ code: "FORBIDDEN" });
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  });

  it("the run starter finds no person for a system owner's id (nothing signs in as it)", async () => {
    const t = await setup();
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

describe("a system owner is given no model key, ever", () => {
  it("an operation of a system-owned task that asks the model proxy for a key is refused, and nothing is minted (whatever the job)", async () => {
    const access = fakeModelAccess();
    const t = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    const starter = createAgentRunStarter(t.brokerInput as never)!;
    // A job with no nightly payload is an ordinary coding operation, which does ask for a model key: the system owner must not get one.
    const started = await startAgentRun(starter, { requestId: randomUUID(), orgId: TEST_ORG, project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Check." }, origin: "nightly",
      owner: { developerId: SYSTEM }, automatic: { job: "scheduled_check" }, payer: { kind: "project", project: PROJECT } });
    const task = t.db.get(`DEVTASK#${started.taskId}`, "META") as { workspaceId: string };
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
