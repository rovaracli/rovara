import { defineScenario } from "../harness/types.js";

// The coding run's machine is lost (no result ever comes back): Cloud's session reconciler finds it and blocks the step with a retry; the core has to notice too.
export default defineScenario({
  id: "worker-lost",
  title: "The coding run's worker machine is lost mid-step",
  areas: [1, 6],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "worker.lost" },
  ],
});
