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

/** Rows each side writes that the other does not, all from the two causes below (limits D3, the artifact key). */
const LIMIT_AND_ARTIFACT_ROWS = [
  "ORG#<org>#SLACK_LIMIT#T0BSHLLUGBD | MEMBER#U0MAYA001", "ORG#<org>#SLACK_LIMIT#T0BSHLLUGBD | ORGANIZATION",
  "DEVELOPER_LIMIT#<person> | MEMBER", "DEVELOPER_LIMIT#<person> | TASK#<id>", "ORG#<org>#DEVELOPER_LIMIT#ORGANIZATION | ORGANIZATION",
  "WORKSPACE#<id> | ARTIFACT#<id>", "WORKSPACE#<id> | ARTIFACT#<id>#plan.md",
];

const CORE_LANE_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "code-defaults-quick", facet: "transitions",
    cause: "Settings, not logic: Code's flow defaults run Understand first and the plan check (UNDERSTAND, PLAN_CRITIQUE stages); Cloud's Quick path runs neither. The composition root must map Cloud's settings (rovaraCodeV2, plan check, the task path) onto the core's flow options (understandFirst, planCheck, planSelfCheck) per company; with the mapping the other scenarios compare the same.",
    owner: "S0-Q2: the settings mapping in core-runtime flowOptions (owner: which Cloud setting decides Understand for Quick tasks)",
  },
  {
    scenario: "code-defaults-quick", facet: "rows",
    cause: "The same settings difference: the Understand and plan check steps leave their own artifacts (intent.json, plan-critique.md) and dispatch row, plus the limit and artifact rows of every scenario.",
    owner: "S0-Q2 (as its transitions)",
  },
  {
    scenario: "*", facet: "rows", only: LIMIT_AND_ARTIFACT_ROWS,
    cause: [
      "(1) Workspace limits (plan D3, A5 S2 held): a Slack-started Cloud task is counted on the Slack workspace counters ORG#<org>#SLACK_LIMIT#<team> (MEMBER#<slack user>, ORGANIZATION, a string set of tasks),",
      "the core on DEVELOPER_LIMIT#<person>/MEMBER with a TASK#<id> marker and ORG#<org>#DEVELOPER_LIMIT#ORGANIZATION. A core task never touches Cloud's Slack counters, so with the switch on, Slack-started core tasks",
      "and Cloud tasks of the same person are counted against two different limits. Needs the S2 move plus a decision on which counter family the core charges for a Slack-started task (A5-S0-OPEN-QUESTIONS 5).",
      "(2) NEW, not in the plan's D table: a worker artifact's record is WORKSPACE#<w>/ARTIFACT#<id> on Cloud's path and WORKSPACE#<w>/ARTIFACT#<id>#<name> on the core. Cloud readers of a core task's",
      "artifacts (task page, plan panel, evidence download) must read the core's key before the switch (readers before writers, plan 3.2).",
    ].join(" "),
    owner: "S0 follow-up lane (D3 run + limit family decision; artifact readers) before the combined switch",
  },
  {
    scenario: "plan-changes-requested", facet: "transitions",
    cause: [
      "Core bug found by the suite: with Understand off (Cloud's Quick path; the composition root maps Cloud's settings to understandFirst=false), a plan sent back with \"request changes\" is never re-planned.",
      "The decision writes PLAN/READY and a PLAN dispatch row, but core/task-flow/stage-machine.ts runDispatchRow only starts a PLAN after Understand (it requires workflow.intent.assessment ready)",
      "and resolves the row as STALE, so the task stays PLAN/READY for ever. Cloud's path re-plans (PLAN/RUNNING then PLAN_REVIEW/WAITING v2).",
    ].join(" "),
    owner: "Code upstream fix (replan after request-changes without an Understand assessment), then a vendor pin bump",
  },
  {
    scenario: "plan-changes-requested", facet: "rows",
    cause: "Same bug as its transitions (the core leaves its PLAN dispatch row and writes its PLAN_FEEDBACK#<n> note row, Cloud keeps the note on the revised plan's run), plus the limit and artifact rows of every scenario.",
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
];
