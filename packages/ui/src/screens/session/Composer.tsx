import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { clockTime } from "./task-time.js";
export interface MessageInput { kind: "comment" | "steer"; text: string }
export interface ComposerDrafts { comment: string; steer: string }
export function Composer({ agent, actions, onSend, drafts, onDraftChange, sending = false, autoFocus = false, disabled = false, question, seed, compact = false, collapseQuestion = false, collapseAlways = false, settleNote }: {
 /** A plan change waits in the sheet: the composer is one quiet line under the Review plan bar. */
 collapseAlways?: boolean | undefined;
 /** A question is waiting on Rovara: the composer collapses to one "Ask another question" line that opens the question box. */
 collapseQuestion?: boolean | undefined;
 /** The task page collapses the composer to one line after a send, as in the Talk mocks; settleNote explains a held delivery. */
 compact?: boolean | undefined; settleNote?: string | undefined;
 /** The task page moves a refused instruction's text into the comment box (nothing is sent). */
 seed?: number | undefined;
 agent: string; actions: readonly string[]; onSend: (input: MessageInput) => Promise<void>;
 drafts?: ComposerDrafts | undefined; onDraftChange?: ((kind: "comment" | "steer", text: string) => void) | undefined; sending?: boolean; autoFocus?: boolean; disabled?: boolean; question?: ReactNode;
}) {
 const [kind, setKind] = useState<"comment" | "steer">(actions.includes("comment") ? "comment" : "steer"), [local, setLocal] = useState<ComposerDrafts>({ comment: "", steer: "" });
 const [asking, setAsking] = useState(false), taskPage = useTaskPagePolicy() !== undefined;
 const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), pending = useRef(false);
 const field = useRef<HTMLTextAreaElement>(null), focused = useRef(false);
 useLayoutEffect(() => { if (autoFocus && !disabled && !focused.current) { field.current?.focus();focused.current = true; } }, [autoFocus, disabled]);
 const [expanded, setExpanded] = useState(false), [touched, setTouched] = useState(false);
 const [seenCollapse, setSeenCollapse] = useState(compact || collapseQuestion || collapseAlways), [seenSettle, setSeenSettle] = useState(settleNote);
 if (seenCollapse !== (compact || collapseQuestion || collapseAlways)) { setSeenCollapse(compact || collapseQuestion || collapseAlways);if (!(compact || collapseQuestion || collapseAlways)) setExpanded(false); }
 if (seenSettle !== settleNote) { setSeenSettle(settleNote);setTouched(false); }
 const collapsed = taskPage && !expanded && (collapseQuestion || (!asking && (collapseAlways || (compact && kind === "steer"))));
 const [draftAt, setDraftAt] = useState<string>();
 const kindNow = collapsed && collapseAlways && !collapseQuestion && actions.includes("steer") ? "steer" : kind;
 const text = (drafts ?? local)[kindNow], writing = busy || sending, allowed = !disabled && actions.includes(kindNow), valid = text.trim().length > 0 && text.length <= 2000 && allowed;
 const [seenSeed, setSeenSeed] = useState(seed);
 if (seed !== seenSeed) { setSeenSeed(seed);if (seed !== undefined && actions.includes("comment")) { setExpanded(true);setAsking(false);setKind("comment");setError(undefined); } }
 function change(value: string) { if (taskPage && value !== "") setDraftAt(new Date().toISOString());if (onDraftChange) onDraftChange(kindNow, value);else setLocal(old => ({ ...old, [kindNow]: value })); }
 async function submit() {
  if (!valid || pending.current || sending) return;pending.current = true;setBusy(true);setError(undefined);
  try { await onSend({ kind: kindNow, text });change(""); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't send this message. Your draft is still here. Try again."); } finally { pending.current = false;setBusy(false); }
 }
 if (!actions.includes("comment") && !actions.includes("steer")) return <>{question}<p className="rv-muted">You can read this conversation.</p></>;
 const words = taskPage ? { comment: "Comment", steer: "Send an instruction", question: "Ask about this task" } : { comment: "Comment", steer: "Message the agent", question: "Ask a question" };
 const commentMode = actions.includes("comment") && <Button aria-pressed={!asking && !(collapseQuestion && !expanded) && kind === "comment"} disabled={writing} onClick={() => { setAsking(false);setKind("comment");setError(undefined); }}>{words.comment}</Button>;
 const steerMode = actions.includes("steer") && <Button aria-pressed={!asking && !(collapseQuestion && !expanded) && kind === "steer"} disabled={writing} onClick={() => { setAsking(false);setKind("steer");setError(undefined); }}>{words.steer}</Button>;
 const questionMode = question && <Button aria-pressed={asking || (collapseQuestion && !expanded)} disabled={writing || disabled} onClick={() => setAsking(true)}>{words.question}</Button>;
 const collapsedWords = collapseQuestion ? "Ask another question" : kindNow === "comment" ? "Write a comment" : "Write the next instruction";
 const arrow = <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M8 13V3m0 0L4 7m4-4 4 4" /></svg>;
 if (collapsed && collapseQuestion) return <div className="rv-composer rv-composer-collapsed"><div className="rv-composer-modes">{questionMode}{steerMode}{commentMode}</div><div hidden>{question}</div><form onSubmit={event => { event.preventDefault();setExpanded(true);setAsking(true); }}><TextArea label={collapsedWords} value="" readOnly rows={1} placeholder={collapsedWords} onFocus={() => { setExpanded(true);setAsking(true); }} onChange={() => undefined} /><div className="rv-composer-footer"><Button type="submit" variant="primary" disabled><span className="rv-visually-hidden">{collapsedWords}</span>{arrow}</Button></div></form></div>;
 return <div className={collapsed ? "rv-composer rv-composer-collapsed" : "rv-composer"}>{(!collapsed || (!collapseAlways && settleNote === undefined)) && <div className="rv-composer-modes">{taskPage ? <>{questionMode}{steerMode}{commentMode}</> : <>{commentMode}{steerMode}{questionMode}</>}</div>}{asking ? <fieldset disabled={disabled || writing} aria-label="Task question">{question}</fieldset> : <form onSubmit={event => { event.preventDefault();void submit(); }}>{collapsed && settleNote !== undefined && <p className="rv-composer-help rv-composer-settle"><VisibleText text={settleNote} /></p>}{!collapsed && <p className="rv-composer-help">{kindNow === "comment" && taskPage ? <><strong>Leave a note for people on this task.</strong> <span className="rv-composer-help-body"><VisibleText text={`Comments are for people. ${agent} doesn't read them.`} /></span></> : kindNow === "steer" && taskPage ? <><strong>Change what Rovara does on this build.</strong> <VisibleText text="Anything outside the plan comes back to you as a plan change to approve." /></> : <VisibleText text={kindNow === "comment" ? `Comments are for people. ${agent} doesn't read them.` : taskPage ? "Change what Rovara does on this build. Anything outside the plan comes back to you as a plan change to approve." : `${agent} receives this as an instruction. Delivery does not mean applied. Plan approvals still need review.`} />}</p>}<TextArea ref={field} autoFocus={autoFocus && !disabled} label={kindNow === "comment" ? "Comment" : taskPage ? "Instruction to Rovara" : "Message the agent"} value={settleNote !== undefined && !touched ? "" : text} onChange={event => { setTouched(true);change(event.target.value); }} {...(collapsed ? { onFocus: () => { setExpanded(true); } } : {})} disabled={writing || disabled} rows={collapsed ? 1 : 3} maxLength={2000} {...(collapsed ? { placeholder: collapsedWords } : {})} {...(error !== undefined && !(taskPage && disabled) ? { error } : {})} />{!collapsed && taskPage && onDraftChange !== undefined && text !== "" && draftAt !== undefined && clockTime(draftAt) !== undefined && <p className="rv-composer-saved" role="status">Draft saved on this device at {clockTime(draftAt)}. It stays until Rovara confirms it received it.</p>}<div className="rv-composer-footer">{!collapsed && <span className="rv-muted">{text.length}/2,000</span>}<Button type="submit" busy={writing} disabled={!valid || (settleNote !== undefined && !touched)} variant="primary">{collapsed ? <><span className="rv-visually-hidden">{kindNow === "comment" ? "Send comment" : "Send instruction"}</span>{arrow}</> : kindNow === "comment" ? "Send comment" : taskPage ? "Send instruction" : "Send message"}</Button></div></form>}</div>;
}
