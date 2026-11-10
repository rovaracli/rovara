import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { localToolsKey, useLocalTools, useLocalToolsApi } from "../../../api/lessons-local-tools.js";
import { Button } from "../../../design/Button.js";

const W = {
 TITLE: "Lessons in coding tools", WHY: "Your team's own coding tools (Claude Code, Codex, Cursor) can ask Rovara for the lessons that apply to a repository before they plan or write code. They get only lessons every member of the project may read, and only lessons that earned trust. Nothing is kept on their computers by Rovara, and a lesson you erase is gone on their next ask.",
 ON: "On: coding tools can fetch this project's lessons.", OFF: "Off: coding tools get no lessons from this project.",
 COMPANY: "Your company keeps lessons inside Rovara, so coding tools get none. An owner or admin can change that on the company How we work page.", REGULATED: "This project uses the Regulated preset, which keeps lessons out of coding tools.",
 TURN_ON: "Turn on for this project", TURN_OFF: "Turn off for this project", FAILED: "Couldn't read this setting. Try again.", TRY_AGAIN: "Try again", CHANGE_FAILED: "Couldn't change that. Try again.", NOT_ALLOWED: "A maintainer of this project can change this.", SAVED: "Saved.",
} as const;
const failure = (error: unknown): string => (error instanceof ApiError && error.code === "FORBIDDEN" ? W.NOT_ALLOWED : W.CHANGE_FAILED);

/** Whether coding tools get this project's lessons (decision 46b). Anyone on the project sees what it comes to and why; a maintainer switches the project's own choice. An installation without the setting shows nothing. */
export function LocalToolsControl({ project, canChange }: { project: string; canChange: boolean }) {
 const read = useLocalTools(project), api = useLocalToolsApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 if (read.isPending) return null;
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return null;
 if (read.isError || read.data === undefined) return <section className="rv-lessons-local" aria-label={W.TITLE}><h2>{W.TITLE}</h2><p role="alert">{W.FAILED}</p><Button onClick={() => { void read.refetch(); }}>{W.TRY_AGAIN}</Button></section>;
 const state = read.data;
 // The project's own choice, as a button: on when it is not "on" and the preset or the company is not what blocks it.
 const blocked = state.reason === "company_stays" || state.reason === "regulated";
 async function set(enabled: boolean) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);setSaved(false);
  try { await api.setProject(project, enabled);setSaved(true);await query.invalidateQueries({ queryKey: localToolsKey(project) }); }
  catch (cause) { setError(failure(cause));await query.invalidateQueries({ queryKey: localToolsKey(project) }).catch(() => undefined); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-lessons-local" aria-label={W.TITLE} aria-busy={busy}>
  <h2>{W.TITLE}</h2>
  <p className="rv-muted">{W.WHY}</p>
  <p role="status">{state.enabled ? W.ON : W.OFF}</p>
  {state.reason === "company_stays" && <p role="note" className="rv-muted">{W.COMPANY}</p>}
  {state.reason === "regulated" && <p role="note" className="rv-muted">{W.REGULATED}</p>}
  {canChange && !blocked && <div className="rv-lessons-actions">{state.enabled
   ? <Button variant="secondary" busy={busy} onClick={() => { void set(false); }}>{W.TURN_OFF}</Button>
   : <Button variant="primary" busy={busy} onClick={() => { void set(true); }}>{W.TURN_ON}</Button>}</div>}
  {!canChange && <p className="rv-muted">{W.NOT_ALLOWED}</p>}
  {saved && <p role="status">{W.SAVED}</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </section>;
}
