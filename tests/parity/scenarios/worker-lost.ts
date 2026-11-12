import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "worker-lost",
  title: "The worker machine is lost mid-step; the step is retried once",
  areas: [1, 6],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "worker.lost" },
  ],
});
