import { type AgentId, type ChainId, ModelSourceIdSchema, type OrgId, RUN_LIMIT_MULTIPLIER, type RunCheckout } from "@rovara-code/contracts";
// Budget and approval placeholder constants for agents. Other tasks read these before the budget engine that
// owns them exists, so they live here from the start; the budget tasks add keys, types and functions beside them.
import { z } from "zod";
import { TaskStopProjectPolicySchema } from "./task-stop-project.js";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD } from "./org-budget.js";
/** A run limit above this needs the project's lead to approve. */
export const LEAD_APPROVAL_THRESHOLD_USD = 10;
/** A run limit above this needs an org admin to approve. */
export const ADMIN_APPROVAL_THRESHOLD_USD = 100;
/** The share of a budget at which people are warned. */
export const BUDGET_WARNING_RATIO = 0.8;

/**
 * Kept while an approved plan's coding start has not been made (the approval committed; a start that failed is retried): "approved, starting" for the task.
 * The ask-again route and the task view read it; it is removed when the start is made, given up or the task closes.
 */
export const heldPlanStartKey = (orgId: string, taskId: string): { pk: string; sk: string } => ({ pk: `HELD_SPEND_STARTS#PLAN#${orgId}`, sk: taskId });
/** The owner's last new ask for a plan's run limit (`POST /v1/app/tasks/{id}/run-limit-request`), for the cooldown between asks. */
export const runLimitAskedKey = (orgId: string, taskId: string): { pk: string; sk: string } => ({ pk: `RUN_LIMIT_ASKED#${orgId}`, sk: taskId });
/** How long after one new ask the owner may make the next. */
export const RUN_LIMIT_ASK_COOLDOWN_MS = 10 * 60_000;

/** A member's monthly allowance for test runs of draft agents, and the most one test run may spend. */
export const TESTING_ALLOWANCE_USD = 10;
export const PER_TEST_CAP_USD = 2;

export const DEFAULT_MAX_AGENT_MONTHLY_USD = 50;
// Canonical exact default; the legacy USD name is an alias, not another setting.
export const DEFAULT_MAX_PER_RUN_CEILING_MICROUSD = 100_000_000;
export const DEFAULT_MAX_PER_RUN_CEILING_USD = DEFAULT_MAX_PER_RUN_CEILING_MICROUSD / 1_000_000;
export const DEFAULT_OWNER_AGENT_BUDGET_CAP_USD = 100;

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
 * What a limit applies to: the whole org, one member, one project, one agent, one chain, or one member's test runs of draft agents. The visibility
 * counter `AGENT_USAGE#<agentId>` has no limit and is not a scope. A chain's steps count against the chain and not against the agent that runs them.
 */
export type BudgetScope =
  | { kind: "org" }
  | { kind: "member"; developerId: string }
  | { kind: "project"; project: string }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "chain"; chainId: ChainId }
  | { kind: "testing"; developerId: string };

/** The name a scope has in a map of limits and in a top-up item's sort key. */
export function scopeKey(scope: BudgetScope): string {
  switch (scope.kind) {
    case "org": return "ORG";
    case "member": return `MEMBER#${scope.developerId}`;
    case "project": return `PROJECT#${scope.project}`;
    case "agent": return `AGENT#${scope.agentId}`;
    case "chain": return `CHAIN#${scope.chainId}`;
    case "testing": return `TESTING#${scope.developerId}`;
  }
}

/**
 * What a paused run is waiting on (Task 31): a budget scope that is full, or one of the run's own limits (the task's run limit, the agent's max per run,
 * a test run's cap, the planning limit). Task 32's requests are keyed by `pauseKey`, so a second pause on the same scope asks for nothing new.
 */
export type PauseScope =
  | BudgetScope
  | { kind: "task"; taskId: string }
  | { kind: "max_per_run"; taskId: string }
  | { kind: "test"; taskId: string }
  | { kind: "planning"; taskId: string };

