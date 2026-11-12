import { defineScenario } from "../harness/types.js";

// A feature scenario: its steps are the feature's own (`feature`), which an engine drives once its driver is written.
export default defineScenario({
  id: "setup-agent",
  title: "The setup agent proposes and proves the project setup",
  areas: [29],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "feature", name: "setup-agent" },
  ],
});
