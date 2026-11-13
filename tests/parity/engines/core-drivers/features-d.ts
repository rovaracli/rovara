// Core drivers: Chains, triggers, automatic runs, custom agents (areas 16, 17), held hidden in Cloud by decision 45.10 and compared with both switched on in
// the test. Each `feature:<flow>` step runs one flow on Code's core chain runner (features-d-support/code-flows.ts) and reports into this engine's facets.
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { runCodeFlow } from "../features-d-support/code-flows.js";
import { FLOWS, isFlow } from "../features-d-support/flows.js";
import type { Step } from "../../harness/types.js";

const flowDriver: StepDriver<CoreContext, FakeWorldOptions> = {
  supports: (step: Step) => (step.do === "feature" && isFlow(step.name) ? true : { unsupported: "not a chain or custom agent flow" }),
  async run(ctx, step) {
    if (step.do !== "feature" || !isFlow(step.name)) throw new Error("not a chain flow");
    const seen = await runCodeFlow(step.name);
    ctx.recorder.states.push(...seen.transitions);
    ctx.extra.spend.push(...seen.spend);
    for (const row of seen.rows) ctx.recorder.keys.add(row);
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.features-d", flow: step.name, seen }));
  },
};

export const FEATURES_D_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = Object.fromEntries(FLOWS.map((flow) => [`feature:${flow}`, flowDriver]));
