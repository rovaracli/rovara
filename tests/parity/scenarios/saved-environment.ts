import { defineScenario } from "../harness/types.js";

// Features-C lane: a task is planned, then the feature's surface is asked on both engines (engines/features-c-support/probes.ts).
export default defineScenario({
  id: "saved-environment",
  title: "The project's saved environment panel is read (the image build itself needs the cloud registry: not compared)",
  areas: [27],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "saved-env" },
  ],
});
