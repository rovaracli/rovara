// Where each part of packages/broker/src/aws/broker.ts goes (read by scripts/split/split-broker.ts). Only declarations that exist in the public repository AND in Rovara Cloud are
// named here, so this file can live in both. Names only Rovara Cloud has are in broker-config.private.ts (an overlay: kept out of the public repository, merged in when the file
// exists), the same convention as developer-config.ts / developer-config.private.ts.
//
// A module's `from` is the first top-level declaration that belongs to it; everything after it, up to the next anchor, belongs to it too (the order of this list does not matter:
// each anchor sits where it sits in the file). Declarations the map has never seen fall into the range they sit in. `overrides` places single declarations elsewhere; `keepFrom` is
// where the part that must stay in broker.ts starts: the singletons built when the Lambda loads (clients, configuration read from the environment) and the exported `handler`.
// To plan the split of another checkout: `node scripts/split/split-broker.ts --root <checkout> --dry-run` (exit 2 when the real run would refuse, e.g. an anchor it lacks).
import type { SplitConfig } from "./split-broker.ts";

const broker: SplitConfig = {
  source: "packages/broker/src/aws/broker.ts",
  outDir: "packages/broker/src/aws/broker",
  marker: "split-by: scripts/split/split-broker.ts (the broker's modules are in ./broker/; broker.ts composes them and builds the Lambda handler)",
  headerPrefix: "Part of the broker (split out of ../broker.ts):",
  maxLines: 1500,
  keepFrom: "awsClientConfiguration",
  testsListingSourceFiles: ["tests/contract/broker-environment-provided.test.ts", "tests/contract/admin-health-infrastructure.test.ts"],
  testHelper: "tests/support/broker-source.ts",
  modules: [
    { name: "definitions", from: "MAX_ARTIFACT_BYTES", description: "limits, the setup capture policy, the record and dependency types, route keys." },
    { name: "handler", from: "createAwsBrokerHandler", description: "createAwsBrokerHandler: the request router." },
    { name: "workspace-routes", from: "thrownAt", description: "Slack refusal answers, workspace routing, connector and GitHub context." },
    { name: "project-registration", from: "parseRegistrationInput", description: "project registration, cloud project creation, the project catalog and setup admission." },
    { name: "workspace-preparation", from: "MEMBERSHIP_PREPARATION_ATTEMPTS", description: "workspace preparation, Slack identities, shared threads and Slack bindings." },
    { name: "thread-workspaces", from: "closeOperationParts", description: "closing workspaces, admitting Slack work, thread workspaces and their preparation." },
    { name: "task-operations", from: "resolveWorkspace", description: "agent steps, the task operation parts, application selection, agent skills and tools." },
    { name: "acceptance", from: "acceptTask", description: "accepting tasks and pull requests, and cancelling tasks." },
    { name: "slack-workflow-events", from: "SlackStopTaskEvent", description: "Slack workflow, people and note events." },
    { name: "callbacks", from: "handleCallback", description: "worker callbacks, workflow candidate export, build source and baseline source." },
    { name: "evidence-and-setup", from: "GROUNDING_SOURCE_REFUSED_REASON", description: "workflow E2E evidence upload and project setup evidence and callbacks." },
    { name: "workflow-e2e-verification", from: "WorkflowE2EProjection", description: "verifying workflow E2E evidence, authority checks and presentations." },
    { name: "feedback-and-codebuild", from: "projectSetupDomainRecord", description: "callback refusals, feedback approvals, CodeBuild records and pull request updates." },
    { name: "terminal-and-github-events", from: "queuedFirstTask", description: "queued first tasks, terminal results, GitHub workflow events, merge recovery." },
    { name: "e2e-rounds", from: "requireApplicationSelectionStillCurrent", description: "application E2E rounds (baseline, replay, grounding) and their dispatch." },
    { name: "workflow-items", from: "retryDueWorkflowDispatches", description: "retries, evidence jobs and the items each completed workflow step writes." },
    { name: "terminal-result", from: "checkCommandCouldNotRun", description: "recording a task's terminal result and the stop, end and close notices." },
    { name: "records", from: "pageEvents", description: "reading artifacts, workspaces, projects, pull requests and memberships." },
    { name: "admin-and-helpers", from: "swebenchDependencies", description: "SWE-bench routes, admin task reads, keys, request parsing helpers and event hooks." },
    { name: "runtime-clients", description: "the AWS client configuration, DynamoDB client, Step Functions client and EC2 session manager." },
  ],
  overrides: {
    awsClientConfiguration: "runtime-clients",
    documentClient: "runtime-clients",
    stepFunctions: "runtime-clients",
    ec2Sessions: "runtime-clients",
  },
};

export const CONFIGS: Record<string, SplitConfig> = { broker };
