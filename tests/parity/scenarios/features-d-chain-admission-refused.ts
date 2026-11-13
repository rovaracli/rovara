import { defineScenario } from "../harness/types.js";

// Areas 16 and 17 compare at the chain runner of each product (features-d-support/flows.ts).
export default defineScenario({
  id: "features-d-chain-admission-refused",
  title: "A chain step whose money is refused: the run does not start a task",
  areas: [16],
  kind: "failure",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-admission-refused" },
  ],
});
