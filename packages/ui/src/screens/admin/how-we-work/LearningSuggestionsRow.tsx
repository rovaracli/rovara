import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { companySettingsKey, useCompanySuggestionsSettings, useLearningApi } from "../../../api/learning.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SUGGESTIONS as T } from "./company-text.js";
import "./how-we-work.css";

/** A status line belongs to the revision it reported; once the setting is read at another revision it is no longer true and goes. An alert stays until the next action. */
type Message = { kind: "status"; text: string; revision: number } | { kind: "alert"; text: string };
/** The company's master switch for rule suggestions (the learning loop). Changes apply at once in both directions; the server decides who may and counts the revision. */
export function LearningSuggestionsRow() {
 const api = useLearningApi(), query = useQueryClient(), read = useCompanySuggestionsSettings();
 const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(), sending = useRef(false), actions = useRef<HTMLDivElement>(null), refocus = useRef(false);
 // Focus follows the change of control: into the confirm step when it opens, back to the row's button when it closes (the button it replaced is gone).
 useEffect(() => { if (confirming) actions.current?.querySelector("button")?.focus();else if (refocus.current) { refocus.current = false;actions.current?.querySelector("button")?.focus(); } }, [confirming]);
 // An older server has no such setting (NOT_FOUND): nothing is shown, as the project section does.
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return null;
 if (read.isPending) return null;
 if (read.data === undefined) return <section aria-label={T.HEADING} className="rv-hww-company-card"><h2>{T.HEADING}</h2><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const { suggestions, source, revision, canChange } = read.data, known = suggestions === "on" || suggestions === "off";
 async function change(next: "on" | "off") {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const saved = await api.setCompanySettings({ expectedRevision: revision, suggestions: next });
   // The change's own answer is the new state, so a failed re-read cannot leave the old one on screen.
   query.setQueryData(companySettingsKey, saved);refocus.current = true;setConfirming(false);setMessage({ kind: "status", text: next === "on" ? T.SAVED_ON : T.SAVED_OFF, revision: saved.revision });
   await query.invalidateQueries({ queryKey: companySettingsKey });
  } catch (error) {
   refocus.current = true;setConfirming(false);
   if (error instanceof ApiError && error.code === "LEARNING_SETTINGS_CHANGED") { await query.invalidateQueries({ queryKey: companySettingsKey });setMessage({ kind: "alert", text: T.CHANGED }); }
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label={T.HEADING} className="rv-hww-company-card rv-hww-suggestions" aria-busy={busy}><h2>{T.HEADING}</h2>
  <p>Suggestions: <strong>{suggestions === "on" ? "On" : suggestions === "off" ? "Off" : "Unknown"}</strong>{source === "install_default" && <> <span className="rv-muted">{T.INSTALL_DEFAULT}</span></>}</p>
  <p className="rv-muted">{T.HELP}</p>
  {!canChange ? <p className="rv-muted">{T.READ_ONLY}</p> : known && <div ref={actions}>{confirming ? <div><p>{T.CONFIRM}</p><div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { void change("on"); }}>{T.TURN_ON}</Button><Button disabled={busy} onClick={() => { refocus.current = true;setConfirming(false); }}>{T.CANCEL}</Button></div></div>
   : <Button busy={busy} onClick={() => { if (suggestions === "on") void change("off"); else { setMessage(undefined);setConfirming(true); } }}>{suggestions === "on" ? T.TURN_OFF : T.TURN_ON}</Button>}</div>}
  <p role="status">{message?.kind === "status" && message.revision === revision ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} /></p>}
 </section>;
}
