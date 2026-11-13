import { defineScenario } from "../harness/types.js";

// Area 32, Fix with agent, at the SERVICE level (engines/features-c-support/diagnosis.ts): the journey harness builds Cloud's broker with no diagnosis
// dependencies and the core engine has no model key, so each product's own diagnosis service runs on the same failed task: no provider, a start, the
// same request again, and an error that is no longer the one shown. Only the features facet is compared (no task runs through the engines).
export default defineScenario({
  id: "diagnosis",
  title: "Fix with agent on a failed task: no provider, a start, a repeat, a stale error",
  areas: [32],
  kind: "edge",
  facets: ["features"],
  steps: [
    { do: "feature", name: "diagnosis" },
  ],
});
