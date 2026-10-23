// Plan 4 Task 9: failure, timeouts, retries and cancel. An attempt that failed or timed out is tried again while its step has retries left (never two attempts of a step at
// once); a step, a gate and a whole run have their times; `sweepChainRuns` finds the work a lost callback or a dead process left behind; and a person (or a maintainer, or the
// chain's owner) can stop a run. Task 6's, 7's and 8's guarantees hold on every path here: a step ends at most once, a budget pause is never a failure or a retry, a state change
// and its event are one transaction, and a run's end releases its place in the chain once.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { approvalKey, approverIndexKey, chainKey, openApprovalKey, openChainRunKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { decideApproval, expireApprovals, registerApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { routeChainRequest } from "../../packages/broker/src/chains/routes.js";
import { taskEndKey } from "../../packages/broker/src/agents/task-end.js";
import { taskAgentRunKey } from "../../packages/broker/src/developer/task-records.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";

const lifecycle = () => import("../../packages/broker/src/chains/lifecycle.js");
const runner = () => import("../../packages/broker/src/chains/runner.js");

afterEach(() => disposeGateWorlds());

const MIN = 60_000;
const HOUR = 3_600_000;
type Step = ChainDefinitionInput["steps"][number];
const agentStep = (id: string, name: string, agentId: string, next: unknown, extra: Record<string, unknown> = {}): Step => ({ kind: "agent", id, name, agent: { agentId, version: "current" }, next, ...extra }) as Step;
/** look -> act. `first` adds fields to the first step (retries, timeoutMinutes); `limits` replaces the design's limits. */
const twoSteps = (first: Record<string, unknown> = {}, limits: Record<string, unknown> = { maxRunUsd: 30 }): ChainDefinitionInput => ({
  start: "look", limits,
  steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "act" }, first), agentStep("act", "Act on it", "code-reviewer", { kind: "end" })],
});
/** look (may be sent back to itself twice) -> end. */
const looping = (first: Record<string, unknown>): ChainDefinitionInput => ({
  start: "look", limits: { maxRunUsd: 30 },
  steps: [agentStep("look", "Look into it", "root-cause-analyst", {
    kind: "branch", default: "done", choices: [{ id: "again", description: "Look again", to: "look", maxTraversals: 2 }, { id: "done", description: "Enough", to: "$end" }],
  }, first)],
});

const sweep = async (w: GateWorld) => (await lifecycle()).sweepChainRuns(w.deps, w.clock.now);
const endTask = async (w: GateWorld, taskId: string, extra: Record<string, unknown> = {}) => (await runner()).onStepTaskEnded(w.deps, w.endEvent(taskId, extra));
const setAgentRun = (w: GateWorld, taskId: string, fields: Record<string, unknown>) => w.db.set({ ...w.db.get(taskAgentRunKey(taskId))!, ...fields });
const failTask = async (w: GateWorld, taskId: string, reason?: string) => {
  if (reason !== undefined) setAgentRun(w, taskId, { endReason: reason });
  await endTask(w, taskId, { outcome: "failed" });
};
/** What a refused call said: its code and its words without the code. */
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
/** The stored META item of a run, whole. */
const runItem = (w: GateWorld, runId: string) => w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === runId)[0]!;
const openRunsOf = async (w: GateWorld, chainId: string) => (await w.chainOf(chainId)).openRuns;
const live = (w: GateWorld, runId: string) => w.attempts(runId).filter((attempt) => ["starting", "running", "paused", "waiting"].includes(attempt.status));
const startedAgain = (w: GateWorld) => w.starts.length;

// ---- retries

