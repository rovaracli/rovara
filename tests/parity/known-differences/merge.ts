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
  "UPDATED for the 0.5.17 pin (public #502): the core now calls its `taskEnded` seam when a merge completes the task too, and the suite's core writes DEVTASK#<task>/TASK_END on merge; the row no longer differs in pr-merged. (Before the pin: the core called the seam only from close, vendor core/task-flow/close.ts:69.) The root's side is built (cloud/rows/core-rows.ts coreTaskEndedHandler maps the seam",
  "onto Cloud's onTaskEnded, tested in tests/unit/cloud-core-rows.test.ts); what stays open is Code's: the core must call the seam on MERGED/COMPLETE too (upstream), and the suite's core runs Code's local composition, which has no Cloud handler.",
  "(3) Core-only DEVTASK#<task>/CODE_MILESTONE#approved#<n>: the core's tracking pass announces the person's approval (\"Approved by maint. Ready to merge\", vendor core/merge/merge-tracking.ts:604-620);",
  "Cloud's same rule (packages/broker/src/rovara-code/merge-tracking.ts:716-734) did not announce it for the same review. The rule is identical; the inputs differ: Cloud counts an approval only",
  "from a reviewer its member directory knows (`linkedAmong`/`nonWritersAmong` over Cloud's members), the core's local people seam (`soleOwnerPeople`) counts any write-access reviewer.",
  "The root's side is built: cloud/app/merge-people.ts answers MergePeople from Cloud's member directory (tested in tests/unit/cloud-app-wiring.test.ts). The suite's core is Code's local composition, which hard-wires `soleOwnerPeople`, so the difference shows until the root composes merge tracking itself (S0-Q1: Code does not export its service layer).",
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
