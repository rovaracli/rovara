import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 22: the agent-step engine. A run of an agent made of agent steps is a task that holds ONE workspace; after the preparation finishes the
// engine dispatches its steps one at a time (each an ordinary task operation whose payload is `agentStep.kind === "agent"`), hands each step the
// run's request and the earlier reports, waits in place for approvals (an `approval` step, and the write approvals a step's calls made), and ends
// the run in one terminal place (`onTaskEnded`) that releases the workspace, blocks the keys and tells every registered handler once.
// These tests go through the real broker (the app routes, the worker callbacks, the approvals core); only the worker and the vendor are faked.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { unregisterAgentSessionTaskHandlers } from "../../packages/broker/src/agent-sessions/index.js";
import { uninstallTicketUpdates } from "../../packages/broker/src/aws/broker/ticket-updates-wiring.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { currentBuiltinVersion } from "@rovara-code/contracts";
import {
  advanceAgentRun, cancelAgentRun, driveAgentRun, giveUpAgentRun, onAgentStepFinished, onApprovalGaveUp, onTaskEnded, onWriteDecided, prepareSlackReport, registerTaskEndHandler,
  registerTaskPauseHandler, type TaskEndEvent, type TaskPauseEvent,
} from "../../packages/broker/src/agents/run-engine.js";
import {
  approvalTaskEventKey, createStepApproval, createWriteApprovalRecord, decideApproval, expireApprovals, getAnyApproval, registerWriteApprovalDriver,
  type ApprovalDependencies, type StepApprovalRecord, type WriteApprovalRecord,
} from "../../packages/broker/src/agents/approvals.js";
import { writeApproversFor } from "../../packages/broker/src/agents/write-gate.js";
import { readGuardrailsWithRevision } from "../../packages/broker/src/agents/guardrails.js";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@rovara-code/contracts";
import { DeveloperTaskRunViewSchema } from "@rovara-code/contracts";
import { AgentRunStateSchema, SHORTENED_MARKER, UNVERIFIED_END_PREFIX, renderRunInput, type RunInput } from "@rovara-code/contracts";
import { agentXError, orgScoped } from "@rovara-code/contracts";
import { recipeDigest, type RecipeOverlay } from "@rovara-code/contracts";
import { AGENT_WORKER_OUTDATED, AgentStepPayloadSchema } from "@rovara-code/contracts";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { approvalKey, approverIndexKey, projectAgentKey, slackBindingKey } from "@rovara-code/contracts";
import { orgMemberKey, orgRemovedKey } from "../../packages/cloud-contracts/src/org-node.js";
import type { AgentId } from "@rovara-code/contracts";
import { DEV_ISSUER, MAYA, OMAR, bindChannel, createDeveloperTaskBroker, grantProject, recordStream, unbindChannel, type Developer } from "../support/developer-task-broker.js";
import { agentRunDispatchItem, operationEndDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { noticesOf, type Notice } from "../../packages/broker/src/developer/notifications.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const TASK_LINK = "https://identity.example.test/review/TASKID/task";

let createAgentRouteDependencies: typeof BrokerModule.createAgentRouteDependencies;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRouteDependencies } = await import("../../packages/broker/src/aws/broker.js"));
});

// The write approvals of these tests are carried out by a stand-in for the connector path (Task 19 and 21 test the real one): it says what each approval was told.
const driver = { execute: vi.fn<(deps: ApprovalDependencies, record: WriteApprovalRecord) => Promise<{ outcome: "done" } | { outcome: "failed"; failure: string }>>(async () => ({ outcome: "done" })) };
registerWriteApprovalDriver({ execute: (deps, record) => driver.execute(deps, record) });
const unregister: Array<() => void> = [];
afterEach(() => {
  while (unregister.length > 0) unregister.pop()!();
  driver.execute.mockReset();
  driver.execute.mockImplementation(async () => ({ outcome: "done" }));
});

const agentStep = (id: string, name: string = id, workspace: "none" | "read" = "none", extra: Record<string, unknown> = {}) => ({ id, name, kind: "agent" as const, workspace, ...extra });
const WITH_GATE: RecipeOverlay = {
  instructions: "Draft, ask, send.",
  sequence: [agentStep("draft", "Draft"), { id: "gate", name: "Ship it", kind: "approval" as const, prompt: "Send the report to customers?" }, agentStep("send", "Send")],
};
const INPUT: RunInput = { text: "Why did checkout fail at 14:02?", context: [{ kind: "ticket", ref: "LIN-12", title: "Checkout fails" }] };

type Reply = { status: number; body: Record<string, unknown> };
/** The fields of a task view these tests read. */
interface TaskViewShape {
  status: string;
  events: Array<{ at: string; kind: string; text: string }>;
  agent?: { agentId: string };
  run: { state: string; currentStep?: { id: string; name: string }; steps: Array<Record<string, unknown>>; pendingApprovals: Array<Record<string, unknown>>; finalReport?: string; endReason?: string };
}
type Op = Record<string, unknown> & { id: string; kind: string; status: string; programStepId?: string; createdAt: string; fence: number };

async function setup(options: { proxy?: boolean; brokerExtra?: Record<string, unknown>; readyChecks?: boolean } = {}) {
  const access = options.proxy === true ? fakeModelAccess() : undefined;
  const h = await createDeveloperTaskBroker({
    ...(options.readyChecks === true ? { register: false } : {}),
    brokerExtra: { agents: {}, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }), ...options.brokerExtra },
  });
  // Plan 5 Task 7b: a broker with agents registers the sessions' end and pause handlers. These tests are Plan 3's contract for the handlers it is given (who is told, in what
  // order, how many), and some of them are about nobody listening, so they run without that pair (agent-session-task-end-broker.test.ts covers it with the real broker).
  unregisterAgentSessionTaskHandlers();
  // Slice 5: a broker with developer sign-in also registers the ticket updates end handler (it notes "closed" on a ticket that started a task). It is one more listener for every end, so
  // these tests take it off as they take off the sessions' pair (ticket-updates.test.ts covers it with the real broker).
  uninstallTicketUpdates();
  if (options.readyChecks === true) await registerSlackProject(h.handler, { readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }] });
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
  const agentOf = async (overlay: RecipeOverlay): Promise<AgentId> => {
    const created = await call(MAYA, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
    h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return agentId;
  };
  const operations = (workspaceId: string): Op[] => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Op[];
  /** The task operations of a workspace (the agent steps and their continuations), oldest first. */
  const stepOps = (workspaceId: string): Op[] => operations(workspaceId).filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence);
  const invocationOf = (operationId: string) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string; payload: Record<string, unknown> & { agentStep?: Record<string, unknown> & { inputs: string } } };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; outcome?: string; releasedAt?: string; budgetUsd?: number; developerId: string };
  const runItem = (taskId: string) => {
    const item = h.db.get(`DEVTASK#${taskId}`, "AGENT_RUN");
    if (item === undefined) return undefined;
    const { pk: _pk, sk: _sk, entityType: _type, ...state } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- only the key attributes are dropped
    return AgentRunStateSchema.parse(state);
  };
  const taskEvents = (taskId: string) => h.db.find((item) => item.pk === `DEVTASK#${taskId}` && typeof item.sk === "string" && item.sk.startsWith("EVENT#"));
  const view = async (who: Developer, taskId: string) => (await call(who, "GET", `/v1/dev/tasks/${taskId}`)).body.task as TaskViewShape;
  const routeDeps = (clock?: { now: number }): ApprovalDependencies => {
    const deps = createAgentRouteDependencies(h.brokerInput as never);
    if (deps === undefined) throw new Error("the broker has no agent route dependencies");
    return clock === undefined ? deps : { ...deps, now: () => clock.now };
  };
  /** Starts a run of `agent` on payments as `who`; the preparation has not finished. */
  const start = async (agent: string, input: RunInput = INPUT, who: Developer = MAYA) => {
    const reply = await call(who, "POST", `/v1/app/agents/${agent}/runs`, { project: "payments", input });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    return handleOf((reply.body.task as { taskId: string }).taskId);
  };
  /** A started run: its ids and the way to finish its preparation. */
  const handleOf = (taskId: string) => {
    const { workspaceId } = meta(taskId);
    const prepareId = String(operations(workspaceId).find((operation) => operation.kind === "prepare")!.id);
    return { taskId, workspaceId, prepareId, finishPrepare: () => h.finish(workspaceId, prepareId, "SUCCEEDED", PREPARED) };
  };
  const finishStep = (run: { workspaceId: string }, operationId: string, report: string, extra: Record<string, unknown> = {}) =>
    h.finish(run.workspaceId, operationId, "SUCCEEDED", { result: { agentStepResult: { report, outcome: "SUCCEEDED", ...extra } } });
  const caller = (developerId: string) => ({ orgId: TEST_ORG, developerId, orgRole: "member" as const });
  return { ...h, access, store, call, agentOf, operations, stepOps, invocationOf, meta, runItem, taskEvents, view, routeDeps, start, handleOf, finishStep, caller };
}
type World = Awaited<ReturnType<typeof setup>>;

/** A write approval the step's call made, PENDING, holding what a person would be shown. */
async function askWrite(t: World, deps: ApprovalDependencies, input: { taskId: string; stepId: string; operationId: string; summary: string; expiresAt?: string; approvers?: WriteApprovalRecord["approvers"] }) {
  const approvalId = `apr_${randomUUID().replace(/-/g, "").slice(0, 20).replace(/[^0-9a-z]/g, "a")}`;
  const createdAt = new Date().toISOString();
  const record: WriteApprovalRecord = {
    orgId: TEST_ORG, approvalId: approvalId, kind: "write", subject: { kind: "agent_run", taskId: input.taskId, stepId: input.stepId }, operationId: input.operationId,
    connector: "linear", connectorType: "linear", tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64),
    arguments: { title: input.summary }, argumentsHash: "c".repeat(64), summary: input.summary, class: "consequential",
    approvers: input.approvers ?? { kind: "ids", ids: [MAYA.developerId] }, status: "PENDING", project: "payments", owner: { developerId: MAYA.developerId, name: MAYA.name },
    attempts: 0, createdAt, expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
  const event = { Put: { TableName: "state", Item: { ...approvalTaskEventKey(input.taskId, createdAt, approvalId), entityType: "TASK_EVENT", orgId: TEST_ORG, kind: "status", text: `Agent wants to ${input.summary}.`, at: createdAt } } };
  expect(await createWriteApprovalRecord(deps, record, [event], 8)).toBe("created");
  void t;
  return record;
}

const approve = (deps: ApprovalDependencies, approvalId: string, decision: "APPROVE" | "DECLINE" = "APPROVE") =>
  decideApproval(deps, { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "member" }, approvalId, { requestId: randomUUID(), decision });

