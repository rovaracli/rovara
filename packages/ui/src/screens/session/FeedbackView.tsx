import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createPlanPanelApi } from "../../api/plan-panel.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./plan-panel.css";

const NOTE_MAX = 2000;
const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const DECIDED: Record<string, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", DISMISS: "Dismissed" };

/** The check changes a finding's fix makes, as plain lines: the checks it retires and the commands it adds (each shown as code, never run here). */
function checkLines(changes: unknown): string[] {
 const entry = changes !== null && typeof changes === "object" ? changes as Record<string, unknown> : {};
 return [...strings(entry.obsolete).map(label => "Stops running: " + label), ...list(entry.added).map(check => {
  const command = check.command !== null && typeof check.command === "object" ? check.command as Record<string, unknown> : {};
  return "Adds " + str(check.label) + ": " + [str(command.executable), ...strings(command.args)].join(" ") + " (in " + str(command.cwd) + ")";
 })];
}

/**
 * OWNER DECISION 18: the PR feedback review on the task page, as the old `/review/<task>` page showed it: the findings, each with its comments, proposed fix or question for the owner, and check changes;
 * the failing CI checks; the pull requests. The owner approves the findings they choose, requests changes or dismisses it, through the same decision as the old page and Slack
 * (`submitWorkflowFeedbackDecision`); the server checks who may and every digest again.
 */
