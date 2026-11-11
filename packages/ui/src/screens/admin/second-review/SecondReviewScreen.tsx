import { useRef, useState } from "react";
import { SettingsNote } from "../SettingsNote.js";
import { useQueryClient } from "@tanstack/react-query";
import type { SecondReviewState } from "@agentx/cloud-contracts/web";
import { ApiError } from "../../../api/errors.js";
import { secondReviewKey, useSecondReview, useSecondReviewApi } from "../../../api/second-review.js";
import { useAppHost } from "../../../host.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { expires, cost, days, T } from "./second-review-text.js";
import "../how-we-work/how-we-work.css";

type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };
type Ref = { provider: string; modelId: string };
const refKey = (model: Ref): string => model.provider + "\u0000" + model.modelId;
const refOf = (key: string): Ref | undefined => { const at = key.indexOf("\u0000"); return at < 0 ? undefined : { provider: key.slice(0, at), modelId: key.slice(at + 1) }; };

/** Runs one write: one press at a time, the server's words on a refusal, a fresh read afterwards. */
function useWrite() {
 const query = useQueryClient(), host = useAppHost(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 async function run(write: () => Promise<unknown>, done: string | ((answer: unknown) => string)) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   setMessage({ kind: "status", text: typeof done === "string" ? done : done(answer) });
   await query.invalidateQueries({ queryKey: secondReviewKey });
  } catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") { await query.invalidateQueries({ queryKey: secondReviewKey });setMessage({ kind: "alert", text: T.CHANGED }); }
   else if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") setMessage({ kind: "alert", text: error.message, signIn: true });
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 const view = <>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => host.signIn(host.currentPath())}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </>;
 return { run, busy, view };
}

function NoticeSection({ state }: { state: SecondReviewState }) {
 const api = useSecondReviewApi(), write = useWrite(), notice = state.notice;
 if (notice === null) return null;
 return <Banner title={T.NOTICE_HEADING} tone="warning" action={notice.seen ? undefined : <Button busy={write.busy} onClick={() => { void write.run(() => api.noticeSeen(notice.key), T.SEEN_DONE); }}>{T.SEEN}</Button>}>
  {notice.lines.map((line, index) => <p key={index}><VisibleText text={line} /></p>)}{write.view}
 </Banner>;
}

function ModeSection({ state }: { state: SecondReviewState }) {
 const api = useSecondReviewApi(), write = useWrite(), mine = state.modes.company;
 const [choice, setChoice] = useState<"off" | "shadow" | "on">();
 const picked = choice ?? mine;
 // Blocking can be turned on only for the model the evidence is about, and that has to be the reviewer the company CHOSE (a default or another primary is not what the record covers).
 const chosenPrimary = state.choice?.models[0], proof = state.evidence;
 const canOn = proof?.holds === true && chosenPrimary !== undefined && proof.model.provider === chosenPrimary.provider && proof.model.modelId === chosenPrimary.modelId;
 const pending = state.pending?.filter(item => item.scope === "company") ?? [];
 const options = [{ value: "off", label: T.MODE_OFF }, { value: "shadow", label: T.MODE_SHADOW }, { value: "on", label: T.MODE_ON, disabled: !canOn && mine !== "on" }];
 return <section aria-label={T.MODE_HEADING} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.MODE_HEADING}</h2>
  <p>{T.MODE_NOW} <strong>{{ off: T.MODE_OFF, shadow: T.MODE_SHADOW, on: T.MODE_ON }[mine]}</strong></p>
  <Select label={T.MODE_LABEL} value={picked} options={options} onValueChange={value => setChoice(value as "off" | "shadow" | "on")} />
  <p className="rv-muted">{T.MODE_HELP[picked]}</p>
  {!canOn && mine !== "on" && <p className="rv-muted">{T.MODE_ON_NEEDS}</p>}
  <p className="rv-muted">{T.LOWER_HELP}</p>
  <div className="rv-hww-company-actions"><Button variant="primary" busy={write.busy} disabled={picked === mine} onClick={() => { void write.run(() => api.setMode(picked), answer => (answer as { status?: string }).status === "needs_approval" ? T.MODE_ASKED : T.MODE_SAVED).then(() => setChoice(undefined)); }}>{T.MODE_SAVE}</Button></div>
  {state.pendingLowering && pending.length === 0 && <p role="status">{T.PENDING_HIDDEN}</p>}
  {pending.map(item => <div key={item.changeId}>
   <p role="status">{item.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER} ({item.from} to {item.to}). {expires(item.expiresAt)}</p>
   <div className="rv-hww-company-actions">
    {!item.proposedByYou && <Button variant="primary" busy={write.busy} onClick={() => { void write.run(() => api.approveMode(item.changeId), T.APPROVED); }}>{T.APPROVE}</Button>}
    <Button busy={write.busy} onClick={() => { void write.run(() => api.cancelMode(item.changeId), T.CANCELLED); }}>{T.CANCEL}</Button>
   </div></div>)}
  {write.view}
 </section>;
}

