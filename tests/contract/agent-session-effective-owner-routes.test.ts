// Plan 5 Task 12a, end to end through the broker's own routes: a task Maya started that Ben took over (written directly, as Task 12b will) is Ben's on every route
// that decides by its owner, and no longer Maya's. Her principal (the task's `ownerKey`, its workspace and its object prefixes) never changes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA } from "../support/developer-task-broker.js";
import { BEN, CARL, CODING, setup, type World } from "../support/spend-world.js";

const SINCE = "2026-10-22T11:00:00.000Z";

/** Maya's plain task, idle after its first run, taken over by `taker`. */
async function takenOver(t: World, taker = BEN) {
  const started = await t.plainTask(MAYA);
  await t.finish(started.workspaceId, started.operationId, "SUCCEEDED");
  const before = t.meta(started.taskId);
  await t.set(started.taskId, "SET currentOwner = :owner", { ":owner": { developerId: taker.developerId, name: taker.name, provider: taker.provider, since: SINCE } });
  return { ...started, before };
}

describe("a task Ben took over from Maya, through the routes", () => {
  it("is Ben's to read and list-check, and Maya's own owner routes answer 404", async () => {
    const t = await setup();
    const { taskId } = await takenOver(t);
    expect((await t.api(BEN, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
    const refused = await t.api(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).toContain("TASK_NOT_FOUND");
  });

  it("is Ben's to continue: the new turn runs under his authority, and Maya's continue is refused as a task that is not hers", async () => {
    const t = await setup();
    const { taskId, workspaceId } = await takenOver(t);
    const refused = await t.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { instructions: "more" });
    expect(refused.status).toBe(404);
    const before = t.taskOps(workspaceId).length;
    const continued = await t.api(BEN, "POST", `/v1/dev/tasks/${taskId}/continue`, { instructions: "Carry on with the retry fix" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(t.taskOps(workspaceId)).toHaveLength(before + 1);
  });

  it("keeps the task's principal as it was: the owner key, the workspace and Maya's own fields", async () => {
    const t = await setup();
    const { taskId, before } = await takenOver(t);
    const after = t.meta(taskId);
    expect(after.ownerKey).toBe(before.ownerKey);
    expect(after.workspaceId).toBe(before.workspaceId);
    expect(after.developerId).toBe(MAYA.developerId);
    expect(after.developerName).toBe(MAYA.name);
  });

  it("refuses a continue by a teammate who is neither, exactly as it did before the take-over", async () => {
    const t = await setup();
    const { taskId } = await takenOver(t);
    expect((await t.api(CARL, "POST", `/v1/dev/tasks/${taskId}/continue`, { instructions: randomUUID() })).status).toBe(404);
  });

  it("a task nobody took over answers as before: Maya continues it, and Ben, who maintains the project, gets 404", async () => {
    const t = await setup();
    const started = await t.plainTask(MAYA);
    await t.finish(started.workspaceId, started.operationId, "SUCCEEDED");
    expect((await t.api(BEN, "POST", `/v1/dev/tasks/${started.taskId}/continue`, { instructions: "more" })).status).toBe(404);
    expect((await t.api(MAYA, "POST", `/v1/dev/tasks/${started.taskId}/continue`, { instructions: "more" })).status).toBe(200);
  });
});

describe("a budget pause on a task Ben took over from Maya", () => {
  async function pausedAfterTakeOver(t: World, options: { takeOver: boolean }) {
    const agentId = await t.agentOf(CODING);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    if (options.takeOver) await t.set(run.taskId, "SET currentOwner = :owner", { ":owner": { developerId: BEN.developerId, name: BEN.name, provider: BEN.provider, since: SINCE } });
    await t.pauseAndEnd(run, { kind: "task", taskId: run.taskId });
    return { ...run, request: t.requestOf(run.taskId, "run_limit")[0]! };
  }

  it("asks for the taker, who now decides what the task spends", async () => {
    const t = await setup();
    const { request } = await pausedAfterTakeOver(t, { takeOver: true });
    expect(request).toMatchObject({ requestedFor: { developerId: BEN.developerId } });
  });

  it("asks for the run's starter, as before, when nobody took the task over", async () => {
    const t = await setup();
    const { request } = await pausedAfterTakeOver(t, { takeOver: false });
    expect(request).toMatchObject({ requestedFor: { developerId: MAYA.developerId } });
  });

  it("shows the pause on the taker's task page, and the creator's page answers 404", async () => {
    const t = await setup();
    const { taskId } = await pausedAfterTakeOver(t, { takeOver: true });
    const seen = await t.view(BEN, taskId);
    expect(seen.paused).toMatchObject({ reason: expect.any(String) as unknown });
    expect((await t.api(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(404);
  });
});
