// Known differences found by the facet readers (messages, spend, audit). Same rules as known-differences.ts. The wildcard entries list exactly the values
// they explain (`only`); a value outside them is a new finding. Each value's cause is in the entry's text.
import type { KnownDifference } from "../known-differences.js";

const counts = (word: string, max: number): string[] => Array.from({ length: max }, (_unused, index) => `${word}=${String(index + 1)}`);

/** Every action the composition root admits (cloud-modules.ts CORE_ADMISSION_ACTIONS), as the core engine's spend words. */
const ADMITTED = ["task.start", "machine.start", "autofix.base-merged", "nightly.run", "model.call"].map((action) => `admitted:${action}`);

export const FACETS_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "*", facet: "messages", only: [...counts("progress", 15), ...counts("pr_opened", 3), ...counts("pr_updated", 3), ...counts("ready", 3)],
    cause: [
      "(1) progress / pr_opened / pr_updated (Cloud only): Cloud's thread narrates the task (\"Started on Quick\", \"The workspace is ready\", \"Coding plan approved by\", \"The check passed\", \"Rovara sent this back to coding\",",
      "\"The base branch was merged into this pull request\", \"Draft pull request opened\", \"Pushed the fix to PR\"). The core tells the person only what needs them (attention kinds, core/notify/attention.ts",
      "attentionKindOf: needs_you / paused / ready / failed / done) and has no narration and no \"pull request opened\" notice (a draft PR waiting for review is no attention state).",
      "(2) ready (core only): the core tells the person a pull request is ready to merge (attention kind `ready`); Cloud's thread posts no such message (its PR post already says to approve and press Merge).",
      "Once Slack is the core's channel adapter (H1, A8), Cloud users lose the narration and the PR posts, and get a new \"ready\" notice.",
    ].join(" "),
    owner: "Owner decision 143(b): Slack threads get key milestones only (plan ready, PR opened, done) plus every needs-you notice, replacing today's narration. Intended once done; ROOT TO-DO (S0-143b): the core sends the three milestones to the thread (Code upstream: progress channel events from the stage machine and a pr_opened attention kind (core/notify/attention.ts attentionKindOf)",
  },
  {
    scenario: "*", facet: "spend", only: [...ADMITTED, "refused:learning.call:admission_action_unknown"],
    cause: [
      "(1) admitted:* (core only): the core asks Admission before a start, a machine and a base-merged autofix, and the core engine records each decision. Cloud's admitWork",
      "(packages/broker/src/spend/admission.ts admitWork) writes nothing when it admits, so an admission is not observable on Cloud's path, and the journey harness wires no model access, so Cloud's",
      "start skips admitWork altogether (packages/broker/src/aws/developer-tasks/start.ts, `if (deps.modelAccess !== undefined)`) and mints no model key (no OPEN_MODEL_KEY / LEDGER rows).",
      "Not a product difference; a harness gap. (2) refused:learning.call:admission_action_unknown (core only, after a merge): REAL GAP, Cloud side. After a merged task the core's lessons",
      "model asks Admission for `learning.call` (vendor/rovara-code/packages/broker/src/local/app/lessons-model.ts:68, the lessons reflection) and CORE_ADMISSION_ACTIONS in",
      "packages/broker/src/cloud/app/cloud-modules.ts has no rule for it, so CloudAdmission refuses it (fail closed): with the switch on and the core's lessons model wired, no lesson is reflected. Fix: add `learning.call: { kind: \"hold\", unknownCostUsd: <learning worst case> }` (or a deliberate refusal with a reason) and widen",
      "tests/unit/cloud-app-modules.test.ts to scan packages/broker/src/lessons and every admit() caller in the vendored broker, not only core/.",
    ].join(" "),
    owner: "(1) people-money lane: give createWorkflowE2E a model-access fake so Cloud's admitWork runs and its key ledger writes rows; (2) S0: CORE_ADMISSION_ACTIONS + its scan test",
  },
  {
    scenario: "*", facet: "audit",
    only: ["task.started", "task.start_refused", "task.closed", "approval.decided", "session.stopped", "session.closed", "session.message_sent", "pull_request.merged"],
    cause: [
      "(1) task.* / approval.decided / session.* (core only): the core audits every task start, refused start and close, every plan decision and every session stop; A7 added these Cloud actions",
      "for exactly that (packages/cloud-contracts/src/audit.ts, the A7 block of AUDIT_ACTIONS) because Cloud's own flows never recorded them for a Slack-started task (Cloud audits approval.decided only",
      "for agent approvals, packages/broker/src/agents/approvals-decide.ts, and session.stopped only through agent-sessions/stop.ts). With the switch on the ledger gains these events: intended.",
      "(2) pull_request.merged (Cloud only): REAL GAP, core side. Cloud records the merge from the GitHub webhook (packages/broker/src/aws/github-webhooks.ts:380, auditPullRequestMerged);",
      "the core's merge observation (vendor/rovara-code/packages/broker/src/core/merge/merged.ts mergedStateItems, :76) commits the merged state and milestone with no audit event, and A7's map has no",
      "core action for it. With the switch on, merges disappear from the audit ledger. Fix (Code upstream): stage a `pull_request.merged` AuditEvent (subject change_request, details number + repository)",
      "in mergedStateItems' transaction; then map it in packages/broker/src/cloud/adapters/audit-sink/event-map.ts to Cloud's pull_request.merged (fact number).",
    ].join(" "),
    owner: "(1) intended: owner decision 143(a) keeps the core's task.started and own-plan approval entries in Cloud (fuller trail); (2) Code upstream (core/merge/merged.ts) + A7 event map",
  },
  // Scenario-specific facet differences. Most are the messages / audit side of a transitions difference another entry explains: where the core stops or asks
  // again, it tells the person differently. They change with that difference.
  {
    scenario: "plan-changes-requested", facet: "messages",
    cause: "Consequence of the core re-plan bug (plan-changes-requested transitions): Cloud posts the v2 plan card (needs_you=2), the core never re-plans so it asks once. Fixed upstream in Code #484; gone after the vendor pin bump.",
    owner: "vendor pin bump to a code/next with #484",
  },
  {
    scenario: "review-findings-send-back", facet: "messages",
    cause: "With the same transitions, the core queues a second needs_you while Rovara sends the work back by itself after the review findings (likely cause: the session status the core derives during the automatic send-back reads as needing the person, contracts/src/task-status.ts sessionTaskStatus); Cloud only narrates \"Rovara sent this back to coding by itself\" (progress). The person is told they are needed when they are not.",
    owner: "Code upstream (core/notify: no needs_you for an automatic send-back) after confirming the summary status; resilience lane to confirm",
  },
  {
    scenario: "base-branch-drift", facet: "messages",
    cause: "Consequence of base-branch-drift's transitions (merge lane): after the base-merged re-check the core blocks VERIFY (\"couldn't confirm the selected checks ran\") and asks the person again (needs_you=2, plus ready); Cloud re-checks without asking.",
    owner: "merge lane's transitions entry",
  },
  {
    scenario: "merge-base-drift-autofix", facet: "messages",
    cause: "The same base-drift path with the automatic fix: the core tells ready twice and asks once more (needs_you=2); Cloud narrates the sync (\"Brought PR up to date\", \"Running the selected checks\") and asks once.",
    owner: "merge lane",
  },
  {
    scenario: "parallel-parts", facet: "messages",
    cause: "Consequence of parallel-parts' transitions (features lane): Cloud's Full path asks for the requirements, the design and the coding plan (needs_you=3) and opens the PR; the core stops after its first document (needs_you=1).",
    owner: "features lane's transitions entry",
  },
  {
    scenario: "parallel-parts", facet: "audit",
    cause: "Consequence of parallel-parts' transitions: the core stops before the pull request, so no pull_request.opened (Cloud records one).",
    owner: "features lane's transitions entry",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "messages",
    cause: "Cloud asks for three documents (requirements, design, coding plan: needs_you=3); the core asks twice (needs_you=2): the core's batched notices merge two of the asks inside one batch window (core/notify/attention.ts, NOTIFY_BATCH_MINUTES) or one document is not an attention state on the core.",
    owner: "features lane to confirm which; Code upstream if a document wait is not told",
  },
  {
    scenario: "worker-lost", facet: "messages",
    cause: "Consequence of worker-lost's transitions (resilience lane): Cloud notices the lost run and tells the person (\"Coding stopped before it finished\", failed); the core never ends the run in the harness, so it tells nothing.",
    owner: "resilience lane's transitions entry",
  },
  {
    scenario: "mcp-tools", facet: "messages",
    cause: "A task started from the editor (MCP): Cloud has no Slack thread for it and posts nothing; the core tells the owner on their chosen chat (notice settings targets), as it does for any task. Cloud's needs-you notifier (packages/broker/src/notifications/attention.ts) would tell them, but the journey harness runs no session projection.",
    owner: "intended on the core; harness gap on Cloud (no agent-session projection in createWorkflowE2E)",
  },
  {
    scenario: "outbound-events", facet: "messages",
    cause: "Consequence of outbound-events' transitions (features lane): the core run stops at PLAN/RUNNING, so it never reaches the plan card (Cloud: needs_you=1 plus narration).",
    owner: "features lane's transitions entry",
  },
];
