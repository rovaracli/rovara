// Cloud drivers: Chains, triggers, automatic runs, custom agents (areas 16, 17), held hidden in Cloud by decision 45.10 and compared with both switched on in
// the test. Each `feature:<flow>` step runs one flow on Cloud's own chain runner (features-d-support/cloud-flows.ts) and reports into this engine's facets.
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { runCloudFlow } from "../features-d-support/cloud-flows.js";
import { FLOWS, isFlow } from "../features-d-support/flows.js";
import type { Step } from "../../harness/types.js";

const flowDriver: StepDriver<CloudContext, CloudOptions> = {
  supports: (step: Step) => (step.do === "feature" && isFlow(step.name) ? true : { unsupported: "not a chain or custom agent flow" }),
  async run(ctx, step) {
    if (step.do !== "feature" || !isFlow(step.name)) throw new Error("not a chain flow");
    const seen = await runCloudFlow(step.name);
    ctx.states.push(...seen.transitions);
    ctx.extra.spend.push(...seen.spend);
    for (const row of seen.rows) ctx.keys.add(row);
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.features-d", flow: step.name, seen }));
  },
};

export const FEATURES_D_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = Object.fromEntries(FLOWS.map((flow) => [`feature:${flow}`, flowDriver]));
