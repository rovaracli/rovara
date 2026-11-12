import { defineScenario } from "../harness/types.js";

// One company, two projects, one person with a one-workspace limit. Both tasks start through the developer route (`/v1/dev/tasks`) on each side: the second
// is refused, because a person's workspace limit counts across the company's projects.
export default defineScenario({
  id: "multi-project-company",
  title: "One company, two projects: a person's workspace limit counts across both",
  areas: [1, 39],
  kind: "edge",
  facets: ["spend"],
  steps: [
    { do: "project.second" },
    { do: "feature", name: "start-api:payments" },
    { do: "feature", name: "start-api:billing" },
  ],
});
