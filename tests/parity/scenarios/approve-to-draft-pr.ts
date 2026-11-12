import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "approve-to-draft-pr",
  title: "An approved plan is coded, checked, reviewed and published as a draft pull request",
  areas: [1, 6, 7, 13, 41, 42],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "checks", outcome: "pass" },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
  ],
});
