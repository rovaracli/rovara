import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { approvalsKey, isStaleDecision, useCollaboratorApprovals, useProductDecisionsApi } from "../../../api/product-decisions.js";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "./people-text.js";
import { failureText, useRequestId } from "./people-write.js";

/**
 * The project's collaborator-approvals switch (`PUT .../collaborator-approvals`, browser-only): whether a collaborator may approve LOW-risk product decisions here. On by default. The server says who may change it
 * (`canChange`); a stale answer reloads it and says so. Everyone who can see the project reads the state.
 */
export function CollaboratorApprovalsSwitch({ project }: { project: string }) {
 const read = useCollaboratorApprovals(project), api = useProductDecisionsApi(), query = useQueryClient(), id = useRequestId();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function change(enabled: boolean) {
  if (busy || read.data === undefined) return;
  setBusy(true);setError(undefined);
  try { await api.setApprovals(project, { requestId: id.get(), enabled, expectedRevision: read.data.revision });id.reset();await query.invalidateQueries({ queryKey: approvalsKey(project) }); }
  catch (failure) { id.settle(failure);if (isStaleDecision(failure)) { setError(PROJECT_PEOPLE_STALE_MESSAGE);await query.invalidateQueries({ queryKey: approvalsKey(project) }); } else setError(failureText(failure)); }
  finally { setBusy(false); }
 }
 return <section className="rv-project-section rv-people-approvals" aria-labelledby="rv-people-approvals-title">
  <h2 id="rv-people-approvals-title">Collaborator approvals</h2>
  {read.isPending ? <Skeleton label="Loading collaborator approvals" /> : read.isError ? <><p role="alert">Couldn't load this setting.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : <>
    <p>Collaborators can approve low-risk product decisions, such as wording or a design option, while this is on. Anything medium or high risk, and every coding plan and merge, still needs a maintainer or the task's owner.</p>
    {read.data.canChange ? <Switch label="Let collaborators approve low-risk product decisions" checked={read.data.enabled} disabled={busy} onCheckedChange={enabled => { void change(enabled); }} />
     : <p role="note">{read.data.enabled ? "On" : "Off"}. Only a project maintainer can change this.</p>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   </>}
 </section>;
}
