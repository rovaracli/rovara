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

/**
 * Who may read a send-back's row. The event's `shared` is the C1 Slack-channel flag and says nothing of Plan 5 visibility, so it is not used: the task's visibility is read when the row is
 * written (`lessons/task-visibility.ts`, the one reader every emit point uses). Without a reader the row is the owner's alone (fail closed).
 */
export type SendBackVisibility = (workspaceId: string, taskId: string) => Promise<TaskVisibility | undefined>;
export const ownerOnly = (event: Pick<HumanSendBackEvent, "ownerDeveloperId">): TaskVisibility => ({ kind: "private", ownerDeveloperId: event.ownerDeveloperId });

/** The listener that writes the send-back to the Team record through the Rovara emitter, naming the person who sent it. */
export function sendBackToRecord(emitter: Pick<RovaraEmitter, "sendBack">, visibilityOf?: SendBackVisibility): HumanSendBackListener {
  return async (event) => {
    const visibility = visibilityOf === undefined ? ownerOnly(event) : await visibilityOf(event.workspaceId, event.taskId);
    if (visibility === undefined) return;
    await emitter.sendBack({
      workspaceId: event.workspaceId, project: event.project, taskId: event.taskId, visibility, at: event.at,
      sendBackId: event.requestId, round: event.round, origin: "human", reasonText: event.instructions, actorDeveloperId: event.actorDeveloperId,
    });
  };
}
