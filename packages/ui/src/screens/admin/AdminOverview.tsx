// UX3: the front page of company settings. It lists every settings page once, in the groups the navigation uses, with a line on what is there.
import { Link } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { useAdminContext } from "./AdminLayout.js";
import { visibleSections } from "./admin-sections.js";
import { SettingsNote } from "./SettingsNote.js";
export function AdminOverview() {
 const { company, role } = useAdminContext();
 return <section><PageHeader focusOnMount title="Company settings" description={`Everything about how ${company} uses Rovara, in one place: people, connections, money, rules and security.`} /><SettingsNote area="overview" />{visibleSections(role, false).map(section => <section key={section.id} className="rv-admin-section" aria-labelledby={`overview-${section.id}`}><h2 id={`overview-${section.id}`}>{section.title}</h2><ul className="rv-admin-overview-list">{section.items.map(item => <li key={item.to}><h3>{item.label}</h3><p>{item.blurb}</p><Link to={item.to}>{item.action}</Link></li>)}</ul></section>)}</section>;
}
