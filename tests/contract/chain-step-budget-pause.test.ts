// Plan 4 Task 6, concern 2 (M-6b), now that Plan 3's M-6 is merged: a chain step that is a plain coding task (Rovara Code) and stops on a budget limit is told to the
// chain runner as PAUSED, not as a failed end. The broker's real end site (`recordTerminalResult` with M-6's `tellTaskStop`) tells the real runner handlers, which read
// the run and the step's attempt from the same table. The attempt and the run are `paused`, nothing fails, no second task starts, and the step ends only when the task does.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerChainRunner } from "../../packages/broker/src/chains/index.js";
import type { ChainRunnerDependencies } from "../../packages/broker/src/chains/runner.js";
import { chainKey, chainRunKey } from "@rovara-code/contracts";
import type { BudgetScope } from "@agentx/cloud-contracts";
import { ORG_A, PRIYA, setupWorld, type ChainWorld } from "../support/chain-run-world.js";
import { MAYA } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { DEB, setup, type World } from "../support/spend-world.js";

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };
const unregister: Array<() => void> = [];
beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

/** A chain with one Rovara Code step, started in a chain world; its run's rows are copied into the broker's table, and its attempt is bound to the plain task `taskId`. */
async function chainStepOn(w: ChainWorld, t: World, taskId: string) {
  const chain = await w.publish({
    start: "fix", limits: { maxRunUsd: 30 },
    steps: [{ kind: "agent", id: "fix", name: "Fix it", agent: { agentId: "rovara-code", version: "current" }, next: { kind: "end" } }],
  } as never);
  const { startChainRun } = await import("../../packages/broker/src/chains/runner.js");
  const run = await startChainRun(w.deps, { orgId: ORG_A, developerId: PRIYA, orgRole: "member" }, {
    orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: PRIYA }, requestId: randomUUID(),
  } as never);
  const rows = w.db.find((item) => item.pk === chainRunKey(ORG_A, run.runId, "META").pk);
  expect(rows.length).toBeGreaterThan(2);
  // The chain's own row counts its open runs, which the run's end decrements.
  t.db.set(w.db.get(chainKey(ORG_A, chain.chainId, "META"))!);
  for (const row of [...rows, ...w.openItems()]) t.db.set(String(row.sk).startsWith("STEP#") ? { ...row, taskId } : row);
  await t.set(taskId, "SET #chain = :chain", { ":chain": { chainRunId: run.runId, stepId: "fix" } }, { "#chain": "chain" });
  const deps: ChainRunnerDependencies = { ...w.deps, documentClient: t.db, tableName: "state" };
  unregister.push(registerChainRunner(() => deps));
  const attempts = () => t.db.find((item) => item.pk === chainRunKey(ORG_A, run.runId, "META").pk && String(item.sk).startsWith("STEP#"));
  const events = () => t.db.find((item) => item.pk === chainRunKey(ORG_A, run.runId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => String(item.type));
  const runRow = () => t.db.get(chainRunKey(ORG_A, run.runId, "META")) as unknown as { status: string };
  return { run, attempts, events, runRow };
}

describe("a chain step that is a plain coding task and stops on a budget (Plan 4 Task 6 concern 2, Plan 3 M-6)", () => {
  it("is told as paused: the attempt and the run are paused, nothing failed, and the step is not ended", async () => {
    const t = await setup();
    const w = setupWorld();
    const task = await t.plainTask();
    const step = await chainStepOn(w, t, task.taskId);
    expect(step.runRow().status).toBe("running");
    await t.pauseAndEnd(task, MEMBER);
    expect(step.attempts()).toEqual([expect.objectContaining({ taskId: task.taskId, status: "paused" })]);
    expect(step.runRow().status).toBe("paused");
    const events = step.events();
    expect(events).toContain("paused");
    expect(events).not.toContain("step_ended");
    // The task was not ended: its workspace and keys are kept for Task 32's resume.
    expect(t.db.find((item) => item.pk === `DEVTASK#${task.taskId}` && item.sk === "TASK_END")).toEqual([]);
    expect(t.meta(task.taskId).releasedAt).toBeUndefined();
  });

  it("goes on after the raise is approved and the task finishes: the step ends once, succeeded, and the run with it", async () => {
    const t = await setup();
    const w = setupWorld();
    const task = await t.plainTask();
    const step = await chainStepOn(w, t, task.taskId);
    await t.pauseAndEnd(task, MEMBER);
    const request = t.requests().find((record) => record.kind === "month")!;
    await t.decide(DEB, request.spendRequestId, "APPROVE", { amountUsd: 10 });
    const operations = t.taskOps(task.workspaceId);
    expect(operations).toHaveLength(2);
    // Plan 4 Task 6 review M-1: the approved raise tells the runner the step went on, so the step and the run show running again before the task ends.
    expect(step.attempts()).toEqual([expect.objectContaining({ status: "running" })]);
    expect(step.runRow().status).toBe("running");
    expect(step.events().filter((type) => type === "resumed")).toHaveLength(1);
    await t.finish(task.workspaceId, operations[1]!.id, "SUCCEEDED");
    expect(step.attempts()).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(step.runRow().status).toBe("succeeded");
    expect(step.events().filter((type) => type === "step_ended")).toHaveLength(1);
  });

  it("handles a second budget stop of the same task after the first raise was approved: paused again, then the one end", async () => {
    const t = await setup();
    const w = setupWorld();
    const task = await t.plainTask();
    const step = await chainStepOn(w, t, task.taskId);
    await t.pauseAndEnd(task, MEMBER);
    const request = t.requests().find((record) => record.kind === "month")!;
    await t.decide(DEB, request.spendRequestId, "APPROVE", { amountUsd: 10 });
    expect(step.attempts()).toEqual([expect.objectContaining({ status: "running" })]);
    await t.pauseAndEnd(task, MEMBER);
    expect(step.attempts()).toEqual([expect.objectContaining({ status: "paused" })]);
    expect(step.runRow().status).toBe("paused");
    expect(step.events().filter((type) => type === "paused")).toHaveLength(2);
    expect(step.events()).not.toContain("step_ended");
  });

  it("a stop with no pause that could not be worked out is still a failed step (the failure is real)", async () => {
    const t = await setup();
    const w = setupWorld();
    const task = await t.plainTask();
    const step = await chainStepOn(w, t, task.taskId);
    await t.pauseAndEnd(task, "none");
    expect(step.attempts()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(step.runRow().status).toBe("failed");
  });
});
