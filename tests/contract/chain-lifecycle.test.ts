// Plan 4 Task 9: failure, timeouts, retries and cancel. An attempt that failed or timed out is tried again while its step has retries left (never two attempts of a step at
// once); a step, a gate and a whole run have their times; `sweepChainRuns` finds the work a lost callback or a dead process left behind; and a person (or a maintainer, or the
// chain's owner) can stop a run. Task 6's, 7's and 8's guarantees hold on every path here: a step ends at most once, a budget pause is never a failure or a retry, a state change
// and its event are one transaction, and a run's end releases its place in the chain once.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@rovara-code/contracts";
import { approvalKey, approverIndexKey, chainKey, chainRunKey, openApprovalKey, openChainRunKey, stepSk } from "@rovara-code/contracts";
import { orgOpenApprovalKey } from "@agentx/cloud-contracts";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
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
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 4, traversals: { "look>look": 1 } });
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


describe("the sweep: what it looks at and when it looks again", () => {
  const dueAtOf = (w: GateWorld, runId: string) => w.run(runId)!.dueAt;
  const at = (w: GateWorld, minutes: number) => new Date(w.clock.now + minutes * MIN).toISOString();

  it("looks at a run that is due exactly now, and at nothing before", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 5 * MIN - 1;
    expect((await sweep(w)).examined).toBe(0);
    w.clock.now += 1;
    expect((await sweep(w)).examined).toBe(1);
    expect(dueAtOf(w, run.runId)).toBe(at(w, 5));
  });

  it("looks again in 5 minutes at a run with a step going", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(dueAtOf(w, run.runId)).toBe(at(w, 5));
  });

  it("looks again when the step is due to run out, if that comes first", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 7 }));
    const start = w.clock.now;
    const run = await w.start(chain.chainId);
    w.clock.now += 5 * MIN;
    await sweep(w);
    expect(dueAtOf(w, run.runId)).toBe(new Date(start + 7 * MIN).toISOString());
  });

  it("never looks later than the run's own time", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 600 }, { maxRunUsd: 30, maxRunHours: 1 }));
    const start = w.clock.now;
    const run = await w.start(chain.chainId);
    w.clock.now += 58 * MIN;
    await sweep(w);
    expect(dueAtOf(w, run.runId)).toBe(new Date(start + 60 * MIN).toISOString());
  });

  it("looks at a gate every half hour, and when it expires if that comes first", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(dueAtOf(w, run.runId)).toBe(at(w, 30));
    const hourly = setupGateWorld();
    const chain = await hourly.publish({
      start: "look", limits: { maxRunUsd: 30 },
      steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "approve" }), { kind: "gate", id: "approve", name: "Approve it", prompt: "Go ahead?", approvers: [{ kind: "starter" }], timeoutHours: 1, onApprove: { to: "$end" }, onReject: { to: "$end" } }],
    });
    const start = hourly.clock.now;
    const gated = await hourly.start(chain.chainId);
    await hourly.endLatest();
    // The gate's own time is sooner than the first look; the run is looked at then, and again when it expires.
    hourly.clock.now = start + 40 * MIN;
    await sweep(hourly);
    expect(hourly.run(gated.runId)!.dueAt).toBe(new Date(start + 60 * MIN).toISOString());
  });

  it("looks again in 5 minutes at a gate whose approval is past its time and still PENDING", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    w.clock.now += 73 * HOUR;
    await sweep(w);
    expect(dueAtOf(w, run.runId)).toBe(at(w, 5));
  });

  it("deletes an item it can't read, and stops when it has no time left", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ pk: "OPEN_CHAIN_RUNS", sk: `${new Date(w.clock.now - MIN).toISOString()}#junk`, entityType: "OPEN_CHAIN_RUN" });
    const report = await sweep(w);
    expect(report).toEqual({ examined: 1, failed: 0 });
    expect(w.openItems()).toHaveLength(1);
    w.clock.now += 6 * MIN;
    expect(await (await lifecycle()).sweepChainRuns(w.deps, w.clock.now, { budgetMs: -1 })).toEqual({ examined: 0, failed: 0 });
    expect(w.run(run.runId)!.version).toBe(2);
  });

  it("ends a run exactly at its time, and cancels a step exactly at its time", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 30 }, { maxRunUsd: 30, maxRunHours: 1 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 30 * MIN;
    await sweep(w);
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
    w.clock.now += 30 * MIN;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout" } });
  });

  it("starts the first step of a run that has none yet, because the process died after the run was made", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    w.beforeTransaction("step_started", () => { throw new Error("the process died"); });
    const run = await w.start(chain.chainId);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 0 });
    expect(startedAgain(w)).toBe(0);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toMatchObject([{ seq: 1, status: "running", taskId: "task-1" }]);
    expect(startedAgain(w)).toBe(1);
  });

  it("moves a run on whose attempt ended without the run hearing of it", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: "succeeded", result: { report: "Found it." }, endedAt: new Date(w.clock.now).toISOString() });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toMatchObject([{ status: "succeeded" }, { stepId: "act", status: "running" }]);
    expect(w.starts[1]!.input.context).toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining("Found it.") as string })]));
  });

  it("does not take a lost end's report from another org's agent run", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, outcome: "succeeded", handlersTold: 0, done: false });
    setAgentRun(w, "task-1", { orgId: ORG_B, state: "COMPLETE", finalReport: "from another org" });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(JSON.stringify(w.attempts(run.runId)[0])).not.toContain("from another org");
  });

  it("finishes an ending whose chain count has drifted to 0, and leaves it at 0", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const dead = await w.start(chain.chainId);
    w.db.set({ ...runItem(w, dead.runId), status: "failed", endedAt: new Date(w.clock.now).toISOString() });
    w.db.set({ ...w.db.get(chainKey(ORG_A, chain.chainId, "META"))!, openRuns: 0 });
    w.clock.now += 6 * MIN;
    expect((await sweep(w)).failed).toBe(0);
    expect(w.openItems()).toEqual([]);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
    expect(w.logs.map((line) => line.event)).toContain("chain_run.open_runs_drifted");
  });

  it("gives one place back when two finishers meet", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    await refusal((await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId }));
    expect(await openRunsOf(w, chain.chainId)).toBe(2);
    // The sweep is about to give the place back when the same request arrives again and finishes it first.
    w.beforeTransaction("attribute_exists", async () => { await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId }); });
    await sweep(w);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
    expect(w.openItems()).toHaveLength(1);
  });

  it("does not say where the cancel's request id comes from: it is not the step's own start request id", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    expect(w.cancels[0]!.requestId).not.toBe(w.starts[0]!.requestId);
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
    await endTask(w, "task-1", { outcome: "cancelled" });
    // The task's own end adds its spend to the run once, and nothing else moves.
    expect(w.run(run.runId)).toMatchObject({ spentUsd: 0.5 });
    const version = w.run(run.runId)!.version;
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
    expect(w.cancels).toHaveLength(1);
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
    expect(w.db.get(orgOpenApprovalKey(ORG_A, record.createdAt, approvalId)), "the company's open index item goes in the same transaction").toBeUndefined();
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
    // Asked by the cancel (which finds the task through Plan 3's request item) and again when the start is recorded: one cancel request id, so Plan 3 answers the repeat as the first.
    expect([...new Set(w.cancels.map((cancel) => cancel.taskId))]).toEqual(["task-1"]);
    expect(new Set(w.cancels.map((cancel) => cancel.requestId)).size).toBe(1);
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


describe("who may stop a run on a project's chain", () => {
  it("lets a contributor who started the run stop it, and refuses another contributor", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps(), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    const run = await w.start(chain.chainId, CARL);
    const { cancelChainRun } = await lifecycle();
    expect((await refusal(cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() })))?.code).toBe("FORBIDDEN");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
    expect((await cancelChainRun(w.deps, callerOf(CARL), run.runId, { requestId: randomUUID() })).status).toBe("cancelled");
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
    expect(w.db.get(orgOpenApprovalKey(ORG_A, before.createdAt, approvalId))).toBeUndefined();
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

  it("does not overwrite a record that was decided between its read and its write", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const { closeStepApproval } = await lifecycle();
    w.beforeTransaction("closedReason", () => { w.db.set({ ...w.db.get(approvalKey(ORG_A, approvalId))!, status: "APPROVED", decidedBy: PRIYA }); });
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "The run was cancelled.")).toBe(false);
    expect(w.db.get(approvalKey(ORG_A, approvalId))).toMatchObject({ status: "APPROVED" });
    expect(w.db.get(approvalKey(ORG_A, approvalId))!.closedBy).toBeUndefined();
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

// ---- what the first mutation pass found unpinned

describe("an attempt that timed out is told apart from one that failed, and is told in its own words", () => {
  it("keeps a task's own failure as its own when the cancel was not what ended it", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    await failTask(w, "task-1", "The tool broke first");
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "failed", failure: { reason: "step_failed", message: "The tool broke first" } });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { message: 'Step "Look into it" failed: The tool broke first.' } });
  });

  it("says the step's own limit in its words", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 30 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 31 * MIN;
    await sweep(w);
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.run(run.runId)!.failure!.message).toBe('Step "Look into it" failed: it ran longer than 30 minutes.');
  });

  it("asks for the cancel of each attempt under its own request id", async () => {
    const w = setupGateWorld();
    const { cancelRequestId } = await lifecycle();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    await endTask(w, "task-1", { outcome: "cancelled" });
    w.clock.now += 121 * MIN;
    await sweep(w);
    expect(w.cancels.map((cancel) => cancel.requestId)).toEqual([cancelRequestId(run.runId, 1), cancelRequestId(run.runId, 2)]);
    expect(cancelRequestId(run.runId, 1)).not.toBe(cancelRequestId(run.runId, 2));
  });

  it("does not cancel a task that ended between the sweep's read and its flag, and does not flag one that was paused meanwhile", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const ended = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    w.beforeTransaction("timedOutAt", async () => { await endTask(w, "task-1", { finalReport: "Just in time." }); });
    await sweep(w);
    expect(w.cancels).toEqual([]);
    expect(w.attempts(ended.runId)[0]).toMatchObject({ status: "succeeded" });
    expect(w.attempts(ended.runId)[0]!.timedOutAt).toBeUndefined();
    const paused = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    const { onStepTaskPaused } = await runner();
    w.beforeTransaction("timedOutAt", async () => { await onStepTaskPaused(w.deps, w.pauseEvent("task-3")); });
    await sweep(w);
    // (The first run's next step has been going 121 minutes too, and is asked to stop; the paused one is not.)
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-2"]);
    expect(w.attempts(paused.runId)[0]).toMatchObject({ status: "paused" });
    expect(w.attempts(paused.runId)[0]!.timedOutAt).toBeUndefined();
  });

  it("goes on when the attempt it was marking the clock of ended meanwhile, and when the run moved as it was rescheduled", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    w.clock.now += 6 * MIN;
    w.beforeTransaction("timeoutBase", async () => { await endTask(w, "task-1", { finalReport: "Done." }); });
    expect(await sweep(w)).toEqual({ examined: 1, failed: 0 });
    const other = await w.start(chain.chainId);
    w.clock.now += 6 * MIN;
    w.beforeTransaction("OPEN_CHAIN_RUN", () => { w.touchRun(other.runId); });
    expect((await sweep(w)).failed).toBe(0);
    expect(w.logs.map((line) => line.event)).not.toContain("chain_sweep.reschedule_failed");
    expect(w.run(run.runId)).toBeDefined();
  });
});

