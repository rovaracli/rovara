import { TaskErrorBlock } from "./TaskErrorBlock.js";

export interface TaskSessionEntryReadRecoveryViewProps {
 onRetry: () => void;
 /** The read was refused (signed out, or no longer allowed to see this task): nothing earlier stays on the page. */
 accessLost?: boolean;
}

/** F736 recovery for a failed initial session read, and DEC 324's access lost. The parent owns the read and its authority. */
export function TaskSessionEntryReadRecoveryView({ onRetry, accessLost = false }: TaskSessionEntryReadRecoveryViewProps) {
 return accessLost
  ? <TaskErrorBlock page title="You no longer have access to this task" happened="Rovara can't show this task to you any more. Your access changed or you were signed out." safe="The task itself is not changed." next="Check again. If you still can't see it, ask the person who owns the task to share it with you." action={{ label: "Check access again", onClick: onRetry }} refCode="TASK-ACCESS-LOST" />
  : <TaskErrorBlock page title="Rovara couldn't load this task" happened="This page could not be loaded, so it can't say whether the task is running." safe="Nothing on the task was changed by this page. Running work is not affected." next="" action={{ label: "Check again", onClick: onRetry }} refCode="TASK-READ-FAILED" />;
}
