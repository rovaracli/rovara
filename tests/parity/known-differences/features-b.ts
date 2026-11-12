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
    scenario: "model-selection", facet: "features",
    cause: [
      "Real gap in the composition root: Cloud's path tells each step's worker its model (PLAN and IMPLEMENT amazon-bedrock/us.anthropic.claude-sonnet-4-6, REVIEW",
      "amazon-bedrock/us.anthropic.claude-opus-5-5, from the install's model settings); the core's invocations carry no `payload.model` at all, because no `model-provider`",
      "adapter is registered (the local composition finds no provider key; packages/broker/src/cloud/app/cloud-modules.ts cloudAdapterModules registers none either: A3's",
      "bedrock-role, litellm and openrouter providers exist in packages/broker/src/cloud-adapters/model-provider/ but are not in the list) and nothing maps Cloud's project",
      "and company model settings onto the core's model selection service. With the switch, a core step's worker would run on its own default model. Proposed: add A3's",
      "model-provider modules to cloudAdapterModules and map Cloud's per-project model choice (S0-Q2) onto core flowOptions.stepModels / usableModels.",
    ].join(" "),
    owner: "S0 follow-up (cloud-modules model providers + S0-Q2 settings mapping)",
  },
  {
    scenario: "realtime", facet: "features",
    cause: [
      "Real gap on Cloud's side, the realtime face of R-SESSIONS (resilience lane): with the agent-session projector and Cloud's real notice sink run over every write of",
      "the journey (features-b drivers), a Slack-started Quick task tells an open page NOTHING: the task has no agent session (`sessions:0`), so the projector",
      "(agent-sessions/projector.ts:89 resolveTask) finds no `sessionId` on the task and refreshes nothing, and realtime/sink.ts never runs. The core gives every task a",
      "session at start (`sessions:1`) and publishes `attention.changed` when it needs the person. With the switch, core tasks start telling open pages; Cloud tasks keep",
      "not telling them. Proposed (Cloud, before the switch only if Cloud's path stays for some tasks): give Slack workflow tasks their session (workflow task `agent`/`origin`,",
      "or a workflow branch in agent-sessions/create.ts lazyTaskSessionInput :296), so the projector and the sink run for them. Also: the core's realtime adapter here is the",
      "local composition's in-process publisher; A8's AppSync publisher is the Cloud adapter of the point and is not registered by the root yet (cloud-modules.ts).",
    ].join(" "),
    owner: "Cloud agent-sessions (workflow task sessions) or accepted as fixed by the switch; S0 follow-up registers A8's realtime publisher",
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
    owner: "Code upstream (approval cards to chats) + owner decision (Slack plan approval vs step-up) + S0 root wiring of the Slack sink",
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