describe("a run that drifted when a gate times out", () => {
  it("still marks the gate's attempt timed out when the chain's count is already 0", async () => {
    const w = setupGateWorld();
    const { run, chain } = await w.runAtGate();
    w.db.set({ ...w.db.get(chainKey(ORG_A, chain.chainId, "META"))!, openRuns: 0 });
    w.clock.now += 73 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "timed_out" });
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });
});

describe("a task started for a run that was stopped meanwhile", () => {
  const stopDuringStart = async (w: GateWorld, stop: () => Promise<unknown>) => {
    const chain = await w.publish(twoSteps());
    w.beforeTransaction("taskId", async () => { await stop(); });
    return { chain, run: await w.start(chain.chainId, PRIYA) };
  };

  it("is asked to stop under the attempt's own cancel request id, also when the run timed out", async () => {
    const w = setupGateWorld();
    const { cancelRequestId } = await lifecycle();
    const { run } = await stopDuringStart(w, async () => { w.clock.now += 169 * HOUR; await sweep(w); });
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out" });
    // Asked once by the sweep's ending and once when the start is recorded: one request id, which Plan 3 answers as the same cancel.
    expect(w.cancels.length).toBeGreaterThanOrEqual(1);
    for (const cancel of w.cancels) expect(cancel).toMatchObject({ taskId: "task-1", requestId: cancelRequestId(run.runId, 1) });
  });

  it("is left to answer for itself when it can't be asked: the start still finishes", async () => {
    const w = setupGateWorld();
    const { run } = await stopDuringStart(w, async () => {
      const id = w.db.find((item) => item.entityType === "CHAIN_RUN")[0]!.runId as string;
      await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), id, { requestId: randomUUID() });
      w.hooks.cancelFails.push(new Error("the worker is not reachable"));
    });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(w.logs.map((line) => line.event)).toContain("chain_run.abandoned_task_not_cancelled");
  });
});

