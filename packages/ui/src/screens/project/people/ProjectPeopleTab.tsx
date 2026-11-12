import { useState } from "react";
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
import { NO_EDIT_NOTE, ROLE_HELP, sourceWords } from "./people-text.js";
import "./people.css";

/**
 * The project's People tab (switch `rovara.people` = "v2"): who is on the project and in what role, from `GET .../people`. What each control does is the server's word (`viewer`): add, change and remove need
 * `canManageMembers` and offer only `assignableRoles`; invite needs `canInvite` and offers only `invitableRoles`; merge rules change only with `canEditCodeSettings`. A person who is a maintainer because they
 * are a company owner or admin has no project role to change, so their row has no controls. Every write is under the roster's revision; a stale answer reloads it.
 */
export function ProjectPeopleTab({ project }: { project: string }) {
 const read = useProjectPeople(project), nav = useNav();
 const [dialog, setDialog] = useState<{ kind: "change" | "remove"; member: PeopleMember } | { kind: "add" } | { kind: "invite" }>(), [notice, setNotice] = useState<string>();
 if (read.isPending) return <Skeleton label="Loading the project's people" />;
 if (read.isError) return <section className="rv-project-section"><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this project's people."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const view = read.data, v = view.viewer, stale = read.isFetching && !read.isPending;
 // The powers carry the three-role floor (a collaborator reads there as a viewer); the roster row of this person has the exact role.
 const mine = view.members.find(person => person.developerId === nav.data?.me.developerId), myRole = mine?.projectRole ?? v.role;
 const open = (next: NonNullable<typeof dialog> | undefined) => { setDialog(next); };
 return <div className="rv-people">
  <section className="rv-project-section" aria-labelledby="rv-people-title">
   <h2 id="rv-people-title">People</h2>
   <p className="rv-muted">Everyone on this project and their role. Your role here: <strong>{projectRoleLabel[myRole]}</strong>.</p>
   {(v.canManageMembers || v.canInvite) && <div className="rv-people-actions">
    {v.canManageMembers && <Button onClick={() => { open({ kind: "add" }); }}>Add a person</Button>}
    {v.canInvite && <Button onClick={() => { open({ kind: "invite" }); }}>Invite into this project</Button>}
   </div>}
   {!v.canManageMembers && <p className="rv-muted">{NO_EDIT_NOTE}</p>}
   {notice !== undefined && <p role="status">{notice}</p>}
   {view.members.length === 0 ? <p>No one has a role on this project yet.</p> : <DataTable caption="People on this project" rows={view.members} rowKey={member => member.developerId} columns={[
    { key: "name", title: "Person", render: member => <VisibleText text={member.name} /> },
    { key: "role", title: "Role", render: member => projectRoleLabel[member.projectRole ?? member.role] },
    { key: "source", title: "How they're on it", render: member => sourceWords(member.source) },
    ...(v.canManageMembers ? [{ key: "actions", title: "Actions", render: (member: PeopleMember) => member.source === "grant"
     ? <span className="rv-people-row-actions"><Button disabled={stale} aria-label={"Change role for " + member.name} onClick={() => { open({ kind: "change", member }); }}>Change role</Button><Button variant="quiet" disabled={stale} aria-label={"Remove " + member.name + " from the project"} onClick={() => { open({ kind: "remove", member }); }}>Remove</Button></span>
     : <span className="rv-muted">Set by their company role</span> }] : []),
   ]} />}
   <details className="rv-people-roles"><summary>What each role can do</summary><dl>{(["maintainer", "contributor", "collaborator", "viewer"] as const).map(role => <div key={role}><dt>{projectRoleLabel[role]}</dt><dd>{ROLE_HELP[role]}</dd></div>)}</dl></details>
  </section>
  <MergeRulesSection project={project} canEdit={v.canEditCodeSettings} canConfirm={v.canConfirmSelfApproval} />
  <CollaboratorApprovalsSwitch project={project} />
  {dialog?.kind === "add" && <PersonRoleDialog mode="add" project={project} revision={view.revision} roles={v.assignableRoles} people={view.members} open onOpenChange={next => { if (!next) open(undefined); }} onDone={setNotice} />}
  {dialog?.kind === "change" && <PersonRoleDialog mode="change" member={dialog.member} project={project} revision={view.revision} roles={v.assignableRoles} open onOpenChange={next => { if (!next) open(undefined); }} onDone={setNotice} />}
  {dialog?.kind === "remove" && <RemovePersonDialog project={project} revision={view.revision} member={dialog.member} open onOpenChange={next => { if (!next) open(undefined); }} onDone={setNotice} />}
  {dialog?.kind === "invite" && <InviteToProjectDialog project={project} roles={v.invitableRoles} open onOpenChange={next => { if (!next) open(undefined); }} />}
 </div>;
}
