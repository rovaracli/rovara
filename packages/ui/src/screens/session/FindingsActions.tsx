import { useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";

/** What Slack's Send back button sends as the instructions when the person adds none (the broker's `SLACK_SEND_BACK_INSTRUCTIONS`). */
const SEND_BACK_DEFAULT = "Fix the problems listed above, then report what changed.";
const NEVER = { retry: "never" } as const;
const ROLE_WORDS: Record<string, string> = { CRITIC: "Code review", SECURITY: "Security review" };

/**
 * UX2 slice 2 item 3: a blocked task's review findings and its two ways on, on the task page (as in Slack and the MCP tools): Resolve findings (fix or accept each, a reason for each accepted one) and Send back
 * to coding. Offered only where the task view says so; the routes re-check who may and refuse a stale page (its revision and code are sent).
 */
export function FindingsActions({ task, sessionId, mayAct }: { task: ReadTask; sessionId: string; /** The reader may act on the task (its owner, or edit level); the server decides in the end. */ mayAct: boolean }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]), noteId = useId();
 const offer = task.reviewFindings, workflow = task.workflow;
 const [choices, setChoices] = useState<Record<string, { action: "FIX" | "ACCEPT"; note: string }>>({});
 const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const requestIds = useRef<Record<string, string>>({});
 if (offer === undefined || workflow === undefined) return null;
 const path = (action: string) => "/v1/app/tasks/" + encodeURIComponent(task.taskId) + "/workflow/" + action;
 const idFor = (action: string, body: string) => { const key = action + "\n" + body;return requestIds.current[key] ??= crypto.randomUUID(); };
 async function send(action: "review-findings" | "send-back", body: Record<string, unknown>, said: string) {
  if (busy) return;
  setBusy(true);setError(undefined);
  try {
   // The same choices are the same request: a lost answer resent never decides twice.
   await api.sendAnswer("POST", path(action), { ...body, requestId: idFor(action, JSON.stringify(body)) }, { parse: (value: unknown) => value }, NEVER);
   setDone(said);
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't send that. Refresh the page and try again."); }
  finally { setBusy(false); }
 }
 const candidateDigest = (workflow as { candidate?: { digest?: unknown } }).candidate?.digest;
 const resolutions = offer.findings.map(finding => ({ findingId: finding.findingId, ...(choices[finding.findingId] ?? { action: "FIX" as const, note: "" }) }));
 const missingReason = resolutions.some(entry => entry.action === "ACCEPT" && entry.note.trim() === "");
 return <section id="findings" className="rv-findings" aria-label="Review findings">
  <h2>Review findings</h2>
  {offer.findings.length === 0 ? <p className="rv-muted">The checks or reviews stopped this task; see the evidence for what failed.</p> : <ol>{offer.findings.map(finding => { const choice = choices[finding.findingId] ?? { action: "FIX" as const, note: "" };return <li key={finding.findingId}>
   <p><strong>{ROLE_WORDS[finding.role] ?? "Review"}</strong>{finding.file !== undefined && <> · <code><VisibleText text={finding.file + (finding.line === undefined ? "" : ":" + String(finding.line))} /></code></>}</p>
   <p className="rv-evidence-text"><VisibleText text={finding.text} /></p>
   {mayAct && offer.resolve && <fieldset className="rv-finding-choice"><legend>What to do with this finding</legend>
    <label><input type="radio" name={"finding-" + finding.findingId} checked={choice.action === "FIX"} disabled={busy} onChange={() => setChoices(all => ({ ...all, [finding.findingId]: { ...choice, action: "FIX" } }))} /> Fix it</label>
    <label><input type="radio" name={"finding-" + finding.findingId} checked={choice.action === "ACCEPT"} disabled={busy} onChange={() => setChoices(all => ({ ...all, [finding.findingId]: { ...choice, action: "ACCEPT" } }))} /> Accept it</label>
    {choice.action === "ACCEPT" && <TextArea label="Why it's fine as it is" maxLength={500} value={choice.note} disabled={busy} onChange={event => { const value = event.target.value;setChoices(all => ({ ...all, [finding.findingId]: { ...choice, note: value } })); }} />}
   </fieldset>}
  </li>; })}</ol>}
  {mayAct && <div className="rv-actions">
   {offer.resolve && offer.findings.length > 0 && typeof candidateDigest === "string" && <Button variant="primary" busy={busy} disabled={missingReason} onClick={() => { void send("review-findings", { expectedRevision: workflow.revision, candidateDigest, resolutions: resolutions.map(entry => ({ findingId: entry.findingId, action: entry.action, note: entry.note.trim() })) }, "Sent. The findings to fix go back to coding; the accepted ones are recorded."); }}>Resolve findings</Button>}
   {offer.sendBack && <Button busy={busy} onClick={() => { void send("send-back", { expectedRevision: workflow.revision, instructions: note.trim() === "" ? SEND_BACK_DEFAULT : note.trim() }, "Sent back to coding."); }}>Send back to coding</Button>}
  </div>}
  {mayAct && offer.sendBack && <TextArea id={noteId} label="Note for the agent (optional)" maxLength={2000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} />}
  {!mayAct && <p className="rv-muted">The task owner decides what happens to these findings.</p>}
  {missingReason && <p className="rv-muted">Give a reason for each finding you accept.</p>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {done && <p role="status"><VisibleText text={done} /></p>}
 </section>;
}