function ReviewerSection({ state }: { state: SecondReviewState }) {
 const api = useSecondReviewApi(), write = useWrite();
 const usable = state.models.filter(entry => entry.eligible);
 const chosen = state.choice?.models ?? [];
 const [primary, setPrimary] = useState<string>(), [backup, setBackup] = useState<string>();
 const primaryKey = primary ?? (chosen[0] === undefined ? "" : refKey(chosen[0])), backupKey = backup ?? (chosen[1] === undefined ? "" : refKey(chosen[1]));
 const options = usable.map(entry => ({ value: refKey(entry.model), label: entry.model.modelId + (entry.suggested ? " (" + T.SUGGESTED.toLowerCase() + ")" : "") }));
 const first = refOf(primaryKey), second = refOf(backupKey);
 return <section aria-label={T.REVIEWER_HEADING} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.REVIEWER_HEADING}</h2>
  {state.current.line !== undefined && <p><strong><VisibleText text={state.current.line} /></strong></p>}
  {state.current.source === "none" && state.current.reason !== undefined && <p role="status">No model is being used: <VisibleText text={state.current.reason} /></p>}
  {state.fitKnown === false && <p className="rv-muted">{T.FIT_UNKNOWN}</p>}
  {state.models.length === 0 ? <p>{T.NO_MODELS}</p> : <table className="rv-table"><thead><tr><th scope="col">{T.COL_MODEL}</th><th scope="col">{T.COL_MAKER}</th><th scope="col">{T.COL_COST}</th><th scope="col">{T.COL_FIT}</th><th scope="col">{T.COL_NOTES}</th></tr></thead>
   <tbody>{state.models.map(entry => <tr key={refKey(entry.model)} className={entry.eligible ? undefined : "rv-muted"}>
    <th scope="row"><VisibleText text={entry.model.modelId} /><br /><span className="rv-muted"><VisibleText text={entry.model.provider} /></span>{entry.suggested && <><br /><strong>{T.SUGGESTED}</strong>{entry.suggestionReason !== undefined && <>: <VisibleText text={entry.suggestionReason} /></>}</>}</th>
    <td data-label={T.COL_MAKER}><VisibleText text={entry.company} /></td><td data-label={T.COL_COST}>{cost(entry.costUsd)}</td>
    <td data-label={T.COL_FIT}>{entry.eligible ? T.FITS : T.NOT_USED + ": " + (entry.ineligibleWhy === undefined ? "" : T.WHY[entry.ineligibleWhy] ?? entry.ineligibleWhy)}</td>
    <td data-label={T.COL_NOTES}>{[...entry.notes, ...(entry.trackRecord === undefined ? [] : [entry.trackRecord])].map((note, index) => <span key={index}><VisibleText text={note} /><br /></span>)}</td></tr>)}</tbody></table>}
  {usable.length > 0 && <>
   <Select label={T.PRIMARY} value={primaryKey} options={options} placeholder="Choose a model" onValueChange={setPrimary} />
   <Select label={T.BACKUP} value={backupKey} options={[{ value: "", label: T.NONE }, ...options.filter(option => option.value !== primaryKey)]} onValueChange={setBackup} />
   <div className="rv-hww-company-actions">
    <Button variant="primary" busy={write.busy} disabled={first === undefined} onClick={() => { void write.run(() => api.choose(first!, second), T.CHOSEN); }}>{T.CHOOSE}</Button>
    {state.choice !== null && <Button busy={write.busy} onClick={() => { void write.run(() => api.clear(), T.DEFAULT_ON).then(() => { setPrimary(undefined);setBackup(undefined); }); }}>{T.USE_DEFAULT}</Button>}
   </div></>}
  {write.view}
 </section>;
}

