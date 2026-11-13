import { defineScenario } from "../harness/types.js";
import type { SpendLimitStep } from "../engines/people-money-support/spend.js";

// The company's monthly limit is $0: a Quick start is refused before anything is written. Both sides ask their own start admission (Cloud: `admitWork`; the
// core: lane A5's CloudAdmission on `task.start`) over the same seeded limit; the spend facet compares what each says.
const limit: SpendLimitStep = { do: "spend.limit", usd: 0 };

export default defineScenario({
  id: "spend-limit-hit",
  title: "A task is refused at start when the company's money limit is spent",
  areas: [22, 23],
  kind: "failure",
  facets: ["transitions", "rows", "spend"],
  steps: [limit, { do: "feature", name: "spend.start-quick" }],
});
