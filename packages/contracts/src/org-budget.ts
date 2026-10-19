// Placeholder spend caps (ruling R29), in US dollars. The model proxy enforces them as a calendar-month
// budget per member and per organisation, and as a total per task key. Real, editable budgets replace
// these once organisations can set their own.

/** What one member may spend through the model proxy in a calendar month. */
export const DEFAULT_MEMBER_MONTHLY_BUDGET_USD = 29;

/** What one organisation may spend through the model proxy in a calendar month. */
export const DEFAULT_ORG_MONTHLY_BUDGET_USD = 500;

/** What one task's key may spend, when the task record carries no budget of its own. */
export const PER_TASK_BUDGET_USD = 25;
/** How the refusal that a task has spent its own cap begins (ruling R35); the worker tells the task scope from the member's by it. */
export const TASK_BUDGET_EXCEEDED_PREFIX = "This task has used its AI budget";
