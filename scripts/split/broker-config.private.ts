// Rovara Cloud only: the anchors and overrides of modules whose declarations exist in this repository but not in the public one, added to the shared groups in broker-config.ts.
// Keep this file out of the public repository (its names are private features). The script merges it in when the file exists. `moduleOrder` is the order the original file had
// the parts in (it is the order tests read the files in).
import type { ConfigOverlay } from "./split-broker.ts";

const broker: ConfigOverlay = {
  modules: [
    { name: "scope-helpers", from: "brokerEnvironmentName", description: "environment, organisation and GitHub scope helpers, egress decisions, connection stores." },
    { name: "dependency-wiring", from: "agentRouteDependencies", description: "builds the dependency objects handed to the agent, chain, admin, plan and developer-task routes." },
    { name: "model-access", from: "agentRunHostOf", description: "write gate, model access (web and Slack), turn routing and budgets." },
    { name: "pull-request-reconcile", from: "freshLinearKey", description: "Linear lines, pull request reconciliation, event append and artifacts." },
    { name: "sweeps-and-readiness", from: "isAuditDrainEvent", description: "scheduled event predicates, dispatch failure records, E2E readiness." },
    { name: "dispatch", from: "runAgentRunDispatch", description: "agent run, workflow and autofix dispatch." },
    { name: "plan-answers", from: "spendLimitKind", description: "plan critique, plan answers, CI checks and planner replies." },
  ],
  overrides: {
    serviceStatusRouteDependencies: "dependency-wiring",
  },
  moduleOrder: ["definitions", "scope-helpers", "dependency-wiring", "handler", "workspace-routes", "project-registration", "workspace-preparation", "thread-workspaces", "task-operations", "model-access", "acceptance", "slack-workflow-events", "callbacks", "evidence-and-setup", "workflow-e2e-verification", "feedback-and-codebuild", "pull-request-reconcile", "terminal-and-github-events", "sweeps-and-readiness", "dispatch", "e2e-rounds", "workflow-items", "plan-answers", "terminal-result", "records", "admin-and-helpers", "runtime-clients"],
};

export const OVERLAYS: Record<string, ConfigOverlay> = { broker };
