import { useEffect, useMemo, useState } from "react";
import { SettingsNote } from "../SettingsNote.js";
import { Link, useParams } from "react-router";
import type { OrgServiceStatus } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { createServiceStatusApi } from "../../../api/service-status.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { useAdminContext } from "../AdminLayout.js";
type Kind = "web" | "api";
const name = (kind: Kind) => kind === "web" ? "browser runtime" : "API runtime";
const reason: Record<OrgServiceStatus["checks"][number]["reason"], string> = {
 qualified: "Stored qualification is outside the doctor's expiry warning window.", expiring: "Stored qualification expires soon. Contact your Rovara operator.", expired: "Stored qualification has expired. Contact your Rovara operator.", not_ready: "Stored runtime state does not permit browser or API checks.", not_observed: "No stored qualification was observed for this runtime.", invalid_evidence: "Stored qualification evidence could not be validated.", not_configured: "Stored qualification is not configured in this deployment.", unavailable: "Stored qualification could not be read.",
};
const observation = { qualified: "Qualification recorded", warning: "Warning", expired: "Expired", unknown: "Not observed" };
function stamp(value: string) { return <time dateTime={value}>{new Date(value).toLocaleString()}</time>; }
export function ServiceStatusContent({ orgId, kind, enabled }: { orgId: string; kind?: Kind; enabled: boolean }) {
 const host = useAppHost(), api = useMemo(() => createServiceStatusApi(host, orgId), [host, orgId]);
 const [revision, setRevision] = useState(0), [result, setResult] = useState<{ orgId: string; revision: number; data?: OrgServiceStatus; failed?: true }>();
 useEffect(() => {
  let alive = true;api.setScopeActive(enabled);
  if (enabled) void api.read().then(data => { if (alive) setResult({ orgId, revision, data }); }).catch(() => { if (alive) setResult({ orgId, revision, failed: true }); });
  return () => { alive = false;api.setScopeActive(false); };
 }, [api, enabled, orgId, revision]);
 const current = enabled && result?.orgId === orgId && result.revision === revision ? result : undefined, pending = enabled && current === undefined;
 const data = current?.data, row = kind === undefined ? undefined : data?.checks.find(check => check.kind === kind);
 return <section aria-label="Rovara service status"><PageHeader focusOnMount title={kind ? `Rovara service status: ${name(kind)}` : "Rovara service status"} actions={<button type="button" className="rv-button rv-button-secondary" aria-disabled={!enabled || pending} onClick={() => { if (enabled && !pending) setRevision(value => value + 1); }}>Refresh stored status</button>} /><SettingsNote area="health" />
  <p>These deployment-wide runtime facts are shared with every company's admins. This is stored qualification evidence, not a live availability check or proof that this project can run checks. No probe or renewal runs here.</p>
  <Link to={kind ? "/app/admin/health" : "/app/admin"}>{kind ? "Back to service status" : "Back to Administration"}</Link>
  {!enabled && <p role="alert">Service status is unavailable while company access is being checked.</p>}
  {current?.failed && <p role="alert">Stored service status could not be verified. Refresh to try another read.</p>}
  {data && kind === undefined && <><ul>{data.checks.map(check => <li key={check.kind}><Link to={`/app/admin/health/runtime/${check.kind}`}>{name(check.kind)}</Link>: {check.state} · {observation[check.observation]}</li>)}{data.teamRecord && <li>Team record deletes: {data.teamRecord.status} · {data.teamRecord.detail}</li>}</ul><h2>Not observed here</h2><p>Other doctor checks have no stored report here: Slack, GitHub, connectors, models, alarms, capacity, sign-in and ChatGPT reachability. Their configuration does not prove a successful check.</p></>}
  {row && data && <><table><caption>Stored {name(row.kind)} qualification</caption><tbody>
   <tr><th scope="row">Recorded state</th><td>{row.state}</td></tr>
   <tr><th scope="row">Qualification observation</th><td>{observation[row.observation]}</td></tr>
   <tr><th scope="row">Stored state read at</th><td>{stamp(data.checkedAt)}</td></tr>
   <tr><th scope="row">Qualification expires at</th><td>{row.expiresAt === undefined ? "Not observed" : stamp(row.expiresAt)}</td></tr>
  </tbody></table><p>{reason[row.reason]}</p><p>The read time records when stored evidence was fetched; it does not record a new runtime test.</p></>}
  <p role="status" aria-live="polite">{pending ? "Reading stored service status." : data ? "Stored status refreshed. No active check was run." : "No current service status is displayed."}</p>
 </section>;
}
export function ServiceStatusScreen() {
 const { orgId, checking } = useAdminContext(), { kind } = useParams();
 if (kind !== undefined && kind !== "web" && kind !== "api") return <section><PageHeader focusOnMount title="Service status not found" /><Link to="/app/admin/health">Back to service status</Link></section>;
 return <ServiceStatusContent key={orgId} orgId={orgId} {...(kind === undefined ? {} : { kind })} enabled={!checking} />;
}
