import { defineScenario } from "../harness/types.js";

// Features-C lane: a task is planned, then the feature's surface is asked on both engines (engines/features-c-support/probes.ts).
export default defineScenario({
  id: "test-services",
  title: "The project's test environment is read (running its services needs Docker or the AWS emulator: not compared here)",
  areas: [28],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "test-services" },
  ],
});
