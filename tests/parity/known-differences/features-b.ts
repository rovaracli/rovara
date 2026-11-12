// Known differences found by the tracker intake, slack channel, model selection, audit ledger, script tokens, realtime and outbound events drivers. Same
// rules as known-differences.ts. The drivers' feature outcomes are compared on the `features` facet (features-b-support/outcomes.ts). The audit actions
// these scenarios record (the core's task.started and approval.decided) are the facets lane's audit entry, not repeated here.
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
    scenario: "realtime", facet: "features",
    cause: [
      "Both paths now tell an open page (each has the task's session: sessions:1). What they publish differs in vocabulary: Cloud's agent-session projector and notice sink publish `home.changed` and `session.updated`;",
      "the core's realtime port publishes `attention.changed` when the task needs the person. The core's adapter here is the local composition's in-process publisher; lane A8's AppSync publisher is the Cloud adapter of the",
      "point and is not registered by the root yet (cloud-modules.ts, WIRING), and it must carry the core's notice to the pages that listen for Cloud's two.",
    ].join(" "),
    owner: "S0 follow-up (WIRING): register A8's realtime publisher and map the core's notice onto the page's two notices",
  },
  {
    scenario: "audit-ledger", facet: "features",
    cause: [
      `Ordered ledger, Cloud: project.checks_changed, pull_request.opened; core (mapped by A7): task.started, approval.decided, pull_request.opened. ${LEDGER_GAP}`,
      "Cloud's `project.checks_changed` is its project registration (playbook/project-settings-audit.ts auditedWrite, written by the definition registration); the core's",
      "project registration (`POST /v1/admin/projects`) audits nothing. With the switch, Cloud's ledger gains task.started and approval.decided for core tasks only, so",
      "during coexistence the ledger reads differently by engine; project registration stays on Cloud's route, so its record is not lost.",
      "Proposed: decide one rule for both (owner); if task starts and own-plan approvals are to be in the ledger, add the Cloud writers (start.ts, decide.ts) before the",
      "switch so the ledger does not depend on the engine; else map the core's two actions to nothing in A7's event map.",
    ].join(" "),
    owner: "Intended: owner decision 143(a) keeps the core's task.started and own-plan approval audit entries in Cloud; nothing to change on either side",
  },
  {
    scenario: "slack-channel", facet: "features",
    cause: [
      "Real gap on the core: a plan cannot be approved from the Slack thread. Cloud posts the plan card with Approve in the thread and the press decides it (decision 99,",
      "inside the sign-in window). On the core, no approval card is ever posted to a chat: core/channel/cards.ts postApprovalCard (:64) has no caller in the vendored core",
      "(the plan's approval_request never reaches the channel); and even when one is, lane A8's CloudSlackChannel lists `plan_approval` in `stepUp`",
      "(packages/broker/src/plugins/channel/slack-cloud/adapter.ts, `stepUp`), so the card would carry no buttons and the sink refuses a press (`step_up`). The start",
      "through the channel compares the same (`slack:start:task_started`) once the test wires what the root owes (inboundFromQueuedSlackRequest into the sink, a Cloud",
      "ChannelWork, the CHANNEL_TENANTS row via A8's backfill). Proposed: Code posts the approval card to the task's thread when the plan waits (a caller of",
      "postApprovalCard in the stage machine's plan-review step); the owner decides whether `plan_approval` stays a step-up kind for Slack on the core, since decision 99",
      "lets Cloud's Slack approve inside the window today.",
    ].join(" "),
    owner: "Owner decision 144: low- and medium-risk plans are approved in the Slack thread; a high-risk plan needs the web app with a fresh sign-in, and its card links there. TO-DOs: (Code, S0-144-code) the stage machine's plan-review step calls postApprovalCard, with buttons by risk (high risk: a link to the web app, no buttons); (root, S0-144-root) A8's CloudSlackChannel step-up list by risk (plan_approval step-up only for high risk) instead of always; plus the S0 root wiring of the Slack sink. Cloud's own Slack follows 144 too (today decision 99 allows any risk inside the window)",
  },
  {
    scenario: "slack-channel", facet: "transitions",
    cause: "Follows from the slack-channel features entry: Cloud's Slack approval decides the plan and the task runs on (IMPLEMENT; it then blocks with \"No code changes were needed\" because the scenario scripts no coding); on the core the plan stays PLAN_REVIEW/WAITING, as nothing in Slack can approve it.",
    owner: "as the slack-channel features entry",
  },
  {
    scenario: "slack-channel", facet: "decisions",
    cause: "Follows from the slack-channel features entry: Cloud records APPROVE from the Slack press; the core records none.",
    owner: "as the slack-channel features entry",
  },
  {
    scenario: "slack-channel", facet: "messages",
    cause: "Follows from the slack-channel features entry: Cloud's thread narrates the approved run (progress posts, then \"No code changes were needed\"); the core, whose plan still waits, tells only needs_you. The narration difference itself is the facets lane's messages entry.",
    owner: "as the slack-channel features entry; narration: facets lane",
  },
];