const endHandler = () => {
  const events: TaskEndEvent[] = [];
  unregister.push(registerTaskEndHandler(async (_deps, event) => { events.push(event); }));
  return events;
};
const pauseHandler = () => {
  const events: TaskPauseEvent[] = [];
  unregister.push(registerTaskPauseHandler(async (_deps, event) => { events.push(event); }));
  return events;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The Slack report (R4-2)
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("prepareSlackReport", () => {
  const options = (extra: Partial<Parameters<typeof prepareSlackReport>[1]> = {}) => ({ orgId: TEST_ORG, taskUrl: TASK_LINK, reportLinkDomains: [], extraCommandWords: [], ...extra });
  const LINK_ONLY = `Report available in Rovara: ${TASK_LINK}`;

  it("posts a plain report as text, unchanged", () => {
    expect(prepareSlackReport("The retry was removed in the 14:02 deploy. Two services call checkout.", options())).toEqual({ kind: "text", text: "The retry was removed in the 14:02 deploy. Two services call checkout." });
  });

  it("strips Slack's broadcast, user, group and channel mentions and the plain @channel, @here and @everyone", () => {
    const result = prepareSlackReport("<!channel> <!here> <!everyone> ping <@U123> and <@W456> in <#C789|general> and <!subteam^S12|@oncall>. Also @channel, @here and @everyone.", options());
    expect(result.kind).toBe("text");
    const text = result.text;
    for (const forbidden of ["<!channel>", "<!here>", "<!everyone>", "<@U123>", "<@W456>", "<#C789", "<!subteam", "@channel", "@here", "@everyone", "@oncall"]) expect(text).not.toContain(forbidden);
    expect(text).toContain("ping");
  });

  it("strips an @name the way Task 14 does, so the report mentions nobody", () => {
    const result = prepareSlackReport("Thanks @alice and @acme/platform for the pointers.", options());
    expect(result).toEqual({ kind: "text", text: "Thanks alice and acme/platform for the pointers." });
  });

  it("turns a labelled link to another site into plain text `label (host)`", () => {
    expect(prepareSlackReport("see <https://evil.example/x|the fix>", options())).toEqual({ kind: "text", text: "see the fix (evil[.]example)" });
  });

  it("turns an unlabelled link and a bare URL into plain text with the host", () => {
    const result = prepareSlackReport("a <https://evil.example/a> and https://other.example/b?c=1 here", options());
    expect(result.kind).toBe("text");
    expect(result.text).not.toMatch(/https?:\/\//);
    expect(result.text).toContain("(evil[.]example)");
    expect(result.text).toContain("(other[.]example)");
  });

  it("keeps the task link and a link whose host is one of the org's report link domains (or a subdomain of one)", () => {
    const own = `see <${TASK_LINK}|the task> and <https://docs.acme.example/runbook|the runbook> and <https://www.acme.example/x|more>`;
    const result = prepareSlackReport(own, options({ reportLinkDomains: ["acme.example", "docs.acme.example"] }));
    expect(result).toEqual({ kind: "text", text: own });
    expect(prepareSlackReport("see <https://notacme.example/x|a>", options({ reportLinkDomains: ["acme.example"] }))).toEqual({ kind: "text", text: "see a (notacme[.]example)" });
  });

  it.each([
    ["deploy api to production"], ["rollback"], ["please roll back the release"], ["restart the worker"], ["redeploy the api"], ["ship the build to staging"],
    ["promote this to production"], ["scale the service to 20 replicas"], ["!deploy"], [".deploy api"], ["  !restart now"], ["/merge"],
  ])("posts only the link when the report holds a command: %s", (line) => {
    expect(prepareSlackReport(`The cause is the retry.\n${line}\nThat is all.`, options())).toEqual({ kind: "link_only", text: LINK_ONLY });
  });

  it("finds a command written with look-alike characters", () => {
    expect(prepareSlackReport("ｒｏｌｌｂａｃｋ", options())).toEqual({ kind: "link_only", text: LINK_ONLY });
  });

  it("posts only the link when the org's own command word is in the report, and not otherwise", () => {
    expect(prepareSlackReport("the deploy script failed", options())).toEqual({ kind: "text", text: "the deploy script failed" });
    expect(prepareSlackReport("the deploy script failed", options({ extraCommandWords: ["deploy"] }))).toEqual({ kind: "link_only", text: LINK_ONLY });
  });

  it("checks the report after the mentions and links are gone, and never posts the original", () => {
    const result = prepareSlackReport("<!channel> look at <https://evil.example/x|this>", options());
    expect(result.text).not.toContain("channel");
    expect(result.text).not.toContain("https://");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The run, step by step
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("running the steps in order", () => {
  it("dispatches the steps of a two-step root-cause-analyst run in order and hands the first report to the second under the exact header", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    expect(t.stepOps(run.workspaceId)).toEqual([]);
    await run.finishPrepare();
    const [first] = t.stepOps(run.workspaceId);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(first).toMatchObject({ kind: "task", programStepId: "investigate", status: "ACCEPTED" });
    const firstPayload = t.invocationOf(first!.id).payload;
    expect(AgentStepPayloadSchema.parse(firstPayload.agentStep)).toMatchObject({ kind: "agent", agentId: "root-cause-analyst", version: currentBuiltinVersion("root-cause-analyst"), stepId: "investigate", workspace: "read" });
    expect(firstPayload.agentStep!.inputs).toBe(renderRunInput(INPUT));
    expect(firstPayload.agentStep).not.toHaveProperty("resultContract");
    expect(typeof firstPayload.prompt).toBe("string");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", cursor: 0, steps: [{ id: "investigate", status: "running", operationIds: [first!.id] }, { id: "report", status: "pending" }] });

    await t.finishStep(run, first!.id, "The 14:02 deploy removed the retry around the payment call.");
    const ops = t.stepOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    const second = ops[1]!;
    expect(second).toMatchObject({ programStepId: "report" });
    const secondPayload = t.invocationOf(second.id).payload.agentStep!;
    expect(secondPayload).toMatchObject({ kind: "agent", stepId: "report", workspace: "none" });
    expect(secondPayload.inputs).toBe(`${renderRunInput(INPUT)}\n\nReport from Investigate:\nThe 14:02 deploy removed the retry around the payment call.`);
    expect(t.runItem(run.taskId)).toMatchObject({ cursor: 1, steps: [{ id: "investigate", status: "done" }, { id: "report", status: "running", operationIds: [second.id] }], reports: [{ stepId: "investigate", name: "Investigate", text: "The 14:02 deploy removed the retry around the payment call." }] });
  });

  it("ends the run COMPLETE with the last report as its final report, releases the workspace and shows the run in the task view", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "The retry was removed.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE", finalReport: "The retry was removed.", steps: [{ status: "done" }, { status: "done" }] });
    expect(t.meta(run.taskId)).toMatchObject({ agentRunEnd: { state: "COMPLETE" } });
    // One workspace for the whole run, given back when the run ended.
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
    expect(t.db.get(`WORKSPACE#${run.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    const view = await t.view(MAYA, run.taskId);
    expect(view).toMatchObject({ status: "SUCCEEDED", agent: { agentId: "root-cause-analyst" } });
    expect(view.run).toMatchObject({
      state: "COMPLETE", finalReport: "The retry was removed.", pendingApprovals: [],
      steps: [{ id: "investigate", name: "Investigate", status: "done", report: "Found it." }, { id: "report", name: "Report", status: "done", report: "The retry was removed." }],
    });
    // Each report is kept with the task as agent-step-<id>.md.
    const artifacts = t.db.find((item) => item.entityType === "ARTIFACT" && item.workspaceId === run.workspaceId).map((item) => item.name);
    expect(artifacts).toEqual(expect.arrayContaining(["agent-step-investigate.md", "agent-step-report.md"]));
    expect(t.runItem(run.taskId)!.steps[0]!.reportKey).toBeDefined();
  });

  it("advances once when the worker's terminal callback is repeated", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    await t.finishStep(run, first.id, "One.");
    await t.finishStep(run, first.id, "One.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    // Calling the engine again with nothing to do changes nothing either.
    const deps = t.routeDeps();
    await onAgentStepFinished(deps, { taskId: run.taskId, operationId: first.id, outcome: "SUCCEEDED", report: "One." });
    await advanceAgentRun(deps, run.taskId);
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.runItem(run.taskId)!.reports).toHaveLength(1);
  });

  it("shortens a report over 32,768 bytes with the marker and keeps what the next step is sent inside the payload limit", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "é".repeat(40_000));
    const report = t.runItem(run.taskId)!.reports[0]!.text;
    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(32_768);
    expect(report.endsWith(SHORTENED_MARKER)).toBe(true);
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs;
    expect(Buffer.byteLength(inputs, "utf8")).toBeLessThanOrEqual(262_144);
  });

  it("puts the result contract on the last agent step only, and records the branch the worker chose when the contract names it", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const starter = await startWithContract(t, contract);
    await starter.finishPrepare();
    const first = t.stepOps(starter.workspaceId)[0]!;
    expect(t.invocationOf(first.id).payload.agentStep).not.toHaveProperty("resultContract");
    await t.finishStep(starter, first.id, "Looked.");
    const last = t.stepOps(starter.workspaceId)[1]!;
    expect(t.invocationOf(last.id).payload.agentStep).toMatchObject({ resultContract: contract });
    await t.finishStep(starter, last.id, "Needs a fix.", { branch: "fix", reason: "the retry is gone" });
    expect(t.runItem(starter.taskId)).toMatchObject({ state: "COMPLETE", branch: "fix" });
  });

  it("leaves the branch unset when the worker names one the contract does not have, or none", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const unknown = await startWithContract(t, contract);
    await unknown.finishPrepare();
    await t.finishStep(unknown, t.stepOps(unknown.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(unknown, t.stepOps(unknown.workspaceId)[1]!.id, "Done.", { branch: "deploy-everything" });
    expect(t.runItem(unknown.taskId)).toMatchObject({ state: "COMPLETE" });
    expect(t.runItem(unknown.taskId)!.branch).toBeUndefined();
    const none = await startWithContract(t, contract);
    await none.finishPrepare();
    await t.finishStep(none, t.stepOps(none.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(none, t.stepOps(none.workspaceId)[1]!.id, "Done.");
    expect(t.runItem(none.taskId)!.branch).toBeUndefined();
  });
});

/** A run of root-cause-analyst that was started with a result contract (Plan 4 passes it through `startAgentRun`). */
async function startWithContract(t: World, resultContract: { branches: Array<{ id: string; description: string }> }) {
  const { createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js");
  const starter = createAgentRunStarter(t.brokerInput as never)!;
  const started = await startAgentRun(starter, {
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "root-cause-analyst" }, input: INPUT, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, resultContract,
  });
  return t.handleOf(started.taskId);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Waiting for write approvals in place
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a run waits while its write approvals are pending", () => {
  /** A run of root-cause-analyst whose first step has made one write approval, with the first step still running. */
  async function running() {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    return { t, run, first, deps, write };
  }

  it("never reaches COMPLETE while an approval is PENDING: the step waits, nothing more is dispatched and the task view lists the approval", async () => {
    const { t, run, first, write } = await running();
    await t.finishStep(run, first.id, "Found it. One comment waits for a person.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL", cursor: 0, steps: [{ id: "investigate", status: "waiting", approvalIds: [write.approvalId] }, { id: "report", status: "pending" }] });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    const view = await t.view(MAYA, run.taskId);
    expect(view.status).toBe("RUNNING");
    expect(view.run).toMatchObject({ state: "WAITING_FOR_APPROVAL", currentStep: { id: "investigate", name: "Investigate" } });
    expect(view.run.pendingApprovals).toEqual([expect.objectContaining({ approvalId: write.approvalId, kind: "write", text: expect.stringContaining("comment on LIN-12") as string, confirmUrl: expect.stringContaining(`/v1/app/approve/${write.approvalId}`) as string })]);
    // The workspace is still the run's: nothing is released while it waits.
    expect(t.meta(run.taskId).releasedAt).toBeUndefined();
  });

  it("dispatches ONE continuation of the same step when the approval is approved, with the exact outcome line, and its report replaces the step's", async () => {
    const { t, run, first, deps, write } = await running();
    await t.finishStep(run, first.id, "Provisional report.");
    await approve(deps, write.approvalId);
    const ops = t.stepOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ programStepId: "investigate" });
    const payload = t.invocationOf(ops[1]!.id).payload.agentStep!;
    expect(AgentStepPayloadSchema.parse(payload)).toMatchObject({ kind: "agent", stepId: "investigate" });
    expect(payload.inputs).toContain("Outcomes of the actions that needed approval:\nApproved and done: comment on LIN-12");
    expect(payload.inputs).toContain(renderRunInput(INPUT));
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ id: "investigate", status: "running", operationIds: [first.id, ops[1]!.id] }, { id: "report", status: "pending" }] });
    // Hearing the same outcome again (the handler can be called up to 8 times) dispatches nothing more.
    await onWriteDecided(deps, (await getAnyApproval(deps, TEST_ORG, write.approvalId))!);
    await onWriteDecided(deps, (await getAnyApproval(deps, TEST_ORG, write.approvalId))!);
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);

    await t.finishStep(run, ops[1]!.id, "Final report after the comment was made.");
    expect(t.runItem(run.taskId)!.reports).toEqual([{ stepId: "investigate", name: "Investigate", text: "Final report after the comment was made." }]);
    const next = t.stepOps(run.workspaceId)[2]!;
    expect(next).toMatchObject({ programStepId: "report" });
    const nextInputs = t.invocationOf(next.id).payload.agentStep!.inputs;
    expect(nextInputs).toContain("Report from Investigate:\nFinal report after the comment was made.");
    expect(nextInputs).not.toContain("Provisional report.");
  });

  it("continues with 'Approved but not run: <summary> (<reason>)' for an approval that was approved and failed", async () => {
    const { t, run, first, deps, write } = await running();
    driver.execute.mockImplementation(async () => ({ outcome: "failed", failure: "The connector changed since this was asked, so Rovara didn't run it." }));
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId);
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs;
    expect(inputs).toContain("Approved but not run: comment on LIN-12 (The connector changed since this was asked, so Rovara didn't run it.)");
  });

  it("continues with 'Declined: <summary>' for a declined approval", async () => {
    const { t, run, first, deps, write } = await running();
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId, "DECLINE");
    expect(t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs).toContain("Declined: comment on LIN-12");
  });

  it("continues with 'Expired: <summary>' for an approval nobody answered in time", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12", expiresAt: new Date(Date.now() - 1000).toISOString() });
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    await expireApprovals(deps, Date.now() + 1000);
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId))!.status).toBe("EXPIRED");
    expect(t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs).toContain("Expired: comment on LIN-12");
  });

  it("waits for every approval of the step, then hands back one line each", async () => {
    const { t, run, first, deps, write } = await running();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "label LIN-12 as bug" });
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await approve(deps, second.approvalId, "DECLINE");
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs;
    expect(inputs).toContain("Outcomes of the actions that needed approval:\nApproved and done: comment on LIN-12\nDeclined: label LIN-12 as bug");
  });

  it("hands back an approval decided while the step still ran, when that step ends, with no wait", async () => {
    const { t, run, first, deps, write } = await running();
    await approve(deps, write.approvalId);
    // The step is still running: nothing is dispatched for the decision alone.
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    await t.finishStep(run, first.id, "Report before I heard the outcome.");
    const ops = t.stepOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ programStepId: "investigate" });
    expect(t.invocationOf(ops[1]!.id).payload.agentStep!.inputs).toContain("Approved and done: comment on LIN-12");
  });

  it("does not ask the model about an outcome twice: a step whose outcomes were handed back ends when its continuation ends", async () => {
    const { t, run, first, deps, write } = await running();
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId);
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Done.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(3);
    expect(t.stepOps(run.workspaceId)[2]).toMatchObject({ programStepId: "report" });
    expect(t.runItem(run.taskId)!.steps[0]).toMatchObject({ status: "done", told: [write.approvalId] });
  });

  it("expires the approvals still PENDING when the run is cancelled while it waits, and ends it CANCELLED", async () => {
    const { t, run, first, deps, write } = await running();
    await t.finishStep(run, first.id, "Waiting.");
    const events = endHandler();
    const cancelled = await t.call(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId))!.status).toBe("EXPIRED");
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled", taskId: run.taskId })]);
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
    expect((await t.view(MAYA, run.taskId)).status).toBe("CANCELLED");
    // The dust is gone: nothing is left in the person's list and a late decision finds it closed.
    expect(t.db.get(approverIndexKey(TEST_ORG, MAYA.developerId, write.approvalId).pk, approverIndexKey(TEST_ORG, MAYA.developerId, write.approvalId).sk)).toBeUndefined();
  });

  it("fails the run with a clear reason and tells the owner when the approval's handler is given up on (8 tries)", async () => {
    const clock = { now: Date.now() };
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const base = t.routeDeps(clock);
    const write = await askWrite(t, base, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    // The engine's host can't dispatch the continuation: every call of the handler fails, as an outage that outlasts the sweep's tries would.
    const failing = { ...base, agentRuns: { ...base.agentRuns!, startStep: async () => { throw new Error("the workspace is gone"); } } } as ApprovalDependencies;
    await approve(failing, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    for (let round = 0; round < 12; round += 1) {
      clock.now += 7 * 3_600_000;
      await expireApprovals(failing, clock.now);
    }
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toMatch(/approval/i);
    expect(t.taskEvents(run.taskId).map((event) => String(event.text))).toEqual(expect.arrayContaining([expect.stringMatching(/couldn't continue|could not continue/i) as string]));
    expect((await t.view(MAYA, run.taskId)).status).toBe("FAILED");
  });
});

describe("an approval step", () => {
  async function atGate() {
    const t = await setup();
    const agentId = await t.agentOf(WITH_GATE);
    const run = await t.start(agentId);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    const deps = t.routeDeps();
    const [approvalId] = t.runItem(run.taskId)!.steps[1]!.approvalIds;
    const record = (await getAnyApproval(deps, TEST_ORG, approvalId as never)) as StepApprovalRecord;
    return { t, run, deps, record };
  }

  it("asks the owner and the maintainers (the write_approver rule), waits in place, and dispatches nothing", async () => {
    const { t, run, deps, record } = await atGate();
    expect(record).toMatchObject({ kind: "step", status: "PENDING", prompt: "Send the report to customers?", subject: { kind: "agent_run", taskId: run.taskId, stepId: "gate" } });
    expect(record.approvers).toEqual({ kind: "rule", rule: "write_approver", candidates: await writeApproversFor(deps, { orgId: TEST_ORG, project: "payments", owner: { developerId: MAYA.developerId } }) });
    expect(record.approvers.kind === "rule" && record.approvers.candidates).toContain(MAYA.developerId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL", cursor: 1, steps: [{ status: "done" }, { id: "gate", status: "waiting", approvalIds: [record.approvalId] }, { status: "pending" }] });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect((await t.view(MAYA, run.taskId)).run.pendingApprovals).toEqual([expect.objectContaining({ kind: "step", text: "Send the report to customers?" })]);
  });

  it("asks the person who took the task over, not the creator, as the run's owner (Plan 5 Task 12a)", async () => {
    const t = await setup();
    const agentId = await t.agentOf(WITH_GATE);
    const run = await t.start(agentId);
    await run.finishPrepare();
    // Omar takes the task over before the draft step ends; as the owner now he holds a project grant (S2: a later step meets the send-back's project access rule).
    grantProject(t.db, OMAR);
    t.db.set({ ...t.db.get(`DEVTASK#${run.taskId}`, "META")!, currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: OMAR.provider, since: "2026-10-22T11:00:00.000Z" } });
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    const deps = t.routeDeps();
    const [approvalId] = t.runItem(run.taskId)!.steps[1]!.approvalIds;
    const record = (await getAnyApproval(deps, TEST_ORG, approvalId as never)) as StepApprovalRecord;
    expect(record.owner).toEqual({ developerId: OMAR.developerId, name: OMAR.name });
    expect(record.approvers.kind === "rule" && record.approvers.candidates).toContain(OMAR.developerId);
    expect(record.approvers.kind === "rule" && record.approvers.candidates).not.toContain(MAYA.developerId);
  });

  it("goes on to the next step when it is approved, handing it the earlier reports", async () => {
    const { t, run, deps, record } = await atGate();
    await approve(deps, record.approvalId);
    const ops = t.stepOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ programStepId: "send" });
    expect(t.invocationOf(ops[1]!.id).payload.agentStep!.inputs).toBe(`${renderRunInput(INPUT)}\n\nReport from Draft:\nThe draft.`);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ status: "done" }, { id: "gate", status: "done" }, { id: "send", status: "running" }] });
    await t.finishStep(run, ops[1]!.id, "Sent.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE", finalReport: "Sent." });
  });

  it("ends the run CANCELLED with '<step name> declined: <prompt>' when it is declined, and gives the workspace back", async () => {
    const { t, run, deps, record } = await atGate();
    const events = endHandler();
    await approve(deps, record.approvalId, "DECLINE");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "Ship it declined: Send the report to customers?" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
    const view = await t.view(MAYA, run.taskId);
    expect(view).toMatchObject({ status: "CANCELLED" });
    expect(view.run).toMatchObject({ state: "CANCELLED", endReason: "Ship it declined: Send the report to customers?" });
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled", taskId: run.taskId })]);
  });

  it("ends the run CANCELLED when nobody answers in time", async () => {
    const { t, run, deps, record } = await atGate();
    await onWriteDecided(deps, { ...record, status: "EXPIRED" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "Ship it expired: Send the report to customers?" });
  });

  it("hears an approval of a task or run it does not know without failing (the sweep would retry it)", async () => {
    const t = await setup();
    const deps = t.routeDeps();
    const stray = await createStepApproval(deps, { orgId: TEST_ORG, subject: { kind: "agent_run", taskId: randomUUID(), stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: "write_approver", candidates: [] }, project: "payments", owner: { developerId: MAYA.developerId, name: MAYA.name } });
    await expect(onWriteDecided(deps, { ...stray, status: "APPROVED" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// How a run ends, in one place
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the end of a run", () => {
  it("calls every end handler exactly once with the task's end, however often the run is driven again, and with the run limit after an approved raise", async () => {
    const t = await setup();
    const events = endHandler();
    const other: TaskEndEvent[] = [];
    unregister.push(registerTaskEndHandler(async (_deps, event) => { other.push(event); }));
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    // An approved raise of the run's limit: the event carries the task's budget as it is then.
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetUsd = :raised", ExpressionAttributeValues: { ":raised": 40 } }));
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "The retry was removed.");
    const deps = t.routeDeps();
    await advanceAgentRun(deps, run.taskId);
    await onAgentStepFinished(deps, { taskId: run.taskId, operationId: t.stepOps(run.workspaceId)[1]!.id, outcome: "SUCCEEDED", report: "The retry was removed." });
    expect(events).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, outcome: "succeeded", finalReport: "The retry was removed.", runLimitUsd: 40, stopAtUsd: 40, spentUsd: 0 }]);
    expect(other).toHaveLength(1);
    const task = t.meta(run.taskId) as never;
    expect(await onTaskEnded(deps as never, task, "succeeded")).toBe("already_ended");
    expect(events).toHaveLength(1);
  });

  it("tells the end handler the branch the worker chose, and the chain the run belongs to", async () => {
    const t = await setup();
    const events = endHandler();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const run = await startWithContract(t, contract);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "A fix.", { branch: "fix", reason: "yes" });
    expect(events).toEqual([expect.objectContaining({ outcome: "succeeded", branch: "fix", finalReport: "A fix." })]);
  });

  it("ends a run FAILED with the worker's error and tells the end handler", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: "timeout:600000" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("timeout");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)!.steps[0]).toMatchObject({ status: "failed" });
    expect(events).toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect((await t.view(MAYA, run.taskId)).status).toBe("FAILED");
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
  });

  it("ends a run FAILED when its preparation fails, instead of leaving it RUNNING for ever", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await t.finish(run.workspaceId, run.prepareId, "FAILED", { error: "git clone failed" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(events).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("pauses the run when a step ran out of budget: PAUSED_BUDGET, the pause handler is told and the end handler is not, and nothing is released", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const scope = { kind: "task" as const, taskId: run.taskId };
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET", steps: [{ id: "investigate", status: "pending" }, { id: "report", status: "pending" }] });
    expect(paused).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope }]);
    expect(ended).toEqual([]);
    expect(t.meta(run.taskId).releasedAt).toBeUndefined();
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("runs the same step again when the pause is lifted and the run is advanced (Task 32's approval)", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const scope = { kind: "task" as const, taskId: run.taskId };
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    const deps = t.routeDeps();
    // Still paused: advancing does nothing.
    await advanceAgentRun(deps, run.taskId);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "REMOVE budgetPause" }));
    await advanceAgentRun(deps, run.taskId);
    const ops = t.stepOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ programStepId: "investigate" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ id: "investigate", status: "running" }, { id: "report", status: "pending" }] });
  });

  it("ends the run creator_removed at the next step when its owner has left the organization", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) }));
    t.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" });
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.meta(run.taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("is no longer a member");
    expect(events).toEqual([expect.objectContaining({ outcome: "creator_removed", taskId: run.taskId })]);
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
  });

  it("ends the run at the next step when its owner has lost the project's access (S2, any path: an agent run's later steps meet the send-back's rule too)", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    t.channelMembers.mockImplementation(async () => ({ ok: true, memberOf: [] }));
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("Rovara didn't start");
  });

  it("refuses the next step with the exact words when the company has forbidden its model since the run started", async () => {
    const t = await setup();
    const events = endHandler();
    const agentId = await t.agentOf({ instructions: "Two steps.", sequence: [agentStep("one", "One"), agentStep("two", "Two", "none", { settings: { model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } } })] });
    const run = await t.start(agentId);
    await run.finishPrepare();
    // The company forbids that model after the run started.
    const current = await readGuardrailsWithRevision({ documentClient: t.db, tableName: "state" }, TEST_ORG);
    await t.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: { ...current.guardrails, forbiddenModels: [{ provider: "anthropic", modelId: "claude-sonnet-4-6" }] }, expectedRevision: current.revision, by: MAYA.developerId }), by: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true).developerId, actor: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true) });
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "One done.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("isn't allowed on payments");
    expect(events).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("cancels a run whose step is running: the worker is asked to stop, and the cancel's result ends the run CANCELLED", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const cancelled = await t.call(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(t.operations(run.workspaceId).find((operation) => operation.id === first.id)).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING" });
    const cancel = t.operations(run.workspaceId).find((operation) => operation.kind === "cancel")!;
    await t.finish(run.workspaceId, cancel.id, "SUCCEEDED");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
    expect((await t.view(MAYA, run.taskId)).status).toBe("CANCELLED");
  });

  it("blocks the model keys of the task's operations when the run ends, by cancel as by completion", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    // The worker asks for the key of its step.
    const minted = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": t.invocationOf(first.id).callbackCapability } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const key = t.access!.mintedKeys()[0]!;
    expect(t.access!.blockKey).not.toHaveBeenCalled();
    await t.call(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/cancel`, {});
    await t.finish(run.workspaceId, t.operations(run.workspaceId).find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(key));
    expect(events).toHaveLength(1);
    // A second look at the end (the sweep does one) blocks nothing more.
    const calls = t.access!.blockKey.mock.calls.length;
    await advanceAgentRun(t.routeDeps(), run.taskId);
    expect(t.access!.blockKey.mock.calls.length).toBe(calls);
  });

  it("asks the proxy what the task's keys spent for the end handlers", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET modelKeyIds = :keys", ExpressionAttributeValues: { ":keys": ["key-one"] } }));
    vi.spyOn(t.access!, "keySpend").mockResolvedValue(3.25);
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "One.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Two.");
    expect(events).toEqual([expect.objectContaining({ outcome: "succeeded", spentUsd: 3.25 })]);
  });

  it("finds a step whose result callback was lost, from the dispatch row the sweep runs", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    // The worker's result was recorded but nothing went on from it (the process stopped after the commit): only the operation changed.
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${first.id}` }, UpdateExpression: "SET #status = :done, #result = :result", ExpressionAttributeNames: { "#status": "status", "#result": "result" }, ExpressionAttributeValues: { ":done": "SUCCEEDED", ":result": { agentStepResult: { report: "Found it.", outcome: "SUCCEEDED" } } } }));
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :ready REMOVE activeOperationId", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ready": "READY" } }));
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ kind: "agent_run", dispatchDuePk: "WORKFLOW_DISPATCH" });
    // Due: the watchdog the step's dispatch wrote has run out.
    t.db.set({ ...row[0]!, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row[0]!.sk)}` });
    const reply = await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(reply).toBeDefined();
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.runItem(run.taskId)!.reports).toEqual([{ stepId: "investigate", name: "Investigate", text: "Found it." }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The other tasks that end
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("tasks that are not agent-step runs end through the same place", () => {
  it("tells the end handler once when a workflow task is merged, from the release of its workspace", async () => {
    const t = await setup();
    const events = endHandler();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const record = t.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
    record.workflow = { ...(record.workflow as Record<string, unknown>), stage: "MERGED", state: "COMPLETE", outcome: "MERGED" };
    const { releaseFinishedTaskQuietly } = await import("../../packages/broker/src/aws/developer-tasks.js");
    const release = { tableName: "state", actions: t.actions, documentClient: t.db };
    await releaseFinishedTaskQuietly(release, taskId);
    await releaseFinishedTaskQuietly(release, taskId);
    expect(events).toEqual([expect.objectContaining({ orgId: TEST_ORG, taskId, outcome: "merged" })]);
  });

  it("tells it when a plain task's operation succeeds or fails", async () => {
    const t = await setup();
    const events = endHandler();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = t.meta(taskId);
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    // A task started with no agent and no workflow runs its instructions as a plain turn.
    const turn = t.stepOps(workspaceId)[0];
    if (turn === undefined) return;
    await t.finish(workspaceId, turn.id, "FAILED", { error: "the model gave up" });
    expect(events.map((event) => event.outcome)).toEqual(["failed"]);
  });

  it("writes nothing for a task that ends when no handler is listening", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "One.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Two.");
    // An agent-step run's end is recorded whoever listens: its own release and keys depend on it. A plain task's is not.
    expect(t.db.find((item) => item.pk === `DEVTASK#${run.taskId}` && item.sk === "TASK_END")).toHaveLength(1);
    const plain = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const plainId = (plain.body.task as { taskId: string }).taskId;
    const { workspaceId } = t.meta(plainId);
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const turn = t.stepOps(workspaceId)[0];
    if (turn !== undefined) await t.finish(workspaceId, turn.id, "SUCCEEDED");
    expect(t.db.find((item) => item.pk === `DEVTASK#${plainId}` && item.sk === "TASK_END")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the person sees
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the task view of a run", () => {
  it("merges the approval events of the task into its events, and shows no event another org's item carries", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    // An item in the task's partition that names another org (a task partition is global): never shown.
    t.db.set({ ...approvalTaskEventKey(run.taskId, new Date().toISOString(), "apr_zzzzzzzzzzzzzzzzzzzz"), entityType: "TASK_EVENT", orgId: "org_bbbbbbbbbbbbbbbbbbbb", kind: "status", text: "Another org's event.", at: new Date().toISOString() });
    const view = await t.view(MAYA, run.taskId);
    const texts = (view.events as Array<{ text: string; kind: string }>).map((event) => event.text);
    expect(texts).toContain(`Agent wants to comment on LIN-12.`);
    expect(texts).not.toContain("Another org's event.");
    void write;
  });

  it("does not show a run on a task that has none", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    expect((started.body.task as Record<string, unknown>).run).toBeUndefined();
  });

  it("answers the same 404 for another org's task as for a missing one", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    const other = await t.call(OMAR, "GET", `/v1/dev/tasks/${run.taskId}`);
    const missing = await t.call(OMAR, "GET", `/v1/dev/tasks/${randomUUID()}`);
    expect(other.status).toBe(missing.status);
  });
});

