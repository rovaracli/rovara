import { useState } from "react";
import { Button } from "../../design/Button.js";
import { recordUnknownActionCheck, useUnknownActionExit, type Fence } from "../../safe-action.js";

type Recovery = { fence: Fence; entry: { requestId: string; startedAt: string } | undefined };
/** Read-only recovery for a task action whose response did not settle it. */
export function TaskActionNotice({ pending, check, recovery, taskHref }: { pending: boolean; check: () => Promise<unknown>; recovery: Recovery; taskHref: string }) {
 const [failed, setFailed] = useState(false);
 const entry = pending ? recovery.entry : undefined;
 const exit = useUnknownActionExit(recovery.fence, entry, taskHref);
 async function checkNow() {
  try { await check();setFailed(false); }
  catch { setFailed(true); }
  // Presentation only. A successful Check may have resolved the request and
  // unmounted this notice; counting the old identity cannot unlock or resend it.
  if (entry !== undefined) recordUnknownActionCheck(recovery.fence, entry);
 }
 return pending ? <p role="status">{failed ? "Couldn't check this task. The request is still unconfirmed." : "Rovara didn't confirm this yet. Check its current state before acting again."} <Button onClick={() => { void checkNow(); }}>Check</Button>{exit && <> We couldn't confirm this. <a href={exit.href}>Open the task to check</a></>}</p> : null;
}
