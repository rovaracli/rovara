import { Link } from "react-router";
import { VisibleText } from "../../../design/VisibleText.js";
import { ConnectGithubStep } from "../steps/ConnectGithubStep.js";

/**
 * Company-level steps stay thin: an admin does them once, so here they are a status and a link, not a flow of their own. The GitHub connection shows its state from the installations the page already read; when
 * there is none, the existing connect panel is shown (never a second copy of it). The model source has no read of its own here, so it is a link to where it is set.
 */
export function CompanyStatus({ installations, githubRequested, refresh, canAdmin }: { installations: ReadonlyArray<{ accountLogin: string }>; githubRequested: boolean; refresh: () => void; canAdmin: boolean }) {
 const connected = installations.length > 0;
 return <section className="rv-psv2-company" aria-label="Company setup">
  <h2>Company setup</h2>
  <p className="rv-muted">An admin does these once for the whole company. Everything else is set up per project, here.</p>
  <ul>
   <li><strong>GitHub</strong>: {connected ? <>connected as <VisibleText text={installations.map(item => item.accountLogin).join(", ")} />.</> : "not connected yet."}{canAdmin && <> <Link to="/app/admin/connections">Manage connections</Link></>}</li>
   <li><strong>Model source</strong>: set by an admin once, with your own provider key or a trial allowance.{canAdmin && <> <Link to="/app/admin/models">Open Models</Link></>}</li>
  </ul>
  {!connected && <ConnectGithubStep requested={githubRequested} refresh={refresh} />}
 </section>;
}
