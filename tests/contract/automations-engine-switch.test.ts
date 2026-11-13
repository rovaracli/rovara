// Owner decision 143(c), on Cloud's own engine: the automations switch (WEB_FEATURES `chains`) is the engine's too. Off, nothing starts on its own (a trigger's event, a chain's
// next step) and the sweep stops the runs already started at a safe point; on again resumes nothing by itself. Over Cloud's chain runner, lifecycle sweep and trigger dispatch.
import { afterEach, describe, expect, it } from "vitest";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { AUTOMATIONS_OFF_MESSAGE, type AutomationsSwitch } from "../../packages/broker/src/chains/automations-gate.js";
import { sweepChainRuns } from "../../packages/broker/src/chains/lifecycle.js";
import { onStepTaskEnded } from "../../packages/broker/src/chains/runner.js";
import { startChainRun } from "../../packages/broker/src/chains/runner.js";
import { stopRequestIdOf, stopTriggerTasksWhenOff } from "../../packages/broker/src/chains/automations-stop.js";
import { createTaskSessionItems } from "../../packages/broker/src/agent-sessions/create.js";
import { dispatchTriggerEvent, type TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import { DANA, ORG_A, PRIYA, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";
import { setupTriggerWorld } from "../support/trigger-world.js";

afterEach(() => disposeGateWorlds());

const MIN = 60_000;
const twoSteps: ChainDefinitionInput = {
  start: "look", limits: { maxRunUsd: 30 },
  steps: [
    { kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "go", to: "act" } },
    { kind: "agent", id: "act", name: "Act on it", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } },
  ],
};

/** A switch the test flips; set on the world's dependencies the way the broker's wiring does (`chainRunnerDependenciesOf`). */
function withSwitch(w: GateWorld, on = true): { flip: (value: boolean) => void } {
  const state = { on };
  const automations: AutomationsSwitch = { enabled: () => state.on };
  Object.assign(w.deps, { automations });
  return { flip: (value) => { state.on = value; } };
}
const sweep = (w: GateWorld) => sweepChainRuns(w.deps, w.clock.now + 6 * MIN);
const setWorkflow = (w: GateWorld, taskId: string, stage: string, state: string) => w.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", workflow: { stage, state } });

describe("off stops what starts on its own", () => {
  it("a person's run starts, but its first step is refused with the off words and the run fails, as on the core", async () => {
    const w = setupGateWorld();
    const automations = withSwitch(w);
    const chain = await w.publish(twoSteps);
    automations.flip(false);
    const run = await w.start(chain.chainId);
    expect(w.starts).toHaveLength(0);
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { reason: "NOT_AVAILABLE_HERE" } });
    expect(AUTOMATIONS_OFF_MESSAGE).toMatch(/turned off/u);
  });

  it("a trigger's or a schedule's start is refused before anything is written", async () => {
    const w = setupGateWorld();
    withSwitch(w, false);
    const chain = await w.publish(twoSteps);
    await expect(startChainRun(w.deps, { system: "event", owner: { developerId: DANA } }, {
      orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "event", startedBy: { kind: "system", origin: "event" } as never, requestId: "11111111-1111-4111-8111-111111111111",
    } as never)).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
    expect(w.starts).toHaveLength(0);
  });

  it("an agent trigger starts nothing while off, and does while on", async () => {
    const event = {
      source: "github", type: "pull_request.opened", eventKey: "gh:pr:41:opened", occurredAt: "2026-11-12T09:59:00.000Z", project: "web",
      subject: { kind: "pull_request", id: "41", title: "Fix the login redirect", url: "https://github.com/examplehost/web/pull/41" },
      fields: { label: ["bug"], baseBranch: ["main"], authorAssociation: ["MEMBER"] }, actor: { kind: "external", id: "alice" },
    };
    const off = setupTriggerWorld();
    await off.builtinBudget("code-reviewer");
    await off.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DANA });
    Object.assign(off.routeDeps, { automations: { enabled: () => false } });
    await dispatchTriggerEvent(off.routeDeps as unknown as TriggerDispatchDependencies, ORG_A, event as never);
    expect(off.starts).toHaveLength(0);

    const on = setupTriggerWorld();
    await on.builtinBudget("code-reviewer");
    await on.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DANA });
    Object.assign(on.routeDeps, { automations: { enabled: () => true } });
    await dispatchTriggerEvent(on.routeDeps as unknown as TriggerDispatchDependencies, ORG_A, event as never);
    expect(on.starts).toHaveLength(1);
  });

  it("with no switch given the engine behaves as it always did (the harnesses)", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(twoSteps);
    await w.start(chain.chainId);
    expect(w.starts).toHaveLength(1);
  });
});

