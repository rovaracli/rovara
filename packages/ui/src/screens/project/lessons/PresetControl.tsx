import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lessonsKey, useLessonsApi, type LessonsView } from "../../../api/lessons.js";
import { Button } from "../../../design/Button.js";
import { T, failureText } from "./lessons-text.js";

/**
 * How lessons are approved here (the learning preset). Standard: a low-risk lesson from a team member's own correction goes live on trial. Regulated: every lesson waits for a person. A maintainer
 * can make the project stricter with one button; going back asks a different maintainer or admin to approve (the same rule as every loosening). A company that requires Regulated says so.
 */
export function PresetControl({ project, view }: { project: string; view: Pick<LessonsView, "preset" | "presetLockedByCompany" | "canDecide"> }) {
 const api = useLessonsApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<string>();
 async function change(to: "regulated" | "standard") {
  if (busy) return;
  setBusy(true);setError(undefined);setSaved(undefined);
  try {
   const answer = to === "regulated" ? await api.requirePerson(project) : await api.allowTrial(project);
   setSaved(to === "regulated" ? T.PRESET_SAVED : answer.needsApproval === true ? T.PRESET_ALLOW_ASKED : T.PRESET_ALLOW_DONE);
   await query.invalidateQueries({ queryKey: lessonsKey(project) });
  }
  catch (failure) { setError(failureText(failure, T.PRESET_FAILED)); }
  finally { setBusy(false); }
 }
 return <div className="rv-lessons-preset">
  <p>{view.preset === "regulated" ? T.PRESET_REGULATED : T.PRESET_STANDARD}{view.presetLockedByCompany && <span className="rv-muted"> {T.PRESET_COMPANY}</span>}</p>
  {view.preset === "standard" && view.canDecide && <Button busy={busy} onClick={() => { void change("regulated"); }}>{T.PRESET_REQUIRE}</Button>}
  {view.preset === "regulated" && view.canDecide && !view.presetLockedByCompany && <Button variant="quiet" busy={busy} onClick={() => { void change("standard"); }}>{T.PRESET_ALLOW}</Button>}
  {saved !== undefined && <p role="status">{saved}</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </div>;
}
