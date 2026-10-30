import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { learningKey, useLearningApi, type SettingsView } from "../../api/learning.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SETTINGS_TEXT as T, expiresText, settingsFailure, skippedUnlinkedText } from "./learning-text.js";

/** "Learn from PR review comments": off by default, turning it on needs a second person. Who may change it, whether the company locked it and who proposed what are the server's to say; this only sends, shows the answer and reads again. */
export function LearningSettings({ project, settings, canDecide, skippedUnlinked }: { project: string; settings: SettingsView; canDecide: boolean; skippedUnlinked: number }) {
 const api = useLearningApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [waiting, setWaiting] = useState(false), [failure, setFailure] = useState<string>(), [sole, setSole] = useState(false);
 const on = settings.prComments === "on" && !settings.locked, pending = settings.pendingProposal, revision = settings.revision, canWrite = canDecide && !settings.locked;
 const reread = () => query.invalidateQueries({ queryKey: learningKey(project) });
 /** One write at a time: the ref stops a second click before the screen has disabled the buttons. */
 async function run(write: () => Promise<void>) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setFailure(undefined);setWaiting(false);
  try { await write();await reread(); }
  catch (error) { const result = settingsFailure(error);setFailure(result.text);if (result.stale) await reread(); }
  finally { sending.current = false;setBusy(false); }
 }
 const change = (prComments: "on" | "off") => run(async () => { if (revision === undefined) return;const result = await api.changeSettings(project, { expectedRevision: revision, prComments });setWaiting(!result.applied); });
 const decide = (decision: "approve" | "decline") => run(async () => { await api.decideSettingsProposal(project, pending!.id, { decision, ...(sole ? { soleOwnerAcknowledged: true } : {}) });setSole(false); });
 const expires = pending?.expiresAt === undefined ? undefined : expiresText(pending.expiresAt);
 return <div className="rv-learning-settings" role="group" aria-label={T.LABEL}>
  <h3>{T.LABEL}</h3>
  <p className="rv-muted">{T.HELP}</p>
  <p><strong>{on ? T.STATE_ON : T.STATE_OFF}</strong></p>
  {settings.locked && <p>{T.LOCKED}</p>}
  {!settings.locked && pending !== undefined && <p role="status">{T.PENDING}</p>}
  {!settings.locked && expires !== undefined && <p className="rv-muted">{expires}</p>}
  {waiting && <p role="status">{T.WAITING}</p>}
  {on && skippedUnlinked > 0 && <p className="rv-muted">{skippedUnlinkedText(skippedUnlinked)}</p>}
  {canWrite && pending !== undefined && <>
   <label className="rv-learning-sole"><input type="checkbox" checked={sole} disabled={busy} onChange={event => setSole(event.target.checked)} />{T.SOLE_OWNER}</label>
   <div className="rv-learning-actions"><Button variant="primary" busy={busy} onClick={() => { void decide("approve"); }}>{T.APPROVE}</Button><Button busy={busy} onClick={() => { void decide("decline"); }}>{T.DECLINE}</Button></div>
  </>}
  {canWrite && pending === undefined && revision !== undefined && <div className="rv-learning-actions"><Button busy={busy} onClick={() => { void change(on ? "off" : "on"); }}>{on ? T.TURN_OFF : T.TURN_ON}</Button></div>}
  {!canDecide && !settings.locked && <p className="rv-muted">{T.READ_ONLY}</p>}
  {failure !== undefined && <p role="alert"><VisibleText text={failure} /></p>}
 </div>;
}
