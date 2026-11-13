// The parity suite's CLOUD engine: runs a scenario's steps through the Cloud drivers (cloud-drivers/) on a fresh journey harness (cloud-context.ts).
import type { Facet, Observation, ParityEngine, Scenario, Step, StepSupport } from "../harness/types.js";
import { baseOptions, createCloudContext, scenarioAudit, type CloudOptions } from "./cloud-context.js";
import { CLOUD_DRIVERS } from "./cloud-drivers/index.js";
import { driverKey, driversOf, supportOf } from "./drivers.js";
import { cloudPostKind } from "./facets-support/messages.js";

/** The facets the Cloud engine cannot see yet, with why. */
export const CLOUD_UNOBSERVED: Partial<Record<Facet, string>> = {};

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
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.posts", scenario: scenario.id, posts: ctx.e2e.slack.posts.map((post) => post.text.slice(0, 160)), updates: ctx.e2e.slack.updates.length, ephemerals: ctx.e2e.slack.ephemerals.map((post) => post.text.slice(0, 100)) }));
    return {
      transitions: ctx.states, decisions: ctx.decisions, rows: [...ctx.keys],
      // Messages: each post in the task's thread as a kind (facets-support/messages.ts). Audit: Cloud's audit actions, queued or still pending.
      messages: [...ctx.e2e.slack.posts.map((post) => cloudPostKind(post.text)), ...ctx.extra.messages],
      features: [...ctx.extra.features],
      codeHost: [...ctx.e2e.github.pullRequests.map((pull) => (pull.state === "merged" ? "merged_pr" : pull.draft === false ? "open_pr" : "open_draft_pr")), ...ctx.extra.codeHost],
      spend: [...ctx.spend, ...ctx.extra.spend], audit: [...scenarioAudit(ctx), ...ctx.extra.audit],
    };
  }

  dispose(): Promise<void> { return Promise.resolve(); }
}
