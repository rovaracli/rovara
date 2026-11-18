import { openRoundOf, useWorkTasks, type ReadTask } from "../../api/work.js";
import { VisibleText } from "../../design/VisibleText.js";
import { InlineQuestions } from "../work/InlineQuestions.js";

/**
 * The person's own tasks whose Understand questions wait on them and can be answered here: a round with a question left. A row with no round (an older Code, or one Code would not show
 * the person) is not counted: the Work list links it to the task's page, and Home does not claim it needs them.
 */
export const tasksAsking = (tasks: readonly ReadTask[] | undefined): ReadTask[] => (tasks ?? []).filter(task => openRoundOf(task) !== undefined);

/**
 * Home's "Rovara has questions": the same list read as the Work page (`GET /v1/app/sessions`, Code's detailed list with Code #1057's round), and the questions answered inline. Nothing shows
 * while none waits, or when the list cannot be read (the Work page says why); the cards above and below are unchanged.
 */
export function HomeQuestions() {
 const tasks = useWorkTasks(), asking = tasksAsking(tasks.data);
 if (asking.length === 0) return null;
 return <section className="rv-needs-you" aria-label="Rovara has questions"><h2 className="rv-needs-you-title">Rovara has questions</h2>
  <ol className="rv-attention-list" aria-label="Questions waiting for you">{asking.map(task => <li key={task.taskId} className="rv-attention-row" data-task-id={task.taskId}><article><div className="rv-attention-content"><h3><VisibleText text={task.title} /></h3><p className="rv-muted"><VisibleText text={task.project} /></p></div></article><InlineQuestions task={task} /></li>)}</ol>
 </section>;
}
