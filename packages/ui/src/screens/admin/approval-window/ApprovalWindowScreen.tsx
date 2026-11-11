import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { approvalWindowKey, useApprovalWindow, useApprovalWindowApi, type ApprovalWindowAnswer, type ApprovalWindowState } from "../../../api/approval-window.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SettingsNote } from "../SettingsNote.js";
import { useAdminContext } from "../AdminLayout.js";
import { changedParts, currentSentence, durationWords, expires, policyRows, T, windowChoices } from "./approval-window-text.js";
import "../how-we-work/how-we-work.css";
import "./approval-window.css";

type Write = ReturnType<typeof useWrite>;
type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };

/** Runs one write: one press at a time, the server's words on a refusal (verbatim), a fresh read afterwards. The screen holds it, so an answer stays on screen when the card that was pressed goes away (an approved request). */
function useWrite(orgId: string, developerId: string) {
 const query = useQueryClient(), host = useAppHost(), sending = useRef(false), key = approvalWindowKey(orgId, developerId);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 async function run(write: () => Promise<ApprovalWindowAnswer>, done: (answer: ApprovalWindowAnswer) => string) {
  if (sending.current) return false;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   setMessage({ kind: "status", text: done(answer) });
   await query.invalidateQueries({ queryKey: key });
   return true;
  } catch (error) {
   if (error instanceof ApiError && (error.code === "CHANGE_STALE" || error.code === "POLICY_STALE")) void query.invalidateQueries({ queryKey: key });
   if (error instanceof ApiError) setMessage({ kind: "alert", text: error.message, signIn: error.code === "REAUTH_REQUIRED" });
   else setMessage({ kind: "alert", text: T.FAILED });
   return false;
  } finally { sending.current = false;setBusy(false); }
 }
 const view = <>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </>;
 return { run, busy, view };
}

function CurrentSection({ state }: { state: ApprovalWindowState }) {
 const changed = changedParts(state.seconds, state.changedBy, state.changedAt);
 return <section aria-label={T.CURRENT_HEADING} className="rv-hww-company-card rv-aw-card"><h2>{T.CURRENT_HEADING}</h2>
  <p><strong>{currentSentence(state.seconds)}</strong></p>
  {state.unreadable && <p role="alert">{T.UNREADABLE}</p>}
  <dl className="rv-aw-facts">
   <div><dt>Default</dt><dd>{durationWords(state.defaultSeconds)}</dd></div>
   <div><dt>Your company</dt><dd>{state.unreadable ? "Could not be read" : state.isDefault ? "The default" : durationWords(state.seconds)}</dd></div>
  </dl>
  <p className="rv-muted">{state.isDefault || state.unreadable ? T.DEFAULT_LINE : changed === undefined ? T.SET_LINE + " (" + durationWords(state.defaultSeconds) + ")." : <>{changed.before}{changed.by !== undefined && <> by <VisibleText text={changed.by} /></>}{changed.after}</>} {!state.isDefault && !state.unreadable && <Link to="/app/admin/audit">{T.AUDIT_LINK}</Link>}</p>
  <p className="rv-muted">{T.SLACK_GITHUB}</p>
 </section>;
}

function PendingSection({ state, write }: { state: ApprovalWindowState; write: Write }) {
 const api = useApprovalWindowApi(), pending = state.pending;
 if (pending === null || pending === undefined) return null;
 const stamp = expires(pending.expiresAt);
 return <section aria-label={T.PENDING_HEADING} className="rv-hww-company-card rv-aw-card" aria-busy={write.busy}><h2>{T.PENDING_HEADING}</h2>
  <p role="status">{pending.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER} from {durationWords(state.seconds)} to <strong>{durationWords(pending.seconds)}</strong>. {stamp}</p>
  <p className="rv-muted">{T.ONE_AT_A_TIME}</p>
  {!pending.proposedByYou && state.canChange && <p className="rv-muted">{T.APPROVE_HELP}</p>}
  {state.canChange && <div className="rv-hww-company-actions">
   {!pending.proposedByYou && <Button variant="primary" busy={write.busy} onClick={() => { void write.run(() => api.approve(pending.changeId), answer => T.APPROVED + " " + durationWords(answer.seconds) + "."); }}>{T.APPROVE}</Button>}
   <Button busy={write.busy} onClick={() => { void write.run(() => api.cancel(pending.changeId), () => T.CANCELLED); }}>{T.CANCEL}</Button>
  </div>}
  </section>;
}

