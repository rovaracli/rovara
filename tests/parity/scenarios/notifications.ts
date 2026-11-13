import { defineScenario } from "../harness/types.js";

// The plan waits for the owner: the needs-you notice goes out (batched), the way each path sends it.
export default defineScenario({
  id: "notifications",
  title: "Needs-you notices are batched to Slack and email",
  areas: [19],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "notifications" },
  ],
});
