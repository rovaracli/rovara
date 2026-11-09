import { useState } from "react";
import { useLessonHistory, useLessonsApi, type LessonItem } from "../../../api/lessons.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { Citations } from "./Citations.js";
import type { Decided } from "./LessonCard.js";
import { T, agoWords, dateWords, expiryWords, failureText, isStale, scopeWords, stagesWords, typeWords } from "./lessons-text.js";

function History({ project, id }: { project: string; id: string }) {
 const read = useLessonHistory(project, id, true);
 if (read.isPending) return <p className="rv-muted" role="status">Loading</p>;
 if (read.isError) return <p className="rv-muted" role="alert">The history could not be loaded right now.</p>;
 return <ol className="rv-lessons-history" aria-label="Versions">{read.data.versions.map(version => <li key={version.version}>
  <strong>Version {version.version}</strong> <span className="rv-muted">· {dateWords(version.at)} · {version.status}{version.approvedBy.length > 0 && <> · approved by <VisibleText text={version.approvedBy.map(person => person.name).join(", ")} /></>}</span>
  <p className="rv-lessons-text"><VisibleText text={version.title} />: <VisibleText text={version.body} /></p></li>)}</ol>;
}

/** One lesson in use (or stale): its words, helpful and wrong marks, expiry, the code it cites and whether that still holds; Remove and History for a person who decides. */
export function ActiveLesson({ project, lesson, now, onDone }: { project: string; lesson: LessonItem; now: number; onDone: (result: Decided) => Promise<void> | void }) {
 const api = useLessonsApi(), [history, setHistory] = useState(false), [removing, setRemoving] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function remove() {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await api.retire(project, lesson.id, reason.trim() === "" ? undefined : reason.trim());await onDone({ message: T.REMOVED_DONE, reload: true }); }
  catch (failure) { setError(failureText(failure, "Couldn't remove this lesson. Try again."));if (isStale(failure)) await onDone({ reload: true }); }
  finally { setBusy(false); }
 }
 const stale = lesson.status === "stale";
 return <li className="rv-lessons-active">
  <h4><VisibleText text={lesson.title} /></h4>
  {lesson.trial !== undefined && <p className="rv-lessons-trial"><strong>{lesson.trial === "trial" ? T.TRIAL_BADGE : T.STABLE_BADGE}</strong> <span className="rv-muted">{lesson.trial === "trial" ? T.TRIAL_WORDS : T.STABLE_WORDS}</span></p>}
  <p className="rv-muted">{typeWords(lesson.type)} · <VisibleText text={scopeWords(lesson.scope)} /> · {stagesWords(lesson.stages)}</p>
  <p className="rv-lessons-text"><VisibleText text={lesson.body} /></p>
  {stale && <Banner title={T.STALE} tone="warning" />}
  {lesson.retireProposed === true && <Banner title={T.RETIRE_PROPOSED} tone="warning" />}
  {lesson.reviewRequired === true && <p className="rv-muted">{T.SENT_BACK}</p>}
  <p className="rv-lessons-counts" title={T.MARKS_ONCE}><span>{T.HELPFUL}: {lesson.counters.helpful}</span> · <span>{T.WRONG}: {lesson.counters.harmful}</span> · <span>Loaded {lesson.counters.loaded} {lesson.counters.loaded === 1 ? "time" : "times"}</span>{lesson.lastUsedAt !== undefined && <> · <span>{T.LAST_HELPED} {agoWords(lesson.lastUsedAt, now)}</span></>} · <span>{expiryWords(lesson.expiresAt, now)}</span></p>
  <details><summary>{T.WHERE_FROM}</summary>
   {lesson.from.length > 0 && <p>{T.FROM_PEOPLE} <VisibleText text={lesson.from.map(person => person.name).join(", ")} /></p>}
   {lesson.measured && <p>{T.MEASURED}</p>}
   <Citations citations={lesson.citations} now={now} />
  </details>
  {removing ? <fieldset className="rv-lessons-edit" disabled={busy}><legend>{T.RETIRE}</legend>
   <TextField label={T.REMOVE_REASON} maxLength={200} value={reason} onChange={event => setReason(event.target.value)} />
   <div className="rv-lessons-actions"><Button variant="danger" busy={busy} onClick={() => { void remove(); }}>{T.REMOVE_SEND}</Button><Button onClick={() => setRemoving(false)}>{T.CANCEL}</Button></div></fieldset>
  : lesson.canRetire && <div className="rv-lessons-actions">
   {lesson.canRetire && <Button onClick={() => setRemoving(true)} aria-label={T.RETIRE + ": " + visibleText(lesson.title)}>{T.RETIRE}</Button>}
   {lesson.canRetire && <Button variant="quiet" aria-expanded={history} onClick={() => setHistory(value => !value)} aria-label={(history ? T.HIDE_HISTORY : T.HISTORY) + ": " + visibleText(lesson.title)}>{history ? T.HIDE_HISTORY : T.HISTORY}</Button>}
  </div>}
  {history && <History project={project} id={lesson.id} />}
  {error !== undefined && <p role="alert">{error}</p>}
 </li>;
}
