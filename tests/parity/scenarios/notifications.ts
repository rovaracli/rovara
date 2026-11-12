import { defineScenario } from "../harness/types.js";

// A feature scenario: its steps are the feature's own (`feature`), which an engine drives once its driver is written.
export default defineScenario({
  id: "notifications",
  title: "Needs-you notices are batched to Slack and email",
  areas: [19],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "feature", name: "notifications" },
  ],
});
