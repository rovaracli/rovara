// The parity suite's CORE engine: runs a scenario's steps through the core drivers (core-drivers/) on a fresh core context (core-context.ts) and reports
// what it observed. A step the core stopped at (it handed the worker nothing, or refused a start) ends the run: the comparison shows where the paths part.
import { rm } from "node:fs/promises";
import type { FakeWorldOptions } from "../../support/cloud-core-fakes.js";
import type { Facet, Observation, ParityEngine, Scenario, Step, StepSupport } from "../harness/types.js";
import { coreRoot, createCoreContext, stateWord, Stalled, type CoreContext } from "./core-context.js";
import { CORE_DRIVERS } from "./core-drivers/index.js";
import { StartRefused } from "./core-drivers/task-flow.js";
import { driverKey, driversOf, supportOf } from "./drivers.js";

export { planTextOf, stateWord } from "./core-context.js";

/** The facets the core engine cannot see yet, with why (a driver that adds a facet's source removes its line). */
export const CORE_UNOBSERVED: Partial<Record<Facet, string>> = {
  messages: "no channel adapter is registered on the core yet (A8's Slack channel is registered only once slackSwitchReadiness passes)",
  audit: "the core's audit events are not yet mapped to Cloud's audit types (A7's event map)",
};

export class CoreEngine implements ParityEngine {
  readonly name = "core";
  #root: string | undefined;
  #context: CoreContext | undefined;

  supports(step: Step): StepSupport {
    return supportOf(CORE_DRIVERS, "core", step);
  }

  observes(facet: Facet): StepSupport {
    const why = CORE_UNOBSERVED[facet];
    return why === undefined ? true : { unsupported: why };
  }

  async run(scenario: Scenario): Promise<Observation> {
    const drivers = driversOf(CORE_DRIVERS, scenario);
    const world: FakeWorldOptions = Object.assign({}, ...drivers.map((driver) => driver.options?.(scenario) ?? {})) as FakeWorldOptions;
    this.#root = await coreRoot();
    const ctx = await createCoreContext(scenario, this.#root, { world });
    this.#context = ctx;
    for (const driver of drivers) await driver.prepare?.(ctx, scenario);
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await CORE_DRIVERS[driverKey(step)]!.run(ctx, step, scenario.steps[index + 1]);
      } catch (error) {
        if (!(error instanceof Stalled) && !(error instanceof StartRefused)) throw error;
        if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.stopped", step: step.do, why: error.message }));
        break;
      }
    }
    if (process.env.PARITY_DEBUG === "1") {
      const task = await ctx.readTask();
      console.log(JSON.stringify({ parity: "core.final", scenario: scenario.id, workflow: stateWord((task?.workflow ?? {}) as never), states: ctx.recorder.states }));
    }
    return {
      transitions: ctx.recorder.states, decisions: [...ctx.recorder.decisions], rows: [...ctx.recorder.keys],
      messages: [...ctx.extra.messages], spend: [...ctx.world.spend, ...ctx.extra.spend], audit: [...ctx.world.audit.map((event) => event.action), ...ctx.extra.audit],
      codeHost: [...ctx.world.hostModel.changeRequests.map((entry) => (entry.state === "merged" ? "merged_pr" : entry.draft ? "open_draft_pr" : "open_pr")), ...ctx.extra.codeHost],
    };
  }

  async dispose(): Promise<void> {
    await this.#context?.runtime.stop();
    if (this.#root !== undefined) await rm(this.#root, { recursive: true, force: true });
  }
}
