// How a finished session ended, for the Finished list (`SessionTile.finishedAs`). Read from what the session summary STORED when the task ended (its status model `display`: the state and,
// for a Closed, the reason), never from the live task and never guessed: a session whose summary says nothing this build recognises is plainly `finished`.
//   merged            the stored state is Merged
//   finished_no_code  the stored state is Closed with the status model's "Answered: no code change was needed" reason (a question that needed no code change)
//   closed            the stored state is Closed with no reason (its owner closed it, or its plan was rejected) and it is not a run that can still be retried
//   finished          everything else: a run that ended, one that failed, a Closed that carries another reason, an older summary with no `display`, a state this build does not know
import { TASK_STATUS_ANSWERED_REASON, type FinishedAs } from "@agentx/cloud-contracts";
import { TaskStatusSchema, type AgentSessionRecord } from "@rovara-code/contracts";

export function finishedAsOf(session: Pick<AgentSessionRecord, "summary">): FinishedAs {
  const stored = TaskStatusSchema.safeParse(session.summary.display);
  if (!stored.success) return "finished";
  const { state, reason, retryable } = stored.data;
  if (state === "merged") return "merged";
  if (state === "closed") {
    if (reason === TASK_STATUS_ANSWERED_REASON) return "finished_no_code";
    if (reason === undefined && retryable !== true) return "closed";
  }
  return "finished";
}
