import { runTaskAction } from "../../api/task-action.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { useSessionIdentity, useSessionRequest, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest, clearSessionRequest, isSessionCsrf, isFinalSessionRefusal } from "../../api/session-safety.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskCloseProgressStatusView, type TaskCloseProgressStatus } from "./TaskCloseProgressStatusView.js";
type Unpublished = ReadonlyArray<{ repository: string; reasons: readonly string[] }>;
const unpublishedKey = (work: Unpublished) => JSON.stringify(work.map(entry => [entry.repository, [...entry.reasons].sort()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
/** One persisted close request, then read-only checks. Leaving this dialog never retires an unresolved operation. */
export function CloseTaskDialog({ id, open, onOpenChange, trigger, onCloseAutoFocus, onClosed, onChecking, canClose = true }: { id: string; open: boolean; onOpenChange: (open: boolean) => void; trigger?: ReactElement; onCloseAutoFocus?: (event: Event) => void; onClosed: () => Promise<unknown> | void; onChecking?: () => void; canClose?: boolean }) {
 const page = useTaskPagePolicy();
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), sessions = useMemo(() => createTaskSessionApi(host), [host]);
 const identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, id);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [unpublished, setUnpublished] = useState<Unpublished>(), [progress, setProgress] = useState<TaskCloseProgressStatus>("pending");
 const sending = useRef(false), request = saved.request, locked = request !== undefined || saved.storageError !== undefined;
 const [previousOpen, setPreviousOpen] = useState(open);
 if (previousOpen !== open) { setPreviousOpen(open);setUnpublished(undefined); }
 useEffect(() => {
  if (request?.action !== "close") return;
  const timer = window.setTimeout(() => setProgress("slow"), Math.max(0, 360_000 - (Date.now() - request.startedAt)));
  return () => window.clearTimeout(timer);
 }, [request?.action, request?.startedAt]);
 const allowed = canClose && identity.data !== undefined && saved.failure === undefined;
 function matchesShown(work: Unpublished | undefined): boolean {
  if (work !== undefined && unpublished !== undefined && unpublishedKey(work) === unpublishedKey(unpublished)) return true;
  setUnpublished(work);return false;
 }
 async function check() {
  if (sending.current) return;setBusy(true);setError(undefined);
  try {
   const current = await sessions.read(id);query.setQueryData(["session", id], current);
   if (identity.data === undefined || saved.scope === undefined || request?.action !== "close") return;
   assertSessionIdentity(host, identity.data);
   const task = current.body.kind === "task" ? current.body.task : undefined;
   if (task?.status === "CLOSED") { clearSessionRequest(host, saved.scope, request.requestId);setBusy(false);onOpenChange(false);void Promise.resolve().then(onClosed).catch(() => undefined); }
   else if (task?.unpublished !== undefined && task.unpublished.length > 0 && request.body.discardUnpublished !== true && task.closing !== true) { clearSessionRequest(host, saved.scope, request.requestId);setUnpublished(task.unpublished); }
   else { setProgress(Date.now() - request.startedAt >= 360_000 ? "slow" : "pending"); }
  } catch { setError("Couldn't check this task. Closure is still unconfirmed."); }
  finally { setBusy(false); }
 }
 async function close(discard: boolean) {
  if (!allowed || locked || sending.current || identity.data === undefined || saved.scope === undefined) return;
  sending.current = true;setBusy(true);setError(undefined);
  let frozen: FrozenSessionRequest | undefined;
  try {
   const person = await readSessionIdentity(host);
   if (person.companyId !== identity.data.companyId || person.personId !== identity.data.personId) throw new ApiError(0, "IDENTITY_CHANGED", "Identity changed. Check this page again.");
   const latest = await sessions.read(id);query.setQueryData(["session", id], latest);
   if (!latest.you.actions.includes("close")) throw new ApiError(403, "FORBIDDEN", "Close task is no longer available. Check the current task controls.");
   if (discard) {
    const fresh = latest.body.kind === "task" ? latest.body.task.unpublished : undefined;
    if (!matchesShown(fresh)) { setError("The unpublished work changed. Check the new list.");return; }
   }
   assertSessionIdentity(host, person);
   const body = { requestId: crypto.randomUUID(), ...(discard ? { discardUnpublished: true as const } : {}) };
   const result = await runTaskAction(host, saved.scope, "close", body, async request => {
    if (discard) {
     const current = query.getQueryData<typeof latest>(["session", id]), state = query.getQueryState(["session", id]);
     const fresh = state?.status === "success" && state.fetchStatus === "idle" && state.fetchFailureCount === 0 && current?.body.kind === "task" ? current.body.task.unpublished : undefined;
     if (!matchesShown(fresh)) throw new ApiError(403, "CHANGE_STALE", "The unpublished work changed. Check the new list.");
     if (!current?.you.actions.includes("close")) throw new ApiError(403, "FORBIDDEN", "Close task is no longer available. Check the current task controls.");
    }
    frozen = request;assertSessionIdentity(host, person);
    const answer = await api.close(id, request.body as typeof body);assertSessionIdentity(host, person);
    if (answer.kind !== "done" || !answer.value.closed && (discard || !answer.value.unpublished?.length)) throw new ApiError(202, "PENDING", "Rovara didn't confirm closure yet.");
    return answer;
   });
   query.setQueryData(["session", id], result.value.session);
   if (result.value.closed) { setBusy(false);onOpenChange(false);void Promise.resolve().then(onClosed).catch(() => undefined);return; }
   if (!discard && result.value.unpublished !== undefined && result.value.unpublished.length > 0) { setUnpublished(result.value.unpublished);return; }
   // A readable not-closed answer is progress, not permission to start another close.
   setProgress("pending");onChecking?.();
  } catch (failure) {
   if (isSessionCsrf(failure)) {

    setError("Couldn't change that. Nothing was sent. Rovara is checking your identity.");void readSessionIdentity(host).catch(() => undefined);
   } else if (isFinalSessionRefusal(failure)) {

    setError(failure instanceof ApiError ? failure.message : "Couldn't close this task.");
   } else if (frozen !== undefined) setProgress(failure instanceof ApiError && failure.status === 202 ? "pending" : "unconfirmed");
   else setError(failure instanceof ApiError ? failure.message : "Couldn't check the current task controls.");
  } finally { sending.current = false;setBusy(false); }
 }
 const state = progress;
 return <Dialog title={unpublished === undefined ? "Close this task?" : "Discard unpublished work?"} description={unpublished === undefined ? "Rovara frees its workspace and its place in your open-task limit. Work that was published stays where it is." : "This task has work that was never published. Closing it now deletes that work."}
  className="rv-action-dialog" open={open} onOpenChange={onOpenChange} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})} {...(trigger ? { trigger } : {})}>
  {unpublished !== undefined && <ul aria-label="Unpublished work">{unpublished.map(entry => <li key={entry.repository}><VisibleText text={entry.repository} />{entry.reasons.length > 0 && <>: <VisibleText text={entry.reasons.join("; ")} /></>}</li>)}</ul>}
  {!allowed && <p role="alert">Current identity or task controls are unavailable. Check the task before closing it.</p>}
  {request?.action === "close" && <TaskCloseProgressStatusView taskId={id} state={state} onCheck={check} />}
  {saved.storageError && <p role="alert">{saved.storageError}</p>}
  <div className="rv-actions"><Button variant={page === undefined ? "secondary" : "primary"} onClick={() => onOpenChange(false)}>{busy || locked ? "Close this window" : "Keep it open"}</Button><Button variant="danger" busy={busy} disabled={!allowed || locked} onClick={() => { void close(unpublished !== undefined); }}>{unpublished === undefined ? "Close task" : "Discard it and close"}</Button></div>
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </Dialog>;
}
