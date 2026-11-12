import { defineScenario } from "../harness/types.js";

// Approve is pressed twice at the same moment (two devices, or Slack delivering the press twice): one decision is recorded and the task moves once, to its pull request.
export default defineScenario({
  id: "two-actors-race",
  title: "Approve pressed twice at the same moment: one decision is recorded",
  areas: [1, 5],
  kind: "race",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "race", steps: [{ do: "plan.approve" }, { do: "plan.approve" }] },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
  ],
});
