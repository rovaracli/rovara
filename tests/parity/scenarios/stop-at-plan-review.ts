import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "stop-at-plan-review",
  title: "The owner stops a task waiting for approval",
  areas: [1, 21],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "task.stop" },
  ],
});
