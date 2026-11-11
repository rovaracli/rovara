// UX3: the front page of company settings. It lists every settings page once, in the groups the navigation uses, with a line on what is there.
import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { useAppHost } from "../../host.js";
import { PageHeader } from "../../design/PageHeader.js";
import { useAdminContext } from "./AdminLayout.js";
import { useNav } from "../../api/nav.js";
import { visibleSections } from "./admin-sections.js";
import { SettingsNote } from "./SettingsNote.js";
import { isHealthV2On } from "./health/health-flags.js";
// Switch rovara.health = "v2" (off by default): "What needs an admin" and the health counts sit above the settings map.
const NeedsAdmin = lazy(async () => ({ default: (await import("./health/NeedsAdmin.js")).NeedsAdmin }));
export function AdminOverview() {
 const { company, role, approvalWindowOff } = useAdminContext(), host = useAppHost(), health = isHealthV2On(host), nav = useNav();
 return <section><PageHeader focusOnMount title="Company settings" description={`Everything about how ${company} uses Rovara, in one place: people, connections, money, rules and security.`} /><SettingsNote area="overview" />{health && <Suspense fallback={null}><NeedsAdmin /></Suspense>}{visibleSections(role, false, false, nav.data?.features.companyRules === true, approvalWindowOff).map(section => <section key={section.id} className="rv-admin-section" aria-labelledby={`overview-${section.id}`}><h2 id={`overview-${section.id}`}>{section.title}</h2><ul className="rv-admin-overview-list">{section.items.map(item => <li key={item.to}><h3>{item.label}</h3><p>{item.blurb}</p><Link to={item.to}>{item.action}</Link></li>)}</ul></section>)}</section>;
}
