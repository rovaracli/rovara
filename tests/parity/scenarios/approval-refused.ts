import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "approval-refused",
  title: "A high-risk decision needs a second person; it is refused",
  areas: [5, 25],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "approval.needed", kind: "plan-high-risk", answer: "refuse" },
  ],
});
