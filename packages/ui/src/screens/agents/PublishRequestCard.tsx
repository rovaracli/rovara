import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MY_AGENTS_KEY, PUBLISH_KEY, useAgentPublishApi, type ReadPublishRequest } from "../../api/agent-publish.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { isConfirmUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "./agent-context.js";
import { PublishSummary } from "./PublishSummary.js";
import { cannotDecideLine, knownTarget, outcomeLine, stateWords, targetKey, targetName, targetShort } from "./publish-words.js";
import "./publish.css";

const dateWords = (at: string): string => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "a later date";

/**
 * One publish request, for the person who asked and for the person who decides. It shows what the approver is told (the summary and the sentences that say what is less safe), and what approving does in the server's
 * own fixed words. Every Approve and Decline is made on the request's confirmation page (`approval.confirmUrl`), with a fresh sign-in: the card says what will happen, then opens that page, where the
 * decliner may also say why. The card never posts a decision itself (the decide route refuses a script's request, RULING Q10). The server decides who may; nothing here guesses it.
 */
export function PublishRequestCard({ request, meId, onDecided }: { request: ReadPublishRequest; meId: string | undefined; onDecided?: ((message: string) => void) | undefined }) {
 const api = useAgentPublishApi(), host = useAppHost(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reauth, setReauth] = useState<{ url?: string }>(), [choosing, setChoosing] = useState<"approve" | "decline">(), [noWithdraw, setNoWithdraw] = useState(false);
 const pending = request.state === "pending", mine = meId !== undefined && request.requestedBy.id === meId, canDecide = pending && request.approval.canDecide;
 const confirmUrl = typeof request.approval.confirmUrl === "string" && isConfirmUrl(request.approval.confirmUrl, host.origin) ? request.approval.confirmUrl : undefined;
 const refresh = () => Promise.all([[PUBLISH_KEY], ["agent", request.agent.agentId], ["agents"], [MY_AGENTS_KEY]].map(queryKey => query.invalidateQueries({ queryKey })));
 async function run(work: () => Promise<void>) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);setReauth(undefined);
  try { await work(); } catch (failure) {
   if (failure instanceof ApiError && failure.code === "REAUTH_REQUIRED") { setReauth(failure.signInUrl === undefined ? {} : { url: failure.signInUrl });setError(failure.message); }
   else setError(failureText(failure, "Couldn't complete this. Try again."));
  } finally { sending.current = false;setBusy(false); }
 }
 /** Opens the confirmation page, where the decision is made with a fresh sign-in. */
 const toConfirmation = () => {
  if (confirmUrl === undefined) { setError("The confirmation page isn't available right now. Reload this page and try again.");return; }
  onDecided?.("Confirm " + request.agent.name + " for " + targetName(request.target) + " on the next page.");
  host.openExternal(confirmUrl);
 };
 const withdraw = () => run(async () => {
  try { await api.withdraw(request.requestId);await refresh(); } catch (failure) {
   // The server may not have the withdraw route yet: say so, and stop offering it; the request ends by itself.
   if (failure instanceof ApiError && (failure.status === 404 || failure.status === 405)) { setNoWithdraw(true);setError("Withdrawing isn't available yet. This request runs out on " + dateWords(request.expiresAt) + ".");return; }
   throw failure;
  }
 });
 const company = knownTarget(request.target)?.kind === "company", waitingOn = cannotDecideLine(request), outcome = outcomeLine(request), askKey = targetKey(request.target), again = (request.state === "stale" || request.state === "expired") && mine && askKey !== undefined;
 return <li className="rv-pub-card" data-state={request.state}>
  <div className="rv-pub-head"><h3><Link to={paths.agent(request.agent.agentId)}><VisibleText text={request.agent.name} /></Link></h3><span className="rv-pub-state" data-state={request.state}>{stateWords(request.state)}</span></div>
  <p className="rv-muted rv-pub-meta">To <VisibleText text={targetShort(request.target)} /> · Version {request.version} · Asked by <VisibleText text={mine ? "you" : request.requestedBy.name} /> <RelativeTime at={request.requestedAt} />{pending && <> · Runs out on {dateWords(request.expiresAt)}</>}</p>
  {request.note !== null && request.note !== "" && <p className="rv-pub-note">“<VisibleText text={request.note} />”</p>}
  <p className="rv-pub-effect"><VisibleText text={request.effect} /></p>
  <details className="rv-pub-details" open={canDecide}><summary>What it can do</summary><PublishSummary summary={request.summary} label={"What " + request.agent.name + " can do"} /></details>
  {pending && !canDecide && waitingOn !== undefined && <p className="rv-muted">{waitingOn}</p>}
  {!pending && outcome !== undefined && <p className="rv-pub-outcome"><VisibleText text={outcome} /></p>}
  {canDecide && choosing === undefined && <div className="rv-actions"><Button variant="primary" onClick={() => setChoosing("approve")} aria-label={"Approve " + request.agent.name + " for " + targetShort(request.target)}>Approve</Button><Button onClick={() => setChoosing("decline")} aria-label={"Decline " + request.agent.name + " for " + targetShort(request.target)}>Decline</Button></div>}
  {canDecide && choosing === "approve" && <div className="rv-pub-decline" role="group" aria-label={"Confirm approving " + request.agent.name}><p><strong>Approve {request.agent.name} for {targetShort(request.target)}?</strong> <VisibleText text={request.effect !== "" ? request.effect : company ? "Approving shares this agent with everyone in your company." : "Approving moves this agent to the project. You become accountable for it."} /></p><p className="rv-muted">You'll confirm on the next page, with a fresh sign-in.</p><div className="rv-actions"><Button variant="primary" onClick={toConfirmation}>Continue to approve</Button><Button onClick={() => { setChoosing(undefined); }}>Cancel</Button></div></div>}
  {canDecide && choosing === "decline" && <div className="rv-pub-decline" role="group" aria-label={"Confirm declining " + request.agent.name}><p><strong>Decline {request.agent.name} for {targetShort(request.target)}?</strong> The person who asked will see that it was declined.</p><p className="rv-muted">You'll confirm on the next page, with a fresh sign-in. You can say why there.</p><div className="rv-actions"><Button variant="danger" onClick={toConfirmation}>Continue to decline</Button><Button onClick={() => { setChoosing(undefined); }}>Cancel</Button></div></div>}
  {pending && mine && !noWithdraw && <div className="rv-actions"><Button busy={busy} onClick={() => { void withdraw(); }} aria-label={"Withdraw the request for " + request.agent.name}>Withdraw</Button></div>}
  {again && <p><Link className="rv-button" to={paths.agent(request.agent.agentId) + "?publish=1&to=" + encodeURIComponent(askKey ?? "")}>Ask again</Link></p>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {reauth !== undefined && <div className="rv-actions">{reauth.url !== undefined ? <a className="rv-button rv-button-secondary" href={reauth.url}>Sign in again</a> : <Button onClick={() => host.signIn(host.currentPath())}>Sign in again</Button>}{confirmUrl !== undefined && <Button onClick={() => host.openExternal(confirmUrl)}>Or confirm on the next page</Button>}</div>}
 </li>;
}