describe("approvals of a run: who can see them", () => {
  it("lets someone who can view the task read an approval of it, through the task page's own access check, and nobody else", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    expect(deps.writeGate !== undefined && "canViewTask" in deps.writeGate).toBe(true);
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    expect(await deps.writeGate!.canViewTask!(t.caller(MAYA.developerId), { taskId: run.taskId, project: "payments", developerId: MAYA.developerId })).toBe(true);
    expect(await deps.writeGate!.canViewTask!(t.caller("9".repeat(64)), { taskId: run.taskId, project: "payments", developerId: MAYA.developerId })).toBe(false);
    expect(await deps.writeGate!.canViewTask!(t.caller(MAYA.developerId), { taskId: randomUUID(), project: "payments", developerId: MAYA.developerId })).toBe(false);
    void write;
  });
});

describe("agent-step runs are allowed", () => {
  it("starts a run of an agent made of agent steps on a broker built the way the deployed handler is, with no seam to switch on", async () => {
    const t = await setup();
    const reply = await t.call(MAYA, "POST", "/v1/app/agents/ticket-triage/runs", { project: "payments", input: { text: "Triage LIN-12" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A pull request to look at
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a run that looks at a pull request", () => {
  const HEAD = "a".repeat(40);
  const review = { text: "Review this pull request", context: [{ kind: "pull_request" as const, ref: "example/demo#12", title: "Fix retry" }] };

  it("sends the head commit to the worker with the preparation and with each step, so the workspace has it checked out, read-only", async () => {
    const t = await setup({ brokerExtra: { agents: { pullRequestHead: async () => ({ headSha: HEAD }) } } });
    const run = await t.start("code-reviewer", review);
    const prepare = t.invocationOf(run.prepareId).payload as { checkout?: unknown };
    expect(prepare.checkout).toEqual([{ repository: "demo", pullRequest: 12, headSha: HEAD }]);
    await run.finishPrepare();
    const step = t.invocationOf(t.stepOps(run.workspaceId)[0]!.id).payload.agentStep!;
    expect(AgentStepPayloadSchema.parse(step)).toMatchObject({ checkout: [{ repository: "demo", pullRequest: 12, headSha: HEAD }] });
  });

  it("sends no checkout when the run names no pull request", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    expect((t.invocationOf(run.prepareId).payload as { checkout?: unknown }).checkout).toBeUndefined();
    await run.finishPrepare();
    expect(t.invocationOf(t.stepOps(run.workspaceId)[0]!.id).payload.agentStep).not.toHaveProperty("checkout");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The report in Slack
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the final report in Slack", () => {
  /** A finished run of root-cause-analyst whose last step reports to Slack; every stream record the table made is taken for the notifier. */
  async function finished(options: { channel: boolean; report: string }) {
    const t = await setup();
    if (options.channel) await bindChannel(t.handler, SLACK_CHANNEL, "payments");
    else {
      grantProject(t.db, MAYA);
      await unbindChannel(t.handler, SLACK_CHANNEL);
    }
    const stream = recordStream(t.db);
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, options.report);
    return { t, run, stream };
  }
  const notifier = (t: World, post: ReturnType<typeof vi.fn>, queued: Notice[]) => createNotifierHandler({
    documentClient: t.db, tableName: "state", enqueue: async (notices) => { queued.push(...notices); }, retryLater: async () => undefined, post: post as never,
    now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined,
  });
  const deliver = async (handler: ReturnType<typeof notifier>, notice: Notice, id: string) => handler({ Records: [{ eventSource: "aws:sqs", messageId: id, receiptHandle: id, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } }] });

  it("posts the prepared report to the project's bound channel once, however often the notice is delivered", async () => {
    const { t, run, stream } = await finished({ channel: true, report: "The retry was removed. <!channel> see <https://evil.example/x|the fix>" });
    const post = vi.fn(async () => ({ ts: "1.1", channel: SLACK_CHANNEL }));
    const queued: Notice[] = [];
    const handler = notifier(t, post, queued);
    await handler({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const notice = queued.find((entry) => entry.kind === "agent_report");
    expect(notice).toMatchObject({ kind: "agent_report", taskId: run.taskId });
    await deliver(handler, notice!, "m1");
    await deliver(handler, notice!, "m2");
    expect(post).toHaveBeenCalledTimes(1);
    const posted = (post.mock.calls[0] as unknown as [{ channel: string; text: string }])[0];
    expect(posted.channel).toBe(SLACK_CHANNEL);
    expect(posted.text).toBe("The retry was removed. see the fix (evil[.]example)");
  });

  it("posts only the link to the task when the report holds a command", async () => {
    const { t, run, stream } = await finished({ channel: true, report: "Cause found.\nrollback the release" });
    const post = vi.fn(async () => ({ ts: "1.1", channel: SLACK_CHANNEL }));
    const queued: Notice[] = [];
    const handler = notifier(t, post, queued);
    await handler({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    await deliver(handler, queued.find((entry) => entry.kind === "agent_report")!, "m1");
    const posted = (post.mock.calls[0] as unknown as [{ text: string }])[0];
    // UX2 slice 2: the link is the task's one address, its session page, on the same origin.
    expect(posted.text).toMatch(new RegExp(`^Report available in Rovara: ${new URL(DEV_ISSUER).origin.replace(/[.]/gu, "\\.")}/app/sessions/ses_[0-9a-z]{20}$`, "u"));
    // The whole report stays on the task page.
    expect(t.runItem(run.taskId)!.finalReport).toBe("Cause found.\nrollback the release");
  });

  it("appends the task event 'No Slack channel is set up for <project>, so the report is only on this page.' when the project has no channel, and posts nothing", async () => {
    const { t, run, stream } = await finished({ channel: false, report: "The retry was removed." });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const queued: Notice[] = [];
    const handler = notifier(t, post, queued);
    await handler({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    for (const notice of queued.filter((entry) => entry.kind === "agent_report")) await deliver(handler, notice, "m1");
    expect(post).not.toHaveBeenCalled();
    const texts = t.taskEvents(run.taskId).map((event) => String(event.text));
    expect(texts.filter((text) => text === "No Slack channel is set up for payments, so the report is only on this page.")).toHaveLength(1);
    expect((await t.view(MAYA, run.taskId)).events.map((event) => event.text)).toContain("No Slack channel is set up for payments, so the report is only on this page.");
  });

  it("posts nothing for a step that does not report to Slack", async () => {
    const t = await setup();
    await bindChannel(t.handler, SLACK_CHANNEL, "payments");
    const stream = recordStream(t.db);
    const run = await t.start(await t.agentOf({ instructions: "Look.", sequence: [agentStep("work", "Work")] }), INPUT);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Reviewed.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE" });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const queued: Notice[] = [];
    const handler = notifier(t, post, queued);
    await handler({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    expect(queued.filter((entry) => entry.kind === "agent_report")).toEqual([]);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_REPORT")).toBeUndefined();
    expect(t.taskEvents(run.taskId).map((event) => String(event.text)).filter((text) => text.startsWith("No Slack channel"))).toEqual([]);
    void noticesOf;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Races, repairs and edges
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the engine under repeats, races and lost work", () => {
  it("hears a step's result once when two copies of it arrive at the same moment", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    // The step's result is in the table (its operation ended and the workspace is free) and nothing has gone on from it yet.
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${first.id}` }, UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "SUCCEEDED" } }));
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :ready REMOVE activeOperationId", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ready": "READY" } }));
    await Promise.all([1, 2, 3].map(() => onAgentStepFinished(deps, { taskId: run.taskId, operationId: first.id, outcome: "SUCCEEDED", report: "One." })));
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.runItem(run.taskId)!.reports).toHaveLength(1);
    expect(t.runItem(run.taskId)!.steps[1]!.operationIds).toHaveLength(1);
  });

  it("dispatches a step once when the run is advanced twice at the same moment", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    const deps = t.routeDeps();
    // The preparation succeeded in the table but nothing went on from it (the process stopped after the commit).
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${run.prepareId}` }, UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "SUCCEEDED" } }));
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :ready REMOVE activeOperationId", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ready": "READY" } }));
    const results = await Promise.all([advanceAgentRun(deps, run.taskId), advanceAgentRun(deps, run.taskId)]);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(results).toContain("dispatched");
  });

  it("ends a run FAILED when a step's result holds no report, and when the step was interrupted", async () => {
    const t = await setup();
    const empty = await t.start("root-cause-analyst");
    await empty.finishPrepare();
    await t.finish(empty.workspaceId, t.stepOps(empty.workspaceId)[0]!.id, "SUCCEEDED", { result: { agentStepResult: { report: "  ", outcome: "SUCCEEDED" } } });
    expect(t.runItem(empty.taskId)).toMatchObject({ state: "FAILED", endReason: "The step ended without a report." });
    const interrupted = await t.start("root-cause-analyst");
    await interrupted.finishPrepare();
    await t.finish(interrupted.workspaceId, t.stepOps(interrupted.workspaceId)[0]!.id, "INTERRUPTED", { error: "the worker went away" });
    expect(t.runItem(interrupted.taskId)).toMatchObject({ state: "FAILED", endReason: "The step was interrupted before it finished." });
  });

  it("ignores an approval, a result and a drive that name another org's task", async () => {
    const t = await setup();
    const run = await t.start("code-reviewer");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "review", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: approvalKey(TEST_ORG, write.approvalId), UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "APPROVED_DONE" } }));
    // Heard as an approval of another org (the record names it): the task is not theirs, so nothing moves.
    await onWriteDecided(deps, { ...(await getAnyApproval(deps, TEST_ORG, write.approvalId))!, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
  });

  it("goes on from approvals that were decided without the handler hearing, when the run's watchdog row comes due", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    // The decision was recorded and the handler never heard it (and the sweep's tries are used up or lost).
    await t.db.send(new UpdateCommand({ TableName: "state", Key: approvalKey(TEST_ORG, write.approvalId), UpdateExpression: "SET #status = :done, handlerDone = :yes", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "APPROVED_DONE", ":yes": true } }));
    // A decision also took the approval off the step's counter, in the same transaction (the fixture above wrote the record by hand).
    t.db.set({ pk: orgScoped(TEST_ORG, `STEP_APPROVALS#${run.taskId}`), sk: "investigate", pending: 0 });
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    // A run that waits is looked at again after hours, not at the next sweep.
    expect(Date.parse(String(row.nextAttemptAt)) - Date.now()).toBeGreaterThan(5 * 3_600_000);
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs).toContain("Approved and done: comment on LIN-12");
  });

  it("leaves the run waiting, and looks at it again later, when the row comes due while an approval is still PENDING", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    const again = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    expect(Date.parse(String(again.nextAttemptAt))).toBeGreaterThan(Date.now());
  });

  it("ends a run CANCELLED when its task was closed while it waited", async () => {
    const t = await setup();
    const events = endHandler();
    const agentId = await t.agentOf(WITH_GATE);
    const run = await t.start(agentId);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET closedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
    const [approvalId] = t.runItem(run.taskId)!.steps[1]!.approvalIds;
    const deps = t.routeDeps();
    await onWriteDecided(deps, { ...(await getAnyApproval(deps, TEST_ORG, approvalId as never))!, status: "APPROVED" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });

  it("wakes the engine when a step's operation could not be delivered to a worker, so the run fails instead of waiting for its watchdog", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === first.id)[0]!;
    const { failOutboxOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failOutboxOperation(t.db, "state", outbox as never, "RUNTIME_UNAVAILABLE: the worker could not be reached");
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    expect(Date.parse(String(row.nextAttemptAt))).toBeLessThanOrEqual(Date.now() + 1000);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("the worker could not be reached");
  });

  it("gives a run whose dispatch row keeps failing a clear end instead of leaving it", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    // Nine failed tries already; the tenth gives up.
    t.db.set({ ...row, attempts: 9, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${first.id}` }, UpdateExpression: "SET #status = :done, #result = :result", ExpressionAttributeNames: { "#status": "status", "#result": "result" }, ExpressionAttributeValues: { ":done": "SUCCEEDED", ":result": { agentStepResult: { report: "Found it.", outcome: "SUCCEEDED" } } } }));
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :ready REMOVE activeOperationId", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ready": "READY" } }));
    // Starting the next step fails every time: the workspace is held by an operation the engine knows nothing about.
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :busy, activeOperationId = :other", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":busy": "BUSY", ":other": randomUUID() } }));
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toBe("Rovara couldn't continue this run. Start it again.");
    expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toEqual([]);
  });

  it("keeps what the next step is sent inside the payload limit however large the request and the earlier reports are", async () => {
    const t = await setup();
    const agentId = await t.agentOf({ instructions: "Three steps.", sequence: [agentStep("a", "A"), agentStep("b", "B"), agentStep("c", "C")] });
    const big: RunInput = { text: "x".repeat(8000), context: Array.from({ length: 10 }, (_, index) => ({ kind: "text" as const, ref: `item-${String(index)}`, body: "é".repeat(8000) })) };
    const run = await t.start(agentId, big);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "a".repeat(40_000));
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "b".repeat(40_000));
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[2]!.id).payload.agentStep!.inputs;
    expect(Buffer.byteLength(inputs, "utf8")).toBeLessThanOrEqual(262_144);
    expect(inputs).toContain("Report from A:\n");
    expect(inputs).toContain("Report from B:\n");
    expect(inputs.startsWith(renderRunInput(big))).toBe(true);
  });

  it("keeps each step's report as the task's artifact, whole", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The 14:02 deploy removed the retry.");
    const key = t.runItem(run.taskId)!.steps[0]!.reportKey!;
    expect(await t.actions.readArtifact(key, 100_000)).toBe("The 14:02 deploy removed the retry.");
    // Seen again (a repeat of the result) it is not kept twice.
    await onAgentStepFinished(t.routeDeps(), { taskId: run.taskId, operationId: t.stepOps(run.workspaceId)[0]!.id, outcome: "SUCCEEDED", report: "The 14:02 deploy removed the retry." });
    expect(t.db.find((item) => item.entityType === "ARTIFACT" && item.name === "agent-step-investigate.md")).toHaveLength(1);
  });
});

describe("a refusal that trying again cannot change", () => {
  it("ends the run with the refusal's own words when the step's operation can't be made, and keeps retrying one that can pass", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    const base = t.routeDeps();
    // The preparation succeeded in the table and nothing went on from it.
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${run.prepareId}` }, UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "SUCCEEDED" } }));
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" }, UpdateExpression: "SET #status = :ready REMOVE activeOperationId", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ready": "READY" } }));
    const failing = (code: "MODEL_NOT_ALLOWED" | "RUNTIME_UNAVAILABLE", message: string) => ({ ...base, agentRuns: { ...base.agentRuns!, startStep: async () => { throw agentXError(code, message); } } }) as ApprovalDependencies;
    // A temporary failure is thrown on to the sweep, which tries again.
    await expect(advanceAgentRun(failing("RUNTIME_UNAVAILABLE", "the proxy is down"), run.taskId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING" });
    await advanceAgentRun(failing("MODEL_NOT_ALLOWED", "Root-cause analyst needs its Report step from a different AI company than its Investigate step, and none is allowed on payments. Ask an admin to add one."), run.taskId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED", endReason: "Root-cause analyst needs its Report step from a different AI company than its Investigate step, and none is allowed on payments. Ask an admin to add one." });
    expect(events).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

describe("the connector tools of a step", () => {
  const tools = (t: World, operationId: string) => call(t.handler, { method: "GET", path: "/v1/internal/agent-tools", headers: { "x-agentx-callback-capability": t.invocationOf(operationId).callbackCapability } });

  it("is given the agent-tools scope for every agent step, and an empty list when its recipe grants none (the worker fails a step it is refused)", async () => {
    const t = await setup();
    const none = await t.start(await t.agentOf({ instructions: "No tools.", sequence: [agentStep("work", "Work")] }));
    await none.finishPrepare();
    const answer = await tools(t, t.stepOps(none.workspaceId)[0]!.id);
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200, body: { catalogs: [] } });
    const granted = await t.start("root-cause-analyst");
    await granted.finishPrepare();
    expect((await tools(t, t.stepOps(granted.workspaceId)[0]!.id)).status).toBe(200);
  });
});

describe("a task whose creator left, and a task that was cancelled, end through the same place", () => {
  it("tells the end handlers once that a plain task's creator was removed, however often the check refuses it", async () => {
    const t = await setup();
    const events = endHandler();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    await t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) }));
    t.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" });
    const { requireCreatorStillMember } = await import("../../packages/broker/src/developer/creator-member.js");
    const deps = { documentClient: t.db, tableName: "state", orgId: TEST_ORG };
    const task = t.db.get(`DEVTASK#${taskId}`, "META") as never;
    await expect(requireCreatorStillMember(deps, task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await expect(requireCreatorStillMember(deps, t.db.get(`DEVTASK#${taskId}`, "META") as never)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(events).toEqual([expect.objectContaining({ taskId, outcome: "creator_removed" })]);
  });

  it("tells the end handlers a plain task was cancelled when its cancel succeeds", async () => {
    const t = await setup();
    const events = endHandler();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = t.meta(taskId);
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    expect(t.stepOps(workspaceId)).toHaveLength(1);
    expect(events).toEqual([]);
    await t.call(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, {});
    await t.finish(workspaceId, t.operations(workspaceId).find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
    expect(events).toEqual([expect.objectContaining({ taskId, outcome: "cancelled" })]);
  });
});

describe("task-end handlers", () => {
  it("tells each handler once, in order, takes a failed one up again without telling the others twice, and keeps the pause handlers apart", async () => {
    const t = await setup();
    const order: string[] = [];
    let failures = 1;
    unregister.push(registerTaskEndHandler(async () => { order.push("first"); }));
    unregister.push(registerTaskEndHandler(async () => { order.push("second"); if (failures > 0) { failures -= 1; throw new Error("down"); } }));
    unregister.push(registerTaskEndHandler(async () => { order.push("third"); }));
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "One.");
    // The last result commits; the second handler fails, so the end is told again by the row until every handler has heard it.
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Two.");
    expect(order).toEqual(["first", "second"]);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE" });
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(order).toEqual(["first", "second", "second", "third"]);
    expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toEqual([]);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "TASK_END")).toMatchObject({ done: true, handlersTold: 3, outcome: "succeeded" });
  });
});

