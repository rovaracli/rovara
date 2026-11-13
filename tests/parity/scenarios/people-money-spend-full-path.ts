import { defineScenario } from "../harness/types.js";
import type { SpendLimitStep } from "../engines/people-money-support/spend.js";

// $10 a month, $8.60 spent: $1.40 left. Cloud needs $2 left to start a Full task (MINIMUM_REMAINING_USD.FULL), $0.50 for a Quick one; does the core tell the paths apart?
const limit: SpendLimitStep = { do: "spend.limit", usd: 10, spentUsd: 8.6 };

export default defineScenario({
  id: "people-money-spend-full-path",
  title: "A Full start with room for a Quick task but not a Full one",
  areas: [22, 23],
  kind: "edge",
  facets: ["spend"],
  steps: [limit, { do: "feature", name: "spend.start-full" }],
});
