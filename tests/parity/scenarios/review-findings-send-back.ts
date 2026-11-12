import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "review-findings-send-back",
  title: "The reviews find a problem; the work is sent back once",
  areas: [7],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "findings" },
  ],
});
