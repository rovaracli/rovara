import { defineScenario } from "../harness/types.js";

// parallel-parts with the core left to run Understand first (Code's default), so its Full path gets past the requirements and the parts themselves are
// compared. The extra Understand stage is the settings difference (S0-Q2); the rest is the feature.
export default defineScenario({
  id: "features-a-parallel-parts-understand",
  title: "Parallel parts with the core's Understand step on",
  areas: [11],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a shared greeting service", path: "FULL" },
    { do: "feature", name: "parallel-parts" },
  ],
});
