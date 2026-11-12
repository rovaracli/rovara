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

const SESSIONS_CAUSE = [
  "Cloud gap (R-SESSIONS): a Slack-started workflow task has no agent session on Cloud's path, so a person's message to it is refused 404 \"session not found\", even after",
  "the task page is read; the core accepts it (it gives every task a session at start, in the start's own transaction). Cloud makes a session at start only for an agent",
  "run (`prepared` in packages/broker/src/aws/developer-tasks/start.ts) and lazily only for a task that has `agent` and `origin`",
  "(packages/broker/src/agent-sessions/create.ts:296, `lazyTaskSessionInput`); a Slack workflow task has neither. With the combined switch on, core tasks could be",
  "messaged and Cloud tasks could not, so who can steer a task would depend on its engine. Proposed fix (Cloud): give workflow tasks their session as the core does, either",
  "by writing `agent` and `origin` on a workflow task at start (aws/developer-tasks/workflow-starts.ts) or by a workflow-task branch in `lazyTaskSessionInput`.",
].join(" ");

export const RESILIENCE_DIFFERENCES: readonly KnownDifference[] = [
  { scenario: "session-message-mid-run", facet: "features", cause: SESSIONS_CAUSE, owner: "Cloud fix before the combined switch (sessions for workflow tasks), or the owner accepts it until DEL" },
  {
    scenario: "session-message-mid-run", facet: "rows",
    // No `only` list yet: the core's NOTE row carries a random message id (`msg_...`) that harness/normalize.ts does not mask; once it does (asked of its owner),
    // this entry gets `only: [MESSAGE_BUCKET, NOTE#<msg>, RECIPE, BUILTIN_AGENTS rows]` plus the limit and artifact rows.
    cause: "Expected values: core DEVTASK#<id> | MESSAGE_BUCKET and DEVTASK#<id> | NOTE#msg_<id>; Cloud DEVTASK#<id> | RECIPE and ORG#<org>#BUILTIN_AGENTS | rovara-code; plus the limit and artifact rows of every scenario. Follows from R-SESSIONS: the core keeps the accepted message (its NOTE row and the task's message bucket); Cloud refused it and keeps none. Cloud's RECIPE and BUILTIN_AGENTS rows are the agent sessions wiring the harness turns on for this step (`agentSessions`), Cloud's own catalogue, not a task record.",
    owner: "As its features",
  },
  { scenario: "worker-lost", facet: "transitions", cause: LOST_RUN_CAUSE, owner: "Code upstream: lost-run watchdog in the core's recovery sweep (then a vendor pin bump); S0 schedules it" },
  {
    scenario: "worker-lost", facet: "rows",
    cause: "Same gap: Cloud's reconciler writes its `operation_end` dispatch row (WORKFLOW_DISPATCH/<task>#end) and resolves the step's row; the core leaves the IMPLEMENT row it never resolves. Plus the limit and artifact rows of every scenario.",
    owner: "As its transitions",
  },
];
