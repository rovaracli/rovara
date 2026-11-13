import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "quick-to-plan-review",
  title: "A Quick task is planned and waits for the owner's approval",
  areas: [1, 3, 5],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
  ],
});
