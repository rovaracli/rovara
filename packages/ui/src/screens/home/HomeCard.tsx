import { Link } from "react-router";
import type { HomeCardReaderSchema } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { RelativeTime } from "../../design/RelativeTime.js";
type ReadHomeCard = ReturnType<typeof HomeCardReaderSchema.parse>;
export function HomeCard({ card }: { card: ReadHomeCard }) {
 // RULING Q22: placeholder button.action is arbitrary text and carries no href. Never infer a write or permission from it.
 return <li className="rv-attention-row"><article><div className="rv-attention-content"><h2><VisibleText text={card.title} /></h2><RelativeTime at={card.at} /></div>{card.sessionId !== undefined && <Link className="rv-attention-open" to={"/s/" + encodeURIComponent(card.sessionId)} aria-label={"Open session: " + card.title}>Open session<span aria-hidden="true"> →</span></Link>}</article></li>;
}
