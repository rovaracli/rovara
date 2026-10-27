import { Link } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { useAdminContext } from "./AdminLayout.js";
export function AdminOverview() {
 const { company } = useAdminContext();
 return <section><PageHeader focusOnMount title="Administration" description={`Review company access and monthly base budget settings for ${company}.`} /><section className="rv-admin-section"><h2>People and access</h2><p>See company members and understand their roles before making access decisions.</p><Link to="/app/admin/people">Review company members</Link></section><section className="rv-admin-section"><h2>Invites</h2><p>Check masked pending invites. Older invite links may still exist outside this directory.</p><Link to="/app/admin/invites">Review pending invites</Link></section><section className="rv-admin-section"><h2>Spending</h2><p>Read company and default-member monthly base budgets, with explicit coverage.</p><Link to="/app/admin/money/budgets">Review monthly base budgets</Link></section></section>;
}
