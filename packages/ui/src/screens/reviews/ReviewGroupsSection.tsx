// The project page's "Review groups" section (lane exp/review-groups, switch: review-flags.ts). This whole file is a lazy chunk: with the switch off, none of it is downloaded.
// Everyone who can see the project sees the groups. A maintainer (the server's `canManage`) edits them: add, rename and remove groups, add and remove people from the project's contributors and maintainers,
// then Save sends the whole list under the revision read. A refusal is shown as the server worded it; a stale answer reloads the list.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { REVIEW_CLAIM_APPROVAL_NOTE } from "@agentx/cloud-contracts/web";
import { ApiError } from "../../api/errors.js";
import { reviewGroupsKey, useReviewApi, useReviewCandidates, useReviewGroups, type ReviewGroupsView } from "../../api/review-groups.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { GROUPS_EMPTY, GROUPS_EMPTY_CAN_MANAGE, GROUPS_INTRO, GROUPS_LIMITS, INELIGIBLE_SAVE_NOTE, NO_LONGER_CONTRIBUTOR } from "./review-text.js";
import { canAddGroup, canAddMember, draftBody, draftChanged, draftFromView, draftProblems, nameProblem, newDraftGroup, type DraftGroup } from "./review-groups-draft.js";
import "./reviews.css";

const failure = (problem: unknown): string => (problem instanceof ApiError ? problem.message : "Couldn't save the review groups. Try again.");

function Members({ group }: { group: ReviewGroupsView["groups"][number] }) {
 return group.members.length === 0 ? <p className="rv-muted">Nobody is in this group yet.</p> : <ul className="rv-review-members">{group.members.map(member => <li key={member.developerId} data-eligible={member.eligible ? "yes" : "no"}><VisibleText text={member.name} />{!member.eligible && <span className="rv-review-gone"> ({NO_LONGER_CONTRIBUTOR})</span>}</li>)}</ul>;
}