/** The name a pause scope has in a request's key: a budget scope's `scopeKey`, or the run's limit and the task it belongs to. */
export function pauseKey(scope: PauseScope): string {
  switch (scope.kind) {
    case "task": return `TASK#${scope.taskId}`;
    case "max_per_run": return `MAX_PER_RUN#${scope.taskId}`;
    case "test": return `TEST#${scope.taskId}`;
    case "planning": return `PLANNING#${scope.taskId}`;
    default: return scopeKey(scope);
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
 * chain is `autonomous` (a member-paid chain still reads as autonomous, since no person started that run), and so is the company's own lesson learning (`learning`: no person
 * started that call, and it must not read as a person's spend); every other origin is `person` (so a Linear
 * run a bot assigned and the project pays for is `person`: someone's request started it). Who pays is the ledger line's `payerKind`.
 */
export type SpendOriginKind = "person" | "autonomous" | "test";
export const SPEND_ORIGIN_KINDS: readonly SpendOriginKind[] = ["person", "autonomous", "test"];
export const originCounter = (agentId: string, kind: SpendOriginKind): string => `AGENT_ORIGIN#${agentId}#${kind}`;
export function spendOriginKind(origin: string): SpendOriginKind {
  if (origin === "test_run") return "test";
  return origin === "event" || origin === "schedule" || origin === "chain" || origin === "learning" ? "autonomous" : "person";
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
  /** Preserved by ordinary settings changes; only a separately reviewed writer may change it. */
  taskStopPolicy: TaskStopProjectPolicySchema.optional(),
  monthlyBudgetUsd: Amount.optional(),
  projectPays: z.boolean(),
  /** Absent: the project follows the org's order. */
  sourceOrder: z.array(ModelSourceIdSchema).max(20).superRefine((order, context) => {
    if (new Set(order).size !== order.length) context.addIssue({ code: "custom", message: "must not repeat a source" });
  }).optional(),
  planningLimitUsd: z.object({ QUICK: PlanningLimit.optional(), FULL: PlanningLimit.optional() }).strict().optional(),
  /**
   * Owner decision 3 (option E): when the project pays, the most a run limit may be for the member who approves the plan to accept it themselves. Above it a
   * `run_limit` request goes to the project's maintainers. Absent: the org's lead threshold. Never more than the org's admin threshold (saving more is refused, and an older
   * setting is held to it when applied: `memberAcceptRunLimitUsd`). A project maintainer, an org owner or an admin sets it.
   */
  memberAcceptRunLimitUpToUsd: z.number().finite().min(0).max(1000).optional(),
}).strict();
/** The lead threshold's own default. A project that set nothing no longer uses this: it follows the org's lead threshold (`memberAcceptRunLimitUsd`). */
export const DEFAULT_MEMBER_ACCEPT_RUN_LIMIT_USD = 10;
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

/**
 * What a member may accept as a run limit when the project pays (owner decision 3, option E, with the fix wave re-check's N-1 ruling): the project's setting, or
 * when it set none the org's lead threshold (so a project follows an org that changed it); and never more than the org's admin threshold, which is what a project
 * maintainer may accept. Read where it is applied, so a threshold lowered after the setting was saved holds at once.
 */
export const memberAcceptRunLimitUsd = (settings: { memberAcceptRunLimitUpToUsd?: number | undefined }, policy: Pick<SpendPolicy, "leadApprovalThresholdUsd" | "adminApprovalThresholdUsd">): number =>
  Math.min(settings.memberAcceptRunLimitUpToUsd ?? Math.min(policy.leadApprovalThresholdUsd, policy.adminApprovalThresholdUsd), policy.adminApprovalThresholdUsd);

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

// ---- spend requests (Task 32)

/** What a request asks for: a run's limit, an agent's max per run for one run, the planning limit, a month's budget (Task 33), or an owner's cap. */
export const SPEND_REQUEST_KINDS = ["run_limit", "max_per_run", "planning", "month", "owner_cap"] as const;
export type SpendRequestKind = (typeof SPEND_REQUEST_KINDS)[number];
export const SPEND_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "EXPIRED"] as const;
export type SpendRequestStatus = (typeof SPEND_REQUEST_STATUSES)[number];
/** Who a request was routed to: the payer, the project's maintainers, the agent's owner, the chain's owner (Plan 4), or the org's owners and admins. */
export const SPEND_APPROVER_ROLES = ["payer", "project_maintainer", "agent_owner", "chain_owner", "org_admin"] as const;
export type SpendApproverRole = (typeof SPEND_APPROVER_ROLES)[number];
/** The longest reason a request carries, in code points. */
export const SPEND_REQUEST_REASON_MAX = 300;
/** What a task with no workflow is told when its budget was raised (the system's Continue). */
export const SPEND_RESUME_INSTRUCTIONS = "Your AI budget was raised. Continue where you stopped.";

/**
 * The change an `owner_cap` request holds until an admin decides: nothing changes while it is PENDING, and approving applies exactly this, as an override of the
 * cap. `confirm_move` is Rovara's own move (a member merged, removed or no longer a project maintainer), which already applied: approving it only records that an admin saw it.
 */
export type OwnerCapChange =
  | { op: "set_budget"; budget: { monthlyUsd?: number | null; maxPerRunUsd?: number | null }; /** Server-captured per-run value; null is confirmed absence. */ expectedMaxPerRunUsd?: number | null }
  | { op: "set_owner"; owner: { kind: "member"; developerId: string } | { kind: "project"; project: string }; accountable?: { developerId: string } }
  | { op: "set_accountable"; accountable: { developerId: string } }
  | { op: "unarchive" }
  | { op: "confirm_move"; owner: string; cause: "member_merged" | "member_removed" | "project_role_changed" };