describe("a run that looks at a pull request: an old worker", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
  const binding = {
    deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
  };
  function dispatcherFor(features: readonly string[]) {
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliverEc2 = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined,
      planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => Date.parse("2026-10-21T12:00:00.000Z"),
      workerFeatures: async () => features,
    });
    const markFailed = vi.fn(async () => undefined);
    const markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, maxAttempts: 1, log: () => undefined });
    return { handler, post, markFailed, markDelivered };
  }

  it("refuses to prepare a workspace for a pull request on a worker that does not run agent steps, and sends the head to one that does", async () => {
    const t = await setup({ brokerExtra: { agents: { pullRequestHead: async () => ({ headSha: "a".repeat(40) }) } } });
    const run = await t.start("code-reviewer", { text: "Review this pull request", context: [{ kind: "pull_request", ref: "example/demo#12" }] });
    const stored = t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === run.prepareId)[0]!;
    const record = { id: stored.id, entityType: "OUTBOX", status: "QUEUED", operationId: run.prepareId, workspaceId: run.workspaceId, deploymentMode: "ec2-ebs", invocation: stored.invocation } as Ec2OutboxRecord;
    const old = dispatcherFor(["task.workflowMode", "model.thinkingLevel"]);
    await old.handler({ Records: [{ messageId: "old-worker", body: JSON.stringify(record) }] });
    expect(old.post).not.toHaveBeenCalled();
    expect((old.markFailed.mock.calls[0] as unknown as [unknown, string])[1]).toContain(AGENT_WORKER_OUTDATED);
    const current = dispatcherFor(["task.agentStep", "task.agentRun"]);
    await current.handler({ Records: [{ messageId: "new-worker", body: JSON.stringify(record) }] });
    expect(current.post).toHaveBeenCalledTimes(1);
    expect(current.markDelivered).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Survivors of the first mutation run: each guard below is pinned by a test that fails without it
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("what a step's result may and may not change", () => {
  it("changes nothing once the run is over, or for a step that is no longer running", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    await t.finishStep(run, first.id, "One.");
    // The step is done: a late copy with another report changes nothing.
    await onAgentStepFinished(deps, { taskId: run.taskId, operationId: first.id, outcome: "SUCCEEDED", report: "Something else." });
    expect(t.runItem(run.taskId)!.reports).toEqual([{ stepId: "investigate", name: "Investigate", text: "One." }]);
    // The run is over: a result for its running step does nothing either.
    const second = t.stepOps(run.workspaceId)[1]!;
    await cancelAgentRun(deps, run.taskId);
    await onAgentStepFinished(deps, { taskId: run.taskId, operationId: second.id, outcome: "SUCCEEDED", report: "Too late." });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.runItem(run.taskId)!.reports).toHaveLength(1);
    expect(t.runItem(run.taskId)!.finalReport).toBeUndefined();
  });

  it("keeps a report redacted, and takes the branch only from the last agent step", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const run = await startWithContract(t, contract);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was in the log.", { branch: "fix" });
    expect(t.runItem(run.taskId)!.reports[0]!.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(t.runItem(run.taskId)!.branch).toBeUndefined();
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Done.");
    expect(t.runItem(run.taskId)!.branch).toBeUndefined();
  });

  it("does not hand an outcome back while the approval is being carried out (EXECUTING is not decided)", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: approvalKey(TEST_ORG, write.approvalId), UpdateExpression: "SET #status = :executing", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":executing": "EXECUTING" } }));
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("hands the outcomes back at most four times, then lets the step end", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const deps = t.routeDeps();
    for (let round = 0; round < 6; round += 1) {
      const ops = t.stepOps(run.workspaceId);
      const current = ops.at(-1)!;
      if (current.programStepId !== "investigate") break;
      const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: current.id, summary: `action ${String(round)}` });
      await t.finishStep(run, current.id, `Report ${String(round)}.`);
      if (t.runItem(run.taskId)!.state === "WAITING_FOR_APPROVAL") await approve(deps, write.approvalId);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const investigateOps = t.stepOps(run.workspaceId).filter((operation) => operation.programStepId === "investigate");
    expect(investigateOps).toHaveLength(1 + 4);
    expect(t.stepOps(run.workspaceId).at(-1)).toMatchObject({ programStepId: "report" });
  });

  it("shortens each earlier report so the next step's inputs stay in the payload limit, and keeps the stored reports inside the run's budget", async () => {
    const t = await setup();
    const agentId = await t.agentOf({ instructions: "Four.", sequence: [agentStep("a", "A"), agentStep("b", "B"), agentStep("c", "C"), agentStep("d", "D")] });
    const big: RunInput = { text: "x".repeat(8000), context: Array.from({ length: 10 }, (_, index) => ({ kind: "text" as const, ref: `item-${String(index)}`, body: "e".repeat(16_000) })) };
    const run = await t.start(agentId, big);
    await run.finishPrepare();
    for (const [index, name] of ["a", "b", "c"].entries()) await t.finishStep(run, t.stepOps(run.workspaceId)[index]!.id, name.repeat(40_000));
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[3]!.id).payload.agentStep!.inputs;
    expect(Buffer.byteLength(inputs, "utf8")).toBeLessThanOrEqual(262_144);
    expect(inputs).toContain(SHORTENED_MARKER);
    const stored = t.runItem(run.taskId)!.reports.reduce((total, report) => total + Buffer.byteLength(report.text, "utf8"), 0);
    expect(stored).toBeLessThanOrEqual(150 * 1024);
  });

  it("hands a continuation the step's own earlier report, and says it in the step's event", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "My first findings.");
    await approve(deps, write.approvalId);
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs;
    expect(inputs).toContain("Your report for this step before the outcomes were known:\nMy first findings.");
    // The continuation is dispatched outside the sweep, so its watchdog row is the step's own: hours away. Nothing is pending any more.
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    expect(Date.parse(String(row.nextAttemptAt)) - Date.now()).toBeGreaterThan(60 * 60_000);
    expect((await t.view(MAYA, run.taskId)).run.pendingApprovals).toEqual([]);
    expect((await t.view(MAYA, run.taskId)).events.map((event) => event.text)).toContain("Carrying on with Investigate now that the outcomes of the actions that needed approval are known.");
  });

  it("is not told of a run another org's item names, or of an approval that belongs to another task", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "AGENT_RUN" }, UpdateExpression: "SET orgId = :other", ExpressionAttributeValues: { ":other": "org_bbbbbbbbbbbbbbbbbbbb" } }));
    expect(await advanceAgentRun(deps, run.taskId)).toBe("no_run");
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "AGENT_RUN" }, UpdateExpression: "SET orgId = :mine", ExpressionAttributeValues: { ":mine": TEST_ORG } }));
    // An approval of another task, named by an event in this task's partition, is not this task's.
    const stranger = await askWrite(t, deps, { taskId: randomUUID(), stepId: "investigate", operationId: randomUUID(), summary: "a stranger's action" });
    t.db.set({ ...approvalTaskEventKey(run.taskId, new Date().toISOString(), stranger.approvalId), entityType: "TASK_EVENT", orgId: TEST_ORG, kind: "status", text: "x", at: new Date().toISOString() });
    await t.finishStep(run, first.id, "One.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ status: "done" }, { status: "running" }] });
  });

  it("leaves a running step a watchdog row that is not due for a long while", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    expect(Date.parse(String(row.nextAttemptAt)) - Date.now()).toBeGreaterThan(10 * 60_000);
  });
});

