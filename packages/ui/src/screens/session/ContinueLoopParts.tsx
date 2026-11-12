import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createContinueLoopActions } from "../../api/continue-loop.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Chip } from "../../design/Chip.js";
import { VisibleText } from "../../design/VisibleText.js";
import { CHANGED_OUTSIDE, outsideRowsOf, pushedByWords, useNow, type ContinueLoop, type OutsideRow } from "./continue-outside.js";
import { RECHECK_UNAVAILABLE, type ContinueOffer, type LoopBranch } from "./continue-in-tool.js";

const sessionKey = (offer: ContinueOffer) => ["session", offer.sessionId] as const;

/** "Publish working branch" for one repository that has no branch yet. Sent once from the browser (a token gets 403); a refusal shows the server's own sentence; REAUTH_REQUIRED offers "Sign in again". */
export function PublishBranch({ offer, repository, labelled, onPublished }: { offer: ContinueOffer; repository: string; labelled: boolean; onPublished: (branch: LoopBranch) => void }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createContinueLoopActions(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reauth, setReauth] = useState(false), sending = useRef(false), requestId = useRef<string | undefined>(undefined);
 async function press() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);setReauth(false);
  try {
   requestId.current ??= crypto.randomUUID();
   const result = await api.publishBranch(offer.taskId, requestId.current, repository);
   requestId.current = undefined;
   // Show the branch now; the task view read again makes it permanent.
   onPublished({ repository: result.repository, branch: result.branch, source: "published", headSha: result.commit });
   await query.invalidateQueries({ queryKey: sessionKey(offer) });
  } catch (failure) {
   // A refusal (a closed task, a branch that already exists with other work) is final for this request: the next press sends a fresh one. A dropped connection keeps the id, so a repeat is the same press.
   if (!(failure instanceof ApiError) || failure.code !== "NETWORK_ERROR") requestId.current = undefined;
   setReauth(failure instanceof ApiError && failure.code === "REAUTH_REQUIRED");
   setError(failure instanceof ApiError ? failure.message : "Couldn't publish the branch. Try again.");
  } finally { sending.current = false;setBusy(false); }
 }
 return <span className="rv-continue-publish">
  <Button variant="secondary" className="rv-continue-action" aria-disabled={busy || undefined} aria-busy={busy || undefined} {...(labelled ? { "aria-label": "Publish working branch in " + repository } : {})} onClick={() => { void press(); }}>Publish working branch</Button>
  {error !== undefined && <span role="alert" className="rv-continue-error"><VisibleText text={error} /></span>}
  {reauth && <Button variant="quiet" onClick={() => host.signIn(host.currentPath())}>Sign in again</Button>}
 </span>;
}

/**
 * Recheck for one head that changed outside Rovara. Shown only where the server says this row can be re-checked (`canRecheck`). Sent once, never retried. A server whose worker cannot adopt a head answers 503
 * (OUTSIDE_RECHECK_WORKER_MISSING): its sentence is shown and the button stays off (aria-disabled, so focus stays) until the page is read again. What happens after the press comes from the server: the row then
 * says `rechecking` and has no button. The refusal sentence lives in this component, which is keyed by repository and number only, so reading the task again (a moved head) keeps it.
 */
function Recheck({ offer, row }: { offer: ContinueOffer; row: OutsideRow & { number: number } }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createContinueLoopActions(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reauth, setReauth] = useState(false), [unavailable, setUnavailable] = useState(false), sending = useRef(false);
 async function press() {
  if (sending.current || unavailable) return;
  sending.current = true;setBusy(true);setError(undefined);setReauth(false);
  try {
   await api.recheck(offer.taskId, { requestId: crypto.randomUUID(), repository: row.repository, number: row.number, headSha: row.headSha });
   await query.invalidateQueries({ queryKey: sessionKey(offer) });
  } catch (failure) {
   setReauth(failure instanceof ApiError && failure.code === "REAUTH_REQUIRED");
   if (failure instanceof ApiError && failure.status === 503) { setUnavailable(true);setError(failure.code === "REQUEST_FAILED" ? RECHECK_UNAVAILABLE : failure.message); }
   else setError(failure instanceof ApiError ? failure.message : "Couldn't ask for a re-check. Try again.");
   // The head moved again since the page read it: read the page again so the next press is for the new head. The sentence stays.
   if (failure instanceof ApiError && failure.code === "STALE_FENCE") await query.invalidateQueries({ queryKey: sessionKey(offer) });
  } finally { sending.current = false;setBusy(false); }
 }
 const place = row.repository + " #" + String(row.number);
 return <span className="rv-continue-publish">
  <Button variant="secondary" className="rv-continue-action" aria-disabled={busy || unavailable || undefined} aria-busy={busy || undefined} aria-label={"Recheck " + place} onClick={() => { void press(); }}>Recheck</Button>
  {error !== undefined && <span role="alert" className="rv-continue-error"><VisibleText text={error} /></span>}
  {reauth && <Button variant="quiet" onClick={() => host.signIn(host.currentPath())}>Sign in again</Button>}
 </span>;
}

/** The "Changed outside Rovara · checks needed" state in the panel: the existing outside-change chip, who pushed last, and Recheck where the server offers it. Nothing at all when nothing changed outside. */
export function OutsideChanges({ offer, loop }: { offer: ContinueOffer; loop: ContinueLoop | undefined }) {
 const rows = outsideRowsOf(loop), now = useNow(rows.length > 0);
 if (loop === undefined || rows.length === 0) return null;
 // The key is the repository and number, never the head: a moved head reads the same row again and keeps what it said.
 return <div className="rv-continue-outside" role="group" aria-label={CHANGED_OUTSIDE}>
  <p><Chip kind="outside-change">{CHANGED_OUTSIDE}</Chip></p>
  <ul>{rows.map(row => <li key={row.repository + "#" + String(row.number ?? "branch")}><span><VisibleText text={pushedByWords(row, now, rows.length > 1)} /></span>
   {row.rechecking === true ? <span className="rv-continue-note">Re-checking</span>
    : loop.canRecheck && row.canRecheck && row.number !== undefined ? <Recheck offer={offer} row={{ ...row, number: row.number }} /> : null}
   {row.rechecking !== true && row.recheckNote !== undefined && <span className="rv-continue-note"><VisibleText text={row.recheckNote} /></span>}</li>)}</ul>
 </div>;
}
