import { useMemo, useRef, useState, type ReactElement } from "react";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
type Unpublished = ReadonlyArray<{ repository: string; reasons: readonly string[] }>;
/**
 * Closes a task from the web, through the same close the Slack button and the AI-tool close run. The first ask never discards anything: when the workspace holds work that was never published, the
 * answer lists it and only the person's second, explicit press asks for it to be discarded (with a request id of its own). Any answer that is not "closed" keeps the dialog open with the broker's words.
 */
export function CloseTaskDialog({ id, open, onOpenChange, trigger, onCloseAutoFocus, onClosed }: { id: string; open: boolean; onOpenChange: (open: boolean) => void; trigger?: ReactElement; onCloseAutoFocus?: (event: Event) => void; onClosed: () => Promise<unknown> | void }) {
 const host = useAppHost(), api = useMemo(() => createSessionActions(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [unpublished, setUnpublished] = useState<Unpublished>();
 const sending = useRef(false), intent = useRef<{ discard: boolean; requestId: string } | undefined>(undefined);
 async function close(discard: boolean) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);
  // The same request id until the close is settled (closed, or refused for unpublished work): the broker answers a repeat of it with the check already under way, and a new id would start the check again.
  if (intent.current?.discard !== discard) intent.current = { discard, requestId: crypto.randomUUID() };
  try {
   const result = await api.close(id, { requestId: intent.current.requestId, ...(discard ? { discardUnpublished: true } : {}) });
   if (result.kind !== "done") { setError("This action is waiting for confirmation. Open the session to continue.");return; }
   if (result.value.closed) { intent.current = undefined;setUnpublished(undefined);onOpenChange(false);await onClosed();return; }
   if (result.value.unpublished !== undefined && result.value.unpublished.length > 0 && !discard) { intent.current = undefined;setUnpublished(result.value.unpublished); }
   // Not settled yet (the workspace is still being checked, or released): the broker's words name an AI-tool command, so the page says it in its own.
   else setError("This task isn't closed yet. Press the button again in a moment.");
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't close this task. Try again."); }
  finally { sending.current = false;setBusy(false); }
 }
 return <Dialog title={unpublished === undefined ? "Close this task?" : "Discard unpublished work?"} description={unpublished === undefined ? "Rovara frees its workspace and its place in your open-task limit. Work that was published stays where it is." : "This task has work that was never published. Closing it now deletes that work."}
  open={open} onOpenChange={value => { if (!busy) { if (!value) { setUnpublished(undefined);setError(undefined);intent.current = undefined; }onOpenChange(value); } }} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})} {...(trigger ? { trigger } : {})}>
  {unpublished !== undefined && <ul aria-label="Unpublished work">{unpublished.map(entry => <li key={entry.repository}><VisibleText text={entry.repository} />{entry.reasons.length > 0 && <>: <VisibleText text={entry.reasons.join("; ")} /></>}</li>)}</ul>}
  <div className="rv-actions"><Button disabled={busy} onClick={() => onOpenChange(false)}>Keep it open</Button><Button variant="danger" busy={busy} onClick={() => { void close(unpublished !== undefined); }}>{unpublished === undefined ? "Close task" : "Discard it and close"}</Button></div>
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </Dialog>;
}