export default function FeedbackView({ taskId, onClose }: { taskId: string; onClose: () => void }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createPlanPanelApi(host), [host]);
 const read = useQuery({ queryKey: ["task-feedback", taskId], queryFn: () => api.feedback(taskId), retry: false });
 const [chosen, setChosen] = useState<Record<string, boolean>>({}), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const review = read.data;
 const findings = list(review?.findings), recommended = strings(review?.recommendedFindingIds);
 const pending = review?.status === "PENDING" && (review.reportStatus === undefined || review.reportStatus === "COMPLETE") && (review.workflowStatus === undefined || (review.workflowStatus === "WAITING" && review.workflowStage === "WAIT_FOR_MERGE"));
 const isChosen = (id: string) => chosen[id] ?? recommended.includes(id);
 const selected = findings.map(finding => str(finding.id)).filter(id => id !== "" && isChosen(id)), written = note.trim();
 async function decide(decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS", findingIds: string[]) {
  if (busy || review === undefined) return;
  setBusy(true);setError(undefined);setDone(undefined);
  try {
   await api.decideFeedback(taskId, { expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest, bundleDigests: review.bundleDigests,
    decision, selectedFindingIds: decision === "APPROVE" ? findingIds : [], ...(written === "" ? {} : { ownerNote: written }) });
   setDone(decision === "APPROVE" ? "Approved. Rovara updates the code; the checks and reviews run again after." : decision === "DISMISS" ? "Dismissed. No code changes start from this proposal." : "Changes requested. Rovara waits for your updated instructions.");
   setNote("");
   await Promise.all([query.invalidateQueries({ queryKey: ["task-feedback", taskId] }), query.invalidateQueries({ queryKey: ["session"] })]);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "This review changed. Close and open it again before deciding."); } finally { setBusy(false); }
 }
 const decision = review?.decision !== null && typeof review?.decision === "object" ? review.decision as Record<string, unknown> : undefined;
 const missing = read.error instanceof ApiError && read.error.status === 404;
 return <Dialog title={"PR feedback" + (review === undefined ? "" : " · " + str(review.title))} open onOpenChange={open => { if (!open) onClose(); }} className="rv-plan-panel" description="AI-generated advice on your pull request's review comments. Only your approval starts code changes.">
  <div className="rv-plan-panel-body">
   {read.isPending ? <Skeleton label="Loading the PR feedback review" />
    : missing ? <p>No PR feedback review is waiting on this task, or only its owner can see it.</p>
    : review === undefined ? <p role="alert">Couldn't load the PR feedback review. Close it and try again.</p>
    : <>
     {review.reportStatus !== undefined && review.reportStatus !== "COMPLETE" && <p><strong>The review didn't finish. Retry it from the task's Slack thread.</strong></p>}
     {decision !== undefined && !pending && <section aria-label="Recorded decision"><h3>Decision recorded: {DECIDED[str(decision.decision)] ?? "Decided"}</h3>{str(decision.ownerNote) !== "" && <p>Your note: <VisibleText text={str(decision.ownerNote)} /></p>}</section>}
     {str(review.nextAction) !== "" && <p><strong>Next:</strong> <VisibleText text={str(review.nextAction)} /></p>}
     {strings(review.ciFailures).length > 0 && <section aria-label="Failing checks"><h3>CI is failing</h3><p>These checks fail on the pull request: <VisibleText text={strings(review.ciFailures).join(", ")} />. Approving fixes them in the same round.</p></section>}
     <section aria-label="Findings"><h3>{findings.length === 1 ? "1 finding" : String(findings.length) + " findings"}</h3>
      {findings.map((finding, index) => {
       const id = str(finding.id) || "finding-" + String(index + 1), proposal = finding.fixProposal !== null && typeof finding.fixProposal === "object" ? finding.fixProposal as Record<string, unknown> : undefined;
       const question = finding.proposedDisposition === "OWNER_DECISION", lines = checkLines(finding.checkChanges), inputId = "feedback-" + id.replace(/[^A-Za-z0-9_-]/gu, "-");
       return <article key={id} className="rv-feedback-finding" aria-label={str(finding.priority) + " finding"}>
        <h4><VisibleText text={str(finding.priority) + " · " + str(finding.assessment)} /></h4>
        <p><VisibleText text={str(finding.rationale)} /></p>
        <p className="rv-muted">{recommended.includes(id) ? "Rovara recommends addressing this." : "Rovara does not recommend a code change for this item."}</p>
        {pending && !question && <p><input type="checkbox" id={inputId} checked={isChosen(id)} onChange={event => { const on = event.target.checked;setChosen(current => ({ ...current, [id]: on })); }} /> <label htmlFor={inputId}>Include this finding</label></p>}
        {proposal !== undefined && (question
         ? <section aria-label="Question for you"><h5>Question for you</h5><p><VisibleText text={str(proposal.summary)} /></p><p className="rv-muted">Answer it in your note with Request changes.</p></section>
         : <details><summary>Proposed fix, comments and evidence</summary><p><VisibleText text={str(proposal.summary)} /></p>
          <ul>{list(proposal.fileChanges).map((change, at) => <li key={at}><VisibleText text={str(change.operation) + " " + str(change.repositoryId) + "/" + str(change.path) + ": " + str(change.change)} /></li>)}</ul>
          {list(proposal.tests).length > 0 && <ul>{list(proposal.tests).map((test, at) => <li key={at}><VisibleText text={"Test " + str(test.operation) + " " + str(test.repositoryId) + "/" + str(test.path) + ": " + str(test.behavior)} /></li>)}</ul>}
          {lines.length > 0 && <><h5>Checks, if approved</h5><ul>{lines.map((line, at) => <li key={at}><code><VisibleText text={line} /></code></li>)}</ul></>}
          <ul>{list(finding.comments).map((comment, at) => <li key={at}><VisibleText text={str(comment.author) + ": " + str(comment.body)} /></li>)}</ul>
         </details>)}
       </article>;
      })}
     </section>
     {list(review.candidates).length > 0 && <section aria-label="Pull requests"><h3>Pull requests</h3><ul>{list(review.candidates).map((pr, at) => <li key={at}><VisibleText text={str(pr.repositoryId) + " #" + str(pr.number)} /></li>)}</ul></section>}
    </>}
  </div>
  <div className="rv-plan-panel-messages">{done !== undefined && <p role="status">{done}</p>}{error !== undefined && <p role="alert"><VisibleText text={error} /></p>}</div>
  {pending && <div className="rv-plan-panel-footer" role="region" aria-label="Decide">
   <label htmlFor="feedback-note">Note for Rovara (needed to request changes or dismiss)</label>
   <textarea id="feedback-note" maxLength={NOTE_MAX} value={note} onChange={event => setNote(event.target.value)} />
   <div className="rv-decision-actions">
    <Button variant="primary" busy={busy} disabled={selected.length === 0} onClick={() => { void decide("APPROVE", selected); }}>{selected.length === 1 ? "Approve 1 finding" : "Approve " + String(selected.length) + " findings"}</Button>
    <Button busy={busy} disabled={written === ""} onClick={() => { void decide("REQUEST_CHANGES", []); }}>Request changes</Button>
    <Button busy={busy} disabled={written === ""} onClick={() => { void decide("DISMISS", []); }}>Dismiss</Button>
   </div>
  </div>}
 </Dialog>;
}
