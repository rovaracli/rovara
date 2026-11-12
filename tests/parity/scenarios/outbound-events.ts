import { defineScenario } from "../harness/types.js";

// A Quick task to its draft pull request, then the outbound events each path sent. Cloud has no outbound events feature (plan row 43: Slack and milestone
// hooks are inline). The core has the point; a recording adapter is registered on it here, so what the core sends through it is what is compared.
export default defineScenario({
  id: "outbound-events",
  title: "A milestone is sent as an outbound event",
  areas: [43],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
    { do: "feature", name: "outbound-events" },
  ],
});
