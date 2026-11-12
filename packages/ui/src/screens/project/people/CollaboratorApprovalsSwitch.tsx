import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { approvalsKey, isStaleDecision, useCollaboratorApprovals, useProductDecisionsApi } from "../../../api/product-decisions.js";
import { StaleNotice } from "./StaleNotice.js";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "./people-text.js";
import { failureText, isGone, useRequestId, useRestoreFocus } from "./people-write.js";

/**
 * The project's collaborator-approvals switch (`PUT .../collaborator-approvals`, browser-only): whether a collaborator may approve LOW-risk product decisions here. On by default. The server says who may change it
 * (`canChange`). Pressing the switch asks first, and the question is fenced by the revision the page showed WHEN IT WAS ASKED (a refetch while it is open never changes it); a stale answer says so, reloads the state
 * behind it and offers "Discard my changes and reload". Everyone who can see the project reads the state.
 */
export function CollaboratorApprovalsSwitch({ project }: { project: string }) {
 const read = useCollaboratorApprovals(project), box = useRef<HTMLDivElement>(null), focus = useRestoreFocus(() => document.getElementById("rv-people-approvals-title"));
 const [asking, setAsking] = useState<{ enabled: boolean; revision: number }>();
 return <section className="rv-project-section rv-people-approvals" aria-labelledby="rv-people-approvals-title">
  <h2 id="rv-people-approvals-title" tabIndex={-1}>Collaborator approvals</h2>
  {read.isPending ? <Skeleton label="Loading collaborator approvals" /> : read.isError ? (isGone(read.error) ? <p role="note">This setting isn't available for this project.</p> : <><p role="alert">Couldn't load this setting.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>)
   : <>
    <p>Collaborators can approve low-risk product decisions, such as wording or a design option, while this is on. Anything medium or high risk, and every coding plan and merge, still needs a maintainer or the task's owner.</p>
    {read.data.canChange ? <div ref={box}><Switch label="Let collaborators approve low-risk product decisions" checked={read.data.enabled} onCheckedChange={enabled => { focus.remember(box.current?.querySelector("button") ?? null);setAsking({ enabled, revision: read.data.revision }); }} /></div>
     : <p role="note">{read.data.enabled ? "On" : "Off"}. Only a project maintainer can change this.</p>}
    {asking !== undefined && <ApprovalsQuestion project={project} asking={asking} onCloseAutoFocus={focus.onCloseAutoFocus} onClose={() => { setAsking(undefined); }} />}
   </>}
 </section>;
}

function ApprovalsQuestion({ project, asking, onClose, onCloseAutoFocus }: { onCloseAutoFocus: (event: Event) => void; project: string; asking: { enabled: boolean; revision: number }; onClose: () => void }) {
 const api = useProductDecisionsApi(), query = useQueryClient(), id = useRequestId(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [stale, setStale] = useState(false);
 async function confirm() {
  if (busy || stale) return;
  setBusy(true);setError(undefined);
  try { await api.setApprovals(project, { requestId: id.get(), enabled: asking.enabled, expectedRevision: asking.revision });id.reset();await query.invalidateQueries({ queryKey: approvalsKey(project) });onClose(); }
  catch (failure) { id.settle(failure);if (isStaleDecision(failure)) { setStale(true);setError(PROJECT_PEOPLE_STALE_MESSAGE);await query.invalidateQueries({ queryKey: approvalsKey(project) }); } else setError(failureText(failure)); }
  finally { setBusy(false); }
 }
 return <Dialog title={asking.enabled ? "Let collaborators approve?" : "Stop collaborators approving?"} open onCloseAutoFocus={onCloseAutoFocus} onOpenChange={next => { if (!busy && !next) onClose(); }}>
  <div className="rv-people-form">
   <p>{asking.enabled ? "Collaborators will be able to approve low-risk product decisions on this project." : "Collaborators will no longer be able to approve product decisions on this project. They can still answer questions and comment."}</p>
   {stale && error !== undefined ? <StaleNotice message={error} onDiscard={onClose} /> : error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button variant="primary" busy={busy} disabled={stale} onClick={() => { void confirm(); }}>{asking.enabled ? "Turn on" : "Turn off"}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
  </div>
 </Dialog>;
}
