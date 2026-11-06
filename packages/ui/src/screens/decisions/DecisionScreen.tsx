import { useParams } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { SingleDecision } from "../home/NeedsYou.js";
import "../home/home.css";

/**
 * Decision journey slice 3b: the card-only page of one decision (`/app/decisions/<kind>/<subject>`). It shows the card and its evidence as the server answers it for this person (only a card they may decide
 * is ever listed for them), with the card's own inline checks; nothing else of the task. The server checks the person's authority again on every read and press.
 */
export function DecisionScreen() {
 const { kind = "", subject = "" } = useParams();
 const cardId = /^[a-z_]{1,40}$/u.test(kind) && /^[A-Za-z0-9_-]{1,150}$/u.test(subject) ? kind + ":" + subject : "";
 return <section className="rv-home"><PageHeader title="Decision" />{cardId === "" ? <p role="status">This decision is no longer waiting for you.</p> : <SingleDecision cardId={cardId} />}</section>;
}
