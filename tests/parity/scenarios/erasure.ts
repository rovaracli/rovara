import { defineScenario } from "../harness/types.js";

export default defineScenario({
  id: "erasure",
  title: "A person is erased; their tasks keep no name",
  areas: [39],
  kind: "edge",
  steps: [
    { do: "start", request: "Add a greet(name) function", path: "QUICK" },
    { do: "person.erase" },
  ],
});
