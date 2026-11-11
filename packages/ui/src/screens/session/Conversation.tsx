import { useLayoutEffect, useRef, useState } from "react";
import type { SessionEventReaderSchema, SessionMessageReaderSchema } from "@agentx/cloud-contracts/web";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
type ReadMessage = ReturnType<typeof SessionMessageReaderSchema.parse>;
type ReadEvent = ReturnType<typeof SessionEventReaderSchema.parse>;
export interface CommentDraft { text: string; rev: number }
interface MessageActions {
 editDrafts?: Readonly<Record<string, CommentDraft>> | undefined;
 onEditDraftChange?: ((id: string, draft: CommentDraft | undefined) => void) | undefined;
 meId?: string | undefined;
 onEdit?: ((id: string, rev: number, text: string) => Promise<void>) | undefined;
 onDelete?: ((id: string, rev: number) => Promise<void>) | undefined;
 onReload?: ((id: string) => Promise<ReadMessage | undefined>) | undefined;
}
const goneWords: Record<string, string> = { plan_block: "This part of the plan is no longer available.", step: "This step is no longer available.", change_file: "This changed file is no longer available." };
const sourceWords: Record<string, string> = { slack: "from Slack", page: "from the task page", linear: "from Linear", app: "" };
function Message({ message, agent, meId, onEdit, onDelete, onReload, editDrafts, onEditDraftChange }: MessageActions & { message: ReadMessage; agent: string }) {
 const [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false), [text, setText] = useState(""), [revision, setRevision] = useState(message.rev);
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
   if (failure instanceof ApiError && failure.code === "SESSION_REVISION_CONFLICT") setConflict(true);
  } finally { pending.current = false;setBusy(false); }
 }
 async function reload() {
  if (pending.current || onReload === undefined) return;pending.current = true;setBusy(true);
  try {
   const fresh = await onReload(message.messageId);
   if (fresh === undefined) throw new ApiError(404, "NOT_FOUND", "This comment is no longer available.");
   setRevision(fresh.rev);if (editing) onEditDraftChange?.(message.messageId, { text, rev: fresh.rev });setServerText(fresh.text);setConflict(false);setError(undefined);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't reload this comment. Your draft is still here."); }
  finally { pending.current = false;setBusy(false); }
 }
 return <article ref={article} tabIndex={-1}>
  <div className="rv-message-meta"><strong><VisibleText text={message.author.name} /></strong><span>{sourceWords[message.source] ?? "Source unavailable"}</span><RelativeTime at={message.createdAt} />{message.editedAt && <span>Edited</span>}</div>
  {message.kind === "steer" && <p className="rv-message-kind"><VisibleText text={"Message to " + agent} /></p>}
  {message.anchorState === "gone" ? <p className="rv-muted">{goneWords[message.anchor?.target ?? ""] ?? "This part of the work is no longer available."}</p> : message.anchorState === "outdated" ? <p className="rv-muted">Refers to an earlier version</p> : null}
  <p className="rv-message-text"><VisibleText text={message.deletedAt ? "Comment deleted" : message.text} /></p>
  {message.delivery && <p className="rv-message-delivery"><VisibleText text={message.delivery.state === "queued" ? "Queued" : message.delivery.state === "delivered" ? "Delivered" + (message.delivery.reason === undefined ? "" : ": " + message.delivery.reason) : message.delivery.state === "not_delivered" ? "Not delivered: " + (message.delivery.reason ?? "Delivery unavailable") : "Delivery unavailable"} /></p>}
  {editable && <div className="rv-message-actions">
   {!editing && !deleting && <>{onEdit && <Button ref={editTrigger} variant="quiet" onClick={() => { const draft = editDrafts?.[message.messageId];setText(draft?.text ?? message.text);setRevision(draft?.rev ?? message.rev);setError(undefined);setConflict(false);setEditing(true); }}>Edit comment</Button>}{onDelete && <Button variant="quiet" onClick={() => { setRevision(message.rev);setDeleting(true);setError(undefined); }}>Delete comment</Button>}</>}
   {editing && <form onSubmit={event => { event.preventDefault();void change(false); }}><TextArea autoFocus label="Edit comment" value={text} onChange={event => { setText(event.target.value);onEditDraftChange?.(message.messageId, { text: event.target.value, rev: revision }); }} maxLength={2000} disabled={busy} /><div className="rv-message-buttons"><Button type="submit" busy={busy} disabled={conflict || text.trim() === "" || text.length > 2000}>Save changes</Button><Button disabled={busy} onClick={() => { returnFocus.current = true;setEditing(false);setError(undefined);setServerText(undefined);onEditDraftChange?.(message.messageId, undefined); }}>Cancel edit</Button></div></form>}
   {deleting && <div><p>Delete this comment permanently?</p><Button variant="danger" busy={busy} disabled={conflict} onClick={() => { void change(true); }}>Delete permanently</Button><Button autoFocus disabled={busy} onClick={() => { returnFocus.current = true;setDeleting(false);setError(undefined); }}>Keep comment</Button></div>}
   {error && <p role="alert"><VisibleText text={error} /></p>}
   {conflict && onReload && <Button busy={busy} onClick={() => { void reload(); }}>Reload</Button>}
   {serverText !== undefined && <div><p className="rv-muted">Latest saved comment. Your unsaved edit is above.</p>{serverText !== message.text && <p className="rv-message-text"><VisibleText text={serverText} /></p>}</div>}
  </div>}
 </article>;
}
export function Conversation({ agent, messages, events, ...actions }: MessageActions & { agent: string; messages: readonly ReadMessage[]; events: readonly ReadEvent[] }) {
 const timeline = [...messages.map(message => ({ at: message.createdAt, id: message.messageId, message })), ...events.map(event => ({ at: event.at, id: event.eventId, event }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
 return <ol className="rv-conversation" aria-label="Conversation">{timeline.map(item => <li key={item.id}>{"message" in item ? <Message message={item.message} agent={agent} {...actions} /> : <p className="rv-event-line">{item.event.actor?.kind === "member" && <><VisibleText text={item.event.actor.name} />: </>}<VisibleText text={item.event.text} /> <RelativeTime at={item.at} /></p>}</li>)}</ol>;
}