describe("the agent step's payload", () => {
  it("carries the layered instructions, the step's time limit and no instruction section in the prompt", async () => {
    const t = await setup();
    const agentId = await t.agentOf({ instructions: "House rules.", sequence: [agentStep("work", "Work", "none", { settings: { instructions: "Be brief.", timeoutMinutes: 30 } })] });
    const run = await t.start(agentId);
    await run.finishPrepare();
    const payload = t.invocationOf(t.stepOps(run.workspaceId)[0]!.id).payload;
    expect(payload.agentStep).toMatchObject({ timeoutMs: 1_800_000 });
    expect(payload.agentStep!.instructions).toMatch(/^From [^\n]+:\nHouse rules\.\n\nFrom [^\n]+:\nBe brief\.$/);
    expect(String(payload.prompt)).not.toContain("Instructions from your company's agent");
    expect(String(payload.prompt)).not.toContain("House rules.");
  });

  it("refuses instructions too long for the worker, and puts the step's own name in its operation", async () => {
    const { applyAgentStep } = await import("../../packages/broker/src/agents/dispatch.js");
    const { EMPTY_RECIPE } = await import("@rovara-code/contracts");
    const { DEFAULT_AGENT_GUARDRAILS } = await import("@rovara-code/contracts");
    const step = { id: "work", name: "Work", kind: "agent" as const, workspace: "none" as const, settings: { instructions: [{ agentName: "A", text: "y".repeat(70_000) }] } };
    const recipe = { ...structuredClone(EMPTY_RECIPE), chain: [{ agentId: "agt_aaaaaaaaaaaaaaaaaaaa" as AgentId, name: "A", version: 1, builtin: false }], steps: [step] };
    expect(() => applyAgentStep({ recipe, ref: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "A", version: 1, builtin: false }, guardrails: { ...DEFAULT_AGENT_GUARDRAILS }, project: "payments", priorOperations: [], agentRun: { step, inputs: "Request:\nx" } })).toThrow(/too long to send to the worker/);
  });

  it("holds a step that must differ in company from an earlier agent step to it, as it does for coding steps", async () => {
    const t = await setup({ brokerExtra: { agents: { servableModels: async () => [{ provider: "anthropic", modelId: "claude-sonnet-4-6" }, { provider: "openai", modelId: "gpt-5.5" }] } } });
    const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    const refused = await t.start(await t.agentOf({ instructions: "Two.", sequence: [agentStep("one", "One", "none", { settings: { model: sonnet } }), agentStep("two", "Two", "none", { settings: { model: sonnet, differentCompanyFrom: "one" } })] }));
    await refused.finishPrepare();
    await t.finishStep(refused, t.stepOps(refused.workspaceId)[0]!.id, "One.");
    expect(t.runItem(refused.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(refused.taskId)!.endReason).toContain("different AI company");
    const allowed = await t.start(await t.agentOf({ instructions: "Two.", sequence: [agentStep("one", "One", "none", { settings: { model: sonnet } }), agentStep("two", "Two", "none", { settings: { model: { provider: "openai", modelId: "gpt-5.5" }, differentCompanyFrom: "one" } })] }));
    await allowed.finishPrepare();
    await t.finishStep(allowed, t.stepOps(allowed.workspaceId)[0]!.id, "One.");
    expect(t.stepOps(allowed.workspaceId)).toHaveLength(2);
  });

  it("does not run an agent step of a run on its owner's ChatGPT plan", async () => {
    const plan = { [MAYA.developerId]: { connected: true, status: "connected", models: ["gpt-6.1-sol"] } };
    const chatgpt = {
      settings: async () => ({ enabled: true, preferredModel: "gpt-6.1-sol" }), view: async (developerId: string) => (plan as Record<string, unknown>)[developerId] ?? { connected: false },
      accessToken: async () => ({ access: "token", expiresAt: Date.now() + 3_600_000, models: [] }), markStatus: async () => undefined, refreshModels: async () => undefined,
    };
    const t = await setup({ brokerExtra: { chatgpt } });
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const op = t.stepOps(run.workspaceId)[0]!;
    expect(t.invocationOf(op.id).payload).not.toHaveProperty("chatgpt");
    expect(op.chatgptDeveloperId).toBeUndefined();
  });

  it("sends no readiness checks with an agent step, though the project has some", async () => {
    const t = await setup({ readyChecks: true });
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    expect(t.invocationOf(t.stepOps(run.workspaceId)[0]!.id).payload).not.toHaveProperty("readiness");
  });
});

describe("prepareSlackReport: what only the full normalisation and the exact forms catch", () => {
  const options = { orgId: TEST_ORG, taskUrl: TASK_LINK, reportLinkDomains: [], extraCommandWords: [] };
  it("finds a command written with a look-alike letter that the text clean-up alone does not fold", () => {
    expect(prepareSlackReport("rollbаck", options)).toEqual({ kind: "link_only", text: `Report available in Rovara: ${TASK_LINK}` });
  });
  it("does not leave a link inside a link's label", () => {
    const result = prepareSlackReport("see <https://evil.example/x|https://good.example/y>", options);
    expect(result.text).not.toContain("https://");
    expect(result.text).toContain("(evil[.]example)");
  });
  it("takes a plain @here out with the space after it", () => {
    expect(prepareSlackReport("Ping @here now", options)).toEqual({ kind: "text", text: "Ping now" });
  });
  it("is the org's domain list that decides, not a look-alike ending", () => {
    expect(prepareSlackReport("<https://evilacme.example/x|a>", { ...options, reportLinkDomains: ["acme.example"] })).toEqual({ kind: "text", text: "a (evilacme[.]example)" });
  });
});

describe("the guardrails that shape the Slack report", () => {
  async function finishedWith(report: string, guardrails: { extraCommandWords?: string[]; reportLinkDomains?: string[] }) {
    const t = await setup();
    const current = await readGuardrailsWithRevision({ documentClient: t.db, tableName: "state" }, TEST_ORG);
    await t.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: { ...current.guardrails, ...guardrails }, expectedRevision: current.revision, by: MAYA.developerId }), by: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true).developerId, actor: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true) });
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, report);
    return { t, run, post: t.db.get(`DEVTASK#${run.taskId}`, "AGENT_REPORT") as { kind: string; text: string } | undefined };
  }
  it("withholds a report that holds the org's own command word", async () => {
    const { post } = await finishedWith("the deploy script failed", { extraCommandWords: ["deploy"] });
    expect(post).toMatchObject({ kind: "link_only" });
  });
  it("keeps a link to a host the org allows", async () => {
    const { post } = await finishedWith("see <https://docs.acme.example/runbook|the runbook>", { reportLinkDomains: ["acme.example"] });
    expect(post).toMatchObject({ kind: "text", text: "see <https://docs.acme.example/runbook|the runbook>" });
  });
  it("leaves nothing for the notifier, and says nothing about Slack, when the run failed", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[1]!.id, "FAILED", { error: "the model gave up" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_REPORT")).toBeUndefined();
    expect(t.taskEvents(run.taskId).map((event) => String(event.text)).filter((text) => text.startsWith("No Slack channel"))).toEqual([]);
  });
});

describe("approval steps check the task before they ask", () => {
  async function atTheGate(change: (t: World) => Promise<void>) {
    const t = await setup();
    const run = await t.start(await t.agentOf(WITH_GATE));
    await run.finishPrepare();
    await change(t);
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    return { t, run };
  }
  it("does not ask when the creator left meanwhile, and ends the run creator_removed", async () => {
    const { t, run } = await atTheGate(async (w) => {
      await w.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) }));
      w.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" });
    });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.meta(run.taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(t.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });
  it("does not ask when the company forbade a model of the agent meanwhile", async () => {
    const agent = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    const t = await setup();
    const id = await t.agentOf({ instructions: "x", sequence: [agentStep("draft", "Draft"), { id: "gate", name: "Ship it", kind: "approval" as const, prompt: "Go?" }, agentStep("send", "Send", "none", { settings: { model: agent } })] });
    const run = await t.start(id);
    await run.finishPrepare();
    const current = await readGuardrailsWithRevision({ documentClient: t.db, tableName: "state" }, TEST_ORG);
    await t.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: { ...current.guardrails, forbiddenModels: [agent] }, expectedRevision: current.revision, by: MAYA.developerId }), by: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true).developerId, actor: fixtureActor(t.store, TEST_ORG, MAYA.developerId, true) });
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });
  it("hears an approval that was decided before the run was waiting on it", async () => {
    const t = await setup();
    const run = await t.start(await t.agentOf(WITH_GATE));
    await run.finishPrepare();
    const deps = t.routeDeps();
    const owner = { developerId: MAYA.developerId, name: MAYA.name };
    const early = await createStepApproval(deps, { orgId: TEST_ORG, subject: { kind: "agent_run", taskId: run.taskId, stepId: "gate" }, prompt: "Send the report to customers?", approvers: { kind: "rule", rule: "write_approver", candidates: [MAYA.developerId] }, project: "payments", owner });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: approvalKey(TEST_ORG, early.approvalId), UpdateExpression: "SET #status = :yes", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":yes": "APPROVED" } }));
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.stepOps(run.workspaceId)[1]).toMatchObject({ programStepId: "send" });
  });
});

describe("the end handlers' unit contract", () => {
  const taskOf = (t: World, taskId: string) => t.db.get(`DEVTASK#${taskId}`, "META") as never;
  const endDeps = (t: World) => ({ documentClient: t.db, tableName: "state", now: Date.now });

  it("tells a handler once when two calls meet, and keeps the lease off when a handler fails", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    let told = 0;
    unregister.push(registerTaskEndHandler(async () => { told += 1; await new Promise((resolve) => setTimeout(resolve, 20)); }));
    const results = await Promise.all([onTaskEnded(endDeps(t), taskOf(t, taskId), "closed"), onTaskEnded(endDeps(t), taskOf(t, taskId), "closed")]);
    expect(told).toBe(1);
    // The call that meets the other's unfinished telling is told so (Task 22 review, I4), not that the end is over.
    expect([...results].sort()).toEqual(["called", "in_progress"]);
  });

  it("takes a failed handler up at once on the next call", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    let fail = true;
    let told = 0;
    unregister.push(registerTaskEndHandler(async () => { if (fail) { fail = false; throw new Error("down"); } told += 1; }));
    await expect(onTaskEnded(endDeps(t), taskOf(t, taskId), "closed")).rejects.toThrow("down");
    expect(await onTaskEnded(endDeps(t), taskOf(t, taskId), "closed")).toBe("called");
    expect(told).toBe(1);
  });

  it("tells the task's budget as it stands now, the cap on the run, and the spend; a spend that can't be read is told as nothing", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const stale = structuredClone(taskOf(t, taskId)) as Record<string, unknown>;
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, UpdateExpression: "SET budgetUsd = :raised, maxPerRunUsd = :cap", ExpressionAttributeValues: { ":raised": 40, ":cap": 10 } }));
    const events = endHandler();
    const spend = async () => { throw new Error("proxy down"); };
    await onTaskEnded({ ...endDeps(t), agentRuns: { spentUsd: spend } }, stale as never, "closed");
    expect(events).toEqual([expect.objectContaining({ runLimitUsd: 40, stopAtUsd: 10, spentUsd: 0, outcome: "closed" })]);
  });

  it("tells nobody about a task that belongs to no org, and writes nothing", async () => {
    const t = await setup();
    const events = endHandler();
    const task = { taskId: randomUUID() } as never;
    expect(await onTaskEnded(endDeps(t), task, "closed")).toBe("not_listening");
    expect(events).toEqual([]);
  });

  it("writes no record of a merged workflow task's end when no handler listens", async () => {
    const t = await setup();
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const record = t.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
    record.workflow = { ...(record.workflow as Record<string, unknown>), stage: "MERGED", state: "COMPLETE", outcome: "MERGED" };
    const { releaseFinishedTaskQuietly } = await import("../../packages/broker/src/aws/developer-tasks.js");
    await releaseFinishedTaskQuietly({ tableName: "state", actions: t.actions, documentClient: t.db }, taskId);
    expect(t.db.get(`DEVTASK#${taskId}`, "TASK_END")).toBeUndefined();
  });

  it("is told of a pause handler that failed again until it hears", async () => {
    const t = await setup();
    let fail = true;
    const paused: TaskPauseEvent[] = [];
    unregister.push(registerTaskPauseHandler(async (_deps, event) => { if (fail) { fail = false; throw new Error("down"); } paused.push(event); }));
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
    expect(paused).toEqual([]);
    expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toHaveLength(1);
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(paused).toHaveLength(1);
    expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toEqual([]);
  });

  it("blocks the model keys when a run completes and when a plain task is cancelled", async () => {
    const t = await setup({ proxy: true });
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": t.invocationOf(first.id).callbackCapability } });
    const key = t.access!.mintedKeys()[0]!;
    await t.finishStep(run, first.id, "One.");
    // The first operation's own end blocks its key; the run's end finds it blocked and blocks nothing more.
    const afterFirst = t.access!.blockKey.mock.calls.length;
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(key));
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Two.");
    expect(t.access!.blockKey.mock.calls.length).toBe(afterFirst);

    const plain = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const plainId = (plain.body.task as { taskId: string }).taskId;
    const { workspaceId } = t.meta(plainId);
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const turn = t.stepOps(workspaceId)[0]!;
    await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": t.invocationOf(turn.id).callbackCapability } });
    const plainKey = t.access!.mintedKeys().at(-1)!;
    expect(t.access!.blockKey).not.toHaveBeenCalledWith(keyIdOf(plainKey));
    await t.call(MAYA, "POST", `/v1/dev/tasks/${plainId}/cancel`, {});
    await t.finish(workspaceId, t.operations(workspaceId).find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plainKey));
  });
});

describe("the broker's side of a run", () => {
  it("answers who may see an approval only for the task's own project", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    const deps = t.routeDeps();
    expect(await deps.writeGate!.canViewTask!(t.caller(MAYA.developerId), { taskId: run.taskId, project: "another", developerId: MAYA.developerId })).toBe(false);
  });

  it("keeps a step's report once however often it is saved, and reads only the project's own Slack channels", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const task = t.meta(run.taskId) as never;
    const host = deps.agentRuns!;
    const a = await host.saveReport!({ task, operationId: first.id, stepId: "investigate", text: "Report." });
    const b = await host.saveReport!({ task, operationId: first.id, stepId: "investigate", text: "Report." });
    expect(a).toBe(b);
    expect(t.db.find((item) => item.entityType === "ARTIFACT" && item.name === "agent-step-investigate.md")).toHaveLength(1);
    t.db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, "C0OTHER0001"), entityType: "SLACK_BINDING", orgId: TEST_ORG, teamId: SLACK_TEAM, channelId: "C0OTHER0001", projectName: "billing" });
    expect(await host.slackChannels!(TEST_ORG, "payments")).toEqual([SLACK_CHANNEL]);
  });

  it("wakes the engine for a step, a preparation and a stopped step, and for nothing else or nobody else's", async () => {
    const { agentRunWakeItems } = await import("../../packages/broker/src/aws/agent-run-wakeup.js");
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const wake = (operation: Record<string, unknown>) => agentRunWakeItems(t.db, "state", operation as never, run.taskId, new Date().toISOString());
    expect(await wake({ ...first })).toHaveLength(1);
    expect(await wake({ kind: "prepare", id: run.prepareId, workspaceId: run.workspaceId })).toHaveLength(1);
    expect(await wake({ kind: "publish", id: "x", workspaceId: run.workspaceId })).toEqual([]);
    expect(await wake({ kind: "task", id: "x", workspaceId: run.workspaceId, workflowMode: "PLAN" })).toEqual([]);
    expect(await wake({ kind: "cancel", id: "c", workspaceId: run.workspaceId, targetOperationId: first.id })).toHaveLength(1);
    expect(await wake({ kind: "cancel", id: "c", workspaceId: run.workspaceId, targetOperationId: run.prepareId })).toHaveLength(1);
    expect(await wake({ kind: "cancel", id: "c", workspaceId: run.workspaceId, targetOperationId: randomUUID() })).toEqual([]);
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "AGENT_RUN" }, UpdateExpression: "SET orgId = :other", ExpressionAttributeValues: { ":other": "org_bbbbbbbbbbbbbbbbbbbb" } }));
    expect(await wake({ ...first })).toEqual([]);
  });

  it("fails a run whose preparation could not be delivered, instead of leaving it", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === run.prepareId)[0]!;
    const { failOutboxOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failOutboxOperation(t.db, "state", outbox as never, "RUNTIME_UNAVAILABLE: the worker could not be reached");
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("the worker could not be reached");
  });

  it("shows a failed run's reason in the task view and says in the release record that its run ended", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: "the model gave up" });
    const view = await t.view(MAYA, run.taskId);
    expect(view).toMatchObject({ status: "FAILED" });
    expect((view as unknown as { failure: { message: string } }).failure.message).toContain("the model gave up");
    expect(JSON.stringify(t.db.find((item) => item.action === "close" && item.taskId === run.taskId))).toContain("its run ended");
  });
});

describe("the notifier's report notice", () => {
  const noticeOf = (next: Record<string, unknown>, previous?: Record<string, unknown>) => noticesOf(previous, next, "2026-10-22T10:00:00.000Z", "e1");
  it("is made once, when the report is written pending", () => {
    const item = { entityType: "AGENT_REPORT_POST", taskId: "t1", status: "PENDING" };
    expect(noticeOf(item)).toEqual([expect.objectContaining({ kind: "agent_report", taskId: "t1", id: "t1:agent_report" })]);
    expect(noticeOf(item, item)).toEqual([]);
    expect(noticeOf({ ...item, status: "SENT" })).toEqual([]);
  });

  it("does not post again a report that may have landed, and does not claim one twice", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Done.");
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const queued: Notice[] = [];
    const handler = createNotifierHandler({ documentClient: t.db, tableName: "state", enqueue: async (notices) => { queued.push(...notices); }, retryLater: async () => undefined, post, now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined });
    const notice: Notice = { id: `${run.taskId}:agent_report`, kind: "agent_report", taskId: run.taskId, at: new Date().toISOString() };
    const message = (id: string) => ({ eventSource: "aws:sqs", messageId: id, receiptHandle: id, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } });
    const key = { pk: `DEVTASK#${run.taskId}`, sk: "AGENT_REPORT" };
    await t.db.send(new UpdateCommand({ TableName: "state", Key: key, UpdateExpression: "SET #status = :unknown", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":unknown": "UNKNOWN" } }));
    await handler({ Records: [message("m1")] });
    expect(post).not.toHaveBeenCalled();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: key, UpdateExpression: "SET #status = :pending", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pending": "PENDING" } }));
    await Promise.all([handler({ Records: [message("m2")] }), handler({ Records: [message("m3")] })]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(t.db.get(key.pk, key.sk)).toMatchObject({ status: "SENT", attempts: 1 });
    void queued;
  });
});

