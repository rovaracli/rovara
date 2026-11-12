import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { isStale, peopleKey, useProjectPeopleApi, type PeopleMember } from "../../../api/project-people.js";
import { StaleNotice } from "./StaleNotice.js";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "./people-text.js";
import { failureText, useRequestId } from "./people-write.js";

/** Take a person's project role away (`DELETE .../people/{id}`), under the revision the page read WHEN THE DIALOG OPENED (the tab captures it then; a refetch while it is open never changes it). The server's refusal, the last-maintainer sentence included, is shown as it came. */
export function RemovePersonDialog({ project, revision, member, open, onOpenChange, onDone }: { project: string; revision: number; member: PeopleMember; open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void }) {
 const api = useProjectPeopleApi(), query = useQueryClient(), id = useRequestId(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [stale, setStale] = useState(false);
 async function remove() {
  if (busy || stale) return;
  setBusy(true);setError(undefined);
  try {
   const result = await api.remove(project, member.developerId, { requestId: id.get(), expectedRevision: revision });id.reset();
   await query.invalidateQueries({ queryKey: peopleKey(project) });
   onDone(result.removed ? member.name + " was removed from the project." : member.name + " had no project role to remove.");onOpenChange(false);
  } catch (failure) {
   id.settle(failure);
   if (isStale(failure)) { setStale(true);setError(PROJECT_PEOPLE_STALE_MESSAGE);await query.invalidateQueries({ queryKey: peopleKey(project) }); } else setError(failureText(failure));
  } finally { setBusy(false); }
 }
 return <Dialog title="Remove from project" open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
  <div className="rv-people-form">
   <p>Remove <strong><VisibleText text={member.name} /></strong> from this project? They stay in the company. Work they started keeps running.</p>
   {stale && error !== undefined ? <StaleNotice message={error} onDiscard={() => { onOpenChange(false); }} /> : error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button variant="danger" busy={busy} disabled={stale} onClick={() => { void remove(); }}>Remove from project</Button><Button disabled={busy} onClick={() => { onOpenChange(false); }}>Cancel</Button></div>
  </div>
 </Dialog>;
}