describe("a step's retries", () => {
  it("runs a step with `retries: 1` twice, then fails the run with the step's name and the task's own words", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    await failTask(w, "task-1", "The tool broke");
    expect(w.attempts(run.runId)).toMatchObject([{ seq: 1, status: "failed", attempt: 1 }, { seq: 2, status: "running", attempt: 2, stepId: "look", taskId: "task-2" }]);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2, stepRuns: 2 });
    const retrying = w.events(run.runId).filter((event) => event.type === "retrying");
    expect(retrying).toEqual([expect.objectContaining({ stepSeq: 1, text: 'Step "Look into it" failed: The tool broke. Trying again (attempt 2 of 2).' })]);
    const types = w.events(run.runId).map((event) => event.type);
    expect(types.indexOf("retrying")).toBeLessThan(types.lastIndexOf("step_started"));
    await failTask(w, "task-2", "The tool broke again");
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 2, reason: "step_failed", message: 'Step "Look into it" failed: The tool broke again.' } });
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(startedAgain(w)).toBe(2);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("starts the new attempt with the same input as the first, under a new request id", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    await w.start(chain.chainId, PRIYA);
    await failTask(w, "task-1");
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]!.input).toEqual(w.starts[0]!.input);
    expect(w.starts[1]!.requestId).not.toBe(w.starts[0]!.requestId);
    expect(w.starts[1]!.chain).toEqual(w.starts[0]!.chain);
  });

  it("gives a step `retries: 2` three attempts and no more", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const run = await w.start(chain.chainId);
    for (const taskId of ["task-1", "task-2"]) await failTask(w, taskId);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 3 });
    expect(w.attempts(run.runId)[2]).toMatchObject({ attempt: 3, status: "running" });
    await failTask(w, "task-3", "Third time");
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { message: 'Step "Look into it" failed: Third time.' } });
    expect(startedAgain(w)).toBe(3);
  });

  it("fails the run at the first failure when the step has no retries", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    await failTask(w, "task-1", "Nope");
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { message: 'Step "Look into it" failed: Nope.' } });
    expect(w.events(run.runId).some((event) => event.type === "retrying")).toBe(false);
    expect(startedAgain(w)).toBe(1);
  });

  it("never has two attempts of a step live at once: the retry starts only after the first attempt has ended", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const liveAtStart: number[] = [];
    w.hooks.onStarted = () => { liveAtStart.push(w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.status === "running").length); };
    const run = await w.start(chain.chainId);
    await failTask(w, "task-1");
    await failTask(w, "task-2");
    expect(liveAtStart).toEqual([0, 0, 0]);
    expect(live(w, run.runId)).toHaveLength(1);
  });

  it("starts one retry however often, and however many at once, the failed attempt's end is told", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    await Promise.all([failTask(w, "task-1"), failTask(w, "task-1"), failTask(w, "task-1")]);
    await failTask(w, "task-1");
    expect(startedAgain(w)).toBe(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(w.events(run.runId).filter((event) => event.type === "retrying")).toHaveLength(1);
  });

  it("does not retry a step that could not start: a refused start fails the run", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    w.hooks.refuse.push(agentXError("FORBIDDEN", "the project is archived"));
    const run = await w.start(chain.chainId);
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { reason: "FORBIDDEN" } });
    expect(startedAgain(w)).toBe(1);
  });

  it("starts retries over for each visit of a step: a step sent back to itself gets its own retries", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(looping({ retries: 1 }));
    const run = await w.start(chain.chainId);
    await failTask(w, "task-1");
    await endTask(w, "task-2", { finalReport: "Again.", branch: "again" });
    expect(w.attempts(run.runId)[2]).toMatchObject({ seq: 3, attempt: 3, status: "running" });
    expect(w.attempts(run.runId)[2]!.retriesUsed ?? 0).toBe(0);
    await failTask(w, "task-3");
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 4 });
    expect(w.attempts(run.runId)[3]).toMatchObject({ attempt: 4, retriesUsed: 1 });
  });

  it("says at most 300 characters of the reason", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    await failTask(w, "task-1", "x".repeat(1000));
    const message = w.run(run.runId)!.failure!.message;
    expect(message.startsWith('Step "Look into it" failed: xxx')).toBe(true);
    expect([...message].length).toBeLessThanOrEqual('Step "Look into it" failed: '.length + 300 + 1);
    expect(message.endsWith("….")).toBe(true);
  });

  it("is not a failure and not a retry when a step is paused for budget: the run is paused, nothing starts, and the end of the task goes on", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const run = await w.start(chain.chainId);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(w.run(run.runId)).toMatchObject({ status: "paused" });
    expect(w.attempts(run.runId)).toMatchObject([{ status: "paused" }]);
    w.clock.now += 500 * MIN;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "paused" });
    expect(w.attempts(run.runId)).toHaveLength(1);
    expect(w.cancels).toEqual([]);
    expect(startedAgain(w)).toBe(1);
    await endTask(w, "task-1", { finalReport: "Done after the raise." });
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2 });
    expect(w.events(run.runId).some((event) => event.type === "retrying")).toBe(false);
  });

  it("ends the chain run `cancelled` with the task's words when a person declined an approval inside the step, and does not retry it", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const run = await w.start(chain.chainId);
    setAgentRun(w, "task-1", { endReason: "Ship it declined: Send the report to customers?" });
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", failure: { seq: 1, reason: "step_cancelled", message: "Ship it declined: Send the report to customers?" } });
    expect(startedAgain(w)).toBe(1);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("keeps the plain words for a cancel that said nothing", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    setAgentRun(w, "task-1", { endReason: "Cancelled." });
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", failure: { message: 'Step "Look into it" was cancelled.' } });
  });
});

// ---- step timeouts

