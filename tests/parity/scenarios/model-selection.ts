import { defineScenario } from "../harness/types.js";

// A Quick task from the request to its draft pull request; then the model each step's worker invocation named, compared step by step, under each
// install's own defaults.
export default defineScenario({
  id: "model-selection",
  title: "Each step runs on the model the company chose",
  areas: [24],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
    { do: "feature", name: "model-selection" },
  ],
});
