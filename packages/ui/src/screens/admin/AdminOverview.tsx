import { Link } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { useAdminContext } from "./AdminLayout.js";
export function AdminOverview() {
 const { company } = useAdminContext();
 return <section><PageHeader focusOnMount title="Administration" description={`Review who belongs to ${company} and what each role allows.`} /><section className="rv-admin-section"><h2>People and access</h2><p>See company members and understand their roles before making access decisions.</p><Link to="/app/admin/people">Review company members</Link></section><section className="rv-admin-section"><h2>Invites</h2><p>Check masked pending invites. Older invite links may still exist outside this directory.</p><Link to="/app/admin/invites">Review pending invites</Link></section></section>;
}