describe("a step's time", () => {
  it("cancels an agent attempt that has run 121 minutes, through the cancel path as the run's owner, and marks it timed out when the task ends", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([{ orgId: ORG_A, taskId: "task-1", owner: { developerId: PRIYA }, requestId: expect.any(String) as string }]);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", timeoutMinutes: 120, timedOutAt: new Date(w.clock.now).toISOString() });
    // The task ends the way a cancel ends it; the attempt takes the timeout's words, and the run its failure.
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "timed_out", failure: { reason: "step_timeout", message: "it ran longer than 120 minutes" } });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "step_timeout", message: 'Step "Look into it" failed: it ran longer than 120 minutes.' } });
    expect(w.events(run.runId).find((event) => event.type === "step_ended")!.text).toBe('Step "Look into it" ran out of time.');
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("leaves an attempt alone at 119 minutes, and uses the step's own timeout when it has one", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    await w.start(chain.chainId);
    w.clock.now += 119 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    const own = await w.publish(twoSteps({ timeoutMinutes: 30 }));
    const run = await w.start(own.chainId);
    w.clock.now += 31 * MIN;
    await sweep(w);
    // The second run's task is the second task; the first run's task, 150 minutes old, is cancelled too.
    expect(w.cancels.map((cancel) => cancel.taskId).sort()).toEqual(["task-1", "task-2"]);
    expect(w.attempts(run.runId)[0]).toMatchObject({ timeoutMinutes: 30 });
  });

  it("asks again at the next sweep with the same request id while the task still runs, and flags the attempt once", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    const flagged = w.attempts(run.runId)[0]!.timedOutAt;
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels).toHaveLength(2);
    expect(w.cancels[1]!.requestId).toBe(w.cancels[0]!.requestId);
    expect(w.attempts(run.runId)[0]!.timedOutAt).toBe(flagged);
    expect(w.attempts(run.runId)).toHaveLength(1);
  });

  it("starts the retry of a timed out attempt only after its task has ended", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    expect(startedAgain(w)).toBe(1);
    expect(live(w, run.runId)).toHaveLength(1);
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.attempts(run.runId)).toMatchObject([{ status: "timed_out" }, { status: "running", attempt: 2, taskId: "task-2" }]);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2 });
    expect(startedAgain(w)).toBe(2);
    expect(w.events(run.runId).find((event) => event.type === "retrying")!.text).toBe('Step "Look into it" failed: it ran longer than 120 minutes. Trying again (attempt 2 of 2).');
  });

  it("takes a task that finished before the cancel took effect as finished", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    await endTask(w, "task-1", { finalReport: "Done just in time." });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded", result: { report: "Done just in time." } });
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2 });
  });

  it("never times out a paused attempt, and does not time it out the moment it goes on", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const { onStepTaskPaused, markStepResumed } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    w.clock.now += 500 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    expect(w.run(run.runId)).toMatchObject({ status: "paused" });
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    await sweep(w);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    w.clock.now += 100 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    w.clock.now += 25 * MIN;
    await sweep(w);
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
  });

  it("never times out an attempt that waits on Plan 3 write approvals", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    setAgentRun(w, "task-1", { state: "WAITING_FOR_APPROVAL" });
    w.clock.now += 500 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    setAgentRun(w, "task-1", { state: "RUNNING" });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });
});

// ---- the gate's time and the run's time

describe("a gate's time", () => {
  it("is the approval's own expiry: Plan 3's sweep marks it EXPIRED and tells the gate, and the run ends timed out with the plan's words", async () => {
    const w = setupGateWorld();
    const { run, approvalId, chain } = await w.runAtGate();
    w.clock.now += 73 * HOUR;
    const report = await expireApprovals(w.deps, w.clock.now);
    expect(report.expired).toBe(1);
    expect((await w.approval(approvalId)).status).toBe("EXPIRED");
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { seq: 2, reason: "gate_timeout", message: 'No one approved "Approve the fix" within 72 hours, so the chain stopped.' } });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "timed_out" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    await sweep(w);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("is never ended by the chain sweep: a gate past its time with its approval still PENDING waits for Plan 3's sweep", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const before = w.events(run.runId).length;
    w.clock.now += 73 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    expect((await w.approval(approvalId)).status).toBe("PENDING");
    expect(w.events(run.runId)).toHaveLength(before);
    expect(JSON.stringify(w.run(run.runId))).not.toContain("No one approved");
  });
});

describe("a run's time", () => {
  it("cancels the running task and ends the run timed out after 168 hours, once", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 1440 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout", message: "This run took longer than 168 hours, so the chain stopped." } });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout" } });
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
    expect(w.openItems()).toEqual([]);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    const events = w.events(run.runId).length;
    // The task's own end arrives afterwards, and a second sweep: nothing changes.
    await endTask(w, "task-1", { outcome: "cancelled" });
    await sweep(w);
    expect(w.events(run.runId)).toHaveLength(events);
    expect(w.cancels).toHaveLength(1);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("takes the design's own `maxRunHours`, and does it before the step's time", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({}, { maxRunUsd: 30, maxRunHours: 1 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 59 * MIN;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
    w.clock.now += 2 * MIN;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { message: "This run took longer than 1 hour, so the chain stopped." } });
  });

  it("ends a run that waits at a gate when its time is up, and closes the gate's approval", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId);
    await w.endLatest({ branch: "fix" });
    const approvalId = w.attempts(run.runId)[1]!.approvalId!;
    // Plan 3's expiry sweep has not run when the chain's does.
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout" } });
    expect((await w.approval(approvalId)).status).toBe("EXPIRED");
  });
});

// ---- what the sweep recovers

