import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type CloudProjectRole } from "@agentx/cloud-contracts/web";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { Select } from "../../../design/Select.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { isStale, peopleKey, useCompanyMembers, useProjectPeopleApi, type PeopleMember } from "../../../api/project-people.js";
import { projectRoleLabel } from "../../admin/projects/labels.js";
import { StaleNotice } from "./StaleNotice.js";
import { ADD_UNAVAILABLE, PROJECT_PEOPLE_STALE_MESSAGE, ROLE_HELP } from "./people-text.js";
import { failureText, useRequestId } from "./people-write.js";

/** `revision`, `roles` and `people` are what the page read WHEN THE DIALOG OPENED (the tab captures them then): a refetch while it is open never changes what a save is fenced by. */
interface Common { project: string; revision: number; roles: readonly CloudProjectRole[]; open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void }
type Props = Common & ({ mode: "change"; member: PeopleMember } | { mode: "add"; people: readonly PeopleMember[] });

/** Change one person's role, or add a company member with a role. Both are the same write (`PUT .../people/{id}`) under the revision captured at open; the server's refusal (last maintainer, stale) is shown as it came, and a stale answer keeps the draft. */
export function PersonRoleDialog(props: Props) {
 const { project, revision, roles, open, onOpenChange, onDone } = props, api = useProjectPeopleApi(), query = useQueryClient(), id = useRequestId();
 const current = props.mode === "change" ? props.member.projectRole ?? props.member.role : undefined;
 const [role, setRole] = useState<string>(current ?? roles[roles.length - 1] ?? "viewer"), [who, setWho] = useState<string>(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [stale, setStale] = useState(false);
 const companyMembers = useCompanyMembers(open && props.mode === "add");
 const onProject = new Set(props.mode === "add" ? props.people.map(person => person.developerId) : []);
 const choices = (companyMembers.data?.members ?? []).filter(member => member.role === "member" && !onProject.has(member.developerId));
 const target = props.mode === "change" ? props.member.developerId : who;
 const options = roles.map(value => ({ value, label: projectRoleLabel[value] }));
 const chosen = roles.find(value => value === role);
 async function save() {
  if (busy || stale || target === "" || chosen === undefined) return;
  setBusy(true);setError(undefined);
  try {
   await api.setRole(project, target, { requestId: id.get(), role: chosen, expectedRevision: revision });id.reset();
   await query.invalidateQueries({ queryKey: peopleKey(project) });
   const name = props.mode === "change" ? props.member.name : choices.find(member => member.developerId === who)?.name ?? "The person";
   onDone(props.mode === "change" ? name + " is now " + projectRoleLabel[chosen].toLowerCase() + "." : name + " was added as " + projectRoleLabel[chosen].toLowerCase() + ".");onOpenChange(false);
  } catch (failure) {
   id.settle(failure);
   if (isStale(failure)) { setStale(true);setError(PROJECT_PEOPLE_STALE_MESSAGE);await query.invalidateQueries({ queryKey: peopleKey(project) }); } else setError(failureText(failure));
  } finally { setBusy(false); }
 }
 const discard = () => { onOpenChange(false); };
 const title = props.mode === "change" ? "Change role" : "Add a person";
 return <Dialog title={title} open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }} {...(props.mode === "change" ? {} : { description: "Add someone who is already in your company. To bring in someone new, invite them." })}>
  <form className="rv-people-form" onSubmit={event => { event.preventDefault();void save(); }}>
   {props.mode === "change" ? <p>Person: <strong><VisibleText text={props.member.name} /></strong></p>
    : companyMembers.isPending ? <p role="status">Loading your company's people</p>
    : companyMembers.isError ? <p role="alert">Couldn't load your company's people. <Button onClick={() => { void companyMembers.refetch(); }}>Try again</Button></p>
    : choices.length === 0 ? <p>{ADD_UNAVAILABLE}</p>
    : <Select label="Person" value={who} onValueChange={value => { id.reset();setWho(value); }} options={choices.map(member => ({ value: member.developerId, label: member.name }))} placeholder="Choose a person" />}
   <Select label="Role" value={role} onValueChange={value => { id.reset();setRole(value); }} options={options} />
   {chosen !== undefined && <p className="rv-muted">{ROLE_HELP[chosen]}</p>}
   {stale && error !== undefined ? <StaleNotice message={error} onDiscard={discard} /> : error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button type="submit" variant="primary" busy={busy} disabled={stale || target === "" || chosen === undefined || (props.mode === "change" && chosen === current)}>{props.mode === "change" ? "Save role" : "Add to project"}</Button><Button disabled={busy} onClick={() => { onOpenChange(false); }}>Cancel</Button></div>
  </form>
 </Dialog>;
}
