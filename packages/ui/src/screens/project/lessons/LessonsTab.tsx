import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lessonsPauseLine } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { lessonsKey, useLessons } from "../../../api/lessons.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ActiveLesson } from "./ActiveLesson.js";
import { LearningModeControl } from "./LearningModeControl.js";
import { PresetControl } from "./PresetControl.js";
import { useLearningMode } from "../../../api/learning-mode.js";
import { Digest } from "./Digest.js";
import { LessonCard, type Decided } from "./LessonCard.js";
import { Rollback } from "./Rollback.js";
import { T, agoWords, dateWords, scopeWords, typeWords } from "./lessons-text.js";
import "./lessons.css";

/** Why there are no lessons here: the record paused (its own read says so), or lessons not set up in this installation. */
function LessonsGone({ project }: { project: string }) {
 const mode = useLearningMode(project);
 if (mode.isPending) return <p className="rv-muted" role="status">{T.LOADING}</p>;
 const paused = mode.error instanceof ApiError && mode.error.code === "TEAM_RECORD_PAUSED";
 return <p role="alert">{paused ? T.LESSONS_PAUSED : T.LESSONS_UNAVAILABLE}</p>;
}

/** "Lessons": what Rovara learned from this team's work. Maintainers approve, reject, remove and go back; everyone who can see the project reads the active lessons. */
export function LessonsTab({ project }: { project: string }) {
 const read = useLessons(project), query = useQueryClient();
 const [notice, setNotice] = useState<string>(), [search, setSearch] = useState(""), [now] = useState(() => Date.now()), [show, setShow] = useState({ removed: false, rollback: false });
 if (read.isPending) return <section className="rv-lessons" aria-label={T.TITLE}><Skeleton label={T.LOADING} /></section>;
 if (read.isError || read.data === undefined) {
  // UX-4b: learning Off (or the company's lock) has its own code, so the tab says so and offers to turn it on; a plain not found is an installation without the team record or lessons.
  const off = read.error instanceof ApiError && (read.error.code === "LEARNING_OFF" || read.error.code === "LEARNING_LOCKED");
  const gone = read.error instanceof ApiError && read.error.code === "NOT_FOUND";
  if (off) return <section className="rv-lessons" aria-label={T.TITLE}><p role="status">{read.error instanceof ApiError && read.error.code === "LEARNING_LOCKED" ? T.SOURCES_LEARNING_LOCKED : T.OFF}</p><LearningModeControl project={project} /></section>;
  // UX-4b review M3: a paused record has no lessons routes either; the record's own read says it is paused, and the tab says so.
  if (gone) return <section className="rv-lessons" aria-label={T.TITLE}><LessonsGone project={project} /></section>;
  return <section className="rv-lessons" aria-label={T.TITLE}><p role="alert">{gone ? T.LESSONS_UNAVAILABLE : T.LOAD_FAILED}</p>{!gone && <Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button>}</section>;
 }
 const view = read.data;
 async function done(result: Decided) {
  if (result.message !== undefined) setNotice(result.message); else if (result.reload) setNotice(T.CHANGED);
  if (result.reload) await query.invalidateQueries({ queryKey: lessonsKey(project) });
 }
 const needle = search.trim().toLowerCase();
 const active = needle === "" ? view.active : view.active.filter(lesson => (lesson.title + " " + lesson.body + " " + scopeWords(lesson.scope)).toLowerCase().includes(needle));
 const off = view.mode === "Off", collecting = view.mode === "Collect";
 return <section className="rv-lessons" aria-label={T.TITLE}>
  <p className="rv-muted">{T.INTRO}</p>
  {off && <Banner title={T.OFF} tone="warning" />}
  {/* Never silent: when learning cannot run for this project (no provider, the monthly limit, every model forbidden, the budgets), the tab says why in one line. */}
  {view.lessonsSwitchedOff === true && <Banner title={T.SWITCHED_OFF} tone="warning" />}
  {!off && view.paused !== undefined && <p role="status" className="rv-lessons-paused" data-testid="lessons-paused"><span data-testid="lessons-paused-line">{lessonsPauseLine(view.paused)}</span> <span className="rv-muted" data-testid="lessons-paused-since">since {dateWords(view.paused.at)}</span></p>}
  {collecting && view.lessonsSwitchedOff !== true && <Banner title={T.COLLECT} tone="info" />}
  {view.lockedByCompany && <p className="rv-muted">{T.LOCKED}</p>}
  {!view.canDecide && <p className="rv-muted">{T.READ_ONLY}</p>}
  {view.canDecide && <LearningModeControl project={project} compact />}
  {!off && <PresetControl project={project} view={view} />}
  {notice !== undefined && <p role="status">{notice}</p>}

  {view.canDecide && <section aria-label={T.WAITING} className="rv-lessons-section">
   <h2>{T.WAITING} ({view.waiting.length})</h2>
   {view.waiting.length === 0 ? <p className="rv-muted">{T.WAITING_NONE}</p> : <ul className="rv-lessons-cards" aria-label={T.WAITING}>{view.waiting.map(lesson => <li key={lesson.id + ":" + String(lesson.version)}><LessonCard project={project} lesson={lesson} now={now} onDone={done} /></li>)}</ul>}
   {view.truncated.includes("waiting") && <p className="rv-muted">{T.TRUNCATED}</p>}
   {view.queued > 0 && <p className="rv-muted">{String(view.queued)} {T.QUEUED}</p>}
   {view.hidden > 0 && <p className="rv-muted">{String(view.hidden)} {view.hidden === 1 ? "lesson comes" : "lessons come"} from sources you can't see and {view.hidden === 1 ? "is" : "are"} left out.</p>}
   {view.legacyHeld !== undefined && <p className="rv-muted" data-testid="lessons-legacy-held">{String(view.legacyHeld)} {view.legacyHeld === 1 ? "lesson is" : "lessons are"} on hold because {view.legacyHeld === 1 ? "it was" : "they were"} learned from tasks started before sessions existed, so who may see {view.legacyHeld === 1 ? "it" : "them"} can't be checked.</p>}
  </section>}

  <section aria-label={T.ACTIVE} className="rv-lessons-section">
   <h2>{T.ACTIVE} ({view.active.length})</h2>
   {view.active.length > 0 && <TextField label={T.SEARCH} type="search" value={search} onChange={event => setSearch(event.target.value)} />}
   {view.active.length === 0 ? <p className="rv-muted">{T.ACTIVE_NONE}</p> : active.length === 0 ? <p className="rv-muted">{T.NO_MATCH}</p> : <ul className="rv-lessons-list" aria-label={T.ACTIVE}>{active.map(lesson => <ActiveLesson key={lesson.id + ":" + String(lesson.version)} project={project} lesson={lesson} now={now} onDone={done} />)}</ul>}
   {view.truncated.includes("active") && <p className="rv-muted">{T.TRUNCATED}</p>}
  </section>

  {view.canDecide && <section aria-label={T.DIGEST} className="rv-lessons-section"><h2>{T.DIGEST}</h2><Digest project={project} /></section>}

  {view.canDecide && <section aria-label={T.REMOVED} className="rv-lessons-section">
   <Button className="rv-lessons-toggle" aria-expanded={show.removed} onClick={() => setShow(current => ({ ...current, removed: !current.removed }))}>{T.REMOVED} ({view.removed.length})</Button>
   {show.removed && (view.removed.length === 0 ? <p className="rv-muted">{T.REMOVED_NONE}</p> : <ul className="rv-lessons-list" aria-label={T.REMOVED}>{view.removed.map(lesson => <li key={lesson.id + ":" + String(lesson.version)}>
    <strong><VisibleText text={lesson.title} /></strong> <span className="rv-muted">· {typeWords(lesson.type)} · {lesson.status === "rejected" ? "Rejected" : lesson.status === "expired" ? "Expired" : "Removed"} {dateWords(lesson.updatedAt)} ({agoWords(lesson.updatedAt, now)})</span>
    {lesson.rejectedReason !== undefined && <p className="rv-muted">Reason: <VisibleText text={lesson.rejectedReason} /></p>}</li>)}</ul>)}
   {show.removed && view.truncated.includes("removed") && <p className="rv-muted">{T.TRUNCATED}</p>}
   <Button className="rv-lessons-toggle" aria-expanded={show.rollback} onClick={() => setShow(current => ({ ...current, rollback: !current.rollback }))}>{T.ROLLBACK}</Button>
   {show.rollback && <Rollback project={project} view={view} onDone={done} />}
  </section>}
 </section>;
}