describe("an approval the sweep gave up on, when the run can't be ended yet", () => {
  it("is not given up for good until the run has been told, and then fails the run", async () => {
    const clock = { now: Date.now() };
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const base = t.routeDeps(clock);
    const write = await askWrite(t, base, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    const down = true;
    const failing = { ...base, agentRuns: { ...base.agentRuns!, startStep: async () => { throw new Error("gone"); }, blockKeys: async () => { if (down) throw new Error("proxy down"); } } } as ApprovalDependencies;
    await approve(failing, write.approvalId);
    let failedAt = -1;
    for (let round = 0; round < 14 && failedAt < 0; round += 1) {
      clock.now += 7 * 3_600_000;
      await expireApprovals(failing, clock.now);
      if (t.runItem(run.taskId)!.state === "FAILED") failedAt = round;
    }
    // The run was ended by the hook, but ending it did not finish (the proxy is down): the hook failed, so the record is still owed and tried again.
    expect(failedAt).toBeGreaterThan(0);
    expect((await getAnyApproval(failing, TEST_ORG, write.approvalId))!.handlerDone).not.toBe(true);
    clock.now += 7 * 3_600_000;
    await expireApprovals(failing, clock.now);
    expect((await getAnyApproval(failing, TEST_ORG, write.approvalId))!.handlerDone).toBe(true);
    void down;
  });
});

describe("the run's budgets and the end of a step the broker never heard from", () => {
  it("keeps the reports a run stores inside the budget of its state item however many steps there are", async () => {
    const t = await setup();
    const ids = ["a", "b", "c", "d", "e", "f"];
    const agentId = await t.agentOf({ instructions: "Six.", sequence: ids.map((id) => agentStep(id, id.toUpperCase())) });
    const run = await t.start(agentId);
    await run.finishPrepare();
    for (const [index, id] of ids.entries()) await t.finishStep(run, t.stepOps(run.workspaceId)[index]!.id, id.repeat(40_000));
    const reports = t.runItem(run.taskId)!.reports;
    expect(reports).toHaveLength(6);
    expect(reports.reduce((total, report) => total + Buffer.byteLength(report.text, "utf8"), 0)).toBeLessThanOrEqual(150 * 1024 + 1024);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE" });
  });

  it("blocks the task's keys when a run ends over a step whose compute was lost, a path that blocks nothing itself", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": t.invocationOf(first.id).callbackCapability } });
    const key = t.access!.mintedKeys()[0]!;
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", run.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    expect(t.access!.blockKey).not.toHaveBeenCalled();
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(key));
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 of the Task 22 review (C1, C2, I1 to I4, M1 to M4, M7). Each probe of the review (P1 to P6) is a test here.
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("Task 22 review: the Slack report can never ping (C2) and flattens bare domains (M4)", () => {
  const options = (extra: Partial<Parameters<typeof prepareSlackReport>[1]> = {}) => ({ orgId: TEST_ORG, taskUrl: TASK_LINK, reportLinkDomains: [], extraCommandWords: [], ...extra });

  it("P1: strips a broadcast written with fullwidth brackets, which the folding turns into a live <!channel>", () => {
    expect(prepareSlackReport("Done ＜!channel＞ now", options())).toEqual({ kind: "text", text: "Done now" });
    for (const form of ["＜!here＞", "＜!everyone＞", "＜!subteam^S1＞", "＜!subteam^S1|@oncall＞", "＜@U123＞", "＜@W456|alice＞", "＜#C789|general＞"]) {
      const result = prepareSlackReport(`before ${form} after`, options());
      expect(result.kind).toBe("text");
      expect(result.text, form).not.toMatch(/<[!@#]/u);
      expect(result.text, form).not.toContain("<!");
    }
  });

  it("strips a form the other characters of which are look-alikes or invisible", () => {
    for (const form of ["<!chan​nel>", "<!he­re>", "<！channel>", "＜!channel＞"]) {
      expect(prepareSlackReport(`x ${form} y`, options()).text, form).not.toMatch(/<!/u);
    }
  });

  it("escapes every < > & that is left, so the text holds no Slack control sequence at all", () => {
    expect(prepareSlackReport("if a < b && c > d then <b>bold</b>", options())).toEqual({ kind: "text", text: "if a &lt; b &amp;&amp; c &gt; d then &lt;b&gt;bold&lt;/b&gt;" });
    // An unknown <!…> form (a date, say) keeps its label and nothing else.
    expect(prepareSlackReport("at <!date^1700000000^{date}|today> ok", options()).text).toBe("at today ok");
  });

  it("keeps a link to the task and to an allowed host, escaping only what is not the link itself", () => {
    const own = `see <${TASK_LINK}|the task> & <https://docs.acme.example/a?x=1&y=2|the doc>`;
    expect(prepareSlackReport(own, options({ reportLinkDomains: ["acme.example"] }))).toEqual({
      kind: "text", text: `see <${TASK_LINK}|the task> &amp; <https://docs.acme.example/a?x=1&amp;y=2|the doc>`,
    });
    // A `<` hidden in an allowed link's address or label never survives as a control character.
    const sneaky = prepareSlackReport("<https://docs.acme.example/x<!channel>|<!here>>", options({ reportLinkDomains: ["acme.example"] }));
    expect(sneaky.text).not.toMatch(/<!/u);
  });

  it("M4: turns a bare domain, a www host and a mailto link into plain text with the host", () => {
    const result = prepareSlackReport("see evil.example/login and www.evil.example and evil.com for more", options());
    expect(result.kind).toBe("text");
    expect(result.text).not.toContain("evil.example/login");
    expect(result.text).not.toContain("www.");
    // The flattened host is defanged (its dots in brackets), or Slack would link it again (final fix wave, runs minor 2, Task 22 M4).
    expect(result.text).toContain("link (evil[.]example)");
    expect(result.text).toContain("link (evil[.]com)");
    expect(result.text).not.toMatch(/evil\.(?:example|com)/u);
    const mail = prepareSlackReport("write to mailto:boss@evil.example or <mailto:boss@evil.example|the boss>", options());
    expect(mail.text).not.toContain("mailto:");
    expect(mail.text).toContain("(evil[.]example)");
    expect(mail.text).not.toContain("evil.example");
  });

  it("minor 2: a host with a port, a subdomain, an unparseable address and a Slack `<url|label>` link are all shown with their dots defanged", () => {
    const result = prepareSlackReport("a <https://login.evil.example:8443/x|sign in> and https://a.b.evil.example/p and evil.example:8080/x", options());
    expect(result.text).not.toMatch(/[a-z]\.[a-z]/u);
    expect(result.text).toContain("sign in (login[.]evil[.]example:8443)");
    expect(result.text).toContain("link (a[.]b[.]evil[.]example)");
  });

  it("M4: leaves versions, file names and the org's own bare domain alone", () => {
    expect(prepareSlackReport("v1.2.3 changed README.md, index.ts and package.json; node.js 22.1 was used", options()).text).toBe("v1.2.3 changed README.md, index.ts and package.json; node.js 22.1 was used");
    expect(prepareSlackReport("docs at acme.example/runbook", options({ reportLinkDomains: ["acme.example"] })).text).toBe("docs at acme.example/runbook");
  });

  it("flattens a link written in the label of an allowed link, so the label never shows an address that is not the link's", () => {
    const result = prepareSlackReport("<https://docs.acme.example/x|https://evil.example/login>", options({ reportLinkDomains: ["acme.example"] }));
    expect(result.text).not.toContain("https://evil.example");
    expect(result.text).toContain("(evil[.]example)");
    expect(result.text).toMatch(/^<https:\/\/docs\.acme\.example\/x\|/u);
  });
});

describe("Task 22 review: cancelling stops the run (C1)", () => {
  async function runningWithWrite() {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    return { t, run, first, deps, write };
  }
  const cancelRoute = (t: World, taskId: string) => t.call(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, {});
  /** The intent a cancel leaves on the run, written the way the cancel's own transaction writes it. */
  const recordIntent = (t: World, taskId: string) => t.db.send(new UpdateCommand({
    TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "AGENT_RUN" }, UpdateExpression: "SET cancelRequestedAt = :at, revision = revision + :one",
    ExpressionAttributeValues: { ":at": new Date().toISOString(), ":one": 1 },
  }));

  it("P2: a step that was asked to stop and still finishes successfully ends the run CANCELLED, and the next step is never dispatched", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    expect((await cancelRoute(t, run.taskId)).status).toBe(200);
    expect(t.stepOps(run.workspaceId)[0]).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", cancelRequestedAt: expect.any(String) as string });
    await t.finishStep(run, first.id, "Found it.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", steps: [{ id: "investigate", status: "failed" }, { id: "report", status: "pending" }] });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ taskId: run.taskId, outcome: "cancelled" })]);
    // The cancel operation succeeding afterwards changes nothing.
    await t.finish(run.workspaceId, t.operations(run.workspaceId).find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
  });

  it("a step that was asked to stop and fails, or runs out of budget, ends the run CANCELLED too", async () => {
    const t = await setup();
    const failed = await t.start("root-cause-analyst");
    await failed.finishPrepare();
    await cancelRoute(t, failed.taskId);
    await t.finish(failed.workspaceId, t.stepOps(failed.workspaceId)[0]!.id, "FAILED", { error: "the model gave up" });
    expect(t.runItem(failed.taskId)).toMatchObject({ state: "CANCELLED" });
    const broke = await t.start("root-cause-analyst");
    await broke.finishPrepare();
    await cancelRoute(t, broke.taskId);
    await t.finish(broke.workspaceId, t.stepOps(broke.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(t.runItem(broke.taskId)).toMatchObject({ state: "CANCELLED" });
  });

  it("P3: a step cancelled while a write approval is pending ends the run CANCELLED with the approval expired, and approving it later dispatches no continuation", async () => {
    const { t, run, first, deps, write } = await runningWithWrite();
    const events = endHandler();
    await cancelRoute(t, run.taskId);
    await t.finishStep(run, first.id, "Provisional report.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId as never))!.status).toBe("EXPIRED");
    await approve(deps, write.approvalId).catch(() => undefined);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });

  it("a decision that reaches a waiting run after its cancel was recorded ends the run instead of continuing the step", async () => {
    const { t, run, first, deps, write } = await runningWithWrite();
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await recordIntent(t, run.taskId);
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    // The same for a step approval: a cancel recorded while the run waits for a person.
    const agentId = await t.agentOf(WITH_GATE);
    const gated = await t.start(agentId);
    await gated.finishPrepare();
    await t.finishStep(gated, t.stepOps(gated.workspaceId)[0]!.id, "The draft.");
    await recordIntent(t, gated.taskId);
    const [approvalId] = t.runItem(gated.taskId)!.steps[1]!.approvalIds;
    await approve(deps, approvalId!);
    expect(t.runItem(gated.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.stepOps(gated.workspaceId)).toHaveLength(1);
  });

  it("a run that is between steps when its cancel is recorded dispatches nothing", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    await recordIntent(t, run.taskId);
    // The step's result reaches the engine only through the sweep's row (the callback's own drive is lost).
    t.db.set({ ...t.db.get(`WORKSPACE#${run.workspaceId}`, `OPERATION#${first.id}`)!, status: "SUCCEEDED", result: { agentStepResult: { report: "Found it.", outcome: "SUCCEEDED" } } });
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("a cancel that lands while the engine is writing a step's result is not lost: the engine's write fails on the raised revision and the run ends CANCELLED", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    let cancelled = false;
    // The engine has read the run when it keeps the step's report; the person cancels at that moment.
    const hooked = { ...deps, agentRuns: { ...deps.agentRuns!, saveReport: async () => {
      if (!cancelled) { cancelled = true; expect((await cancelRoute(t, run.taskId)).status).toBe(200); }
      return undefined;
    } } } as ApprovalDependencies;
    await onAgentStepFinished(hooked, { taskId: run.taskId, operationId: first.id, outcome: "SUCCEEDED", report: "Found it." });
    expect(cancelled).toBe(true);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("a decision for a step that has nothing more to be told still ends a cancelled run instead of completing it", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    const last = t.stepOps(run.workspaceId)[1]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "report", operationId: last.id, summary: "comment on LIN-12" });
    // The step has been handed outcomes four times already: a fifth is not made, so a decision would complete the run.
    const item = t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN") as Record<string, unknown> & { steps: Array<{ id: string; operationIds: string[] }> };
    t.db.set({ ...item, steps: item.steps.map((step) => (step.id === "report" ? { ...step, operationIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), last.id] } : step)) });
    await t.finishStep(run, last.id, "Report.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await recordIntent(t, run.taskId);
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
  });

  it("an approval step that is the last step does not complete a cancelled run when it is approved", async () => {
    const t = await setup();
    const agentId = await t.agentOf({ instructions: "Draft, then ask.", sequence: [agentStep("draft", "Draft"), { id: "gate", name: "Ship it", kind: "approval" as const, prompt: "Send the report?" }] });
    const run = await t.start(agentId);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    const [approvalId] = t.runItem(run.taskId)!.steps[1]!.approvalIds;
    await recordIntent(t, run.taskId);
    await approve(t.routeDeps(), approvalId!);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
  });

  it("a run resumed after a budget pause does not dispatch when its task was closed meanwhile", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET closedAt = :now REMOVE budgetPause", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
    expect(await advanceAgentRun(t.routeDeps(), run.taskId)).toBe("ended");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });
});

