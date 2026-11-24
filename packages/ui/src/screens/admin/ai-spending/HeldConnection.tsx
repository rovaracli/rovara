import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import "../../../design/parts/held-connection.css";
import { CONNECTION_NOT_CONFIRMED, CONNECTION_NOT_CONFIRMED_SHORT, CONNECTION_PAUSED, type useConnectionChange } from "./connection-change.js";

type Change = ReturnType<typeof useConnectionChange>;

/**
 * Drawn inside every card whose buttons a held change disables, so the reason and the way out sit beside the buttons that don't respond.
 * A warning callout: why changes are paused and Check (primary). After a Check that saw no newer revision the same place says so
 * (the long words in the card that made the change, the short words elsewhere) and offers "Continue with these settings" (primary).
 */
export function HeldConnection({ change, checkLabel, showNotice = true }: { change: Change; checkLabel: string; showNotice?: boolean }) {
 if (!change.held) return null;
 const unconfirmed = change.unconfirmed;
 // The not-confirmed words replace the pause line once Check has run; they are the notice itself, so it is not drawn twice.
 const note = change.notice !== undefined && !(unconfirmed && change.notice.text === CONNECTION_NOT_CONFIRMED) ? change.notice : undefined;
 return <div className="rv-held-connection" data-testid="held-connection">
  <div className="rv-held-connection-head">
   <svg className="rv-held-connection-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3.2M8 11.6v.4" /></svg>
   <p role="alert">{unconfirmed ? (showNotice ? CONNECTION_NOT_CONFIRMED : CONNECTION_NOT_CONFIRMED_SHORT) : CONNECTION_PAUSED}</p>
  </div>
  {showNotice && note !== undefined && <p role={note.ok ? "status" : "alert"}><VisibleText text={note.text} /></p>}
  <div className="rv-held-connection-actions">
   <Button variant={unconfirmed ? "secondary" : "primary"} disabled={change.busy} onClick={() => { void change.check(); }}>{checkLabel}</Button>
   {unconfirmed && <Button variant="primary" disabled={change.busy} onClick={change.release}>Continue with these settings</Button>}
  </div>
 </div>;
}
