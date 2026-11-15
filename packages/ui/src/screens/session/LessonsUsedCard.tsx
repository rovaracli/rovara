import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { learnedKey, lessonsOff, notServed, stageWords, taskCitationWords, useLearnedApi, useTaskLessons, whyWords, type TaskLesson } from "../../api/learned.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import "../work/lessons.css";

/** What a lesson's marks are, as Code counted them; nothing when Code sent no counts. */
function marks(lesson: TaskLesson): string | undefined {
 if (lesson.helpful === undefined && lesson.harmful === undefined) return undefined;
 return `${String(lesson.helpful ?? 0)} helpful · ${String(lesson.harmful ?? 0)} not helpful, across all tasks`;
}

function LessonUsedRow({ project, taskId, lesson }: { project: string; taskId: string; lesson: TaskLesson }) {
 const api = useLearnedApi(), query = useQueryClient(), [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string }>({ kind: "idle" });
 async function mark() {
  setState({ kind: "busy" });
  try {
   await api.notHelpful(project, taskId, lesson.lessonId);
   setState({ kind: "done", text: lesson.trial === "trial" ? "Marked not helpful. It was on trial, so Rovara stops using it." : "Marked not helpful. The people who decide lessons will look at it." });
   void query.invalidateQueries({ queryKey: learnedKey(project) });
  } catch (error) { setState({ kind: "error", text: error instanceof ApiError ? error.message : "Couldn't record that. Try again." }); }
 }
 const counted = marks(lesson);
 return <li data-lesson-id={lesson.lessonId}>
  {lesson.visible ? <b><VisibleText text={lesson.title ?? "A lesson"} /></b> : <b>A lesson from a source you can't see</b>}
  <small>{stageWords(lesson.stage)}{lesson.round > 1 ? `, round ${String(lesson.round)}` : ""} · Why: {whyWords(lesson.why)}</small>
  <small>{taskCitationWords(lesson.citation)}{counted === undefined ? "" : " · " + counted}{lesson.trial === "trial" ? " · On trial" : ""}</small>
  {state.kind === "done" ? <p role="status">{state.text}</p>
   : lesson.canMark && lesson.visible && <Button variant="quiet" busy={state.kind === "busy"} onClick={() => { void mark(); }} aria-label={`Not helpful: ${lesson.title ?? "this lesson"}`}>Not helpful</Button>}
  {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
 </li>;
}

/**
 * A side card: a read that failed is said in the card with Try again, not as an alert that would interrupt the task page.
 *
 * "Lessons used" (DEC 231, fix 3): each lesson the task was given, why Rovara picked it, the state of its citation and its helpful and not helpful marks as Code
 * counted them, with "Not helpful" for a person on the project. Lessons that are off say so calmly; a Code without the lessons API says nothing is recorded.
 */
export function LessonsUsedCard({ project, taskId }: { project: string; taskId: string }) {
 const read = useTaskLessons(project, taskId);
 let body;
 if (read.isPending) body = <p className="rv-muted">Loading…</p>;
 else if (read.isError) body = lessonsOff(read.error) ? <p className="rv-muted" data-testid="lessons-off">Lessons are off, so this page can't show which ones this task used.</p>
  : notServed(read.error) ? <p className="rv-muted" data-testid="lessons-not-recorded">Which lessons this task used isn't recorded on Rovara Code yet.</p>
  : <div className="rv-section-error" data-testid="lessons-used-error"><p><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load the lessons used. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>;
 else if (read.data.length === 0) body = <p className="rv-muted">No lessons were given to this task.</p>;
 else body = <ul>{read.data.map(lesson => <LessonUsedRow key={`${lesson.stage}:${String(lesson.round)}:${lesson.lessonId}`} project={project} taskId={taskId} lesson={lesson} />)}</ul>;
 return <section className="rv-card rv-lessons-used" aria-label="Lessons used" data-testid="lessons-used"><h4>Lessons used</h4>{body}</section>;
}
