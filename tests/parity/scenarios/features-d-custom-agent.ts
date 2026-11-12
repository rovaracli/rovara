import { defineScenario } from "../harness/types.js";

// Hidden in Cloud by decision 45.10 and off by default in Code (the automation switch): the drivers turn it on in both for the comparison.
export default defineScenario({
  id: "features-d-custom-agent",
  title: "A custom agent made from a recipe overlay is published and runs as a chain step",
  areas: [17],
  kind: "happy",
  // The runner's own rows (chain runs, step attempts) are outside the shared task-record families the rows facet compares; see known-differences/features-d.ts.
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "custom-agents" },
  ],
});
