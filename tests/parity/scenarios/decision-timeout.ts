import { defineScenario } from "../harness/types.js";

// Nobody decides the plan for 8 days. Cloud's 24 h / 72 h / park / close ladder (Q5) exists for design-review waits (DR10); this is the plan approval wait, so it
// finds what each path does with an unanswered plan.
export default defineScenario({
  id: "decision-timeout",
  title: "Nobody answers the plan for 8 days",
  areas: [5, 19],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "decision.timeout", days: 8 },
  ],
});
