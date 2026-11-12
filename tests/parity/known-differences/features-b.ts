// Known differences found by the tracker intake, slack channel, model selection, audit ledger, script tokens, realtime and outbound events drivers. Same
// rules as known-differences.ts. The drivers' feature outcomes ride in the audit facet with the `feature:` prefix (features-b-support/outcomes.ts), so a
// scenario's audit entry below explains both its feature words and the audit actions both paths recorded in it.
import type { KnownDifference } from "../known-differences.js";

/** The audit difference every task run shows, from the audit ledger scenario (said once, referred to by the others). */
const LEDGER_GAP = [
  "Cloud's path records no `task.started` for a task it starts (packages/cloud-contracts/src/audit.ts:442 declares the action and its facts, but no Cloud builder in",
  "packages/broker/src/audit/events.ts writes it), while the core stages one in the start's own transaction (core/task-flow/start.ts:215) and A7's map turns it into Cloud's",
  "`task.started`. Cloud's path records no audit for an owner approving their own plan from Slack (aws/developer-tasks/decide.ts recordPlaceDecision audits only a",
  "decision by someone other than the owner or a medium approval from outside the app, as `approval.place_decided`), while the core's approval gate records",
  "`approval.decided` for every plan decision.",
].join(" ");

export const FEATURES_B_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "audit-ledger", facet: "audit",
    cause: [
      `Ordered ledger, Cloud: project.checks_changed, pull_request.opened; core (mapped by A7): task.started, approval.decided, pull_request.opened. ${LEDGER_GAP}`,
      "Cloud's `project.checks_changed` is its project registration (playbook/project-settings-audit.ts auditedWrite, written by the definition registration); the core's",
      "project registration (`POST /v1/admin/projects`) audits nothing. With the switch, Cloud's ledger gains task.started and approval.decided for core tasks only, so",
      "during coexistence the ledger reads differently by engine; project registration stays on Cloud's route, so its record is not lost.",
      "Proposed: decide one rule for both (owner); if task starts and own-plan approvals are to be in the ledger, add the Cloud writers (start.ts, decide.ts) before the",
      "switch so the ledger does not depend on the engine; else map the core's two actions to nothing in A7's event map.",
    ].join(" "),
    owner: "owner decision (audit content), then A7 event map or Cloud's start/decide writers",
  },
  {
    scenario: "script-tokens", facet: "audit",
    cause: [
      "Script tokens behave the same: on both paths a token with read and start on the project makes a task (client \"Script token\"), reads it, and is refused",
      "approve, stop and close with 403 FORBIDDEN; the plan that waits stays undecided; both audit script_token.created and script_token.used. The only difference is",
      `the core's task.started audit event (two token-or-owner starts), which Cloud never writes. ${LEDGER_GAP}`,
      "Note: Cloud refuses to make a token on an install without the audit ledger (AUDIT_UNAVAILABLE); the Cloud context gives its broker the ledger.",
    ].join(" "),
    owner: "as audit-ledger",
  },
  {
    scenario: "model-selection", facet: "audit",
    cause: [
      "Real gap in the composition root: Cloud's path tells each step's worker its model (PLAN and IMPLEMENT amazon-bedrock/us.anthropic.claude-sonnet-4-6, REVIEW",
      "amazon-bedrock/us.anthropic.claude-opus-5-5, from the install's model settings); the core's invocations carry no `payload.model` at all, because no `model-provider`",
      "adapter is registered (the local composition finds no provider key; packages/broker/src/cloud/app/cloud-modules.ts cloudAdapterModules registers none either: A3's",
      "bedrock-role, litellm and openrouter providers exist in packages/broker/src/cloud-adapters/model-provider/ but are not in the list) and nothing maps Cloud's project",
      "and company model settings onto the core's model selection service. With the switch, a core step's worker would run on its own default model. Proposed: add A3's",
      `model-provider modules to cloudAdapterModules and map Cloud's per-project model choice (S0-Q2) onto core flowOptions.stepModels / usableModels. Also: ${LEDGER_GAP}`,
    ].join(" "),
    owner: "S0 follow-up (cloud-modules model providers + S0-Q2 settings mapping)",
  },
  {
    scenario: "outbound-events", facet: "audit",
    cause: [
      "Outbound events are the same: neither path sends one (Cloud has no outbound events feature, plan row 43; the core publishes to every registered `outbound-events`",
      "adapter and neither the local composition nor cloud-modules.ts registers one). What the core WOULD send once an adapter is registered is not compared: that needs a",
      `recording outbound-events module in tests/support/cloud-core-fakes.ts (shared file). The rest is the core's task.started: ${LEDGER_GAP}`,
    ].join(" "),
    owner: "as audit-ledger; a recording outbound adapter in the fakes to compare the events themselves",
  },
];
