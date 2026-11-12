import { useState } from "react";
import { type CloudProjectRole } from "@agentx/cloud-contracts/web";
import { Button } from "../../../design/Button.js";
import { DataTable } from "../../../design/DataTable.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ApiError } from "../../../api/errors.js";
import { useNav } from "../../../api/nav.js";
import { useProjectPeople, type PeopleMember } from "../../../api/project-people.js";
import { projectRoleLabel } from "../../admin/projects/labels.js";
import { CollaboratorApprovalsSwitch } from "./CollaboratorApprovalsSwitch.js";
import { InviteToProjectDialog } from "./InviteToProjectDialog.js";
import { MergeRulesSection } from "./MergeRulesSection.js";
import { PersonRoleDialog } from "./PersonRoleDialog.js";
import { RemovePersonDialog } from "./RemovePersonDialog.js";
import { isGone, useRestoreFocus } from "./people-write.js";
import { NO_EDIT_NOTE, ROLE_HELP, sourceWords } from "./people-text.js";
import "./people.css";

/**
 * The project's People tab (switch `rovara.people` = "v2"): who is on the project and in what role, from `GET .../people`. What each control does is the server's word (`viewer`): add, change and remove need
 * `canManageMembers` and offer only `assignableRoles`; invite needs `canInvite` and offers only `invitableRoles`; merge rules change only with `canEditCodeSettings`. A person who is a maintainer because they
 * are a company owner or admin has no project role to change, so their row has no controls. Every write is under the roster's revision; a stale answer reloads it.
 */
/**
 * What an open dialog was opened under: the roster's revision and the powers as the page read them WHEN THE PERSON OPENED IT. A refetch (focus, a realtime reset) while it is open changes the page behind it, never
 * what a save is fenced by, so an old draft can never be saved over somebody else's newer change.
 */
type Opened = ({ kind: "change" | "remove"; member: PeopleMember } | { kind: "add" } | { kind: "invite" }) & { revision: number; assignable: readonly CloudProjectRole[]; invitable: readonly CloudProjectRole[]; people: readonly PeopleMember[] };
export function ProjectPeopleTab({ project }: { project: string }) {
 const read = useProjectPeople(project), nav = useNav(), focus = useRestoreFocus(() => document.getElementById("rv-people-title"));
 const [dialog, setDialog] = useState<Opened>(), [notice, setNotice] = useState<string>();
 if (read.isPending) return <Skeleton label="Loading the project's people" />;
 if (read.isError) return <section className="rv-project-section"><p role="alert">{isGone(read.error) ? "People isn't available for this project." : <VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this project's people."} />}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const view = read.data, v = view.viewer, stale = read.isFetching && !read.isPending;
 // The powers carry the three-role floor (a collaborator reads there as a viewer); the roster row of this person has the exact role.
 const mine = view.members.find(person => person.developerId === nav.data?.me.developerId), myRole = mine?.projectRole ?? v.role;
 const open = (opener: Element | null, next: ({ kind: "change" | "remove"; member: PeopleMember } | { kind: "add" } | { kind: "invite" }) | undefined) => { if (next !== undefined) focus.remember(opener);setDialog(next === undefined ? undefined : { ...next, revision: view.revision, assignable: v.assignableRoles, invitable: v.invitableRoles, people: view.members }); };
 return <div className="rv-people">
  <section className="rv-project-section" aria-labelledby="rv-people-title">
   <h2 id="rv-people-title" tabIndex={-1}>People</h2>
   <p className="rv-muted">Everyone on this project and their role. Your role here: <strong>{projectRoleLabel[myRole]}</strong>.</p>
   {(v.canManageMembers || v.canInvite) && <div className="rv-people-actions">
    {v.canManageMembers && <Button onClick={event => { open(event.currentTarget, { kind: "add" }); }}>Add a person</Button>}
    {v.canInvite && <Button onClick={event => { open(event.currentTarget, { kind: "invite" }); }}>Invite into this project</Button>}
   </div>}
   {!v.canManageMembers && <p className="rv-muted">{NO_EDIT_NOTE}</p>}
   {notice !== undefined && <p role="status">{notice}</p>}
   {view.members.length === 0 ? <p>No one has a role on this project yet.</p> : <DataTable caption="People on this project" rows={view.members} rowKey={member => member.developerId} columns={[
    { key: "name", title: "Person", render: member => <VisibleText text={member.name} /> },
    { key: "role", title: "Role", render: member => projectRoleLabel[member.projectRole ?? member.role] },
    { key: "source", title: "How they're on it", render: member => sourceWords(member.source) },
    ...(v.canManageMembers ? [{ key: "actions", title: "Actions", render: (member: PeopleMember) => member.source === "grant"
     ? <span className="rv-people-row-actions"><Button disabled={stale} aria-label={"Change role for " + member.name} onClick={event => { open(event.currentTarget, { kind: "change", member }); }}>Change role</Button><Button variant="quiet" disabled={stale} aria-label={"Remove " + member.name + " from the project"} onClick={event => { open(event.currentTarget, { kind: "remove", member }); }}>Remove</Button></span>
     : <span className="rv-muted">Set by their company role</span> }] : []),
   ]} />}
   <details className="rv-people-roles"><summary>What each role can do</summary><dl>{(["maintainer", "contributor", "collaborator", "viewer"] as const).map(role => <div key={role}><dt>{projectRoleLabel[role]}</dt><dd>{ROLE_HELP[role]}</dd></div>)}</dl></details>
  </section>
  <MergeRulesSection project={project} canEdit={v.canEditCodeSettings} canConfirm={v.canConfirmSelfApproval} />
  <CollaboratorApprovalsSwitch project={project} />
  {dialog?.kind === "add" && <PersonRoleDialog mode="add" project={project} revision={dialog.revision} roles={dialog.assignable} people={dialog.people} open onCloseAutoFocus={focus.onCloseAutoFocus} onOpenChange={next => { if (!next) open(null, undefined); }} onDone={setNotice} />}
  {dialog?.kind === "change" && <PersonRoleDialog mode="change" member={dialog.member} project={project} revision={dialog.revision} roles={dialog.assignable} open onCloseAutoFocus={focus.onCloseAutoFocus} onOpenChange={next => { if (!next) open(null, undefined); }} onDone={setNotice} />}
  {dialog?.kind === "remove" && <RemovePersonDialog project={project} revision={dialog.revision} member={dialog.member} open onCloseAutoFocus={focus.onCloseAutoFocus} onOpenChange={next => { if (!next) open(null, undefined); }} onDone={setNotice} />}
  {dialog?.kind === "invite" && <InviteToProjectDialog project={project} roles={dialog.invitable} open onCloseAutoFocus={focus.onCloseAutoFocus} onOpenChange={next => { if (!next) open(null, undefined); }} />}
 </div>;
}
