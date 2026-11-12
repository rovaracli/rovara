import { defineScenario } from "../harness/types.js";

// The two-step chain with the core left at Code's default project rules (no connector writes): what the composition root's settings mapping must carry.
export default defineScenario({
  id: "features-d-chain-code-defaults",
  title: "A chain with a writing built-in agent, on the core's default project rules",
  areas: [16],
  kind: "edge",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-code-defaults" },
  ],
});
