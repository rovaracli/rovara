// The canary's fixed numbers. Every file of the gate pack is hashed into the policy pin (P-EDIT), so changing one needs a re-pin after a review.

/** Owner decision DEC 254zzz441: at most 16 canaries per rolling 24 h, counted across the Code and Cloud pipelines together. */
export const CANARY_CAP = 16;
export const WINDOW_MS = 24 * 60 * 60_000;
/** The listing starts a little before the window, so the S3 listing stays short; the filter by last-modified is exact. */
export const LIST_SLACK_MS = 60 * 60_000;
/** The canary lane's own hard cap per run (DEC 410): a report that says it cost more is a FAIL. */
export const COST_CAP_USD = 1.0;
export const POLL_INTERVAL_MS = 20_000;
export const DEADLINE_MS = 42 * 60_000;
/** The lane's one-at-a-time lock or an open install marker: wait this long, this many times, then give up as INCONCLUSIVE. */
export const BUSY_RETRIES = 6;
export const BUSY_WAIT_MS = 60_000;
/** Consecutive unreadable or failed lane calls before the canary gives up as INCONCLUSIVE. */
export const MAX_BAD_CALLS = 3;

export const LEDGER_PREFIX = "canary-ledger/";
/** Rollback canaries are exempt from the cap (P-RB: at most one per HOLD): they are recorded here and never counted. */
export const ROLLBACK_LEDGER_NAME_PREFIX = "rollback-";

export const KINDS = ["code", "cloud"] as const;
export type Kind = (typeof KINDS)[number];

export const OUTCOMES = ["PASS", "FAIL", "INCONCLUSIVE", "SKIPPED-CAP"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Lane steps whose failure is a fault of the lane or its setup rather than of the release (S0 preconditions, S12 the worker-free read): INCONCLUSIVE, never a rollback. */
export const LANE_SETUP_STEPS: readonly string[] = ["S0", "S12"];
/** Steps whose failure the release could cause. */
export const RELEASE_STEPS: readonly string[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S13"];
/** Lane `outcome` values that are not proof either way (the report says so itself). */
export const INCONCLUSIVE_LANE_OUTCOMES: readonly string[] = ["budget-refused", "provider-outage", "canary-no-answer", "spend-cap", "not-configured", "lock-busy", "install-open"];
/** Lane `outcome` values that mean a product fault with a failing step. Anything else with result FAIL is not trusted as one. */
export const FAULT_LANE_OUTCOMES: readonly string[] = ["step-failed", "budget-near-cap", "over-cap"];
