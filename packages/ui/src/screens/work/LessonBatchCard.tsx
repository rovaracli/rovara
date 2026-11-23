import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LessonDecisionResult, LessonInboxBatch } from "@agentx/contracts/code-contract-v0";
import { ApiError } from "../../api/errors.js";
import { DECISIONS_MAX, INBOX_KEY, relationWords, REJECT_REASONS, batchTitle, citationWords, expiryWords, fromWords, learnedKey, resultWords, useLearnedApi, type LessonDecision, type LessonItem } from "../../api/learned.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { TextArea } from "../../design/TextArea.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { RECONNECTING_TEXT } from "../project/write-freeze.js";
import "./lessons.css";

type Choice = { kind: "keep" } | { kind: "edit"; title: string; description: string; body: string } | { kind: "drop"; reason: string };
type Sent = { title: string; decision: "keep" | "drop"; result: LessonDecisionResult };

/** The decision a choice sends, or undefined while it is not complete (an edit with no title or text, a drop with no reason). */
function decisionOf(lesson: LessonItem, choice: Choice | undefined): LessonDecision | undefined {
 if (choice === undefined) return undefined;
 if (choice.kind === "keep") return { lessonId: lesson.id, version: lesson.version, decision: "keep" };
 if (choice.kind === "drop") { const reason = REJECT_REASONS.find(entry => entry.value === choice.reason)?.value; return reason === undefined ? undefined : { lessonId: lesson.id, version: lesson.version, decision: "drop", reason }; }
 const title = choice.title.trim(), body = choice.body.trim(), description = choice.description.trim();
 if (title === "" || body === "" || title.length > 80 || description.length > 160 || body.length > 600) return undefined;
 // An edit that changes nothing is a plain Keep: Code treats any edit as a rewrite (it records an editor and drops approvals given to the old text).
 if (title === lesson.title.trim() && description === lesson.description.trim() && body === lesson.body.trim()) return { lessonId: lesson.id, version: lesson.version, decision: "keep" };
 return { lessonId: lesson.id, version: lesson.version, decision: "keep", edit: { title, description, body } };
}

