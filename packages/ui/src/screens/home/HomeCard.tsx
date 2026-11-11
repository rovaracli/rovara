import { Link } from "react-router";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { type ReadHomeCard } from "../../api/home.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { useHomeCardActions } from "./use-home-card-actions.js";
export function HomeCard({ card }: { card: ReadHomeCard }) {
 const { actions, busy, error, run } = useHomeCardActions(card);
 return <li className="rv-attention-row"><article><div className="rv-attention-content"><h2><VisibleText text={card.title} /></h2><p className="rv-attention-reason"><VisibleText text={card.reason} /></p><RelativeTime at={card.at} /></div><div className="rv-attention-actions">{actions.map((action, index) => action.kind === "internal" ? <Link key={index} className="rv-attention-open" to={action.href}><VisibleText text={action.label} /></Link> : <Button key={index} disabled={busy} onClick={() => { void run(action); }}><VisibleText text={action.label} /></Button>)}{SessionIdSchema.safeParse(card.sessionId).success && !actions.some(action => action.kind === "internal" && action.href.split("#")[0] === "/app/sessions/" + card.sessionId) && <Link className="rv-attention-open" to={"/app/sessions/" + card.sessionId} aria-label={"Open session: " + card.title}>Open session<span aria-hidden="true"> →</span></Link>}</div></article>{error && <p role="alert"><VisibleText text={error} /></p>}</li>;
}
