import { Link } from "react-router";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
import { SessionControls } from "../session/SessionControls.js";
import type { WorkRow } from "./work-list.js";

/** One row of the Work list: the outcome, then its plain state, how long, who acts next (only where the data says) and where it runs. A live row keeps today's Approve and session controls. */
export function WorkRowItem({ row, onChanged }: { row: WorkRow; onChanged: () => Promise<unknown> }) {
 const host = useAppHost(), live = row.live;
 return <li className="rv-work-row" data-attention={row.attention ? "true" : undefined}>
  <div className="rv-work-main">
   <h2 className="rv-work-title"><Link to={"/app/sessions/" + row.sessionId}><VisibleText text={row.title} /></Link></h2>
   <div className="rv-work-context">
    {row.project !== undefined && <Link to={"/app/projects/" + encodeURIComponent(row.project)}><VisibleText text={row.project} /></Link>}
    {row.agent !== undefined && <span><VisibleText text={row.agent} /></span>}
    {row.place !== undefined && <span><VisibleText text={row.place.text} />{row.place.offline && " (offline)"}</span>}
   </div>
  </div>
  <div className="rv-work-facts">
   <span className="rv-work-state" data-tone={row.state.tone}><span className="rv-work-dot" aria-hidden="true" /><VisibleText text={row.state.label} /></span>
   {row.age !== undefined && <span className="rv-work-age">{row.since === undefined ? row.age : <time dateTime={row.since}>{row.age}</time>}</span>}
   {row.next !== undefined && <span className="rv-work-next">Next: <strong>{row.next}</strong></span>}
  </div>
  {live !== undefined && <div className="rv-work-actions">
   {live.approvalUrl !== undefined && isConfirmUrl(live.approvalUrl, host.origin) && <Button onClick={() => host.openExternal(live.approvalUrl!)}>Approve</Button>}
   <SessionControls id={row.sessionId} agent={row.agent ?? "The agent"} actions={live.actions} following={live.following} onChanged={onChanged} />
  </div>}
 </li>;
}