function ChangeSection({ state, write }: { state: ApprovalWindowState; write: Write }) {
 const api = useApprovalWindowApi(), [pick, setPick] = useState<string>();
 if (state.unreadable) return null;
 const choices = windowChoices(state.seconds, state.minSeconds, state.maxSeconds);
 const picked = pick !== undefined && choices.includes(Number(pick)) ? Number(pick) : state.seconds;
 const options = choices.map(value => ({ value: String(value), label: durationWords(value) + (value === state.defaultSeconds ? " (default)" : "") }));
 const help = picked === state.seconds ? T.SAME : picked < state.seconds ? T.SHORTER : T.LONGER;
 return <section aria-label={T.CHANGE_HEADING} className="rv-hww-company-card rv-aw-card" aria-busy={write.busy}><h2>{T.CHANGE_HEADING}</h2>
  {!state.canChange ? <p>{T.READ_ONLY}</p> : <>
   <Select label={T.CHOOSE} value={String(picked)} options={options} onValueChange={setPick} />
   <p className="rv-muted">{help}</p>
   <div className="rv-hww-company-actions"><Button variant="primary" busy={write.busy} disabled={picked === state.seconds} onClick={() => {
    void write.run(() => api.set(state.revision, picked), answer => answer.status === "needs_approval" ? T.ASKED + " " + durationWords(picked) + "." : T.SAVED_SHORTER + " " + durationWords(answer.seconds) + ".").then(ok => { if (ok) setPick(undefined); });
   }}>{T.SAVE}</Button></div></>}
  </section>;
}

function PolicySection({ state }: { state: ApprovalWindowState }) {
 const rows = policyRows(state.seconds);
 return <section aria-label={T.POLICY_HEADING} className="rv-hww-company-card rv-aw-card"><h2>{T.POLICY_HEADING}</h2>
  <div className="rv-table-wrap"><table className="rv-table rv-aw-policy"><caption>{T.POLICY_CAPTION}</caption>
   <thead><tr><th scope="col">{T.COL_PLACE}</th><th scope="col">{T.COL_LOW}</th><th scope="col">{T.COL_MEDIUM}</th><th scope="col">{T.COL_HIGH}</th></tr></thead>
   <tbody>{rows.map(row => <tr key={row.place}><th scope="row">{row.place}</th><td data-label={T.COL_LOW}>{row.low}</td><td data-label={T.COL_MEDIUM}>{row.medium}</td><td data-label={T.COL_HIGH}>{row.high}</td></tr>)}</tbody></table></div>
  <h3>{T.POLICY_ALSO}</h3>
  <ul className="rv-aw-list"><li>{T.REQUEST_CHANGES}</li><li>{T.REJECT}</li><li>{T.NOT_NOW}</li></ul>
  <p className="rv-muted">{T.LINKED}</p>
 </section>;
}

/**
 * Company settings: the recent sign-in window (lane exp/approval-window). How recently a person must have signed in to Rovara to approve medium-risk work from chat or comments, how to change it
 * (shorter at once; longer waits for a second admin), and the read-only policy table. The server decides who may, what a lengthening needs and what a refusal says; this screen shows the answer and sends one press.
 * Absent (NOT_FOUND) while the server's switch is off.
 */
export function ApprovalWindowScreen() {
 const { orgId, developerId } = useAdminContext(), read = useApprovalWindow(orgId, developerId), write = useWrite(orgId, developerId);
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the recent sign-in window" /></section>;
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return <section><PageHeader focusOnMount title={T.TITLE} /><p>{T.UNAVAILABLE}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} /><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const state = read.data;
 return <section aria-label={T.TITLE}><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><SettingsNote area="approval-window" />
  <CurrentSection state={state} />
  {state.pending === null || state.pending === undefined ? null : <PendingSection state={state} write={write} />}
  <div className="rv-aw-result">{write.view}</div>
  <ChangeSection state={state} write={write} />
  <PolicySection state={state} />
  <section aria-label={T.WHY_HEADING} className="rv-hww-company-card rv-aw-card"><h2>{T.WHY_HEADING}</h2><p>{T.WHY}</p></section>
 </section>;
}