describe("an approval made for a gate the run did not enter, in more detail", () => {
  const raceWith = async (w: GateWorld, then: (runId: string) => void) => {
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    w.beforeTransaction("gate_waiting", () => { then(run.runId); });
    await w.endLatest({ branch: "fix" });
    const approval = w.db.find((item) => item.entityType === "APPROVAL" && (item.subject as { kind?: string } | undefined)?.kind === "chain_gate")[0]!;
    return { run, approval };
  };

  it("is closed, with the words of why, when the run moved on to another step in the gate's place", async () => {
    const w = setupGateWorld();
    const { approval } = await raceWith(w, (runId) => {
      const meta = runItem(w, runId);
      w.db.set({ ...meta, currentSeq: 2, version: (meta.version as number) + 1 });
      w.db.set({ ...chainRunKey(ORG_A, runId, stepSk(2)), entityType: "CHAIN_RUN_STEP", orgId: ORG_A, runId, seq: 2, stepId: "fix", stepName: "Fix it", kind: "agent", attempt: 1, status: "running", inputDigest: "x", startedAt: new Date(w.clock.now).toISOString() });
    });
    expect(approval).toMatchObject({ status: "EXPIRED", closedReason: "The run moved on before this gate opened." });
  });

  it("is kept when the run moved on to this very gate, entered by someone else under the same approval", async () => {
    const w = setupGateWorld();
    const { approval } = await raceWith(w, (runId) => {
      const meta = runItem(w, runId);
      const approvalId = w.db.find((item) => item.entityType === "APPROVAL")[0]!.approvalId as string;
      w.db.set({ ...meta, currentSeq: 2, status: "waiting", version: (meta.version as number) + 1 });
      w.db.set({ ...chainRunKey(ORG_A, runId, stepSk(2)), entityType: "CHAIN_RUN_STEP", orgId: ORG_A, runId, seq: 2, stepId: "approve_fix", stepName: "Approve the fix", kind: "gate", attempt: 1, status: "waiting", approvalId, inputDigest: "x", startedAt: new Date(w.clock.now).toISOString() });
    });
    expect(approval).toMatchObject({ status: "PENDING" });
  });

  it("does not make the lost race an error when it can't be closed", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    const { cancelChainRun } = await lifecycle();
    w.beforeTransaction("gate_waiting", async () => { await cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() }); });
    w.beforeTransaction("closedReason", () => { throw new Error("the table is unavailable"); });
    await expect(w.endLatest({ branch: "fix" })).resolves.toBeUndefined();
    expect(w.logs.map((line) => line.event)).toContain("chain_run.abandoned_gate_not_closed");
  });
});

