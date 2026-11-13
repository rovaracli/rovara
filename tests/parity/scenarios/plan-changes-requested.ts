import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "plan-changes-requested",
  title: "The owner asks for changes; the planner revises; v2 waits for the owner",
  areas: [4, 5],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.requestChanges", note: "Call the function hello, not greet.", revised: { title: "Add hello(name)", claims: ["Add hello to greeting.ts.", "A test in greeting.test.ts proves hello(\"Maya\") returns Hello, Maya."] } },
  ],
});
