import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { lessonsKey, useLessons } from "../../../api/lessons.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ActiveLesson } from "./ActiveLesson.js";
import { Digest } from "./Digest.js";
import { LessonCard, type Decided } from "./LessonCard.js";
import { Rollback } from "./Rollback.js";
import { T, agoWords, dateWords, scopeWords, typeWords } from "./lessons-text.js";
import "./lessons.css";

/** "Lessons": what Rovara learned from this team's work. Maintainers approve, reject, remove and go back; everyone who can see the project reads the active lessons. */
export function LessonsTab({ project }: { project: string }) {
 const read = useLessons(project), query = useQueryClient();
 const [notice, setNotice] = useState<string>(), [search, setSearch] = useState(""), [now] = useState(() => Date.now()), [show, setShow] = useState({ removed: false, rollback: false });
 if (read.isPending) return <section className="rv-lessons" aria-label={T.TITLE}><Skeleton label={T.LOADING} /></section>;
 if (read.isError || read.data === undefined) {
  const gone = read.error instanceof ApiError && read.error.code === "NOT_FOUND";
  return <section className="rv-lessons" aria-label={T.TITLE}><p role="alert">{gone ? "Lessons aren't set up for this project yet." : T.LOAD_FAILED}</p>{!gone && <Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button>}</section>;
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
  {collecting && <Banner title={T.COLLECT} tone="info" />}
  {view.lockedByCompany && <p className="rv-muted">{T.LOCKED}</p>}
  {!view.canDecide && <p className="rv-muted">{T.READ_ONLY}</p>}
  {notice !== undefined && <p role="status">{notice}</p>}

  {view.canDecide && <section aria-label={T.WAITING} className="rv-lessons-section">
   <h2>{T.WAITING} ({view.waiting.length})</h2>
   {view.waiting.length === 0 ? <p className="rv-muted">{T.WAITING_NONE}</p> : <ul className="rv-lessons-cards" aria-label={T.WAITING}>{view.waiting.map(lesson => <li key={lesson.id + ":" + String(lesson.version)}><LessonCard project={project} lesson={lesson} now={now} onDone={done} /></li>)}</ul>}
   {view.truncated.includes("waiting") && <p className="rv-muted">{T.TRUNCATED}</p>}
   {view.queued > 0 && <p className="rv-muted">{String(view.queued)} {T.QUEUED}</p>}
   {view.hidden > 0 && <p className="rv-muted">{String(view.hidden)} {view.hidden === 1 ? "lesson comes" : "lessons come"} from sources you can't see and {view.hidden === 1 ? "is" : "are"} left out.</p>}
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
