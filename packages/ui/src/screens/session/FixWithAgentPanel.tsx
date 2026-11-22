import { runTaskAction, useTaskAction } from "../../api/task-action.js";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DIAGNOSIS_ANSWER_LABEL, errorRefKey, type ErrorRef, type DiagnosisStatusReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createDiagnosesApi } from "../../api/diagnoses.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { isCurrentSessionRead } from "../../api/session-safety.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TaskDiagnosisResultStatusView } from "./TaskDiagnosisResultStatusView.js";
import { useSessionIdentity, useSessionRequest, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest, isSessionCsrf, isFinalSessionRefusal } from "../../api/session-safety.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";

type Proposal = NonNullable<ReturnType<typeof DiagnosisStatusReaderSchema.parse>["proposals"]>[number];

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** One proposal as plain text for a person. Nothing here can apply it: a diagnosis explains and suggests, and changes nothing. */
function ProposalText({ proposal }: { proposal: Proposal }) {
 switch (proposal.kind) {
  case "explain": return <VisibleText text={proposal.text} />;
  case "retry_with_note": return <>Retry with this note: <VisibleText text={proposal.note} /></>;
  case "redirect": return <>Tell the agent: <VisibleText text={proposal.text} /></>;
  case "new_task": return <>Start a new task: <VisibleText text={proposal.request} /></>;
  case "admin_steps": return <>For an admin: <ol>{proposal.steps.map((step, index) => <li key={index}><VisibleText text={step} /></li>)}</ol></>;
  case "settings_change": return <>Suggested setting change (<VisibleText text={proposal.target} />, <VisibleText text={proposal.path} />): <VisibleText text={show(proposal.from)} /> to <VisibleText text={show(proposal.to)} /></>;
  case "contact_support": return <>This needs help from outside the task.</>;
  default: return null;
 }
}

/**
 * "Fix with agent" for the error the session shows. Mounted only when the session view says it is on for this reader (`you.live.fix`) and carries an `errorRef`. Pressing the button asks for a diagnosis; the panel
 * then shows its explanation and proposals. It is read-only: there is no apply button. Every refusal (including "connect an AI provider") is the server's own sentence, shown as it came.
 */
