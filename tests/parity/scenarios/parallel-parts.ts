import { defineScenario } from "../harness/types.js";

// A Full task whose coding plan has three parts (A and B independent, C on both): A and B are built side by side, C on the tree both were merged into,
// and one pull request opens on the integrated tree. The feature driver answers the phases' plans and approves each (features-a drivers).
export default defineScenario({
  id: "parallel-parts",
  title: "A plan with parts builds the independent ones side by side, then the one that needs both",
  areas: [11],
  kind: "happy",
  steps: [
    { do: "start", request: "Add a shared greeting service", path: "FULL" },
    { do: "feature", name: "parallel-parts" },
  ],
});
