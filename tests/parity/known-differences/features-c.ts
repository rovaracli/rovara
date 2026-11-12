// Known differences found by the saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections and MCP tools drivers.
// Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

export const FEATURES_C_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "saved-environment", facet: "features",
    cause: [
      "Surface difference. The core has no saved environment panel route at all (no environment-image path in vendor broker local/app or core): 404 NOT_FOUND.",
      "Cloud serves it only to a live browser session (packages/broker/src/aws/developer-routes/saved-env-image.ts:20-21, SAVED_ENV_IMAGE_BROWSER_MESSAGE), never",
      "to a developer token: 403 FORBIDDEN. Before saved environments move onto the core the panel needs a core read, or it stays a Cloud route over core rows.",
    ].join(" "),
    owner: "X3 cloud/adopt-env (saved environments on core); Code upstream for the read",
  },
  {
    scenario: "test-services", facet: "features",
    cause: [
      "Same path, different answer. Cloud answers the project's test environment draft ({draft}: packages/broker/src/aws/developer-routes/test-environment.ts, TEST_ENV_PATH);",
      "the core answers whether test services are on and the project's services ({enabled, project, testServices}: vendor local/app/test-environment.ts).",
      "Cloud's web app reads Cloud's shape, so a route moved onto the core read unchanged breaks the test environment page (readers before writers).",
      "Running the services needs Docker or the AWS emulator and is not compared here.",
    ].join(" "),
    owner: "X3 cloud/adopt-env: one contract for the test environment read",
  },
  {
    scenario: "setup-agent", facet: "features",
    cause: [
      "Harness, not yet product: Cloud's maintainerOf (packages/broker/src/rovara-code/setup-agent.ts:479-482) refuses the journey's Maya (403, \"only a project",
      "maintainer can set up a project with Rovara\"): her project role lacks edit_settings, and seeding a maintainer membership row (projectMemberKey) did not",
      "change that, so the role comes from another record. The core's laptop owner holds every role and reads the state (200 {basedOnRevision, limits, status}).",
      "The real comparison needs a Cloud caller who is a project maintainer; until then this shows only that the two callers differ.",
    ].join(" "),
    owner: "features-C follow-up: drive the Cloud side as a real project maintainer, then compare the setup agent read",
  },
  {
    scenario: "connections", facet: "features",
    cause: [
      "Route-map difference. Cloud's /v1/app/connections are the company's agent connections (packages/broker/src/connections/routes.ts:28-30; 404 here because the",
      "journey harness builds no agents dependencies), and Cloud has no /v1/dev/connections. The core's /v1/dev/connections are its monitoring and context",
      "connections (vendor local/app/connections.ts:39; 200 {connections}), and it has no /v1/app/connections. Cloud's monitoring and context connections",
      "(packages/broker/src/context-sources, connectors) have no matching core path: a route map is owed before the switch.",
    ].join(" "),
    owner: "X4 cloud/adopt-connect (route map for connections, context sources, MCP servers)",
  },
  {
    scenario: "devcontainer", facet: "features",
    cause: [
      "Real gap, CODE's worker (drift W0-2 never sent upstream). Cloud's worker refuses any `--network` / `--net` in a devcontainer's runArgs or build options when",
      "it joins the walled task network (packages/worker/src/devcontainer-policy.ts:46 walledNetwork, :178, :228-229: \"dev containers on this worker join the",
      "agentx-task network\"), and checks the started container for NET_RAW and the walled network (:398-414 dropsNetRaw, walledNetworkProblem). The vendored",
      "Code worker has no walledNetwork in its policy context (vendor packages/worker/src/devcontainer-policy.ts:28-36) and refuses only `--network=host` and",
      "`--network=container:` (:180-183), so a devcontainer on a network of its own (`--network team-cache`) is allowed: on an EC2 worker that container would",
      "sit on a second, unwalled network. The other fixtures (plain image, features, privileged, host command) and the config path are the same on both.",
      "Proposed fix (Code, upstream first): add walledNetwork, its two refusals and the NET_RAW / walled-network container checks to Code's worker policy;",
      "Cloud moves onto Code's worker (W0-1 vendor pin) only after that. The words of the host-network refusal differ too (Cloud names the walled network).",
    ].join(" "),
    owner: "W0-2 drift-upstream (Code worker), before Cloud runs Code's worker",
  },
  {
    scenario: "diagnosis", facet: "features",
    cause: [
      "Real bug, CORE side (words). With no provider both refuse MODEL_NOT_ALLOWED, but the core's words are the laptop's: \"Fix with agent runs on your own",
      "model key, and none is set up on this computer. Run `rovara up --check`...\" (vendor packages/broker/src/core/diagnosis/service.ts:85 whyNot reads",
      "DIAGNOSIS_LAPTOP_REFUSALS, words.ts:8). Cloud says \"Diagnosis uses your company's AI provider. Connect one in Settings to turn it on.\"",
      "(DIAGNOSIS_REFUSALS.noProvider). On the core in Cloud a person would be told to run a laptop command. The start (queued), the repeat (same diagnosis,",
      "nothing spent) and the stale error (CONFIG_INVALID, same words) are the same on both. Proposed fix (Code): the refusal words come from a seam",
      "(DiagnosisDependencies.words, laptop words by default), and the composition root passes Cloud's DIAGNOSIS_REFUSALS.",
    ].join(" "),
    owner: "Code upstream (a words seam in core/diagnosis), then S0 wires Cloud's words",
  },
  {
    scenario: "mcp-tools", facet: "messages",
    cause: [
      "An MCP-started task has no Slack thread on Cloud's path, so the journey's Slack double sees no post (Cloud's needs-you notice for it goes through the notifier's",
      "batched direct message, which the journey harness does not deliver); the core tells its channel adapter needs_you once for the plan's approval whatever surface",
      "started the task. Likely cause, not proven: the Cloud side's DM delivery is outside what the harness captures. Recheck once the messages facet reads Cloud's DM notices.",
    ].join(" "),
    owner: "facets lane (Cloud DM notices into the messages facet), then recheck",
  },
];

