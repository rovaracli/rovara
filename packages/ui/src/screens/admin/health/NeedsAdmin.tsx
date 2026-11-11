import "./health.css";
import { Link } from "react-router";
import { useReadinessReads } from "../../../api/readiness.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { ADMIN_LIST_CAP, buildNeedsAdmin, buildReadiness, HEALTH_PATH, WAITING_PATH } from "./readiness.js";
/**
 * The admin overview with the switch on: "What needs an admin" (confirmations waiting for a second admin, spending requests, company rule proposals, broken connections and failed
 * checks, each linking to where it is fixed) and the health counts. Owners and admins only; everything is read from what the app already reads elsewhere.
 */
export function NeedsAdmin() {
 const { orgId, developerId, role } = useAdminContext();
 return role === "owner" || role === "admin" ? <Scoped key={`${orgId}:${developerId}:${role}`} /> : null;
}
function Scoped() {
 const { orgId, developerId, role, checking } = useAdminContext();
 const reads = useReadinessReads({ orgId, developerId, role, enabled: !checking });
 const readiness = buildReadiness(reads, reads.now), needs = buildNeedsAdmin(reads, readiness), { counts } = readiness;
 const settled = !checking && !reads.busy && readiness.checking === 0;
 const shown = needs.items.slice(0, ADMIN_LIST_CAP), more = needs.items.length - shown.length;
 return <>
  <section className="rv-admin-section rv-health-needs" aria-labelledby="overview-needs-admin" aria-busy={!settled}>
   <h2 id="overview-needs-admin">What needs an admin</h2>
   {!settled ? <p className="rv-muted">Reading what is waiting...</p> : <>
    {shown.length === 0 ? <p>{needs.unread.length === 0 ? "Nothing needs an admin right now." : "Nothing found that needs an admin, but some things couldn't be read."}</p> : <ul className="rv-health-needs-list">{shown.map(item => <li key={item.id} className="rv-health-needs-item">
     <h3><VisibleText text={item.title} /></h3><p><VisibleText text={item.why} /></p>
     {item.when !== undefined && <p className="rv-muted"><VisibleText text={item.when} /></p>}
     {item.others === true && <p className="rv-muted">Waiting for another admin, not for you.</p>}
     <p><Link className="rv-health-link" to={item.link.to}>{item.link.label}</Link></p>
    </li>)}</ul>}
    {more > 0 && <p>{more} more. <Link className="rv-health-link" to={WAITING_PATH}>Open the waiting list</Link></p>}
    {needs.unread.length > 0 && <p role="note" className="rv-muted">Couldn't read: {needs.unread.join(", ")}. This list may be missing items.</p>}
   </>}
   <p className="rv-muted">Why: money and permission changes take effect only after a different admin confirms.</p>
  </section>
  <section className="rv-admin-section rv-health-glance" aria-labelledby="overview-health-glance">
   <h2 id="overview-health-glance">Health at a glance</h2>
   {!settled ? <p className="rv-muted">Reading health...</p> : <p>{counts.healthy} healthy · {counts.action} action needed · {counts.unknown} unknown. <Link className="rv-health-link" to={HEALTH_PATH}>All checks</Link></p>}
  </section>
 </>;
}
