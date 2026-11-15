import type { ReadEvent, ReadSpecTask } from "../../api/work.js";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SteerBox, type Steer } from "./SteerBox.js";
import { stripTerminalEscapes } from "../../text/terminal.js";

const STATE_WORDS = { todo: "Planned", running: "Running", done: "Done", blocked: "Stopped" } as const;
const LIVE_LINES = 3;
const time = (iso: string): string => iso.slice(11, 19);

/** One plan task: planned, running (the last three lines of what it is doing), done or stopped, with the criteria it builds. */
export function TaskRow({ task, events, steer }: { task: ReadSpecTask; events: readonly ReadEvent[]; /** The steer box, drawn under the running task only. */ steer?: Steer | undefined }) {
 const lines = task.status === "running" ? events.slice(-LIVE_LINES) : [];
 return <li className={`rv-task-row ${task.status}`} data-task={task.id}>
  <span className="rv-task-box" aria-hidden="true">{task.status === "done" ? "✓" : task.status === "running" ? "●" : task.status === "blocked" ? "!" : ""}</span>
  <div className="rv-task-main"><b>{task.id} · <VisibleText text={task.title} /></b><span className="rv-visually-hidden">, {STATE_WORDS[task.status]}</span>
   {lines.length > 0 && <div className="rv-live" role="log" aria-label={"What " + task.id + " is doing"}>{lines.map(line => <div key={line.seq}><b>{time(line.at)}</b> <VisibleText text={stripTerminalEscapes(line.text ?? line.kind)} /></div>)}</div>}{task.status === "running" && steer !== undefined && <SteerBox steer={steer} label={task.id} />}</div>
  {task.criterionIds.length > 0 && <span className="rv-id-chip link">{task.criterionIds.join(" · ")}</span>}
 </li>;
}

/** The plan's tasks with what each is doing now. Events are grouped under the task they name (`taskItemId`); a Code that names none shows the latest lines together. */
export function BuildStep({ tasks, events, heading = "Build", steer }: { tasks: readonly ReadSpecTask[]; events: readonly ReadEvent[]; heading?: string; steer?: Steer | undefined }) {
 const running = tasks.findIndex(task => task.status === "running");
 const named = events.some(event => event.taskItemId !== undefined);
 return <section aria-label={heading} className="rv-build">
  <div className="rv-section-head"><h3>{heading}</h3><span>{tasks.length === 0 ? "No tasks planned yet" : running >= 0 ? <StatusPill tone="run" label={`Task ${running + 1} of ${tasks.length}`} /> : `${tasks.filter(task => task.status === "done").length} of ${tasks.length} done`}</span></div>
  {tasks.length > 0 && <ol className="rv-task-list">{tasks.map(task => <TaskRow key={task.id} task={task} events={named ? events.filter(event => event.taskItemId === task.id) : events} steer={steer} />)}</ol>}
  {tasks.length === 0 && events.length > 0 && <div className="rv-live" role="log" aria-label="What Rovara is doing">{events.slice(-LIVE_LINES).map(line => <div key={line.seq}><b>{time(line.at)}</b> <VisibleText text={stripTerminalEscapes(line.text ?? line.kind)} /></div>)}</div>}
  {tasks.length === 0 && steer !== undefined && <SteerBox steer={steer} label="task" />}
 </section>;
}
