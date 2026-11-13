import { defineScenario } from "../harness/types.js";

// Hidden in Cloud by decision 45.10 and off by default in Code (the automation switch): the drivers turn it on in both for the comparison.
export default defineScenario({
  id: "features-d-chain-run",
  title: "A person starts a two-step chain; each step's end moves it on; the run succeeds",
  areas: [16],
  kind: "happy",
  // The runner's own rows (chain runs, step attempts) are outside the shared task-record families the rows facet compares; see known-differences/features-d.ts.
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains" },
  ],
});