describe("the sweep", () => {
  it("looks only at runs that are due, in order, and at most 200 of them", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const queries: Array<Record<string, unknown>> = [];
    const send = w.deps.documentClient.send.bind(w.deps.documentClient);
    w.deps.documentClient.send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("OPEN_CHAIN_RUNS")) queries.push(command.input);
      return send(command);
    };
    await sweep(w);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ Limit: 200, ConsistentRead: true });
    // Not yet due: nothing is read or moved.
    expect(w.run(run.runId)!.version).toBe(2);
  });

  it("moves the run's due time and its open item together, in one transaction that moves the version", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const before = w.run(run.runId)!;
    w.clock.now += 6 * MIN;
    await sweep(w);
    const after = w.run(run.runId)!;
    expect(after.version).toBe(before.version + 1);
    expect(after.eventSeq).toBe(before.eventSeq);
    expect(after.dueAt > new Date(w.clock.now).toISOString()).toBe(true);
    expect(w.openItems().map((item) => String(item.sk))).toEqual([openChainRunKey(after.dueAt, ORG_A, run.runId).sk]);
    // Looked at once: a second sweep at the same time changes nothing.
    await sweep(w);
    expect(w.run(run.runId)!.version).toBe(after.version);
  });

  it("recovers a lost task-end callback once: the next step starts, and a second sweep does not start it again", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    // The task ended and its end was recorded, but the handler never ran.
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, outcome: "succeeded", handlersTold: 0, done: false });
    setAgentRun(w, "task-1", { state: "COMPLETE", finalReport: "Found it." });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded", result: { report: "Found it." } });
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(startedAgain(w)).toBe(2);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(startedAgain(w)).toBe(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(w.events(run.runId).filter((event) => event.type === "step_ended")).toHaveLength(1);
  });

  it("recovers a lost end that failed: the attempt fails, and its retry starts", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, outcome: "failed", handlersTold: 0, done: false });
    setAgentRun(w, "task-1", { state: "FAILED", endReason: "It broke" });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toMatchObject([{ status: "failed", failure: { message: "It broke" } }, { status: "running", attempt: 2 }]);
  });

  it("ignores a task end that another org's task wrote", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_B, outcome: "succeeded", handlersTold: 0, done: false });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toHaveLength(1);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running" });
  });

  it("starts an attempt that is `starting` with no task once, with the same request id", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "the runtime is busy"));
    const run = await w.start(chain.chainId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "starting" });
    expect(w.attempts(run.runId)[0]!.taskId).toBeUndefined();
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", taskId: "task-1" });
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]!.requestId).toBe(w.starts[0]!.requestId);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.starts).toHaveLength(2);
    expect(w.tasks.size).toBe(1);
  });

  it("finishes a run that is terminal with its open item still there: the item goes and the chain's count drops once", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const dead = await w.start(chain.chainId);
    await w.start(chain.chainId);
    expect(await openRunsOf(w, chain.chainId)).toBe(2);
    w.db.set({ ...runItem(w, dead.runId), status: "failed", endedAt: new Date(w.clock.now).toISOString() });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.openItems().map((item) => String(item.sk))).not.toContain(openChainRunKey(dead.dueAt, ORG_A, dead.runId).sk);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
    w.clock.now += 6 * MIN;
    await sweep(w);
    await sweep(w);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
  });

  it("drops an open item whose run is not there under that org, and leaves the run it names under another org alone", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const stray = openChainRunKey(new Date(w.clock.now).toISOString(), ORG_B, run.runId);
    w.db.set({ ...stray, entityType: "OPEN_CHAIN_RUN", orgId: ORG_B, runId: run.runId });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.db.get(stray)).toBeUndefined();
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
  });

  it("goes on with the other runs when one run can't be looked at, and says how many failed", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const first = await w.start(chain.chainId);
    const second = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    w.hooks.cancelFails.push(new Error("the worker could not be asked"));
    const report = await sweep(w);
    expect(report.failed).toBe(1);
    expect(w.cancels).toHaveLength(1);
    expect([first, second].map((run) => w.attempts(run.runId)[0]!.timedOutAt !== undefined)).toEqual([true, true]);
  });

  it("re-reads each run under the org its item names", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ ...runItem(w, run.runId), orgId: ORG_B });
    w.clock.now += 6 * MIN;
    const report = await sweep(w);
    expect(report.failed).toBe(0);
    expect(w.cancels).toEqual([]);
  });
});

describe("a gate decided but not applied", () => {
  const decided = async (w: GateWorld, approvalId: string, status: "APPROVED" | "DECLINED" | "EXPIRED") => {
    const record = await w.approval(approvalId);
    w.db.set({
      ...w.db.get(approvalKey(ORG_A, approvalId))!, status, handlerDone: false,
      ...(status === "EXPIRED" ? {} : { decidedBy: MAX, decidedAt: new Date(w.clock.now).toISOString(), decision: status === "APPROVED" ? "APPROVE" : "DECLINE" }),
    });
    return record;
  };

  it("takes `onApprove` once from a record that is APPROVED while the run still waits, even after the gate's time, and never says no one approved", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await decided(w, approvalId, "APPROVED");
    w.clock.now += 73 * HOUR;
    await sweep(w);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "approved" });
    expect(w.attempts(run.runId)[2]).toMatchObject({ stepId: "fix", status: "running" });
    expect(startedAgain(w)).toBe(2);
    expect(w.events(run.runId).filter((event) => event.type === "gate_decided")).toHaveLength(1);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(startedAgain(w)).toBe(2);
    expect(w.events(run.runId).filter((event) => event.type === "gate_decided")).toHaveLength(1);
    expect(JSON.stringify([w.run(run.runId), w.events(run.runId)])).not.toContain("No one approved");
  });

  it("takes `onReject` from a record that is DECLINED", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await decided(w, approvalId, "DECLINED");
    w.clock.now += 73 * HOUR;
    await sweep(w);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "declined" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    await sweep(w);
    expect(w.events(run.runId).filter((event) => event.type === "gate_decided")).toHaveLength(1);
  });

  it("ends the run timed out, with the plan's words, only for a record that is EXPIRED", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await decided(w, approvalId, "EXPIRED");
    w.clock.now += 73 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { message: 'No one approved "Approve the fix" within 72 hours, so the chain stopped.' } });
  });

  it("leaves a record that is still PENDING alone, even past its time", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.clock.now += 80 * HOUR;
    await sweep(w);
    expect((await w.approval(approvalId)).status).toBe("PENDING");
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
  });
});

