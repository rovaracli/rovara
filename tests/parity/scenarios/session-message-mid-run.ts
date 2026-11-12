import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "session-message-mid-run",
  title: "A person tells the running step something",
  areas: [21],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "session.message", text: "Use the existing helper." },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
  ],
});
