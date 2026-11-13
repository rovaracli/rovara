// Differences between Cloud's path and the core that the suite found and that are understood, each with its likely cause and who closes it. The suite
// fails on a difference not listed here, and on a listed one that no longer shows. Removing an entry is the goal: each is fixed in Code (upstream first),
// mapped by the composition root, or accepted by the owner as an intended change.
import type { Facet } from "./harness/types.js";
import { MERGE_DIFFERENCES } from "./known-differences/merge.js";
import { PEOPLE_MONEY_DIFFERENCES } from "./known-differences/people-money.js";
import { RESILIENCE_DIFFERENCES } from "./known-differences/resilience.js";
import { FACETS_DIFFERENCES } from "./known-differences/facets.js";
import { FEATURES_A_DIFFERENCES } from "./known-differences/features-a.js";
import { FEATURES_B_DIFFERENCES } from "./known-differences/features-b.js";
import { FEATURES_C_DIFFERENCES } from "./known-differences/features-c.js";
import { FEATURES_D_DIFFERENCES } from "./known-differences/features-d.js";
import { UNDERSTAND_DIFFERENCES } from "./known-differences/understand.js";

export interface KnownDifference {
  /** A scenario id, or `*` for a difference every scenario that reaches it shows (the same cause). */
  scenario: string;
  facet: Facet;
  cause: string;
  /** Who or what closes it. */
  owner: string;
  /**
   * For `*` entries: the exact values the difference may consist of (what one side has and the other lacks). A difference with anything else in it is NOT
   * explained, so a wildcard never hides a new finding.
   */
  only?: readonly string[];
}

const CORE_LANE_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "*", facet: "rows", only: ["DEVTASK#<id> | RECIPE", "ORG#<org>#BUILTIN_AGENTS | rovara-code"],
    cause: [
      "Cloud's agent-session wiring (production starts every task with it: aws/broker.ts:653, aws/developer-tasks/start.ts createTaskSessionItems; the Cloud engine passes `agentSessions: true`)",
      "writes the task's frozen recipe (DEVTASK#<task>/RECIPE, the recipe pin the task runs on) and the company's built-in agent catalogue row (ORG#<org>#BUILTIN_AGENTS/rovara-code). The core keeps the",
      "task's program on its workflow and has no separate recipe row or per-company built-in catalogue: Cloud-only (decision 41, agents). Open: what Cloud's readers of the frozen recipe",
      "(model pin, autonomy, the plan check) read for a core task is the root's autonomy and model seams (S0-Q2 UNMAPPED_SETTINGS), not a row.",
    ].join(" "),
    owner: "Agents on the core (X lane): the recipe pin as a core record, or readers that take the workflow's program; until then Cloud-only",
  },
  {
    scenario: "plan-changes-requested", facet: "transitions",
    cause: [
      "Core bug found by the suite: with Understand off (Cloud's Quick path; the composition root maps Cloud's settings to understandFirst=false), a plan sent back with \"request changes\" is never re-planned.",
      "The decision writes PLAN/READY and a PLAN dispatch row, but core/task-flow/stage-machine.ts runDispatchRow only starts a PLAN after Understand (it requires workflow.intent.assessment ready)",
      "and resolves the row as STALE, so the task stays PLAN/READY for ever. Cloud's path re-plans (PLAN/RUNNING then PLAN_REVIEW/WAITING v2).",
    ].join(" "),
    owner: "Fixed upstream in public code/next #484 (2026-11-12); shows here until Cloud's vendor pin (0e340c0e) is bumped past it. The suite then fails on this entry as stale: remove it with the bump",
  },
  {
    scenario: "plan-changes-requested", facet: "rows",
    cause: "Same bug as its transitions (the core leaves its PLAN dispatch row and writes its PLAN_FEEDBACK#<n> note row, Cloud keeps the note on the revised plan's run).",
    owner: "Code upstream fix (see transitions); recheck the feedback row's family after it",
  },
];

/** Every known difference: the first lane's, then each lane's own file. */
export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  ...CORE_LANE_DIFFERENCES,
  ...MERGE_DIFFERENCES,
  ...PEOPLE_MONEY_DIFFERENCES,
  ...RESILIENCE_DIFFERENCES,
  ...FACETS_DIFFERENCES,
  ...FEATURES_A_DIFFERENCES,
  ...FEATURES_B_DIFFERENCES,
  ...FEATURES_C_DIFFERENCES,
  ...FEATURES_D_DIFFERENCES,
  ...UNDERSTAND_DIFFERENCES,
];
