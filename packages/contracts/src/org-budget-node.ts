

/** What one task's key may spend, when the task record carries no budget of its own. */
export const PER_TASK_BUDGET_USD = 25;

/** How the refusal that a task has spent its own cap begins (ruling R35); the worker tells the task scope from the member's by it. */
export const TASK_BUDGET_EXCEEDED_PREFIX = "This task has used its AI budget";

export { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD } from "./org-budget.js";
