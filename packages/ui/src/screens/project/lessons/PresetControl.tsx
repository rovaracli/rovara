import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lessonsKey, useLessonsApi, type LessonsView } from "../../../api/lessons.js";
import { Button } from "../../../design/Button.js";
import { PresetProposalBox } from "./PresetProposalBox.js";
import { T, failureText } from "./lessons-text.js";

/**
 * How lessons are approved here (the learning preset). Standard: a low-risk lesson from a team member's own correction goes live on trial. Regulated: every lesson waits for a person. A maintainer
 * can make the project stricter with one button; going back asks a different maintainer or admin to approve (the same rule as every loosening), and that request is shown here with Approve and Cancel
 * for the people who decide. A company that requires Regulated says so.
 */
export function PresetControl({ project, view }: { project: string; view: Pick<LessonsView, "preset" | "presetLockedByCompany" | "canDecide" | "presetProposal"> }) {
 const api = useLessonsApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<string>();
 async function run(work: () => Promise<string>) {
  if (busy) return;
  setBusy(true);setError(undefined);setSaved(undefined);
  try { setSaved(await work());await query.invalidateQueries({ queryKey: lessonsKey(project) }); }
  catch (failure) { setError(failureText(failure, T.PRESET_FAILED));await query.invalidateQueries({ queryKey: lessonsKey(project) }).catch(() => undefined); }
  finally { setBusy(false); }
 }
 const change = (to: "regulated" | "standard") => run(async () => {
  const answer = to === "regulated" ? await api.requirePerson(project) : await api.allowTrial(project);
  return to === "regulated" ? T.PRESET_SAVED : answer.needsApproval === true ? T.PRESET_ALLOW_ASKED : T.PRESET_ALLOW_DONE;
 });
 // A request already waiting is shown with its own buttons (the box draws nothing for someone who cannot decide); asking again would only be refused.
 const waiting = !view.presetLockedByCompany && view.presetProposal !== undefined ? view.presetProposal : undefined;
 return <div className="rv-lessons-preset">
  <p>{view.preset === "regulated" ? T.PRESET_REGULATED : T.PRESET_STANDARD}{view.presetLockedByCompany && <span className="rv-muted"> {T.PRESET_COMPANY}</span>}</p>
  {view.preset === "standard" && view.canDecide && <Button busy={busy} onClick={() => { void change("regulated"); }}>{T.PRESET_REQUIRE}</Button>}
  {view.preset === "regulated" && view.canDecide && !view.presetLockedByCompany && waiting === undefined && <Button variant="quiet" busy={busy} onClick={() => { void change("standard"); }}>{T.PRESET_ALLOW}</Button>}
  {waiting !== undefined && <PresetProposalBox proposal={waiting} scope="project" canDecide={view.canDecide} busy={busy}
   onApprove={() => { void run(async () => { await api.approvePreset(project, waiting.changeId);return T.PRESET_APPROVED; }); }}
   onCancel={() => { void run(async () => { await api.cancelPreset(project, waiting.changeId);return T.PRESET_CANCELLED; }); }} />}
  {saved !== undefined && <p role="status">{saved}</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </div>;
}
