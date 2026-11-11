import { Link } from "react-router";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { paths } from "../../paths.js";
import type { HomeAction, ReadHomeCard } from "../../api/home.js";
import { Button } from "../../design/Button.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { homeCardState } from "./home-rows.js";
import { StatePill } from "./StatePill.js";
import { useHomeCardActions } from "./use-home-card-actions.js";

/** Which action leads, by what it does: open a page, then retry, then start; a dismissal never leads (it is shown, quietly, after the others). */
const RANK: Readonly<Record<HomeAction["kind"], number>> = { internal: 0, confirm: 1, external: 2, retry: 3, ticket_start: 4, dismiss: 5, ticket_dismiss: 5 };
const isDismissal = (action: HomeAction): boolean => action.kind === "dismiss" || action.kind === "ticket_dismiss";

/** A failure card is `failure:<session id>`; one that arrives without its `sessionId` takes it from there, so its Open and Retry can still be offered (and checked: a Retry is only valid for the card's own session). */
export function withFailureSession(card: ReadHomeCard): ReadHomeCard {
 if (card.kind !== "failure" || card.sessionId !== undefined || !card.cardId.startsWith("failure:")) return card;
 const id = card.cardId.slice("failure:".length);
 return SessionIdSchema.safeParse(id).success ? { ...card, sessionId: id } : card;
}

/**
 * One older Home card as a row of the new Home (exp/home): its plain state, title, one-line reason, how long since it changed and one primary action. The other actions the card offers stay,
 * quiet, so nothing it offered is lost. Only the new Home imports this (and so the plain-state words); today's HomeCard does not.
 */
export function HomeCardRow({ card: read }: { card: ReadHomeCard }) {
 const card = withFailureSession(read);
 const { actions, busy, error, run } = useHomeCardActions(card);
 const ordered = [...actions].sort((a, b) => RANK[a.kind] - RANK[b.kind]), leads = ordered[0] !== undefined && !isDismissal(ordered[0]);
 // A card with no page of its own to open (and no lead action) opens its session.
 const open = SessionIdSchema.safeParse(card.sessionId).success && !actions.some(action => action.kind === "internal" && action.href.split("#")[0] === "/app/sessions/" + card.sessionId) ? paths.session(card.sessionId!) : undefined;
 const name = (action: HomeAction) => action.label + ": " + card.title, variant = (index: number) => index === 0 && leads ? "primary" as const : "quiet" as const;
 return <li className="rv-hv2-row" data-card-kind={card.kind}>
  <div className="rv-hv2-main"><p className="rv-hv2-top"><StatePill state={homeCardState(card.kind)} /><span className="rv-hv2-age">Updated <RelativeTime at={card.at} /></span></p><h3><VisibleText text={card.title} /></h3><p className="rv-hv2-line"><VisibleText text={card.reason} /></p></div>
  <div className="rv-hv2-actions">
   {ordered.map((action, index) => action.kind === "internal"
    ? <Link key={index} className={"rv-button rv-button-" + variant(index)} to={action.href} aria-label={name(action)}><VisibleText text={action.label} /></Link>
    : <Button key={index} variant={variant(index)} disabled={busy} aria-label={name(action)} onClick={() => { void run(action); }}><VisibleText text={action.label} /></Button>)}
   {open !== undefined && <Link className={"rv-button " + (leads ? "rv-button-quiet" : "rv-button-primary")} to={open} aria-label={"Open session: " + card.title}>Open session</Link>}
  </div>
  {error && <p role="alert" className="rv-hv2-error"><VisibleText text={error} /></p>}
 </li>;
}
