import { useState } from "react";
import { Link } from "react-router";
import { useLessonMeasure } from "../../../api/lessons.js";
import { useLessonReplay, useLessonTuning } from "../../../api/lessons-extras.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { LearningMeasure } from "../LearningMeasure.js";

const rec = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null ? x as Record<string, unknown> : {};
const word = (value: unknown, fallback: string) => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
export function LessonChecks({ project }: { project: string }) {
 const measure = useLessonMeasure(project), [open, setOpen] = useState(false), [run, setRun] = useState(false), [count, setCount] = useState(30);
 if (!measure.isSuccess) return null;
 return <section className="rv-project-section" data-testid="lesson-checks"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><strong>Check how lessons are doing</strong></button><p className="rv-muted">For project admins. Read-only.</p>{open && <><LearningMeasure project={project} /><ReplayPanel project={project} run={run} count={count} setCount={setCount} onRun={() => setRun(true)} /><TuningPanel project={project} /></>}</section>;
}
function ReplayPanel({ project, run, count, setCount, onRun }: { project: string; run: boolean; count: number; setCount: (n: number) => void; onRun: () => void }) {
 const read = useLessonReplay(project, count, run), data = read.data;
 return <section><h3>Replay check</h3><p>See which lessons Rovara would give your last finished tasks today, next to what it gave then. Nothing is changed and no AI is used.</p><label>Last <select value={count} onChange={e => setCount(Number(e.target.value))}><option value={10}>10</option><option value={30}>30</option><option value={50}>50</option></select> finished tasks</label><Button busy={read.isFetching} onClick={() => { onRun();void read.refetch(); }}>Run check</Button>{read.isError && <p role="alert">Rovara couldn't run the check right now. Try again, or check fewer tasks.</p>}{read.isFetching && <p role="status">Checking the last {count} tasks…</p>}{data && <ReplayResult data={data} />}</section>;
}
function ReplayResult({ data }: { data: unknown }) {
 const body = rec(data), tasks = Array.isArray(body["tasks"]) ? body["tasks"].map(rec) : [], totals = rec(body["totals"]), changed = tasks.filter(task => task["changed"] === true), changedTasks = Number(totals["changedTasks"] ?? changed.length), gained = Number(totals["lessonsGained"] ?? 0), lost = Number(totals["lessonsLost"] ?? 0);
 if (tasks.length === 0) return <p>No finished task here was given lessons yet. Run this after a few tasks finish.</p>;
 return <><p>{changedTasks === 0 ? `Same lessons for all ${tasks.length} tasks checked.` : `${changedTasks} of ${tasks.length} tasks would get different lessons today: ${gained} added, ${lost} left out.`}</p>{changed.length > 0 && <ul>{changed.slice(0, 10).map((task, i) => { const id = word(task["taskId"], `task-${i}`);return <li key={id}><Link to={`/app/tasks/${encodeURIComponent(id)}`}>{word(task["taskId"], "Task")}</Link> · {word(task["stage"], "A step")} · +{Array.isArray(task["gained"]) ? task["gained"].length : 0} added, {Array.isArray(task["lost"]) ? task["lost"].length : 0} left out</li>; })}</ul>}{changed.length > 10 && <p>Showing 10 of {changed.length} changed tasks.</p>}<p className="rv-muted">Lessons change as they are approved, retired, or as their fit is re-scored. Fix rounds are compared without the reviewer's words, so they can differ slightly.</p></>;
}
function TuningPanel({ project }: { project: string }) {
 const read = useLessonTuning(project, true), data = read.data, suggestions = data && Array.isArray(data.suggestions) ? data.suggestions.map(rec) : [];
 return <section><h3>Suggested settings</h3>{read.isPending ? <p>Loading suggested settings</p> : read.isError ? <p role="status">Suggested settings are unavailable right now. Try again.</p> : data && !data.ready ? <p>{data.message || "Not enough data yet."}</p> : <><p>{data?.note}</p><p>Ask Rovara support to apply a value.</p><ul>{suggestions.map((item, index) => <li key={index}><VisibleText text={`${word(item["setting"], "Setting")}: ${word(item["status"], "Not yet")}`} /></li>)}</ul></>}</section>;
}
