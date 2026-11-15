import { useState } from "react";
import type { ReadComment, ReadCriterion, ReadQuestion } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** One acceptance criterion: "WHEN ... THEN ...", with the plan tasks that build it, and the question it settles when it has one. */
export function CriterionRow({ criterion, question, answeredLabel, comment, onAnswer }: {
 criterion: ReadCriterion;
 /** An open question tied to this criterion; the row asks it in place. */
 question?: ReadQuestion | undefined;
 /** The option the person chose, once they answered: the row says so instead of asking again. */
 answeredLabel?: string | undefined;
 comment?: ReadComment | undefined;
 onAnswer?: ((questionId: string, optionId: string) => Promise<void>) | undefined;
}) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 const open = question !== undefined && answeredLabel === undefined && onAnswer !== undefined;
 async function answer(optionId: string) {
  if (question === undefined || onAnswer === undefined || busy) return;
  setBusy(true);setError(undefined);
  try { await onAnswer(question.questionId, optionId); } catch (failure) { setError(failure instanceof Error && failure.message !== "" ? failure.message : "Couldn't save your answer. Try again."); } finally { setBusy(false); }
 }
 const fallback = question?.options.find(option => option.optionId === question.defaultOptionId)?.label;
 return <div className={`rv-criterion${open ? " q" : ""}`} data-criterion={criterion.id}>
  <span className="rv-criterion-id">{criterion.id}</span>
  <span className="rv-criterion-text">
   <span><em>WHEN</em> <VisibleText text={criterion.when} /> <em>THEN</em> <VisibleText text={criterion.then} />.</span>
   {open && <span className="rv-criterion-question"><b>Question for you.</b> <VisibleText text={question.text} /><span className="rv-criterion-options">{question.options.map(option => <Button key={option.optionId} busy={busy} onClick={() => { void answer(option.optionId); }}>{option.label}</Button>)}</span>{fallback !== undefined && <span className="rv-muted rv-criterion-note">Leave it, and Rovara uses "{fallback}".</span>}</span>}
   {question !== undefined && answeredLabel !== undefined && <span className="rv-muted rv-criterion-note">You answered: <b><VisibleText text={answeredLabel} /></b></span>}
   {comment !== undefined && <span className="rv-muted rv-criterion-note">{comment.author}: "<VisibleText text={comment.text} />"{comment.resolved ? " · resolved" : ""}</span>}
   {error !== undefined && <span role="alert" className="rv-error rv-criterion-note" data-testid="answer-error"><VisibleText text={error} /></span>}
  </span>
  {criterion.taskIds.length > 0 && <span className="rv-id-chip link" aria-label={"Built by " + criterion.taskIds.join(", ")}>{criterion.taskIds.join(" · ")}</span>}
 </div>;
}
