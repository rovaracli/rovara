import { defineScenario } from "../harness/types.js";

// Compared at the feature's decisions (tests/parity/engines/features-a-support/decision.ts and cases-e2e.ts): the same cases through Cloud's copy and the
// core's copy, one features word per case. Only the features facet is compared: the scenario starts no task, so the other facets would be empty on both
// sides and read "same" for no reason.
export default defineScenario({
  id: "e2e-checks",
  title: "E2E checks: what the verifier concludes from a CHECKS operation's admission and evidence, on the same records and stored objects",
  areas: [10],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "e2e" },
  ],
});
