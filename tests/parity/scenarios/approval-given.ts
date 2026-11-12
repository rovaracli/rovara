import { defineScenario } from "../harness/types.js";

// Area 25 at the decision (people-money-support/approvals.ts): one high-risk coding plan (a file in infra), decided in turn by the owner's tool token, an Auditor
// with no standing under the decide-grade sign-in, a person of another company, and the owner in a signed-in browser (with and without the decide-grade sign-in).
// Each attempt's outcome, the task's state and its recorded decision are the `features` words. Only that facet is compared: Cloud's attempts run on its developer
// task broker (the Slack journey harness has no browser decide-grade surface), so the journey task's own transitions and rows are not the decided task's.
export default defineScenario({
  id: "approval-given",
  title: "A high-risk plan is approved only by its owner in a browser under the decide-grade sign-in",
  areas: [5, 25],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "start", request: "Let the payments role read the retry queue", path: "QUICK" },
    { do: "approval.needed", kind: "plan-high-risk", answer: "approve" },
  ],
});
