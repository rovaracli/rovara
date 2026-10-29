// Plan 3 final fix wave (runs I-3, money I-1; owner decision 2 = A): Continue never skips an approval unless the person pressing it may decide that approval
// themselves. An agent-step run takes no free-form turn at all (the engine owns its turns); on a max-per-run, run-limit or planning pause of a run WITH an
// agent, a person's Continue, workflow retry or send-back neither resets the window, clears the pause nor withdraws the request unless `mayDecideNow` holds.
// A plain task keeps R38 as accepted (spend-requests-run "P2").
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "@agentx/contracts";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { pausedTaskGate } from "../../packages/broker/src/spend/requests.js";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { BEN, CODING, DEB, TRIAGE, refusal, setup, type World } from "../support/spend-world.js";

const PAUSED = WORKFLOW_BLOCK_REASONS.budgetPaused;

/** An agent of Maya's with a max per run of `max`, shared with Ben, whose run Ben started and which paused at its max per run (Maya's to decide, not Ben's). */
async function maxPaused(t: World, overlay: typeof TRIAGE, max = 4) {
  const agentId = await t.agentOf(overlay, { name: "Ticket looker" });
  expect((await t.setBudget(MAYA, agentId, { maxPerRunUsd: max })).status).toBe(200);
  await t.shareWith(agentId, BEN);
  const run = await t.runOf(agentId, { who: BEN });
  await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
  await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
  const request = t.requestOf(run.taskId, "max_per_run")[0]!;
  expect(request).toMatchObject({ status: "PENDING", approverIds: [MAYA.developerId] });
  return { agentId, ...run, request };
}

/** Everything a Continue, a retry or a send-back would have changed, so a refusal can be shown to have written nothing. */
const snapshot = (t: World, taskId: string, workspaceId: string, spendRequestId: string) => ({
  meta: t.meta(taskId), ops: t.taskOps(workspaceId).map((operation) => operation.id), request: t.requests().find((record) => record.spendRequestId === spendRequestId), open: t.openItems().length,
  events: t.taskEvents(taskId),
});

describe("an agent-step run takes no free-form turn (runs I-3)", () => {
  it("refuses Continue on a run paused at its max per run: the Ben and Maya scenario writes nothing", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await maxPaused(t, TRIAGE);
    const before = snapshot(t, taskId, workspaceId, request.spendRequestId);
    const continued = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/continue`, { instructions: "Go on" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(409);
    expect(continued.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("agent run") as unknown } });
    expect(snapshot(t, taskId, workspaceId, request.spendRequestId)).toEqual(before);
    expect(t.meta(taskId).budgetPause).toBeDefined();
    expect(t.db.get(`DEVTASK#${taskId}`, "AGENT_RUN")).toMatchObject({ state: "PAUSED_BUDGET" });
    // The owner's approval still resumes it.
    await t.decide(MAYA, request.spendRequestId);
    expect(t.meta(taskId).budgetPause).toBeUndefined();
    expect(t.requests().find((record) => record.spendRequestId === request.spendRequestId)).toMatchObject({ status: "APPROVED" });
  });

  it("refuses Continue from the run's owner and starter too, even while the run only waits between steps", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const run = await t.runOf(agentId);
    const before = t.taskOps(run.workspaceId).map((operation) => operation.id);
    const continued = await t.api(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/continue`, { instructions: "Go on" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(409);
    expect(t.taskOps(run.workspaceId).map((operation) => operation.id)).toEqual(before);
  });

  it("backstop: a task operation with no agentRun input for an agent_steps recipe is refused by taskOperationParts, whichever route asked", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const run = await t.runOf(agentId);
    const task = t.meta(run.taskId) as unknown as Parameters<typeof developerTaskIdentity>[0];
    // The step the engine started is finished (the workspace is idle), so only the backstop can refuse.
    const workspace = t.db.get(`WORKSPACE#${run.workspaceId}`, "META") as Record<string, unknown>;
    const { activeOperationId: _active, ...idle } = workspace; // eslint-disable-line @typescript-eslint/no-unused-vars -- taken out of the copy, not read
    t.db.set({ ...idle, status: "READY" });
    const before = t.taskOps(run.workspaceId).length;
    const refused = await refusal(t.actions.acceptTask(developerTaskIdentity(task, TEST_ORG), run.workspaceId, { requestId: randomUUID(), conversationId: t.meta(run.taskId).conversationId as string, prompt: "do something else" }, () => [], {}));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("agent run") as unknown });
    expect(t.taskOps(run.workspaceId)).toHaveLength(before);
  });
});

