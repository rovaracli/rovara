// Known differences found by the merge tracking, branch sync, merge conflicts drivers. Same rules as known-differences.ts.
//
// Comparable conditions (see the drivers): both engines run the task on Rovara Code version 2 (definition 1.1.0 with a program, set the way the
// branch-sync journeys set it), GitHub shows one passing CI check and a write-access person's approval, and Cloud's automatic fix switch `af` maps onto
// the core's autofix option (off unless a scenario has `feature: autofix-on`). With those, transitions, decisions and code host actions compare the same
// in all four merge scenarios. What differs is below.
//
// Several entries list only the values this lane explains (the merge-specific ones). A facet whose difference also holds values another lane explains
// (the limits rows of every scenario, the facets lane's message and spend words) is explained only when the suite reads the matching entries together
// (proposed shared change: parity.test.ts explains a facet when the union of the `only` lists of every entry for that scenario and facet, plus `*`
// entries, covers each differing value).
import type { KnownDifference } from "../known-differences.js";

const MERGE_SCENARIOS = ["pr-merged", "base-branch-drift", "merge-conflict", "merge-base-drift-autofix"] as const;

const MERGE_ROWS = [
  "DEVTASK#<id> | OUTCOME_KEYS#<hash>", "DEVTASK#<id> | TASK_END", "DEVTASK#<id> | CODE_MILESTONE#approved#<n>",
];

const ROWS_CAUSE = [
  "(1) Cloud-only DEVTASK#<task>/OUTCOME_KEYS#<hash>: Cloud's track-record outcome hooks (packages/broker/src/rovara-code/outcome-hooks.ts) key a task's outcome when its pull request opens;",
  "the core has no track record (area 14/15, Cloud-only team record). Not a bug; the root wires the hook as an outbound-events or learning adapter when lessons move (X2).",
  "(2) Cloud-only DEVTASK#<task>/TASK_END (pr-merged): Cloud's task-end record (packages/broker/src/agents/task-end.ts:118, its end handlers: triggers, chains, agents) is written when the task ends;",
  "the core calls its `taskEnded` seam only from close (vendor core/task-flow/close.ts:69), not when a merge completes the task. The root's side is built (cloud/rows/core-rows.ts coreTaskEndedHandler maps the seam",
  "onto Cloud's onTaskEnded, tested in tests/unit/cloud-core-rows.test.ts); what stays open is Code's: the core must call the seam on MERGED/COMPLETE too (upstream), and the suite's core runs Code's local composition, which has no Cloud handler.",
  "(3) Core-only DEVTASK#<task>/CODE_MILESTONE#approved#<n>: the core's tracking pass announces the person's approval (\"Approved by maint. Ready to merge\", vendor core/merge/merge-tracking.ts:604-620);",
  "Cloud's same rule (packages/broker/src/rovara-code/merge-tracking.ts:716-734) did not announce it for the same review. The rule is identical; the inputs differ: Cloud counts an approval only",
  "from a reviewer its member directory knows (`linkedAmong`/`nonWritersAmong` over Cloud's members), the core's local people seam (`soleOwnerPeople`) counts any write-access reviewer.",
  "Owner: the A6 people adapter must back the core's MergePeople seam in the root (S0-Q1), then this row should match; needs a check that Cloud's directory would count `maint`.",
  "Not listed here any more (decided, ROWS): the core's WORKSPACE#<w>/VERIFIED_FILES#<digest> cache is core-private (D19, no Cloud reader asks for it), the artifact key, the operation events and the limit family are read",
  "in both shapes by Cloud's readers (D17, D18, D3: cloud/rows/core-rows.ts) and compare as one family in the suite's normalization.",
].join(" ");

const rowsEntries: KnownDifference[] = MERGE_SCENARIOS.map((scenario) => ({
  scenario, facet: "rows", only: MERGE_ROWS, cause: ROWS_CAUSE,
  owner: "Code upstream (taskEnded on merge), S0 root wiring (MergePeople from A6); OUTCOME_KEYS stays Cloud-only until X2",
}));

export const MERGE_DIFFERENCES: readonly KnownDifference[] = [
  ...rowsEntries,
  {
    scenario: "pr-merged", facet: "audit", only: ["pull_request.merged"],
    cause: [
      "BUG (core): a merged pull request leaves no audit event on the core. Cloud's webhook path stages `pull_request.merged` for each pull request a save moves to MERGED",
      "(packages/broker/src/aws/github-webhooks.ts:380, builder packages/broker/src/audit/events.ts:154). The core records the merge through mergedStateItems (vendor core/merge/merged.ts:76) and",
      "stages no audit event there (only pull_request.opened at core/build-step/publish.ts:234 and pull_request.merge_requested at core/merge/merge.ts:624). With the switch on, merges of core tasks would",
      "be missing from the audit ledger. Proposed fix (Code upstream): in the merged save (merged.ts, the commit that moves a pull request to MERGED) add `deps.audit.stage({ action: \"pull_request.merged\",",
      "eventId: `pull_request.merged:${repositoryKey}#${number}`, subject: { type: \"change_request\", id: `${repositoryKey}#${number}` }, actor: { type: \"system\" } })` once per newly merged pull request,",
      "and add the name to A7's event map (Cloud type pull_request.merged).",
    ].join(" "),
    owner: "Code upstream (core/merge/merged.ts) + A7 event map; blocks the combined switch (audit chain completeness)",
  },
  {
    scenario: "merge-base-drift-autofix", facet: "spend", only: ["admitted:autofix.base-merged"],
    cause: "The core asks Admission before the automatic recheck after a base merge (`autofix.base-merged`, vendor core/build-step/autofix.ts:35, 169); Cloud's path runs the same recheck through its own day budget, which the Cloud spend reader does not show as an admission. Same decision, different recording.",
    owner: "facets lane (Cloud spend reader) to map Cloud's base-merged allowance to the same word",
  },
  {
    scenario: "merge-conflict", facet: "messages", only: ["pr_updated=1"],
    cause: "Cloud tells the thread \"Pushed the fix to PR #1\" after the conflict fix is pushed (pr_updated); the core's notices have no pull-request-updated kind (core/notify sends ready / needs_you). Notice gap on the core.",
    owner: "Code upstream (core/notify: a pr_updated notice on a pushed fix) or accepted by the owner",
  },
  ...(["pr-merged", "base-branch-drift", "merge-conflict", "merge-base-drift-autofix"] as const).map((scenario): KnownDifference => ({
    scenario, facet: "messages", only: ["ready=1", "ready=2"],
    cause: "The core's \"Approved by maint. Ready to merge\" notice comes from its approved milestone, which Cloud did not write for the same approval (see the rows entry, cause 3).",
    owner: "S0 root wiring (MergePeople from A6), then recheck",
  })),
];
