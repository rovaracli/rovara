import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { fixedSetupWords } from "../../api/setup-checklist.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { MISMATCH_WORDS } from "./words.js";
import { setupAgentKey } from "./SetupReview.js";

/**
 * A command row whose cited lines are not in the file at all (Rovara misread the files; owner DEC 254zzz586): it cannot be used, and it is never a dead end. The row says so and offers the two ways forward right there:
 * run setup again, and change a command. Changing a command is not served yet (lane SETUP-CHANGE-COMMAND), so that action is shown locked with its reason until it ships.
 */
export function MisreadRow({ project, testId }: { project: string; testId: string }) {
  const api = useSetupAgentApi(), client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), sending = useRef(false);
  async function again() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(undefined);
    try { client.setQueryData(setupAgentKey(project), await api.start(project, crypto.randomUUID())); void client.invalidateQueries({ queryKey: setupAgentKey(project) }); }
    catch (caught) { setError(fixedSetupWords(caught, "Couldn't start the setup just now. Try again.")); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div data-testid={testId}>
    <p role="note" data-testid={`${testId}-words`}>{MISMATCH_WORDS.misread}</p>
    <div className="rv-setup-card-actions">
      <Button variant="secondary" busy={busy} data-testid={`${testId}-again`} onClick={() => { void again(); }}>{MISMATCH_WORDS.runAgain}</Button>
      <Button variant="secondary" lockedReason={MISMATCH_WORDS.changeLocked} data-testid={`${testId}-change`}>{MISMATCH_WORDS.changeCommand}</Button>
    </div>
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </div>;
}
