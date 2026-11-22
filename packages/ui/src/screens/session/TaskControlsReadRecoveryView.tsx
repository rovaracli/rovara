import type { ReactNode } from "react";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

export function TaskControlsReadRecoveryView({ children, reloadControls }: { children: ReactNode; reloadControls: () => void }) {
 return <>{children}<div role="alert" className="rv-task-controls-error" data-testid="controls-error"><p><VisibleText text="Stop, Share and Conversation could not be loaded. The displayed task is still available, but its controls are not current." /> <Button onClick={reloadControls}>Reload the controls</Button></p></div></>;
}
