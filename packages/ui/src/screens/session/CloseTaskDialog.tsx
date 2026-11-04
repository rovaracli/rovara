import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { CLOSE_MESSAGES } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
type Unpublished = ReadonlyArray<{ repository: string; reasons: readonly string[] }>;
/** How often the page asks again while the workspace is checked: every 5 s for the first minute, then every 10 s, and it gives up after 6 minutes (the broker keeps checking). */
const POLL_FAST_MS = 5_000, POLL_SLOW_MS = 10_000, POLL_FAST_WINDOW_MS = 60_000, POLL_CEILING_MS = 360_000;
const CHECKING_WORDS = "Checking this task for unpublished work… this usually takes 1–3 minutes";
const RELEASING_WORDS = "No unpublished work found. Releasing the workspace… this usually takes a minute";
const DISCARDING_WORDS = "Discarding the unpublished work and closing this task… this usually takes a minute or two";
const SLOW_WORDS = "This is taking longer than usual. You can close this window; Rovara keeps checking. Try Close task again later.";
const FAILED_WORDS = "Rovara couldn't finish checking this task. Try Close task again.";
/** Requests that fail on the way (no connection, a 5xx) in a row before the wait ends; the same request id is sent again, so a repeat is safe. */
const TRANSIENT_FAILURES_MAX = 2;
/** One press of the button: `cancelled` ends it, and `wake` ends its wait between two asks at once. */
type Run = { cancelled: boolean; wake?: () => void };
/**
 * Closes a task from the web, through the same close the Slack button and the AI-tool close run. The first ask never discards anything: when the workspace holds work that was never published, the
 * answer lists it and only the person's second, explicit press asks for it to be discarded (with a request id of its own). Closing first boots a worker to check the workspace, which takes minutes: until it
 * settles the broker answers "not closed yet", and this dialog says it is checking and asks again by itself (the same request id, so the broker answers with the check already under way), until the task is closed,
 * unpublished work is found, an error comes back, the person closes the window, or six minutes pass. A check that ended without closing the task (the broker says so in `CLOSE_MESSAGES`) is started again once,
 * with a new request id, because the old id only repeats the ended check; a second such end is told to the person. Any other answer that is not "closed" keeps the dialog open with the broker's words.
 */
