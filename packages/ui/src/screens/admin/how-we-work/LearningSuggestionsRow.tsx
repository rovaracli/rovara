import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { companySettingsKey, useCompanySuggestionsSettings, useLearningApi } from "../../../api/learning.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SUGGESTIONS as T } from "./company-text.js";
import "./how-we-work.css";

type Message = { kind: "status" | "alert"; text: string };
/** The company's master switch for rule suggestions (the learning loop). Changes apply at once in both directions; the server decides who may and counts the revision. */
export function LearningSuggestionsRow() {
 const api = useLearningApi(), query = useQueryClient(), read = useCompanySuggestionsSettings();
 const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(), sending = useRef(false);
 // An older server has no such setting (NOT_FOUND): nothing is shown, as the project section does.
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return null;
 if (read.isPending) return null;
 if (read.data === undefined) return <section aria-label={T.HEADING} className="rv-hww-company-card"><h2>{T.HEADING}</h2><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const { suggestions, source, revision, canChange } = read.data, known = suggestions === "on" || suggestions === "off";
 async function change(next: "on" | "off") {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   await api.setCompanySettings({ expectedRevision: revision, suggestions: next });
   await query.invalidateQueries({ queryKey: companySettingsKey });setConfirming(false);setMessage({ kind: "status", text: next === "on" ? T.SAVED_ON : T.SAVED_OFF });
  } catch (error) {
   setConfirming(false);
   if (error instanceof ApiError && error.code === "LEARNING_SETTINGS_CHANGED") { await query.invalidateQueries({ queryKey: companySettingsKey });setMessage({ kind: "alert", text: T.CHANGED }); }
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label={T.HEADING} className="rv-hww-company-card rv-hww-suggestions" aria-busy={busy}><h2>{T.HEADING}</h2>
  <p>Suggestions: <strong>{suggestions === "on" ? "On" : suggestions === "off" ? "Off" : "Unknown"}</strong>{source === "install_default" && <> <span className="rv-muted">{T.INSTALL_DEFAULT}</span></>}</p>
  <p className="rv-muted">{T.HELP}</p>
  {!canChange ? <p className="rv-muted">{T.READ_ONLY}</p> : known && (confirming ? <div><p>{T.CONFIRM}</p><div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { void change("on"); }}>{T.TURN_ON}</Button><Button disabled={busy} onClick={() => setConfirming(false)}>{T.CANCEL}</Button></div></div>
   : <div><Button busy={busy} onClick={() => { if (suggestions === "on") void change("off"); else { setMessage(undefined);setConfirming(true); } }}>{suggestions === "on" ? T.TURN_OFF : T.TURN_ON}</Button></div>)}
  {message !== undefined && <p role={message.kind === "alert" ? "alert" : "status"}><VisibleText text={message.text} /></p>}
 </section>;
}
