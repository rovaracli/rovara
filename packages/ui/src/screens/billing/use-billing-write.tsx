// One billing write at a time: one press, the server's own words on a refusal, a fresh read afterwards. The answer of a write carries the billing state exactly as a read would, so it replaces the cached state.
// A repeat of the same press (the network dropped, so the outcome is unknown) reuses its requestId, and the server returns the stored outcome instead of writing twice. A refusal drops the id: the next press is a new request.
import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { billingKey, hostedPageUrl, invoicesKey, trialKey, useTrialBillingApi, type BillingActionInput, type BillingAnswer } from "../../api/trial-billing.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

export const WRITE_WORDS = {
 FAILED: "Couldn't do that. Try again.",
 SIGN_IN_HELP: "This change needs a sign-in from the last 10 minutes. Sign in again, then press the button once more.",
 SIGN_IN_AGAIN: "Sign in again",
 OPENED: "The secure page opened in a new tab. If nothing opened, use this link:",
 OPEN_AGAIN: "Open the secure page",
} as const;
type Message = { kind: "status"; text: string; link?: string } | { kind: "alert"; text: string; signIn?: boolean };

export function useBillingWrite(onDone?: (text: string) => void) {
 const query = useQueryClient(), host = useAppHost(), api = useTrialBillingApi(), sending = useRef(false), ids = useRef(new Map<string, string>());
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 /** Runs the action; the answer when it was accepted, undefined otherwise. A second press while one is running is ignored. */
 async function run(action: BillingActionInput, done: string): Promise<BillingAnswer | undefined> {
  if (sending.current) return undefined;
  sending.current = true;setBusy(true);setMessage(undefined);onDone?.("");
  const key = JSON.stringify(action), requestId = ids.current.get(key) ?? crypto.randomUUID();
  ids.current.set(key, requestId);
  try {
   const answer = await api.send({ ...action, requestId });
   ids.current.delete(key);
   query.setQueryData(billingKey, answer.state);
   void query.invalidateQueries({ queryKey: trialKey });void query.invalidateQueries({ queryKey: invoicesKey });
   const url = hostedPageUrl(answer);
   if (url !== undefined) { host.openExternal(url);setMessage({ kind: "status", text: WRITE_WORDS.OPENED, link: url }); }
   else if (onDone === undefined) setMessage({ kind: "status", text: done });
   else onDone(done);
   return answer;
  } catch (error) {
   if (error instanceof ApiError) {
    if (error.status !== 0 && error.status < 500) ids.current.delete(key);
    // A stale or refused change also re-reads, so the page shows what is true now. The refusal is shown as the server wrote it.
    if (error.code === "CHANGE_STALE" || error.status === 403 || error.status === 404) { void query.invalidateQueries({ queryKey: billingKey, exact: true });void query.invalidateQueries({ queryKey: trialKey, exact: true }); }
    setMessage({ kind: "alert", text: error.message, signIn: error.code === "REAUTH_REQUIRED" });
   } else setMessage({ kind: "alert", text: WRITE_WORDS.FAILED });
   return undefined;
  } finally { sending.current = false;setBusy(false); }
 }
 const view: ReactNode = <>
  <p role="status" className="rv-tb-status">{message?.kind === "status" ? message.text : ""}{message?.kind === "status" && message.link !== undefined && <> <a href={message.link} target="_blank" rel="noopener noreferrer">{WRITE_WORDS.OPEN_AGAIN}</a></>}</p>
  {message?.kind === "alert" && <div role="alert" className="rv-tb-alert"><p><VisibleText text={message.text} /></p>{message.signIn === true && <><p className="rv-muted">{WRITE_WORDS.SIGN_IN_HELP}</p><Button onClick={() => { host.signIn(host.currentPath()); }}>{WRITE_WORDS.SIGN_IN_AGAIN}</Button></>}</div>}
 </>;
 return { run, busy, view, failed: message?.kind === "alert" };
}
