import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { knownFailingPolicyKey, useKnownFailingApi, useKnownFailingPolicy } from "../../../api/known-failing.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { KF_POLICY as T, kfExpiresText } from "./company-text.js";
import "./how-we-work.css";

type Answer = Awaited<ReturnType<ReturnType<typeof useKnownFailingApi>["setPolicy"]>>;
type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };
/**
 * The company setting "always two people" for marking tests as already failing (owner decision, 2026-11-02). Turning it ON applies at once. Turning it OFF opens a request that a DIFFERENT admin approves, signed in within
 * the last 10 minutes. This page is the company admins' (members never reach it), and who may change it, whether a request is waiting and whose it is are the server's to say (a refusal is shown in its words); this row only shows the answer, sends one press and reads again. Absent (NOT_FOUND) while the four test results are off.
 */
export function KnownFailingPolicyRow() {
 const api = useKnownFailingApi(), query = useQueryClient(), host = useAppHost(), read = useKnownFailingPolicy(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return null;
 if (read.isPending) return null;
 if (read.data === undefined) return <section aria-label={T.HEADING} className="rv-hww-company-card"><h2>{T.HEADING}</h2><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const state = read.data, pending = state.pending;
 async function run(write: () => Promise<Answer>, done: string) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   // The change's own answer is the new state, so a failed re-read cannot leave the old one on screen.
   query.setQueryData(knownFailingPolicyKey, { alwaysTwoPeople: answer.alwaysTwoPeople, pendingLoosening: answer.pendingLoosening, ...(answer.pending === undefined ? {} : { pending: answer.pending }) });
   setMessage({ kind: "status", text: done });
   await query.invalidateQueries({ queryKey: knownFailingPolicyKey });
  } catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") { await query.invalidateQueries({ queryKey: knownFailingPolicyKey });setMessage({ kind: "alert", text: T.CHANGED }); }
   else if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") setMessage({ kind: "alert", text: error.message, signIn: true });
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 const turnOn = () => run(() => api.setPolicy(true), T.SAVED_ON);
 const askOff = () => run(() => api.setPolicy(false), T.ASKED_OFF);
 const approve = () => run(() => api.approvePolicy(pending!.changeId), T.APPROVED);
 return <section aria-label={T.HEADING} className="rv-hww-company-card rv-hww-suggestions" aria-busy={busy}><h2>{T.HEADING}</h2>
  <p>Now: <strong>{state.alwaysTwoPeople ? T.LABEL_ON : T.LABEL_OFF}</strong></p>
  <p className="rv-muted">{T.HELP}</p>
  <p className="rv-muted">{state.alwaysTwoPeople ? T.STATE_ON : T.STATE_OFF}</p>
  {state.pendingLoosening && <p role="status">{pending === undefined ? T.PENDING_HIDDEN : pending.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER}</p>}
  {pending !== undefined && <p className="rv-muted">{kfExpiresText(pending.expiresAt)}</p>}
  <div className="rv-hww-company-actions">
   {!state.alwaysTwoPeople && <><Button variant="primary" busy={busy} onClick={() => { void turnOn(); }}>{T.TURN_ON}</Button><span className="rv-muted">{T.TURN_ON_HELP}</span></>}
   {state.alwaysTwoPeople && pending === undefined && !state.pendingLoosening && <><Button busy={busy} onClick={() => { void askOff(); }}>{T.ASK_OFF}</Button><span className="rv-muted">{T.ASK_OFF_HELP}</span></>}
   {pending !== undefined && !pending.proposedByYou && <><Button variant="primary" busy={busy} onClick={() => { void approve(); }}>{T.APPROVE}</Button><span className="rv-muted">{T.APPROVE_HELP}</span></>}
  </div>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => host.signIn(host.currentPath())}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </section>;
}
