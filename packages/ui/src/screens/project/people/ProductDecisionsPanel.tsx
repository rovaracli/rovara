import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { EmptyState } from "../../../design/EmptyState.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { decisionsKey, isStaleDecision, useProductDecisions, useProductDecisionsApi, type DecisionView } from "../../../api/product-decisions.js";
import { StaleNotice } from "./StaleNotice.js";
import { EMPTY_DECISIONS, PROJECT_PEOPLE_STALE_MESSAGE, RISK_WORDS, approveRefusalWords } from "./people-text.js";
import { failureText, isGone, useRequestId, useRestoreFocus } from "./people-write.js";
import "./people.css";

/**
 * The project's product decisions (`GET .../product-decisions`): a choice about wording, design or scope that a task raised, with its options, the answers so far and, once settled, who approved which option.
 * `you` is the server's word for what this reader may do: answer (a note; settles nothing) and approve one option, and when not, `approveRefusal` says why (shown in plain words). Nothing raises decisions yet, so
 * the list is usually empty and says so calmly. Every refusal and stale answer is shown as the server gave it.
 */
export function ProductDecisionsPanel({ project }: { project: string }) {
 const read = useProductDecisions(project);
 return <section className="rv-project-section rv-decisions" aria-labelledby="rv-decisions-title">
  <h2 id="rv-decisions-title">Product decisions</h2>
  {read.isPending ? <Skeleton label="Loading product decisions" /> : read.isError ? <><p role="alert">{isGone(read.error) ? "Product decisions aren't available for this project." : "Couldn't load the product decisions."}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : read.data.length === 0 ? <EmptyState title={EMPTY_DECISIONS.title} description={EMPTY_DECISIONS.description} />
   : <ul className="rv-decision-list">{read.data.map(decision => <li key={decision.decisionId}><DecisionItem project={project} decision={decision} /></li>)}</ul>}
 </section>;
}

/**
 * One decision. A write is fenced by the revision the page showed WHEN THE PERSON STARTED: an approval asks first (the question holds the revision it was asked under), and an answer holds the revision of the moment
 * the first word was typed. A list refetch while either is open changes what is shown behind it, never what is sent. A stale answer keeps the typed answer and offers "Discard my changes and reload".
 */
function DecisionItem({ project, decision }: { project: string; decision: DecisionView }) {
 const api = useProductDecisionsApi(), query = useQueryClient(), id = useRequestId();
 const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<string>(), [stale, setStale] = useState(false);
 const [asking, setAsking] = useState<{ optionId: string; label: string; revision: number }>();
 const draftRevision = useRef<number | undefined>(undefined), focus = useRestoreFocus(() => document.getElementById("decision-" + decision.decisionId));
 const open = decision.status === "open", refusal = open && !decision.you.canApprove ? approveRefusalWords(decision.you.approveRefusal) : undefined;
 async function run(work: () => Promise<unknown>, done: string, after?: () => void) {
  if (busy || stale) return;
  setBusy(true);setError(undefined);setSaved(undefined);
  try { await work();id.reset();setSaved(done);await query.invalidateQueries({ queryKey: decisionsKey(project) });after?.(); }
  catch (failure) { id.settle(failure);if (isStaleDecision(failure)) { setStale(true);setError(PROJECT_PEOPLE_STALE_MESSAGE);await query.invalidateQueries({ queryKey: decisionsKey(project) }); } else setError(failureText(failure)); }
  finally { setBusy(false); }
 }
 const discard = () => { setNote("");draftRevision.current = undefined;setAsking(undefined);setStale(false);setError(undefined);id.reset();void query.invalidateQueries({ queryKey: decisionsKey(project) }); };
 const heading = "decision-" + decision.decisionId;
 return <article className="rv-surface rv-decision" aria-labelledby={heading}>
  <p className="rv-muted rv-decision-meta"><span>{RISK_WORDS[decision.risk] ?? decision.risk}</span> · <span>{open ? "Waiting for a decision" : "Decided"}</span></p>
  <h3 id={heading} tabIndex={-1}><VisibleText text={decision.question} /></h3>
  {decision.approved !== undefined && (() => { const picked = decision.options.find(option => option.id === decision.approved!.optionId); return <p role="status"><strong>Approved:</strong> <VisibleText text={picked?.label ?? "an option"} /> by <VisibleText text={decision.approved.by.name} />.</p>; })()}
  <ul className="rv-decision-options">{decision.options.map(option => <li key={option.id}>
   <span className="rv-decision-option"><VisibleText text={option.label} /></span>
   {open && decision.you.canApprove && <Button variant="primary" busy={busy} aria-label={"Approve: " + option.label} onClick={event => { focus.remember(event.currentTarget);id.reset();setStale(false);setError(undefined);setAsking({ optionId: option.id, label: option.label, revision: decision.revision }); }}>Approve this</Button>}
  </li>)}</ul>
  {refusal !== undefined && <p role="note" className="rv-muted">{refusal}</p>}
  {decision.answers.length > 0 && <div className="rv-decision-answers"><h4>Answers so far</h4><ul>{decision.answers.map((answer, index) => <li key={String(index)}><strong><VisibleText text={answer.by.name} />:</strong> <VisibleText text={answer.text} /></li>)}</ul></div>}
  {open && decision.you.canAnswer && <form className="rv-people-form" onSubmit={event => { event.preventDefault();const revision = draftRevision.current;if (note.trim() === "" || revision === undefined) return;void run(async () => { await api.answer(project, decision.decisionId, { requestId: id.get(), expectedRevision: revision, text: note.trim() }); }, "Your answer was added.", () => { setNote("");draftRevision.current = undefined; }); }}>
   <TextArea label="Add your answer" hint="An answer is a note for the people deciding. It does not settle the decision." rows={3} maxLength={2000} value={note} onChange={event => { id.reset();if (event.target.value.trim() === "") draftRevision.current = undefined;else draftRevision.current ??= decision.revision;setNote(event.target.value); }} />
   <div className="rv-people-actions"><Button type="submit" busy={busy} disabled={stale || note.trim() === ""}>Add answer</Button></div>
  </form>}
  {asking === undefined && (stale && error !== undefined ? <StaleNotice message={error} onDiscard={discard} /> : error !== undefined && <p role="alert"><VisibleText text={error} /></p>)}
  {saved !== undefined && error === undefined && <p role="status">{saved}</p>}
  {asking !== undefined && <Dialog title="Approve this option?" open onCloseAutoFocus={focus.onCloseAutoFocus} onOpenChange={next => { if (!busy && !next) setAsking(undefined); }}>
   <div className="rv-people-form">
    <p>Approving settles this decision: <strong><VisibleText text={asking.label} /></strong>.</p>
    {stale && error !== undefined ? <StaleNotice message={error} onDiscard={discard} /> : error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
    <div className="rv-people-actions"><Button variant="primary" busy={busy} disabled={stale} onClick={() => { void run(() => api.approve(project, decision.decisionId, { requestId: id.get(asking.optionId), expectedRevision: asking.revision, optionId: asking.optionId }), "Approved.", () => { setAsking(undefined); }); }}>Approve</Button><Button disabled={busy} onClick={() => { setAsking(undefined); }}>Cancel</Button></div>
   </div>
  </Dialog>}
 </article>;
}
