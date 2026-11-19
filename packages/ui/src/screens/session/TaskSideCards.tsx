import { TaskMoney } from "../../design/TaskMoney.js";
import type { ReadEvent, ReadPlan, ReadTask } from "../../api/work.js";
import { Money } from "../../design/Money.js";
import { VisibleText } from "../../design/VisibleText.js";
import { stripTerminalEscapes } from "../../text/terminal.js";

const HISTORY_MAX = 8;

/** The task's cost against its limit, and its history (the events that belong to no plan task). Each says nothing for what Code did not send. */
export function TaskSideCards({ task, plan, events }: { task: ReadTask; plan: ReadPlan | undefined; events: readonly ReadEvent[] }) {
 const limit = task.money?.stop.taskMaximumMicros.state === "available" ? task.money.stop.taskMaximumMicros.value / 1_000_000 : undefined, spent = task.money?.spentMicros.state === "available" ? task.money.spentMicros.value / 1_000_000 : undefined, history = events.filter(event => event.taskItemId === undefined).slice(-HISTORY_MAX);
 return <>
  <section className="rv-card" aria-label="Cost"><h4>Cost</h4>
   <div className="rv-cost-row"><TaskMoney money={task.money} />{limit !== undefined && <span className="rv-muted">stops at <Money usd={limit} /></span>}</div>
   {spent !== undefined && limit !== undefined && limit > 0 && <div className="rv-meter" role="meter" aria-label="Spent against the limit" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spent, limit)}><i className={spent >= limit ? "bad" : ""} style={{ width: Math.min(100, (spent / limit) * 100) + "%" }} /></div>}
   {plan?.estimate !== undefined && <p className="rv-muted rv-cost-estimate">Estimate: <VisibleText text={plan.estimate} /></p>}</section>
  {history.length > 0 && <section className="rv-card" aria-label="History"><h4>History</h4><ol className="rv-history">{history.map(event => <li key={event.seq}><span className="mono rv-muted">{event.at.slice(11, 16)}</span> <VisibleText text={stripTerminalEscapes(event.text ?? event.kind)} /></li>)}</ol></section>}
 </>;
}
