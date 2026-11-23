import { runTaskAction, isFinalTaskActionRefusal, useTaskAction } from "../../api/task-action.js";
import { useQuery } from "@tanstack/react-query";
import type { SessionBoundCloseBody, TaskClosePreview } from "@agentx/contracts/web";
import { chooseCloseView, isRetainedCloseRefusal, NOT_CHECKED_WORDS, reasonWords, RETAINED_CLOSE_LEAD, RETAINED_CLOSE_LINK, RETAINED_CLOSE_TAIL, type CloseView } from "./close-preview.js";
import { ClosePreviewView } from "./ClosePreviewView.js";
import "./close-preview.css";
import { recordUnknownActionCheck, useUnknownActionExit } from "../../safe-action.js";
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
/** Interim data-loss warning: a live Close deletes the task's machine and workspace with no unpublished-work check. Always shown before Close can be pressed. */
const CLOSE_DATA_LOSS_WARNING = "Closing deletes this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.";
type Unpublished = ReadonlyArray<{ repository: string; reasons: readonly string[] }>;
/** One number per open and per mount: the preview reads are keyed by it, so no earlier open's preview is ever shown or bound. */
let openings = 0;
const nextOpening = () => ++openings;
const FOUND_WORK = "Rovara found unpublished work in this workspace. Review what would be discarded before deciding.";
const unpublishedKey = (work: Unpublished) => JSON.stringify(work.map(entry => [entry.repository, [...entry.reasons].sort()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
/** One persisted close request, then read-only checks. Leaving this dialog never retires an unresolved operation. */
export function CloseTaskDialog({ id, open, onOpenChange, trigger, onCloseAutoFocus, onClosed, onChecking, canClose = true }: { id: string; open: boolean; onOpenChange: (open: boolean) => void; trigger?: ReactElement; onCloseAutoFocus?: (event: Event) => void; onClosed: () => Promise<unknown> | void; onChecking?: () => void; canClose?: boolean }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), sessions = useMemo(() => createTaskSessionApi(host), [host]);
 const identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, id);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [unpublished, setUnpublished] = useState<Unpublished>(), [progress, setProgress] = useState<TaskCloseProgressStatus>("pending");
 const sending = useRef(false), request = saved.request, locked = request !== undefined || saved.storageError !== undefined;
 const [retained, setRetained] = useState(false), [opening, setOpening] = useState(nextOpening);
 // DEC 285: an unresolved close is never cleared or resent by a Check; after three unconfirmed Checks or ten minutes the person is offered the task page to look.
 const unknown = useTaskAction(host, id), exit = useUnknownActionExit(unknown.recovery.fence, unknown.recovery.entry, host.currentPath());
 const unconfirmed = () => { if (unknown.recovery.entry !== undefined) recordUnknownActionCheck(unknown.recovery.fence, unknown.recovery.entry); };
 const [previousOpen, setPreviousOpen] = useState(open);
 if (previousOpen !== open) { setPreviousOpen(open);setUnpublished(undefined);setRetained(false);setOpening(nextOpening()); }
 // The Close preview (DEC 254zzz367): read fresh on every open (a new key per open and per mount), never reused (a digest names one moment), never refetched behind the person's back.
 const person = identity.data === undefined ? undefined : identity.data.companyId + "/" + identity.data.personId;
 const previewReads = { staleTime: 0, gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
 const previewOn = open && canClose && person !== undefined;
 const closeRead = useQuery({ queryKey: ["close-preview", person, id, opening, "close"], enabled: previewOn, queryFn: () => api.previewClose(id, "close"), ...previewReads });
 const needsDiscard = closeRead.data?.preview != null && closeRead.data.preview.unpublished.length > 0;
 const discardRead = useQuery({ queryKey: ["close-preview", person, id, opening, "discard"], enabled: previewOn && needsDiscard, queryFn: () => api.previewClose(id, "discard"), ...previewReads });
 const view: CloseView = !previewOn ? { kind: "reading" } : chooseCloseView(closeRead, discardRead);
 useEffect(() => { if (!open) query.removeQueries({ queryKey: ["close-preview"] }); }, [open, query]);
 const rereadPreview = () => { void closeRead.refetch();if (needsDiscard) void discardRead.refetch(); };
 // With a served preview the discard is bound to it: the legacy list (and its unbound second ask) belongs only to a Code without the preview route.
 const kind = view.kind, legacyList = unpublished !== undefined && (!previewOn || kind === "legacy" || kind === "reading") ? unpublished : undefined;
 // A first ask that found unpublished work: where a preview is served, read it again so the discard is shown (and bound) from it.
 const foundWork = (list: Unpublished) => { setUnpublished(list);if (kind !== "legacy" && kind !== "reading") void closeRead.refetch(); };
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
   // A close bound to a preview names the work the person saw: findings appearing later never turn it into a first ask.
   const bound = Object.hasOwn(request.body, "expectedPreviewDigest");
   if (task?.status === "CLOSED") { clearSessionRequest(host, saved.scope, request.requestId);setBusy(false);onOpenChange(false);void Promise.resolve().then(onClosed).catch(() => undefined); }
   else if (!bound && task?.unpublished !== undefined && task.unpublished.length > 0 && request.body.discardUnpublished !== true && task.closing !== true) {
    clearSessionRequest(host, saved.scope, request.requestId);
    foundWork(task.unpublished);
   }
   else if (task?.closing === true) { setProgress("closing");unconfirmed(); }
   else { setProgress(Date.now() - request.startedAt >= 360_000 ? "slow" : "pending");unconfirmed(); }
  } catch { setError("Couldn't check this task. Closure is still unconfirmed.");unconfirmed(); }
  finally { setBusy(false); }
 }
 async function close(discard: boolean) {
  if (!allowed || locked || sending.current || identity.data === undefined || saved.scope === undefined) return;
  // The legacy ask only where the preview said so: Code has no preview route (legacy), or has not inspected the workspace yet (inspect, first ask only).
  if (kind !== "legacy" && !(kind === "inspect" && !discard)) return;
  sending.current = true;setBusy(true);setError(undefined);setRetained(false);
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
   if (!discard && result.value.unpublished !== undefined && result.value.unpublished.length > 0) {
    foundWork(result.value.unpublished);return;
   }
   // A readable not-closed answer is progress, not permission to start another close.
   setProgress("pending");onChecking?.();
  } catch (failure) {
   if (isSessionCsrf(failure)) {

    setError("Couldn't change that. Nothing was sent. Rovara is checking your identity.");void readSessionIdentity(host).catch(() => undefined);
   } else if (isRetainedCloseRefusal(failure) && isFinalTaskActionRefusal(failure)) {
    // DEC 254zzz347: refused before anything was written. Code's words, with its /v1/dev link replaced by the Cloud preview.
    setRetained(true);
   } else if (isFinalSessionRefusal(failure) || isFinalTaskActionRefusal(failure)) {

    setError(failure instanceof ApiError ? failure.message : "Couldn't close this task.");
   } else if (frozen !== undefined) setProgress(failure instanceof ApiError && failure.status === 202 ? "pending" : "unconfirmed");
   else setError(failure instanceof ApiError ? failure.message : "Couldn't check the current task controls.");
  } finally { sending.current = false;setBusy(false); }
 }
 /** The bound close (DEC 254zzz367): exactly the digest of the preview on screen, and the discard flag only when that preview IS the discard preview. */
 async function closeBound(shown: TaskClosePreview) {
  if (!allowed || locked || sending.current || identity.data === undefined || saved.scope === undefined) return;
  // Only the preview on screen, fresh and fully read, may be bound; never a kept (reconnecting) one.
  if (view.kind !== "review" || view.preview !== shown || view.staleSince !== undefined || closeRead.isFetching || discardRead.isFetching) return;
  const discard = shown.action === "discard";
  if (!discard && shown.unpublished.length > 0) return;
  sending.current = true;setBusy(true);setError(undefined);setRetained(false);
  let frozen: FrozenSessionRequest | undefined, accepted = false;
  try {
   const caller = await readSessionIdentity(host);
   if (caller.companyId !== identity.data.companyId || caller.personId !== identity.data.personId) throw new ApiError(0, "IDENTITY_CHANGED", "Identity changed. Check this page again.");
   const latest = await sessions.read(id);query.setQueryData(["session", id], latest);
   if (!latest.you.actions.includes("close")) throw new ApiError(403, "FORBIDDEN", "Close task is no longer available. Check the current task controls.");
   assertSessionIdentity(host, caller);
   const body = { requestId: crypto.randomUUID(), expectedPreviewDigest: shown.digest, ...(discard ? { discard_unpublished: true as const } : {}) } satisfies SessionBoundCloseBody;
   const result = await runTaskAction(host, saved.scope, "close", body, async sent => {
    frozen = sent;assertSessionIdentity(host, caller);
    // The frozen body is what is sent, byte for byte; the adapter only validates it.
    const answer = await api.closeBound(id, sent.body as SessionBoundCloseBody);assertSessionIdentity(host, caller);
    if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm closure yet.");
    if (!answer.value.closed) { accepted = true;query.setQueryData(["session", id], answer.value.session);throw new ApiError(202, "PENDING", "Rovara accepted the close and is closing the task."); }
    return answer;
   });
   query.setQueryData(["session", id], result.value.session);
   setBusy(false);onOpenChange(false);void Promise.resolve().then(onClosed).catch(() => undefined);
  } catch (failure) {
   if (isSessionCsrf(failure)) {
    setError("Couldn't change that. Nothing was sent. Rovara is checking your identity.");void readSessionIdentity(host).catch(() => undefined);
   } else if (isFinalSessionRefusal(failure) || isFinalTaskActionRefusal(failure)) {
    // Refused before anything was closed. A digest that no longer matches means the facts moved: read the preview again before any new press.
    setError(failure instanceof ApiError ? failure.message : "Couldn't close this task.");
    if (failure instanceof ApiError && failure.code === "CHANGE_STALE") rereadPreview();
   } else if (frozen !== undefined) { setProgress(accepted ? "closing" : failure instanceof ApiError && failure.status === 202 ? "pending" : "unconfirmed");if (accepted) onChecking?.(); }
   else setError(failure instanceof ApiError ? failure.message : "Couldn't check the current task controls.");
  } finally { sending.current = false;setBusy(false); }
 }
 const state = progress;
 const showPreview = previewOn && view.kind !== "legacy", reviewing = view.kind === "review" && showPreview, discarding = legacyList !== undefined || (reviewing && view.discard);
 const previewBusy = closeRead.isFetching || discardRead.isFetching;
 const reconnectingSince = "staleSince" in view ? view.staleSince : undefined;
 // Where Code cannot show the preview the person is told so, and never that a check happens.
 const unchecked = (kind === "legacy" || kind === "inspect") && previewOn;
 const sendsLegacy = !showPreview || view.kind === "inspect" || view.kind === "reading";
 return <Dialog title={discarding ? "Discard unpublished work?" : "Close this task?"} description={discarding ? "This task has work that was never published. Closing it now deletes that work." : CLOSE_DATA_LOSS_WARNING}
  className="rv-action-dialog" open={open} onOpenChange={onOpenChange} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})} {...(trigger ? { trigger } : {})}>
  {legacyList !== undefined && <ul aria-label="Unpublished work">{legacyList.map(entry => <li key={entry.repository}><VisibleText text={entry.repository} />{entry.reasons.length > 0 && <>: <VisibleText text={entry.reasons.join("; ")} /></>}</li>)}</ul>}
  {!allowed && <p role="alert">Current identity or task controls are unavailable. Check the task before closing it.</p>}
  {request?.action === "close" && <TaskCloseProgressStatusView taskId={id} state={state} onCheck={check} />}
  {request?.action === "close" && exit !== undefined && <p role="status">We couldn't confirm this. <a href={exit.href}>Open the task to check</a></p>}
  {saved.storageError && <p role="alert">{saved.storageError}</p>}
  {showPreview && !locked && <>
   {view.kind === "reading" && <p className="rv-close-note" role="status">Reading what closing will keep and discard…</p>}
   {view.kind === "denied" && <p className="rv-close-note" role="alert">This task isn't available to you.</p>}
   {view.kind === "unreadable" && <p className="rv-close-note" role="alert">Couldn't read the Close preview. Nothing was closed.</p>}
   {view.kind === "busy" && <p className="rv-close-note" role="status">Rovara is working on this workspace right now, so there is no preview yet.</p>}
   {view.kind === "changed" && <p className="rv-close-note" role="status">This task changed while you were reviewing it. Read the preview again.</p>}
   {view.kind === "discard_unavailable" && <><p className="rv-close-note" role="status">This workspace has work that was never published, but Rovara can't show the full list to discard yet. Closing is not possible from here until the full list can be shown.</p><ul aria-label="Unpublished work">{view.findings.map(entry => <li key={entry.repository}><strong><VisibleText text={entry.repository} /></strong>: <VisibleText text={reasonWords(entry.reasons)} /></li>)}</ul></>}
   {view.kind === "review" && <ClosePreviewView preview={view.preview} discard={view.discard} />}
   {(reconnectingSince !== undefined || view.kind === "unreadable" || view.kind === "busy" || view.kind === "changed" || view.kind === "discard_unavailable") && <p className="rv-close-note rv-close-reread">
    {reconnectingSince !== undefined && <span className="rv-muted" role="status">Updated {new Date(reconnectingSince).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · Reconnecting</span>}
    <Button variant="quiet" disabled={previewBusy} onClick={rereadPreview}>{view.kind === "unreadable" || reconnectingSince !== undefined ? "Try again" : "Check again"}</Button></p>}
  </>}
  {unchecked && legacyList === undefined && !locked && <p className="rv-close-note">{NOT_CHECKED_WORDS}</p>}
  {unpublished !== undefined && legacyList === undefined && <p className="rv-close-note" role="status">{FOUND_WORK}</p>}
  {retained && <p className="rv-close-note" role="alert">{RETAINED_CLOSE_LEAD}<button type="button" className="rv-close-link" disabled={previewBusy} onClick={rereadPreview}>{RETAINED_CLOSE_LINK}</button>{RETAINED_CLOSE_TAIL}</p>}
  <div className="rv-actions"><Button variant="primary" {...(!discarding && !busy && !locked ? { autoFocus: true } : {})} onClick={() => onOpenChange(false)}>{busy || locked ? "Close this window" : discarding ? "Keep it open" : "Cancel"}</Button>
   {view.kind !== "denied" && (reviewing || sendsLegacy || locked) && <Button variant="danger" busy={busy} disabled={!allowed || locked || (showPreview && (view.kind === "reading" || previewBusy && view.kind !== "inspect" || reconnectingSince !== undefined))}
    onClick={() => { if (view.kind === "review") void closeBound(view.preview); else void close(legacyList !== undefined); }}>{discarding ? "Discard it and close" : "Close and delete the machine"}</Button>}</div>
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </Dialog>;
}