/** One proposed lesson in the batch: what it says, where it came from, when it lapses, and Keep, Edit or Drop (keys K, E and D while it has focus). */
function LessonDecisionRow({ lesson, index, total, choice, onChoose, now, failed, disabled, titleOf }: { lesson: LessonItem; index: number; total: number; choice: Choice | undefined; onChoose: (choice: Choice | undefined) => void; now: number; failed: string | undefined; disabled: boolean; titleOf: (id: string) => string | undefined }) {
 const relations = relationWords(lesson, titleOf);
 const expiry = expiryWords(lesson.expiresAt, now), from = fromWords(lesson), name = "lesson-" + lesson.id;
 const keep = () => onChoose({ kind: "keep" }), edit = () => onChoose({ kind: "edit", title: lesson.title, description: lesson.description, body: lesson.body }), drop = () => onChoose({ kind: "drop", reason: "" });
 function onKeyDown(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  // A key typed in a text field or a list is text, never a decision.
  const typing = target.closest("textarea, select") !== null || (target instanceof HTMLInputElement && target.type !== "radio" && target.type !== "checkbox");
  if (disabled || event.metaKey || event.ctrlKey || event.altKey || typing) return;
  const key = event.key.toLowerCase();
  if (key === "k" && lesson.canApprove) { event.preventDefault();keep(); }
  // E again while editing keeps the text typed so far.
  else if (key === "e" && lesson.canApprove) { event.preventDefault();if (choice?.kind !== "edit") edit(); }
  else if (key === "d" && lesson.canReject) { event.preventDefault();drop(); }
 }
 return <li><article className="rv-lesson" aria-labelledby={name + "-title"} data-lesson-id={lesson.id} onKeyDown={onKeyDown} data-choice={choice?.kind}>
  <div className="rv-lesson-top"><p className="rv-lesson-eyebrow">Lesson {index + 1} of {total}</p>{lesson.canApprove && <span className="rv-lesson-waiting"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11v.2" /></svg>Waiting for you</span>}</div>
  <header className="rv-lesson-head"><h3 id={name + "-title"}><VisibleText text={lesson.title} /></h3></header>
  {(lesson.description !== "" || from !== undefined) && <div className="rv-lesson-row"><span className="rv-lesson-label">Came from</span><p className="rv-lesson-description">{lesson.description !== "" && <VisibleText text={lesson.description} />}{from !== undefined && <span className={"rv-lesson-from" + (lesson.from.some(person => person.you === true) ? " you" : "")}>{from}</span>}</p></div>}
  {lesson.body !== "" && lesson.body !== lesson.description && <div className="rv-lesson-row"><span className="rv-lesson-label">The lesson</span><p className="rv-lesson-body"><VisibleText text={lesson.body} /></p></div>}
  <ul className="rv-lesson-facts">
   {lesson.supportTasks > 0 && <li>Learned from {lesson.supportTasks === 1 ? "1 task" : `${String(lesson.supportTasks)} tasks`}</li>}
   {lesson.needs?.required === 2 && <li>Needs two people to keep it</li>}
   {lesson.citations.slice(0, 3).map((one, index) => { const words = citationWords(one); return <li key={index}>{words.href === undefined ? <span className="mono"><VisibleText text={words.text} /></span> : <a href={words.href} target="_blank" rel="noreferrer">{words.text}</a>}</li>; })}
  </ul>
  {relations.map(words => <p key={words} className="rv-lesson-relation" data-testid="lesson-relation"><VisibleText text={words} /></p>)}
  <p className={"rv-lesson-expiry" + (expiry.soon ? " soon" : "")} data-testid={expiry.soon ? "lesson-expiry-soon" : "lesson-expiry"}>{expiry.soon && <span className="rv-tone-dot" data-tone="wait" aria-hidden="true" />}{expiry.text}</p>
  <fieldset className="rv-lesson-choice" disabled={disabled}>
   <legend className="rv-visually-hidden">Your decision on {lesson.title}</legend>
   {lesson.canApprove && <label className="rv-choice"><input type="radio" name={name} checked={choice?.kind === "keep"} onChange={keep} /><span>Keep <kbd aria-hidden="true">K</kbd></span></label>}
   {lesson.canApprove && <label className="rv-choice"><input type="radio" name={name} checked={choice?.kind === "edit"} onChange={edit} /><span>Edit <kbd aria-hidden="true">E</kbd></span></label>}
   {lesson.canReject && <label className="rv-choice"><input type="radio" name={name} checked={choice?.kind === "drop"} onChange={drop} /><span>Drop <kbd aria-hidden="true">D</kbd></span></label>}
   {choice !== undefined && <Button variant="quiet" onClick={() => onChoose(undefined)}>Undo</Button>}
  </fieldset>
  {choice?.kind === "edit" && <div className="rv-lesson-edit">
   <TextField label="Title" value={choice.title} maxLength={80} onChange={event => onChoose({ ...choice, title: event.target.value })} {...(choice.title.trim() === "" ? { error: "Give the lesson a title." } : {})} />
   <TextField label="One line about it (optional)" value={choice.description} maxLength={160} onChange={event => onChoose({ ...choice, description: event.target.value })} />
   <TextArea label="What Rovara should do" value={choice.body} maxLength={600} rows={3} onChange={event => onChoose({ ...choice, body: event.target.value })} {...(choice.body.trim() === "" ? { error: "Say what Rovara should do." } : {})} />
  </div>}
  {choice?.kind === "drop" && <div className="rv-lesson-edit"><Select label="Why drop it" value={choice.reason} placeholder="Choose a reason" options={REJECT_REASONS} onValueChange={reason => onChoose({ kind: "drop", reason })} /></div>}
  {failed !== undefined && <p className="rv-lesson-failed" role="alert"><VisibleText text={failed} /></p>}
 </article></li>;
}

/**
 * The inbox batch (DEC 231b): one card for a project's proposed lessons, a decision for each (Keep, Edit or Drop), all sent at once with one result each. The lessons
 * from the person's own corrections come first (Cloud orders them; Code says whose they are). After sending, what happened stays on the card until the person
 * moves on; a lesson that was not accepted stays in the list with Code's words.
 */
export function LessonBatchCard({ batch, onDone, frozen = false }: { batch: LessonInboxBatch; onDone: () => void; frozen?: boolean }) {
 // Rule 14: this card depends on the inbox read only (Code says in it who may decide; this page has no identity read). While that read shows kept facts, nothing is sent.
 const frozenRef = useRef(frozen);useLayoutEffect(() => { frozenRef.current = frozen; });
 const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
 const [choices, setChoices] = useState<Record<string, Choice>>({}), [sent, setSent] = useState<Record<string, Sent>>({}), [sending, setSending] = useState(false), [error, setError] = useState<string>();
 const [now] = useState(() => Date.now()), heading = useRef<HTMLHeadingElement>(null), sentAny = useRef(false);
 // Leaving the card reads the inbox again, so the list shows only what still waits.
 useEffect(() => () => { if (sentAny.current) void query.invalidateQueries({ queryKey: INBOX_KEY }); }, [query]);
 const open = batch.lessons.filter(lesson => sent[lesson.id]?.result.ok !== true);
 const ready = open.flatMap(lesson => { const decision = decisionOf(lesson, choices[lesson.id]); return decision === undefined ? [] : [decision]; }).slice(0, DECISIONS_MAX);
 const incomplete = open.filter(lesson => choices[lesson.id] !== undefined && decisionOf(lesson, choices[lesson.id]) === undefined).length;
 const undecided = open.filter(lesson => choices[lesson.id] === undefined && lesson.canApprove);
 async function send() {
  if (ready.length === 0 || sending) return;
  if (frozenRef.current) { setError(RECONNECTING_TEXT);return; }
  setSending(true);setError(undefined);
  try {
   const results = await api.decide(batch.project, ready);
   sentAny.current = true;
   const next = { ...sent };
   for (const result of results) {
    const lesson = batch.lessons.find(entry => entry.id === result.lessonId), decision = ready.find(entry => entry.lessonId === result.lessonId);
    if (lesson !== undefined && decision !== undefined) next[lesson.id] = { title: lesson.title, decision: decision.decision, result };
   }
   setSent(next);
   // Every sent choice is cleared: a refused lesson is read again and decided again on its current text, never kept unread.
   setChoices(old => Object.fromEntries(Object.entries(old).filter(([id]) => !results.some(result => result.lessonId === id))));
   const kept = results.filter(result => result.ok && result.status !== "rejected").length, dropped = results.filter(result => result.ok && result.status === "rejected").length, refused = results.filter(result => !result.ok).length;
   announce(`Sent. ${String(kept)} kept, ${String(dropped)} dropped${refused > 0 ? `, ${String(refused)} not accepted` : ""}.`);
   void query.invalidateQueries({ queryKey: learnedKey(batch.project) });
   // A lesson that was not accepted (most often one that changed since it was read) is read again, so a second send carries its current version.
   if (refused > 0) void query.invalidateQueries({ queryKey: INBOX_KEY });
   heading.current?.focus();
  } catch (failure) {
   setError(failure instanceof ApiError ? failure.message : "Couldn't send your decisions. Reload to check where they stand.");
  } finally { setSending(false); }
 }
 const done = Object.values(sent);
 return <article className="rv-task-pane rv-lesson-batch" aria-labelledby="lesson-batch-title" data-testid="lesson-batch">
  <header className="rv-pane-head">
   <p className="rv-eyebrow">Lessons · <VisibleText text={batch.project} /></p>
   <h2 id="lesson-batch-title" data-testid="pane-title" ref={heading} tabIndex={-1}>{batchTitle(batch, now)}</h2>
   <p className="rv-muted rv-lesson-intro">Rovara drafted these from corrections people made. Keep the ones that should guide future tasks; nothing is used until a person keeps it. With a lesson focused: <kbd>K</kbd> keep, <kbd>E</kbd> edit, <kbd>D</kbd> drop.</p>
  </header>
  <div className="rv-pane-grid">
   {done.length > 0 && <section className="rv-lesson-results" aria-label="What happened" data-testid="lesson-results"><h3>What happened</h3><ul>{done.map(entry => <li key={entry.result.lessonId} className={entry.result.ok ? "ok" : "bad"}><b><VisibleText text={entry.title} /></b> <VisibleText text={resultWords(entry.result, entry.decision)} /></li>)}</ul></section>}
   {open.length === 0 ? <section className="rv-lesson-all-done" data-testid="lesson-batch-done"><h3>All decided</h3><p className="rv-muted">Nothing else waits in this batch.</p><Button variant="primary" onClick={onDone}>Done</Button></section> : <>
    <ol className="rv-lesson-list" aria-label="Lessons to decide">{open.map((lesson, index) => <LessonDecisionRow key={lesson.id} lesson={lesson} index={index} total={open.length} now={now} titleOf={id => batch.lessons.find(entry => entry.id === id)?.title} disabled={sending || frozen} choice={choices[lesson.id]} failed={sent[lesson.id]?.result.ok === false ? resultWords(sent[lesson.id]!.result, sent[lesson.id]!.decision) : undefined} onChoose={choice => setChoices(old => { const next = { ...old };if (choice === undefined) delete next[lesson.id];else next[lesson.id] = choice;return next; })} />)}</ol>
    <div className="rv-lesson-send">
     {error !== undefined && <p role="alert" className="rv-lesson-failed"><VisibleText text={error} /></p>}
     <p className="rv-muted" aria-live="polite">{ready.length === 0 ? "Choose Keep, Edit or Drop for each lesson you want to decide now." : `${String(ready.length)} of ${String(open.length)} decided${incomplete > 0 ? `; ${String(incomplete)} still need${incomplete === 1 ? "s" : ""} a reason or text` : ""}.`}</p>
     <div className="rv-lesson-send-row">
      {undecided.length > 0 && <Button disabled={sending || frozen} onClick={() => setChoices(old => ({ ...old, ...Object.fromEntries(undecided.map(lesson => [lesson.id, { kind: "keep" }])) }))}>Keep the rest</Button>}
      <Button variant="primary" busy={sending} disabled={ready.length === 0 || frozen} onClick={() => { void send(); }}>{ready.length <= 1 ? "Send decision" : `Send ${String(ready.length)} decisions`}</Button>
     </div>
    </div>
   </>}
  </div>
 </article>;
}
