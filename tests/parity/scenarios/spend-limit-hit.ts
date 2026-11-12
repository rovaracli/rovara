import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "spend-limit-hit",
  title: "A task is refused at start when the company's money limit is spent",
  areas: [22, 23],
  kind: "failure",
  steps: [
    { do: "spend.limit", usd: 0 },
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
  ],
});
