// The parity suite's CLOUD engine: runs a scenario's steps through the Cloud drivers (cloud-drivers/) on a fresh journey harness (cloud-context.ts).
import type { Facet, Observation, ParityEngine, Scenario, Step, StepSupport } from "../harness/types.js";
import { baseOptions, createCloudContext, type CloudOptions } from "./cloud-context.js";
import { CLOUD_DRIVERS } from "./cloud-drivers/index.js";
import { driverKey, driversOf, supportOf } from "./drivers.js";

/** The facets the Cloud engine cannot see yet, with why. */
export const CLOUD_UNOBSERVED: Partial<Record<Facet, string>> = {
  spend: "the journey harness has no spend ledger reader yet",
  audit: "Cloud's audit outbox rows are not mapped to event names yet",
};

export class CloudEngine implements ParityEngine {
  readonly name = "cloud";

  supports(step: Step): StepSupport {
    return supportOf(CLOUD_DRIVERS, "Cloud", step);
  }

  observes(facet: Facet): StepSupport {
    const why = CLOUD_UNOBSERVED[facet];
    return why === undefined ? true : { unsupported: why };
  }

  async run(scenario: Scenario): Promise<Observation> {
    const drivers = driversOf(CLOUD_DRIVERS, scenario);
    const options: CloudOptions = Object.assign(baseOptions(scenario), ...drivers.map((driver) => driver.options?.(scenario) ?? {})) as CloudOptions;
    const ctx = await createCloudContext(scenario, options);
    for (const driver of drivers) await driver.prepare?.(ctx, scenario);
    for (const [index, step] of scenario.steps.entries()) await CLOUD_DRIVERS[driverKey(step)]!.run(ctx, step, scenario.steps[index + 1]);
    return {
      transitions: ctx.states, decisions: ctx.decisions, rows: [...ctx.keys],
      messages: [...ctx.e2e.slack.posts.map((post) => `slack:${post.text.split("\n")[0]!.slice(0, 40)}`), ...ctx.extra.messages],
      codeHost: [...ctx.e2e.github.pullRequests.map((pull) => (pull.state === "merged" ? "merged_pr" : pull.draft === false ? "open_pr" : "open_draft_pr")), ...ctx.extra.codeHost],
      spend: [...ctx.extra.spend], audit: [...ctx.extra.audit],
    };
  }

  dispose(): Promise<void> { return Promise.resolve(); }
}
