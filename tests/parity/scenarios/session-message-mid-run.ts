import { defineScenario } from "../harness/types.js";

// A person tells the task something while its plan waits for approval; the coding step that follows is told it. Then the task runs to its pull request.
export default defineScenario({
  id: "session-message-mid-run",
  title: "A person tells the task something before coding starts",
  areas: [21],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "session.message", text: "Use the existing helper." },
    { do: "plan.approve" },
    { do: "coding.done", files: { "greeting.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" } },
    { do: "reviews", outcome: "pass" },
    { do: "published" },
  ],
});