describe("Task 22 review: closing a task ends a run that waits (I1)", () => {
  async function waitingOnWrite() {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    return { t, run, first, deps, write };
  }

  it("P4: closing the task cancels the run, expires its approvals and tells the end handlers once; approving afterwards dispatches nothing", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    const events = endHandler();
    const closed = await t.call(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/close`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const closeOperation = t.operations(run.workspaceId).find((operation) => operation.kind === "close")!;
    await t.finish(run.workspaceId, closeOperation.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(t.meta(run.taskId)).toHaveProperty("closedAt");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId as never))!.status).toBe("EXPIRED");
    expect(events).toEqual([expect.objectContaining({ taskId: run.taskId, outcome: "cancelled" })]);
    await approve(deps, write.approvalId).catch(() => undefined);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("a write decided after the task was closed (by a path that told the engine nothing) ends the run instead of continuing the step", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET closedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("the sweep ends a waiting run whose task was closed, without anyone deciding anything", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    const events = endHandler();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET closedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId as never))!.status).toBe("EXPIRED");
    expect(events).toHaveLength(1);
  });

  it("closing ends the run itself, even when the run's dispatch row is gone (nothing else would look at it)", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    await t.db.send(new DeleteCommand({ TableName: "state", Key: { pk: "WORKFLOW_DISPATCH", sk: `${run.taskId}#agent` } }));
    await t.call(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/close`, {});
    await t.finish(run.workspaceId, t.operations(run.workspaceId).find((operation) => operation.kind === "close")!.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
    expect((await getAnyApproval(deps, TEST_ORG, write.approvalId))!.status).toBe("EXPIRED");
  });

  it("a close that another call finished first still ends the run when this call finds it done", async () => {
    const { t, run, deps } = await waitingOnWrite();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET closedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
    await t.db.send(new DeleteCommand({ TableName: "state", Key: { pk: "WORKFLOW_DISPATCH", sk: `${run.taskId}#agent` } }));
    const { finishTaskClose } = await import("../../packages/broker/src/aws/developer-tasks.js");
    await finishTaskClose({ tableName: "state", actions: t.actions, documentClient: t.db, agentEngine: deps }, t.db.get(`DEVTASK#${run.taskId}`, "META") as never, undefined, []);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED", endReason: "The task was closed." });
  });
});

describe("Task 22 review: a plain task's end by the reaper or a stuck cancel blocks its keys and tells the handlers (I2)", () => {
  async function plainTurn(t: World) {
    const started = await t.call(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the bug", client: "test-client" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = t.meta(taskId);
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const turn = t.stepOps(workspaceId)[0]!;
    await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": t.invocationOf(turn.id).callbackCapability } });
    return { taskId, workspaceId, turn, key: t.access!.mintedKeys().at(-1)! };
  }
  const rowsOf = (t: World, taskId: string) => t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId);

  it("lost compute (the reaper's failActiveOperation)", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", plain.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    expect(t.access!.blockKey).not.toHaveBeenCalled();
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plain.key));
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toHaveLength(1);
  });

  it("an operation the dispatcher could not deliver (failOutboxOperation)", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === plain.turn.id)[0]!;
    const { failOutboxOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failOutboxOperation(t.db, "state", outbox as never, "RUNTIME_UNAVAILABLE: the worker could not be reached");
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plain.key));
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
  });

  it("a cancel that never finished (the stuck-cancel sweep)", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    await t.call(MAYA, "POST", `/v1/dev/tasks/${plain.taskId}/cancel`, {});
    const { sweepStuckCancels } = await import("../../packages/broker/src/aws/stuck-cancels.js");
    const swept = await sweepStuckCancels({ client: t.db, tableName: "state" }, [{ workspaceId: plain.workspaceId, compute: "gone" }], new Date(Date.now() + 31 * 60_000));
    expect(swept.ended).toEqual([plain.turn.id]);
    expect(t.access!.blockKey).not.toHaveBeenCalledWith(keyIdOf(plain.key));
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plain.key));
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
  });

  it("leaves an agent-step run to its engine: no second row, and the end is told once", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", run.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    expect(rowsOf(t, run.taskId).map((row) => row.sk)).toEqual([`${run.taskId}#agent`]);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toHaveLength(1);
  });

  it("an operation_end row for an operation that has not ended, or that belongs to another org, blocks and tells nothing", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    const rowFor = (orgId: string) => (operationEndDispatchItem("state", { taskId: plain.taskId, orgId, workspaceId: plain.workspaceId, operationId: plain.turn.id, now: new Date().toISOString() }) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    t.db.set(rowFor(TEST_ORG));
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access!.blockKey).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
    t.db.set({ ...t.db.get(`WORKSPACE#${plain.workspaceId}`, `OPERATION#${plain.turn.id}`)!, status: "FAILED" });
    t.db.set(rowFor("org_zzzzzzzzzzzzzzzzzzzz"));
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access!.blockKey).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
  });

  // Fix round 2 (re-check N1): the end of a plain task is told until it is finished, not at most once.
  const dueNow = (t: World, taskId: string) => {
    const row = rowsOf(t, taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
  };
  const failingOnce = () => {
    const events: TaskEndEvent[] = [];
    let failures = 1;
    unregister.push(registerTaskEndHandler(async (_deps, event) => {
      if (failures > 0) { failures -= 1; throw new Error("down"); }
      events.push(event);
    }));
    return events;
  };
  const heldLease = (t: World, taskId: string, leaseUntil: number) =>
    t.db.set({ pk: `DEVTASK#${taskId}`, sk: "TASK_END", entityType: "TASK_END", orgId: TEST_ORG, outcome: "failed", at: new Date().toISOString(), handlersTold: 0, done: false, leaseUntil });

  it("N1 A: a handler that throws once is told again by the same row, which stays until the end is finished", async () => {
    const t = await setup({ proxy: true });
    const events = failingOnce();
    const plain = await plainTurn(t);
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", plain.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([]);
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plain.key));
    const row = rowsOf(t, plain.taskId)[0];
    expect(row).toMatchObject({ kind: "operation_end", attempts: 1 });
    expect(Date.parse(String(row!.nextAttemptAt))).toBeGreaterThan(Date.now());
    dueNow(t, plain.taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
    expect(t.db.get(`DEVTASK#${plain.taskId}`, "TASK_END")).toMatchObject({ done: true });
  });

  it("N1 B: an end another call is telling keeps the row, due when its lease could have run out; when the holder dies the row finishes the end", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", plain.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    heldLease(t, plain.taskId, Date.now() + 60_000);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([]);
    const row = rowsOf(t, plain.taskId)[0];
    expect(row).toBeDefined();
    expect(Date.parse(String(row!.nextAttemptAt))).toBeGreaterThan(Date.now() + 30_000);
    // The holder died: its lease runs out, and the row is looked at again.
    t.db.set({ ...t.db.get(`DEVTASK#${plain.taskId}`, "TASK_END")!, leaseUntil: Date.now() - 1 });
    dueNow(t, plain.taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
  });

  it("N1 C: the broker's own result path leaves a row when telling fails, and the row finishes the end", async () => {
    const t = await setup({ proxy: true });
    const events = failingOnce();
    const plain = await plainTurn(t);
    await t.finish(plain.workspaceId, plain.turn.id, "SUCCEEDED", { result: { status: "SUCCEEDED" } });
    expect(events).toEqual([]);
    expect(rowsOf(t, plain.taskId)[0]).toMatchObject({ kind: "operation_end", operationId: plain.turn.id });
    dueNow(t, plain.taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "succeeded" })]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
  });

  it("N1 D: the broker's own result path leaves a row when another call holds the end, and finishes it once the holder is gone", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    heldLease(t, plain.taskId, Date.now() + 60_000);
    await t.finish(plain.workspaceId, plain.turn.id, "SUCCEEDED", { result: { status: "SUCCEEDED" } });
    expect(events).toEqual([]);
    const row = rowsOf(t, plain.taskId)[0];
    expect(row).toMatchObject({ kind: "operation_end" });
    expect(Date.parse(String(row!.nextAttemptAt))).toBeGreaterThan(Date.now() + 30_000);
    t.db.set({ ...t.db.get(`DEVTASK#${plain.taskId}`, "TASK_END")!, leaseUntil: Date.now() - 1 });
    dueNow(t, plain.taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toHaveLength(1);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
  });

  it("N1 E: a handler that always fails stops being tried after the row's attempts are used up, and the keys are blocked all the same", async () => {
    const t = await setup({ proxy: true });
    unregister.push(registerTaskEndHandler(async () => { throw new Error("down for good"); }));
    const plain = await plainTurn(t);
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", plain.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    for (let round = 0; round < 12 && rowsOf(t, plain.taskId).length > 0; round += 1) {
      dueNow(t, plain.taskId);
      await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    }
    expect(rowsOf(t, plain.taskId)).toEqual([]);
    expect(t.access!.blockKey).toHaveBeenCalledWith(keyIdOf(plain.key));
  });

  it("N1 F: a task record that cannot be read when the end is told leaves the row for another try", async () => {
    const t = await setup({ proxy: true });
    const events = endHandler();
    const plain = await plainTurn(t);
    const { failActiveOperation } = await import("../../packages/broker/src/aws/outbox-failure.js");
    await failActiveOperation(t.db, "state", plain.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost");
    const original = t.db.send.bind(t.db);
    let down = true;
    t.db.send = (async (command: { constructor: { name: string }; input?: { Key?: { pk?: string; sk?: string } } }) => {
      if (down && command.constructor.name === "GetCommand" && command.input?.Key?.pk === `DEVTASK#${plain.taskId}` && command.input.Key.sk === "META") throw new Error("throttled");
      return original(command as never);
    });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([]);
    expect(rowsOf(t, plain.taskId)[0]).toMatchObject({ kind: "operation_end", attempts: 1 });
    down = false;
    dueNow(t, plain.taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(events).toEqual([expect.objectContaining({ taskId: plain.taskId, outcome: "failed" })]);
    expect(rowsOf(t, plain.taskId)).toEqual([]);
  });
});

describe("Task 22 review: a late handler_gave_up never fails a run that moved on (I3)", () => {
  async function waitingOnWrite() {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    await t.finishStep(run, first.id, "Waiting.");
    return { t, run, first, deps, write };
  }

  it("P6: after the approval was decided and the step continued, the hook changes nothing", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING" });
    const continuation = t.stepOps(run.workspaceId)[1]!;
    await onApprovalGaveUp(deps, (await getAnyApproval(deps, TEST_ORG, write.approvalId))!);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING" });
    expect(t.stepOps(run.workspaceId)[1]).toMatchObject({ id: continuation.id, status: expect.not.stringMatching(/^CANCEL/u) as string });
    expect(t.operations(run.workspaceId).filter((operation) => operation.kind === "cancel")).toEqual([]);
  });

  it("still fails a run that really waits on the approval, with the reason the owner reads", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    await onApprovalGaveUp(deps, (await getAnyApproval(deps, TEST_ORG, write.approvalId))!);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason).toContain("couldn't continue this run");
  });

  it("an approval of a step the run is not waiting on changes nothing", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    const other = await askWrite(t, deps, { taskId: run.taskId, stepId: "report", operationId: t.stepOps(run.workspaceId)[0]!.id, summary: "comment on LIN-13" });
    await onApprovalGaveUp(deps, other);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    void write;
  });

  it("ending a run whose step is still running asks the worker to stop that step (giveUpAgentRun, the engine's own ends)", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    await giveUpAgentRun(t.routeDeps(), run.taskId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.stepOps(run.workspaceId)[0]).toMatchObject({ id: first.id, status: "CANCEL_REQUESTED" });
    expect(t.operations(run.workspaceId).filter((operation) => operation.kind === "cancel")).toHaveLength(1);
  });

  it("a run that ends because its step ended asks for no stop", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: "the model gave up" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.operations(run.workspaceId).filter((operation) => operation.kind === "cancel")).toEqual([]);
  });

  it("an approval that was already handed back to the model belongs to an earlier round: its late hook does not fail a run that waits on the next one", async () => {
    const { t, run, deps, write } = await waitingOnWrite();
    await approve(deps, write.approvalId);
    const continuation = t.stepOps(run.workspaceId)[1]!;
    const second = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: continuation.id, summary: "comment on LIN-13" });
    await t.finishStep(run, continuation.id, "More to approve.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await onApprovalGaveUp(deps, (await getAnyApproval(deps, TEST_ORG, write.approvalId))!);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await onApprovalGaveUp(deps, (await getAnyApproval(deps, TEST_ORG, second.approvalId))!);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
  });
});

describe("Task 22 review: the end is finished by whoever is left when a call stops (I4)", () => {
  it("keeps the dispatch row while another call holds the end's lease, and tells the handlers once when it is free", async () => {
    const clock = { now: Date.now() };
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    // Another call (its process about to die) holds the lease on the end.
    t.db.set({ pk: `DEVTASK#${run.taskId}`, sk: "TASK_END", entityType: "TASK_END", orgId: TEST_ORG, outcome: "cancelled", at: new Date().toISOString(), handlersTold: 0, done: false, leaseUntil: clock.now + 60_000 });
    const deps = t.routeDeps(clock);
    expect(await cancelAgentRun(deps, run.taskId)).toBe(true);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "CANCELLED" });
    expect(events).toEqual([]);
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0];
    expect(row).toBeDefined();
    expect(Date.parse(String(row!.nextAttemptAt))).toBeGreaterThan(clock.now + 30_000);
    // The lease runs out; the row's next look finishes the end.
    clock.now += 61_000;
    expect(await driveAgentRun(deps, run.taskId)).toBe("DONE");
    expect(events).toEqual([expect.objectContaining({ taskId: run.taskId, outcome: "cancelled" })]);
    expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toEqual([]);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "TASK_END")).toMatchObject({ done: true });
  });
});

describe("Task 22 review: one gate for every dispatch (M1), the step's pending counter (M2), the branch (M3) and a resumed step (M7)", () => {
  async function waitingOnWrite() {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    return { t, run, first, deps, write };
  }

  it("M1: a continuation checks the creator and the recipe like every other dispatch", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await t.finishStep(run, first.id, "Waiting.");
    const requireCreator = vi.fn(async () => undefined);
    const requireRecipeAllowed = vi.fn(async () => undefined);
    const spied = { ...deps, agentRuns: { ...deps.agentRuns!, requireCreator, requireRecipeAllowed } } as ApprovalDependencies;
    await approve(spied, write.approvalId);
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(requireCreator).toHaveBeenCalled();
    expect(requireRecipeAllowed).toHaveBeenCalled();
  });

  it("M1: a continuation whose recipe is refused ends the run with the refusal's words and dispatches nothing", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await t.finishStep(run, first.id, "Waiting.");
    const refusing = { ...deps, agentRuns: { ...deps.agentRuns!, requireRecipeAllowed: async () => { throw agentXError("MODEL_NOT_ALLOWED", "the model is no longer allowed here"); } } } as ApprovalDependencies;
    await approve(refusing, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED", endReason: "the model is no longer allowed here" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("M2: a step whose approval counter says one is still pending waits, even if no approval record is found", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    t.db.set({ pk: orgScoped(TEST_ORG, `STEP_APPROVALS#${run.taskId}`), sk: "investigate", pending: 1 });
    await t.finishStep(run, first.id, "Report.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL", steps: [{ id: "investigate", status: "waiting" }, { id: "report", status: "pending" }] });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    // The counter reaching zero lets the sweep take the step on.
    t.db.set({ pk: orgScoped(TEST_ORG, `STEP_APPROVALS#${run.taskId}`), sk: "investigate", pending: 0 });
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.stepOps(run.workspaceId)[1]).toMatchObject({ programStepId: "report" });
  });

  it("M3: the branch the last step chose is kept while it waits, and used when its outcomes are not handed back again", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const run = await startWithContract(t, contract);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    const last = t.stepOps(run.workspaceId)[1]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "report", operationId: last.id, summary: "comment on LIN-12" });
    // The step has already been handed outcomes four times: a fifth is not made.
    const item = t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN") as Record<string, unknown> & { steps: Array<{ id: string; operationIds: string[] }> };
    t.db.set({ ...item, steps: item.steps.map((step) => (step.id === "report" ? { ...step, operationIds: ["a", "b", "c", "d", last.id].map((id) => (id.length === 1 ? randomUUID() : id)) } : step)) });
    await t.finishStep(run, last.id, "Needs a fix.", { branch: "fix", reason: "the retry is gone" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE", branch: "fix" });
  });

  it("M7: a step run again after a budget pause is told what came of the writes it asked for the first time", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, first.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
    await approve(deps, write.approvalId);
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "REMOVE budgetPause" }));
    await advanceAgentRun(deps, run.taskId);
    const rerun = t.stepOps(run.workspaceId)[1]!;
    expect(rerun).toMatchObject({ programStepId: "investigate" });
    expect(t.invocationOf(rerun.id).payload.agentStep!.inputs).toContain("Outcomes of the actions that needed approval:\nApproved and done: comment on LIN-12");
    // It is told once: the rerun's own end moves the run on without another continuation.
    await t.finishStep(run, rerun.id, "Done after the comment.");
    expect(t.stepOps(run.workspaceId)).toHaveLength(3);
    expect(t.stepOps(run.workspaceId)[2]).toMatchObject({ programStepId: "report" });
  });

  it("M7: a step run again is told only the writes that were decided, not the ones still waiting", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-13" });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, first.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    await approve(deps, write.approvalId);
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "REMOVE budgetPause" }));
    await advanceAgentRun(deps, run.taskId);
    const inputs = t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs;
    expect(inputs).toContain("Approved and done: comment on LIN-12");
    expect(inputs).not.toContain("LIN-13");
  });

  it("M2: a step the counter still holds is not taken on when another of its approvals is decided", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await t.finishStep(run, first.id, "Waiting.");
    const counter = { pk: orgScoped(TEST_ORG, `STEP_APPROVALS#${run.taskId}`), sk: "investigate" };
    t.db.set({ ...counter, pending: 2 });
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    // The counter reaching zero lets the sweep take the step on, with the outcome it knows.
    t.db.set({ ...counter, pending: 0 });
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.invocationOf(t.stepOps(run.workspaceId)[1]!.id).payload.agentStep!.inputs).toContain("Approved and done: comment on LIN-12");
  });

  it("an approval step whose record is gone is never taken for decided by the sweep", async () => {
    const t = await setup();
    const agentId = await t.agentOf(WITH_GATE);
    const run = await t.start(agentId);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The draft.");
    const [approvalId] = t.runItem(run.taskId)!.steps[1]!.approvalIds;
    await t.db.send(new DeleteCommand({ TableName: "state", Key: approvalKey(TEST_ORG, approvalId as never) }));
    const row = t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)[0]!;
    t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "WAITING_FOR_APPROVAL" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("M3: the branch of the first report is not carried over to a continuation's own report", async () => {
    const t = await setup();
    const contract = { branches: [{ id: "fix", description: "A fix is needed" }, { id: "close", description: "Nothing to do" }] };
    const run = await startWithContract(t, contract);
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Looked.");
    const last = t.stepOps(run.workspaceId)[1]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "report", operationId: last.id, summary: "comment on LIN-12" });
    await t.finishStep(run, last.id, "Needs a fix.", { branch: "fix" });
    await approve(deps, write.approvalId);
    const continuation = t.stepOps(run.workspaceId)[2]!;
    expect(continuation).toMatchObject({ programStepId: "report" });
    await t.finishStep(run, continuation.id, "Done after the comment.");
    expect(t.runItem(run.taskId)).toMatchObject({ state: "COMPLETE" });
    expect(t.runItem(run.taskId)!.branch).toBeUndefined();
  });

  it("M7: a continuation that was cut by the budget is run again with the outcomes it had been told, since the new run starts from the request alone", async () => {
    const { t, run, first, deps, write } = await waitingOnWrite();
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId);
    const continuation = t.stepOps(run.workspaceId)[1]!;
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, continuation.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "REMOVE budgetPause" }));
    await advanceAgentRun(deps, run.taskId);
    const rerun = t.stepOps(run.workspaceId)[2]!;
    expect(t.invocationOf(rerun.id).payload.agentStep!.inputs).toContain("Approved and done: comment on LIN-12");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plan 3 final fix wave, runs I-1: a budget stop with no pause written yet (the proxy's mid-step "budget exceeded") is told with its real scope, once.
// None of these tests sets `budgetPause` before the step's result: that is the real path.
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("final fix wave, runs I-1: a budget stop the broker has not turned into a pause yet", () => {
  const META = (taskId: string) => ({ TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "META" } });
  const eventsOf = (t: World, taskId: string) => t.taskEvents(taskId).map((item) => String(item.text));
  const rows = (t: World, taskId: string) => t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId);
  const requests = (t: World) => t.db.find((item) => item.entityType === "SPEND_REQUEST");

  /** A run whose first step is running, whose keys have spent `spent` of a $5 run limit (and `maxPerRun` when given). */
  async function running(options: { spent: number; maxPerRun?: number }) {
    const t = await setup({ proxy: true });
    const paused = pauseHandler();
    const ended = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const key = "sk-step-key";
    await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET modelKeyIds = :keys, budgetUsd = :limit" + (options.maxPerRun === undefined ? "" : ", maxPerRunUsd = :max"),
      ExpressionAttributeValues: { ":keys": [keyIdOf(key)], ":limit": 5, ...(options.maxPerRun === undefined ? {} : { ":max": options.maxPerRun }) } }));
    t.access!.setKeySpent(key, options.spent);
    return { t, run, paused, ended, first: t.stepOps(run.workspaceId)[0]! };
  }
  const stop = (t: World, run: { workspaceId: string }, operationId: string) => t.finish(run.workspaceId, operationId, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });

  it("tells the real scope once (the run limit the ledger shows was reached), asks for it once, and neither resumes nor dispatches the step again", async () => {
    const { t, run, paused, ended, first } = await running({ spent: 6 });
    await stop(t, run, first.id);
    const scope = { kind: "task", taskId: run.taskId };
    expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET", pause: { scope, notifiedAt: expect.any(String) as string } });
    expect(t.runItem(run.taskId)!.pause).not.toHaveProperty("unconfirmed");
    expect(paused).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope }]);
    expect(ended).toEqual([]);
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(eventsOf(t, run.taskId).filter((text) => text.includes("budget was raised"))).toEqual([]);
    expect(requests(t)).toHaveLength(1);
    expect(requests(t)[0]).toMatchObject({ kind: "run_limit", taskId: run.taskId, status: "PENDING" });
    // The sweep finds nothing more to tell.
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(paused).toHaveLength(1);
    expect(requests(t)).toHaveLength(1);
  });

  it("tells a max per run as a max per run when that is the lower stop", async () => {
    const { t, run, paused, first } = await running({ spent: 3, maxPerRun: 2 });
    await stop(t, run, first.id);
    expect(paused).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope: { kind: "max_per_run", taskId: run.taskId } }]);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
  });

  it("an approval that answered the stop before its result was driven resumes the step, and tells no pause", async () => {
    const { t, run, paused, first } = await running({ spent: 6 });
    // The refusal wrote a pause and an approval cleared it before the result arrived: nothing but `budgetStopOf` is left of it.
    await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET budgetStopOf = :operation", ExpressionAttributeValues: { ":operation": first.id } }));
    await stop(t, run, first.id);
    expect(paused).toEqual([]);
    expect(requests(t)).toEqual([]);
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.stepOps(run.workspaceId)[1]).toMatchObject({ programStepId: "investigate" });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ id: "investigate", status: "running" }, { id: "report", status: "pending" }] });
    expect(t.runItem(run.taskId)!.pause).toBeUndefined();
    expect(eventsOf(t, run.taskId).filter((text) => text.includes("budget was raised"))).toHaveLength(1);
    // It was never a pause: the run was not shown as paused at all.
    expect(eventsOf(t, run.taskId).filter((text) => text.includes("The run is paused"))).toEqual([]);
  });

  describe("no pause could be worked out (the ledger says spend is just under the stop)", () => {
    it("keeps the run waiting without telling a made-up scope, keeps its row due in about two minutes, and never resumes the step meanwhile", async () => {
      const { t, run, paused, ended, first } = await running({ spent: 0.5 });
      const before = Date.now();
      await stop(t, run, first.id);
      expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET", pause: { unconfirmed: true, operationId: first.id }, steps: [{ id: "investigate", status: "pending" }, { id: "report", status: "pending" }] });
      expect(paused).toEqual([]);
      expect(ended).toEqual([]);
      expect(t.stepOps(run.workspaceId)).toHaveLength(1);
      expect(rows(t, run.taskId)).toHaveLength(1);
      const due = Date.parse(String(rows(t, run.taskId)[0]!.nextAttemptAt));
      expect(due).toBeGreaterThan(before + 60_000);
      expect(due).toBeLessThan(before + 5 * 60_000);
      // Advancing does not resume it either: no pause was ever told.
      await advanceAgentRun(t.routeDeps(), run.taskId);
      expect(t.stepOps(run.workspaceId)).toHaveLength(1);
      expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
    });

    it("ends FAILED with the budget words once the bounded wait is over, and tells the end handlers (not the pause handlers)", async () => {
      const { t, run, paused, ended, first } = await running({ spent: 0.5 });
      await stop(t, run, first.id);
      // Looked at again after a few minutes: still waiting, the row is armed again.
      expect(await driveAgentRun(t.routeDeps({ now: Date.now() + 3 * 60_000 }), run.taskId)).toBe("WAIT");
      expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
      expect(rows(t, run.taskId)).toHaveLength(1);
      expect(await driveAgentRun(t.routeDeps({ now: Date.now() + 11 * 60_000 }), run.taskId)).toBe("DONE");
      expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
      expect(t.runItem(run.taskId)!.endReason).toMatch(/budget/iu);
      expect(paused).toEqual([]);
      expect(ended).toEqual([expect.objectContaining({ taskId: run.taskId, outcome: "failed" })]);
      expect(rows(t, run.taskId)).toEqual([]);
    });

    it("tells the pause that appears while it waits, with its real scope, once, and still waits for the approval", async () => {
      const { t, run, paused, first } = await running({ spent: 0.5 });
      await stop(t, run, first.id);
      const scope = { kind: "max_per_run", taskId: run.taskId };
      await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET budgetPause = :pause, budgetStopOf = :operation", ExpressionAttributeValues: { ":pause": { scope, at: new Date().toISOString() }, ":operation": first.id } }));
      await driveAgentRun(t.routeDeps(), run.taskId);
      expect(paused).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope }]);
      expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET", pause: { scope, notifiedAt: expect.any(String) as string } });
      await driveAgentRun(t.routeDeps(), run.taskId);
      expect(paused).toHaveLength(1);
      expect(t.stepOps(run.workspaceId)).toHaveLength(1);
      // The approval clears the pause: now the step runs again, once.
      await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "REMOVE budgetPause" }));
      await advanceAgentRun(t.routeDeps(), run.taskId);
      expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    });

    it("asks for the pause again when it looks (the broker's own ask may have failed), and tells what that wrote", async () => {
      const { t, run, paused, first } = await running({ spent: 0.5 });
      await stop(t, run, first.id);
      const scope = { kind: "task", taskId: run.taskId };
      const deps = t.routeDeps();
      const askForPause = vi.fn(async (_task: unknown, operationId: string) => {
        await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET budgetPause = :pause, budgetStopOf = :operation", ExpressionAttributeValues: { ":pause": { scope, at: new Date().toISOString() }, ":operation": operationId } }));
      });
      await driveAgentRun({ ...deps, agentRuns: { ...deps.agentRuns!, askForPause } }, run.taskId);
      expect(askForPause).toHaveBeenCalledExactlyOnceWith(expect.anything(), first.id);
      expect(paused).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope }]);
      expect(t.runItem(run.taskId)).toMatchObject({ state: "PAUSED_BUDGET", pause: { scope, notifiedAt: expect.any(String) as string } });
    });

    it("resumes silently when the stop was answered meanwhile (its pause was approved away and `budgetStopOf` names the operation)", async () => {
      const { t, run, paused, first } = await running({ spent: 0.5 });
      await stop(t, run, first.id);
      await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET budgetStopOf = :operation", ExpressionAttributeValues: { ":operation": first.id } }));
      await driveAgentRun(t.routeDeps(), run.taskId);
      expect(paused).toEqual([]);
      expect(t.stepOps(run.workspaceId)).toHaveLength(2);
      expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING" });
    });
  });

  it("a pause that was never told (its handler is down) is told before the step runs again, and an approval that raced it resumes without a tell", async () => {
    const t = await setup();
    let down = true;
    const heard: TaskPauseEvent[] = [];
    unregister.push(registerTaskPauseHandler(async (_deps, event) => { if (down) throw new Error("down"); heard.push(event); }));
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const scope = { kind: "task", taskId: run.taskId };
    await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "SET budgetPause = :pause", ExpressionAttributeValues: { ":pause": { scope, at: new Date().toISOString() } } }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(heard).toEqual([]);
    // The pause is lifted before anyone heard it, with no record that it answered this operation: the handlers hear it, then the step runs again.
    await t.db.send(new UpdateCommand({ ...META(run.taskId), UpdateExpression: "REMOVE budgetPause" }));
    down = false;
    await advanceAgentRun(t.routeDeps(), run.taskId);
    expect(heard).toEqual([{ orgId: TEST_ORG, taskId: run.taskId, scope }]);
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
  });
});

