import { defineScenario } from "../harness/types.js";

// Not driven end to end yet: the drivers' supports() say exactly what is missing on each engine (features-b drivers).
export default defineScenario({
  id: "tracker-intake",
  title: "A tracker ticket starts a task and gets the write-back",
  areas: [18],
  kind: "happy",
  steps: [
    { do: "feature", name: "tracker-intake" },
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
  ],
});
