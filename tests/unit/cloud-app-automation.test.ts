// Convergence S0-143c (owner decision 143c): the core's automation switch is Cloud's `chains` feature; off stops new starts and cancels runs already started at a safe point,
// nothing half done is merged; on resumes nothing by itself. Over the vendored chain runner and unattended door, and Cloud's own engine.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orgScoped } from "@rovara-code/contracts";
import { readChainRun, readStepAttempts } from "../../vendor/rovara-code/packages/broker/src/core/chains/runner.js";
import { startUnattendedRun, type AutomatedRunRequest } from "../../vendor/rovara-code/packages/broker/src/core/automation/run-seam.js";
import { CORE_JOBS, OPEN_UNATTENDED_RUNS, cloudAutomationSwitch, stopAutomationsWhenOff, type AutomationStopDeps } from "../../packages/broker/src/cloud/app/index.js";
import { automationStopSafe, automationsSwitchOf } from "../../packages/broker/src/chains/automations-gate.js";
import { WORLD_COMPANY, createCoreChainWorld } from "../support/core-chain-world.js";

type Request = AutomatedRunRequest;

function stopperOver(world: ReturnType<typeof createCoreChainWorld>): AutomationStopDeps {
  return {
    automation: { enabled: () => world.switchState.on }, companyId: WORLD_COMPANY, store: world.store, chains: world.deps, unattended: world.unattended,
    taskWorkflow: async (taskId) => world.workflows.get(taskId), log: () => undefined,
  };
}
const runStatus = async (world: ReturnType<typeof createCoreChainWorld>, runId: string) => (await readChainRun(world.table, WORLD_COMPANY, runId))?.status;

