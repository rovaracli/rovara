import { defineScenario } from "../harness/types.js";

// Compared at the feature's decisions (tests/parity/engines/features-a-support/decision.ts and cases-second-review.ts): the same cases through Cloud's copy and the
// core's copy, one features word per case. Only the features facet is compared: the scenario starts no task, so the other facets would be empty on both
// sides and read "same" for no reason.
export default defineScenario({
  id: "second-review",
  title: "Second review: the plan (model, mode, evidence), an unavailable review, the acknowledgement, where an opinion shows and the money gate, on the same inputs",
  areas: [8],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "second-review" },
  ],
});
