import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";

export const DISCARD_AND_RELOAD = "Discard my changes and reload";
/**
 * What a stale answer shows: the server's sentence, and a way out. The person's draft stays exactly as typed (a stale answer never throws it away); "Discard my changes and reload" closes the editor, so opening it
 * again reads the newer state. Nothing is saved from the stale draft, because every write carries the revision the editor was opened under.
 */
export function StaleNotice({ message, onDiscard }: { message: string; onDiscard: () => void }) {
 return <div className="rv-people-stale"><p role="alert"><VisibleText text={message} /></p><Button onClick={onDiscard}>{DISCARD_AND_RELOAD}</Button></div>;
}
