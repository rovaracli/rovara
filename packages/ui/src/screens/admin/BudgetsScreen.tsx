import { Link } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { Button } from "../../design/Button.js";
import { useAdminContext } from "./AdminLayout.js";
import { SpendingSummary, useOrgSpendRead } from "./spending/SpendingSummary.js";
export function BudgetsScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Spending" /><p role="alert">Only current company owners and admins can view company spending. No amounts are shown.</p></section>;
 return <Spending key={`${orgId}:${developerId}:${role}`} />;
}
function Spending() {
 const { checking } = useAdminContext(), read = useOrgSpendRead(), locked = checking || read.isFetching;
 return <section aria-busy={locked}>
  <PageHeader focusOnMount title="Spending" description="Spent this month, what is left, and amounts not yet confirmed." actions={<Button aria-disabled={locked} onClick={() => { if (!locked) void read.refetch(); }}>Refresh spending</Button>} />
  <SpendingSummary read={read} />
  <p>Set the company monthly limit in <Link to="/app/admin/ai-spending">AI and spending</Link>. Set project and person monthly limits on <Link to="/app/admin/money/limits">Spending limits</Link>. Each project's task limit is on its project page.</p>
 </section>;
}
