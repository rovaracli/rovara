import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "decision-timeout",
  title: "Nobody answers a decision: reminders, then the task parks",
  areas: [5, 19],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "decision.timeout", days: 8 },
  ],
});
