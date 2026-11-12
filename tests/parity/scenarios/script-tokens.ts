import { defineScenario } from "../harness/types.js";

// A task waits for the owner's plan decision; a script token (read and start on the project) starts a second task, reads it, and is refused every
// decision on the first: approve, stop, close. Cloud's switch `pt` is turned on for the comparison (the core's tokens are on by default).
export default defineScenario({
  id: "script-tokens",
  title: "A script token starts a task and cannot decide",
  areas: [36],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "script-tokens" },
  ],
});