describe("a coding agent's max-per-run pause is not skipped by a retry or a send-back (money I-1)", () => {
  async function planBlocked(t: World) {
    const run = await maxPaused(t, CODING);
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: PAUSED });
    return run;
  }

  it("Ben's PLAN retry is refused naming who is asked; the window, the pause and the request are untouched", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await planBlocked(t);
    const before = snapshot(t, taskId, workspaceId, request.spendRequestId);
    const retried = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: before.meta.workflow!.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(409);
    expect(retried.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("Maya") as unknown } });
    expect(snapshot(t, taskId, workspaceId, request.spendRequestId)).toEqual(before);
  });

  it("Ben's retry of a blocked coding stage (queueWorkflowCoding) is refused the same way", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await planBlocked(t);
    const workflow = t.meta(taskId).workflow!;
    await t.set(taskId, "SET workflow = :workflow", { ":workflow": { ...workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: PAUSED } });
    const before = snapshot(t, taskId, workspaceId, request.spendRequestId);
    const retried = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: workflow.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(409);
    expect(retried.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("waiting for") as unknown } });
    expect(snapshot(t, taskId, workspaceId, request.spendRequestId)).toEqual(before);
  });

  it("Ben's send-back to coding is refused the same way", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await planBlocked(t);
    const workflow = t.meta(taskId).workflow!;
    await t.set(taskId, "SET workflow = :workflow", { ":workflow": { ...workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: PAUSED } });
    const before = snapshot(t, taskId, workspaceId, request.spendRequestId);
    const sent = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { expectedRevision: workflow.revision, instructions: "Fix it." });
    expect(sent.status, JSON.stringify(sent.body)).toBe(409);
    expect(sent.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("waiting for") as unknown } });
    expect(snapshot(t, taskId, workspaceId, request.spendRequestId)).toEqual(before);
  });

  it("a refusal is also given to a run-limit pause of a run with an agent when someone else must approve the raise (a $21 limit goes to the maintainer)", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(run, { kind: "task", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "run_limit")[0]!;
    const before = snapshot(t, run.taskId, run.workspaceId, request.spendRequestId);
    // Maya pays and started it, but a raise to $21 needs a project maintainer (Ben), not the payer.
    expect(request).toMatchObject({ approverRole: "project_maintainer", approverIds: [BEN.developerId] });
    const retried = await t.api(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/workflow/retry`, { expectedRevision: before.meta.workflow!.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(409);
    expect(retried.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("a maintainer of payments") as unknown } });
    expect(snapshot(t, run.taskId, run.workspaceId, request.spendRequestId)).toEqual(before);
  });

  it("a process-layer task keeps R38 like a Rovara Code task: the run-limit pause that gates an agent's run does not gate it", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(run, { kind: "task", taskId: run.taskId });
    const task = t.meta(run.taskId) as unknown as Parameters<typeof pausedTaskGate>[2];
    // Control: as an ordinary agent's run it is gated (a raise to $21 is a maintainer's to decide).
    const ordinary = await pausedTaskGate(t.deps(), t.caller(MAYA), task);
    expect(ordinary).toMatchObject({ allowed: false });
    const layer = { ...task, agent: { ...task.agent!, builtin: false, process: true as const } };
    expect(await pausedTaskGate(t.deps(), t.caller(MAYA), layer)).toEqual({ allowed: true });
  });

  it("a person who may decide the open request still goes on: the payer's retry of a pause within the payer's threshold resets the window and withdraws the request", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(run, { kind: "planning", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "planning")[0]!;
    expect(request).toMatchObject({ approverRole: "payer", approverIds: [MAYA.developerId] });
    const workflow = t.meta(run.taskId).workflow!;
    const retried = await t.api(MAYA, "POST", `/v1/dev/tasks/${run.taskId}/workflow/retry`, { expectedRevision: workflow.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(t.meta(run.taskId).budgetPause).toBeUndefined();
  });

  it("a planning pause within the payer's threshold goes on for the payer, and is refused for someone who is not asked", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING);
    await t.shareWith(agentId, BEN);
    const run = await t.runOf(agentId, { who: BEN });
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 6 });
    await t.pauseAndEnd(run, { kind: "planning", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "planning")[0]!;
    expect(request).toMatchObject({ approverRole: "payer", approverIds: [BEN.developerId] });
    const before = snapshot(t, run.taskId, run.workspaceId, request.spendRequestId);
    // Ben pays and started it, so a planning raise within the lead's threshold is his to decide.
    const retried = await t.api(BEN, "POST", `/v1/dev/tasks/${run.taskId}/workflow/retry`, { expectedRevision: before.meta.workflow!.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(t.meta(run.taskId).budgetPause).toBeUndefined();
  });

  it("a request that ended (denied or expired) leaves the pause in place, and a retry by someone who could not decide it is still refused", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await planBlocked(t);
    await t.decide(MAYA, request.spendRequestId, "DENY");
    expect(t.openItems()).toEqual([]);
    const before = snapshot(t, taskId, workspaceId, request.spendRequestId);
    const retried = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: before.meta.workflow!.revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(409);
    expect(retried.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("waiting for") as unknown } });
    expect(snapshot(t, taskId, workspaceId, request.spendRequestId)).toEqual(before);
  });
});

describe("the gate holds where the other tests do not reach it", () => {
  it("a plain task (no agent, so no workflow and no agent run) paused at a max per run is not skipped by its starter's Continue: a max per run holds for every task", async () => {
    const t = await setup();
    // Ben started and pays for it, but a max per run with no agent to own it is the org admins' to decide.
    const { taskId, workspaceId } = await t.plainTask(BEN);
    await t.set(taskId, "SET maxPerRunUsd = :max", { ":max": 4 });
    await t.pauseAndEnd({ taskId, workspaceId }, { kind: "max_per_run", taskId });
    const before = snapshot(t, taskId, workspaceId, "none");
    const continued = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/continue`, { instructions: "Go on" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(409);
    expect(continued.body).toMatchObject({ error: { code: "WORKSPACE_BUSY", message: expect.stringContaining("waiting for") as unknown } });
    expect(snapshot(t, taskId, workspaceId, "none")).toEqual(before);
    expect(t.meta(taskId).budgetPause).toBeDefined();
  });

  it("the open request decides who may go on, not the request the pause would ask for now: once it is escalated, an admin may", async () => {
    const t = await setup();
    const { taskId, request } = await maxPaused(t, TRIAGE);
    const task = t.meta(taskId) as unknown as Parameters<typeof pausedTaskGate>[2];
    // Asked of the agent's owner (Maya) alone: Deb, an admin, is not asked.
    expect(await pausedTaskGate(t.deps(), t.caller(DEB, "admin"), task)).toMatchObject({ allowed: false });
    expect(await pausedTaskGate(t.deps(), t.caller(MAYA), task)).toEqual({ allowed: true });
    // The escalation adds the org's admins to that request; the request that would be asked now (never escalated) would not.
    t.db.set({ ...t.requests().find((record) => record.spendRequestId === request.spendRequestId)!, escalatedAt: new Date().toISOString() });
    expect(await pausedTaskGate(t.deps(), t.caller(DEB, "admin"), task)).toEqual({ allowed: true });
  });

  it("an approval's own resume is the approval, so the gate does not refuse it, even when another pause landed on the task in between", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await maxPaused(t, CODING);
    const before = t.taskOps(workspaceId).length;
    // The resume runs as the run's owner (Ben), who may not decide this request himself. Just after the approval took the pause off, another one is written
    // (a concurrent stop): the resume reads the task again, finds a pause that is not the approval's, and must still go on, as the approval it is.
    const send = t.db.send;
    let approved = false;
    let reads = 0;
    t.db.send = async (command) => {
      const input = (command as { input?: { Key?: { pk?: string; sk?: string }; TransactItems?: Array<{ Update?: { Key?: { pk?: string } } }> } }).input;
      if (command instanceof GetCommand && approved && input?.Key?.pk === `DEVTASK#${taskId}` && input.Key.sk === "META") {
        reads += 1;
        // The third read after the approval is the resume's own read of the task, after its check that no pause is left.
        if (reads === 3) await t.set(taskId, "SET budgetPause = :pause", { ":pause": { scope: { kind: "max_per_run", taskId }, at: new Date().toISOString() } });
      }
      const sent = await send(command);
      if (input?.TransactItems?.some((item) => item.Update?.Key?.pk === `DEVTASK#${taskId}`) === true) approved = true;
      return sent;
    };
    await t.decide(MAYA, request.spendRequestId);
    t.db.send = send;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(t.meta(taskId).workflow).toMatchObject({ state: "RUNNING" });
    expect(t.meta(taskId).budgetPause).toBeUndefined();
    expect(t.taskOps(workspaceId)).toHaveLength(before + 1);
  });
});
