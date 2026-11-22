import { useLayoutEffect, useRef, useState } from "react";
import type { SessionEventReaderSchema, SessionMessageReaderSchema } from "@agentx/contracts/web";
import { TalkCommentProvenanceView } from "./TalkCommentProvenanceView.js";
import { TalkCommentEditRecoveryView } from "./TalkCommentEditRecoveryView.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { MessageDelivery } from "../../design/MessageDelivery.js";
import { HeldState } from "../../design/HeldState.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { clockTime } from "./task-time.js";
import { TalkAvatar, TalkKindChip, TalkLadder, deliveryLadder } from "./TalkParts.js";
type ReadMessage = ReturnType<typeof SessionMessageReaderSchema.parse>;
type ReadEvent = ReturnType<typeof SessionEventReaderSchema.parse>;
export interface CommentDraft { text: string; rev: number }
interface MessageActions {
 editDrafts?: Readonly<Record<string, CommentDraft>> | undefined;
 onEditDraftChange?: ((id: string, draft: CommentDraft | undefined) => void) | undefined;
 meId?: string | undefined;
 onCopyDraft?: ((draft: string) => Promise<void>) | undefined;
 onEdit?: ((id: string, rev: number, text: string) => Promise<void>) | undefined;
 onDelete?: ((id: string, rev: number) => Promise<void>) | undefined;
 onReload?: ((id: string) => Promise<ReadMessage | undefined>) | undefined;
 /** The task page's "Post it as a comment instead" after a refused instruction: moves the text to the comment box; sends nothing. */
 onPostAsComment?: ((text: string) => void) | undefined;
}
const goneWords: Record<string, string> = { plan_block: "This part of the plan is no longer available.", step: "This step is no longer available.", change_file: "This changed file is no longer available." };
const sourceWords: Record<string, string> = { slack: "from Slack", page: "from the task page", linear: "from Linear", app: "" };
function Message({ message, agent, meId, onEdit, onDelete, onReload, editDrafts, onEditDraftChange, onCopyDraft, onPostAsComment, event }: MessageActions & { message: ReadMessage; agent: string; event?: ReadEvent | undefined }) {
 const taskPage = useTaskPagePolicy() !== undefined, [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false), [text, setText] = useState(""), [revision, setRevision] = useState(message.rev);
 const [recovery, setRecovery] = useState<"conflict" | "missing" | "reload-failed">();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [conflict, setConflict] = useState(false), [serverText, setServerText] = useState<string>();
 const article = useRef<HTMLElement>(null), editTrigger = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
 useLayoutEffect(() => { if (returnFocus.current) { returnFocus.current = false;(editTrigger.current ?? article.current)?.focus(); } });
 const pending = useRef(false), editable = meId !== undefined && message.author.developerId === meId && message.source === "app" && message.kind === "comment" && message.deletedAt === undefined;
 async function change(remove: boolean) {
  if ((remove ? onDelete === undefined : onEdit === undefined) || pending.current || conflict || !editable || (!remove && (text.trim() === "" || text.length > 2000))) return;
  pending.current = true;setBusy(true);setError(undefined);
  try {
   if (remove) await onDelete?.(message.messageId, revision);else await onEdit?.(message.messageId, revision, text);
   returnFocus.current = true;setEditing(false);setDeleting(false);setServerText(undefined);onEditDraftChange?.(message.messageId, undefined);
  } catch (failure) {
   setError(failure instanceof ApiError ? failure.message : "Couldn't change this comment. Your draft is still here.");
   if (failure instanceof ApiError && ["SESSION_REVISION_CONFLICT", "CONFLICT"].includes(failure.code)) { setConflict(true);setRecovery("conflict"); }
   if (failure instanceof ApiError && failure.status === 404) { setConflict(true);setRecovery("missing"); }
  } finally { pending.current = false;setBusy(false); }
 }
 async function reload() {
  if (pending.current || onReload === undefined) return;pending.current = true;setBusy(true);
  try {
   const fresh = await onReload(message.messageId);
   if (fresh === undefined) throw new ApiError(404, "NOT_FOUND", "This comment is no longer available.");
   setRevision(fresh.rev);if (editing) onEditDraftChange?.(message.messageId, { text, rev: fresh.rev });setServerText(fresh.text);setConflict(false);setRecovery(undefined);setError(undefined);
  } catch (failure) { setServerText(undefined);setConflict(true);setRecovery(failure instanceof ApiError && failure.status === 404 ? "missing" : "reload-failed");setError(undefined); }
  finally { pending.current = false;setBusy(false); }
 }
 return <article ref={article} tabIndex={-1} className={taskPage ? "rv-message-card" : undefined}>
  {taskPage ? <div className="rv-message-top"><TalkAvatar name={message.author.name} />{message.kind === "comment" && event !== undefined ? <TalkCommentProvenanceView event={event} message={message} /> : <div className="rv-message-meta"><strong><VisibleText text={message.author.name} /></strong><RelativeTime at={message.createdAt} />{sourceWords[message.source] !== undefined && sourceWords[message.source] !== "" && <span>· {sourceWords[message.source]}</span>}{message.editedAt && <span>Edited</span>}</div>}<TalkKindChip kind={message.kind === "steer" ? "steer" : message.kind === "comment" ? "comment" : "question"} /></div>
   : message.kind === "comment" && event !== undefined ? <TalkCommentProvenanceView event={event} message={message} /> : <div className="rv-message-meta"><strong><VisibleText text={message.author.name} /></strong><span>{sourceWords[message.source] ?? "Source unavailable"}</span><RelativeTime at={message.createdAt} />{message.editedAt && <span>Edited</span>}</div>}
  {message.kind === "steer" && !taskPage && <p className="rv-message-kind"><VisibleText text={"Message to " + agent} /></p>}
  {message.anchorState === "gone" ? <p className="rv-muted">{goneWords[message.anchor?.target ?? ""] ?? "This part of the work is no longer available."}</p> : message.anchorState === "outdated" ? <p className="rv-muted">Refers to an earlier version</p> : null}
  <p className="rv-message-text"><VisibleText text={message.deletedAt ? "Comment deleted" : message.text} /></p>
  {taskPage && message.kind === "comment" && event?.source === "slack" && <p className="rv-talk-held-channel">Slack channel <HeldState /></p>}
  {message.kind === "steer" && message.delivery && (taskPage ? <>
   <TalkLadder steps={deliveryLadder(message.delivery)} />
   {message.delivery.state === "queued" && <p className="rv-receipt-note">Sent by <VisibleText text={message.author.name} /> to the build. Delivery is recorded here once the build acknowledges it. You can close this; the task page shows the same line.</p>}
   {message.delivery.state === "not_delivered" && <div className="rv-talk-refusal"><p><strong>Rovara couldn&apos;t deliver this instruction.</strong> <span className="rv-muted"><VisibleText text={message.delivery.reason ?? "It did not reach the build."} /> Nothing was changed by it.</span></p>{onPostAsComment !== undefined && <div className="rv-talk-next"><h4>What you can do</h4><p className="rv-talk-held">Sending it back to Build with this text isn&apos;t available here yet.</p><Button onClick={() => onPostAsComment(message.text)}>Post it as a comment instead</Button><p className="rv-muted">A comment is a note for people. Rovara does not act on it.</p></div>}</div>}
  </> : message.delivery.state === "unknown" ? <HeldState /> : <MessageDelivery receipt={{ state: message.delivery.state, ...(message.delivery.reason === undefined ? {} : { detail: message.delivery.reason }) }} />)}
  {editable && <div className="rv-message-actions">
   {!editing && !deleting && <>{onEdit && <Button ref={editTrigger} variant="quiet" onClick={() => { const draft = editDrafts?.[message.messageId];setText(draft?.text ?? message.text);setRevision(draft?.rev ?? message.rev);setError(undefined);setConflict(false);setRecovery(undefined);setEditing(true); }}>Edit comment</Button>}{onDelete && <Button variant="quiet" onClick={() => { setRevision(message.rev);setDeleting(true);setError(undefined); }}>Delete comment</Button>}</>}
   {editing && <form onSubmit={event => { event.preventDefault();void change(false); }}><TextArea autoFocus label="Edit comment" value={text} onChange={event => { setText(event.target.value);onEditDraftChange?.(message.messageId, { text: event.target.value, rev: revision }); }} maxLength={2000} disabled={busy} /><div className="rv-message-buttons">{recovery !== "missing" && <Button type="submit" busy={busy} disabled={onEdit === undefined || conflict || text.trim() === "" || text.length > 2000}>Save changes</Button>}<Button disabled={busy} onClick={() => { returnFocus.current = true;setEditing(false);setError(undefined);setServerText(undefined);onEditDraftChange?.(message.messageId, undefined); }}>Cancel edit</Button></div></form>}
   {deleting && <div><p>Delete this comment permanently?</p><Button variant="danger" busy={busy} disabled={onDelete === undefined || conflict} onClick={() => { void change(true); }}>Delete permanently</Button><Button autoFocus disabled={busy} onClick={() => { returnFocus.current = true;setDeleting(false);setError(undefined); }}>Keep comment</Button></div>}
   {error && recovery === undefined && <p role="alert"><VisibleText text={error} /></p>}
   {recovery !== undefined && <TalkCommentEditRecoveryView state={recovery} messageId={message.messageId} draft={text} onReload={() => { if (!busy) void reload(); }} onCopyDraft={draft => { void onCopyDraft?.(draft).catch(() => setError("Couldn't copy your draft.")); }} />}
   {serverText !== undefined && <div><p className="rv-muted">Latest saved comment. Your unsaved edit is above.</p>{serverText !== message.text && <p className="rv-message-text"><VisibleText text={serverText} /></p>}</div>}
  </div>}
 </article>;
}
export function Conversation({ agent, messages, events, ...actions }: MessageActions & { agent: string; messages: readonly ReadMessage[]; events: readonly ReadEvent[] }) {
 const timeline = [...messages.map(message => ({ at: message.createdAt, id: message.messageId, message })), ...events.filter(event => event.type !== "comment" || !messages.some(message => message.messageId === event.messageId)).map(event => ({ at: event.at, id: event.eventId, event }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
 const brief = messages.slice(-2).map(message => (message.author.name.split(" ")[0] ?? "") + "'s " + (message.kind === "steer" ? "instruction" : "comment") + (clockTime(message.createdAt) === undefined ? "" : " " + clockTime(message.createdAt))).join(", ");
 return <><ol className="rv-conversation" aria-label="Conversation">{timeline.map(item => <li key={item.id}>{"message" in item ? <Message message={item.message} event={events.find(event => event.type === "comment" && event.messageId === item.message.messageId)} agent={agent} {...actions} /> : <p className="rv-event-line">{item.event.actor?.kind === "member" && <><VisibleText text={item.event.actor.name} />: </>}<VisibleText text={item.event.text} /> <RelativeTime at={item.at} /></p>}</li>)}</ol>{messages.length > 0 && <p className="rv-conversation-brief" aria-hidden="true"><VisibleText text={"Earlier: " + brief} /></p>}</>;
}
