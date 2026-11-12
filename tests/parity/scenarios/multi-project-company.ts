import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "multi-project-company",
  title: "One company, two projects: tasks and limits stay apart",
  areas: [1, 39],
  kind: "edge",
  steps: [
    { do: "project.second" },
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
  ],
});