export function CloseTaskDialog({ id, open, onOpenChange, trigger, onCloseAutoFocus, onClosed, onChecking }: { id: string; open: boolean; onOpenChange: (open: boolean) => void; trigger?: ReactElement; onCloseAutoFocus?: (event: Event) => void; onClosed: () => Promise<unknown> | void; /** Called once when the broker first answers "not closed yet": the task is closing now, so the page can read it again. */ onChecking?: () => void }) {
 const host = useAppHost(), api = useMemo(() => createSessionActions(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [unpublished, setUnpublished] = useState<Unpublished>(), [wait, setWait] = useState<"checking" | "releasing" | "discarding" | "slow">();
 const sending = useRef(false), intent = useRef<{ discard: boolean; requestId: string } | undefined>(undefined), active = useRef<Run | undefined>(undefined), checking = useRef(onChecking);
 const leaveButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null), wasBusy = useRef(false);
 checking.current = onChecking;
 /** Ends the run that is asking or waiting now (if any) without touching the screen. */
 const stop = useCallback(() => { const run = active.current;if (run === undefined) return;run.cancelled = true;active.current = undefined;sending.current = false;run.wake?.(); }, []);
 // The window going away, by the person or by the page, ends the asking and the waiting words with it (the words are reset while rendering, as React advises for state that follows a prop).
 const [wasOpen, setWasOpen] = useState(open);
 if (open !== wasOpen) { setWasOpen(open);if (!open) { setBusy(false);setWait(undefined);setError(undefined); } }
 useEffect(() => { if (!open) stop(); }, [open, stop]);
 useEffect(() => stop, [stop]);
 // The pressed button is disabled while the check runs, so keyboard focus goes to the button that leaves, and comes back to Close task when the wait ends.
 useEffect(() => { if (busy) leaveButton.current?.focus(); else if (wasBusy.current && open) closeButton.current?.focus();wasBusy.current = busy; }, [busy, open]);
 function pause(run: Run, ms: number) { return new Promise<void>(resolve => { const timer = setTimeout(resolve, ms);run.wake = () => { clearTimeout(timer);resolve(); }; }); }
 async function close(discard: boolean) {
  if (sending.current) return;
  const run: Run = { cancelled: false };
  sending.current = true;active.current = run;setBusy(true);setError(undefined);setWait(discard ? "discarding" : "checking");
  // The same request id until the close is settled (closed, or refused for unpublished work): the broker answers a repeat of it with the check already under way, and a new id would start the check again.
  if (intent.current?.discard !== discard) intent.current = { discard, requestId: crypto.randomUUID() };
  const startedAt = Date.now();let announced = false, restarted = false, failures = 0;
  try {
   for (;;) {
    let result: Awaited<ReturnType<typeof api.close>>;
    try { result = await api.close(id, { requestId: intent.current.requestId, ...(discard ? { discardUnpublished: true } : {}) });failures = 0; }
    catch (failure) {
     // A request lost on the way (no connection, a 5xx) is asked again with the same id after the usual wait; a refusal (4xx) ends the wait at once.
     if (run.cancelled) return;
     if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500) && failures < TRANSIENT_FAILURES_MAX && Date.now() - startedAt < POLL_CEILING_MS) { failures += 1;await pause(run, POLL_FAST_MS);if (run.cancelled) return;continue; }
     throw failure;
    }
    if (run.cancelled) return;
    if (result.kind !== "done") { setWait(undefined);setError("This action is waiting for confirmation. Open the session to continue.");return; }
    if (result.value.closed) { intent.current = undefined;change(false);await onClosed();return; }
    if (result.value.unpublished !== undefined && result.value.unpublished.length > 0 && !discard) { intent.current = undefined;setWait(undefined);setUnpublished(result.value.unpublished);return; }
    const message = result.value.message;
    // The check ended without closing the task: only a new request id starts it again, once; after that the person is told.
    if (message === CLOSE_MESSAGES.checkFailed || message === CLOSE_MESSAGES.stillOpen) {
     if (restarted) { intent.current = undefined;setWait(undefined);setError(FAILED_WORDS);return; }
     restarted = true;intent.current = { discard, requestId: crypto.randomUUID() };setWait(discard ? "discarding" : "checking");continue;
    }
    // Not settled yet (the workspace is still being checked, or released): say so and ask again, instead of asking the person to guess when.
    if (!announced) { announced = true;checking.current?.(); }
    setWait(message === CLOSE_MESSAGES.computePending ? "releasing" : discard ? "discarding" : "checking");
    const elapsed = Date.now() - startedAt;
    if (elapsed >= POLL_CEILING_MS) { intent.current = undefined;setWait("slow");return; }
    await pause(run, elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    if (run.cancelled) return;
   }
  } catch (failure) { if (!run.cancelled) { setWait(undefined);setError(failure instanceof ApiError ? failure.message : "Couldn't close this task. Try again."); } }
  finally { if (active.current === run) { active.current = undefined;sending.current = false;setBusy(false); } }
 }
 function change(value: boolean) {
  if (!value) { stop();setBusy(false);setWait(undefined);setUnpublished(undefined);setError(undefined);intent.current = undefined; }
  onOpenChange(value);
 }
 const words = wait === "checking" ? CHECKING_WORDS : wait === "releasing" ? RELEASING_WORDS : wait === "discarding" ? DISCARDING_WORDS : wait === "slow" ? SLOW_WORDS : undefined;
 return <Dialog title={unpublished === undefined ? "Close this task?" : "Discard unpublished work?"} description={unpublished === undefined ? "Rovara frees its workspace and its place in your open-task limit. Work that was published stays where it is." : "This task has work that was never published. Closing it now deletes that work."}
  open={open} onOpenChange={change} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})} {...(trigger ? { trigger } : {})}>
  {unpublished !== undefined && <ul aria-label="Unpublished work">{unpublished.map(entry => <li key={entry.repository}><VisibleText text={entry.repository} />{entry.reasons.length > 0 && <>: <VisibleText text={entry.reasons.join("; ")} /></>}</li>)}</ul>}
  <div role="status" aria-live="polite" className="rv-close-wait">{words !== undefined && <>{wait !== "slow" && <progress aria-hidden="true" />}<p><VisibleText text={words} /></p></>}</div>
  <div className="rv-actions"><Button ref={leaveButton} onClick={() => change(false)}>{busy ? "Close this window" : "Keep it open"}</Button><Button ref={closeButton} variant="danger" busy={busy} onClick={() => { void close(unpublished !== undefined); }}>{unpublished === undefined ? "Close task" : "Discard it and close"}</Button></div>
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </Dialog>;
}