// ---- a run's end must always work (Task 6, M-3)

describe("ending a run when its bookkeeping has drifted", () => {
  it("ends a run whose chain count is already 0, and leaves the count at 0", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ ...w.db.get(chainKey(ORG_A, chain.chainId, "META"))!, openRuns: 0 });
    await failTask(w, "task-1", "Broke");
    expect(w.run(run.runId)).toMatchObject({ status: "failed" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    expect(w.openItems()).toEqual([]);
  });

  it("ends a run whose open item is not where the run says, and still gives back its place", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const key = openChainRunKey(run.dueAt, ORG_A, run.runId);
    w.db.delete(key.pk, key.sk);
    await failTask(w, "task-1", "Broke");
    expect(w.run(run.runId)).toMatchObject({ status: "failed" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("does not take a place back twice: a second end of the same run changes nothing", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    await w.start(chain.chainId);
    await failTask(w, "task-1", "Broke");
    await failTask(w, "task-1", "Broke");
    expect(w.run(run.runId)).toMatchObject({ status: "failed" });
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
  });

  it("heals an open item that is not the run's own: the stale item goes and the run's own is made", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const own = openChainRunKey(run.dueAt, ORG_A, run.runId);
    w.db.delete(own.pk, own.sk);
    const stale = openChainRunKey(new Date(w.clock.now - MIN).toISOString(), ORG_A, run.runId);
    w.db.set({ ...stale, entityType: "OPEN_CHAIN_RUN", orgId: ORG_A, runId: run.runId });
    await sweep(w);
    expect(w.openItems().map((item) => String(item.sk))).toEqual([own.sk]);
  });
});

// ---- cancel

