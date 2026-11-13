import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "check-fails-autofix",
  title: "A check fails once in the coding run; the worker's one extra try fixes it",
  areas: [6],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "checks", outcome: "fail" },
    { do: "checks", outcome: "pass" },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
  ],
});
