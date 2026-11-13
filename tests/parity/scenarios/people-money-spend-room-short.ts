import { defineScenario } from "../harness/types.js";
import type { SpendLimitStep } from "../engines/people-money-support/spend.js";

// $10 a month, $9.80 already spent: $0.20 is left, less than a Quick start needs on either side ($0.50). Both refuse.
const limit: SpendLimitStep = { do: "spend.limit", usd: 10, spentUsd: 9.8 };

export default defineScenario({
  id: "people-money-spend-room-short",
  title: "A Quick start with less room left than a start needs is refused",
  areas: [22, 23],
  kind: "failure",
  facets: ["transitions", "rows", "spend"],
  steps: [limit, { do: "feature", name: "spend.start-quick" }],
});
