import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReviewedProjectArchivePreviewReaderSchema, ReviewedProjectArchiveOutcomeReaderSchema, type ReviewedProjectArchivePreview, type ReviewedProjectArchiveOutcome } from "@agentx/contracts/web";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
// Only recognized application refusals are definitive; an unknown proxy response stays unknown.
const refusalCodes = new Set(["AUTH_REQUIRED", "FORBIDDEN", "CSRF_STALE", "REAUTH_REQUIRED", "NOT_FOUND", "CONFIG_INVALID", "TOO_MANY_REQUESTS"]);
const definiteRefusal = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && refusalCodes.has(error.code);
type Attempt = { requestId: string; expectedOrgId: string; expectedRevision: number; expectedProjectRevision: number; acknowledgeNewWorkStops: true };
// A timeout discards the late result; it does not cancel or repeat a write.
async function bounded<T>(promise: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Unconfirmed")), 30000); })]); }
 finally { clearTimeout(timer); }
}
export function ArchiveProject({ name, available, observedStatus }: { name: string; available: boolean; observedStatus?: "active" | "archived" }) {
 const context = useAdminContext(), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [ack, setAck] = useState(false);
 const [preview, setPreview] = useState<ReviewedProjectArchivePreview>(), [checkedCurrent, setCurrent] = useState<ReviewedProjectArchivePreview>();
 // Shared checked detail may supersede this snapshot; keep its receipt/history separate.
 const current = checkedCurrent !== undefined && (observedStatus === undefined || checkedCurrent.status === observedStatus) ? checkedCurrent : undefined;
 const [receipt, setReceipt] = useState<ReviewedProjectArchiveOutcome>(), [message, setMessage] = useState(""), [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(false);
 const [attempt, setAttempt] = useState<Attempt>(), [isWriting, setIsWriting] = useState(false);
 // Fresh review is a new intent, not confirmation of an earlier request. Keep their IDs scoped here.
 const [unconfirmed, setUnconfirmed] = useState<string[]>([]);
 const earlierUnknown = unconfirmed.some(id => id !== attempt?.requestId);
 const alive = useRef(true), epoch = useRef(0), sending = useRef(false), writing = useRef(false), trigger = useRef<HTMLButtonElement>(null), status = useRef<HTMLParagraphElement>(null), pendingStatus = useRef<HTMLParagraphElement>(null);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 useEffect(() => { if (isWriting) pendingStatus.current?.focus(); }, [isWriting]);
 const valid = (token: number) => alive.current && epoch.current === token;
 function scoped(value: ReviewedProjectArchivePreview) { if (value.orgId !== context.orgId || value.project !== name) throw new Error("Scope changed");return value; }
 function publish(value: ReviewedProjectArchivePreview) {
  setCurrent(value);
  const key = ["admin", "project-detail", context.orgId, context.developerId, name];
  const previous = query.getQueryData<{ latestRevision: number }>(key);
  // The lifecycle read does not contain repositories/settings. Keep their snapshot revision
  // truthful and independently refresh detail when configuration changed.
  query.setQueryData(key, (old: Record<string, unknown> | undefined) => old === undefined ? old : { ...old, status: value.status });
  if (previous !== undefined && previous.latestRevision !== value.expectedProjectRevision) void query.invalidateQueries({ queryKey: key, exact: true });
  void query.invalidateQueries({ queryKey: ["admin", "projects", context.orgId, context.developerId] });
 }
 function deny(error: unknown) {
  if (error instanceof ApiError && [401, 403].includes(error.status)) void query.invalidateQueries({ queryKey: ["admin", "identity"] });
 }
 async function check(fresh = false) {
  if (sending.current || context.checking) return;
  sending.current = true;setBusy(true);setAck(false);const token = ++epoch.current;
  try {
   const value = scoped(await bounded(api.get(`/v1/app/projects/${encodeURIComponent(name)}/archive-preview`, ReviewedProjectArchivePreviewReaderSchema)));
   if (!valid(token)) return;
   publish(value);setPreview(value);setMessage("");
   if (fresh) { setAttempt(undefined);setReceipt(undefined);setUncertain(false);setStale(false); }
  } catch (error) { if (valid(token)) { setPreview(undefined);setCurrent(undefined);setMessage("Couldn't check this project. Refresh and review before archiving.");deny(error); } }
  finally { if (valid(token)) { sending.current = false;setBusy(false); } }
 }
 const samePins = preview !== undefined && (attempt === undefined || (preview.expectedRevision === attempt.expectedRevision && preview.expectedProjectRevision === attempt.expectedProjectRevision));
 const canWrite = !busy && !context.checking && available && !stale && ack && preview?.status === "active" && preview.access.actions.includes("archive") && samePins && receipt === undefined;
 async function commit() {
  if (sending.current || !canWrite || preview === undefined) return;
  sending.current = true;writing.current = true;setIsWriting(true);setBusy(true);setAck(false);setCurrent(undefined);setMessage("");const token = ++epoch.current;
  const change: Attempt = attempt ?? { requestId: crypto.randomUUID(), expectedOrgId: context.orgId, expectedRevision: preview.expectedRevision, expectedProjectRevision: preview.expectedProjectRevision, acknowledgeNewWorkStops: true };
  setAttempt(change);
  let recorded = false;
  try {
   const result = await bounded(api.send("POST", `/v1/app/projects/${encodeURIComponent(name)}/reviewed-archive`, change, ReviewedProjectArchiveOutcomeReaderSchema, { retry: "never" }));
   if (!valid(token)) return;
   if (result.kind !== "done" || result.value.receipt.project !== name || result.value.receipt.projectRevision !== change.expectedProjectRevision || result.value.receipt.revision !== change.expectedRevision + 1) throw new Error("Unconfirmed");
   scoped(result.value.current);recorded = true;setReceipt(result.value);setUncertain(false);
   setUnconfirmed(ids => ids.filter(id => id !== change.requestId));
   // Never render a historical receipt as current status, even on an idempotent replay.
   const value = scoped(await bounded(api.get(`/v1/app/projects/${encodeURIComponent(name)}/archive-preview`, ReviewedProjectArchivePreviewReaderSchema)));
   if (valid(token)) { publish(value);setPreview(value); }
  } catch (error) {
   if (!valid(token)) return;
   setPreview(undefined);setCurrent(undefined);
   if (!recorded && error instanceof ApiError && error.status === 409 && error.code === "CHANGE_STALE") { setStale(true);setMessage("The project changed. Review the latest state before a new archive request."); }
   else if (!recorded && definiteRefusal(error)) {
    const previouslyUnknown = unconfirmed.includes(change.requestId);
    setStale(true);setUncertain(previouslyUnknown);
    setMessage("This submission was refused. No new archive was recorded by this submission." + (previouslyUnknown ? " The earlier outcome for this request is still unconfirmed." : ""));
   } else {
    setUncertain(!recorded);
    if (!recorded) setUnconfirmed(ids => ids.includes(change.requestId) ? ids : [...ids, change.requestId]);
    setMessage(recorded ? "The archive was recorded. Current project state is unconfirmed. Check current state." : "Your archive request's outcome is unconfirmed. Check current state before deciding what to do next.");
   }
   deny(error);
  } finally { if (valid(token)) { writing.current = false;setIsWriting(false);sending.current = false;setBusy(false); } }
 }
 const mayFreshReview = (receipt !== undefined && current?.status === "active") || stale || (uncertain && preview !== undefined && !samePins);
 function changeOpen(next: boolean) {
  if (writing.current) return;
  setOpen(next);setAck(false);
  if (next) { if (attempt === undefined) void check(true);else void check(); }
  else { epoch.current++;sending.current = false;setBusy(false);setPreview(undefined); }
 }
 return <section aria-label="Archive project">
  {(available || uncertain || earlierUnknown || receipt !== undefined || stale) && <Button ref={trigger} disabled={busy || context.checking} onClick={() => changeOpen(true)}>Review archive</Button>}
  <p ref={status} tabIndex={-1} role="status">{!open && current ? `Current project status: ${current.status === "archived" ? "Archived" : "Active"}.` : !open && receipt ? "Current project status is unconfirmed." : !open && uncertain ? "Archive request outcome is unconfirmed. Reopen the review to check current state." : !open && earlierUnknown ? "An earlier archive request remains unconfirmed. Reopen the review to check current state." : ""}{!open && current && uncertain ? " Archive request outcome is unconfirmed." : !open && current && earlierUnknown ? " An earlier archive request remains unconfirmed." : ""}</p>
  <Dialog className="rv-admin-archive-review" title="Archive project" open={open} onOpenChange={changeOpen} onCloseAutoFocus={event => { event.preventDefault();if (current?.status === "archived" || !trigger.current) status.current?.focus();else trigger.current.focus(); }}>
   <p>Company: <VisibleText text={context.company} />. Project: <VisibleText text={name} />.</p>
   <p>New work will stop. Existing work continues. Nothing is deleted.</p>
   <p ref={pendingStatus} role="status" aria-label="Archive request progress" tabIndex={-1} hidden={!busy && !message && receipt === undefined}>{busy ? "Checking the archive request…" : receipt ? "Archive receipt received. Current state is shown separately below." : message ? "Check finished. See the result below." : ""}</p>
   {(message || uncertain) && <p role="alert">{message || "Your archive request's outcome is unconfirmed. The checked current state does not confirm who changed it."}</p>}
   {earlierUnknown && <p role="alert">An earlier archive request remains unconfirmed. Reviewing new state does not confirm its outcome.</p>}
   {receipt && <><p>Original archive recorded at {receipt.receipt.archivedAt}. This receipt describes the original action.</p><p>Website synchronization: {receipt.effects.egress === "pending" ? "Unconfirmed; scheduled reconciliation remains available." : receipt.effects.egress === "not_attempted" ? "Not repeated for this receipt." : "This synchronization attempt completed."}</p>{receipt.effects.archiveHook === "pending" && <p>Archive notification is unconfirmed; no retry is queued.</p>}{receipt.effects.evidenceClean === "pending" && <p>This project's stored proof evidence is still being removed. It finishes on its own within a few minutes; nothing needs to be done.</p>}</>}
   {current && <p role="status">Current project status: {current.status === "archived" ? "Archived" : "Active"}.</p>}
   {preview && <p>Project revision: {preview.expectedProjectRevision}.</p>}
   {current && <p>Checked at {current.checkedAt}. Current state is separate from the original receipt.</p>}
   {preview?.status === "active" && receipt === undefined && samePins && !stale && <label><input type="checkbox" checked={ack} disabled={busy || context.checking} onChange={event => setAck(event.target.checked)} /> I understand that new work stops and existing work continues.</label>}
   {receipt === undefined && !stale && samePins && <Button variant="danger" disabled={!canWrite} onClick={() => void commit()}>{uncertain ? "Retry same archive request" : "Archive project"}</Button>}
   {(uncertain || earlierUnknown || receipt !== undefined || message) && <Button disabled={busy || context.checking} onClick={() => void check()}>Check current state</Button>}
   {mayFreshReview && <Button disabled={busy || context.checking} onClick={() => void check(true)}>Review latest state</Button>}
   <Button disabled={isWriting} onClick={() => changeOpen(false)}>{attempt ? "Close" : "Cancel"}</Button>
  </Dialog>
 </section>;
}
