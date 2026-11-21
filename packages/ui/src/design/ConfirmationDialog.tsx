import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog.js";
import { Button } from "./Button.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/table-toast-dialog.css";

export type ConfirmationDialogProps = {
 open: boolean;
 onOpenChange: (open: boolean) => void;
 title: string;
 consequence: string;
 confirm: { label: string; onConfirm: () => void };
 busy?: boolean;
} & ({ kind: "close"; discard?: { label: string; consequence: string; onDiscard: () => void } } | { kind: "destructive" | "raise_money"; discard?: never });

/** Presentation only. The owner retains request identity, authority and unresolved-outcome locks. */
export function ConfirmationDialog(props: ConfirmationDialogProps) {
 const { open, onOpenChange, title, consequence, busy = false } = props;
 const opener = useRef<HTMLElement | null>(null);
 useEffect(() => {
  if (open) return;
  const rememberOpener = () => { const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) opener.current = active; };
  rememberOpener(); document.addEventListener("focusin", rememberOpener);
  return () => document.removeEventListener("focusin", rememberOpener);
 }, [open]);
 return <Dialog title={title} description={consequence} open={open} onOpenChange={onOpenChange} className="rv-confirmation" onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}>
  <ConfirmationActions key={String(busy)} {...props} />
 </Dialog>;
}
function ConfirmationActions(props: ConfirmationDialogProps) {
 const { confirm, busy = false, onOpenChange } = props;
 const dispatched = useRef(false);
 const [submitted, setSubmitted] = useState(false);
 function dispatch(action: () => void) { if (busy || dispatched.current) return; dispatched.current = true; setSubmitted(true); action(); }
 const discard = props.kind === "close" ? props.discard : undefined;
 return <>
  <div className="rv-confirmation-actions">
   <Button variant={props.kind === "destructive" ? "danger" : "primary"} busy={busy} disabled={submitted} onClick={() => dispatch(confirm.onConfirm)}><VisibleText text={confirm.label} /></Button>
   <Button autoFocus onClick={() => onOpenChange(false)}>Cancel</Button>
  </div>
  {discard && <div className="rv-confirmation-discard">
   <Button variant="danger" busy={busy} disabled={submitted} onClick={() => dispatch(discard.onDiscard)}><VisibleText text={discard.label} /></Button>
   <p><VisibleText text={discard.consequence} /></p>
  </div>}
 </>;
}
