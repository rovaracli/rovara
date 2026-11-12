import { defineScenario } from "../harness/types.js";

// A ticket labelled `rovara` by a tracker account nobody in the company is linked to: both intake engines make it wait (`unlinked`); a person who may start
// work says Start, the task starts, and the ticket hears it. Cloud: its intake engine and poll over its own rows (the journey harness has no intake wiring);
// core: Code's fake tracker on the registry's `tracker` point, the intake routes and one poll.
export default defineScenario({
  id: "tracker-intake",
  title: "A tracker ticket waits for a person, is started, and gets the write-back",
  areas: [18],
  kind: "happy",
  facets: ["features"],
  steps: [
    { do: "feature", name: "tracker-intake" },
  ],
});
