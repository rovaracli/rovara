// Known differences found by the second review, design review, e2e, parallel parts and lessons drivers. Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

export const FEATURES_A_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "features-a-parallel-parts-understand", facet: "transitions",
    cause: "Not the settings mapping (S0-Q2 maps Cloud's Understand setting, which is off on the journey): this variant turns Understand on by hand (the G3 stall is closed by the root's workflowDependenciesEnabled mapping, so the base scenario no longer needs it; what it shows now is the extra UNDERSTAND step) (a Full task never passes its first plan with Understand off), so the Full path advances; the one extra UNDERSTAND/RUNNING at the start is that workaround. The parts themselves (plans, approvals, coding with A and B side by side and C on both, reviews, the pull request) follow the same stages as Cloud's path.",
    owner: "Retire the variant after the 0.5.19 switch (S3)",
  },
  {
    scenario: "parallel-parts", facet: "rows",
    cause: "Cloud's DEVTASK#<id>/OUTCOME_KEYS#<hash> track-record row (Cloud-only, decision 41: written when a pull request opens).",
    owner: "As the core lane's rows entry (Cloud-only, decision 41)",
  },
  {
    scenario: "parallel-parts", facet: "messages",
    cause: "The core sends needs-you notices only; Cloud's path posts every phase, the progress lines and the pull request (the Full path's phase posts (Requirements/Design ready and approved) the facets lane's message map leaves as `other:`). The stall that used to add to this is closed (switch blocker G3: the root maps workflowDependenciesEnabled).",
    owner: "S0-143b (milestones to Slack); facets lane (map the Full path's phase posts)",
  },
  {
    scenario: "parallel-parts", facet: "spend",
    cause: "The core engine records the A5 adapter's admissions (task.start, machine.start); the Cloud spend reader saw no admission words on this path (Cloud's path admits through admitWork without a SPEND# write for a task with no limit). General facet difference, see known-differences/facets.ts.",
    owner: "facets lane",
  },
  {
    scenario: "parallel-parts", facet: "audit",
    cause: "The general audit vocabulary differences of known-differences/facets.ts (Cloud's project.checks_changed when realProjectCommands registers the project's readiness; the core's task.started and approval.decided have no Cloud audit type).",
    owner: "facets lane",
  },
  {
    scenario: "features-a-parallel-parts-understand", facet: "rows",
    cause: "Cloud's DEVTASK#<id>/OUTCOME_KEYS#<hash> track-record row (Cloud-only, decision 41: written when a pull request opens). The parts' checkpoint events (D18), the artifact keys (D17) and the limit family (D3) compare as one family each: Cloud's readers read both shapes (cloud/rows/core-rows.ts).",
    owner: "Stays Cloud-only until the lessons adoption (X2)",
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
