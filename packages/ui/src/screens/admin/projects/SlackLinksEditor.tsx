import "./project-slack.css";
import { SlackBindEditor } from "./SlackBindEditor.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReviewedSlackUnbindBodySchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createProjectSlackApi } from "../../../api/project-slack.js";
import { readSlackRequests, retainSlackRequest, selectSlackRequest, slackRequestCanResend, type SlackRequest } from "./project-slack-history.js";
type Props = { orgId: string; developerId: string; project: string; enabled: boolean };
type Inventory = Awaited<ReturnType<ReturnType<typeof createProjectSlackApi>["list"]>>;
type Phase = "loading" | "editing" | "reviewing" | "ready" | "sending" | "unknown" | "checking" | "absent" | "expired" | "done" | "refused" | "failed";
export function SlackLinksEditor(props: Props) { return props.enabled ? <ScopedSlackLinks key={`${props.orgId}:${props.developerId}:${props.project}`} {...props} /> : null; }
function ScopedSlackLinks({ orgId, developerId, project }: Props) {
 const host = useAppHost(), api = useMemo(() => createProjectSlackApi(host, orgId, project), [host, orgId, project]);
 const scope = useMemo(() => ({ orgId, developerId, project }), [orgId, developerId, project]);
 const [inventory, setInventory] = useState<Inventory>(), [phase, setPhase] = useState<Phase>("loading"), [attempt, setAttempt] = useState<SlackRequest>(), [message, setMessage] = useState("");
 const [history, setHistory] = useState<{ requests: SlackRequest[]; selectedIndex: number }>({ requests: [], selectedIndex: -1 }), [receipt, setReceipt] = useState("");
 const [bindOpen, setBindOpen] = useState(false), bindEntry = useRef<HTMLButtonElement>(null);
 const alive = useRef(false), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null), focusHeading = useRef(false);
 useEffect(() => { if (focusHeading.current) { heading.current?.focus();focusHeading.current = false; } }, [inventory]);
 useEffect(() => {
  alive.current = true;api.setScopeActive(true);
  void api.list().then(value => {
   if (!alive.current) return;
   try { const saved = readSlackRequests(host.storage, scope), request = saved.requests[saved.selectedIndex];setInventory(value);setHistory(saved);setAttempt(request);setPhase(request ? "unknown" : "editing");if (request) setMessage("A saved Slack request is available. Check its status; nothing was resent."); }
   catch { setPhase("failed");setMessage("Saved Slack requests could not be verified. Nothing was sent."); }
  }).catch(() => { if (alive.current) { setPhase("failed");setMessage("Slack links could not be checked. Refresh project access."); } });
  return () => { alive.current = false;api.setScopeActive(false); };
 }, [api, host.storage, scope]);
 async function load(cursor?: string) {
  if (busy.current || !alive.current) return;busy.current = true;setPhase("loading");
  try {
   const value = await api.list(cursor);if (!alive.current) return;
   focusHeading.current = cursor === undefined && inventory !== undefined && JSON.stringify(value.bindings) !== JSON.stringify(inventory.bindings);
   setInventory(value);setAttempt(undefined);setPhase("editing");setMessage("Recorded Slack links refreshed. Review a fresh request before sending.");
  } catch { if (alive.current) { setInventory(undefined);setAttempt(undefined);setPhase("failed");setMessage("Slack links could not be checked. Refresh project access."); } }
  finally { busy.current = false; }
 }
 async function prepare(teamId: string, channelId: string) {
  if (busy.current || !alive.current || phase !== "editing") return;busy.current = true;setPhase("reviewing");
  try {
   const value = await api.review(teamId, channelId);if (!alive.current) return;
   if (value.state !== "linked") throw new Error("Link changed");
   const request = { reviewedAt: new Date().toISOString(), body: ReviewedSlackUnbindBodySchema.parse({ expectedOrgId: orgId, requestId: crypto.randomUUID(), teamId, channelId, expectedContextDigest: value.contextDigest }) };
   retainSlackRequest(host.storage, scope, request);setHistory(readSlackRequests(host.storage, scope));setAttempt(request);setPhase("ready");setMessage("Review the exact channel and access effects before unlinking.");
  } catch { if (alive.current) { setPhase("refused");setMessage("The Slack unlink could not be reviewed or retained. Nothing was sent. Refresh access and review again."); } }
  finally { busy.current = false; }
 }
 function confirm(value: Awaited<ReturnType<typeof api.status>>) {
  if (!alive.current) return;
  setReceipt(`Earlier request ${value.receipt.requestId}: ${value.receipt.operation === "unbind" ? value.receipt.outcome.removed ? "unlink recorded" : "no link was present" : "link recorded"}. This receipt is separate from current bindings.`);
  setPhase("done");setMessage("Receipt confirmed. Refresh recorded Slack links to check current state.");
 }
 async function send() {
  if (!attempt || busy.current || !alive.current || (phase !== "ready" && phase !== "absent")) return;
  if (!slackRequestCanResend(attempt, Date.now())) { setPhase("expired");setMessage("The receipt retention window has ended. Refresh links and review a new request; the old request will not be resent.");return; }
  try { retainSlackRequest(host.storage, scope, attempt); } catch { setPhase("refused");setMessage("The request could not be retained. Nothing was sent.");return; }
  busy.current = true;setPhase("sending");setMessage("Sending Slack unlink request.");
  try { confirm(await api.unbind(attempt.body)); }
  catch (error) {
   if (!alive.current) return;const refused = error instanceof ApiError && [400, 401, 403, 409, 429].includes(error.status);
   setPhase(refused ? "refused" : "unknown");setMessage(refused ? "The Slack request was refused. Refresh access and review a new request." : "Slack request outcome is unconfirmed. Check its status before deciding whether to resend.");
  } finally { busy.current = false; }
 }
 async function status() {
  if (!attempt || busy.current || !alive.current) return;busy.current = true;setPhase("checking");
  try { confirm(await api.status(attempt.body.requestId)); }
  catch (error) {
   if (!alive.current) return;
   if (error instanceof ApiError && error.status === 404 && !slackRequestCanResend(attempt, Date.now())) { setPhase("expired");setMessage("The receipt retention window has ended. Refresh links and review a new request; the old request will not be resent."); }
   else { setPhase(error instanceof ApiError && error.status === 404 ? "absent" : "unknown");setMessage("No receipt confirmed. The original request may still complete. Nothing was resent."); }
  } finally { busy.current = false; }
 }
 return <section aria-label="Slack links editor">
  <p>Recorded channel links only. Bot membership not verified. Channel-path access currently uses each person's linked Slack workspace.</p>
  <h3 ref={heading} tabIndex={-1}>Current recorded Slack links</h3>
  {inventory && <>
   {inventory.partial && <p>This is a partial page of recorded links. Other links may exist.</p>}
   {inventory.workspaces.length === 0 && <p>No connected Slack workspace was returned. Contact your company administrator for operator assistance.</p>}
   {inventory.bindings.length === 0 ? <p>No links for this project were returned on this page.</p> : <ul>{inventory.bindings.map(link => <li key={`${link.teamId}:${link.channelId}`}>
    <code>{link.teamId} / {link.channelId}</code> · recorded {link.updatedAt}{phase === "editing" && !bindOpen && <button className="rv-button rv-button-secondary" type="button" onClick={() => void prepare(link.teamId, link.channelId)}>Review unlink {link.teamId} / {link.channelId}</button>}
   </li>)}</ul>}
   {inventory.continuation !== null && phase === "editing" && !bindOpen && <button className="rv-button rv-button-secondary" type="button" onClick={() => void load(inventory.continuation!)}>Next Slack links page</button>}
  </>}
  {attempt && phase === "ready" && <div aria-label="Reviewed Slack unlink">
   <p>Company {orgId} · Project {project}</p><p>Workspace {attempt.body.teamId} · Channel {attempt.body.channelId}</p>
   <p>Unlinking removes this channel's project access path; direct grants and other linked channels remain.</p>
   <p>Existing tasks that pinned this link fail their next access check. New mentions in this channel will be ignored.</p>
   <p>Messages already sent are not recalled. A channel change needs separate link and unlink confirmations; no second step runs automatically.</p>
  </div>}
  {attempt && phase !== "editing" && <button className="rv-button rv-button-secondary rv-slack-send" type="button" aria-disabled={phase !== "ready"} aria-busy={phase === "sending"} onClick={() => { if (phase === "ready") void send(); }}>Unlink reviewed channel</button>}
  {["unknown", "absent", "checking"].includes(phase) && <button className="rv-button rv-button-secondary" type="button" disabled={phase === "checking"} onClick={() => void status()}>Check Slack request status</button>}
  {phase === "absent" && <button className="rv-button rv-button-secondary" type="button" onClick={() => void send()}>Resend same Slack request</button>}
  {["done", "refused", "expired", "failed"].includes(phase) && <button className="rv-button rv-button-secondary" type="button" onClick={() => void load()}>Refresh recorded Slack links</button>}
  {!bindOpen && history.requests.length > 1 && <label>Earlier Slack request<select value={history.selectedIndex} disabled={["loading", "reviewing", "sending", "checking"].includes(phase)} onChange={event => {
   if (busy.current) return;try { const value = selectSlackRequest(host.storage, scope, Number(event.target.value));setHistory(readSlackRequests(host.storage, scope));setAttempt(value);setPhase("unknown");setMessage("Earlier Slack request selected. Check its status; nothing was resent."); } catch { setPhase("failed");setMessage("The saved request could not be checked. Nothing was sent."); }
  }}>{history.requests.map((row, i) => <option key={row.body.requestId} value={i}>Request {i + 1} · unlink</option>)}</select></label>}
  {phase === "editing" && <button ref={bindEntry} type="button" className="rv-button rv-button-secondary" aria-expanded={bindOpen} aria-disabled={bindOpen} onClick={() => { if (!bindOpen) setBindOpen(true); }}>Link a Slack channel</button>}
  {phase === "editing" && bindOpen && <SlackBindEditor orgId={orgId} developerId={developerId} project={project} onClose={() => { try { setHistory(readSlackRequests(host.storage, scope)); } catch { setPhase("failed");setMessage("Saved Slack requests could not be verified. Nothing was sent."); }setBindOpen(false);bindEntry.current?.focus(); }} />}
  {phase === "editing" && !bindOpen && <button type="button" className="rv-button rv-button-secondary" onClick={() => void load()}>Refresh recorded Slack links</button>}
  {receipt && <p>{receipt}</p>}{!bindOpen && <p role="status" aria-live="polite">{message}</p>}
 </section>;
}
