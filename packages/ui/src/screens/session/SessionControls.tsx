import { useTaskPagePolicy } from "./task-page-policy.js";
import { useTaskContinueEntry, useTaskStopSlot } from "./task-slots.js";
import { useLegacyRetryRequest, useLegacyTakeOverRequest } from "../../api/session-retry-compat.js";
import { isFinalTaskActionRefusal, runTaskAction, useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
import { createPortal } from "react-dom";
import { Suspense, lazy, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { createSessionActions } from "../../api/session-actions.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { useSessionIdentity, useSessionRequest, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest, clearSessionRequest, updateSessionRequest, readFrozenSessionRequest, isCurrentSessionRead, isSessionCsrf, isFinalSessionRefusal } from "../../api/session-safety.js";
import { createPeopleApi } from "../../api/people.js";
import { ApiError } from "../../api/errors.js";
import { statusWords, type ReadSession } from "./SessionHeader.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Menu, type MenuItem } from "../../design/Menu.js";
import { MakeAgentDialog } from "../agents/MakeAgentDialog.js";
import { CloseTaskDialog } from "./CloseTaskDialog.js";
import { ShareDialog } from "./ShareDialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskSessionControlOutcomeView, type TaskSessionControlOutcomeKind } from "./TaskSessionControlOutcomeView.js";
/** Hosted Stop on a running step ends the task's machine and deletes its workspace (Code cancel -> machines.stop -> terminate). Always shown before Stop can be pressed there. */
const STOP_DATA_LOSS_WARNING = "Stopping now ends this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.";
/** Statuses that say no step is running: a Stop then touches nothing. Anything else (running, starting, paused for budget, or unknown) is treated as running so the warning is never skipped. */
const NO_STEP_RUNNING = ["needs_person", "waiting", "stopped", "succeeded", "failed", "cancelled"];
// Ask about this task is its own chunk: it is fetched only where the session view offers it.
const AskPanel = lazy(async () => ({ default: (await import("./AskPanel.js")).AskPanel }));
export function SessionControls({ id, agent, actions: offeredActions, following, onChanged, where, status, responsive = false, share, makeAgent = false, ask = false, onPeopleShare }: { id: string; agent: string; actions: readonly string[]; following: boolean; onChanged: () => Promise<unknown>; /** Where the session runs, as the read says it. Only a Mac keeps the folder on Stop; anything else (cloud, or not told) is treated as hosted. */ where?: { kind: string }; /** The session's status as read. Only a status that positively says no step is running softens the Stop warning. */ status?: string; responsive?: boolean; share?: { orgName: string }; makeAgent?: boolean; ask?: boolean; /** D8: when the page has a People panel, Share asks it to open (add a viewer) if Code serves this task's People list; otherwise Share is what it always was. */ onPeopleShare?: () => void }) {
 const page = useTaskPagePolicy(), stopSlot = useTaskStopSlot(), continueEntry = useTaskContinueEntry();
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), sessions = useMemo(() => createTaskSessionApi(host), [host]);
 const identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, id), key = ["session", id];
 const takeOverSaved = useSessionRequest(host, identity.data, "take_over:" + id);
 const confirmation = takeOverSaved.request?.confirmation;
 const pendingConfirmation = takeOverSaved.scope !== undefined && takeOverSaved.request !== undefined && confirmation != null && ["needs_confirmation", "needs_admin_approval"].includes(confirmation.kind) ? { scope: takeOverSaved.scope, requestId: takeOverSaved.request.requestId, result: confirmation } : undefined;
 const retrySaved = useSessionRequest(host, identity.data, "retry:" + id);
 const retryRecovery = useTaskAction(host, "retry:" + id);
 const legacyTakeOver = useLegacyTakeOverRequest(host, identity.data, id, saved.request);
 const legacyRetry = useLegacyRetryRequest(host, identity.data, id, saved.request);
 // Keep the fetched object for the body-bound fence; a cache-only update cannot confirm ownership.
 const current = useQuery<ReadSession>({ queryKey: key, queryFn: () => sessions.read(id), enabled: pendingConfirmation !== undefined, ...(pendingConfirmation === undefined ? {} : { structuralSharing: false }) });
 const retryWorkflow = current.data?.body.kind === "task" ? current.data.body.task.workflow : undefined;
 const stepRetry = retryWorkflow?.state === "BLOCKED" && retryWorkflow.stage !== "REVIEW";
 const retryPins = retryWorkflow?.revision === undefined || (!stepRetry && retryWorkflow.candidate?.digest === undefined) ? undefined : { expectedRevision: retryWorkflow.revision, ...(stepRetry ? {} : { candidateDigest: retryWorkflow.candidate!.digest }) };
 const retryLabel = stepRetry ? "Retry the step" : "Retry";
 const held = page === undefined ? [] : offeredActions.filter(action => action === "retry" && retryPins === undefined);
 const actions = offeredActions.filter(action => !held.includes(action));
 const [busy, setBusy] = useState(false), [stopOpen, setStopOpen] = useState(false), [takeOverOpen, setTakeOverOpen] = useState(false), [error, setError] = useState<string>();
 const [message, setMessage] = useState<{ text: string; revision: number; following?: boolean }>(), sending = useRef(false), takingOver = useRef(false);
 const [takeOverBusy, setTakeOverBusy] = useState(false);
 const request = saved.request ?? retrySaved.request ?? legacyRetry.request ?? takeOverSaved.request ?? legacyTakeOver.request, outcome: TaskSessionControlOutcomeKind | undefined = request === undefined || request.action === "close" && page === undefined ? undefined : request.action === "watch" ? "follow-unconfirmed" : request.action === "take_over" ? "ownership-unavailable" : "action-unconfirmed";
 // DEC 285: the saved press supplies the deadline even after a reload. The
 // hint never clears the request, resends it, or shares Stop's pending subject.
 const takeOverPending = takeOverSaved.request ?? legacyTakeOver.request;
 const deadline = takeOverPending === undefined ? NaN : takeOverPending.startedAt + 10 * 60_000;
 const takeOverElapsed = useSyncExternalStore(useCallback(listener => {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return () => undefined;
  const timer = setTimeout(listener, remaining);return () => { clearTimeout(timer); };
 }, [deadline]), () => Date.now() >= deadline, () => false);
 const takeOverExit = takeOverPending !== undefined && ((takeOverPending.unknownChecks ?? 0) >= 3 || takeOverElapsed);
 const allowed = identity.data !== undefined && !current.isError && saved.failure === undefined && saved.storageError === undefined;
 const disabled = busy || !allowed || saved.request !== undefined;
 const takeOverDisabled = disabled || legacyTakeOver.request !== undefined || legacyTakeOver.storageError !== undefined || takeOverBusy || takeOverSaved.request !== undefined || takeOverSaved.storageError !== undefined || takeOverSaved.failure !== undefined;
 const retryDisabled = disabled || legacyRetry.request !== undefined || legacyRetry.storageError !== undefined || retrySaved.request !== undefined || retrySaved.storageError !== undefined || retrySaved.failure !== undefined;
 const takeOverRead = useQuery({ queryKey: [...key, "people"], enabled: takeOverOpen, staleTime: 0, retry: false, queryFn: () => createPeopleApi(host).list(id) });
 const shownPeople = takeOverOpen && !takeOverRead.isError && !takeOverRead.isFetching ? takeOverRead.data?.people : undefined;
 async function run(action: "watch" | "stop" | "retry" | "take_over") {
  const target = action === "retry" ? retrySaved : action === "take_over" ? takeOverSaved : saved;
  const inFlight = action === "take_over" ? takingOver : sending;
  if (action === "take_over" && (legacyTakeOver.request !== undefined || legacyTakeOver.storageError !== undefined)) return;
  if (action === "retry" && (legacyRetry.request !== undefined || legacyRetry.storageError !== undefined)) return;
  if (!allowed || !actions.includes(action) || inFlight.current || saved.request !== undefined || target.request !== undefined || target.storageError !== undefined || identity.data === undefined || target.scope === undefined) return;
  // Capture the DISPLAYED task before the authority re-read below can update
  // the cache. A re-read may deny sending; it never supplies consent's pins.
  if (page !== undefined && action === "retry" && retryPins === undefined) { setError("Cannot tell yet");return; }
  if (action === "take_over" && shownPeople === undefined) return;
  const expectedPeopleRevision = shownPeople?.revision;
  inFlight.current = true;if (action === "take_over") setTakeOverBusy(true);else setBusy(true);setError(undefined);setMessage(undefined);
  let frozen: FrozenSessionRequest | undefined;
  try {
   const person = await readSessionIdentity(host);
   if (person.companyId !== identity.data.companyId || person.personId !== identity.data.personId) throw new ApiError(0, "IDENTITY_CHANGED", "Identity changed. Check this page again.");
   const latest = await sessions.read(id);
   query.setQueryData(key, latest);
   if (!latest.you.actions.includes(action)) { setError("This session action is no longer available. Check the current controls.");return; }
   const latestWorkflow = latest.body.kind === "task" ? latest.body.task.workflow : undefined;
   if (action === "retry" && stepRetry && (latestWorkflow?.revision !== retryPins?.expectedRevision || latestWorkflow?.stage !== retryWorkflow.stage || latestWorkflow?.state !== "BLOCKED")) { setError("This step changed since you read it. Read the task again.");return; }
   assertSessionIdentity(host, person);
   const body = { requestId: crypto.randomUUID(), ...(action === "take_over" ? { expectedPeopleRevision } : {}), ...(action === "watch" ? { following: !latest.you.following } : {}), ...(action === "retry" ? { priorRevision: current.data?.revision ?? latest.revision, priorStatus: current.data?.status ?? latest.status, ...retryPins } : {}) };
   const result = await runTaskAction(host, target.scope, action, body, async request => {
    frozen = request;assertSessionIdentity(host, person);
    if (action === "take_over" && (saved.scope === undefined || legacyTakeOver.scope === undefined || readFrozenSessionRequest(host, saved.scope)?.action === "take_over" || readFrozenSessionRequest(host, legacyTakeOver.scope) !== undefined)) throw new ApiError(409, "CHANGE_STALE", "The previous Take over is still unconfirmed. Check before trying again.");
    if (action === "retry" && (saved.scope === undefined || legacyRetry.scope === undefined || readFrozenSessionRequest(host, saved.scope)?.action === "retry" || readFrozenSessionRequest(host, legacyRetry.scope) !== undefined)) throw new ApiError(409, "CHANGE_STALE", "The previous Retry is still unconfirmed. Check before retrying again.");
    if (action === "watch") {
     const sent = await (latest.you.following ? api.unfollow(id) : api.follow(id));
     if (sent.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");
     assertSessionIdentity(host, person);return { kind: "watch" as const, value: sent.value };
    }
    const sent = await (action === "stop" ? api.stop(id, request.requestId) : action === "retry" ? api.retry(id, request.requestId, retryPins) : api.takeOver(id, expectedPeopleRevision!, request.requestId));
    if (sent.kind !== "done") {
     assertSessionIdentity(host, person);
     if (action === "take_over") updateSessionRequest(host, target.scope!, request.requestId, { confirmation: sent });
     throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");
    }
    assertSessionIdentity(host, person);return { kind: "control" as const, value: sent.value };
   }, saved.scope);
   if (result.kind === "watch") {
    const following = result.value.following;
    query.setQueryData<ReadSession>(key, { ...latest, you: { ...latest.you, following } });
    setMessage({ text: following ? "Following this session." : "No longer following this session.", revision: latest.revision, following });
   } else {
    if (action === "take_over") { setTakeOverOpen(false);if (result.value.session.you.owner) setMessage({ text: "You now own this session.", revision: result.value.session.revision }); }
    query.setQueryData(key, result.value.session);
    if (action === "retry") { void onChanged().catch(() => undefined);host.navigate("/s/" + SessionIdSchema.parse(result.value.session.sessionId));return; }
    if (action === "stop") { setStopOpen(false);setMessage({ text: result.value.stop === "NOTHING_RUNNING" ? result.value.message ?? "Nothing was running to stop." : "Stop requested.", revision: result.value.session.revision }); }
   }
   void onChanged().catch(() => undefined);
  } catch (failure) {
   if (action === "take_over" && frozen !== undefined && !(failure instanceof ApiError && failure.status === 409 && isFinalSessionRefusal(failure))) setTakeOverOpen(false);
   if (isSessionCsrf(failure)) {

    setError("Couldn't change that. Nothing was sent. Rovara is checking your identity.");
    void readSessionIdentity(host).catch(() => undefined);void query.invalidateQueries({ queryKey: key }).catch(() => undefined);
   } else if (isFinalSessionRefusal(failure) || isFinalTaskActionRefusal(failure)) {

    setError(failure instanceof ApiError ? failure.message : "Couldn't change this session.");
    void sessions.read(id).then(view => { query.setQueryData(key, view); }).catch(() => undefined);
   } else if (frozen === undefined) setError(failure instanceof ApiError ? failure.message : "Couldn't check the current controls.");
   // A refused revision requires another displayed People read before a new explicit press.
   if (action === "take_over" && failure instanceof ApiError && failure.status === 409) void query.invalidateQueries({ queryKey: [...key, "people"] }).catch(() => undefined);
  } finally { inFlight.current = false;if (action === "take_over") setTakeOverBusy(false);else setBusy(false); }
 }
 const [shareOpen, setShareOpen] = useState(false), [makeOpen, setMakeOpen] = useState(false), [closeOpen, setCloseOpen] = useState(false);
 const menuTrigger = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null), openingModal = useRef(false);
 function restoreFocus(event: Event) { openingModal.current = false;if (returnFocus.current?.isConnected) { event.preventDefault();returnFocus.current.focus(); }returnFocus.current = null; }
 async function checkOutcome() {
  setError(undefined);
  let resolved = false;
  // Read-only, issue-ordered recovery uses the workflow's own revision. Cloud's
  // session-record revision need not change when Code advances a step.
  if (retrySaved.request !== undefined && typeof retrySaved.request.body.expectedRevision === "number") {
   try {
    const settled = await retryRecovery.check(async () => { const view = await sessions.read(id);query.setQueryData(key, view);return view; }, (view, pending) => view.body.kind === "task" && typeof pending.body.expectedRevision === "number" && (view.body.task.workflow?.revision ?? 0) > pending.body.expectedRevision && view.body.task.workflow?.state !== "BLOCKED" && !view.you.actions.includes("retry"));
    if (!settled) setError("Rovara still hasn't confirmed this. Check again before trying another action.");
   } catch { setError("Couldn't check this session. The previous request is still unconfirmed."); }
   return;
  }
  const requestScope = saved.request === request ? saved.scope : retrySaved.request === request ? retrySaved.scope : takeOverSaved.request === request ? takeOverSaved.scope : legacyTakeOver.request === request ? legacyTakeOver.scope : legacyRetry.scope;
  try {
   await legacyRetry.migrate();await legacyTakeOver.migrate();
   const view = await sessions.read(id);query.setQueryData(key, view);
   if (request === undefined || saved.scope === undefined || identity.data === undefined) return;
   assertSessionIdentity(host, identity.data);
   const observed = request.action === "watch" ? view.you.following === request.body.following : request.action === "take_over" ? view.you.owner : request.action === "stop" ? ["succeeded", "failed", "cancelled"].includes(view.status) : request.action === "close" ? view.body.kind === "task" && view.body.task.status === "CLOSED" : request.action === "retry" && typeof request.body.priorRevision === "number" && view.revision > request.body.priorRevision && view.status !== request.body.priorStatus && !view.you.actions.includes("retry");
   if (observed && requestScope !== undefined) { clearSessionRequest(host, requestScope, request.requestId);resolved = true;setMessage({ text: request.action === "close" ? "Rovara now reads this task as closed." : request.action === "watch" ? (view.you.following ? "Rovara now reads this as followed." : "Rovara now reads this as not followed.") : request.action === "take_over" ? "Rovara now reads you as the owner." : "Rovara now reads this session as " + statusWords(view.status) + ".", revision: view.revision }); }
   else setError("Rovara still hasn't confirmed this. Check again before trying another action.");
  } catch { setError("Couldn't check this session. The previous request is still unconfirmed."); }
  finally {
   if (!resolved && request?.action === "take_over" && requestScope !== undefined) {
    try { updateSessionRequest(host, requestScope, request.requestId, { unknownCheck: true }); }
    catch { setError("Couldn't save this check. The previous request is still unconfirmed."); }
   }
  }
 }
 // D8: a task whose People list Code serves is shared by adding a viewer in the People panel; anything else (Code answers no list, or fails) keeps Share's own dialog.
 async function requestShare() {
  try { await query.fetchQuery({ queryKey: [...key, "people"], queryFn: () => createPeopleApi(host).list(id), staleTime: 0, retry: false }); }
  catch { openingModal.current = true;setShareOpen(true);return; }
  onPeopleShare?.();
 }
 function handleMenuSelect(action: "watch" | "take_over" | "retry" | "share" | "stop" | "make_agent" | "close") {
  if (action === "share" && onPeopleShare !== undefined) { returnFocus.current = menuTrigger.current;void requestShare();return; }
  if (action === "stop" || action === "share" || action === "make_agent" || action === "close" || action === "take_over") { openingModal.current = true;returnFocus.current = menuTrigger.current;if (action === "take_over") { setError(undefined);setTakeOverOpen(true); }else if (action === "stop") setStopOpen(true);else if (action === "share") setShareOpen(true);else if (action === "close") setCloseOpen(true);else setMakeOpen(true); }
  else void run(action);
 }
 const heldItems: MenuItem[] = page === undefined ? [] : held.flatMap(action => action === "close" ? ["Close task", "Discard", "Discard it and close"] : [action === "share" ? "Share" : action === "retry" ? "Retry" : "Take over"]).map(label => ({ label: label + " (cannot tell yet)", disabled: true, onSelect: () => undefined }));
 // A blocked Continue entry (it carries the reason "approve the plan first") only explains itself inside a menu that exists for other reasons; it never makes a menu on its own.
 const continueOffered = continueEntry !== undefined && continueEntry.reason === undefined;
 const hasMenuActions = heldItems.length > 0 || continueOffered || actions.some(action => ["watch", "take_over", "retry", "stop", "close"].includes(action) || (action === "share" && share !== undefined) || (action === "make_agent" && makeAgent));
 // The task page sets Stop and Close apart from the everyday items with one rule (mock 4d); Close task is the destructive tone.
 const everyday = heldItems.length > 0 || continueOffered || actions.includes("watch") || actions.includes("take_over") || actions.includes("retry") || (actions.includes("share") && share !== undefined) || (actions.includes("make_agent") && makeAgent);
 const items: MenuItem[] = [
  ...heldItems,
  ...(actions.includes("watch") ? [{ label: following ? "Following" : "Follow", disabled, onSelect: () => handleMenuSelect("watch") }] : []),
  ...(actions.includes("take_over") ? [{ label: "Take over", disabled: takeOverDisabled, onSelect: () => handleMenuSelect("take_over") }] : []),
  ...(actions.includes("retry") ? [{ label: retryLabel, disabled: retryDisabled, onSelect: () => handleMenuSelect("retry") }] : []),
  ...(actions.includes("share") && share !== undefined ? [{ label: "Share", disabled, onSelect: () => handleMenuSelect("share") }] : []),
  ...(continueEntry !== undefined ? [{ label: continueEntry.reason === undefined ? "Continue in my tool" : "Continue in my tool (" + continueEntry.reason + ")", disabled: continueEntry.disabled, onSelect: continueEntry.onSelect }] : []),
  ...(actions.includes("make_agent") && makeAgent ? [{ label: "Make this an agent", disabled, onSelect: () => handleMenuSelect("make_agent") }] : []),
  ...(actions.includes("stop") ? [{ label: "Stop", disabled, onSelect: () => handleMenuSelect("stop"), ...(page !== undefined && everyday ? { separatorBefore: true } : {}) }] : []),
  ...(actions.includes("close") ? [{ label: "Close task", disabled, onSelect: () => handleMenuSelect("close"), ...(page === undefined ? {} : { tone: "danger" as const }), ...(page !== undefined && everyday && !actions.includes("stop") ? { separatorBefore: true } : {}) }] : []),
 ];
 const stopHosted = where?.kind !== "mac", stopWarned = stopHosted && (status === undefined || !NO_STEP_RUNNING.includes(status));
 const stopDialog = (actions.includes("stop") || stopOpen) ? <Dialog className="rv-action-dialog" title="Stop this session?" description={stopWarned ? STOP_DATA_LOSS_WARNING : page === undefined ? agent + " stops after its current step. If the task is blocked instead of running, Stop ends it and frees its workspace only while no code has been written; after that, use Close task." : "Stops the task's current work"} onCloseAutoFocus={restoreFocus} open={stopOpen} onOpenChange={value => { if (!busy) setStopOpen(value); }} trigger={<Button className="rv-task-stop" disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>{stopSlot === null ? "Stop" : "Stop work"}</Button>}>{!stopWarned && page !== undefined && <p className="rv-muted">{stopHosted ? "Nothing is running right now. If a step is running when you press Stop, it ends this task's machine and changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered." : "Files are kept. Rovara stops after its current step."}</p>}<div className="rv-actions"><Button variant={page === undefined ? "secondary" : "primary"} disabled={busy} {...(stopWarned && !busy ? { autoFocus: true } : {})} onClick={() => setStopOpen(false)}>{stopWarned ? "Cancel" : "Keep running"}</Button><Button variant="danger" busy={busy} disabled={disabled || !actions.includes("stop")} onClick={() => { void run("stop"); }}>{stopWarned ? "Stop and end the machine" : "Stop session"}</Button></div>{!allowed && <p role="alert">Current identity or task controls are unavailable. Check the session before acting.</p>}{outcome && <TaskSessionControlOutcomeView kind={outcome} check={<Button onClick={() => { void checkOutcome(); }}>Check</Button>} />}{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog> : null;
 const stopControl = stopDialog === null || stopSlot === null ? stopDialog : createPortal(stopDialog, stopSlot);
 return <div className="rv-session-controls">{held.flatMap(action => action === "close" ? ["Close task", "Discard", "Discard it and close"] : [action === "share" ? "Share" : action === "retry" ? "Retry" : "Take over"]).map(label => <span key={label}><Button disabled>{label}</Button> <span>Cannot tell yet</span></span>)}{responsive && hasMenuActions && <div className="rv-controls-overflow"><Menu trigger={<Button ref={menuTrigger}>Task actions</Button>} items={items} align="end" className="rv-menu-task" onCloseAutoFocus={event => { if (openingModal.current) event.preventDefault(); }} /></div>}<div className={responsive ? "rv-actions rv-controls-inline" : "rv-actions"}>{actions.includes("watch") && <Button disabled={disabled} onClick={() => { void run("watch"); }}>{following ? "Following" : "Follow"}</Button>}{actions.includes("take_over") && <Button disabled={takeOverDisabled} onClick={event => { returnFocus.current = event.currentTarget;setError(undefined);setTakeOverOpen(true); }}>Take over</Button>}{actions.includes("retry") && <Button disabled={retryDisabled} onClick={() => { void run("retry"); }}>{retryLabel}</Button>}{stopControl}{(actions.includes("close") || closeOpen) && <CloseTaskDialog canClose={allowed && actions.includes("close")} id={id} open={closeOpen} onOpenChange={setCloseOpen} onCloseAutoFocus={restoreFocus} onChecking={() => { void query.invalidateQueries({ queryKey: key }); }} onClosed={() => { setMessage({ text: "Rovara now reads this task as closed.", revision: current.data?.revision ?? 0 });void query.invalidateQueries({ queryKey: key }).catch(() => undefined);void onChanged().catch(() => undefined); }} trigger={<Button disabled={busy || !allowed || (saved.request !== undefined && saved.request.action !== "close")} onClick={event => { returnFocus.current = event.currentTarget; }}>Close task</Button>} />}{share && actions.includes("share") && <ShareDialog id={id} orgName={share.orgName} open={shareOpen} onOpenChange={setShareOpen} onCloseAutoFocus={restoreFocus} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget;if (onPeopleShare !== undefined) { event.preventDefault();void requestShare(); } }}>Share</Button>} />}{makeAgent && actions.includes("make_agent") && <MakeAgentDialog id={id} open={makeOpen} onOpenChange={setMakeOpen} onCloseAutoFocus={restoreFocus} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>Make this an agent</Button>} />}</div><Dialog className="rv-action-dialog" title="Take over this task?" description="Review who is on this task before making yourself its owner." open={takeOverOpen} onOpenChange={value => { if (!takeOverBusy) setTakeOverOpen(value); }} onCloseAutoFocus={restoreFocus}>
 {takeOverRead.isFetching && <p role="status">Reading who is on this task…</p>}
 {takeOverRead.isError && <p role="alert"><VisibleText text={takeOverRead.error instanceof ApiError ? takeOverRead.error.message : "Couldn't read who is on this task. Close and try again."} /></p>}
 {shownPeople && <ul>{shownPeople.people.map(person => <li key={person.personId}><VisibleText text={person.name + " · " + ({ owner: "Owner", commenter: "Can comment", viewer: "Can view", denied: "Removed", unknown: "Role unavailable" }[person.role])} /></li>)}</ul>}
 <div className="rv-actions"><Button disabled={takeOverBusy} onClick={() => setTakeOverOpen(false)}>Keep current owner</Button><Button busy={takeOverBusy} disabled={takeOverDisabled || shownPeople === undefined || !actions.includes("take_over")} onClick={() => { void run("take_over"); }}>Take over</Button></div>
 {error && <p role="alert"><VisibleText text={error} /></p>}
 </Dialog>{pendingConfirmation && <ConfirmInBrowser<ReadSession> key={pendingConfirmation.scope + pendingConfirmation.requestId} result={pendingConfirmation.result} subjectKey={key} isApplied={view => view.you.owner && isCurrentSessionRead(host, identity.data, id, view)} onApplied={() => {
  if (takeOverSaved.scope === undefined || takeOverSaved.request?.requestId !== pendingConfirmation.requestId || identity.data === undefined) return;
  assertSessionIdentity(host, identity.data);clearSessionRequest(host, takeOverSaved.scope, pendingConfirmation.requestId);
  setMessage({ text: "You now own this session.", revision: query.getQueryData<ReadSession>(key)?.revision ?? 0 });
 }} />}{takeOverExit && <p role="status">We couldn't confirm this. <a href={"/s/" + encodeURIComponent(SessionIdSchema.parse(id))}>Open the task to check</a></p>}{retryRecovery.pending && <TaskActionNotice pending check={checkOutcome} recovery={retryRecovery.recovery} taskHref={"/s/" + encodeURIComponent(SessionIdSchema.parse(id))} />}{outcome && request !== retrySaved.request && !stopOpen && !takeOverOpen && <TaskSessionControlOutcomeView kind={outcome} check={<Button variant="quiet" onClick={() => { setError(undefined);void checkOutcome(); }}>Check</Button>} />}{error && !stopOpen && !takeOverOpen && <p role="alert"><VisibleText text={error} /></p>}{legacyTakeOver.migrationError && <p role="alert">{legacyTakeOver.migrationError}</p>}{legacyRetry.migrationError && <p role="alert">{legacyRetry.migrationError}</p>}{saved.storageError && <p role="alert">{saved.storageError}</p>}{message && allowed && (message.following === undefined || current.data?.you.following === message.following) && (current.data === undefined || current.data.revision <= message.revision) && <p role="status"><VisibleText text={message.text} /></p>}{ask && <Suspense fallback={null}><AskPanel id={id} /></Suspense>}</div>;
}
