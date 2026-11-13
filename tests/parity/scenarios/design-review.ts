import { defineScenario } from "../harness/types.js";

// Compared at the feature's decisions (tests/parity/engines/features-a-support/decision.ts and cases-design-review.ts): the same cases through Cloud's copy and the
// core's copy, one features word per case. Only the features facet is compared: the scenario starts no task, so the other facets would be empty on both
// sides and read "same" for no reason.
export default defineScenario({
  id: "design-review",
  title: "Design review: the ON/OFF table, the cost estimate and cap gate, reviewers per round, missing requirements, the wait clock and the lock, on the same inputs",
  areas: [9],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "design-review" },
  ],
});