describe("off cancels running runs at a safe point", () => {
  it("a running run is cancelled by the sweep, its task is asked to stop, and no further step starts", async () => {
    const w = setupGateWorld();
    const automations = withSwitch(w);
    const chain = await w.publish(twoSteps);
    const run = await w.start(chain.chainId);
    setWorkflow(w, "task-1", "IMPLEMENT", "RUNNING");
    automations.flip(false);
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
    expect(w.cancels).toHaveLength(1);
    await onStepTaskEnded(w.deps, w.endEvent("task-1", { outcome: "cancelled" }));
    expect(w.starts).toHaveLength(1);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("a run whose step's task is opening its pull request is left, then stopped once it is done", async () => {
    const w = setupGateWorld();
    const automations = withSwitch(w);
    const chain = await w.publish(twoSteps);
    const run = await w.start(chain.chainId);
    setWorkflow(w, "task-1", "PULL_REQUEST", "RUNNING");
    automations.flip(false);
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "running" });
    expect(w.cancels).toEqual([]);
    setWorkflow(w, "task-1", "WAIT_FOR_MERGE", "WAITING");
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("on resumes nothing by itself: a cancelled run stays cancelled and a sweep with the switch on leaves running runs alone", async () => {
    const w = setupGateWorld();
    const automations = withSwitch(w);
    const chain = await w.publish(twoSteps);
    const stopped = await w.start(chain.chainId, PRIYA);
    setWorkflow(w, "task-1", "IMPLEMENT", "RUNNING");
    automations.flip(false);
    await sweep(w);
    automations.flip(true);
    const live = await w.start(chain.chainId, PRIYA);
    w.clock.now += 6 * MIN;
    await sweep(w);
    expect(w.run(stopped.runId)).toMatchObject({ status: "cancelled" });
    expect(w.run(live.runId)).toMatchObject({ status: "running" });
    expect(w.starts).toHaveLength(2);
  });
});

describe("off also stops the tasks a trigger started on its own (an agent trigger's run, not a chain step)", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  const CHAIN_TASK = "22222222-2222-4222-8222-222222222222";
  const MEMBER_TASK = "33333333-3333-4333-8333-333333333333";

  /** A world with the chain runner's dependencies and three open task sessions: one an event started, one a person started, one an event started that is a chain's. */
  function world() {
    const w = setupGateWorld();
    const switchState = withSwitch(w);
    const table = { documentClient: w.db, tableName: "T" } as never;
    const open = (sessionId: string, taskId: string, startedBy: { kind: "event"; triggerId: string } | { kind: "member"; developerId: string }) => {
      for (const item of createTaskSessionItems(table, {
        orgId: ORG_A, sessionId, taskId, project: "web", agent: { agentId: "code-reviewer", name: "Code reviewer", version: 1 }, title: "Review a pull request", owner: { developerId: PRIYA, name: "Priya" },
        startedBy, origin: startedBy.kind === "member" ? "app" : "event", payer: { kind: "agent", agentId: "code-reviewer" } as never, now: "2026-11-12T10:00:00.000Z",
      })) { const put = (item as { Put?: { Item: Record<string, unknown> } }).Put; if (put !== undefined) w.db.set(put.Item); }
    };
    open("ses_aaaaaaaaaaaaaaaaaaaa", TASK, { kind: "event", triggerId: "ctr_aaaaaaaaaaaaaaaaaaaa" });
    open("ses_bbbbbbbbbbbbbbbbbbbb", MEMBER_TASK, { kind: "member", developerId: PRIYA });
    return { w, ...switchState };
  }
  const workflowOf = (w: GateWorld, taskId: string, stage: string, state: string) => w.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", workflow: { stage, state } });
  void CHAIN_TASK;

  it("stops the trigger's task through the cancel path as the session's owner, and leaves a person's task alone", async () => {
    const { w, flip } = world();
    workflowOf(w, TASK, "IMPLEMENT", "RUNNING");
    workflowOf(w, MEMBER_TASK, "IMPLEMENT", "RUNNING");
    flip(false);
    const report = await stopTriggerTasksWhenOff(w.deps);
    expect(report).toEqual({ examined: 2, stopped: 1, deferred: 0, failed: 0 });
    expect(w.cancels).toEqual([{ orgId: ORG_A, taskId: TASK, owner: { developerId: PRIYA }, requestId: stopRequestIdOf(TASK) }]);
  });

  it("leaves a task that is opening its pull request, and stops it at the next sweep once it is done", async () => {
    const { w, flip } = world();
    workflowOf(w, TASK, "PULL_REQUEST", "RUNNING");
    flip(false);
    expect(await stopTriggerTasksWhenOff(w.deps)).toMatchObject({ stopped: 0, deferred: 1 });
    expect(w.cancels).toEqual([]);
    workflowOf(w, TASK, "WAIT_FOR_MERGE", "WAITING");
    expect(await stopTriggerTasksWhenOff(w.deps)).toMatchObject({ stopped: 1, deferred: 0 });
  });

  it("reads nothing while automations are on, or where the engine has no switch", async () => {
    const { w } = world();
    const before = w.db.commandNames().length;
    expect(await stopTriggerTasksWhenOff(w.deps)).toEqual({ examined: 0, stopped: 0, deferred: 0, failed: 0 });
    expect(w.db.commandNames().length).toBe(before);
    delete (w.deps as { automations?: unknown }).automations;
    expect(await stopTriggerTasksWhenOff(w.deps)).toEqual({ examined: 0, stopped: 0, deferred: 0, failed: 0 });
  });

  it("an ended session is not touched, and a task that cannot be asked to stop is counted as failed, not lost", async () => {
    const { w, flip } = world();
    workflowOf(w, TASK, "IMPLEMENT", "RUNNING");
    flip(false);
    w.hooks.cancelFails.push(new Error("worker unreachable"));
    expect(await stopTriggerTasksWhenOff(w.deps)).toMatchObject({ stopped: 0, failed: 1 });
    const meta = w.db.get({ pk: `ORG#${ORG_A}#AGENT_SESSION#ses_aaaaaaaaaaaaaaaaaaaa`, sk: "META" })!;
    w.db.set({ ...meta, endedAt: "2026-11-12T11:00:00.000Z" });
    expect(await stopTriggerTasksWhenOff(w.deps)).toMatchObject({ stopped: 0, failed: 0 });
  });

  it("the stop request id is stable and a version 4 id", () => {
    expect(stopRequestIdOf(TASK)).toBe(stopRequestIdOf(TASK));
    expect(stopRequestIdOf(TASK)).not.toBe(stopRequestIdOf(MEMBER_TASK));
    expect(stopRequestIdOf(TASK)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
