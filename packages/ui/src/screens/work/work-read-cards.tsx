import type { ReactNode } from "react";
import { ApiError } from "../../api/errors.js";
import type { WorkRow } from "../../api/work-read.js";
import { VisibleText } from "../../design/VisibleText.js";
import { taskWords } from "../../text/task-words.js";

/** The quiet step of the peek: a task that asks nothing of the person says why, in fixed words. */
export function QuietCard({ row, decisionsError }: { row: WorkRow; decisionsError: unknown }) {
 let title: string, body: ReactNode;
 if (row.task.detailUnread === true) { title = "Task details aren't available"; body = <>Rovara can't tell yet which step this task is in. Open the task to check.</>; }
 else if (row.group === "you") {
  title = row.need ?? "Needs you";
  // Understand's questions (Code #1057's round on the row) are answered on the task's page: no decision card is coming for them.
  if (row.need === "Answer questions") body = <>Rovara has questions before it plans this. Open the task to answer them.</>;
  else body = decisionsError === undefined ? <>This needs you, but its decision isn't available to show yet. {row.task.workflow?.blockReason !== undefined && <VisibleText text={taskWords(row.task.workflow.blockReason, row.task.hasThread)} />}</> : <>{decisionsError instanceof ApiError ? <VisibleText text={decisionsError.message} /> : "Decisions couldn't be loaded."}</>;
 } else if (row.group === "involved") { title = "You're involved in this task"; body = <>Someone added you to it. Its owner answers the agent's questions and decides. You can follow it here.</>; }
 else if (row.group === "others") { title = "Waiting"; body = <>{row.line}. Rovara can't tell yet who will make the next move.</>; }
 else if (row.group === "done") { title = row.line; body = <>The latest task read reports this outcome.</>; }
 else if (row.group === "stopped") { title = "Stopped"; body = <>The latest task read reports that it stopped. Open the task to close it, or continue it in your tool.</>; }
 else if (row.line === "In the queue") { title = "In the queue"; body = <>The task read shows it is queued. Rovara can't tell yet when it will start.</>; }
 else { title = "Rovara is working"; body = <>{row.line}. Rovara shows no decision waiting on you for this task.</>; }
 return <section className="rv-qp-step" aria-label="Decision" data-testid="decision-quiet"><h3>{title}</h3><p>{body}</p></section>;
}
