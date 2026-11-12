import { defineScenario } from "../harness/types.js";

// A race at the trigger: GitHub delivers the same "pull request opened" event twice (a retried webhook). One start, and the repeat is a duplicate, on each
// product's own trigger engine (Cloud: packages/broker/src/triggers; Code: core/triggers), with automation switched on in both.
export default defineScenario({
  id: "features-d-trigger-twice",
  title: "A trigger's event delivered twice starts one run",
  areas: [16],
  kind: "race",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-trigger-twice" },
  ],
});
