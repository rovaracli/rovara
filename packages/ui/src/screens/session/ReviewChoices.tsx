// Rovara-cloud#25: what the owner (or a co-owner on the task's People list, DEC 254zzz39 (6)) of a task stopped by review findings can do from Cloud: read the findings, then
// send the code back to coding with a note, or accept the findings (with a reason) so the pull request opens. The server works out which findings and their IDs from Code's task.
// Accepting a SECURITY finding needs a fresh sign-in with Code's own factor (DEC 236h): the button first sends the person to confirm it's them (Code's step-up page) and back,
// keeping their note, and the next press accepts. When the server still says the confirmation is too old, the page asks again.
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useNav } from "../account/use-nav.js";
import { confirmedReturn, forgetConfirmed, startStepUpNonce, useJustConfirmed } from "../admin/parts.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";

type Finding = { role: "CRITIC" | "SECURITY"; text: string; file?: string | undefined; line?: number | undefined };

/** The blocking findings of the current code, by Code's rule: introduced by this change and not advisory (a security finding always blocks). */
export function blockingFindings(task: ReadTask): Finding[] {
 const workflow = task.workflow as unknown as { candidate?: { digest?: string }; reviews?: Array<{ role?: string; candidateDigest?: string; findings?: Array<{ origin?: string; advisory?: boolean; text?: string; file?: string; line?: number } | string> }> } | undefined;
 const digest = workflow?.candidate?.digest;
 if (digest === undefined) return [];
 const seen = new Set<string>(), out: Finding[] = [];
 for (const review of workflow?.reviews ?? []) {
  if ((review.role !== "CRITIC" && review.role !== "SECURITY") || review.candidateDigest !== digest) continue;
  for (const raw of review.findings ?? []) {
   const finding = typeof raw === "string" ? { text: raw } : raw;
   if (typeof raw !== "string" && !(raw.origin === "INTRODUCED" && (raw.advisory !== true || review.role === "SECURITY"))) continue;
   const key = JSON.stringify([review.role, finding.text ?? "", finding.file ?? "", finding.line ?? 0]);
   if (seen.has(key)) continue;
   seen.add(key);
   out.push({ role: review.role, text: finding.text ?? "", file: finding.file, line: finding.line });
  }
 }
 return out;
}

/** Shown only to the owner (or a co-owner) of a task stopped at review with blocking findings; everyone else, and every other task, sees nothing. */
export function ReviewChoices({ session, task }: { session: ReadSession; task: ReadTask }) {
 if (!(session.you.owner || session.you.coOwner === true) || task.workflow?.stage !== "REVIEW" || task.workflow.state !== "BLOCKED") return null;
 const findings = blockingFindings(task);
 return findings.length === 0 ? null : <ReviewChoicesPanel sessionId={session.sessionId} findings={findings} />;
}

/** Where the note waits while the person confirms it's them (a full page round trip), per person and session; forgotten once read back. */
const noteKey = (sessionId: string, who: string | undefined) => `rovara.reviewNote.${who ?? "anyone"}.${sessionId}`;
function keptNote(storage: { get(key: string): string | undefined }, sessionId: string, who: string | undefined): string {
 try { return (storage.get(noteKey(sessionId, who)) ?? "").slice(0, 1000); } catch { return ""; }
}

function ReviewChoicesPanel({ sessionId, findings }: { sessionId: string; findings: Finding[] }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]);
 const who = useNav()?.me.developerId, confirmed = useJustConfirmed(who);
 const [note, setNote] = useState(() => keptNote(host.storage, sessionId, who)), [busy, setBusy] = useState<"send" | "accept">(), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const [stale, setStale] = useState(false);
 // The kept note is filled in once: forget it as soon as the panel has it (an effect, so a render run twice never loses it).
 useEffect(() => { try { if ((host.storage.get(noteKey(sessionId, who)) ?? "") !== "") host.storage.set(noteKey(sessionId, who), ""); } catch { /* blocked storage */ } }, [host, sessionId, who]);
 const security = findings.some((finding) => finding.role === "SECURITY");
 /** A security finding is accepted only right after the person confirms it's them: Code's step-up page, then back here with the note kept. */
 const mustConfirm = security && (!confirmed || stale);
 function confirmItsYou() {
  try { host.storage.set(noteKey(sessionId, who), note.trim()); } catch { /* blocked storage: the note is typed again */ }
  host.signIn(confirmedReturn(host.currentPath(), startStepUpNonce(host.storage)), { stepUp: true });
 }
 async function run(kind: "send" | "accept") {
  setBusy(kind);setError(undefined);
  try {
   const requestId = crypto.randomUUID(), trimmed = note.trim();
   const result = kind === "send" ? await api.sendBack(sessionId, { requestId, ...(trimmed === "" ? {} : { note: trimmed }) }) : await api.acceptFindings(sessionId, { requestId, reason: trimmed });
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Refresh to check.");
   setDone(kind === "send" ? "Sent back to coding." : "Accepted. Rovara is opening the pull request.");
   await query.invalidateQueries();
  } catch (failure) {
   // The confirmation is too old (or there was none): ask for it again, keeping the note.
   if (failure instanceof ApiError && failure.code === "REAUTH_REQUIRED") { if (who !== undefined) forgetConfirmed(host.storage, who); setStale(true); }
   setError(failure instanceof ApiError ? failure.message : "That didn't go through. Try again.");
  }
  finally { setBusy(undefined); }
 }
 return <section className="rv-review-choices" aria-label="Review findings">
  <h3>The reviews found {findings.length === 1 ? "1 problem" : String(findings.length) + " problems"} Rovara couldn't fix by itself</h3>
  <ul>{findings.map((finding, index) => <li key={index}><span className="rv-muted">{finding.role === "SECURITY" ? "Security review" : "Code review"}{finding.file === undefined ? "" : " · " + finding.file + (finding.line === undefined ? "" : ":" + String(finding.line))}</span> <VisibleText text={finding.text} /></li>)}</ul>
  <TextArea label="Your note" hint="For Send back: what the coding agent should do (optional). For Accept: why these are fine to ship (required)." value={note} maxLength={1000} onChange={event => setNote(event.currentTarget.value)} />
  <div className="rv-actions">
   <Button busy={busy === "send"} disabled={busy !== undefined} onClick={() => { void run("send"); }}>Send back to coding</Button>
   {mustConfirm
    ? <Button disabled={busy !== undefined || note.trim() === "" || note.trim().length > 500} onClick={confirmItsYou}>Confirm it's you to accept the security finding</Button>
    : <Button busy={busy === "accept"} disabled={busy !== undefined || note.trim() === "" || note.trim().length > 500} onClick={() => { void run("accept"); }}>{security ? "Accept, including the security finding, and open the pull request" : "Accept and open the pull request"}</Button>}
  </div>
  {mustConfirm && <p className="rv-muted">Accepting a security finding needs you to confirm it's you first. Your note is kept.</p>}
  {error && <p role="alert"><VisibleText text={error} /></p>}{done && <p role="status"><VisibleText text={done} /></p>}
 </section>;
}
