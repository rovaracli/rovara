import { useTaskPagePolicy } from "./task-page-policy.js";
import { useRegisterTaskContinue } from "./task-slots.js";
import { runTaskAction, useTaskAction } from "../../api/task-action.js";
import { useRef, useState } from "react";
import { ApiError } from "../../api/errors.js";
import { useWorkApi } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { Menu } from "../../design/Menu.js";
import { TaskContinuationRefusalView, type TaskContinuationRefusalReason } from "./TaskContinuationRefusalView.js";
import { useAppHost } from "../../host.js";
import { useSessionIdentity, useSessionRequest, sessionScope, readSessionIdentity, assertSessionIdentity, isSessionCsrf } from "../../api/session-safety.js";
import type { ReadTask } from "../../api/work.js";
import { VisibleText } from "../../design/VisibleText.js";

/**
 * The task page's own actions beside the session controls: "Continue in my tool" (contract v0 `tasks.continue`) and, for a task Rovara Cloud did not start, the plain
 * reason Stop is not here (Stop is a session control, so it comes with the session). A route that is not connected says so in its own words; nothing is retried.
 */
export function TaskActions({ taskId, sessionId, canContinue, showNote, task }: { taskId: string; sessionId?: string | undefined; task?: ReadTask; canContinue: boolean; /** Say why Stop and steer are not here (a task Cloud did not start, still going). */ showNote: boolean }) {
 const page = useTaskPagePolicy();
 const host = useAppHost(), identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, "continue:" + taskId), api = useWorkApi(), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ tone: "status" | "alert"; text: string }>(), pending = useRef(false);
 const recovery = useTaskAction(host, "continue:" + taskId), [closed, setClosed] = useState(false);
 const refusal: TaskContinuationRefusalReason | undefined = task?.status === "CLOSED" ? "closed" : task?.workflow?.state === "WAITING" && ["PLAN", "PLAN_REVIEW"].includes(task.workflow.stage ?? "") ? "approval" : undefined;
 async function proceed() {
  if (pending.current || closed || !canContinue || refusal !== undefined || identity.data === undefined || saved.scope === undefined || saved.request !== undefined || saved.storageError !== undefined) return;
  pending.current = true;setBusy(true);setMessage(undefined);
  try {
   await readSessionIdentity(host);assertSessionIdentity(host, identity.data);
   const latest = (await api.tasks()).find(row => row.taskId === taskId);
   if (latest === undefined || latest.status === "CLOSED" || latest.workflow?.state === "WAITING") throw new ApiError(403, "FORBIDDEN", "Approve the plan first.");
   assertSessionIdentity(host, identity.data);
   const result = await runTaskAction(host, saved.scope, "continue", { requestId: crypto.randomUUID() }, async request => {
    assertSessionIdentity(host, identity.data!);
    const answer = await api.continueInTool(taskId, request.requestId);
    if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");
    assertSessionIdentity(host, identity.data!);return answer;
   }, sessionId === undefined ? saved.scope : sessionScope(identity.data, sessionId));
   if (result.kind !== "done") throw new ApiError(0, "PENDING", "Rovara didn't confirm this yet. Check the current task before trying again.");

   setMessage({ tone: "status", text: result.kind === "done" ? "Asked Rovara Code to continue in your tool." : "This is waiting for confirmation. Open the task in Rovara Code to go on." });
  } catch (failure) {
      if (isSessionCsrf(failure)) await readSessionIdentity(host).catch(() => undefined);
   setMessage({ tone: "alert", text: failure instanceof ApiError ? (failure.code === "NOT_ON_CODE_YET" ? "Continuing in your tool isn't connected to Rovara Code yet." : failure.message) : "Couldn't ask for this. Try again." }); }
  finally { pending.current = false;setBusy(false); }
 }
 async function check() {
  try {
   const resolved = await recovery.check(async () => (await api.tasks()).find(row => row.taskId === taskId), current => current?.status === "CLOSED");
   if (resolved) { setClosed(true);setMessage({ tone: "status", text: "Rovara now reads this task as closed. The previous continuation no longer applies." }); }
   else setMessage({ tone: "alert", text: "Rovara still hasn't confirmed continuation. No second request was sent." });
  } catch { setMessage({ tone: "alert", text: "Couldn't check this task. Continuation is still unconfirmed." }); }
 }
 // Mock 4d: "Continue in my tool" is a task-level action inside "Task actions", never a loose link beside the title. The button below is the same guarded handler kept for the page's own control inventory (hidden by the page's CSS); the menu entry calls the same proceed().
 const offered = canContinue && refusal === undefined, cannotSend = closed || identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined || busy;
 // DEC 254zzz374: while a plan waits at plan review the entry is drawn blocked with its short reason; it has no handler to send with.
 const waitingForPlan = canContinue && refusal === "approval", waitingReason = "approve the plan first";
 useRegisterTaskContinue(page === undefined || sessionId === undefined ? undefined : offered ? { disabled: cannotSend, onSelect: () => { void proceed(); } } : waitingForPlan ? { disabled: true, reason: waitingReason, onSelect: () => undefined } : undefined);
 const heldMenu = page !== undefined && sessionId === undefined ? <div className="rv-controls-overflow" data-testid="task-actions-menu"><Menu align="end" className="rv-menu-task" trigger={<Button>Task actions</Button>} items={[...(offered ? [{ label: "Continue in my tool", disabled: cannotSend, onSelect: () => { void proceed(); } }] : waitingForPlan ? [{ label: "Continue in my tool (" + waitingReason + ")", disabled: true, onSelect: () => undefined }] : []), { label: "Share (cannot tell yet)", disabled: true, onSelect: () => undefined }, { label: "Close task (cannot tell yet)", disabled: true, onSelect: () => undefined, separatorBefore: true, tone: "danger" as const }]} /></div> : null;
 return <>{heldMenu}<div className="rv-task-actions">
  <div className="rv-actions">{canContinue && refusal === undefined && <Button variant="quiet" className="rv-task-continue" busy={busy} disabled={closed || identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined} onClick={() => { void proceed(); }}>Continue in my tool</Button>}</div>
  {refusal !== undefined && <TaskContinuationRefusalView reason={refusal} taskTitle={task?.title} />}
  {saved.request !== undefined && <p role="status">Rovara didn't confirm this yet. <Button onClick={() => { void check(); }}>Check</Button></p>}
  {showNote && <p className="rv-muted rv-task-actions-note" data-testid="stop-unavailable">Stop and steering are only for tasks started in Rovara Cloud. This task started in another tool.</p>}
  {message !== undefined && <p role={message.tone} className={message.tone === "alert" ? "rv-error" : "rv-muted"} data-testid="continue-message"><VisibleText text={message.text} /></p>}
 </div></>;
}
