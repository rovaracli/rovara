// Learning v2 wiring (WA-2): what the task actions tell the learning lane. Kept out of the action modules so each stays a one-line call, and so nothing in here can fail an action: every
// read is guarded and a lost event only means one outcome is not counted.
import { effectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { announceHumanSendBack } from "../../lessons/send-back-events.js";

/**
 * The owner sent the task back to coding (after the request was accepted). `caller.developerId` is the person who pressed it: the canonical developer id, never the task-owner key the
 * workflow decision uses as its actor. `earlierSendBacks` is how many human send-backs the task already had, so the round is counted from 1.
 */
export async function announceTaskSendBack(input: { task: DeveloperTaskRecord; callerDeveloperId: string; requestId: string; instructions: string; earlierSendBacks: number; at: string }): Promise<void> {
  // A task without an org has no Team record to write to.
  if (input.task.orgId === undefined) return;
  try {
    let ownerDeveloperId = input.task.developerId;
    try { ownerDeveloperId = effectiveTaskOwner(input.task).developerId; } catch { /* an unreadable owner falls back to the creator: the row then stays private to them */ }
    await announceHumanSendBack({
      workspaceId: input.task.orgId, project: input.task.project, taskId: input.task.taskId, requestId: input.requestId, actorDeveloperId: input.callerDeveloperId,
      instructions: input.instructions, round: input.earlierSendBacks + 1, shared: input.task.shared, ownerDeveloperId, at: input.at,
    });
  } catch { /* never fails the send-back */ }
}
