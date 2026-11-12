import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "two-actors-race",
  title: "Two people press approve at the same moment: one decision is recorded",
  areas: [5, 1],
  kind: "race",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "race", steps: [{ do: "plan.approve" }, { do: "plan.approve" }] },
  ],
});