function ContextSection({ state }: { state: SecondReviewState }) {
 const api = useSecondReviewApi(), write = useWrite(), [pick, setPick] = useState<"change_only" | "same_as_first">();
 const value = pick ?? state.context;
 return <section aria-label={T.CONTEXT_HEADING} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.CONTEXT_HEADING}</h2>
  <Select label={T.CONTEXT_LABEL} value={value} options={[{ value: "change_only", label: T.CONTEXT_CHANGE_ONLY }, { value: "same_as_first", label: T.CONTEXT_SAME }]} onValueChange={next => setPick(next as "change_only" | "same_as_first")} />
  {state.alsoSees !== null && <p><strong>Second reviewer also sees:</strong> <VisibleText text={state.alsoSees} /></p>}
  {value === "same_as_first" && state.context !== "same_as_first" && <p className="rv-muted">{T.CONTEXT_WIDENS}</p>}
  <div className="rv-hww-company-actions"><Button variant="primary" busy={write.busy} disabled={value === state.context} onClick={() => { void write.run(() => api.setContext(value), T.CONTEXT_SAVED).then(() => setPick(undefined)); }}>{T.CONTEXT_SAVE}</Button></div>
  {write.view}
 </section>;
}

function TrackSection({ state }: { state: SecondReviewState }) {
 const api = useSecondReviewApi(), write = useWrite(), track = state.trackRecord, evidence = state.evidence;
 return <section aria-label={T.TRACK_HEADING} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.TRACK_HEADING}</h2>
  {evidence !== null && <p className="rv-muted">{T.TRACK_FOR} <VisibleText text={evidence.model.modelId} /></p>}
  {track === null || track.reviews === 0 ? <p>{T.TRACK_NONE}</p> : <>
   <dl className="rv-evidence-counts">
    <div><dt>{T.DAYS}</dt><dd>{track.days}</dd></div><div><dt>{T.REVIEWS}</dt><dd>{track.reviews}</dd></div><div><dt>{T.FINDINGS}</dt><dd>{track.findings}</dd></div>
    <div><dt>{T.AGREED}</dt><dd>{track.agreed}</dd></div><div><dt>{T.WRONG}</dt><dd>{track.wrong}</dd></div><div><dt>{T.WAITING}</dt><dd>{track.open}</dd></div><div><dt>{T.MISSED}</dt><dd>{track.caughtMissedByFirst}</dd></div>
   </dl><p className="rv-muted">{T.TRACK_HELP}</p></>}
  {evidence !== null && <>
   <h3>{T.EVIDENCE_HEADING}</h3>
   <p role="status">{evidence.verdict === null ? T.NO_VERDICT : evidence.verdict.withdrawn ? T.WITHDRAWN : evidence.holds ? T.HOLDS : T.NOT_HOLDS}</p>
   {evidence.replay !== null && <p className="rv-muted">{T.REPLAY}: {evidence.replay.passed ? T.REPLAY_PASSED : T.REPLAY_FAILED} ({evidence.replay.tasks} cases)</p>}
   {evidence.verdict !== null && !evidence.verdict.withdrawn && <p className="rv-muted">{days(evidence.verdict.shadowDays)} · {evidence.verdict.shadowAgreed} of {evidence.verdict.shadowFindings} findings agreed</p>}
   {evidence.verdict !== null && !evidence.verdict.withdrawn && <div className="rv-hww-company-actions"><Button variant="danger" busy={write.busy} onClick={() => { void write.run(() => api.withdraw(evidence.model), T.WITHDRAW_DONE); }}>{T.WITHDRAW}</Button><span className="rv-muted">{T.WITHDRAW_HELP}</span></div>}</>}
  {write.view}
 </section>;
}

/**
 * The company's settings for the second opinion (lane cr-settings, switch `cr`): the mode, the reviewer model with the models the company can use (maker, cost, fit, notes, suggestions, primary and backup, the default),
 * what the second reviewer sees, and the track record that the "turn on" decision rests on. Everything the server decides (who may, what holds, what a refusal says) comes from it; this screen shows the answer, sends one
 * press and reads again. Absent (NOT_FOUND) while the switch is off.
 */
export function SecondReviewScreen() {
 const read = useSecondReview();
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the second opinion settings" /></section>;
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return <section><PageHeader focusOnMount title={T.TITLE} /><p>{T.UNAVAILABLE}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} /><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const state = read.data as unknown as SecondReviewState;
 return <section aria-label={T.TITLE}><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><SettingsNote area="second-review" />
  <NoticeSection state={state} /><ModeSection state={state} /><ReviewerSection state={state} /><ContextSection state={state} /><TrackSection state={state} />
 </section>;
}
