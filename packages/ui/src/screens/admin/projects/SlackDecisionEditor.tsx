import { useEffect, useMemo, useRef, useState } from "react";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createProjectSlackApi } from "../../../api/project-slack.js";
import { readSlackDecisionRequests, retainSlackDecisionRequest, selectSlackDecisionRequest, slackRequestCanResend, type SlackDecisionRequest } from "./project-slack-history.js";
type Proposal = NonNullable<Awaited<ReturnType<ReturnType<typeof createProjectSlackApi>["proposal"]>>["proposal"]>;
type Props = { orgId: string; developerId: string; project: string; decision: "cancel" | "reject" | "history"; proposal: Proposal | null; onClose: () => void };
type Phase = "loading" | "reviewing" | "ready" | "sending" | "unknown" | "checking" | "absent" | "done" | "failed" | "expired";
export function SlackDecisionEditor({ orgId, developerId, project, decision, proposal, onClose }: Props) {
 const host = useAppHost(), scope = useMemo(() => ({ orgId, developerId, project }), [orgId, developerId, project]), api = useMemo(() => createProjectSlackApi(host, orgId, project), [host, orgId, project]);
 const [phase, setPhase] = useState<Phase>("loading"), [attempt, setAttempt] = useState<SlackDecisionRequest>(), [history, setHistory] = useState<ReturnType<typeof readSlackDecisionRequests>>({ requests: [], selectedIndex: -1 }), [message, setMessage] = useState("Checking saved proposal decisions.");
 const alive = useRef(false), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null);
 useEffect(() => {
  alive.current = true;api.setScopeActive(true);
  void (async () => {
   try {
    const saved = readSlackDecisionRequests(host.storage, scope);if (!alive.current) return;setHistory(saved);
    if (decision === "history") { const selected = saved.requests[saved.selectedIndex] ?? saved.requests.at(-1);if (!selected) throw new Error("No saved decision");setAttempt(selected);setPhase("unknown");setMessage("Saved decision selected. Check its status; nothing was resent."); }
    else {
     setPhase("reviewing");if (!proposal) throw new Error("No proposal");const current = (await api.proposal(proposal.proposalId)).proposal;if (!alive.current) return;
     if (!current || current.state !== "pending" || current.proposalId !== proposal.proposalId || current.by !== proposal.by || current.teamId !== proposal.teamId || current.channelId !== proposal.channelId || current.expiresAt !== proposal.expiresAt || Date.parse(current.expiresAt) <= Date.now() || (decision === "reject" && current.by === developerId)) throw new Error("Proposal changed");
     const request: SlackDecisionRequest = { operation: decision, reviewedAt: new Date().toISOString(), proposalExpiresAt: current.expiresAt, body: { expectedOrgId: orgId, requestId: crypto.randomUUID(), proposalId: current.proposalId, teamId: current.teamId, channelId: current.channelId } };
     retainSlackDecisionRequest(host.storage, scope, request);setHistory(readSlackDecisionRequests(host.storage, scope));setAttempt(request);setPhase("ready");setMessage("Review this terminal decision before confirming. It will not link or unlink a channel.");
    }heading.current?.focus();
   } catch { if (alive.current) { setPhase("failed");setMessage("The proposal decision could not be reviewed or retained. Nothing was sent."); } }
  })();return () => { alive.current = false;api.setScopeActive(false); };
 }, [api, decision, developerId, host.storage, orgId, proposal, scope]);
 function confirmed(value: Awaited<ReturnType<typeof api.decisionStatus>>, request: SlackDecisionRequest) {
  if (value.decision.proposalId !== request.body.proposalId || value.decision.requestId !== request.body.requestId || value.decision.state !== (request.operation === "cancel" ? "cancelled" : "rejected") || value.decision.expiresAt !== request.proposalExpiresAt) throw new Error("Decision mismatch");
  setPhase("done");setMessage(`Decision receipt confirmed: proposal ${value.decision.state}. No channel binding changed. Refresh approval state before any new link request.`);
 }
 async function send() {
  if (!attempt || busy.current || !alive.current || !["ready", "absent"].includes(phase)) return;
  if (!slackRequestCanResend(attempt, Date.now())) { setPhase("expired");setMessage("This saved decision expired. Check its status; it cannot be resent.");return; }
  try { retainSlackDecisionRequest(host.storage, scope, attempt); } catch { setPhase("failed");setMessage("The decision could not be retained. Nothing was sent.");return; }
  busy.current = true;setPhase("sending");
  try { const value = await api.decide({ ...attempt.body, decision: attempt.operation });if (alive.current) confirmed(value, attempt); }
  catch (error) { if (alive.current) { setPhase(error instanceof ApiError && [400, 401, 403, 409, 429].includes(error.status) ? "failed" : "unknown");setMessage("The decision was not confirmed. Check its status before deciding whether to resend."); } }
  finally { busy.current = false; }
 }
 async function status() {
  if (!attempt || busy.current || !alive.current) return;busy.current = true;setPhase("checking");
  try { const value = await api.decisionStatus(attempt.body.requestId);if (alive.current) confirmed(value, attempt); }
  catch (error) { if (alive.current) { setPhase(!slackRequestCanResend(attempt, Date.now()) ? "expired" : error instanceof ApiError && error.status === 404 ? "absent" : "unknown");setMessage("No decision receipt confirmed. The original request may still complete; nothing was resent."); } }
  finally { busy.current = false; }
 }
 const inFlight = ["loading", "reviewing", "sending", "checking"].includes(phase);
 return <section aria-label="Slack proposal decision"><h3 ref={heading} tabIndex={-1}>Review Slack proposal decision</h3><p>Company {orgId} · Project {project}</p>
  {attempt && <><p>Proposal {attempt.body.proposalId} · Workspace {attempt.body.teamId} · Channel {attempt.body.channelId}</p><p>Decision {attempt.operation} · expires {attempt.proposalExpiresAt}</p>
   <p>Cancelling or rejecting ends this pending approval. It does not link or unlink a channel. A new request needs a separate review and confirmation.</p>
   {<button type="button" className="rv-button rv-button-secondary" aria-disabled={phase !== "ready"} aria-busy={phase === "sending"} onClick={() => { if (phase === "ready") void send(); }}>{attempt.operation === "cancel" ? "Confirm cancellation" : "Confirm rejection"}</button>}
   {["unknown", "checking", "absent", "expired", "failed"].includes(phase) && <button type="button" className="rv-button rv-button-secondary" disabled={inFlight} onClick={() => void status()}>Check Slack decision status</button>}
   {phase === "absent" && <button type="button" className="rv-button rv-button-secondary" onClick={() => void send()}>Resend same Slack decision</button>}
  </>}
  {history.requests.length > 1 && <label>Earlier Slack decision<select value={attempt ? history.requests.findIndex(row => row.body.requestId === attempt.body.requestId) : -1} disabled={inFlight} onChange={event => {
   if (busy.current) return;try { const selected = selectSlackDecisionRequest(host.storage, scope, Number(event.target.value));setHistory(readSlackDecisionRequests(host.storage, scope));setAttempt(selected);setPhase("unknown");setMessage("Saved decision selected. Check its status; nothing was resent."); } catch { setPhase("failed");setMessage("Saved decisions could not be verified. Nothing was sent."); }
  }}><option value={-1} disabled>Select a saved decision</option>{history.requests.map((row, index) => <option key={row.body.requestId} value={index}>Decision {index + 1} · {row.operation}</option>)}</select></label>}
  <p role="status" aria-live="polite">{message}</p><button type="button" className="rv-button rv-button-secondary" disabled={inFlight} onClick={onClose}>Close Slack decision</button>
 </section>;
}
