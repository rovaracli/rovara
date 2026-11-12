// The task page's review card (lane exp/review-groups, switch: review-flags.ts). This whole file is a lazy chunk: with the switch off, none of it is downloaded.
// It shows who holds the claim on the review that waits, how GitHub took it, how long it has waited and what the caller may do (Claim, Release, Reassign, each only when the server's own flag says so).
// A claim never grants approval: the server's `approvalNote` is always on the card. Every action names the claim's revision and the review's key; a stale answer reloads the card; a refusal is shown as the server worded it.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { taskReviewKey, useReviewApi, useReviewGroups, useTaskReview, type TaskReviewView } from "../../api/review-groups.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { agedWords, hostSyncHint, hostSyncWords } from "./review-text.js";
import "./reviews.css";

type Action = "claim" | "release" | "reassign";
const FAILED = "Couldn't complete this. Try again.";
const message = (problem: unknown): string => (problem instanceof ApiError ? problem.message : FAILED);
const DONE: Record<Action, string> = { claim: "You claimed this review.", release: "You released this review. It is back with the group.", reassign: "This review was reassigned." };

export function TaskReviewCard({ taskId, project }: { taskId: string; project: string }) {
 const api = useReviewApi(), query = useQueryClient(), read = useTaskReview(taskId), view = read.data;
 const [open, setOpen] = useState<Action>(), [busy, setBusy] = useState(false), [dialogError, setDialogError] = useState<string>(), [cardError, setCardError] = useState<string>(), [done, setDone] = useState<string>();
 const [groupId, setGroupId] = useState(""), [target, setTarget] = useState("");
 const requestId = useRef<string | undefined>(undefined), sending = useRef(false), heading = useRef<HTMLHeadingElement>(null), refocus = useRef(false);
 const groups = useReviewGroups(project, open === "reassign");
 useEffect(() => { if (refocus.current && open === undefined) { refocus.current = false;heading.current?.focus(); } }, [open, view]);
 if (read.isPending) return null;
 if (view === undefined) {
  if (read.error instanceof ApiError && read.error.status === 404) return null;
  return <section className="rv-review-card" aria-labelledby="rv-review-card-title"><h2 id="rv-review-card-title">Review</h2><p role="alert"><VisibleText text={message(read.error)} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 }
 const claim = view.claim;
 // Nothing waits, nobody holds it and it was not just handed back: there is nothing to say about this task's review.
 if (!view.waiting && claim === undefined && view.returned !== true && done === undefined) return null;
 const begin = (action: Action) => {
  requestId.current = crypto.randomUUID();setDialogError(undefined);setCardError(undefined);setDone(undefined);setTarget("");
  setGroupId(action === "claim" ? (view.claimableGroups.length === 1 ? view.claimableGroups[0]!.groupId : "") : action === "reassign" ? (claim?.groupId ?? "") : "");setOpen(action);
 };
 const close = () => { if (!busy) setOpen(undefined); };
 async function send(action: Action, current: TaskReviewView) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setDialogError(undefined);
  try {
   requestId.current ??= crypto.randomUUID();
   const base = { requestId: requestId.current, expectedRevision: current.revision };
   const answer = action === "release" ? await api.release(taskId, base) : action === "claim" ? await api.claim(taskId, { ...base, reviewKey: current.reviewKey!, groupId }) : await api.reassign(taskId, { ...base, reviewKey: current.reviewKey!, groupId, to: target });
   query.setQueryData(taskReviewKey(taskId), answer);requestId.current = undefined;refocus.current = true;setDone(DONE[action]);setOpen(undefined);
  } catch (problem) {
   // A refused or stale request is over; a fresh one is sent the next time. A lost connection keeps its id so a repeat is the same request.
   if (problem instanceof ApiError && problem.status > 0) requestId.current = undefined;
   if (problem instanceof ApiError && problem.code === "CHANGE_STALE") { refocus.current = true;setCardError(problem.message);setOpen(undefined);await query.invalidateQueries({ queryKey: taskReviewKey(taskId) }); }
   else setDialogError(message(problem));
  } finally { sending.current = false;setBusy(false); }
 }
 const mayClaim = view.canClaim && view.reviewKey !== undefined && view.claimableGroups.length > 0, mayReassign = view.canReassign && view.reviewKey !== undefined;
 const reassignGroups = claim === undefined ? (groups.data?.groups ?? []) : (groups.data?.groups ?? []).filter(group => group.groupId === claim.groupId);
 const reassignGroup = reassignGroups.find(group => group.groupId === groupId);
 const reassignOptions = (reassignGroup?.members ?? []).filter(member => member.eligible && member.developerId !== claim?.developerId).map(member => ({ value: member.developerId, label: member.name }));
 const footer = (action: Action, label: string, ready: boolean) => <div className="rv-actions"><Button disabled={busy} onClick={close}>Not now</Button><Button variant="primary" busy={busy} disabled={!ready} onClick={() => { void send(action, view); }}>{label}</Button></div>;
 const note = <p className="rv-review-note" role="note"><VisibleText text={view.approvalNote} /></p>;
 const problem = dialogError === undefined ? null : <p role="alert"><VisibleText text={dialogError} /></p>;
 return <section className="rv-review-card" aria-labelledby="rv-review-card-title">
  <h2 id="rv-review-card-title" ref={heading} tabIndex={-1}>Review</h2>
  <p className="rv-review-state">{view.waiting ? <>Waiting for review{view.waitingSince !== undefined && <>, since <RelativeTime at={view.waitingSince} /></>}.</> : "Nothing is waiting for review now."}{view.aged && <> <span className="rv-review-aged">{agedWords(view.ageHours)}</span></>}</p>
  {view.pullRequests.length > 0 && <ul className="rv-review-prs" aria-label="Pull requests waiting for review">{view.pullRequests.map(pull => <li key={pull.repositoryId + "#" + String(pull.number)}><VisibleText text={pull.repositoryId + " #" + String(pull.number)} /></li>)}</ul>}
  {claim !== undefined ? <div className="rv-review-claim"><p>Claimed by <strong><VisibleText text={claim.name} /></strong> for the <strong><VisibleText text={claim.groupName} /></strong> group, <RelativeTime at={claim.claimedAt} />.</p><p className="rv-review-sync" title={hostSyncHint(claim.hostSync)}><span className="rv-review-sync-words">{hostSyncWords(claim.hostSync)}</span>. <span className="rv-muted">{hostSyncHint(claim.hostSync)}</span></p></div> : view.waiting && <p className="rv-muted">Nobody has claimed this review yet.</p>}
  {view.returned === true && claim === undefined && <p className="rv-review-returned" role="note">This review went back to the group: the person who claimed it left the group or the project.</p>}
  <div className="rv-review-actions">
   {mayClaim && <Dialog title="Claim this review?" description="You become the requested reviewer on GitHub, and the group sees the review is yours." open={open === "claim"} onOpenChange={value => { if (value) begin("claim");else close(); }} trigger={<Button variant="primary">Claim review</Button>}>
    <Select label="Claim through which group?" value={groupId} onValueChange={setGroupId} placeholder="Choose a group" options={view.claimableGroups.map(group => ({ value: group.groupId, label: group.name }))} />
    {note}{problem}{footer("claim", "Claim", groupId !== "")}
   </Dialog>}
   {view.canRelease && <Dialog title="Release this review?" description={claim === undefined ? "It goes back to the group." : "It goes back to the " + claim.groupName + " group for someone else to claim."} open={open === "release"} onOpenChange={value => { if (value) begin("release");else close(); }} trigger={<Button>Release</Button>}>
    {note}{problem}{footer("release", "Release", true)}
   </Dialog>}
   {mayReassign && <Dialog title="Reassign this review" description="Give the review to another person in the group." open={open === "reassign"} onOpenChange={value => { if (value) begin("reassign");else close(); }} trigger={<Button>Reassign</Button>}>
    {groups.isPending ? <p className="rv-muted" role="status">Loading the group's people</p> : groups.isError ? <p role="alert"><VisibleText text={message(groups.error)} /></p> : <>
     {claim === undefined && <Select label="Which group?" value={groupId} onValueChange={value => { setGroupId(value);setTarget(""); }} placeholder="Choose a group" options={reassignGroups.map(group => ({ value: group.groupId, label: group.name }))} />}
     {claim !== undefined && <p>Group: <strong><VisibleText text={claim.groupName} /></strong></p>}
     <Select label="Reassign to" value={target} onValueChange={setTarget} placeholder={reassignGroup === undefined ? "Choose a group first" : reassignOptions.length === 0 ? "Nobody else is in this group" : "Choose a person"} disabled={reassignGroup === undefined || reassignOptions.length === 0} options={reassignOptions} />
    </>}
    {note}{problem}{footer("reassign", "Reassign", groupId !== "" && target !== "")}
   </Dialog>}
  </div>
  {done !== undefined && <p role="status"><VisibleText text={done} /></p>}
  {cardError !== undefined && <p role="alert"><VisibleText text={cardError} /> <Button variant="quiet" onClick={() => { setCardError(undefined);void read.refetch(); }}>Reload</Button></p>}
  {note}
 </section>;
}
