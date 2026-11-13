import { defineScenario } from "../harness/types.js";

// The same as multi-project-company, but the first task starts from Slack on Cloud's path (the core has no Slack start; it starts through its route): Cloud
// counts a Slack-started task on the Slack workspace counters and a route-started one on the developer counters (D3), so does the person's limit still hold?
export default defineScenario({
  id: "people-money-limit-family",
  title: "A Slack-started task and a route-started task of one person against a one-workspace limit",
  areas: [1, 23, 39],
  kind: "edge",
  facets: ["spend"],
  steps: [
    { do: "project.second" },
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "feature", name: "start-api:billing" },
  ],
});