/** A request for more spend, at `spendRequestKey(orgId, spendRequestId)`; the open ones are listed at `openSpendRequestsKey`. */
export interface SpendRequestRecord {
  orgId: OrgId;
  spendRequestId: string;
  kind: SpendRequestKind;
  /** What the request raises: a run's own limit (`task`, `max_per_run`, `planning`), or the agent whose owner's cap it is. */
  scope?: PauseScope;
  taskId?: string;
  /** For an owner change held by the cap: the person who would own the agent. */
  newOwner?: { developerId: string };
  /** How much more is asked for (for `owner_cap`: the dollars over the cap). */
  amountUsd: number;
  /** The limit the request would set: a run's new limit, the raised stop, or the agent's requested monthly budget. */
  newLimitUsd?: number;
  /** What the person deciding is told, at most `SPEND_REQUEST_REASON_MAX` code points. */
  reason: string;
  requestedBy: { kind: "member"; developerId: string } | { kind: "system" };
  /** A task's request: the person whose run it is (the run's starter). They may not decide it unless they are the payer member (`max_per_run`: never, unless they are the org's only owner or admin). */
  requestedFor?: { developerId: string };
  approverRole: SpendApproverRole;
  /** Who it was routed to when it was made (and moved since); who may decide is read live (`spendApprovers`), never from this list. */
  approverIds: string[];
  /** Set when an owner did not answer within `OWNER_ANSWER_HOURS` and the org's owners and admins were added. */
  escalatedAt?: string;
  status: SpendRequestStatus;
  decidedBy?: string;
  decidedAt?: string;
  approvedAmountUsd?: number;
  /** How the task goes on once approved: a task's Continue, the implementation after a plan, or the plan itself. */
  resume?: "continue" | "implement" | "plan";
  /** The change an `owner_cap` request applies once approved. */
  change?: OwnerCapChange;
  /** Original task approval terms. Owner-budget requests use their own source proof. */
  approvalTerms?: {
    version: 1; sourcePresence: true; sourceKey: { pk: string; sk: string }; sourceRevision: string | null; sourceDigest: string;
    firstDispatch: { operationId: string; checkout?: RunCheckout[] | undefined; readOnly?: true | undefined } | null;
    originalFields: Record<string, unknown>; askedFiguresMicrousd: { budget: number; runLimit: number; amount: number; maxPerRun: number | null; baseline: number }; proposedFiguresMicrousd: { budget: number; runLimit: number; maxPerRun: number | null; window: "keep" | "reset" };
    countedOwner: string | null; totalsRevision: null; policyDigest: string; admissionId: string; operation: "run_limit" | "max_per_run" | "planning";
  };
  /** Original counted owner figures for a newly captured owner-cap request. */
  ownerFinancialTerms?: { version: 1; basis?: "base" | "effective"; owner: string; month: string; totalUsd: number; counterUsd: number; counterVersion: number; capUsd: number; policyRevision: number; carriedUsd: number; wouldBeUsd: number; carriedSource?: { key: { pk: string; sk: string }; exists: boolean; fields: Record<string, unknown> } };
  /** Original native money-source state; absence is meaningful. */
  approvalSource?: { version: 1; key: { pk: string; sk: string }; exists: boolean; fields: Record<string, unknown> };
  /** The agent an `owner_cap` request is about. */
  agentId?: AgentId;
  /** The chain an `owner_cap` request is about (Plan 4): the person's agent and chain budgets are one total. */
  chainId?: ChainId;
  /** For `owner_cap`: the person whose total the change was summed against (the figures in `reason`). It applies only while the change still counts for them. */
  forOwner?: string;
  createdAt: string;
  expiresAt: string;
  /** When the settlement run next looks at it (`openSpendRequestDueKey`): an unanswered owner's escalation, else its expiry. */
  dueAt?: string;
  /** Why an EXPIRED request ended before its time: the task went on without it, the task closed, the person its change names left, the agent came to count for another owner than the one the change was summed for, or everyone who could decide it left. */
  endedBecause?: "continued" | "task_closed" | "target_left" | "owner_moved" | "approver_left" | "figures_changed" | "spending_rules_changed";
}

/** What a paused run asks for by default: half its limit again, rounded up to whole dollars, and never less than $5. */
export function suggestedTopUpUsd(limitUsd: number): number {
  return Math.max(5, Math.ceil(limitUsd * 0.5));
}

// ---- monthly requests (Task 33)

/** What a month's request asks for by default: a fifth of the scope's limit, rounded up to whole dollars, and never less than $10. */
export function suggestedMonthTopUpUsd(limitUsd: number): number {
  return Math.max(10, Math.ceil(limitUsd * 0.2));
}