describe("closing an approval, when the record changes under the close", () => {
  it.each([
    ["is no longer a step approval", { kind: "write" }],
    ["is another run's gate", { subject: { kind: "chain_gate", chainRunId: "crn_zzzzzzzzzzzzzzzzzzzz", seq: 2 } }],
    ["is a step of an agent's run, not a gate", { subject: { kind: "agent_run", taskId: "task-1", stepId: "x" } }],
    ["is another org's", { orgId: ORG_B }],
  ])("leaves a record that %s between its read and its write", async (_name, change) => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const { closeStepApproval } = await lifecycle();
    w.beforeTransaction("closedReason", () => { w.db.set({ ...w.db.get(approvalKey(ORG_A, approvalId))!, ...change }); });
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "x")).toBe(false);
    expect(w.db.get(approvalKey(ORG_A, approvalId))!.closedBy).toBeUndefined();
    expect(w.db.get(approvalKey(ORG_A, approvalId))!.status).toBe("PENDING");
  });
});

describe("finishing an ending, in more detail", () => {
  it("does not ask for a cancel again when the ending is already finished", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    const { cancelChainRun } = await lifecycle();
    await cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId });
    await cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels).toHaveLength(1);
  });

  it("drops an item that is not the run's own, when the run has ended and its own item is gone, and when both are there", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const one = await w.start(chain.chainId);
    const two = await w.start(chain.chainId);
    for (const run of [one, two]) w.db.set({ ...runItem(w, run.runId), status: "failed", endedAt: new Date(w.clock.now).toISOString() });
    const staleKey = (runId: string) => openChainRunKey(new Date(w.clock.now - MIN).toISOString(), ORG_A, runId);
    const ownOne = openChainRunKey(one.dueAt, ORG_A, one.runId);
    w.db.delete(ownOne.pk, ownOne.sk);
    for (const run of [one, two]) w.db.set({ ...staleKey(run.runId), entityType: "OPEN_CHAIN_RUN", orgId: ORG_A, runId: run.runId });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.openItems()).toEqual([]);
    // Only the run that still had its own item gave a place back.
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
  });

  it("gives one place back when another finisher gets in first, whichever of the two is quicker", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await w.start(chain.chainId, PRIYA);
    const { cancelChainRun } = await lifecycle();
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    const requestId = randomUUID();
    await refusal(cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId }));
    expect(await openRunsOf(w, chain.chainId)).toBe(2);
    // The sweep's finishing is about to commit when the same request finishes it first.
    w.beforeTransaction('"openRuns"', async () => { await cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId }); });
    expect((await sweep(w)).failed).toBe(0);
    expect(await openRunsOf(w, chain.chainId)).toBe(1);
  });
});

