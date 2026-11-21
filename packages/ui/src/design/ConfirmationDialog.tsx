import { useEffect, useId, useRef, useState } from "react";
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
 /** Draw a nonmodal gallery example in place, without a portal or automatic focus. */
 preview?: boolean;
 /** Optional emphasis in the gallery drawing; the accessible consequence stays complete. */
 consequenceEmphasis?: string;
} & ({ kind: "close"; discard?: { label: string; consequence: string; onDiscard: () => void } } | { kind: "destructive" | "raise_money"; discard?: never });

/** Presentation only. The owner retains request identity, authority and unresolved-outcome locks. */
export function ConfirmationDialog(props: ConfirmationDialogProps) {
 const { open, onOpenChange, title, consequence, busy = false } = props;
 const opener = useRef<HTMLElement | null>(null);
 const previewId = useId();
 useEffect(() => {
  if (open) return;
  const rememberOpener = () => { const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) opener.current = active; };
  rememberOpener(); document.addEventListener("focusin", rememberOpener);
  return () => document.removeEventListener("focusin", rememberOpener);
 }, [open]);
 if (props.preview) return open ? <div role="dialog" aria-labelledby={`${previewId}-title`} aria-describedby={`${previewId}-consequence`} className="rv-confirmation rv-confirmation-preview rv-dialog">
  <div className="rv-dialog-heading"><h2 id={`${previewId}-title`}><VisibleText text={title} /></h2></div>
  <p id={`${previewId}-consequence`}><PreviewConsequence text={consequence} emphasis={props.consequenceEmphasis} /></p>
  <ConfirmationActions key={String(busy)} {...props} />
 </div> : null;
 return <Dialog title={title} description={consequence} open={open} onOpenChange={onOpenChange} className="rv-confirmation" onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}>
  <ConfirmationActions key={String(busy)} {...props} />
 </Dialog>;
}
function PreviewConsequence({ text, emphasis }: { text: string; emphasis: string | undefined }) {
 const start = emphasis ? text.indexOf(emphasis) : -1;
 if (!emphasis || start < 0) return <VisibleText text={text} />;
 return <><VisibleText text={text.slice(0, start)} /><strong><VisibleText text={emphasis} /></strong><VisibleText text={text.slice(start + emphasis.length)} /></>;
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
   <Button autoFocus={!props.preview} onClick={() => onOpenChange(false)}>Cancel</Button>
  </div>
  {discard && <div className="rv-confirmation-discard">
   <Button variant="danger" busy={busy} disabled={submitted} onClick={() => dispatch(discard.onDiscard)}><VisibleText text={discard.label} /></Button>
   <p><VisibleText text={discard.consequence} /></p>
  </div>}
 </>;
}
