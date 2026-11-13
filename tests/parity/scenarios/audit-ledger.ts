import { defineScenario } from "../harness/types.js";

// A Quick task from the request to its draft pull request, then the audit ledger read in order: every audit event of the run, in Cloud's action names
// (the core's mapped by A7's event map), compared one by one.
export default defineScenario({
  id: "audit-ledger",
  title: "Every decision lands in the audit ledger in order",
  areas: [26],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
    { do: "feature", name: "audit-ledger" },
  ],
});
