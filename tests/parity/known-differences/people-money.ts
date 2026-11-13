// Known differences found by the spend limits, approvals, erasure, multi-project companies drivers. Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

const ADMISSION_UNOBSERVED_ON_CLOUD = [
  "Observation, not behaviour: the core's spend facet lists each Admission decision (the fake world records lane A5's CloudAdmission: admitted:task.start, admitted:machine.start); Cloud's journey harness",
  "has no model proxy (createWorkflowE2E has no modelAccess option), so Cloud's start admission (admitWork) does not run for an admitted start and leaves no word. Cloud's admitWork writes nothing when it admits.",
].join(" ");

export const PEOPLE_MONEY_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "people-money-spend-full-path", facet: "spend",
    cause: [
      "REAL GAP (money, core side + composition root): Cloud needs more room left to start a Full task than a Quick one (MINIMUM_REMAINING_USD: QUICK $0.50, FULL $2, CHAT $0.05; packages/broker/src/org/budget.ts:62, used by admitWork),",
      "so with $1.40 left Cloud refuses a Full start (ORG_BUDGET_EXCEEDED) while the core admits it and starts the machine. The core's start asks Admission only `task.start` with no path",
      "(vendor core/task-flow/start.ts:234), and the composition root admits every task.start at one $0.50 room (packages/broker/src/cloud/app/cloud-modules.ts:31).",
      "Proposed fix: Code's start names the workflow path in its admission request (e.g. subject or a `path` field), and CORE_ADMISSION_ACTIONS gives task.start a room by path from MINIMUM_REMAINING_USD; a Slack chat turn keeps CHAT.",
    ].join(" "),
    owner: "Code upstream (start.ts admission request carries the path) + S0 follow-up (cloud-modules room by path), before the combined switch",
  },
  { scenario: "multi-project-company", facet: "spend", cause: ADMISSION_UNOBSERVED_ON_CLOUD + " Both refuse the second project's start with WORKSPACE_LIMIT: a person's limit counts across projects on both sides.", owner: "Shared harness change: a modelAccess option on createWorkflowE2E, and the Cloud spend reader recording admitWork decisions" },
  { scenario: "people-money-limit-family", facet: "spend", cause: ADMISSION_UNOBSERVED_ON_CLOUD + " Both refuse the route-started task after a Slack-started one: Cloud counts the two against one limit too (the D3 row-family split does not let a second task through).", owner: "Shared harness change, as multi-project-company" },
];
