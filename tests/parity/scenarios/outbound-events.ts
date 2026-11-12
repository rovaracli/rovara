import { defineScenario } from "../harness/types.js";

// A Quick task to its plan review; then which outbound-events adapters each path sends a milestone to. Cloud has no outbound events feature (plan row 43:
// Slack and milestone hooks are inline); the core sends to every registered adapter, and the composition root registers none.
export default defineScenario({
  id: "outbound-events",
  title: "A milestone is sent as an outbound event",
  areas: [43],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "outbound-events" },
  ],
});
