import { useAppHost } from "../../host.js";
import type { SendResult } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
export const SENT_FOR_CONFIRMATION = "Sent for confirmation: someone else who can approve changes in this project confirms it.";
export const publishedMessage = (version: number) => "Published as version " + String(version) + ". New tasks use it; running tasks keep their version.";
export const rolledBackMessage = (version: number) => "Rolled back to version " + String(version) + ". New tasks use it; running tasks keep their version.";
/** A less-safe change waits for a second person. It shows why, the confirmation link, and a read-only status check (never a second write). */
export function PendingConfirmation({ result, checking, onCheck }: { result: Exclude<SendResult<unknown>, { kind: "done" }>; checking: boolean; onCheck: () => void }) {
 const host = useAppHost(), url = result.kind === "needs_confirmation" ? result.confirmUrl : undefined;
 return <div role="status"><p>{SENT_FOR_CONFIRMATION}</p>{result.kind === "needs_confirmation" && result.changes.length > 0 && <ul>{result.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}{result.kind === "needs_admin_approval" && <p><VisibleText text={result.message} /></p>}<p>{url !== undefined && isConfirmUrl(url, host.origin) && <Button onClick={() => host.openExternal(url)}>Open confirmation</Button>} <Button busy={checking} onClick={onCheck}>Check status</Button></p></div>;
}