describe("final fix wave, runs minors: the dispatch row, the stop of a step, and the continuation allowance", () => {
  const rowOf = (t: World, taskId: string) => t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)[0];

  it("m4: finishing an end does not delete a row a newer write made", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    expect(await cancelAgentRun(t.routeDeps(), run.taskId)).toBe(true);
    expect(rowOf(t, run.taskId)).toBeUndefined();
    // The end's own row is back (its follow-up was owed); a newer write (a resume or a result of another process) replaces it just before the end deletes it.
    const row = (revision: number) => (agentRunDispatchItem("state", { taskId: run.taskId, orgId: TEST_ORG, revision, dueAt: "2026-10-22T00:00:00.000Z", now: "2026-10-22T00:00:00.000Z" }) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    t.db.set(row(1));
    const racing = { ...t.routeDeps(), documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "DeleteCommand") t.db.set(row(999));
      return t.db.send(command as never);
    } } };
    await cancelAgentRun(racing, run.taskId);
    expect(rowOf(t, run.taskId)).toMatchObject({ workflowRevision: 999 });
    // And an unraced one is deleted, as before.
    t.db.set(row(1));
    await cancelAgentRun(t.routeDeps(), run.taskId);
    expect(rowOf(t, run.taskId)).toBeUndefined();
  });

  it("m4: a rearm made from an older look leaves a newer row alone", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const newer = { ...rowOf(t, run.taskId)!, workflowRevision: 999, nextAttemptAt: "2026-10-22T00:00:00.000Z", dispatchDueSk: `2026-10-22T00:00:00.000Z#${String(rowOf(t, run.taskId)!.sk)}` };
    const racing = { ...t.routeDeps(), documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "PutCommand" && (command as unknown as { input: { Item: { kind?: string } } }).input.Item.kind === "agent_run") t.db.set(newer);
      return t.db.send(command as never);
    } } };
    await driveAgentRun(racing, run.taskId);
    expect(rowOf(t, run.taskId)).toMatchObject({ workflowRevision: 999, nextAttemptAt: "2026-10-22T00:00:00.000Z" });
  });

  it("m5: an end whose stop of the running step failed leaves its row, and the sweep's finishEnd stops the step again", async () => {
    const t = await setup();
    const stopOperation = vi.fn<(task: unknown, operationId: string) => Promise<void>>(async () => { throw new Error("worker unreachable"); });
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const spied = { ...deps, agentRuns: { ...deps.agentRuns!, stopOperation } } as ApprovalDependencies;
    expect(await cancelAgentRun(spied, run.taskId)).toBe(true);
    expect(stopOperation).toHaveBeenCalledTimes(1);
    expect(stopOperation).toHaveBeenLastCalledWith(expect.anything(), first.id);
    expect(rowOf(t, run.taskId)).toBeDefined();
    // The process that ended the run died (here: its stop failed); the sweep's finishEnd asks again.
    stopOperation.mockImplementation(async () => undefined);
    await driveAgentRun(spied, run.taskId);
    expect(stopOperation).toHaveBeenCalledTimes(2);
    expect(stopOperation).toHaveBeenLastCalledWith(expect.anything(), first.id);
    expect(rowOf(t, run.taskId)).toBeUndefined();
  });

  it("m6: reruns after a budget pause do not use up the continuation allowance", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const first = t.stepOps(run.workspaceId)[0]!;
    const deps = t.routeDeps();
    const write = await askWrite(t, deps, { taskId: run.taskId, stepId: "investigate", operationId: first.id, summary: "comment on LIN-12" });
    // Four budget-pause reruns have used four operations; none of them was a continuation.
    const item = t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN") as Record<string, unknown> & { steps: Array<{ id: string; operationIds: string[] }> };
    t.db.set({ ...item, steps: item.steps.map((step) => (step.id === "investigate" ? { ...step, operationIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), first.id], continuations: 0 } : step)) });
    await t.finishStep(run, first.id, "Waiting.");
    await approve(deps, write.approvalId);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ id: "investigate", status: "running", continuations: 1 }, { id: "report", status: "pending" }] });
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Grounding: a report that nothing backs never counts as a success (staging 0.4.6, crn_6o18spb2tfbe8147c40j)
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("an unverified report", () => {
  const FABRICATED = "I'll look up the pull request.\n<tool_call>{\"name\":\"github_list_prs\"}</tool_call>\nFound it: PR #5, merged. healthy";
  const UNVERIFIED = {
    verdict: "unverified", tools: { calls: 0, failed: 0, failures: [] },
    reasons: ["The report contains tool calls or tool answers written as text. A tool call exists only when the agent calls the tool, so none of it happened.", "The report cites pull request #5, which no tool returned and the request did not contain."],
  };

  it("ends the run FAILED with the reasons, keeps the report for a person, starts no further step and tells the end handlers it failed (never succeeded)", async () => {
    const t = await setup();
    const events = endHandler();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, FABRICATED, { grounding: UNVERIFIED });
    const item = t.runItem(run.taskId)!;
    expect(item.state).toBe("FAILED");
    expect(item.endReason!.startsWith(UNVERIFIED_END_PREFIX)).toBe(true);
    expect(item.endReason).toContain("pull request #5");
    expect(item.finalReport).toBe(FABRICATED);
    expect(item.steps[0]).toMatchObject({ status: "failed", unverified: UNVERIFIED.reasons });
    expect(t.stepOps(run.workspaceId)).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ outcome: "failed", taskId: run.taskId, finalReport: FABRICATED })]);
    expect(t.meta(run.taskId).releasedAt).toBeDefined();
    const view = await t.view(MAYA, run.taskId);
    expect(view.status).toBe("FAILED");
    expect(view.run).toMatchObject({ state: "FAILED", finalReport: FABRICATED, steps: [{ id: "investigate", status: "failed", report: FABRICATED, unverified: UNVERIFIED.reasons }, { id: "report", status: "pending" }] });
    expect(view.run.endReason).toMatch(/^Unverified, needs a person: /);
    // Every client reads the view through its schema: the new fields are part of it.
    expect(DeveloperTaskRunViewSchema.parse(view.run).steps[0]).toMatchObject({ unverified: UNVERIFIED.reasons });
  });

  it("fails the run on the last step too: the end of the run is where success was granted before", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "healthy", { grounding: UNVERIFIED });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED", finalReport: "healthy", steps: [{ status: "done" }, { status: "failed", unverified: UNVERIFIED.reasons }] });
    expect((await t.view(MAYA, run.taskId)).status).toBe("FAILED");
  });

  it("records the tools that failed on the step and shows them with the run's result, while a grounded run goes on", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    const tools = { calls: 3, failed: 1, failures: [{ tool: "ls", message: "Cannot read directory: permission" }] };
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "The service has three routes.", { grounding: { verdict: "grounded", reasons: [], tools } });
    expect(t.stepOps(run.workspaceId)).toHaveLength(2);
    expect(t.runItem(run.taskId)).toMatchObject({ state: "RUNNING", steps: [{ status: "done", tools }, { status: "running" }] });
    expect(t.runItem(run.taskId)!.steps[0]).not.toHaveProperty("unverified");
    const view = await t.view(MAYA, run.taskId);
    expect(view.run.steps[0]).toMatchObject({ id: "investigate", tools });
    expect(DeveloperTaskRunViewSchema.parse(view.run).steps[0]).toMatchObject({ tools });
  });

  it("treats a grounding the broker cannot read as unverified, never as a success", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Fine.", { grounding: { verdict: "grounded", surprise: true } });
    expect(t.runItem(run.taskId)).toMatchObject({ state: "FAILED" });
    expect(t.runItem(run.taskId)!.endReason!.startsWith(UNVERIFIED_END_PREFIX)).toBe(true);
  });

  it("reads a grounding tolerantly: a field a newer worker adds is ignored, a clean verdict from a worker that checks changes nothing", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "Fine.", { grounding: { verdict: "grounded", reasons: [], tools: { calls: 4, failed: 0, failures: [], newer: 1 }, checkedBy: "v2" } });
    const item = t.runItem(run.taskId)!;
    expect(item.state).toBe("RUNNING");
    expect(item.steps[0]).toMatchObject({ status: "done" });
    expect(item.steps[0]).not.toHaveProperty("tools");
    expect(item.steps[0]).not.toHaveProperty("unverified");
    const view = await t.view(MAYA, run.taskId);
    expect(view.run.steps[0]).not.toHaveProperty("tools");
  });

  it("parses a view whose step carries a field this build does not know (a newer broker), and a view without tools or unverified (an older one)", () => {
    const base = { state: "RUNNING", pendingApprovals: [] };
    expect(DeveloperTaskRunViewSchema.parse({ ...base, steps: [{ id: "investigate", name: "Investigate", status: "done", report: "x", futureField: 1 }] }).steps[0]).toEqual({ id: "investigate", name: "Investigate", status: "done", report: "x" });
    expect(DeveloperTaskRunViewSchema.parse({ ...base, steps: [{ id: "investigate", name: "Investigate", status: "running" }] }).steps[0]).not.toHaveProperty("tools");
  });

  it("changes nothing for a step with no grounding in its result (an older worker, or a clean run)", async () => {
    const t = await setup();
    const run = await t.start("root-cause-analyst");
    await run.finishPrepare();
    await t.finishStep(run, t.stepOps(run.workspaceId)[0]!.id, "One.");
    await t.finishStep(run, t.stepOps(run.workspaceId)[1]!.id, "Two.");
    const item = t.runItem(run.taskId)!;
    expect(item).toMatchObject({ state: "COMPLETE", finalReport: "Two." });
    expect(item.steps[0]).not.toHaveProperty("tools");
    expect(item.steps[0]).not.toHaveProperty("unverified");
  });
});
