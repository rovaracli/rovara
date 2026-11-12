// Owner decision 143(c), on Cloud's own engine: the automations switch (WEB_FEATURES `chains`) is the engine's too. Off, nothing starts on its own (a trigger's event, a chain's
// next step) and the sweep stops the runs already started at a safe point; on again resumes nothing by itself. Over Cloud's chain runner, lifecycle sweep and trigger dispatch.
import { afterEach, describe, expect, it } from "vitest";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { AUTOMATIONS_OFF_MESSAGE, type AutomationsSwitch } from "../../packages/broker/src/chains/automations-gate.js";
import { sweepChainRuns } from "../../packages/broker/src/chains/lifecycle.js";
import { onStepTaskEnded } from "../../packages/broker/src/chains/runner.js";
import { startChainRun } from "../../packages/broker/src/chains/runner.js";
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
function withSwitch(w: GateWorld, on = true): { flip(value: boolean): void } {
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