describe("cancelling, in more detail", () => {
  const cancelAs = async (w: GateWorld, developerId: string, runId: string, requestId: string = randomUUID()) => (await lifecycle()).cancelChainRun(w.deps, callerOf(developerId), runId, { requestId });

  it("stops a paused step too", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    await cancelAs(w, PRIYA, run.runId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled" });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("answers CHAIN_RUN_CLOSED, and does not end it again, when the run ended while the cancel was written", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.beforeTransaction("cancelledBy", async () => { await failTask(w, "task-1", "Broke"); });
    expect((await refusal(cancelAs(w, PRIYA, run.runId)))?.code).toBe("CHAIN_RUN_CLOSED");
    expect(w.run(run.runId)).toMatchObject({ status: "failed" });
    expect(w.cancels).toEqual([]);
  });

  it("gives up with a busy answer when the run keeps changing under the cancel, and leaves it running", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.beforeTransaction("cancelledBy", () => { w.touchRun(run.runId); }, 3);
    expect((await refusal(cancelAs(w, PRIYA, run.runId)))?.code).toBe("WORKSPACE_BUSY");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("answers a request that is already being answered with its outcome, once", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const requestId = randomUUID();
    w.beforeTransaction("cancelledBy", async () => { await cancelAs(w, PRIYA, run.runId, requestId); });
    expect((await cancelAs(w, PRIYA, run.runId, requestId)).status).toBe("cancelled");
    expect(w.cancels).toHaveLength(1);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("wants a request id that is a UUID", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    expect((await refusal(cancelAs(w, PRIYA, run.runId, "not-a-uuid")))?.code).toBe("CONFIG_INVALID");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("lets a maintainer, and not the person nobody sees, stop a run that an event started", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const { startChainRun } = await runner();
    const started = await startChainRun(w.deps, { system: "event", owner: { developerId: PRIYA } }, {
      orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "event",
      startedBy: { kind: "event", triggerId: "ctr_aaaaaaaaaaaaaaaaaaaa", eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors" },
      trigger: { eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", subject: { kind: "alert", title: "Refund errors" } }, requestId: randomUUID(),
    } as never);
    expect((await refusal(cancelAs(w, CARL, started.runId)))?.code).toBe("FORBIDDEN");
    expect((await cancelAs(w, MAX, started.runId)).status).toBe("cancelled");
    expect(w.cancels.map((cancel) => cancel.owner.developerId)).toEqual([PRIYA]);
  });
});

describe("the sweep recovers a lost end, in more detail", () => {
  it("takes the branch the task chose, not only its report", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, outcome: "succeeded", handlersTold: 0, done: false });
    setAgentRun(w, "task-1", { state: "COMPLETE", finalReport: "The cause is in our code.", branch: "fix" });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded", branch: { id: "fix", fellBack: false } });
    expect(w.attempts(run.runId)[1]).toMatchObject({ kind: "gate", status: "waiting" });
  });

  it("does nothing for an end record with no outcome, or for a task that is another org's", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, handlersTold: 0, done: false });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toMatchObject([{ status: "running" }]);
    w.db.set({ ...taskEndKey("task-1"), entityType: "TASK_END", orgId: ORG_A, outcome: "succeeded", handlersTold: 0, done: false });
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-1", sk: "META" })!, orgId: ORG_B });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.attempts(run.runId)).toMatchObject([{ status: "running" }]);
  });
});

