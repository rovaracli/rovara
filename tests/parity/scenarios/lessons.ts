import { defineScenario } from "../harness/types.js";

// Compared at the feature's decisions (tests/parity/engines/features-a-support/decision.ts and cases-lessons.ts): the same cases through Cloud's copy and the
// core's copy, one features word per case. Only the features facet is compared: the scenario starts no task, so the other facets would be empty on both
// sides and read "same" for no reason.
export default defineScenario({
  id: "lessons",
  title: "Lessons: tiers, approval for use, trials, value, capture words, the repository lessons file and the audience folds, on the same lessons",
  areas: [14],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "lessons" },
  ],
});
