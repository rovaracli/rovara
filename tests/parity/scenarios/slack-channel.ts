import { defineScenario } from "../harness/types.js";

// Not driven end to end yet: the drivers' supports() say exactly what is missing on each engine (features-b drivers).
export default defineScenario({
  id: "slack-channel",
  title: "A Slack thread starts a task and decides through the channel",
  areas: [20],
  kind: "happy",
  steps: [
    { do: "feature", name: "slack-channel" },
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
  ],
});