export function ReviewGroupsSection({ project }: { project: string }) {
 const api = useReviewApi(), query = useQueryClient(), read = useReviewGroups(project);
 const [draft, setDraft] = useState<DraftGroup[]>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 const requestId = useRef<string | undefined>(undefined), sending = useRef(false), root = useRef<HTMLElement>(null), focus = useRef<string | undefined>(undefined);
 const setFocus = (name: string) => { focus.current = name; };
 const editing = draft !== undefined, view = read.data;
 const candidates = useReviewCandidates(project, editing);
 useEffect(() => {
  // Every move that asks for focus also changes state, so this runs after the screen it names is drawn; it takes the request once.
  const wanted = focus.current;if (wanted === undefined) return;
  focus.current = undefined;root.current?.querySelector<HTMLElement>(`[data-focus="${wanted}"]`)?.focus();
 });
 const change = (next: DraftGroup[], focusOn?: string) => { requestId.current = undefined;setSaved(false);setDraft(next);if (focusOn !== undefined) setFocus(focusOn); };
 const edit = (at: number, update: (group: DraftGroup) => DraftGroup, focusOn?: string) => change(draft!.map((group, index) => (index === at ? update(group) : group)), focusOn);
 async function save() {
  if (sending.current || draft === undefined || view === undefined || draftProblems(draft).length > 0) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   requestId.current ??= crypto.randomUUID();
   const answer = await api.saveGroups(project, draftBody(draft, requestId.current, view.revision));
   query.setQueryData(reviewGroupsKey(project), answer);requestId.current = undefined;setDraft(undefined);setSaved(true);setFocus("edit");
  } catch (problem) {
   if (problem instanceof ApiError && problem.status > 0) requestId.current = undefined;
   setError(failure(problem));
   // A stale answer means the list moved under this draft: show the latest and let the person make the change again.
   if (problem instanceof ApiError && problem.code === "CHANGE_STALE") { setDraft(undefined);await query.invalidateQueries({ queryKey: reviewGroupsKey(project) }); }
  } finally { sending.current = false;setBusy(false); }
 }
 const stop = () => { requestId.current = undefined;setDraft(undefined);setError(undefined);setFocus("edit"); };
 let body;
 if (read.isPending) body = <Skeleton label="Loading review groups" />;
 else if (view === undefined) body = <><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load the review groups. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>;
 else if (!editing) body = <>
  {view.groups.length === 0 ? <p className="rv-muted">{GROUPS_EMPTY}{view.canManage ? " " + GROUPS_EMPTY_CAN_MANAGE : ""}</p> : <ul className="rv-review-group-list">{view.groups.map(group => <li key={group.groupId}><h3><VisibleText text={group.name} /></h3><Members group={group} /></li>)}</ul>}
  {view.canManage && <div className="rv-review-actions"><Button data-focus="edit" onClick={() => { setError(undefined);setSaved(false);requestId.current = undefined;setDraft(draftFromView(view));setFocus(view.groups.length === 0 ? "add-group" : "name-0"); }}>{view.groups.length === 0 ? "Add a group" : "Edit groups"}</Button></div>}
 </>;
 else {
  const problems = draftProblems(draft), dirty = draftChanged(draft, view), gone = draft.some(group => group.members.some(member => !member.eligible));
  body = <form className="rv-review-editor" onSubmit={event => { event.preventDefault();void save(); }} noValidate>
   <p className="rv-muted">{GROUPS_LIMITS}</p>
   {draft.map((group, index) => {
    const label = group.name.trim() === "" ? "group " + String(index + 1) : group.name.trim(), chosen = new Set(group.members.map(member => member.developerId));
    const options = (candidates.data ?? []).filter(person => !chosen.has(person.developerId)).map(person => ({ value: person.developerId, label: person.name }));
    return <fieldset key={group.key} className="rv-review-edit-group"><legend>Group {index + 1}</legend>
     <TextField label="Name" value={group.name} data-focus={"name-" + String(index)} onChange={event => edit(index, old => ({ ...old, name: event.target.value }))} {...(group.name.trim() === "" || nameProblem(draft, index) === undefined ? {} : { error: nameProblem(draft, index)! })} autoComplete="off" />
     {group.members.length > 0 && <ul className="rv-review-members">{group.members.map(member => <li key={member.developerId} data-eligible={member.eligible ? "yes" : "no"}><span><VisibleText text={member.name} />{!member.eligible && <span className="rv-review-gone"> ({NO_LONGER_CONTRIBUTOR})</span>}</span><Button variant="quiet" aria-label={"Remove " + member.name + " from " + label} onClick={() => edit(index, old => ({ ...old, members: old.members.filter(other => other.developerId !== member.developerId) }), "pick-" + String(index))}>Remove</Button></li>)}</ul>}
     {candidates.isError ? <p role="alert"><VisibleText text={candidates.error instanceof ApiError ? candidates.error.message : "Couldn't load the project's people."} /></p> : <div data-focus={"pick-" + String(index)} tabIndex={-1}><Select label={"Add a person to " + label} value="" placeholder={candidates.isPending ? "Loading people" : canAddMember(group) ? "Choose a person" : "This group is full"} disabled={candidates.isPending || !canAddMember(group) || options.length === 0} options={options} onValueChange={value => { const person = (candidates.data ?? []).find(other => other.developerId === value);if (person !== undefined) edit(index, old => ({ ...old, members: [...old.members, { developerId: person.developerId, name: person.name, eligible: true }] })); }} /></div>}
     <Button variant="quiet" aria-label={"Remove group " + label} onClick={() => change(draft.filter((_, at) => at !== index), "add-group")}>Remove group</Button>
    </fieldset>;
   })}
   {gone && <p className="rv-muted">{INELIGIBLE_SAVE_NOTE}</p>}
   {draft.some(group => group.name.trim() === "") && <p className="rv-muted">Give every group a name to save.</p>}
   <div className="rv-review-actions"><Button data-focus="add-group" disabled={!canAddGroup(draft)} onClick={() => change([...draft, newDraftGroup()], "name-" + String(draft.length))}>Add a group</Button></div>
   <div className="rv-review-actions"><Button type="submit" variant="primary" busy={busy} disabled={!dirty || problems.length > 0}>Save groups</Button><Button disabled={busy} onClick={stop}>Cancel</Button></div>
  </form>;
 }
 return <section ref={root} className="rv-review-groups" aria-labelledby="rv-review-groups-title"><h2 id="rv-review-groups-title">Review groups</h2>
  <p className="rv-muted">{GROUPS_INTRO}</p>
  <p className="rv-review-note" role="note">{REVIEW_CLAIM_APPROVAL_NOTE}</p>
  {body}
  {saved && <p role="status">Review groups saved.</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
