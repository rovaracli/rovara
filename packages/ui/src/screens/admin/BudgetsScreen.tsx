import { useAdminContext } from "./AdminLayout.js";
import { SpendingV2 } from "./SpendingV2.js";
/**
 * Settings > Spending (`/app/admin/money/budgets`): the Spending page (lane exp/spending; the only spending view since decision 125, which deleted the older monthly-base table). The broker decides what each person
 * is shown; the page shows what comes back. Keyed by the company, the person and their role, so nothing read for one is shown to another.
 */
export function BudgetsScreen() {
 const { orgId, developerId, role } = useAdminContext();
 return <div key={`${orgId}:${developerId}:${role}`}><SpendingV2 /></div>;
}
