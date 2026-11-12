import { defineScenario } from "../harness/types.js";

// The same Quick task with the core left at Code's own flow defaults (Understand first, the plan check on), not the settings the composition root maps
// from Cloud. It shows what that mapping (S0-Q2) has to carry.
export default defineScenario({
  id: "code-defaults-quick",
  title: "A Quick task on the core with Code's own defaults",
  areas: [2, 3],
  kind: "edge",
  coreUsesCodeDefaults: true,
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
  ],
});
