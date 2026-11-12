import { defineScenario } from "../harness/types.js";

// A feature scenario: its steps are the feature's own (`feature`), which an engine drives once its driver is written.
export default defineScenario({
  id: "tracker-intake",
  title: "A tracker ticket starts a task and gets the write-back",
  areas: [18],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "feature", name: "tracker-intake" },
  ],
});
