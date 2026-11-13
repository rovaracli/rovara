import { defineScenario } from "../harness/types.js";

// The same planner answer with no word on how the change is tested: Cloud's path takes the project's own check as the test; the core's plan reader asks.
export default defineScenario({
  id: "plan-without-test-statement",
  title: "A plan that does not say how it is tested",
  areas: [3, 4],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "Run node --version."], testStatement: false } },
  ],
});
