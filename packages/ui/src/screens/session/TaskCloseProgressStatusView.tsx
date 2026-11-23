import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

const STATUS_COPY = {
 // A close bound to a preview that Code accepted: it says so, and it is still running until a read shows the task closed.
 closing: "Closing this task. Rovara accepted the close and is freeing its workspace. Leaving this window does not stop it. Check this task's close status.",
 slow: "Closing is taking longer than usual. The operation may still be running; leaving this window does not confirm closure. Check this task's close status.",
 pending: "Closing is waiting for confirmation. Its result is not yet known. Open this task to check the close status.",
 unconfirmed: "Closing this task was not confirmed. Its workspace may still be held. Check the task's close status.",
} as const;

export type TaskCloseProgressStatus = keyof typeof STATUS_COPY;

/** A status-only close notice. The owner supplies its existing read-only task check. */
export function TaskCloseProgressStatusView({ taskId, state, onCheck }: {
 taskId: string;
 state: TaskCloseProgressStatus;
 onCheck: () => void | Promise<void>;
}) {
 return <div className="rv-banner rv-banner-warning" role="status" data-task-id={taskId}>
  <VisibleText text={STATUS_COPY[state]} />
  <Button variant="quiet" onClick={() => { void onCheck(); }}>Check</Button>
 </div>;
}