describe("cancelling a run", () => {
  const cancelAs = async (w: GateWorld, developerId: string, runId: string, requestId: string = randomUUID()) => (await lifecycle()).cancelChainRun(w.deps, callerOf(developerId), runId, { requestId });

  it("ends the run once as cancelled, asks Plan 3 to cancel the running task as its owner, and gives the chain's place back", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const cancelled = await cancelAs(w, PRIYA, run.runId);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledBy: PRIYA });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", endedAt: new Date(w.clock.now).toISOString() });
    expect(w.run(run.runId)!.failure).toBeUndefined();
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled" });
    expect(w.cancels).toEqual([{ orgId: ORG_A, taskId: "task-1", owner: { developerId: PRIYA }, requestId: expect.any(String) as string }]);
    expect(w.events(run.runId).at(-1)).toMatchObject({ type: "ended", text: `${w.run(run.runId)!.chainName} was cancelled.` });
    expect(w.openItems()).toEqual([]);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("lets a later task end, a second sweep and a second cancel change nothing, and release nothing twice", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const other = await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    await cancelAs(w, PRIYA, run.runId, requestId);
    const events = w.events(run.runId).length;
    const version = w.run(run.runId)!.version;
    await endTask(w, "task-1", { outcome: "cancelled" });
    w.clock.now += 6 * MIN;
    await sweep(w);
    await sweep(w);
    expect(w.events(run.runId)).toHaveLength(events);
    expect(w.run(run.runId)!.version).toBe(version);
    expect(w.attempts(run.runId)).toHaveLength(1);
    expect(startedAgain(w)).toBe(2);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
    expect(w.run(other.runId)).toMatchObject({ status: "running" });
    // The same request again answers the stored outcome and writes nothing.
    const again = await cancelAs(w, PRIYA, run.runId, requestId);
    expect(again).toMatchObject({ status: "cancelled" });
    expect(w.run(run.runId)!.version).toBe(version);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
    // Another request for a run that has ended is refused.
    expect(await refusal(cancelAs(w, PRIYA, run.runId))).toEqual({ code: "CHAIN_RUN_CLOSED", message: "This chain run has already ended." });
  });

  it("answers CHAIN_RUN_CLOSED for a run that ended by itself", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await failTask(w, "task-1");
    expect(await refusal(cancelAs(w, PRIYA, run.runId))).toEqual({ code: "CHAIN_RUN_CLOSED", message: "This chain run has already ended." });
  });

  it("refuses the same request id used for a different run", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const one = await w.start(chain.chainId, PRIYA);
    const two = await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    await cancelAs(w, PRIYA, one.runId, requestId);
    expect((await refusal(cancelAs(w, PRIYA, two.runId, requestId)))?.code).toBe("CONFIG_INVALID");
    expect(w.run(two.runId)).toMatchObject({ status: "running" });
  });

  it("is allowed for the starter, a maintainer of the project, an org admin and the chain's owner, and refused for others with the plan's words", async () => {
    const w = setupGateWorld();
    // Priya owns the chain; Dana, an org admin, starts the runs.
    const chain = await w.publish(twoSteps());
    const name = (await w.chainOf(chain.chainId)).name;
    for (const who of [DANA, PRIYA, MAX]) {
      const run = await w.start(chain.chainId, DANA);
      expect((await cancelAs(w, who, run.runId)).status, who).toBe("cancelled");
    }
    const target = await w.start(chain.chainId, DANA);
    const text = `Only the person who started this run, ${name}'s owner or a maintainer of web can stop it.`;
    // A viewer and a contributor see the run and are told who may stop it; a member with no part in it is told nothing.
    expect(await refusal(cancelAs(w, VIV, target.runId))).toEqual({ code: "FORBIDDEN", message: text });
    expect(await refusal(cancelAs(w, CARL, target.runId))).toEqual({ code: "FORBIDDEN", message: text });
    expect((await refusal(cancelAs(w, ARJUN, target.runId)))?.code).toBe("NOT_FOUND");
    expect(w.run(target.runId)).toMatchObject({ status: "running" });
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("lets a contributor who started the run cancel it, and refuses one who did not when the chain is not theirs", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const name = (await w.chainOf(chain.chainId)).name;
    const run = await w.start(chain.chainId, PRIYA);
    expect(await refusal(cancelAs(w, CARL, run.runId))).toEqual({ code: "FORBIDDEN", message: `Only the person who started this run, ${name}'s owner or a maintainer of web can stop it.` });
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
    expect(w.cancels).toEqual([]);
    expect((await cancelAs(w, PRIYA, run.runId)).status).toBe("cancelled");
  });

  it("answers NOT_FOUND, as for a run that is not there, to another organization and to an id that is not a run's", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const { cancelChainRun } = await lifecycle();
    const outsider = callerOf(STRANGER, ORG_B);
    expect((await refusal(cancelChainRun(w.deps, outsider, run.runId, { requestId: randomUUID() })))?.code).toBe("NOT_FOUND");
    expect((await refusal(cancelAs(w, PRIYA, "crn_zzzzzzzzzzzzzzzzzzzz")))?.code).toBe("NOT_FOUND");
    expect((await refusal(cancelAs(w, PRIYA, "not-a-run")))?.code).toBe("NOT_FOUND");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("reads who the caller is now: a starter who left the organization can't cancel", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const member = w.db.find((item) => item.entityType === "ORG_MEMBER" && item.developerId === PRIYA)[0]!;
    w.db.delete(member.pk as string, member.sk as string);
    expect((await refusal(cancelAs(w, PRIYA, run.runId)))?.code).toMatch(/NOT_FOUND|FORBIDDEN/u);
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("closes a gate's pending approval and answers a later approval APPROVAL_CLOSED, starting nothing", async () => {
    const w = setupGateWorld();
    const { run, approvalId, chain } = await w.runAtGate(PRIYA);
    const record = await w.stepApproval(approvalId);
    const listed = (record.approvers as unknown as { candidates: string[] }).candidates;
    expect(listed.length).toBeGreaterThan(0);
    await cancelAs(w, MAX, run.runId);
    const closed = await w.stepApproval(approvalId);
    expect(closed.status).toBe("EXPIRED");
    expect(closed).toMatchObject({ closedBy: "system", closedReason: "The run was cancelled." });
    expect(w.db.get(openApprovalKey(record.expiresAt, ORG_A, approvalId))).toBeUndefined();
    for (const developerId of listed) expect(w.db.get(approverIndexKey(ORG_A, developerId, approvalId)), developerId).toBeUndefined();
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "cancelled" });
    const before = startedAgain(w);
    expect(await refusal(decideApproval(w.deps, callerOf(PRIYA), approvalId, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(startedAgain(w)).toBe(before);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    // Plan 3's expiry sweep finds nothing to tell: the record is not PENDING, and a run that ended takes no decision.
    w.clock.now += 80 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("does not tell the gate's handler when it closes the approval", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const told: string[] = [];
    registerApprovalSubjectHandler("chain_gate", async (_deps, record) => { told.push(record.status); });
    try {
      await cancelAs(w, PRIYA, run.runId);
    } finally {
      const { registerChainGates } = await import("../../packages/broker/src/chains/gates.js");
      registerChainGates();
    }
    expect(told).toEqual([]);
    expect((await w.approval(approvalId)).status).toBe("EXPIRED");
  });

  it("finishes a cancel whose task could not be asked to stop: the run is cancelled, its place is held, and the sweep asks again and then gives it back once", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    expect((await refusal(cancelAs(w, PRIYA, run.runId)))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
    expect(w.openItems()).toHaveLength(1);
    expect(w.cancels).toEqual([]);
    await sweep(w);
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
    expect(w.openItems()).toEqual([]);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    await sweep(w);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    expect(w.cancels).toHaveLength(1);
  });

  it("answers the same request again by finishing what the first could not", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    await refusal(cancelAs(w, PRIYA, run.runId, requestId));
    const again = await cancelAs(w, PRIYA, run.runId, requestId);
    expect(again).toMatchObject({ status: "cancelled" });
    expect(w.cancels).toHaveLength(1);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("stops a step that is still starting: the task the start made is asked to stop when the start is recorded", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    // The task exists and the process has not yet written its id on the attempt: the cancel lands in between.
    w.beforeTransaction("taskId", async () => { await cancelAs(w, PRIYA, w.db.find((item) => item.entityType === "CHAIN_RUN")[0]!.runId as string); });
    const run = await w.start(chain.chainId, PRIYA);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled" });
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("loses to a step that ended first, and says the run has ended when that was its last", async () => {
    const w = setupGateWorld();
    const chain = await w.publish({ start: "only", limits: { maxRunUsd: 30 }, steps: [agentStep("only", "Only step", "root-cause-analyst", { kind: "end" })] });
    const run = await w.start(chain.chainId, PRIYA);
    await endTask(w, "task-1", { finalReport: "Done." });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    expect((await refusal(cancelAs(w, PRIYA, run.runId)))?.code).toBe("CHAIN_RUN_CLOSED");
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
  });

  it("re-reads and goes on when the run moved while the cancel was written", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.beforeTransaction("ended", () => { w.touchRun(run.runId); });
    const cancelled = await cancelAs(w, PRIYA, run.runId);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });
});

// ---- the approval of a gate that never became live (Task 8, M-2)

describe("an approval made for a gate the run never entered", () => {
  it("is closed when the run ended before the gate's attempt was written", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    const { cancelChainRun } = await lifecycle();
    // The cancel lands after the gate's approval was made and before the attempt that waits on it.
    w.beforeTransaction("gate_waiting", async () => { await cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() }); });
    await w.endLatest({ branch: "fix" });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    const approvals = w.db.find((item) => item.entityType === "APPROVAL" && (item.subject as { kind?: string } | undefined)?.kind === "chain_gate");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "EXPIRED", closedBy: "system" });
    expect(w.attempts(run.runId)).toHaveLength(1);
  });

  it("is kept when the loser of a race will enter the same gate on its next pass", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    // Something else moves the run's version (the sweep's own move, say): the gate is entered on the second pass, and its approval is still the one that waits.
    w.beforeTransaction("gate_waiting", () => { w.touchRun(run.runId); });
    await w.endLatest({ branch: "fix" });
    const gate = w.attempts(run.runId).find((attempt) => attempt.kind === "gate")!;
    expect(gate).toMatchObject({ status: "waiting" });
    expect((await w.approval(gate.approvalId!)).status).toBe("PENDING");
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
  });
});

