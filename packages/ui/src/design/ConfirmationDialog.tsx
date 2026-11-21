import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Dialog } from "./Dialog.js";
import { Button } from "./Button.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/table-toast-dialog.css";

// A request stays sent for this page's lifetime, including dialog/action remounts.
// Durable unknown-outcome storage and identity scoping remain the caller's responsibility.
const sentRequests = new Set<string>();
const requestListeners = new Set<() => void>();
function subscribeToRequests(listener: () => void) {
 requestListeners.add(listener);
 return () => { requestListeners.delete(listener); };
}

type ConfirmationDialogBase = {
 /** Stable, identity-scoped request id. Only a genuinely new request may use a new key. */
 requestKey: string;
 open: boolean;
 onOpenChange: (open: boolean) => void;
 title: string;
 consequence: string;
 busy?: boolean;
 /** Draw a nonmodal gallery example in place, without a portal or automatic focus. */
 preview?: boolean;
 /** Optional emphasis in the gallery drawing; the accessible consequence stays complete. */
 consequenceEmphasis?: string;
};
export type ConfirmationDialogProps = ConfirmationDialogBase & (
 { kind: "close"; confirm: { label: string; onConfirm: () => void }; discard?: { label: string; consequence: string; onDiscard: () => void } }
 | { kind: "destructive"; confirm: { label: string; onConfirm: () => void }; discard?: never }
 | { kind: "raise_money"; amountCents: number; confirm: { label: string; onConfirm: (amountCents: number) => void }; discard?: never }
);

/** Presentation only. The owner retains request identity, authority and unresolved-outcome locks. */
export function ConfirmationDialog(props: ConfirmationDialogProps) {
 const { open, onOpenChange, title, consequence, busy = false } = props;
 const opener = useRef<HTMLElement | null>(null);
 const submitted = useSyncExternalStore(subscribeToRequests, () => sentRequests.has(props.requestKey), () => false);
 const previewId = useId();
 function dispatch(action: () => void) {
  if (busy || sentRequests.has(props.requestKey)) return;
  sentRequests.add(props.requestKey);
  for (const listener of requestListeners) listener();
  action();
 }
 useEffect(() => {
  if (open) return;
  const rememberOpener = () => { const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) opener.current = active; };
  rememberOpener(); document.addEventListener("focusin", rememberOpener);
  return () => document.removeEventListener("focusin", rememberOpener);
 }, [open]);
 if (props.preview) return open ? <div role="dialog" aria-labelledby={`${previewId}-title`} aria-describedby={`${previewId}-consequence`} className="rv-confirmation rv-confirmation-preview rv-dialog">
  <div className="rv-dialog-heading"><h2 id={`${previewId}-title`}><VisibleText text={title} /></h2></div>
  <p id={`${previewId}-consequence`}><PreviewConsequence text={consequence} emphasis={props.consequenceEmphasis} /></p>
  {props.kind === "raise_money" && <p className="rv-confirmation-amount">Amount: <VisibleText text={formatMoneyAmount(props.amountCents)} /></p>}
  <ConfirmationActions {...props} submitted={submitted} dispatch={dispatch} />
 </div> : null;
 return <Dialog title={title} description={consequence} open={open} onOpenChange={onOpenChange} className="rv-confirmation" onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}>
  {props.kind === "raise_money" && <p className="rv-confirmation-amount">Amount: <VisibleText text={formatMoneyAmount(props.amountCents)} /></p>}
  <ConfirmationActions {...props} submitted={submitted} dispatch={dispatch} />
 </Dialog>;
}
function formatMoneyAmount(amountCents: number) {
 return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountCents / 100);
}
function PreviewConsequence({ text, emphasis }: { text: string; emphasis: string | undefined }) {
 const start = emphasis ? text.indexOf(emphasis) : -1;
 if (!emphasis || start < 0) return <VisibleText text={text} />;
 return <><VisibleText text={text.slice(0, start)} /><strong><VisibleText text={emphasis} /></strong><VisibleText text={text.slice(start + emphasis.length)} /></>;
}
function ConfirmationActions(props: ConfirmationDialogProps & { submitted: boolean; dispatch: (action: () => void) => void }) {
 const { busy = false, onOpenChange } = props;
 const { submitted, dispatch } = props;
 function confirm() { dispatch(() => { if (props.kind === "raise_money") props.confirm.onConfirm(props.amountCents); else props.confirm.onConfirm(); }); }
 const discard = props.kind === "close" ? props.discard : undefined;
 return <>
  <div className="rv-confirmation-actions">
   <Button variant={props.kind === "destructive" ? "danger" : "primary"} busy={busy} disabled={submitted} onClick={confirm}><VisibleText text={props.confirm.label} /></Button>
   <Button autoFocus={!props.preview} onClick={() => onOpenChange(false)}>Cancel</Button>
  </div>
  {discard && <div className="rv-confirmation-discard">
   <Button variant="danger" busy={busy} disabled={submitted} onClick={() => dispatch(discard.onDiscard)}><VisibleText text={discard.label} /></Button>
   <p><VisibleText text={discard.consequence} /></p>
  </div>}
 </>;
}
