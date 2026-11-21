import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LOOK_COLORS } from "@agentx/design-tokens";
import { useAnnounce } from "./Announcer.js";
import { IconButton } from "./IconButton.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/table-toast-dialog.css";
// Inverse chrome needs the opposite palette's ok foreground, not its pale tint.
const tickColors = { "--rv-toast-ok-on-dark": LOOK_COLORS.dark.statusDone, "--rv-toast-ok-on-light": LOOK_COLORS.light.statusDone } as CSSProperties;
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
  {onUndo && <span className="rv-toast-v2-tick" style={tickColors} aria-hidden="true">✓</span>}<span><VisibleText text={message} /></span>
  {onUndo && <button type="button" className="rv-toast-v2-undo" disabled={disabled} onClick={undo}>Undo</button>}
  {!onUndo && <IconButton label="Dismiss notification" variant="quiet" onClick={onDismiss}>×</IconButton>}
 </aside>;
}