describe("how often a gate is looked at", () => {
  it("looks at a gate with the default time every half hour, however long since it opened", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    const start = w.clock.now;
    w.clock.now = start + 6 * MIN;
    await sweep(w);
    w.clock.now = start + 40 * MIN;
    await sweep(w);
    expect(w.run(run.runId)!.dueAt).toBe(new Date(start + 70 * MIN).toISOString());
  });
});

describe("POST /v1/app/chain-runs/{id}/cancel, in more detail", () => {
  const request = (path: string, body: unknown) => ({ method: "POST", path, requestId: "r", headers: {}, body: JSON.stringify(body) });
  const call = (deps: GateWorld["deps"], developerId: string, path: string, body: unknown) => routeChainRequest(deps, callerOf(developerId), request(path, body), new URL(`https://cell.example.com${path}`)) as Promise<{ run: Record<string, unknown> }>;

  it("is not a route with more in its path", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    expect((await refusal(call(w.deps, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel/now`, { requestId: randomUUID() })))?.code).toBe("NOT_FOUND");
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
  });

  it("answers 'not set up' where there are no chain runs, and an id that is no run's before the body is read", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const bare = { ...w.deps } as Record<string, unknown>;
    delete bare["chainRuns"];
    expect(await refusal(call(bare as never, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() }))).toEqual({ code: "NOT_FOUND", message: "chain runs are not set up in this deployment" });
    expect((await refusal(call(w.deps, PRIYA, "/v1/app/chain-runs/nope/cancel", {})))?.code).toBe("NOT_FOUND");
  });

  it("shows the run as its starter is shown it, with the end", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    const reply = await call(w.deps, PRIYA, `/v1/app/chain-runs/${run.runId}/cancel`, { requestId: randomUUID() });
    expect(reply.run).toMatchObject({ runId: run.runId, chainId: chain.chainId, project: "web", status: "cancelled", startedBy: { kind: "member", developerId: PRIYA }, endedAt: new Date(w.clock.now).toISOString() });
  });
});

// ---- Task 9 review findings

describe("an attempt past its time that a person stopped, or that a person's decline stopped, is not a timeout", () => {
  it("ends the run cancelled, with no retry, when a person cancelled the task after the sweep flagged it but before its own cancel was taken", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    // The sweep flags the attempt, but Plan 3 does not take its cancel (the worker can't be asked).
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    await sweep(w);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", timedOutAt: expect.any(String) as string });
    // A person's own cancel ends the task.
    setAgentRun(w, "task-1", { endReason: "Cancelled by the person who started it." });
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.attempts(run.runId)).toHaveLength(1);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled", failure: { reason: "step_cancelled" } });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(w.events(run.runId).some((event) => event.type === "retrying" || event.text.includes("ran out of time"))).toBe(false);
    expect(startedAgain(w)).toBe(1);
    expect(await openRunsOf(w, chain.chainId)).toBe(0);
  });

  it("ends the run cancelled with the decline's words, and starts no retry, when a declined write approval ended the task", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 2 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    expect(w.cancels).toHaveLength(1);
    setAgentRun(w, "task-1", { endReason: "Look into it declined: Push the fix to main?" });
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled", failure: { message: "Look into it declined: Push the fix to main?" } });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", failure: { message: "Look into it declined: Push the fix to main?" } });
    expect(startedAgain(w)).toBe(1);
  });

  it("still takes the cancel the sweep itself asked for (and Plan 3 took) as a timeout, and retries it", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ retries: 1 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 121 * MIN;
    await sweep(w);
    setAgentRun(w, "task-1", { endReason: "Cancelled by the person who started it." });
    await endTask(w, "task-1", { outcome: "cancelled" });
    expect(w.attempts(run.runId)).toMatchObject([{ status: "timed_out" }, { status: "running", attempt: 2 }]);
    expect(startedAgain(w)).toBe(2);
  });
});

describe("the spend of the task of a run that was stopped", () => {
  const tellEnd = (w: GateWorld, spentUsd: number) => endTask(w, "task-1", { outcome: "cancelled", spentUsd });

  it("is added to the run's spentUsd when the task of a cancelled run ends, once however often the end is told", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", spentUsd: 0 });
    await tellEnd(w, 0.75);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", spentUsd: 0.75 });
    await tellEnd(w, 0.75);
    await Promise.all([tellEnd(w, 0.75), tellEnd(w, 0.75)]);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", spentUsd: 0.75 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled" });
    expect(w.events(run.runId).filter((event) => event.type === "ended")).toHaveLength(1);
  });

  it("is added when the run timed out and the task's end comes after, and the run's own end changes nothing else", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps({ timeoutMinutes: 1440 }));
    const run = await w.start(chain.chainId);
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", spentUsd: 0 });
    await tellEnd(w, 1.25);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", spentUsd: 1.25, failure: { reason: "run_timeout" } });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout" } });
  });

  it("is added when the cancel lands between the end's read and its write, so the end's own transaction loses", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    w.beforeTransaction('"step_ended"', async () => { await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() }); });
    await tellEnd(w, 0.75);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", spentUsd: 0.75 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled", spendPending: false });
  });

  it("is not counted twice for a step that ended by its own end before the run was stopped", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    const run = await w.start(chain.chainId, PRIYA);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 1 });
    await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 1 });
    await endTask(w, "task-2", { outcome: "cancelled", spentUsd: 0.5 });
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", spentUsd: 1.5 });
  });
});

describe("a gate that was approved but not applied when the run's time is up", () => {
  const decided = (w: GateWorld, approvalId: string, status: "APPROVED" | "DECLINED") => {
    w.db.set({
      ...w.db.get(approvalKey(ORG_A, approvalId))!, status, handlerDone: false,
      decidedBy: MAX, decidedAt: new Date(w.clock.now).toISOString(), decision: status === "APPROVED" ? "APPROVE" : "DECLINE",
    });
  };

  it("applies the approval before the run's time is looked at: the gate is passed as approved, and the run's end carries the run's own words", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    decided(w, approvalId, "APPROVED");
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "approved" });
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
    expect(w.attempts(run.runId)[1]!.failure).toBeUndefined();
    // The step it opened is past the run's time and is stopped with it, in the run's words.
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout", message: "This run took longer than 168 hours, so the chain stopped." } });
    expect(w.attempts(run.runId)[2]).toMatchObject({ stepId: "fix", status: "timed_out", failure: { reason: "run_timeout" } });
    expect(JSON.stringify(w.run(run.runId))).not.toContain("No one approved");
  });

  it("lets a decision that ends the run win over the run's time: a declined gate whose edge ends the run leaves it succeeded", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    decided(w, approvalId, "DECLINED");
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "declined" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
  });

  it("still ends a run that waits at a gate whose approval is PENDING when its time is up", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.clock.now += 169 * HOUR;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "run_timeout" } });
    expect((await w.approval(approvalId)).status).toBe("EXPIRED");
  });
});

describe("closing a gate's approval writes its audit item in the close's own transaction", () => {
  it("leaves the audit item pending, with the close, when the intake queue is down", async () => {
    const w = setupGateWorld({ audit: true });
    const { run, approvalId } = await w.runAtGate(PRIYA);
    w.audit!.queueDown();
    const { closeStepApproval } = await lifecycle();
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "The run was cancelled.")).toBe(true);
    expect(w.audit!.pending().filter((event) => event.action === "approval.expired")).toMatchObject([{ action: "approval.expired", actor: { kind: "system" }, target: { id: approvalId }, facts: { kind: "step", subjectKind: "chain_gate" } }]);
  });

  it("writes none when the close loses its race: the record was decided between the read and the write", async () => {
    const w = setupGateWorld({ audit: true });
    const { run, approvalId } = await w.runAtGate(PRIYA);
    w.audit!.queueDown();
    const { closeStepApproval } = await lifecycle();
    w.beforeTransaction("closedReason", () => { w.db.set({ ...w.db.get(approvalKey(ORG_A, approvalId))!, status: "APPROVED", decidedBy: PRIYA }); });
    expect(await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "The run was cancelled.")).toBe(false);
    expect(w.audit!.recordedBy("approval.expired")).toEqual([]);
  });

  it("writes the audit item together with the record's change, not after it: a transaction that fails takes the audit item with it", async () => {
    const w = setupGateWorld({ audit: true });
    const { run, approvalId } = await w.runAtGate(PRIYA);
    const { closeStepApproval } = await lifecycle();
    const sent: string[][] = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command: { constructor: { name: string }; input: { TransactItems?: Array<Record<string, { Item?: { pk?: string }; Key?: { pk?: string } }>> } }) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("closedReason")) {
        sent.push((command.input.TransactItems ?? []).map((item) => String((item["Put"]?.Item ?? item["Update"]?.Key ?? item["Delete"]?.Key)?.pk)));
      }
      return send(command);
    };
    await closeStepApproval(w.deps, ORG_A, run.runId, approvalId, "The run was cancelled.");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.some((pk) => pk.startsWith("AUDIT_PENDING#"))).toBe(true);
    expect(sent[0]!.some((pk) => pk.includes(approvalId))).toBe(true);
  });
});

describe("a task the run's start made that no attempt names, when the run is stopped", () => {
  /** A start that died after Plan 3 committed: the task and its request item exist; the attempt is `starting` with no task id. */
  const startDied = async (w: GateWorld) => {
    const chain = await w.publish(twoSteps());
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await w.start(chain.chainId, PRIYA);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "starting" });
    expect(w.attempts(run.runId)[0]).not.toHaveProperty("taskId");
    expect(w.tasks.size).toBe(1);
    return { chain, run };
  };

  it("is found through Plan 3's request item and asked to stop under the attempt's cancel request id, when a person cancels the run", async () => {
    const w = setupGateWorld();
    const { cancelRequestId } = await lifecycle();
    const { run } = await startDied(w);
    const cancelled = await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    expect(cancelled.status).toBe("cancelled");
    expect(w.cancels).toEqual([{ orgId: ORG_A, taskId: "task-1", owner: { developerId: PRIYA }, requestId: cancelRequestId(run.runId, 1) }]);
    expect(w.openItems()).toEqual([]);
  });

  it("is found by the sweep when the cancel could not reach Plan 3, and by a run timeout", async () => {
    const w = setupGateWorld();
    const { run } = await startDied(w);
    w.hooks.cancelFails.push(agentXError("RUNTIME_UNAVAILABLE", "the worker is not reachable"));
    await refusal((await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() }));
    expect(w.cancels).toEqual([]);
    expect(w.openItems()).toHaveLength(1);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
    expect(w.openItems()).toEqual([]);

    const timed = setupGateWorld();
    const died = await startDied(timed);
    timed.clock.now += 169 * HOUR;
    await sweep(timed);
    expect(timed.run(died.run.runId)).toMatchObject({ status: "timed_out" });
    expect(timed.cancels.map((cancel) => cancel.taskId)).toEqual(["task-1"]);
  });

  it("leaves a start that never committed alone: no request item, nothing to cancel", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps());
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await w.start(chain.chainId, PRIYA);
    expect(w.tasks.size).toBe(0);
    const cancelled = await (await lifecycle()).cancelChainRun(w.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    expect(cancelled.status).toBe("cancelled");
    expect(w.cancels).toEqual([]);
    expect(w.openItems()).toEqual([]);
  });

  it("does not look for a task when the run did not end by a stop: a run that failed has no one to ask", async () => {
    const w = setupGateWorld();
    const { run } = await startDied(w);
    w.db.set({ ...runItem(w, run.runId), status: "failed", endedAt: new Date(w.clock.now).toISOString() });
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.cancels).toEqual([]);
  });
});
