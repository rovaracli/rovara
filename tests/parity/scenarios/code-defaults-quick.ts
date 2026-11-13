import { defineScenario } from "../harness/types.js";

// A Quick task started on the core under the settings the composition root maps from Cloud (S0-Q2: no Understand step, no plan check, as Cloud's Quick path runs).
// Before the mapping this scenario ran the core on Code's own defaults and showed the two extra stages; it is kept as the guard that the mapping stays on.
export default defineScenario({
  id: "code-defaults-quick",
  title: "A Quick task on the core under the mapped Cloud settings",
  areas: [2, 3],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
  ],
});
