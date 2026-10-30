import { useEffect, useMemo, useRef, useState } from "react";
import { ReviewedSlackProposeBodySchema } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createProjectSlackApi } from "../../../api/project-slack.js";
import { readSlackBindRequests, retainSlackBindRequest, selectSlackBindRequest, slackRequestCanResend, type SlackBindRequest } from "./project-slack-history.js";
type Props = { orgId: string; developerId: string; project: string; onClose: () => void };
type Pending = NonNullable<Awaited<ReturnType<ReturnType<typeof createProjectSlackApi>["proposal"]>>["proposal"]>;
type Phase = "loading" | "editing" | "reviewing" | "ready" | "sending" | "unknown" | "checking" | "absent" | "pending" | "done" | "refused" | "expired" | "failed";
export function SlackBindEditor({ orgId, developerId, project, onClose }: Props) {
 const host = useAppHost(), scope = useMemo(() => ({ orgId, developerId, project }), [orgId, developerId, project]);
 const api = useMemo(() => createProjectSlackApi(host, orgId, project), [host, orgId, project]);
 const [teamId, setTeamId] = useState(""), [channelId, setChannelId] = useState("");
 const [phase, setPhase] = useState<Phase>("loading"), [pending, setPending] = useState<Pending | null>(null), [attempt, setAttempt] = useState<SlackBindRequest>();
 const [history, setHistory] = useState<ReturnType<typeof readSlackBindRequests>>({ requests: [], selectedIndex: -1 }), [message, setMessage] = useState("Checking pending channel approval."), [receipt, setReceipt] = useState("");
 const [observedAt, setObservedAt] = useState(0);
 const alive = useRef(false), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null);
 useEffect(() => {
  alive.current = true;api.setScopeActive(true);
  void api.proposal().then(value => {
   if (!alive.current) return;
   try { const saved = readSlackBindRequests(host.storage, scope), request = saved.requests[saved.selectedIndex];setHistory(saved);setAttempt(request);setPending(value.proposal);setObservedAt(Date.now());setPhase(request ? "unknown" : value.proposal?.state === "pending" && Date.parse(value.proposal.expiresAt) > Date.now() ? "pending" : "editing");setMessage(request ? "A saved link request is available. Check its status; nothing was resent." : value.proposal ? "A recorded channel proposal is available for review." : "Enter the exact workspace and channel IDs to review a new link.");heading.current?.focus(); }
   catch { setPhase("failed");setMessage("Saved link requests could not be verified. Nothing was sent."); }
  }).catch(() => { if (alive.current) { setPhase("failed");setMessage("Pending Slack approval could not be checked. Nothing was sent."); } });
  return () => { alive.current = false;api.setScopeActive(false); };
 }, [api, host.storage, scope]);
 function retain(request: SlackBindRequest) { retainSlackBindRequest(host.storage, scope, request);setHistory(readSlackBindRequests(host.storage, scope));setAttempt(request); }
 async function prepare(proposal?: Pending) {
  if (busy.current || !alive.current || (proposal ? phase !== "pending" : phase !== "editing")) return;
  busy.current = true;setPhase("reviewing");
  try {
   const current = proposal ? (await api.proposal(proposal.proposalId)).proposal : null;
   if (!alive.current) return;
   if (proposal && (current === null || current.state !== "pending" || current.teamId !== proposal.teamId || current.channelId !== proposal.channelId || current.by !== proposal.by || current.expiresAt !== proposal.expiresAt || Date.parse(current.expiresAt) <= Date.now())) throw new Error("Proposal changed");
   const team = current?.teamId ?? teamId, channel = current?.channelId ?? channelId, target = await api.review(team, channel);
   if (!alive.current) return;if (target.state !== "unlinked" || target.projectStatus !== "active") throw new Error("Target changed");
   const requestId = crypto.randomUUID(), reviewedAt = new Date().toISOString();
   if (current) { setPending(current);setObservedAt(Date.now());retain({ operation: "approve", reviewedAt, proposalExpiresAt: current.expiresAt, body: { expectedOrgId: orgId, requestId, proposalId: current.proposalId, teamId: team, channelId: channel } }); }
   else retain({ operation: "propose", reviewedAt, body: ReviewedSlackProposeBodySchema.parse({ expectedOrgId: orgId, requestId, teamId: team, channelId: channel, expectedContextDigest: target.contextDigest }) });
   setPhase("ready");setMessage("Review the company, project, exact channel and access effects before confirming.");
  } catch { if (alive.current) { setPhase("refused");setMessage("The channel link could not be reviewed or retained. Nothing was sent. Refresh before reviewing again."); } }
  finally { busy.current = false; }
 }
 function confirmedProposal(value: Awaited<ReturnType<typeof api.proposal>>, request: SlackBindRequest) {
  const proposal = value.proposal;
  if (proposal === null || proposal.teamId !== request.body.teamId || proposal.channelId !== request.body.channelId || (request.operation === "propose" && proposal.by !== developerId)) throw new Error("Proposal mismatch");
  setPending(proposal);setObservedAt(Date.now());setPhase(proposal.state === "pending" ? Date.parse(proposal.expiresAt) > Date.now() ? "pending" : "expired" : "done");
  setMessage(proposal.state === "pending" ? "Approval request recorded. A different live owner or admin must review it, or a qualifying sole owner may review the exception." : "Proposal records an applied link. Refresh recorded Slack links to check current state.");
 }
 function confirmedReceipt(value: Awaited<ReturnType<typeof api.status>>, request: SlackBindRequest) {
  if (value.receipt.requestId !== request.body.requestId || value.receipt.operation !== "bind" || value.receipt.outcome.binding.teamId !== request.body.teamId || value.receipt.outcome.binding.channelId !== request.body.channelId) throw new Error("Receipt mismatch");
  setReceipt(`Earlier link request ${value.receipt.requestId} was recorded. This receipt is separate from current channel links.`);setPhase("done");setMessage("Link receipt confirmed. Close this flow and refresh recorded Slack links to check current state.");
 }
 async function send() {
  if (!attempt || busy.current || !alive.current || (phase !== "ready" && phase !== "absent")) return;
  if (!slackRequestCanResend(attempt, Date.now())) { setPhase("expired");setMessage("The saved link request has expired. Check its status, then refresh and review a new request.");return; }
  try { retain(attempt); } catch { setPhase("failed");setMessage("The link request could not be retained. Nothing was sent.");return; }
  busy.current = true;setPhase("sending");setMessage("Sending the reviewed channel link request.");
  try {
   if (attempt.operation === "propose") { const value = await api.propose(attempt.body);if (alive.current) confirmedProposal(value, attempt); }
   else { const value = await api.approve(attempt.body);if (alive.current) confirmedReceipt(value, attempt); }
  } catch (error) {
   if (!alive.current) return;const refused = error instanceof ApiError && [400, 401, 403, 409, 429].includes(error.status);
   setPhase(refused ? "refused" : "unknown");setMessage(refused ? "The channel link request was refused. Refresh current access and review again." : "The channel link outcome is unconfirmed. Check its status before deciding whether to resend.");
  } finally { busy.current = false; }
 }
 async function status() {
  if (!attempt || busy.current || !alive.current) return;busy.current = true;setPhase("checking");
  try {
   if (attempt.operation === "propose") { const value = await api.proposal(attempt.body.requestId);if (alive.current) confirmedProposal(value, attempt); }
   else { const value = await api.status(attempt.body.requestId);if (alive.current) confirmedReceipt(value, attempt); }
  } catch (error) {
   if (!alive.current) return;
   if (!slackRequestCanResend(attempt, Date.now())) { setPhase("expired");setMessage("The saved link request has expired. No receipt was confirmed; it will not be resent."); }
   else { setPhase(error instanceof ApiError && error.status === 404 ? "absent" : "unknown");setMessage("No link outcome confirmed. The original request may still complete. Nothing was resent."); }
  } finally { busy.current = false; }
 }
 async function refresh() {
  if (busy.current || !alive.current) return;busy.current = true;setPhase("loading");
  try { const value = await api.proposal();if (!alive.current) return;setPending(value.proposal);setObservedAt(Date.now());setAttempt(undefined);setPhase(value.proposal?.state === "pending" && Date.parse(value.proposal.expiresAt) > Date.now() ? "pending" : "editing");setMessage("Recorded approval state refreshed. Review a fresh request before sending."); }
  catch { if (alive.current) { setPhase("failed");setMessage("Recorded approval state could not be verified. Nothing was sent."); } }
  finally { busy.current = false; }
 }
 const own = pending?.by === developerId, inFlight = ["loading", "reviewing", "sending", "checking"].includes(phase);
 const label = attempt?.operation === "approve" ? own ? "Apply reviewed sole-owner exception" : "Approve reviewed Slack link" : "Request channel link approval";
 return <section aria-label="Slack channel link approval">
  <h3 ref={heading} tabIndex={-1}>Review Slack channel linking</h3>
  <p>Company {orgId} · Project {project}</p>
  <p>People in this channel gain channel-path access to this project, and task output may be sent there. Access currently uses each person's linked Slack workspace. Bot membership not verified.</p>
  <p>A channel change requires separate link and unlink confirmations. No unlink runs automatically.</p>
  {phase === "editing" && <div>
   <label>Slack workspace ID<input value={teamId} maxLength={32} onChange={event => setTeamId(event.target.value)} autoComplete="off" /></label>
   <label>Slack channel ID<input value={channelId} maxLength={32} onChange={event => setChannelId(event.target.value)} autoComplete="off" /></label>
   <button type="button" className="rv-button rv-button-secondary" onClick={() => void prepare()}>Review channel link</button>
  </div>}
  {pending && <div aria-label="Recorded Slack link proposal"><p>Proposal {pending.proposalId} · Workspace {pending.teamId} · Channel {pending.channelId}</p><p>Recorded {pending.state} · expires {pending.expiresAt}</p>{pending.state === "pending" && Date.parse(pending.expiresAt) <= observedAt && <p>This proposal expired. Review a new channel request to continue.</p>}
   {phase === "pending" && pending.state === "pending" && Date.parse(pending.expiresAt) > observedAt && <button type="button" className="rv-button rv-button-secondary" onClick={() => void prepare(pending)}>{own ? "Review sole-owner exception" : "Review pending Slack link"}</button>}
  </div>}
  {attempt && phase === "ready" && <div aria-label="Reviewed Slack link request"><p>Workspace {attempt.body.teamId} · Channel {attempt.body.channelId}</p>
   {attempt.operation === "approve" && own ? <p>The sole-owner exception is allowed only for exactly one owner with no other eligible owner or admin, with complete evidence of no eligible-access loss in the last 24 hours. The server checks this again when applying.</p> : <p>A different live company owner or admin must approve this link. Sending a proposal does not link the channel.</p>}
  </div>}
  {attempt && <button type="button" className="rv-button rv-button-secondary rv-slack-send" aria-disabled={phase !== "ready"} aria-busy={phase === "sending"} onClick={() => { if (phase === "ready") void send(); }}>{label}</button>}
  {attempt && ["unknown", "absent", "checking", "expired"].includes(phase) && <button type="button" className="rv-button rv-button-secondary" disabled={phase === "checking"} onClick={() => void status()}>Check Slack link request status</button>}
  {phase === "absent" && <button type="button" className="rv-button rv-button-secondary" onClick={() => void send()}>Resend same Slack link request</button>}
  {["done", "refused", "failed", "expired", "pending"].includes(phase) && <button type="button" className="rv-button rv-button-secondary" onClick={() => void refresh()}>Refresh Slack link approval</button>}
  {history.requests.length > 1 && <label>Earlier Slack link request<select value={history.selectedIndex} disabled={inFlight} onChange={event => {
   if (busy.current) return;try { const selected = selectSlackBindRequest(host.storage, scope, Number(event.target.value));setHistory(readSlackBindRequests(host.storage, scope));setAttempt(selected);setPhase("unknown");setMessage("Earlier link request selected. Check its status; nothing was resent."); } catch { setPhase("failed");setMessage("Saved link requests could not be verified. Nothing was sent."); }
  }}><option value={-1} disabled>Select a saved request</option>{history.requests.map((request, index) => <option key={request.body.requestId} value={index}>Request {index + 1} · {request.operation}</option>)}</select></label>}
  {receipt && <p>{receipt}</p>}<p role="status" aria-live="polite">{message}</p>
  <button type="button" className="rv-button rv-button-secondary" disabled={inFlight} onClick={onClose}>Close channel link approval</button>
 </section>;
}
