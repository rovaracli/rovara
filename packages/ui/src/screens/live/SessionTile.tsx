import { Link } from "react-router";
import { useAppHost } from "../../host.js";
import type { ReadLiveTile } from "../../api/live.js";
import { AvatarStack } from "../../design/AvatarStack.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { StatusDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
import { stripTerminalEscapes } from "../../text/terminal.js";
import { SessionControls } from "../session/SessionControls.js";
export function SessionTile({ tile, onChanged }: { tile: ReadLiveTile; onChanged: () => Promise<unknown> }) {
 const host = useAppHost();
 return <article className="rv-live-tile"><div className="rv-live-context">{tile.agent && <span><VisibleText text={tile.agent.name} /></span>}{tile.project && <Link to={"/app/projects/" + encodeURIComponent(tile.project)}><VisibleText text={tile.project} /></Link>}</div><h2><Link to={"/app/sessions/" + tile.sessionId}><VisibleText text={tile.title} /></Link></h2><div className="rv-live-progress"><StatusDot status={tile.status} words={tile.statusWords} />{tile.step && <strong><VisibleText text={tile.step} /></strong>}</div>{tile.peek && <p className="rv-live-peek"><VisibleText text={stripTerminalEscapes(tile.peek)} /></p>}<div className="rv-live-facts"><span>Owner: <VisibleText text={tile.owner.name} /></span><span>{tile.where.kind === "cloud" ? "Cloud" : tile.where.kind === "mac" ? <VisibleText text={"on " + tile.where.label} /> : "Location unavailable"}</span>{tile.where.kind === "mac" && tile.where.offline && <span>offline</span>}<Money usd={tile.costUsd} /></div><div className="rv-live-participants"><AvatarStack people={tile.viewingNow} total={tile.viewingNowCount} />{tile.approvalUrl !== undefined && isConfirmUrl(tile.approvalUrl, host.origin) && <Button onClick={() => host.openExternal(tile.approvalUrl!)}>Approve</Button>}</div><SessionControls id={tile.sessionId} agent={tile.agent?.name ?? "The agent"} actions={tile.actions} following={tile.following} onChanged={onChanged} /></article>;
}
