import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "base-branch-drift",
  title: "The base branch moves while the PR waits; branch sync runs",
  areas: [12],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "checks", outcome: "pass" },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
    { do: "base.moved" },
  ],
});
