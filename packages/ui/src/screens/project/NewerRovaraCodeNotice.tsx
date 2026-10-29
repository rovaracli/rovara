import { useRef, useState } from "react";
import { useAgentApi } from "../../api/agents.js";
import { useBuilderApi } from "../../api/builder.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
/** "A newer Rovara Code is available": the company has adopted a newer Rovara Code than the project's How we work builds on. A maintainer's Update moves the layer's draft onto it, then `onMoved` opens Review changes; nothing is published here. */
export function NewerRovaraCodeNotice({ update, agentId, canEdit, disabled, onMoved }: { update: { from: number; to: number }; agentId: string | undefined; canEdit: boolean; disabled: boolean; onMoved: () => Promise<void> }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), sending = useRef(false), builder = useBuilderApi(), agents = useAgentApi();
 async function move() {
  if (sending.current || agentId === undefined) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   const current = await builder.draft(agentId), result = await agents.updateBase(agentId, current.draft.revision);
   if (result.kind !== "done") { setError("Couldn't update. Try again.");return; }
   await onMoved();
  } catch (failure) { setError(failureText(failure, "Couldn't update to the newer Rovara Code. Try again.")); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-project-section" aria-label="Newer Rovara Code">
  <p>A newer Rovara Code is available (version {update.from} → {update.to}).</p>
  {canEdit && <Button busy={busy} disabled={disabled || agentId === undefined} onClick={() => { void move(); }}>Update</Button>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
