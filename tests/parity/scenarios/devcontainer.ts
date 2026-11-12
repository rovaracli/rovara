import { defineScenario } from "../harness/types.js";

// Area 30 is compared at the level where it lives, the WORKER (engines/features-c-support/devcontainer.ts): the broker only passes the project's
// `devcontainer` setting on, and the worker finds the config and refuses what it does not allow. Cloud's worker (packages/worker) against the vendored
// Code worker (the one Cloud moves onto at a vendor pin) on the same fixtures: a plain image, one with features, a privileged container, a second
// network and a host command. No task runs, so only the features facet is compared.
export default defineScenario({
  id: "devcontainer",
  title: "A project's devcontainer: which config the worker finds and what it refuses",
  areas: [30],
  kind: "edge",
  facets: ["features"],
  steps: [
    { do: "feature", name: "devcontainer" },
  ],
});
