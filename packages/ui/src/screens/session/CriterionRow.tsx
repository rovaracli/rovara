import { useEffect, useRef, useState } from "react";
import { PlanCriterionCommentAvailabilityView } from "./PlanCriterionCommentAvailabilityView.js";
import { ApiError } from "../../api/errors.js";
import type { ReadComment, ReadCriterion, ReadQuestion } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";

const COMMENT_MAX = 2000;

/** One comment of a thread; a reply sits under the comment it answers. */
function CommentLine({ comment, reply, onReply }: { comment: ReadComment; reply: boolean; onReply?: (() => void) | undefined }) {
 return <span className={`rv-criterion-comment${reply ? " reply" : ""}`} data-comment={comment.commentId}>
  <span className="rv-muted rv-criterion-note">{comment.author}: "<VisibleText text={comment.text} />"{comment.resolved ? " · resolved" : ""}{onReply !== undefined && !comment.resolved && <> <Button variant="quiet" className="rv-criterion-reply" aria-label={visibleText("Reply to " + comment.author)} onClick={onReply}>Reply</Button></>}</span>
 </span>;
}

/**
 * One acceptance criterion: "WHEN ... THEN ...", with the plan tasks that build it, the question it settles when it has one, and the comments pinned to it
 * (a thread: replies sit under the comment they answer). With `onComment` a person can comment on this passage or reply; a route that is not connected says so
 * in its own words and the draft stays.
 */
export function CriterionRow({ criterion, question, answeredLabel, comments = [], onAnswer, onComment }: {
 criterion: ReadCriterion;
 /** An open question tied to this criterion; the row asks it in place. */
 question?: ReadQuestion | undefined;
 /** The option the person chose, once they answered: the row says so instead of asking again. */
 answeredLabel?: string | undefined;
 /** Every comment pinned to this criterion, oldest first. */
 comments?: readonly ReadComment[] | undefined;
 onAnswer?: ((questionId: string, optionId: string) => Promise<void>) | undefined;
 onComment?: ((anchor: string, text: string, replyTo?: string) => Promise<void>) | undefined;
}) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 const [writing, setWriting] = useState<{ replyTo?: string }>(), [draft, setDraft] = useState(""), [sending, setSending] = useState(false), [commentError, setCommentError] = useState<unknown>();
 const open = question !== undefined && answeredLabel === undefined && onAnswer !== undefined;
 // Focus goes into the form when it opens and back to the button that opened it when it closes, so a keyboard user is never dropped on the page.
 const field = useRef<HTMLTextAreaElement>(null), opener = useRef<HTMLButtonElement>(null), wasWriting = useRef(false), isWriting = writing !== undefined;
 useEffect(() => {
  if (isWriting) field.current?.focus();
  else if (wasWriting.current) opener.current?.focus();
  wasWriting.current = isWriting;
 }, [isWriting]);
 async function answer(optionId: string) {
  if (question === undefined || onAnswer === undefined || busy) return;
  setBusy(true);setError(undefined);
  try { await onAnswer(question.questionId, optionId); } catch (failure) { setError(failure instanceof Error && failure.message !== "" ? failure.message : "Couldn't save your answer. Try again."); } finally { setBusy(false); }
 }
 async function send() {
  const text = draft.trim();
  if (onComment === undefined || writing === undefined || sending || text === "" || text.length > COMMENT_MAX) return;
  setSending(true);setCommentError(undefined);
  try { await onComment(criterion.id, text, writing.replyTo);setDraft("");setWriting(undefined); }
  catch (failure) { setCommentError(failure); }
  finally { setSending(false); }
 }
 const fallback = question?.options.find(option => option.optionId === question.defaultOptionId)?.label;
 const roots = comments.filter(comment => comment.replyTo === undefined || !comments.some(other => other.commentId === comment.replyTo));
 return <div className={`rv-criterion${open ? " q" : ""}`} data-criterion={criterion.id}>
  <span className="rv-criterion-id">{criterion.id}</span>
  <div className="rv-criterion-text">
   {criterion.when === "" ? <span><VisibleText text={criterion.then} /></span> : <span><em>WHEN</em> <VisibleText text={criterion.when} /> <em>THEN</em> <VisibleText text={criterion.then} />.</span>}
   {open && <span className="rv-criterion-question"><b>Question for you.</b> <VisibleText text={question.text} /><span className="rv-criterion-options">{question.options.map(option => <Button key={option.optionId} busy={busy} onClick={() => { void answer(option.optionId); }}>{option.label}</Button>)}</span>{fallback !== undefined && <span className="rv-muted rv-criterion-note">Leave it, and Rovara uses "{fallback}".</span>}</span>}
   {question !== undefined && answeredLabel !== undefined && <span className="rv-muted rv-criterion-note">You answered: <b><VisibleText text={answeredLabel} /></b></span>}
   {roots.map(root => <span key={root.commentId} className="rv-criterion-thread">
    <CommentLine comment={root} reply={false} onReply={onComment === undefined ? undefined : () => { setWriting({ replyTo: root.commentId });setCommentError(undefined); }} />
    {comments.filter(comment => comment.replyTo === root.commentId).map(reply => <CommentLine key={reply.commentId} comment={reply} reply />)}
   </span>)}
   {onComment !== undefined && writing === undefined && <span className="rv-criterion-note"><Button variant="quiet" ref={opener} className="rv-criterion-comment-open" aria-label={"Comment on " + criterion.id} onClick={() => { setWriting({});setCommentError(undefined); }}>Comment</Button></span>}
   {onComment !== undefined && writing !== undefined && <form className="rv-criterion-form" aria-label={"Comment on " + criterion.id} onSubmit={event => { event.preventDefault();void send(); }}>
    <label className="rv-visually-hidden" htmlFor={"comment-" + criterion.id}>{writing.replyTo === undefined ? "Comment on " : "Reply about "}{criterion.id}</label>
    <textarea ref={field} id={"comment-" + criterion.id} className="rv-input" rows={2} maxLength={COMMENT_MAX} value={draft} onChange={event => setDraft(event.target.value)} placeholder={writing.replyTo === undefined ? "Comment on " + criterion.id : "Reply"} />
    <span className="rv-criterion-form-actions"><Button type="submit" busy={sending} disabled={draft.trim() === ""}>Send</Button><Button variant="quiet" disabled={sending} onClick={() => { setWriting(undefined);setCommentError(undefined); }}>Cancel</Button></span>
   </form>}
   {commentError !== undefined && (commentError instanceof ApiError && commentError.status === 501 && commentError.code === "NOT_ON_CODE_YET"
    ? <PlanCriterionCommentAvailabilityView error={commentError} />
    : <span role="alert" className="rv-error rv-criterion-note" data-testid="comment-error"><VisibleText text={commentError instanceof Error && commentError.message !== "" ? commentError.message : "Couldn't save your comment. Your draft is still here. Try again."} /></span>)}
   {error !== undefined && <span role="alert" className="rv-error rv-criterion-note" data-testid="answer-error"><VisibleText text={error} /></span>}
  </div>
  {criterion.taskIds.length > 0 && <span className="rv-id-chip link" aria-label={"Built by " + criterion.taskIds.join(", ")}>{criterion.taskIds.join(" · ")}</span>}
 </div>;
}
