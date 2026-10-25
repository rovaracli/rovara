

// Placeholder spend caps (ruling R29), in US dollars. The model proxy enforces them as a calendar-month
// budget per member and per organisation, and as a total per task key. Real, editable budgets replace
// these once organisations can set their own.

/** What one member may spend through the model proxy in a calendar month. */
export const DEFAULT_MEMBER_MONTHLY_BUDGET_USD = 29;

/** What one organisation may spend through the model proxy in a calendar month. */
export const DEFAULT_ORG_MONTHLY_BUDGET_USD = 500;
