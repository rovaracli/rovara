import { defineScenario } from "../harness/types.js";

// Areas 16 and 17 compare at the chain runner of each product (features-d-support/flows.ts).
export default defineScenario({
  id: "features-d-chain-switch-off",
  title: "A chain run started with automations switched off",
  areas: [16],
  kind: "edge",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-switch-off" },
  ],
});
