import { createTaskSessionApi } from "../../api/sessions.js";
import { isFinalSessionRefusal } from "../../api/session-safety.js";
import { useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
// Rovara-cloud#25: what the owner (or a co-owner on the task's People list, DEC 254zzz39 (6)) of a task stopped by review findings can do from Cloud: read the findings, then
// send the code back to coding with a note, or accept the findings (with a reason) so the pull request opens. The server works out which findings and their IDs from Code's task.
// Accepting a SECURITY finding is the same press (owner DEC 254zzz73 removed the step-up it once needed); the owner/co-owner rule and Code's own checks stay on the server.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
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
 const findings = blockingFindings(task), expectedRevision = task.workflow.revision, candidateDigest = task.workflow.candidate?.digest;
 if (expectedRevision === undefined || candidateDigest === undefined) return <p>Cannot tell yet</p>;
 return findings.length === 0 ? null : <ReviewChoicesPanel sessionId={session.sessionId} findings={findings} expectedRevision={expectedRevision} candidateDigest={candidateDigest} />;
}

function ReviewChoicesPanel({ sessionId, findings, expectedRevision, candidateDigest }: { sessionId: string; findings: Finding[]; expectedRevision: number; candidateDigest: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]);
 const [note, setNote] = useState(""), [busy, setBusy] = useState<"send" | "accept">(), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const action = useTaskAction(host, "review:" + sessionId);
 const security = findings.some((finding) => finding.role === "SECURITY");
 async function run(kind: "send" | "accept") {
  if (action.locked) return;
  setBusy(kind);setError(undefined);
  try {
   const requestId = crypto.randomUUID(), trimmed = note.trim();
   const body = { requestId, expectedRevision, candidateDigest, ...(kind === "send" ? (trimmed === "" ? {} : { note: trimmed }) : { reason: trimmed }) };
   const result = await action.run(kind, body, async frozen => {
    const answer = kind === "send" ? await api.sendBack(sessionId, frozen as typeof body) : await api.acceptFindings(sessionId, frozen as { requestId: string; expectedRevision: number; candidateDigest: string; reason: string });
    if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return answer;
   }, async () => {
    const latest = await createTaskSessionApi(host).read(sessionId), task = latest.body.kind === "task" ? latest.body.task : undefined;
    if (!(latest.you.owner || latest.you.coOwner === true) || task === undefined || JSON.stringify(blockingFindings(task)) !== JSON.stringify(findings) || task.workflow?.stage !== "REVIEW" || task.workflow.state !== "BLOCKED") throw new ApiError(403, "FORBIDDEN", "These findings or your permissions changed. Read the current task before deciding.");
   });
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Refresh to check.");
   setDone(kind === "send" ? "Sent back to coding." : "Accepted. Rovara is opening the pull request.");
   await query.invalidateQueries();
  } catch (failure) {
   setError(failure instanceof ApiError ? failure.message : "That didn't go through. Try again.");
   if (isFinalSessionRefusal(failure)) void query.invalidateQueries({ queryKey: ["session", sessionId] }).catch(() => undefined);
  }
  finally { setBusy(undefined); }
 }
 return <section className="rv-review-choices" aria-label="Review findings">
  <h3>The reviews found {findings.length === 1 ? "1 problem" : String(findings.length) + " problems"} Rovara couldn't fix by itself</h3>
  <ul>{findings.map((finding, index) => <li key={index}><span className="rv-muted">{finding.role === "SECURITY" ? "Security review" : "Code review"}{finding.file === undefined ? "" : " · " + finding.file + (finding.line === undefined ? "" : ":" + String(finding.line))}</span> <VisibleText text={finding.text} /></li>)}</ul>
  <TextArea label="Your note" hint="For Send back: what the coding agent should do (optional). For Accept: why these are fine to ship (required)." value={note} maxLength={1000} onChange={event => setNote(event.currentTarget.value)} />
  <div className="rv-actions">
   <Button busy={busy === "send"} disabled={action.locked || busy !== undefined} onClick={() => { void run("send"); }}>Send back to coding</Button>
   <Button busy={busy === "accept"} disabled={action.locked || busy !== undefined || note.trim() === "" || note.trim().length > 500} onClick={() => { void run("accept"); }}>{security ? "Accept, including the security finding, and open the pull request" : "Accept and open the pull request"}</Button>
  </div>
  <TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={"/app/sessions/" + encodeURIComponent(sessionId)} check={() => query.invalidateQueries({ queryKey: ["session", sessionId] })} />
  {error && <p role="alert"><VisibleText text={error} /></p>}{done && <p role="status"><VisibleText text={done} /></p>}
 </section>;
}
