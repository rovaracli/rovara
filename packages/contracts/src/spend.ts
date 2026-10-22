// Budget and approval placeholder constants for agents. Other tasks read these before the budget engine that
// owns them exists, so they live here from the start; the budget tasks add keys, types and functions beside them.
import { z } from "zod";
import { ModelSourceIdSchema, type AgentId } from "./agent.js";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD } from "./org-budget.js";

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

// ---- budget scopes (Task 28)

/**
 * What a limit applies to: the whole org, one member, one project, one agent, or one member's test runs of draft agents. The visibility
 * counter `AGENT_USAGE#<agentId>` has no limit and is not a scope. Plan 4 adds `chain`.
 */
export type BudgetScope =
  | { kind: "org" }
  | { kind: "member"; developerId: string }
  | { kind: "project"; project: string }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "testing"; developerId: string };

/** The name a scope has in a map of limits and in a top-up item's sort key. */
export function scopeKey(scope: BudgetScope): string {
  switch (scope.kind) {
    case "org": return "ORG";
    case "member": return `MEMBER#${scope.developerId}`;
    case "project": return `PROJECT#${scope.project}`;
    case "agent": return `AGENT#${scope.agentId}`;
    case "testing": return `TESTING#${scope.developerId}`;
  }
}

// ---- the ledger and settlement (Task 30)

/** How long after an operation ends its model keys are blocked before they are finalized, so a request the proxy admitted before the block still counts (spike Q11). */
export const FINALIZE_DELAY_MS = 120_000;
/** A key nobody blocked is finalized this long after it expires. */
export const KEY_EXPIRY_GRACE_MS = 600_000;
/** A finalized key keeps settling this long, for a request that outlived the block. */
export const FINALIZED_SETTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The share of a budget at which each alert is written (`budgetAlertKey` level). */
export const BUDGET_ALERT_LEVELS = [
  { level: "80", ratio: BUDGET_WARNING_RATIO },
  { level: "100", ratio: 1 },
] as const;

/** The counters beside the scopes' own: what a model source, a model and a ChatGPT plan used, and an agent's spend by where the run came from. None has a limit. */
export const sourceCounter = (sourceId: string): string => `SOURCE#${sourceId}`;
export const modelCounter = (model: string): string => `MODEL#${model}`;
export const personalCounter = (developerId: string): string => `PERSONAL#${developerId}`;

/**
 * How an agent's spend view splits its runs. The split is by where the run came from, not by who pays: a test run is `test`; an event, a schedule or a
 * chain is `autonomous` (a member-paid chain still reads as autonomous, since no person started that run); every other origin is `person` (so a Linear
 * run a bot assigned and the project pays for is `person`: someone's request started it). Who pays is the ledger line's `payerKind`.
 */
export type SpendOriginKind = "person" | "autonomous" | "test";
export const SPEND_ORIGIN_KINDS: readonly SpendOriginKind[] = ["person", "autonomous", "test"];
export const originCounter = (agentId: string, kind: SpendOriginKind): string => `AGENT_ORIGIN#${agentId}#${kind}`;
export function spendOriginKind(origin: string): SpendOriginKind {
  if (origin === "test_run") return "test";
  return origin === "event" || origin === "schedule" || origin === "chain" ? "autonomous" : "person";
}

// ---- project AI settings and the org's spend policy (Task 28)

export const PLANNING_LIMIT_MIN_USD = 0.5;
export const PLANNING_LIMIT_MAX_USD = 50;
/** The largest monthly amount a setting may carry; the model proxy's protocol refuses more. */
export const MAX_SPEND_SETTING_USD = 1_000_000;

const Amount = z.number().finite().min(0).max(MAX_SPEND_SETTING_USD);
const PlanningLimit = z.number().finite().min(PLANNING_LIMIT_MIN_USD).max(PLANNING_LIMIT_MAX_USD);

/** A project's AI settings: its own monthly budget, whether it pays for its tasks, the model sources it prefers and its planning limits. */
export const ProjectAiSettingsSchema = z.object({
  monthlyBudgetUsd: Amount.optional(),
  projectPays: z.boolean(),
  /** Absent: the project follows the org's order. */
  sourceOrder: z.array(ModelSourceIdSchema).max(20).superRefine((order, context) => {
    if (new Set(order).size !== order.length) context.addIssue({ code: "custom", message: "must not repeat a source" });
  }).optional(),
  planningLimitUsd: z.object({ QUICK: PlanningLimit.optional(), FULL: PlanningLimit.optional() }).strict().optional(),
}).strict();
export type ProjectAiSettings = z.infer<typeof ProjectAiSettingsSchema>;

/** A project that has never set any of its AI settings. */
export const defaultProjectAiSettings = (): ProjectAiSettings => ({ projectPays: false });

/** The org's rules for who approves spend and how much a person or test may use. */
export const SpendPolicyFieldsSchema = z.object({
  leadApprovalThresholdUsd: Amount,
  adminApprovalThresholdUsd: Amount,
  runLimitMultiplier: z.number().finite().min(1).max(5),
  testingAllowanceUsd: Amount,
  perTestCapUsd: Amount,
  /** The most one person's agent budgets may total in a month, counted across every agent they own. */
  ownerAgentBudgetCapUsd: Amount.min(1),
}).strict();
export const SpendPolicySchema = SpendPolicyFieldsSchema.superRefine((policy, context) => {
  if (policy.leadApprovalThresholdUsd > policy.adminApprovalThresholdUsd) {
    context.addIssue({ code: "custom", path: ["leadApprovalThresholdUsd"], message: "must not be more than adminApprovalThresholdUsd" });
  }
});
export type SpendPolicy = z.infer<typeof SpendPolicySchema>;

export const defaultSpendPolicy = (): SpendPolicy => ({
  leadApprovalThresholdUsd: LEAD_APPROVAL_THRESHOLD_USD,
  adminApprovalThresholdUsd: ADMIN_APPROVAL_THRESHOLD_USD,
  runLimitMultiplier: RUN_LIMIT_MULTIPLIER,
  testingAllowanceUsd: TESTING_ALLOWANCE_USD,
  perTestCapUsd: PER_TEST_CAP_USD,
  ownerAgentBudgetCapUsd: DEFAULT_OWNER_AGENT_BUDGET_CAP_USD,
});

/**
 * R49: a trial org stays within the placeholder limits until billing exists. The proxy already holds the org and member figures; these are
 * the most the settings of this task may name on a trial org, in US dollars a month. A project may use up to the whole org's limit, and an
 * agent, and one person's total of agent budgets, up to a member's.
 */
export const TRIAL_LIMITS_R49 = {
  projectMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD,
  agentMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD,
  ownerAgentBudgetCapUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD,
} as const;
