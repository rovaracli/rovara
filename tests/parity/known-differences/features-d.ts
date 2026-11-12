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
    scenario: "features-d-chain-switch-off", facet: "transitions",
    cause: [
      "Where the automation switch sits (decision 45.10). Cloud's switch is WEB_FEATURES `chains` and gates only the routes",
      "(packages/broker/src/chains/automations-gate.ts:3-8, :33). It says on purpose that the trigger engine is not behind it, so a trigger that is on keeps",
      "starting runs, and a run already started can be read and stopped. Code's switch is read at the unattended door on every start",
      "(vendor core/automation/run-seam.ts:110), so with it off every chain step is refused: the run fails NOT_AVAILABLE_HERE.",
      "Once chains run on the core, turning Cloud's switch off would also stop triggers that are on, which Cloud's path does not do.",
      "Proposed fix: the composition root binds the core's AutomationSwitch to Cloud's switch AND decides (owner) whether the off state stops runs the",
      "trigger engine starts. Cloud's comment says it must not, so the root should report the switch as on for the trigger and schedule paths while the",
      "routes stay hidden. That is a deliberate mapping, not Code's default.",
    ].join(" "),
    owner: "Owner decision 143(c): turning automations off also stops runs a trigger already started, cancelled at a safe point, nothing half-done merged. The core's refusal at the door matches it for new starts; ROOT TO-DO (S0-143c): bind the core's automation switch to Cloud's `chains` feature and cancel running runs at a safe point when it turns off (Cloud's chains/automations-gate.ts changes to match)",
  },
  {
    scenario: "features-d-chain-switch-off", facet: "spend",
    cause: "The same switch placement as its transitions: Cloud's runner starts the first step (start:root-cause-analyst); the core's door refuses before any start.",
    owner: "S0-Q2 (as its transitions)",
  },
  {
    scenario: "features-d-chain-code-defaults", facet: "transitions",
    cause: [
      "Settings, not logic. Code's project rules refuse an agent with a writing tool unless the install says it can ask a person for each change",
      "(vendor core/agents/rules.ts:41, ProjectRules.allowConnectorWrites, absent by default). The built-in Code reviewer has such a tool, so on Code's",
      "defaults a chain that uses it cannot start (CHAIN_UNAVAILABLE). Cloud serves connector writes behind a person's approval and runs it. With",
      "allowConnectorWrites: true (what Cloud's root must pass), features-d-chain-run compares the same.",
    ].join(" "),
    owner: "S0-Q2 settings mapping: cloud/app passes ProjectRules.allowConnectorWrites = true for Cloud's chains and agents",
  },
  {
    scenario: "features-d-chain-code-defaults", facet: "rows",
    cause: "The same project-rules default as its transitions: the core refuses the run before it is created, so it writes no CHAIN_RUN, CHAIN_RUNS, CHAIN_RUNS_P or OPEN_CHAIN_RUNS rows; Cloud runs the chain and writes them (plus its own BUILTIN_AGENTS and event-history rows).",
    owner: "S0-Q2 (as its transitions)",
  },
  {
    scenario: "features-d-chain-code-defaults", facet: "spend",
    cause: "The same project-rules default as its transitions: the core refuses the start (refused:CHAIN_UNAVAILABLE); Cloud starts both steps.",
    owner: "S0-Q2 (as its transitions)",
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
