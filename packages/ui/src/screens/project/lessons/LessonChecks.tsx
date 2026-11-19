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
const SETTING_WORDS: Record<string, string> = {
 fitFloorWords: "How closely a lesson must match a task (words)", fitFloorCosine: "How closely a lesson must match a task (meaning)",
 priorWeightUses: "How many uses before a lesson's record counts fully", stepLessonCap: "Lessons given to one step", weeklyPicks: "New suggestions per week",
};
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/** One row of the table: the setting in plain words, its value now, what is suggested, and why. An unknown setting from a newer Code is drawn with the name as sent. */
function tuningRow(item: Record<string, unknown>): { setting: string; now: string; suggested: string; why: string } {
 const name = word(item["setting"], "Setting"), status = item["status"], evidence = rec(item["evidence"]), message = word(item["message"], "");
 const after = message.includes(": ") ? message.slice(message.indexOf(": ") + 2) : message;
 const base = { setting: Object.hasOwn(SETTING_WORDS, name) ? SETTING_WORDS[name]! : name, now: word(item["current"], "") };
 if (status === "suggested") return { ...base, suggested: word(item["suggested"], ""), why: after };
 if (status === "keep") return { ...base, suggested: "Keep", why: after };
 if (status === "not_enough_data") return { ...base, suggested: "Not yet", why: num(evidence["have"]) !== undefined && num(evidence["needed"]) !== undefined ? `${num(evidence["have"])} of ${num(evidence["needed"])} needed` : "Not enough data yet." };
 if (status === "no_data_source") return { ...base, suggested: "No suggestion", why: "Nothing measured can inform this yet." };
 return { ...base, suggested: word(item["suggested"], "No suggestion"), why: after };
}
function TuningPanel({ project }: { project: string }) {
 const read = useLessonTuning(project, true), data = read.data, suggestions = data && Array.isArray(data.suggestions) ? data.suggestions.map(rec) : [], evidence = rec(data?.evidence);
 const loads = num(evidence["loads"]), merged = num(evidence["mergedTasks"]), reverted = num(evidence["revertedTasks"]), rate = num(evidence["cleanMergeRate"]), clean = num(evidence["meanWordsCleanTasks"]), bad = num(evidence["meanWordsRevertedTasks"]);
 const unreadable = evidence["truncated"] === true || (num(evidence["unreadable"]) ?? 0) > 0;
 return <section><h3>Suggested settings</h3>{read.isPending ? <p>Loading suggested settings</p> : read.isError ? <p role="status">Suggested settings are unavailable right now. Try again.</p> : data && !data.ready ? <p>{loads === undefined ? "Not enough data yet. Come back after more tasks have run." : `Not enough data yet: ${loads} lesson loads so far. Come back after more tasks have run.`}</p> : data && <>
  <p>{loads === undefined ? "Based on the last " + String(data.windowDays) + " days." : `Based on ${loads} lesson loads in the last ${data.windowDays} days.`}</p>
  <table><caption className="rv-visually-hidden">Suggested settings</caption><thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Suggested</th><th scope="col">Why</th></tr></thead><tbody>{suggestions.map((item, index) => { const row = tuningRow(item);return <tr key={index}><th scope="row"><VisibleText text={row.setting} /></th><td>{row.now}</td><td>{item["status"] === "suggested" ? <strong><VisibleText text={row.suggested} /></strong> : <VisibleText text={row.suggested} />}</td><td><VisibleText text={row.why} /></td></tr>; })}</tbody></table>
  {unreadable && <p className="rv-muted">Some data could not be read, so these may be rough.</p>}
  <p className="rv-muted">These are suggestions only. Nothing changes here. Ask Rovara support to apply a value.</p>
  <details><summary>Show the numbers</summary><ul>{merged !== undefined && <li>Merged tasks: {merged}</li>}{reverted !== undefined && <li>Reverted tasks: {reverted}</li>}{rate !== undefined && <li>Clean merge rate: {Math.round(rate * 100)}%</li>}{clean !== undefined && bad !== undefined && clean > bad && <li>Lessons in clean tasks matched slightly better than in reverted tasks.</li>}</ul></details>
 </>}</section>;
}
