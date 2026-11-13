import { defineScenario } from "../harness/types.js";

// Features-C lane: a task is planned, then the feature's surface is asked on both engines (engines/features-c-support/probes.ts).
export default defineScenario({
  id: "playbook",
  title: "The project's How we work playbook is read",
  areas: [31],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "playbook" },
  ],
});
