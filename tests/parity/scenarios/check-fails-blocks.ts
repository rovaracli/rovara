import { defineScenario } from "../harness/types.js";

// A check that fails on every run after the change, with no run before it to compare with (`failing_no_before`). Both paths read the worker's report as
// verified (only a check that passed before and fails after is a regression) and go on to the reviews and the pull request: same, and worth knowing.
export default defineScenario({
  id: "check-fails-blocks",
  title: "A check that fails with no earlier run is not a regression on either path",
  areas: [6],
  kind: "failure",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "checks", outcome: "fail" },
  ],
});
