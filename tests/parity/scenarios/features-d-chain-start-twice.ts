import { defineScenario } from "../harness/types.js";

// Areas 16 and 17 compare at the chain runner of each product (features-d-support/flows.ts).
export default defineScenario({
  id: "features-d-chain-start-twice",
  title: "The same chain run started twice at the same moment: one run, one first step",
  areas: [16],
  kind: "race",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-start-twice" },
  ],
});
