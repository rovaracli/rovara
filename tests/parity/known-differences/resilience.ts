// Known differences found by the resilience lane's drivers (decision timeouts, notifications, races, lost workers, session messages, review send-backs).
// Same rules as known-differences.ts.
import type { KnownDifference } from "../known-differences.js";

const LOST_RUN_CAUSE = [
  "Core gap found by the suite (stated in Code's own docs, vendor/rovara-code/docs/ports.md:696-697: \"no watchdog ends a step whose worker died ... a running step is not\").",
  "When the coding run's machine is lost, Cloud's session reconciler (aws/session-reconciler.ts, run by the dispatch recovery schedule) ends the operation and blocks the step",
  "IMPLEMENT/BLOCKED(\"implementation operation ended failed\") with Retry; on the core the operation stays RUNNING for ever: nothing reads `WorkerMachines.health` for a held",
  "workspace after delivery (core/task-flow/dispatch.ts:170 reads it only while dispatching). Proposed fix (Code, upstream first): a recovery sweep in core/task-flow (run from",
  "`sweepOnce` and from the S0 `dispatch-sweep` job) that, for each workspace BUSY with an active operation past a grace period, asks `machines.health(machineId)` and on",
  "`terminated`/`unhealthy` ends the operation with `endOperation(deps, op, \"INTERRUPTED\", \"the worker's machine was lost\")`, which already routes to `onOperationEnded` and",
  "`causeOfEnd` (run-lost: one automatic retry for VERIFY/REVIEW, a block with retry for the rest). Blocks the combined switch (a lost EC2 worker would hang a core task).",
].join(" ");

export const RESILIENCE_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "session-message-mid-run", facet: "rows", only: ["DEVTASK#<id> | MESSAGE_BUCKET"],
    cause: "Both paths accept the person's message and keep it as the task's NOTE row (the features facet is the same: a session at start on both). The core also keeps the task's message bucket row, a counter of the accepted messages Cloud does not write. Plus the recipe rows of the `*` entry.",
    owner: "Accepted: a core-private counter, read only by the core's own message path",
  },
  { scenario: "worker-lost", facet: "transitions", cause: LOST_RUN_CAUSE, owner: "Code upstream: lost-run watchdog in the core's recovery sweep (then a vendor pin bump); S0 schedules it" },
  {
    scenario: "worker-lost", facet: "rows",
    cause: "Same gap: Cloud's reconciler writes its `operation_end` dispatch row (WORKFLOW_DISPATCH/<task>#end) and resolves the step's row; the core leaves the IMPLEMENT row it never resolves. ",
    owner: "As its transitions",
  },
];
