import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "./Announcer.js";
import { IconButton } from "./IconButton.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/table-toast-dialog.css";
export function Toast({ message, onDismiss, onUndo }: { message: string; onDismiss: () => void; onUndo?: () => void }) {
 const announce = useAnnounce();
 useEffect(() => { announce(message); }, [announce, message]);
 return <ToastReceipt key={message} message={message} onDismiss={onDismiss} {...(onUndo ? { onUndo } : {})} />;
}
function ToastReceipt({ message, onDismiss, onUndo }: { message: string; onDismiss: () => void; onUndo?: () => void }) {
 const undone = useRef(false);
 const [disabled, setDisabled] = useState(false);
 function undo() { if (undone.current || !onUndo) return; undone.current = true; setDisabled(true); onUndo(); onDismiss(); }
 return <aside className={onUndo ? "rv-toast rv-toast-v2" : "rv-inline-receipt"} aria-label="Notification">
  {onUndo && <span className="rv-toast-v2-tick" aria-hidden="true">✓</span>}<span><VisibleText text={message} /></span>
  {onUndo && <button type="button" className="rv-toast-v2-undo" disabled={disabled} onClick={undo}>Undo</button>}
  {!onUndo && <IconButton label="Dismiss notification" variant="quiet" onClick={onDismiss}>×</IconButton>}
 </aside>;
}
