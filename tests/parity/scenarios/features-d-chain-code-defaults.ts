import { defineScenario } from "../harness/types.js";

// The two-step chain on the core under the project rules the composition root maps from Cloud (connector writes allowed behind a person's approval, S0-Q2).
// Before the mapping this ran on Code's default rules and the core refused the writing built-in agent; it is kept as the guard that the mapping stays on.
export default defineScenario({
  id: "features-d-chain-code-defaults",
  title: "A chain with a writing built-in agent, on the mapped project rules",
  areas: [16],
  kind: "edge",
  facets: ["transitions", "spend", "decisions", "codeHost", "rows"],
  steps: [
    { do: "feature", name: "chains-code-defaults" },
  ],
});