// ---- closing a step approval

describe("closeStepApproval", () => {
  it("leaves the record EXPIRED with the reason, takes its index items away and calls no handler", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const before = await w.stepApproval(approvalId);
    const told: string[] = [];
    registerApprovalSubjectHandler("chain_gate", async (_deps, record) => { told.push(record.status); });
    const { closeStepApproval } = await lifecycle();
    let closed: boolean;
    try {
      closed = await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "The run was cancelled.");
    } finally {
      const { registerChainGates } = await import("../../packages/broker/src/chains/gates.js");
      registerChainGates();
    }
    expect(closed).toBe(true);
    expect(told).toEqual([]);
    const record = await w.stepApproval(approvalId);
    expect(record).toMatchObject({ status: "EXPIRED", closedReason: "The run was cancelled.", closedBy: "system", handlerDone: true });
    expect(record.decidedBy).toBeUndefined();
    expect(w.db.get(openApprovalKey(before.expiresAt, ORG_A, approvalId))).toBeUndefined();
    for (const developerId of (before.approvers as unknown as { candidates: string[] }).candidates) expect(w.db.get(approverIndexKey(ORG_A, developerId, approvalId))).toBeUndefined();
    // The run itself is not touched: closing an approval is not ending a run.
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    // Closed once: again, it is left as it is.
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "Again.")).toBe(false);
    expect((await w.stepApproval(approvalId)).closedReason).toBe("The run was cancelled.");
  });

  it("closes only the gate of the run it is asked about", async () => {
    const w = setupGateWorld();
    const one = await w.runAtGate(PRIYA);
    const two = await w.runAtGate(PRIYA);
    const { closeStepApproval } = await lifecycle();
    expect(await closeStepApproval(w.deps, ORG_A, two.run.runId, one.approvalId, "Wrong run.")).toBe(false);
    expect((await w.approval(one.approvalId)).status).toBe("PENDING");
    expect(await closeStepApproval(w.deps, ORG_B, one.run.runId, one.approvalId, "Wrong org.")).toBe(false);
    expect((await w.approval(one.approvalId)).status).toBe("PENDING");
  });

  it("leaves a record that has been decided alone", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    await w.decideAs(PRIYA, approvalId, "approve");
    const { closeStepApproval } = await lifecycle();
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "Late.")).toBe(false);
    expect((await w.approval(approvalId)).status).toBe("APPROVED");
  });

  it("leaves a write approval alone, and an approval that is not there", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const key = approvalKey(ORG_A, approvalId);
    const item = w.db.get(key)!;
    const write = approvalKey(ORG_A, "apr_wwwwwwwwwwwwwwwwwwww");
    w.db.set({ ...item, ...write, approvalId: "apr_wwwwwwwwwwwwwwwwwwww", kind: "write", subject: { kind: "chain_gate", chainRunId: run.runId, seq: 2 } });
    const { closeStepApproval } = await lifecycle();
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, "apr_wwwwwwwwwwwwwwwwwwww", "x")).toBe(false);
    expect(w.db.get(write)).toMatchObject({ status: "PENDING" });
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, "apr_nnnnnnnnnnnnnnnnnnnn", "x")).toBe(false);
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, "not-an-approval", "x")).toBe(false);
  });
});

