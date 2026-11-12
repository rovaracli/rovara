// Known differences found by the second review, design review, e2e, parallel parts and lessons drivers. Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

export const FEATURES_A_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "parallel-parts", facet: "transitions",
    cause: [
      "Core bug (same root as plan-changes-requested): with Understand off (the settings the composition root maps from Cloud), a Full task never gets past its first plan.",
      "Approving the requirements writes PLAN/READY and a PLAN dispatch row for the design, but vendor/rovara-code/packages/broker/src/core/task-flow/stage-machine.ts:340 (runDispatchRow,",
      "`if (workflow.stage !== \"PLAN\" || workflow.state !== \"READY\" || assessment?.kind !== \"ready\") return stale();`) starts a plan only after an Understand assessment,",
      "so the row is resolved STALE and the task stays PLAN/READY for ever. Cloud's Full path writes requirements, design and coding plan, builds the parts and opens the pull request.",
      "Proposed fix (Code): a PLAN row of a READY workflow with no assessment starts the next phase's plan (the Quick/Full path without Understand), as Cloud's",
      "startTaskWorkflowPlanFromSystem does. Check whether public #484 (replan after request changes) already covers this branch; if it does, a vendor pin bump closes both.",
    ].join(" "),
    owner: "Code upstream (stage-machine runDispatchRow), then a vendor pin bump",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "transitions",
    cause: "Not the settings mapping (S0-Q2 maps Cloud's Understand setting, which is off on the journey): this variant turns Understand on by hand as a workaround of the G3 core stall (a Full task never passes its first plan with Understand off), so the Full path advances; the one extra UNDERSTAND/RUNNING at the start is that workaround. The parts themselves (plans, approvals, coding with A and B side by side and C on both, reviews, the pull request) follow the same stages as Cloud's path.",
    owner: "G3 vendor re-pin (public #484); disappears once the re-pin lands and the variant is retired",
  },
  {
    scenario: "parallel-parts", facet: "features",
    cause: "Consequence of the parallel-parts transitions bug: the core never reaches the coding run, so it records none of the parts' checkpoints Cloud's worker reports (A and B started side by side, then C on both). With Understand on (features-a-parallel-parts-understand) the checkpoints compare the same, in the same order.",
    owner: "Code upstream (as the transitions entry)",
  },
  {
    scenario: "parallel-parts", facet: "decisions",
    cause: "Consequence of the parallel-parts transitions bug: the core never reaches the design and coding plans, so only the requirements approval is recorded (Cloud records three).",
    owner: "Code upstream (as the transitions entry)",
  },
  {
    scenario: "parallel-parts", facet: "rows",
    cause: "The stall (no pull request row on the core) plus the rows every scenario shows (limits D3, the artifact key), plus Cloud's DEVTASK#<id>/OUTCOME_KEYS#<hash> track-record row (Cloud-only, decision 41: written when a pull request opens).",
    owner: "Code upstream (stall); the rest as the core lane's rows entry",
  },
  {
    scenario: "parallel-parts", facet: "codeHost",
    cause: "Consequence of the stall: the core never opens the pull request Cloud's path opens.",
    owner: "Code upstream (as the transitions entry)",
  },
  {
    scenario: "parallel-parts", facet: "messages",
    cause: "The stall (the core sends one needs-you notice; Cloud's path posts every phase, the progress lines and the pull request) and the Full path's phase posts (Requirements/Design ready and approved) the facets lane's message map leaves as `other:`.",
    owner: "Code upstream (stall); facets lane (map the Full path's phase posts)",
  },
  {
    scenario: "parallel-parts", facet: "spend",
    cause: "The core engine records the A5 adapter's admissions (task.start, machine.start); the Cloud spend reader saw no admission words on this path (Cloud's path admits through admitWork without a SPEND# write for a task with no limit). General facet difference, see known-differences/facets.ts.",
    owner: "facets lane",
  },
  {
    scenario: "parallel-parts", facet: "audit",
    cause: "The stall (no pull_request.opened on the core) and the general audit vocabulary differences of known-differences/facets.ts (Cloud's project.checks_changed when realProjectCommands registers the project's readiness; the core's task.started and approval.decided have no Cloud audit type).",
    owner: "facets lane; Code upstream (stall)",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "rows",
    cause: [
      "NEW (not in the plan's D table): the parts' checkpoints are worker events, kept as OPERATION#<op>/EVENT#<n> on Cloud's path and as WORKSPACE#<w>/EVENT#<op>#<n> on the core.",
      "Cloud readers of a core task's events (the timeline, the progress lines, Ask) must read the core's key before the switch (readers before writers).",
      "Also: the core's Understand artifact (ARTIFACT#<id>#intent.json, the settings difference), Cloud's OUTCOME_KEYS track-record row (Cloud-only), and the limits and artifact-key rows every scenario shows.",
    ].join(" "),
    owner: "S0 follow-up lane (event readers) with the artifact-key item; S0-Q2 for intent.json",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "messages",
    cause: "The core sends needs-you notices only (twice); Cloud's path posts each phase, approval, five progress lines and the pull request. The core's channel events for progress and the pull request are not delivered as notices in the local composition, and the Full path's phase posts are unmapped (`other:`). General messages difference, see known-differences/facets.ts.",
    owner: "facets lane (mapping); S0 (which core channel events Cloud's Slack adapter turns into posts)",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "spend",
    cause: "As parallel-parts/spend: the core engine records A5's admissions, the Cloud reader saw none on this path. See known-differences/facets.ts.",
    owner: "facets lane",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "audit",
    cause: "General audit vocabulary differences (known-differences/facets.ts): Cloud's project.checks_changed (the readiness this scenario registers) has no core event; the core's task.started and approval.decided have no Cloud audit type on this path.",
    owner: "facets lane / A7 event map",
  },
];
