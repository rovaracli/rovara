import { defineScenario } from "../harness/types.js";

// Understand asks the owner two questions (one with options, one open), the owner answers on the session's answers route, Understand runs again with the
// answers in its labelled block, and the plan that follows carries them. Cloud runs Understand on a Rovara Code v2 task (its own developer-task broker,
// as Cloud's answer suites do); the core with Understand on. Compared on what each records in the features facet.
export default defineScenario({
  id: "understand-questions",
  title: "Understand asks questions, the owner answers, planning goes on with the answers",
  areas: [2],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "understand.questions" },
  ],
});
