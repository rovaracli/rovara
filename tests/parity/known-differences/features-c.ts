// Known differences found by the saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections and MCP tools drivers.
// Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

export const FEATURES_C_DIFFERENCES: readonly KnownDifference[] = [
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

/**
 * Route-level findings of the features-C probes (engines/features-c-support/probes.ts). They are outcomes of a `features` facet that the shared Observation
 * does not have yet (the shared change this lane asks for: a `features` facet read from each engine's `extra.features`). Until it exists they cannot be
 * KNOWN_DIFFERENCES entries (the suite checks every entry against a facet it compares), so they are kept here, each with its cause and owner, to move into
 * FEATURES_C_DIFFERENCES with `facet: "features"` the day the facet lands.
 */
export interface FeatureFinding {
  scenario: string;
  cloud: string;
  core: string;
  cause: string;
  owner: string;
  /** `bug` (a real defect, with file:line and a proposed fix), `surface` (a route or answer shape that differs), `harness` (the test harness, not the product). */
  kind: "bug" | "surface" | "harness";
}

export const FEATURES_C_FINDINGS: readonly FeatureFinding[] = [
  {
    scenario: "saved-environment", kind: "surface",
    cloud: "saved-env GET /v1/app/projects/payments/environment-image -> 403 error:FORBIDDEN",
    core: "saved-env GET /v1/app/projects/payments/environment-image -> 404 error:NOT_FOUND",
    cause: "The core has no saved environment panel route at all (no environment-image path in vendor broker local/app or core); Cloud serves it only to a live browser session (packages/broker/src/aws/developer-routes/saved-env-image.ts:20-21, SAVED_ENV_IMAGE_BROWSER_MESSAGE), never to a token. Before the switch the panel must have a core read (or stay a Cloud route over core rows).",
    owner: "X3 cloud/adopt-env (saved environments on core), Code upstream for the read",
  },
  {
    scenario: "test-services", kind: "surface",
    cloud: "test-services GET /v1/app/projects/payments/test-environment -> 200 keys:draft",
    core: "test-services GET /v1/app/projects/payments/test-environment -> 200 keys:enabled,project,testServices",
    cause: "Same path, different answer: Cloud answers the project's test environment draft (packages/broker/src/aws/developer-routes/test-environment.ts, TEST_ENV_PATH); the core answers whether test services are on and the project's services (vendor local/app/test-environment.ts). Cloud's web app reads Cloud's shape, so if the route moves onto the core read unchanged the test environment page breaks. Running the services themselves needs Docker or the AWS emulator and is not compared here.",
    owner: "X3 cloud/adopt-env: one contract for the read (readers before writers)",
  },
  {
    scenario: "setup-agent", kind: "harness",
    cloud: "setup-agent GET /v1/app/projects/payments/setup-agent -> 403 error:FORBIDDEN (only a project maintainer can set up a project with Rovara)",
    core: "setup-agent GET /v1/app/projects/payments/setup-agent -> 200 keys:basedOnRevision,limits,status",
    cause: "Cloud's maintainerOf (packages/broker/src/rovara-code/setup-agent.ts:479-482) refuses the journey's Maya: her project role lacks edit_settings, and seeding a maintainer MEMBERSHIP row (projectMemberKey) did not change that, so the role comes from another record not found here. The core's laptop owner holds every role. Not yet a product difference: the comparison needs a Cloud caller who is a real project maintainer.",
    owner: "features-C follow-up: drive the Cloud side as a project maintainer, then compare the setup agent read",
  },
  {
    scenario: "playbook", kind: "surface",
    cloud: "playbook GET /v1/app/projects/payments/playbook -> 200 keys:playbook",
    core: "playbook GET /v1/app/projects/payments/playbook -> 200 keys:playbook",
    cause: "Same (after leaving out Cloud's requestId envelope). Listed so the day the features facet lands this scenario starts as compared-same.",
    owner: "none (same)",
  },
  {
    scenario: "connections", kind: "surface",
    cloud: "connections GET /v1/app/connections -> 404 (agents are not set up in this deployment); GET /v1/dev/connections -> 404",
    core: "connections GET /v1/app/connections -> 404; GET /v1/dev/connections -> 200 keys:connections",
    cause: "The two products serve connections on different paths and for different things: Cloud's /v1/app/connections are the company's agent connections (packages/broker/src/connections/routes.ts:28-30, refused here because the journey harness builds no agents dependencies); the core's /v1/dev/connections are its monitoring and context connections (vendor local/app/connections.ts:39). Cloud's monitoring and context connections (packages/broker/src/context-sources, connectors) have no matching core route path. A route map is owed before the switch.",
    owner: "X4 cloud/adopt-connect (route map for connections, context sources, MCP servers)",
  },
  {
    scenario: "mcp-tools", kind: "surface",
    cloud: "mcp-tools start -> started (then PLAN_REVIEW/WAITING)",
    core: "mcp-tools start -> started (then PLAN_REVIEW/WAITING)",
    cause: "Same start and transitions. The core side posts the exact request Code's agentx_start_workflow sends (Code packages/mcp/src/tools.ts:773-803), because the vendored Code has no MCP package; Cloud's side goes through Cloud's real MCP server. Messages differ (see FEATURES_C_DIFFERENCES).",
    owner: "none (same on transitions)",
  },
];
