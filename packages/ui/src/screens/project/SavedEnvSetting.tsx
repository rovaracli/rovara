import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { savedEnvKey, useSavedEnvApi } from "../../api/saved-env.js";
import { Button } from "../../design/Button.js";
import { Switch } from "../../design/Switch.js";
import { SETTING as S } from "./environment-panel-text.js";

/** Why a change was refused, in fixed words by code: no text of the server is shown. */
function refusal(error: unknown): string {
 if (error instanceof ApiError && (error.status === 403 || error.code === "FORBIDDEN")) return S.REFUSED;
 if (error instanceof ApiError && error.code === "CHANGE_STALE") return S.STALE;
 return S.FAILED;
}

/** What the control reads of the panel (the server's answer, with any newer words a reader keeps). */
export interface SavedEnvSettingView { enabled?: boolean | undefined; canChangeSetting?: boolean | undefined }

/**
 * SV-1l: the project's saved environment on or off, the same control in the setup checklist and the Saved environment section. One switch and one Save; the two lines of every setting say what a change
 * affects and who can change it. The control is offered when the server says the caller may change it (`canChangeSetting`); the server checks the maintainer role again on the write, so this only decides
 * what to show. A person who can't change it reads the value and is told who can. An older server that sends no `enabled` gets no control.
 */
export function SavedEnvSetting({ project, panel }: { project: string; panel: SavedEnvSettingView }) {
 const api = useSavedEnvApi(), query = useQueryClient(), sending = useRef(false);
 const [choice, setChoice] = useState<boolean>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<boolean>();
 if (panel.enabled === undefined) return null;
 const current = panel.enabled, picked = choice ?? current, canChange = panel.canChangeSetting === true;
 async function save() {
  if (sending.current || picked === current) return;
  sending.current = true;setBusy(true);setError(undefined);setSaved(undefined);
  try {
   const answer = await api.setEnabled(project, picked);
   query.setQueryData<SavedEnvSettingView>(savedEnvKey(project), old => old === undefined ? old : { ...old, enabled: answer.enabled });
   setChoice(undefined);setSaved(answer.enabled);
   void query.invalidateQueries({ queryKey: savedEnvKey(project) });
  } catch (caught) {
   setError(refusal(caught));
   if (caught instanceof ApiError && caught.code === "CHANGE_STALE") { setChoice(undefined);void query.invalidateQueries({ queryKey: savedEnvKey(project) }); }
  } finally { sending.current = false;setBusy(false); }
 }
 return <div className="rv-saved-env-setting" aria-busy={busy}>
  <aside className="rv-saved-env-note" aria-label="About the saved environment setting">
   <p><strong>What a change affects.</strong> {S.AFFECTS}</p>
   <p><strong>Who can change it.</strong> {S.WHO}</p>
   {!canChange && <p role="note">{S.WHY_NOT}</p>}
  </aside>
  {canChange ? <>
   <Switch label={S.LABEL} checked={picked} disabled={busy} onCheckedChange={value => { setChoice(value);setSaved(undefined);setError(undefined); }} />
   <div className="rv-saved-env-actions"><Button variant="primary" busy={busy} disabled={busy || picked === current} onClick={() => { void save(); }}>{S.SAVE}</Button></div>
  </> : <p>{S.LABEL + ": "}<strong>{current ? S.ON_WORD : S.OFF_WORD}</strong></p>}
  <p role="status">{saved === undefined ? "" : saved ? S.SAVED_ON : S.SAVED_OFF}</p>
  {error !== undefined && <p role="alert">{error}</p>}
 </div>;
}
