// Known differences found by the chains, triggers and custom agents drivers (areas 16, 17). Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

/** Chain and agent rows one runner writes and the other does not (features-d-support flows; see the `*` entry). */
const CHAIN_ROW_FAMILIES = [
  // Cloud only: per-company built-in agent records, and an event history on chains and agents (EVENT#<time>#<n>-<suffix>).
  "ORG#<org>#BUILTIN_AGENTS | code-reviewer", "ORG#<org>#BUILTIN_AGENTS | root-cause-analyst",
  "ORG#<org>#CHAIN#<chn> | EVENT#<time>#<n>-<hash>", "ORG#<org>#AGENT#<agt> | EVENT#<time>#<n>-<hash>", "ORG#<org>#AGENT#code-reviewer | EVENT#<time>#<n>-<hash>",
  // Core only: the pointer from a step's task to its run (Code's runner says it is Code-only: Cloud finds the run from its task record), and the
  // unattended door's open-run row.
  "ORG#<org>#CHAIN_STEP_TASK#task-1 | META", "ORG#<org>#CHAIN_STEP_TASK#task-2 | META", "ORG#<org>#UNATTENDED_RUN_OPEN | <id>",
];

export const FEATURES_D_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "features-d-chain-admission-refused", facet: "spend",
    cause: [
      "Where a chain step's money is admitted. Cloud admits it inside Plan 3's startAgentRun (packages/broker/src/chains/runner.ts:128, the bound starter;",
      "chains/budget.ts admitChainRun), so the run seam is called and refuses. Code admits it at the unattended door, before its starter is called",
      "(vendor core/automation/run-seam.ts:115). The outcome is the same on both: the run fails with BUDGET_EXCEEDED and no task starts (the transitions",
      "facet compares the same). Only the recorded attempt differs. This is not a bug: on the core, Cloud's admission is CloudAdmission at the door, so",
      "Cloud's spend reports stop counting a refused step as a start.",
    ].join(" "),
    owner: "Accepted design difference; spend and audit readers count a refusal, not a start, once the flow is on the core",
  },
  {
    // The chain and agent families are in the rows facet (harness/normalize.ts SHARED_FAMILIES), masked to <chn>/<agt>/<crn>; every chain
    // scenario compares rows, and these are exactly the rows one runner writes and the other does not.
    scenario: "*", facet: "rows", only: CHAIN_ROW_FAMILIES,
    cause: [
      "The chain and agent key layout is shared (CHAIN, CHAIN_RUN META/STEP/EVENT, CHAIN_RUNS, CHAIN_RUNS_P, OPEN_CHAIN_RUNS, AGENT META/DRAFT/VERSION,",
      "AGENT_DIRECTORY, AGENT_NAME are written by both). Cloud also makes each chain run an agent session (AGENT_SESSION#<crn>, LIVE_SESSIONS,",
      "MY_SESSIONS, PROJECT_SESSIONS, OPEN_AGENT_SESSIONS: the session families are not in the rows facet yet), keeps per-company built-in agent",
      "records (BUILTIN_AGENTS), and keeps an event history on chains and agents (CHAIN#/AGENT# EVENT#). The core writes a step-task pointer",
      "(CHAIN_STEP_TASK#<task>, Code-only by design: vendor core/chains/runner.ts stepTaskKey) and the unattended door's UNATTENDED_RUN_OPEN row.",
      "Readers before writers: Cloud's session list, roster and chain history pages must not depend on rows the core does not write.",
      "Otherwise Code needs those rows upstream: the chain run as a session (Code's P5 sessions), the roster.",
    ].join(" "),
    owner: "X-lane adoption of chains (wave 5, X6), once decision 45.10 un-hides them: sessions-on-chain-runs, rosters and history upstream or Cloud readers adapted",
  },
];
