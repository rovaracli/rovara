import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { createHomeApi, homeAction, type HomeAction, type ReadHomeCard } from "../../api/home.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { homeCardState } from "./home-rows.js";
import { StatePill } from "./StatePill.js";
export function HomeCard({ card, compact = false }: { card: ReadHomeCard; /** The new Home (exp/home): a row with the plain state, the one-line why, the age and one primary action. The same actions and the same code run them. */ compact?: boolean }) {
 const host = useAppHost(), api = useMemo(() => createHomeApi(host), [host]), query = useQueryClient();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), sending = useRef(false);
 const actions = card.buttons.flatMap(button => { const action = homeAction(card, button, host.origin);return action === undefined ? [] : [action]; });
 async function run(action: HomeAction) {
  if (sending.current) return;
  if (action.kind === "external" || action.kind === "confirm") { host.openExternal(action.href);return; }
  if (action.kind !== "dismiss" && action.kind !== "retry" && action.kind !== "ticket_start" && action.kind !== "ticket_dismiss") return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   if (action.kind === "ticket_start" || action.kind === "ticket_dismiss") {
    // A waiting ticket's Start or Not this one: the intake client loads only when one is pressed.
    const { createIntakeApi } = await import("../../api/intake.js");
    const answer = await createIntakeApi(host).act(action.href, action.kind === "ticket_start" ? "start" : "dismiss");
    await query.invalidateQueries({ queryKey: ["home"] });
    const started = "started" in answer && answer.started ? SessionIdSchema.safeParse(answer.sessionId) : undefined;
    if (started?.success === true) { host.navigate(paths.session(started.data));return; }
    if ("started" in answer && !answer.started) throw new ApiError(409, "PENDING", answer.state === "started" ? "Someone already started this ticket." : "Rovara couldn't start this ticket yet. Try again later.");
    return;
   }
   if (action.kind === "dismiss") {
    const result = await api.dismissCard(card, action);
    if (result.kind !== "done" || result.value.cardId !== card.cardId) throw new ApiError(409, "PENDING", "This item hasn't been dismissed. Refresh to check its status.");
   } else {
    const result = await api.retry(card, action);
    if (result.kind !== "done") throw new ApiError(409, "PENDING", "This retry is waiting for confirmation. Open the session to continue.");
    await query.invalidateQueries({ queryKey: ["home"] });host.navigate("/app/sessions/" + SessionIdSchema.parse(result.value.session.sessionId));return;
   }
   await query.invalidateQueries({ queryKey: ["home"] });
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't complete this action. Try again."); }
  finally { sending.current = false;setBusy(false); }
 }
 if (compact) {
  // One primary action (the card's first), the rest quiet: nothing the card offered is lost. A card with no action of its own opens its session.
  const open = SessionIdSchema.safeParse(card.sessionId).success && !actions.some(action => action.kind === "internal" && action.href.split("#")[0] === "/app/sessions/" + card.sessionId) ? paths.session(card.sessionId!) : undefined;
  const label = (action: HomeAction) => <VisibleText text={action.label} />;
  const controls = actions.map((action, index) => action.kind === "internal"
   ? <Link key={index} className={"rv-button " + (index === 0 ? "rv-button-primary" : "rv-button-quiet")} to={action.href}>{label(action)}</Link>
   : <Button key={index} variant={index === 0 ? "primary" : "quiet"} disabled={busy} onClick={() => { void run(action); }}>{label(action)}</Button>);
  return <li className="rv-hv2-row" data-card-kind={card.kind}><div className="rv-hv2-main"><p className="rv-hv2-top"><StatePill state={homeCardState(card.kind)} /><RelativeTime at={card.at} /></p><h3><VisibleText text={card.title} /></h3><p className="rv-hv2-line"><VisibleText text={card.reason} /></p></div><div className="rv-hv2-actions">{controls}{open !== undefined && <Link className={"rv-button " + (actions.length === 0 ? "rv-button-primary" : "rv-button-quiet")} to={open} aria-label={"Open session: " + card.title}>Open session</Link>}</div>{error && <p role="alert" className="rv-hv2-error"><VisibleText text={error} /></p>}</li>;
 }
 return <li className="rv-attention-row"><article><div className="rv-attention-content"><h2><VisibleText text={card.title} /></h2><p className="rv-attention-reason"><VisibleText text={card.reason} /></p><RelativeTime at={card.at} /></div><div className="rv-attention-actions">{actions.map((action, index) => action.kind === "internal" ? <Link key={index} className="rv-attention-open" to={action.href}><VisibleText text={action.label} /></Link> : <Button key={index} disabled={busy} onClick={() => { void run(action); }}><VisibleText text={action.label} /></Button>)}{SessionIdSchema.safeParse(card.sessionId).success && !actions.some(action => action.kind === "internal" && action.href.split("#")[0] === "/app/sessions/" + card.sessionId) && <Link className="rv-attention-open" to={"/app/sessions/" + card.sessionId} aria-label={"Open session: " + card.title}>Open session<span aria-hidden="true"> →</span></Link>}</div></article>{error && <p role="alert"><VisibleText text={error} /></p>}</li>;
}
