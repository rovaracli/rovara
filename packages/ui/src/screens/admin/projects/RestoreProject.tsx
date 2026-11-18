import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PROJECT_LIFECYCLE_SENTENCES, ReviewedProjectRestorePreviewReaderSchema, ReviewedProjectRestoreOutcomeReaderSchema, type ReviewedProjectRestorePreview, type ReviewedProjectRestoreOutcome } from "@agentx/contracts/web";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../admin-context.js";
// Only recognized application refusals are definitive; an unknown proxy response stays unknown.
const refusalCodes = new Set(["AUTH_REQUIRED", "FORBIDDEN", "CSRF_STALE", "NOT_FOUND", "CONFIG_INVALID", "TOO_MANY_REQUESTS"]);
// Guided onboarding PR 17: Cloud's fixed "not on Code yet" and "not on the engine" refusals also record nothing.
const notServed = new Set(["NOT_ON_CODE_YET", "ARCHIVE_NOT_AVAILABLE"]);
const definiteRefusal = (error: unknown) => error instanceof ApiError && ((error.status >= 400 && error.status < 500 && refusalCodes.has(error.code)) || ((error.status === 501 || error.status === 503) && notServed.has(error.code)));
/** Cloud's fixed lifecycle sentence on a refusal (PROJECT_LIFECYCLE_WORDS), never any other text the answer carried. */
const fixedWords = (error: unknown) => error instanceof ApiError && PROJECT_LIFECYCLE_SENTENCES.has(error.message) ? error.message : "";
// Code #839 answers "not_required": restoring needs no deployment check there (each new task still checks its own prerequisites).
const prerequisitesOk = (preview: ReviewedProjectRestorePreview) => preview.prerequisites === "checked" || preview.prerequisites === "not_required";
/** Code's impact, in plain words. */
function RestoreImpact({ impact }: { impact: NonNullable<ReviewedProjectRestorePreview["impact"]> }) {
 const channels = impact.linkedSlackChannels;
 return <><p>New work can start in this project again{channels === 0 ? "." : `, from Rovara and from its ${channels} linked Slack ${channels === 1 ? "channel" : "channels"}.`}</p><p>Restoring doesn't start or resume any work by itself.</p></>;
}
type Attempt = { requestId: string; expectedOrgId: string; expectedRevision: number; expectedProjectRevision: number; acknowledgeNewWorkAllowed: true };
// A timeout discards the late result; it does not cancel or repeat a write.
async function bounded<T>(promise: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Unconfirmed")), 30000); })]); }
 finally { clearTimeout(timer); }
}
export function RestoreProject({ name, available, observedStatus }: { name: string; available: boolean; observedStatus: "active" | "archived" }) {
 const context = useAdminContext(), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [ack, setAck] = useState(false);
 const [preview, setPreview] = useState<ReviewedProjectRestorePreview>(), [checkedCurrent, setCurrent] = useState<ReviewedProjectRestorePreview>();
 // Shared checked detail may supersede this snapshot; keep its receipt/history separate.
 const current = checkedCurrent !== undefined && checkedCurrent.status === observedStatus ? checkedCurrent : undefined;
 const [receipt, setReceipt] = useState<ReviewedProjectRestoreOutcome>(), [message, setMessage] = useState(""), [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(false), [said, setSaid] = useState("");
 const [attempt, setAttempt] = useState<Attempt>(), [isWriting, setIsWriting] = useState(false);
 // Fresh review is a new intent, not confirmation of an earlier request. Keep their IDs scoped here.
 const [unconfirmed, setUnconfirmed] = useState<string[]>([]);
 const earlierUnknown = unconfirmed.some(id => id !== attempt?.requestId);
 const alive = useRef(true), epoch = useRef(0), sending = useRef(false), writing = useRef(false), trigger = useRef<HTMLButtonElement>(null), status = useRef<HTMLParagraphElement>(null), pendingStatus = useRef<HTMLParagraphElement>(null);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 useEffect(() => { if (isWriting) pendingStatus.current?.focus(); }, [isWriting]);
 const valid = (token: number) => alive.current && epoch.current === token;
 function scoped(value: ReviewedProjectRestorePreview) { if (value.orgId !== context.orgId || value.project !== name) throw new Error("Scope changed");return value; }
 function publish(value: ReviewedProjectRestorePreview) {
  setCurrent(value);
  const key = ["admin", "project-detail", context.orgId, context.developerId, name];
  const previous = query.getQueryData<{ latestRevision: number }>(key);
  // The lifecycle read does not contain repositories/settings. Keep their snapshot revision
  // truthful and independently refresh detail when configuration changed.
  query.setQueryData(key, (old: Record<string, unknown> | undefined) => old === undefined ? old : { ...old, status: value.status });
  if (previous !== undefined && previous.latestRevision !== value.expectedProjectRevision) void query.invalidateQueries({ queryKey: key, exact: true });
  void query.invalidateQueries({ queryKey: ["admin", "projects", context.orgId, context.developerId] });
  // The page's archive state and offered action follow the checked state.
  void query.invalidateQueries({ queryKey: ["admin", "project-lifecycle", context.orgId, context.developerId, name], exact: true });
 }
 function deny(error: unknown) {
  if (error instanceof ApiError && [401, 403].includes(error.status)) void query.invalidateQueries({ queryKey: ["admin", "identity"] });
 }
 async function check(fresh = false) {
  if (sending.current || context.checking) return;
  sending.current = true;setBusy(true);setAck(false);const token = ++epoch.current;
  try {
   const value = scoped(await bounded(api.get(`/v1/app/projects/${encodeURIComponent(name)}/restore-preview`, ReviewedProjectRestorePreviewReaderSchema)));
   if (!valid(token)) return;
   publish(value);setPreview(value);setMessage("");setSaid("");
   if (fresh) { setAttempt(undefined);setReceipt(undefined);setUncertain(false);setStale(false); }
  } catch (error) { if (valid(token)) { setPreview(undefined);setCurrent(undefined);setMessage("Couldn't check this project. Refresh and review before restoring.");setSaid(fixedWords(error));deny(error); } }
  finally { if (valid(token)) { sending.current = false;setBusy(false); } }
 }
 const samePins = preview !== undefined && (attempt === undefined || (preview.expectedRevision === attempt.expectedRevision && preview.expectedProjectRevision === attempt.expectedProjectRevision));
 const canWrite = !busy && !context.checking && available && !stale && ack && preview?.status === "archived" && preview.access.actions.includes("restore") && prerequisitesOk(preview) && samePins && receipt === undefined;
 async function commit() {
  if (sending.current || !canWrite || preview === undefined) return;
  sending.current = true;writing.current = true;setIsWriting(true);setBusy(true);setAck(false);setCurrent(undefined);setMessage("");setSaid("");const token = ++epoch.current;
  const change: Attempt = attempt ?? { requestId: crypto.randomUUID(), expectedOrgId: preview.orgId, expectedRevision: preview.expectedRevision, expectedProjectRevision: preview.expectedProjectRevision, acknowledgeNewWorkAllowed: true };
  setAttempt(change);
  let recorded = false;
  try {
   const result = await bounded(api.send("POST", `/v1/app/projects/${encodeURIComponent(name)}/reviewed-restore`, change, ReviewedProjectRestoreOutcomeReaderSchema, { retry: "never" }));
   if (!valid(token)) return;
   if (result.kind !== "done" || result.value.receipt.project !== name || result.value.receipt.projectRevision !== change.expectedProjectRevision || result.value.receipt.revision !== change.expectedRevision + 1) throw new Error("Unconfirmed");
   scoped(result.value.current);recorded = true;setReceipt(result.value);setUncertain(false);
   setUnconfirmed(ids => ids.filter(id => id !== change.requestId));
   // Never render a historical receipt as current status, even on an idempotent replay.
   const value = scoped(await bounded(api.get(`/v1/app/projects/${encodeURIComponent(name)}/restore-preview`, ReviewedProjectRestorePreviewReaderSchema)));
   if (valid(token)) { publish(value);setPreview(value); }
  } catch (error) {
   if (!valid(token)) return;
   setPreview(undefined);setCurrent(undefined);
   if (!recorded && error instanceof ApiError && error.status === 409 && error.code === "CHANGE_STALE") { setStale(true);setMessage(fixedWords(error) || "The project changed. Review the latest state before a new restore request."); }
   else if (!recorded && definiteRefusal(error)) {
    const previouslyUnknown = unconfirmed.includes(change.requestId);
    setSaid(fixedWords(error));
    setStale(true);setUncertain(previouslyUnknown);
    setMessage("This submission was refused. No new restore was recorded by this submission." + (previouslyUnknown ? " The earlier outcome for this request is still unconfirmed." : ""));
   } else {
    setUncertain(!recorded);
    if (!recorded) setUnconfirmed(ids => ids.includes(change.requestId) ? ids : [...ids, change.requestId]);
    setMessage(recorded ? "The restore was recorded. Current project state is unconfirmed. Check current state." : "Your restore request's outcome is unconfirmed. Check current state before deciding what to do next.");
   }
   deny(error);
  } finally { if (valid(token)) { writing.current = false;setIsWriting(false);sending.current = false;setBusy(false); } }
 }
 const mayFreshReview = (receipt !== undefined && current?.status === "archived") || stale || (uncertain && preview !== undefined && !samePins);
 function changeOpen(next: boolean) {
  if (writing.current) return;
  setOpen(next);setAck(false);
  if (next) { if (attempt === undefined) void check(true);else void check(); }
  else { epoch.current++;sending.current = false;setBusy(false);setPreview(undefined); }
 }
 return <section aria-label="Restore project">
  {(available || uncertain || earlierUnknown || receipt !== undefined || stale) && <Button ref={trigger} disabled={busy || context.checking} onClick={() => changeOpen(true)}>Review restore</Button>}
  <p ref={status} tabIndex={-1} role="status">{!open && current ? `Current project status: ${current.status === "active" ? "Active" : "Archived"}.` : !open && receipt ? "Current project status is unconfirmed." : !open && uncertain ? "Restore request outcome is unconfirmed. Reopen the review to check current state." : !open && earlierUnknown ? "An earlier restore request remains unconfirmed. Reopen the review to check current state." : ""}{!open && current && uncertain ? " Restore request outcome is unconfirmed." : !open && current && earlierUnknown ? " An earlier restore request remains unconfirmed." : ""}</p>
  <Dialog className="rv-admin-archive-review" title="Restore project" open={open} onOpenChange={changeOpen} onCloseAutoFocus={event => { event.preventDefault();if (current?.status === "active" || !trigger.current) status.current?.focus();else trigger.current.focus(); }}>
   <p>Company: <VisibleText text={context.company} />. Project: <VisibleText text={name} />.</p>
   {preview?.impact ? <RestoreImpact impact={preview.impact} /> : <p>New work can be requested again. Restoring does not start or resume work. Existing work continues.</p>}
   <p ref={pendingStatus} role="status" aria-label="Restore request progress" tabIndex={-1} hidden={!busy && !message && receipt === undefined}>{busy ? "Checking the restore request…" : receipt ? "Restore receipt received. Current state is shown separately below." : message ? "Check finished. See the result below." : ""}</p>
   {said && <p role="alert" className="rv-admin-lifecycle-said">{said}</p>}
   {(message || uncertain) && <p role="alert">{message || "Your restore request's outcome is unconfirmed. The checked current state does not confirm who changed it."}</p>}
   {earlierUnknown && <p role="alert">An earlier restore request remains unconfirmed. Reviewing new state does not confirm its outcome.</p>}
   {receipt && <><p>Original restore recorded at {receipt.receipt.restoredAt}. This receipt describes the original action.</p><p>Website synchronization: {receipt.effects.egress === "pending" ? "Unconfirmed; scheduled reconciliation remains available." : receipt.effects.egress === "not_attempted" ? "Not repeated for this receipt." : "This synchronization attempt completed."}</p></>}
   {current && <p role="status">Current project status: {current.status === "active" ? "Active" : "Archived"}.</p>}
   {preview?.status === "archived" && (!prerequisitesOk(preview) || !preview.access.actions.includes("restore")) && <p role="alert">Restoring is unavailable with the checked access and prerequisites. Refresh before trying again.</p>}
   {preview?.status === "archived" && preview.prerequisites === "checked" && <p>This deployment's restore prerequisites passed. This does not guarantee a future task can start; new work independently checks repository access, setup, budget and trial.</p>}
   {preview && <p>Project revision: {preview.expectedProjectRevision}.</p>}
   {current && <p>Checked at {current.checkedAt}. Current state is separate from the original receipt.</p>}
   {preview?.status === "archived" && prerequisitesOk(preview) && preview.access.actions.includes("restore") && receipt === undefined && samePins && !stale && <label><input type="checkbox" checked={ack} disabled={busy || context.checking} onChange={event => setAck(event.target.checked)} /> I understand that new work can be requested again, but restoring does not start or resume work.</label>}
   {receipt === undefined && !stale && samePins && preview?.access.actions.includes("restore") === true && <Button variant="primary" disabled={!canWrite} onClick={() => void commit()}>{uncertain ? "Retry same restore request" : "Restore project"}</Button>}
   {(uncertain || earlierUnknown || receipt !== undefined || message) && <Button disabled={busy || context.checking} onClick={() => void check()}>Check current state</Button>}
   {mayFreshReview && <Button disabled={busy || context.checking} onClick={() => void check(true)}>Review latest state</Button>}
   <Button disabled={isWriting} onClick={() => changeOpen(false)}>{attempt ? "Close" : "Cancel"}</Button>
  </Dialog>
 </section>;
}
