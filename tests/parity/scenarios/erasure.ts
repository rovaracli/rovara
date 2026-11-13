import { defineScenario } from "../harness/types.js";

// Area 39 on the part both paths have (people-money-support/erasure.ts): the erased person's task evidence (pack and output tails) is deleted, another person's
// stays. Cloud runs its person erase; the core runs its per-task erase through the S0 adapter the composition root owes (written test-side). The rest of
// Cloud's member removal (names scrubbed from records, memberships ended) has no Code counterpart (decision 41) and is not compared here.
export default defineScenario({
  id: "erasure",
  title: "A person's task evidence is erased; another person's stays",
  areas: [39],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "person.erase" },
  ],
});
