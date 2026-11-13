import { defineScenario } from "../harness/types.js";

// The base moves under an open pull request with Cloud's automatic fix switch (`af`) on: after the base merge, the checks and reviews of the merged code
// run again by themselves (decision 70(c)), on both paths, before the task waits for the merge again.
export default defineScenario({
  id: "merge-base-drift-autofix",
  title: "The base moves with the automatic fix on: the merged code is checked and reviewed again by itself",
  areas: [6, 12],
  kind: "edge",
  steps: [
    { do: "feature", name: "autofix-on" },
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
