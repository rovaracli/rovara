import "./health.css";
import { Link } from "react-router";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useReadinessReads } from "../../../api/readiness.js";
import { useAdminContext } from "../AdminLayout.js";
import { SettingsNote } from "../SettingsNote.js";
import { buildReadiness, sortRows, stamp, type ReadinessRow } from "./readiness.js";
import { StatusChip } from "./StatusChip.js";
/**
 * Settings > Health with the switch on: one row for each thing that must work, each Healthy, Action needed or Unknown from a real read, with where the answer came from, when it
 * was checked, and the one thing to do. Unknown is an honest answer: nothing here is green without an observation. Raw facts sit under Details.
 */
export function HealthV2() {
 const { orgId, developerId, role } = useAdminContext();
 return <Scoped key={`${orgId}:${developerId}:${role}`} />;
}
function Scoped() {
 const { orgId, developerId, role, checking } = useAdminContext();
 const reads = useReadinessReads({ orgId, developerId, role, enabled: !checking });
 const readiness = buildReadiness(reads, reads.now), rows = sortRows(readiness.rows), { counts } = readiness;
 // The page waits for every read except the observations (they can take a few seconds when the broker refreshes Slack and GitHub): the rows they back fill in last and say "Checking" meanwhile.
 const settled = !checking && !reads.busy, waiting = readiness.checking, still = `${String(waiting)} still checking`;
 return <section className="rv-health" aria-label="Health and readiness"><PageHeader focusOnMount title="Health" description="What has to work for Rovara to do its job, and what Rovara has actually seen." actions={<Button aria-disabled={reads.busy || reads.observing || checking} onClick={() => { if (!reads.busy && !reads.observing && !checking) reads.refetch(); }}>Check again</Button>} /><SettingsNote area="health" />
  <div role="group" aria-label="Summary"><dl className="rv-health-counts">
   <div><dt>Healthy</dt><dd>{counts.healthy}</dd></div><div><dt>Action needed</dt><dd>{counts.action}</dd></div><div><dt>Unknown</dt><dd>{counts.unknown}</dd></div>
  </dl>{waiting > 0 && <p className="rv-muted">{still}.</p>}</div>
  {(role === "owner" || role === "admin") && (reads.observations.state === "refused" || reads.observations.state === "missing" || reads.observations.state === "failed") && <p role="note" className="rv-muted">{reads.observations.state === "missing" ? "This install doesn't say when checks last ran, so " : "Couldn't read when each check last ran, so "}GitHub, Slack and AI model rows can't be called healthy.</p>}
  <p className="rv-muted">Healthy means Rovara saw it working. Unknown means nothing shows either way, so it is never shown as healthy. "Check again" only re-reads what Rovara already stores; it doesn't run new checks.</p>
  {checking ? <p className="rv-muted">Checking company access...</p> : <ul className="rv-health-list" aria-label="Readiness checks">{rows.map(row => <Row key={row.id} row={row} />)}</ul>}
  <p role="status" aria-live="polite">{checking ? "Checking company access." : settled ? `${String(rows.length)} checks shown. ${String(counts.healthy)} healthy, ${String(counts.action)} need action, ${String(counts.unknown)} unknown.${waiting > 0 ? ` ${still}.` : ""}` : "Reading what Rovara has stored."}</p>
  <p><Link className="rv-health-link" to="/app/admin">Back to Administration</Link></p>
 </section>;
}
function Row({ row }: { row: ReadinessRow }) {
 return <li className="rv-health-row" data-status={row.status}>
  <div className="rv-health-head"><h2 className="rv-health-title"><VisibleText text={row.title} /></h2><StatusChip status={row.status} /></div>
  <p className="rv-health-line"><VisibleText text={row.line} /></p>
  {row.note !== undefined && <p className="rv-health-line"><VisibleText text={row.note} /></p>}
  <p className="rv-health-meta"><span>Source: <VisibleText text={row.source} /></span> <span>{row.checkedAt === undefined ? <VisibleText text={row.checked} /> : <time dateTime={row.checkedAt} title={stamp(row.checkedAt)}><VisibleText text={row.checked} /></time>}</span></p>
  {row.fix !== undefined && <p className="rv-health-fix"><span><VisibleText text={row.fix.text} /></span> <Link className="rv-health-link" to={row.fix.to}>{row.fix.label}</Link></p>}
  {row.details.length > 0 && <details className="rv-health-details"><summary>Details</summary><ul>{row.details.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></details>}
 </li>;
}