export function FixWithAgentPanel({ sessionId, errorRef }: { sessionId: string; errorRef: NonNullable<ReadSession["errorRef"]> }) {
 const host = useAppHost(), api = useMemo(() => createDiagnosesApi(host), [host]), sessions = useMemo(() => createTaskSessionApi(host), [host]), query = useQueryClient();
 const sessionKey = ["session", sessionId], session = useQuery({ queryKey: sessionKey, queryFn: () => sessions.read(sessionId), enabled: false, retry: false });
 const [diagnosisId, setDiagnosisId] = useState<string>(), [sending, setSending] = useState(false), [error, setError] = useState<string>();
 const requestId = useRef<string>(undefined), identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, "diagnosis:" + errorRefKey(errorRef as ErrorRef));
 const recovery = useTaskAction(host, "diagnosis:" + errorRefKey(errorRef as ErrorRef)), [superseded, setSuperseded] = useState(false);
 // Polls only while the server says the diagnosis is queued. Any error (a 404, a steady 5xx) or a state this page does not know stops it; "Try again" reads once more.
 const status = useQuery({
  queryKey: ["diagnosis", diagnosisId], enabled: diagnosisId !== undefined, retry: false, refetchOnWindowFocus: false,
  queryFn: () => api.status(diagnosisId!), refetchInterval: current => (current.state.status !== "error" && current.state.data?.state === "queued" ? 2500 : false),
 });
 async function start() {
  if (sending || superseded || identity.data === undefined || saved.scope === undefined || saved.request !== undefined || saved.storageError !== undefined) return;
  // The same press is the same diagnosis (same request id) unless the last one failed: the server replays a failed diagnosis for its request id, so a retry needs a new id.
  if (requestId.current === undefined || status.data?.state === "failed") requestId.current = crypto.randomUUID();
  // Forget the shown diagnosis before asking, so a lost reply leaves no old "failed" state behind that would give the next press yet another id (the server may already have started this one).
  setSending(true);setError(undefined);setDiagnosisId(undefined);
  let frozen: FrozenSessionRequest | undefined;
  try {
   await readSessionIdentity(host);assertSessionIdentity(host, identity.data);
   const read = await session.refetch(), basis = query.getQueryState(sessionKey), current = read.data;
   const checkAuthority = () => {
    const latest = query.getQueryState(sessionKey);
    if (read.isError || read.failureCount > 0 || current === undefined || basis === undefined || latest !== basis || latest.status !== "success" || latest.fetchFailureCount > 0 || latest.fetchStatus !== "idle" || !isCurrentSessionRead(host, identity.data, sessionId) || current.you.live?.fix !== true || current.errorRef === undefined || errorRefKey(current.errorRef as ErrorRef) !== errorRefKey(errorRef as ErrorRef)) throw new ApiError(403, "FORBIDDEN", "Fix with agent is no longer available for this error. Check the current task.");
   };
   checkAuthority();
   const result = await runTaskAction(host, saved.scope, "diagnosis", { requestId: requestId.current, errorRef }, async request => {
    checkAuthority();
    frozen = request;assertSessionIdentity(host, identity.data!);const answer = await api.start(request.body as { requestId: string; errorRef: unknown });assertSessionIdentity(host, identity.data!);return answer;
   });
   assertSessionIdentity(host, identity.data);setDiagnosisId(result.diagnosisId);
  } catch (failure) {
      if (isSessionCsrf(failure)) { await readSessionIdentity(host).catch(() => undefined);setError("Couldn't change that. Nothing was sent. Check your identity and try again."); }
   else if (frozen === undefined || isFinalSessionRefusal(failure)) setError(failure instanceof ApiError ? failure.message : "Couldn't diagnose this now.");
  }
  finally { setSending(false); }
 }
 async function checkRequest() {
  try {
   const resolved = await recovery.check(() => sessions.read(sessionId), current => current.body.kind === "task" && current.body.task.status === "CLOSED" || current.errorRef === undefined || errorRefKey(current.errorRef as ErrorRef) !== errorRefKey(errorRef as ErrorRef));
   if (resolved) { setSuperseded(true);setError(undefined); }
   else setError("This diagnosis is still unconfirmed. The current error is unchanged. No second diagnosis was sent.");
  } catch { setError("Couldn't check this task. The diagnosis is still unconfirmed. No second diagnosis was sent."); }
 }
 const state = status.isError ? undefined : status.data?.state, waiting = diagnosisId !== undefined && !status.isError && (status.data === undefined || state === "queued");
 const unreadable = diagnosisId !== undefined && !status.isError && status.data !== undefined && state !== "queued" && state !== "ready" && state !== "failed";
 const proposals = status.data?.proposals ?? [];
 return <section className="rv-fix-with-agent" aria-label="Fix with agent">
  <Button variant="secondary" busy={sending || waiting} disabled={superseded || identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined} onClick={() => { void start(); }}>Fix with agent</Button>
  {saved.request !== undefined && <TaskDiagnosisResultStatusView state="unconfirmed" onCheck={() => { void checkRequest(); }} />}
  {superseded && <p role="status">The current error changed or the task closed. The previous diagnosis request no longer applies here.</p>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {waiting && <p className="rv-muted" role="status">Looking into this error</p>}
  {diagnosisId !== undefined && (status.isError || unreadable) && <TaskDiagnosisResultStatusView state="unavailable" onCheck={() => { void status.refetch(); }} />}
  {state === "failed" && <p role="alert"><VisibleText text={status.data?.failure ?? "Couldn't diagnose this now."} /></p>}
  {state === "ready" && <div role="status">
   {proposals.length === 0 ? <TaskDiagnosisResultStatusView state="empty" {...(diagnosisId === undefined ? {} : { safeReference: diagnosisId })} /> : <ul>{proposals.map((proposal, index) => <li key={index}><ProposalText proposal={proposal} /></li>)}</ul>}
   <p className="rv-muted"><VisibleText text={DIAGNOSIS_ANSWER_LABEL} /></p>
  </div>}
 </section>;
}
