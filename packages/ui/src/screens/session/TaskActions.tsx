import { useRef, useState } from "react";
import { ApiError } from "../../api/errors.js";
import { useWorkApi } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/**
 * The task page's own actions beside the session controls: "Continue in my tool" (contract v0 `tasks.continue`) and, for a task Rovara Cloud did not start, the plain
 * reason Stop is not here (Stop is a session control, so it comes with the session). A route that is not connected says so in its own words; nothing is retried.
 */
export function TaskActions({ taskId, canContinue, showNote }: { taskId: string; canContinue: boolean; /** Say why Stop and steer are not here (a task Cloud did not start, still going). */ showNote: boolean }) {
 const api = useWorkApi(), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ tone: "status" | "alert"; text: string }>(), pending = useRef(false);
 async function proceed() {
  if (pending.current) return;
  pending.current = true;setBusy(true);setMessage(undefined);
  try {
   const result = await api.continueInTool(taskId);
   setMessage({ tone: "status", text: result.kind === "done" ? "Asked Rovara Code to continue in your tool." : "This is waiting for confirmation. Open the task in Rovara Code to go on." });
  } catch (failure) { setMessage({ tone: "alert", text: failure instanceof ApiError ? (failure.code === "NOT_ON_CODE_YET" ? "Continuing in your tool isn't connected to Rovara Code yet." : failure.message) : "Couldn't ask for this. Try again." }); }
  finally { pending.current = false;setBusy(false); }
 }
 return <div className="rv-task-actions">
  <div className="rv-actions">{canContinue && <Button variant="quiet" busy={busy} onClick={() => { void proceed(); }}>Continue in my tool</Button>}</div>
  {showNote && <p className="rv-muted rv-task-actions-note" data-testid="stop-unavailable">Stop and steer work for tasks started in Rovara Cloud. This one was started elsewhere.</p>}
  {message !== undefined && <p role={message.tone} className={message.tone === "alert" ? "rv-error" : "rv-muted"} data-testid="continue-message"><VisibleText text={message.text} /></p>}
 </div>;
}
