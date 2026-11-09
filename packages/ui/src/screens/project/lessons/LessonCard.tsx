import { useState } from "react";
import { LESSON_TIER_REASONS } from "@agentx/contracts/web";
import { useLessonsApi, type LessonItem } from "../../../api/lessons.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Card } from "../../../design/Card.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { Citations } from "./Citations.js";
import { T, agoWords, failureText, isStale, reasonWords, scopeWords, stagesWords, typeWords } from "./lessons-text.js";

export interface Decided { message?: string; reload: boolean }
interface Props { project: string; lesson: LessonItem; now: number; onDone: (result: Decided) => Promise<void> | void }
type Mode = "none" | "edit" | "reject";

/** Words for why a lesson needs the people it needs: the tier's reasons the classifier wrote, in plain sentences. Reasons this build does not know have no words and are left out. */
function ReasonList({ lesson }: { lesson: LessonItem }) {
 const words = lesson.tierReasons.filter(reason => (LESSON_TIER_REASONS as readonly string[]).includes(reason)).flatMap(reason => { const text = reasonWords(reason);return text === undefined ? [] : [text]; });
 return words.length === 0 ? null : <ul className="rv-lessons-reasons" aria-label="Why this needs the people it does">{words.map(text => <li key={text}>{text}</li>)}</ul>;
}

/** A lesson waiting for a decision: what it says, where it comes from, whether its code references still hold, who approved first, and the buttons the server says this person may use. */
export function LessonCard({ project, lesson, now, onDone }: Props) {
 const api = useLessonsApi(), needs = lesson.needs;
 const [mode, setMode] = useState<Mode>("none"), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 const [title, setTitle] = useState(lesson.title), [description, setDescription] = useState(lesson.description), [body, setBody] = useState(lesson.body), [reason, setReason] = useState("");
 const two = needs?.required === 2, youApproved = lesson.approvals.some(approval => approval.by.you === true);
 async function run(action: () => Promise<Decided>) {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await onDone(await action()); }
  catch (failure) { setError(failureText(failure, "Couldn't save that. Try again."));if (isStale(failure)) await onDone({ reload: true }); }
  finally { setBusy(false); }
 }
 const approve = (edited: boolean) => run(async () => {
  const answer = await api.approve(project, lesson.id, { expectedVersion: lesson.version, ...(edited ? { edit: { title, description, body } } : {}) });
  return { message: answer.status === "active" ? T.APPROVED_ACTIVE : T.APPROVED_WAITING, reload: true };
 });
 const reject = () => run(async () => { await api.reject(project, lesson.id, { expectedVersion: lesson.version, reason });return { message: T.REJECTED, reload: true }; });
 const merge = () => run(async () => { await api.merge(project, lesson.id, lesson.version);return { message: T.MERGED, reload: true }; });
 return <Card className="rv-lessons-card" aria-labelledby={"lesson-" + lesson.id}>
  <h3 id={"lesson-" + lesson.id}><VisibleText text={lesson.title} /></h3>
  <p className="rv-muted">{typeWords(lesson.type)} · <VisibleText text={scopeWords(lesson.scope)} /> · {stagesWords(lesson.stages)}</p>
  <p className="rv-lessons-text"><VisibleText text={lesson.body} /></p>
  {lesson.description !== "" && <p className="rv-muted"><VisibleText text={lesson.description} /></p>}
  {needs !== undefined && <p><strong>{two ? T.TWO_PEOPLE : T.ONE_PERSON}</strong> <span className="rv-muted">{T.APPROVAL_RULE}</span></p>}
  <ReasonList lesson={lesson} />
  {needs?.first !== undefined && <p>{T.FIRST_APPROVED} <strong><VisibleText text={needs.first.name} /></strong>{needs.firstAt !== undefined && <span className="rv-muted"> · {agoWords(needs.firstAt, now)}</span>}. {T.STILL_NEEDS}</p>}
  {needs !== undefined && needs.groups.length > 0 && <p className="rv-muted">{T.GROUP_NEEDS} <VisibleText text={needs.groups.join(", ")} />.</p>}
  {lesson.reviewRequired === true && <Banner title={T.SENT_BACK} tone="warning" />}
  {lesson.contradicts !== undefined && <Banner title={T.CONTRADICTS} tone="warning" />}
  {lesson.possibleDuplicate !== undefined && <Banner title={lesson.mergeBlocked === true ? T.TWIN_NO_MERGE : T.POSSIBLE_DUPLICATE} tone="warning" />}
  {lesson.supersedes !== undefined && <p className="rv-muted">{T.REPLACES}</p>}
  <section aria-label={T.WHERE_FROM} className="rv-lessons-from">
   <h4>{T.WHERE_FROM}</h4>
   {lesson.from.length > 0 && <p>{T.FROM_PEOPLE} <VisibleText text={lesson.from.map(person => person.name).join(", ")} /></p>}
   {lesson.measured && <p>{T.MEASURED}</p>}
   {lesson.supportTasks > 0 && <p className="rv-muted">{String(lesson.supportTasks)} {T.TASKS_BACK}</p>}
   <Citations citations={lesson.citations} now={now} />
  </section>
  {mode === "edit" && <fieldset className="rv-lessons-edit" disabled={busy}><legend>{T.APPROVE_EDIT}</legend>
   <TextField label={T.EDIT_TITLE} maxLength={80} value={title} onChange={event => setTitle(event.target.value)} />
   <TextField label={T.EDIT_DESCRIPTION} maxLength={160} value={description} onChange={event => setDescription(event.target.value)} />
   <TextArea label={T.EDIT_BODY} hint={T.EDIT_HINT} rows={4} maxLength={600} value={body} onChange={event => setBody(event.target.value)} />
   <div className="rv-lessons-actions"><Button variant="primary" busy={busy} disabled={title.trim() === "" || body.trim() === ""} onClick={() => { void approve(true); }}>{T.APPROVE_EDIT}</Button><Button onClick={() => setMode("none")}>{T.CANCEL}</Button></div>
  </fieldset>}
  {mode === "reject" && <fieldset className="rv-lessons-edit" disabled={busy}><legend>{T.REJECT}</legend>
   <TextField label={T.REJECT_REASON} maxLength={200} value={reason} onChange={event => setReason(event.target.value)} />
   <div className="rv-lessons-actions"><Button variant="danger" busy={busy} disabled={reason.trim() === ""} onClick={() => { void reject(); }}>{T.REJECT_SEND}</Button><Button onClick={() => setMode("none")}>{T.CANCEL}</Button></div>
  </fieldset>}
  {mode === "none" && (lesson.canApprove || lesson.canReject) && <div className="rv-lessons-actions">
   {lesson.canReject && lesson.possibleDuplicate !== undefined && lesson.mergeBlocked !== true && <Button busy={busy} onClick={() => { void merge(); }}>{T.MERGE}</Button>}
   {lesson.canApprove && <Button variant="primary" busy={busy} onClick={() => { void approve(false); }}>{T.APPROVE}</Button>}
   {lesson.canApprove && <Button disabled={busy} onClick={() => setMode("edit")}>{T.APPROVE_EDIT}</Button>}
   {lesson.canReject && <Button disabled={busy} onClick={() => setMode("reject")}>{T.REJECT}</Button>}
  </div>}
  {mode === "none" && !lesson.canApprove && <p className="rv-muted">{youApproved ? T.YOU_APPROVED : T.CANNOT_APPROVE}</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </Card>;
}
