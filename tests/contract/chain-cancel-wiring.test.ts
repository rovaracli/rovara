// Plan 4 Task 9: the cancel port, through the real broker. A chain stops a step's task with Plan 3's own cancel, as the task's owner (the same path as the owner's cancel
// button): the worker is asked to stop, the task's end comes back through the end handlers, and a repeat of the request is the same cancel.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { registerTaskEndHandler, type TaskEndEvent } from "../../packages/broker/src/agents/task-end.js";
import { chainRunPortsFor } from "../../packages/broker/src/chains/runner.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { openChainRunKey } from "@rovara-code/contracts";
import { loadSlackBroker } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const CHAIN = { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "look" };

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const unregister: Array<() => void> = [];
afterEach(() => {
  while (unregister.length > 0) unregister.pop()!();
});

async function startedStep() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const starter = createAgentRunStarter(h.brokerInput as never)!;
  const ended: TaskEndEvent[] = [];
  unregister.push(registerTaskEndHandler(async (_deps, event) => { ended.push(event); }));
  const started = await startAgentRun(starter, {
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "root-cause-analyst" }, input: { text: "Why did checkout fail?" }, origin: "chain",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, chain: CHAIN,
  });
  const meta = h.db.get(`DEVTASK#${started.taskId}`, "META") as Record<string, unknown> & { workspaceId: string };
  const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${meta.workspaceId}` && item.entityType === "OPERATION") as Array<Record<string, unknown> & { id: string; kind: string; status: string }>;
  const prepare = operations().find((operation) => operation.kind === "prepare")!;
  await h.finish(meta.workspaceId, prepare.id, "SUCCEEDED", PREPARED);
  const runState = () => (h.db.get(`DEVTASK#${started.taskId}`, "AGENT_RUN") as { state: string });
  return { h, starter, ended, taskId: started.taskId, meta, operations, runState, ports: chainRunPortsFor(starter) };
}

describe("the chain's cancel port, through Plan 3's cancel", () => {
  it("asks the worker to stop the step as the task's owner, and the cancel's result ends the task through the end handlers, once", async () => {
    const t = await startedStep();
    const requestId = randomUUID();
    await t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: MAYA.developerId }, requestId });
    const cancel = t.operations().find((operation) => operation.kind === "cancel");
    expect(cancel).toBeDefined();
    expect(t.runState()).toMatchObject({ state: "RUNNING" });
    // The same request again is the same cancel: no second one is asked for.
    await t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: MAYA.developerId }, requestId });
    expect(t.operations().filter((operation) => operation.kind === "cancel")).toHaveLength(1);
    // It is the owner's own request that was made, under the id the chain gave.
    expect(t.h.db.find((item) => item.sk === `REQUEST#${requestId}`)).toHaveLength(1);
    // Where the chain finds that its cancel was taken (the runner's step-timeout check): beside the task's owner key and workspace.
    expect(t.h.db.get(`IDEMPOTENCY#${String(t.meta["ownerKey"])}#${t.meta.workspaceId}`, `REQUEST#${requestId}`)).toMatchObject({ action: "cancel" });
    await t.h.finish(t.meta.workspaceId, cancel!.id, "SUCCEEDED");
    expect(t.runState()).toMatchObject({ state: "CANCELLED" });
    expect(t.ended).toEqual([expect.objectContaining({ outcome: "cancelled", taskId: t.taskId, chain: CHAIN })]);
  });

  it("leaves a task that is already over alone", async () => {
    const t = await startedStep();
    const first = randomUUID();
    await t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: MAYA.developerId }, requestId: first });
    await t.h.finish(t.meta.workspaceId, t.operations().find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
    const before = t.operations().length;
    await expect(t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: MAYA.developerId }, requestId: randomUUID() })).resolves.toBeUndefined();
    expect(t.operations().filter((operation) => operation.kind === "cancel").length).toBeLessThanOrEqual(before);
    expect(t.ended).toHaveLength(1);
  });

  it("does nothing for an owner who is no longer a member of the org", async () => {
    const t = await startedStep();
    await expect(t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: "9".repeat(64) }, requestId: randomUUID() })).resolves.toBeUndefined();
    expect(t.operations().find((operation) => operation.kind === "cancel")).toBeUndefined();
    expect(t.runState()).toMatchObject({ state: "RUNNING" });
  });

  it("never cancels another person's task: the cancel is the owner's, so a task that is not theirs is refused as not found", async () => {
    const t = await startedStep();
    const other = "e".repeat(64);
    const answer = await t.ports.cancelTask({ orgId: TEST_ORG, taskId: t.taskId, owner: { developerId: other }, requestId: randomUUID() }).then(() => "answered", (error: { code?: string }) => error.code ?? "error");
    // Plan 3 refuses someone who is not the task's own: the task keeps running.
    expect(answer).toBe("TASK_NOT_FOUND");
    expect(t.operations().find((operation) => operation.kind === "cancel")).toBeUndefined();
    expect(t.runState()).toMatchObject({ state: "RUNNING" });
  });
});

describe("the chain sweep, through the deployed broker's handler", () => {
  const event = { source: "agentx.chain-sweep" };
  /** The answer without the envelope's own request id. */
  const bodyOf = (reply: unknown) => {
    const { requestId: _requestId, ...rest } = JSON.parse((reply as { body: string }).body) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- only the envelope's id is dropped
    return rest;
  };

  it("runs the sweep with the broker's own dependencies: a due item for a run that is not there is dropped and counted", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const due = openChainRunKey(new Date(Date.now() - 60_000).toISOString(), TEST_ORG, "crn_aaaaaaaaaaaaaaaaaaaa");
    h.db.set({ ...due, entityType: "OPEN_CHAIN_RUN", orgId: TEST_ORG, runId: "crn_aaaaaaaaaaaaaaaaaaaa" });
    const reply = await h.handler(event);
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(bodyOf(reply)).toEqual({ examined: 1, failed: 0 });
    expect(h.db.get(due)).toBeUndefined();
  });

  it("leaves an item that is not due yet alone", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const later = openChainRunKey(new Date(Date.now() + 3_600_000).toISOString(), TEST_ORG, "crn_aaaaaaaaaaaaaaaaaaaa");
    h.db.set({ ...later, entityType: "OPEN_CHAIN_RUN", orgId: TEST_ORG, runId: "crn_aaaaaaaaaaaaaaaaaaaa" });
    expect(bodyOf(await h.handler(event))).toEqual({ examined: 0, failed: 0 });
    expect(h.db.get(later)).toBeDefined();
  });

  it("answers 500 when the sweep can't read the open items, and drops nothing", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    h.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input).includes("OPEN_CHAIN_RUNS"), error: { name: "ProvisionedThroughputExceededException" } });
    const reply = await h.handler(event);
    expect(reply).toMatchObject({ statusCode: 500 });
    expect(bodyOf(reply)).toEqual({ error: "sweep_failed" });
  });

  it("says it was skipped where agents are not set up", async () => {
    const h = await createDeveloperTaskBroker({});
    const reply = await h.handler(event);
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(bodyOf(reply)).toEqual({ skipped: true });
  });
});
