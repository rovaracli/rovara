import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectAllowedWebsitesMutationBodySchema, ProjectAllowedWebsitesApprovalBodySchema, ProjectAllowedWebsitesDecisionBodySchema, type ProjectAllowedWebsitesReview, type ProjectAllowedWebsitesResult } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../../host.js";
import { createAllowedWebsitesApi } from "../../../api/allowed-websites.js";
import { TextArea } from "../../../design/TextArea.js";
import "./allowed-websites.css";
import { ApiError } from "../../../api/errors.js";
import { readWebsiteRequests, retainWebsiteRequest, selectWebsiteRequest, type WebsiteRequest } from "./allowed-websites-history.js";

type Props = { orgId: string; developerId: string; project: string; enabled: boolean };
type Phase = "loading" | "editing" | "ready" | "sending" | "unknown" | "checking" | "absent" | "done" | "refused";
/** The enclosing surface supplies fresh identity; the server rechecks project authority. */
export function AllowedWebsitesEditor(props: Props) {
 return props.enabled ? <ScopedWebsiteEditor key={`${props.orgId}:${props.developerId}:${props.project}`} {...props} /> : null;
}
function ScopedWebsiteEditor(props: Props) {
 const host = useAppHost(), { orgId, developerId, project, enabled } = props;
 const api = useMemo(() => createAllowedWebsitesApi(host, orgId, project), [host, orgId, project]);
 const scope = useMemo(() => ({ orgId, developerId, project }), [orgId, developerId, project]);
 const [review, setReview] = useState<ProjectAllowedWebsitesReview>(), [draft, setDraft] = useState("");
 const [history, setHistory] = useState<{ requests: WebsiteRequest[]; selectedIndex: number }>({ requests: [], selectedIndex: -1 });
 const [soleOwnerAcknowledged, setSoleOwnerAcknowledged] = useState(false);
 const [attempt, setAttempt] = useState<WebsiteRequest>(), [phase, setPhase] = useState<Phase>("loading"), [message, setMessage] = useState("");
 const alive = useRef(false), busy = useRef(false), canonicalHeading = useRef<HTMLHeadingElement>(null), focusCanonical = useRef(false);
 const [receiptSummary, setReceiptSummary] = useState("");
 useEffect(() => { if (focusCanonical.current) { canonicalHeading.current?.focus();focusCanonical.current = false; } }, [review]);
 useEffect(() => {
  alive.current = enabled;api.setScopeActive(enabled);
  if (enabled) void api.review().then(value => {
   if (!alive.current) return;
   setReview(value);setDraft(value.allowedDomains.join("\n"));
   try {
    const history = readWebsiteRequests(host.storage, scope), saved = history.requests[history.selectedIndex];setHistory(history);
    setAttempt(saved);setPhase(saved ? "unknown" : "editing");
    if (saved) setMessage("A saved request is available. Check its status; nothing was resent.");
   } catch { setPhase("refused");setMessage("Saved requests could not be verified. Sending is unavailable."); }
  }).catch(() => { if (alive.current) { setPhase("refused");setMessage("Website settings could not be checked. Refresh your project access."); } });
  return () => { alive.current = false;api.setScopeActive(false); };
 }, [api, enabled, host.storage, scope]);
 async function refresh() {
  if (busy.current || !enabled || !alive.current) return;
  busy.current = true;setPhase("loading");
  try {
   const value = await api.review();
   if (!alive.current) return;
   focusCanonical.current = review !== undefined && (value.baseRevision !== review.baseRevision || value.contextDigest !== review.contextDigest);
   setReview(value);setDraft(value.allowedDomains.join("\n"));setAttempt(undefined);setPhase("editing");setMessage("Canonical website settings refreshed. Review a fresh request before sending.");
  } catch { if (alive.current) { setPhase("refused");setMessage("Website settings could not be checked. Refresh your project access."); } }
  finally { busy.current = false; }
 }
 function prepare() {
  if (!review || busy.current || !enabled) return;
  try {
   const body = ProjectAllowedWebsitesMutationBodySchema.parse({ expectedOrgId: orgId, requestId: crypto.randomUUID(), expectedRevision: review.baseRevision, expectedContextDigest: review.contextDigest, allowedDomains: draft.split(/\r?\n/).map(value => value.trim()).filter(Boolean) });
   const request: WebsiteRequest = { operation: body.allowedDomains.some(domain => !review.allowedDomains.includes(domain)) ? "propose" : "save", body };
   retainWebsiteRequest(host.storage, scope, request);setHistory(readWebsiteRequests(host.storage, scope));setAttempt(request);setPhase("ready");setMessage("Review the exact website change before sending.");
  } catch { setMessage("Enter up to 50 valid hostnames. Request storage must also be available before sending."); }
 }
 function prepareApproval() {
  const proposal = review?.liveProposal;
  if (!proposal || proposal.status !== "pending" || busy.current || !enabled || (proposal.proposedBy === developerId && !soleOwnerAcknowledged)) return;
  try {
   const request: WebsiteRequest = { operation: "approve", proposalId: proposal.proposalId, body: ProjectAllowedWebsitesApprovalBodySchema.parse({ expectedOrgId: orgId, requestId: crypto.randomUUID(), soleOwnerAcknowledged: proposal.proposedBy === developerId && soleOwnerAcknowledged }) };
   retainWebsiteRequest(host.storage, scope, request);setHistory(readWebsiteRequests(host.storage, scope));setAttempt(request);setPhase("ready");setMessage("Review this proposal before approving. Eligibility and the exact proposal are checked again when sent.");
  } catch { setMessage("The approval request could not be retained. Nothing was sent."); }
 }
 function prepareDecision(operation: "cancel" | "reject") {
  const proposal = review?.liveProposal;
  if (!proposal || proposal.status !== "pending" || busy.current || !enabled || (operation === "cancel") !== (proposal.proposedBy === developerId)) return;
  try {
   const request: WebsiteRequest = { operation, proposalId: proposal.proposalId, body: ProjectAllowedWebsitesDecisionBodySchema.parse({ expectedOrgId: orgId, requestId: crypto.randomUUID() }) };
   retainWebsiteRequest(host.storage, scope, request);setHistory(readWebsiteRequests(host.storage, scope));setAttempt(request);setPhase("ready");setMessage(operation === "cancel" ? "Review cancellation of this proposal before sending." : "Review rejection of this proposal before sending.");
  } catch { setMessage("The decision request could not be retained. Nothing was sent."); }
 }
 function confirmed(result: ProjectAllowedWebsitesResult) {
  if (!alive.current) return;
  if (result.kind === "receipt") setReceiptSummary(result.receipt.state === "applied" ? `Earlier request applied at revision ${result.receipt.resultRevision}. This is a receipt, independent of current website settings.` : `Earlier request ${result.receipt.state}. This is a receipt, independent of current website settings.`);
  setPhase("done");setMessage(result.kind === "proposal" ? result.status === "pending" ? "Proposal retained. A different eligible person must review additions; company approval is separate from staff approval." : `Proposal status: ${result.status}. Refresh canonical website settings to see the current list.` : result.kind === "unchanged" ? "No website settings changed." : "Receipt confirmed. Refresh canonical website settings to see the current list; this receipt describes the earlier request.");
 }
 async function send() {
  if (!attempt || busy.current || !enabled || !alive.current) return;
  busy.current = true;setPhase("sending");setMessage("Sending website request.");
  try {
   retainWebsiteRequest(host.storage, scope, attempt);
   const result = "proposalId" in attempt ? await api.decide(attempt.proposalId, attempt.operation, attempt.body) : attempt.operation === "save" ? await api.save(attempt.body) : await api.propose(attempt.body);
   confirmed(result);
  } catch (error) {
   if (!alive.current) return;
   const refused = error instanceof ApiError && [400, 401, 403, 409, 429].includes(error.status);
   setPhase(refused ? "refused" : "unknown");setMessage(refused ? "The request was refused. Refresh project access and review a fresh request." : "Request outcome is unconfirmed. Check its status before deciding whether to resend.");
  } finally { busy.current = false; }
 }
 async function status() {
  if (!attempt || busy.current || !enabled || !alive.current) return;
  busy.current = true;setPhase("checking");
  try { confirmed(await api.request(attempt.body.requestId)); }
  catch (error) { if (alive.current) { setPhase(error instanceof ApiError && error.status === 404 ? "absent" : "unknown");setMessage("No receipt confirmed. The original request may still complete. No request was resent."); } }
  finally { busy.current = false; }
 }
 if (!enabled) return null;
 const mutation = attempt && (attempt.operation === "save" || attempt.operation === "propose") ? attempt : undefined;
 const locked = phase !== "editing";
 return <section className="rv-websites-editor" aria-label="Allowed websites editor">
  <p>Company approval and staff approval are separate. DNS enforcement is cell-wide, trusts CNAMEs, and updates eventually.</p>
  {review && <><details className="rv-websites-defaults"><summary>Always-allowed websites ({review.defaultDomains.length})</summary><p>These deployment defaults are read-only here.</p><ul>{review.defaultDomains.map(domain => <li key={domain}>{domain}</li>)}</ul></details>
   <h3 ref={canonicalHeading} tabIndex={-1}>Current project websites</h3><ul>{review.staffDomains.map(entry => <li key={entry.domain}>{entry.domain} · staff {entry.status}</li>)}</ul>
   <TextArea label="Allowed websites, one hostname per line" hint="Use hostnames, including raw xn-- names. Mandatory defaults stay separate." value={draft} disabled={locked} onChange={event => setDraft(event.target.value)} />
   {phase === "editing" && <button className="rv-button rv-button-secondary" type="button" onClick={prepare}>Review website change</button>}
  </>}
  {review?.liveProposal?.status === "pending" && <section aria-label="Pending website proposal">
   <h3>Pending website proposal</h3>
   <p>{review.liveProposal.proposedBy === developerId ? "You proposed this change." : "Another eligible person proposed this change."}</p>
   <p>Reviewed revision {review.liveProposal.baseRevision}. Expires {review.liveProposal.expiresAt}.</p>
   {review.liveProposal.beforeDomains.filter(domain => !review.liveProposal!.afterDomains.includes(domain)).map(domain => <p key={domain}>Proposal removes: {domain}</p>)}
   {review.liveProposal.afterDomains.filter(domain => !review.liveProposal!.beforeDomains.includes(domain)).map(domain => <p key={domain}>Proposal adds: {domain}</p>)}
   {phase === "editing" && (review.liveProposal.proposedBy === developerId ? <>
    <label><input type="checkbox" checked={soleOwnerAcknowledged} onChange={event => setSoleOwnerAcknowledged(event.target.checked)} />I am the sole company owner with no other eligible approver. I acknowledge this audited exception and its 24-hour eligibility-loss cool-off.</label>
    <button className="rv-button rv-button-secondary" type="button" disabled={!soleOwnerAcknowledged} onClick={prepareApproval}>Review sole-owner exception</button>
   </> : <button className="rv-button rv-button-secondary" type="button" onClick={prepareApproval}>Review proposal approval</button>)}
   {phase === "editing" && <button className="rv-button rv-button-secondary" type="button" onClick={() => prepareDecision(review.liveProposal!.proposedBy === developerId ? "cancel" : "reject")}>{review.liveProposal.proposedBy === developerId ? "Review proposal cancellation" : "Review proposal rejection"}</button>}
  </section>}
  {mutation && phase === "ready" && review && <div aria-label="Reviewed website change">
   <p>Reviewed project revision {mutation.body.expectedRevision}.</p>
   {review.allowedDomains.filter(domain => !mutation.body.allowedDomains.includes(domain)).map(domain => <p key={domain}>Remove: {domain}</p>)}
   {mutation.body.allowedDomains.filter(domain => !review.allowedDomains.includes(domain)).map(domain => <p key={domain}>Add: {domain}</p>)}
  </div>}
  {attempt && phase !== "editing" && <button className="rv-button rv-button-secondary" type="button" disabled={phase !== "ready"} aria-busy={phase === "sending"} onClick={() => void send()}>{attempt?.operation === "cancel" ? "Cancel reviewed proposal" : attempt?.operation === "reject" ? "Reject reviewed proposal" : attempt?.operation === "approve" ? "Approve reviewed proposal" : attempt?.operation === "propose" ? "Propose website additions" : "Save website removal"}</button>}
  {["unknown", "absent", "checking"].includes(phase) && <button className="rv-button rv-button-secondary" type="button" disabled={phase === "checking"} onClick={() => void status()}>Check request status</button>}
  {phase === "absent" && <button className="rv-button rv-button-secondary" type="button" onClick={() => void send()}>Resend same request</button>}
  {["done", "refused"].includes(phase) && <button className="rv-button rv-button-secondary" type="button" onClick={() => void refresh()}>Refresh canonical website settings</button>}
  {history.requests.length > 1 && <label>Earlier website request<select aria-label="Earlier website request" value={history.selectedIndex} disabled={["loading", "sending", "checking"].includes(phase)} onChange={event => {
   if (busy.current) return;
   try {
    const saved = selectWebsiteRequest(host.storage, scope, Number(event.target.value));setHistory(readWebsiteRequests(host.storage, scope));setAttempt(saved);setPhase("unknown");setMessage("Earlier request selected. Check its status; nothing was resent.");
   } catch { setPhase("refused");setMessage("The saved request could not be verified. Nothing was sent."); }
  }}>{history.requests.map((request, index) => <option key={request.body.requestId} value={index}>Request {index + 1} · {request.operation}</option>)}</select></label>}
  {receiptSummary && <p>{receiptSummary}</p>}
  <p role="status" aria-live="polite">{message}</p>
 </section>;
}