// ---- the route

describe("POST /v1/app/chain-runs/{id}/cancel", () => {
  const post = async (w: GateWorld, developerId: string, path: string, body: unknown, method = "POST") => {
    const request = { method, path, requestId: "r", headers: {}, body: JSON.stringify(body) };
    return routeChainRequest(w.deps, callerOf(developerId), request, new URL(`https://cell.example.com${path}`)) as Promise<{ status?: number; body?: unknown; run?: Record<string, unknown> }>;
  };

  it("cancels the run for its starter and shows the run", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const reply = await post(w, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() });
    expect(reply).toMatchObject({ run: { runId: run.runId, status: "cancelled" } });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("refuses a viewer with 403 and the plan's words, and a stranger's run with 404", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const name = (await w.chainOf(chain.chainId)).name;
    const viewer = await refusal(post(w, VIV, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() }));
    expect(viewer).toEqual({ code: "FORBIDDEN", message: `Only the person who started this run, ${name}'s owner or a maintainer of web can stop it.` });
    const stranger = await refusal(routeChainRequest(w.deps, callerOf(STRANGER, ORG_B), { method: "POST", path: `/v1/app/chain-runs/${run.runId}/cancel`, requestId: "r", headers: {}, body: JSON.stringify({ requestId: randomUUID() }) }, new URL(`https://cell.example.com/v1/app/chain-runs/${run.runId}/cancel`)));
    expect(stranger?.code).toBe("NOT_FOUND");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("wants a request id and nothing else in the body, and only POST", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    expect((await refusal(post(w, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, {})))?.code).toBe("CONFIG_INVALID");
    expect((await refusal(post(w, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID(), extra: 1 })))?.code).toBe("CONFIG_INVALID");
    expect((await refusal(post(w, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() }, "GET")))?.code).toBe("NOT_FOUND");
    expect((await refusal(post(w, PRIYA, `/v1/app/chain-runs/not-a-run/cancel`, { requestId: randomUUID() })))?.code).toBe("NOT_FOUND");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("answers 409 CHAIN_RUN_CLOSED for a run that has ended", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await failTask(w, "task-1");
    expect(await refusal(post(w, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() }))).toMatchObject({ code: "CHAIN_RUN_CLOSED" });
  });
});

// ---- the port to Plan 3's cancel

describe("the cancel port", () => {
  it("asks the starter to cancel as the task's owner, with the request id it was given", async () => {
    const { chainRunPortsFor } = await runner();
    const calls: Array<{ developerId: string; taskId: string; requestId: string }> = [];
    const starter = {
      callerFor: async (_orgId: string, developerId: string) => ({ developerId, orgId: ORG_A, orgRole: "member" }),
      cancelTask: async (caller: { developerId: string }, taskId: string, requestId: string) => { calls.push({ developerId: caller.developerId, taskId, requestId }); },
    };
    const ports = chainRunPortsFor(starter as never);
    await ports.cancelTask({ orgId: ORG_A, taskId: "task-9", owner: { developerId: PRIYA }, requestId: "r-1" });
    expect(calls).toEqual([{ developerId: PRIYA, taskId: "task-9", requestId: "r-1" }]);
  });

  it("does nothing for an owner who is no longer a member (Plan 3 ended their tasks), and fails closed where the starter can't cancel", async () => {
    const { chainRunPortsFor } = await runner();
    const gone = chainRunPortsFor({ callerFor: async () => undefined, cancelTask: async () => { throw new Error("must not be called"); } } as never);
    await expect(gone.cancelTask({ orgId: ORG_A, taskId: "task-9", owner: { developerId: PRIYA }, requestId: "r-1" })).resolves.toBeUndefined();
    const none = chainRunPortsFor({ callerFor: async (_orgId: string, developerId: string) => ({ developerId, orgId: ORG_A, orgRole: "member" }) } as never);
    expect((await refusal(none.cancelTask({ orgId: ORG_A, taskId: "task-9", owner: { developerId: PRIYA }, requestId: "r-1" })))?.code).toBe("RUNTIME_UNAVAILABLE");
  });
});