describe("the switch is Cloud's chains feature", () => {
  it("the core's switch reads WEB_FEATURES on every use", () => {
    const env: NodeJS.ProcessEnv = {};
    const automation = cloudAutomationSwitch(() => env);
    expect(automation.enabled()).toBe(false);
    env["WEB_FEATURES"] = "admin,chains";
    expect(automation.enabled()).toBe(true);
    env["WEB_FEATURES"] = "admin";
    expect(automation.enabled()).toBe(false);
  });

  it("Cloud's engine switch is the same one", () => {
    expect(automationsSwitchOf({ WEB_FEATURES: "chains" }).enabled()).toBe(true);
    expect(automationsSwitchOf({}).enabled()).toBe(false);
  });

  it("the open-run partition is the one the core's door writes (drift guard against the vendored code)", () => {
    expect(readFileSync(new URL("../../vendor/rovara-code/packages/broker/src/core/automation/run-seam.ts", import.meta.url), "utf8")).toContain(`const OPEN_RUN_PARTITION = "${OPEN_UNATTENDED_RUNS}";`);
  });

  it("the stop is a scheduled job of the flow area, once a minute", () => {
    expect(CORE_JOBS.find((job) => job.name === "automation-stop")).toMatchObject({ area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" } });
  });
});

describe("the safe point", () => {
  it.each([
    [undefined, true], [{ stage: "PLAN", state: "WAITING" }, true], [{ stage: "PLAN_REVIEW", state: "WAITING" }, true], [{ stage: "IMPLEMENT", state: "RUNNING" }, true],
    [{ stage: "REVIEW", state: "RUNNING" }, true], [{ stage: "WAIT_FOR_MERGE", state: "WAITING" }, true],
    [{ stage: "PULL_REQUEST", state: "RUNNING" }, false], [{ stage: "PULL_REQUEST", state: "READY" }, false], [{ stage: "PULL_REQUEST", state: "WAITING" }, true],
    [{ stage: "SYNC", state: "RUNNING" }, false],
  ])("%j is safe: %s", (workflow, safe) => {
    expect(automationStopSafe(workflow)).toBe(safe);
  });
});

describe("the core: off stops new runs and cancels running ones safely", () => {
  it("off refuses a new automatic start at the door and starts nothing", async () => {
    const world = createCoreChainWorld();
    world.switchState.on = false;
    await expect(startUnattendedRun(world.unattended, {
      requestId: "11111111-1111-4111-8111-111111111111", project: "web", agent: { agentId: "code-reviewer" }, input: { text: "x" }, origin: "event", limits: { maxMinutes: 10, maxRunUsd: 1 },
    } satisfies Request)).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
    expect(world.starts).toEqual([]);
  });

  it("a running chain run is cancelled, its step's task is stopped, and nothing further starts", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    expect(world.starts).toHaveLength(1);
    world.switchState.on = false;
    const report = await stopAutomationsWhenOff(stopperOver(world));
    expect(report).toMatchObject({ switch: "off", chainRunsCancelled: 1, deferred: 0 });
    expect(await runStatus(world, run.runId)).toBe("cancelled");
    expect(world.cancelled).toEqual(["task-1"]);
    // The first step's late end does not move a cancelled run on, and the second step never starts.
    await world.endStep("task-1");
    expect(await runStatus(world, run.runId)).toBe("cancelled");
    expect(world.starts).toHaveLength(1);
  });

  it("a run whose step's task is opening its pull request is left, and stopped at the next pass once that is done", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    world.workflows.set("task-1", { stage: "PULL_REQUEST", state: "RUNNING" });
    world.switchState.on = false;
    expect(await stopAutomationsWhenOff(stopperOver(world))).toMatchObject({ chainRunsCancelled: 0, deferred: 1 });
    expect(await runStatus(world, run.runId)).toBe("running");
    expect(world.cancelled).toEqual([]);
    world.workflows.set("task-1", { stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(await stopAutomationsWhenOff(stopperOver(world))).toMatchObject({ chainRunsCancelled: 1, deferred: 0 });
    expect(await runStatus(world, run.runId)).toBe("cancelled");
  });

  it("a task whose state cannot be read is not known to be safe: the run is left", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    world.switchState.on = false;
    const deps = { ...stopperOver(world), taskWorkflow: async () => { throw new Error("unreadable"); } };
    expect(await stopAutomationsWhenOff(deps)).toMatchObject({ chainRunsCancelled: 0, deferred: 1 });
    expect(await runStatus(world, run.runId)).toBe("running");
  });

  it("a run a trigger started on its own has its task stopped, and its reservation is settled once the task ended", async () => {
    const world = createCoreChainWorld();
    // An unattended run with its open record, as the door writes it (a schedule's run).
    const request: Request = { requestId: "22222222-2222-4222-8222-222222222222", project: "web", agent: { agentId: "code-reviewer" }, input: { text: "x" }, origin: "schedule", limits: { maxMinutes: 30, maxRunUsd: 1 } };
    await startUnattendedRun(world.unattended, request);
    expect((await world.store.query({ pk: orgScoped(WORLD_COMPANY, OPEN_UNATTENDED_RUNS) })).items).toHaveLength(1);
    world.switchState.on = false;
    const report = await stopAutomationsWhenOff(stopperOver(world));
    // The task is stopped, and the door's own sweep settles its reservation and closes its record in the same pass (the task has ended).
    expect(report).toMatchObject({ runsStopped: 1, settled: 1 });
    expect(world.cancelled).toEqual(["task-1"]);
    expect(world.settled).toEqual(["settle"]);
    expect((await world.store.query({ pk: orgScoped(WORLD_COMPANY, OPEN_UNATTENDED_RUNS) })).items).toHaveLength(0);
    expect(await stopAutomationsWhenOff(stopperOver(world))).toMatchObject({ runsStopped: 0, settled: 0 });
  });

  it("an unattended run whose task is at a pull request is deferred, not stopped", async () => {
    const world = createCoreChainWorld();
    await startUnattendedRun(world.unattended, { requestId: "33333333-3333-4333-8333-333333333333", project: "web", agent: { agentId: "code-reviewer" }, input: { text: "x" }, origin: "event", limits: { maxMinutes: 30 } });
    world.workflows.set("task-1", { stage: "PULL_REQUEST", state: "READY" });
    world.switchState.on = false;
    expect(await stopAutomationsWhenOff(stopperOver(world))).toMatchObject({ runsStopped: 0, deferred: 1 });
    expect(world.cancelled).toEqual([]);
  });

  it("a chain run waiting at a gate or between steps stops at once", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    world.waiting.add("task-1");
    world.switchState.on = false;
    expect(await stopAutomationsWhenOff(stopperOver(world))).toMatchObject({ chainRunsCancelled: 1 });
    expect(await runStatus(world, run.runId)).toBe("cancelled");
  });
});

describe("the core: on resumes nothing by itself", () => {
  it("while the switch is on the stop does nothing at all", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    expect(await stopAutomationsWhenOff(stopperOver(world))).toEqual({ switch: "on", chainRunsCancelled: 0, runsStopped: 0, deferred: 0, settled: 0 });
    expect(await runStatus(world, run.runId)).toBe("running");
  });

  it("a cancelled run stays cancelled when the switch comes back, and a deferred stop is dropped by it", async () => {
    const world = createCoreChainWorld();
    const first = await world.start(await world.publishChain());
    world.switchState.on = false;
    await stopAutomationsWhenOff(stopperOver(world));
    world.switchState.on = true;
    const after = await stopAutomationsWhenOff(stopperOver(world));
    expect(after.switch).toBe("on");
    expect(await runStatus(world, first.runId)).toBe("cancelled");
    expect((await readStepAttempts(world.table, WORLD_COMPANY, first.runId)).map((attempt) => attempt.status)).toEqual(["cancelled"]);
    expect(world.starts).toHaveLength(1);
  });

  it("a deferred stop does not cancel the run once the switch is back on", async () => {
    const world = createCoreChainWorld();
    const run = await world.start(await world.publishChain());
    world.workflows.set("task-1", { stage: "PULL_REQUEST", state: "RUNNING" });
    world.switchState.on = false;
    await stopAutomationsWhenOff(stopperOver(world));
    world.switchState.on = true;
    world.workflows.set("task-1", { stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await stopAutomationsWhenOff(stopperOver(world));
    expect(await runStatus(world, run.runId)).toBe("running");
  });
});

