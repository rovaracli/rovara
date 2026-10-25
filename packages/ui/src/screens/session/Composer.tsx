import { useRef, useState } from "react";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
export interface MessageInput { kind: "comment" | "steer"; text: string }
export interface ComposerDrafts { comment: string; steer: string }
export function Composer({ agent, actions, onSend, drafts, onDraftChange, sending = false }: {
 agent: string; actions: readonly string[]; onSend: (input: MessageInput) => Promise<void>;
 drafts?: ComposerDrafts | undefined; onDraftChange?: ((kind: "comment" | "steer", text: string) => void) | undefined; sending?: boolean;
}) {
 const [kind, setKind] = useState<"comment" | "steer">(actions.includes("comment") ? "comment" : "steer"), [local, setLocal] = useState<ComposerDrafts>({ comment: "", steer: "" });
 const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), pending = useRef(false);
 const text = (drafts ?? local)[kind], writing = busy || sending, allowed = actions.includes(kind), valid = text.trim().length > 0 && text.length <= 2000 && allowed;
 function change(value: string) { if (onDraftChange) onDraftChange(kind, value);else setLocal(old => ({ ...old, [kind]: value })); }
 async function submit() {
  if (!valid || pending.current || sending) return;pending.current = true;setBusy(true);setError(undefined);
  try { await onSend({ kind, text });change(""); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't send this message. Your draft is still here. Try again."); } finally { pending.current = false;setBusy(false); }
 }
 if (!actions.includes("comment") && !actions.includes("steer")) return <p className="rv-muted">You can read this conversation.</p>;
 return <form className="rv-composer" onSubmit={event => { event.preventDefault();void submit(); }}><div className="rv-composer-modes">{actions.includes("comment") && <Button aria-pressed={kind === "comment"} disabled={writing} onClick={() => { setKind("comment");setError(undefined); }}>Comment</Button>}{actions.includes("steer") && <Button aria-pressed={kind === "steer"} disabled={writing} onClick={() => { setKind("steer");setError(undefined); }}>Message the agent</Button>}</div><p className="rv-composer-help"><VisibleText text={kind === "comment" ? `Comments are for people. ${agent} doesn't read them.` : `${agent} reads this as information, not as instructions. Approvals still need you.`} /></p><TextArea label={kind === "comment" ? "Comment" : "Message the agent"} value={text} onChange={event => change(event.target.value)} disabled={writing} rows={4} maxLength={2000} {...(error !== undefined ? { error } : {})} /><div className="rv-composer-footer"><span className="rv-muted">{text.length}/2,000</span><Button type="submit" busy={writing} disabled={!valid} variant="primary">{kind === "comment" ? "Send comment" : "Send message"}</Button></div></form>;
}
