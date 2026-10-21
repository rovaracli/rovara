// Budget and approval placeholder constants for agents. Other tasks read these before the budget engine that
// owns them exists, so they live here from the start; the budget tasks add keys, types and functions beside them.

/** A run's limit is its estimate's high end times this. */
export const RUN_LIMIT_MULTIPLIER = 2;
/** A run limit above this needs the project's lead to approve. */
export const LEAD_APPROVAL_THRESHOLD_USD = 10;
/** A run limit above this needs an org admin to approve. */
export const ADMIN_APPROVAL_THRESHOLD_USD = 100;
/** The share of a budget at which people are warned. */
export const BUDGET_WARNING_RATIO = 0.8;
/** The most a single run may be limited to, whoever approves it. */
export const MAX_RUN_LIMIT_USD = 1000;

export interface RunEstimateRange {
  lowUsd: number;
  highUsd: number;
}

/** What a run is expected to cost before the org has history to estimate from. */
export const DEFAULT_RUN_ESTIMATE_USD = {
  QUICK: { lowUsd: 1, highUsd: 3 },
  FULL: { lowUsd: 4, highUsd: 10 },
  TASK: { lowUsd: 2, highUsd: 5 },
  AGENT: { lowUsd: 0.5, highUsd: 2 },
} as const satisfies Record<"QUICK" | "FULL" | "TASK" | "AGENT", RunEstimateRange>;

/** The limit on a workflow task's planning phase, before a plan is approved. */
export const DEFAULT_PLANNING_LIMIT_USD = { QUICK: 2, FULL: 6 } as const;

/** A member's monthly allowance for test runs of draft agents, and the most one test run may spend. */
export const TESTING_ALLOWANCE_USD = 10;
export const PER_TEST_CAP_USD = 2;

export const DEFAULT_MAX_AGENT_MONTHLY_USD = 50;
export const DEFAULT_MAX_PER_RUN_CEILING_USD = 100;
export const DEFAULT_OWNER_AGENT_BUDGET_CAP_USD = 100;

/** Estimates come from the last `ESTIMATE_HISTORY_SIZE` runs once there are `ESTIMATE_MIN_SAMPLES` of them. */
export const ESTIMATE_HISTORY_SIZE = 20;
export const ESTIMATE_MIN_SAMPLES = 5;

export const SPEND_REQUEST_TTL_DAYS = 7;
export const WRITE_APPROVAL_TTL_DAYS = 7;
/** How long a change that waits for a person (a less-safe publish, a company-wide share) stays open. Its own constant, so the write TTL can move alone. */
export const CHANGE_APPROVAL_TTL_DAYS = 7;
export const OWNER_ANSWER_HOURS = 24;
export const MAX_PENDING_APPROVALS_PER_STEP = 10;
/** The highest autonomy an org allows its agents until an admin raises it. */
export const DEFAULT_MAX_AUTONOMY = "prepare" as const;
export const APPROVAL_EXECUTING_RETRY_MINUTES = 5;
