// Learning v2 wiring (WA-2): the person who sends a task back to coding. A human send-back is the clearest measured outcome there is, but it counts only when the row in the Team record
// names WHO sent it (`actorDeveloperId`): their own send-back of their own task, or of a lesson they wrote, is not independent. The send-back action (`developer-tasks/workflow-coding.ts`)
// announces it here, the same way a task's end is announced (`agents/task-end.ts`): a process-wide list of listeners, none by default, so nothing happens where learning is not wired.
import type { RovaraEmitter, TaskVisibility } from "../team-record/sources/rovara.js";

export interface HumanSendBackEvent {
  /** The org (the Team record's workspace) and the project of the task. */
  workspaceId: string;
  project: string;
  taskId: string;
  /** The request that sent it back: the row's id, so a repeat is the same row. */
  requestId: string;
  /** The person who pressed send-back: their canonical developer id (never a Slack or GitHub account). */
  actorDeveloperId: string;
  /** The owner's note, as typed. */
  instructions: string;
  /** Which send-back of the task this is, from 1. */
  round: number;
  /** Whether the task is shared; a task that is not stays private to its owner in the record. */
  shared: boolean;
  ownerDeveloperId: string;
  at: string;
}
export type HumanSendBackListener = (event: HumanSendBackEvent) => Promise<void>;

const listeners: HumanSendBackListener[] = [];

/** Registers a listener. Returns the function that removes it. */
export function registerHumanSendBackListener(listener: HumanSendBackListener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** Tells every listener. Never throws and never fails the send-back: a lost row only means one outcome is not counted. */
export async function announceHumanSendBack(event: HumanSendBackEvent): Promise<void> {
  for (const listener of [...listeners]) {
    try { await listener(event); } catch { /* the send-back has been accepted; learning does not get a say */ }
  }
}

/** A task that is shared is the project's; one that is not is its owner's alone. */
export const visibilityOf = (event: Pick<HumanSendBackEvent, "shared" | "ownerDeveloperId">): TaskVisibility =>
  event.shared ? { kind: "shared" } : { kind: "private", ownerDeveloperId: event.ownerDeveloperId };

/** The listener that writes the send-back to the Team record through the Rovara emitter, naming the person who sent it. */
export function sendBackToRecord(emitter: Pick<RovaraEmitter, "sendBack">): HumanSendBackListener {
  return (event) => emitter.sendBack({
    workspaceId: event.workspaceId, project: event.project, taskId: event.taskId, visibility: visibilityOf(event), at: event.at,
    sendBackId: event.requestId, round: event.round, origin: "human", reasonText: event.instructions, actorDeveloperId: event.actorDeveloperId,
  });
}
