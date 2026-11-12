import { defineScenario } from "../harness/types.js";

// A feature scenario: its steps are the feature's own (`feature`), which an engine drives once its driver is written.
export default defineScenario({
  id: "model-selection",
  title: "Each step runs on the model the company chose",
  areas: [24],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "feature", name: "model-selection" },
  ],
});
