import { useEffect, useMemo, useRef, useState } from "react";
import { ReviewedInviteCreateBodySchema } from "@agentx/contracts/web";
import type { z } from "zod";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createInviteAdminApi, type InviteCreateReceipt, type InviteStatus } from "../../api/invite-admin.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { InviteRevokeTarget } from "./InviteRevokeDialog.js";
type Intent = z.infer<typeof ReviewedInviteCreateBodySchema>;
interface Props { open: boolean; orgId: string; company: string; role: "owner" | "admin"; accessAllowed: boolean; checking: boolean; staleData: boolean; /** UX1: this install can email an invite (its sign-in notice sender is set up). */ emailDelivery?: boolean; onClose: () => void; restoreFocus: () => void; onApplied: () => void; onDenied: () => void; onProgress: (resume: boolean, inviteId?: string) => void; onRevoke: (target: InviteRevokeTarget) => void; onRestart: () => void }
const utc = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "UTC" });
const unknown = "The creation outcome is unknown. Check this request before creating another invite.";
const lostLink = "This invite was created, but its link cannot be recovered. Revoke this invite before creating a replacement.";
async function bounded<T>(work: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined;try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(new Error("Invite operation timed out.")); }, 30_000); })]); } finally { clearTimeout(timer); } }
export function InviteCreateDialog({ open, orgId, company, role, accessAllowed, checking, staleData, emailDelivery = false, onClose, restoreFocus, onApplied, onDenied, onProgress, onRevoke, onRestart }: Props) {
 const host = useAppHost(), api = useMemo(() => ({ ...createInviteAdminApi(host, orgId), role, accessAllowed }), [host, orgId, role, accessAllowed]);
 const [destination, setDestination] = useState("email"), [email, setEmail] = useState(""), [proposed, setProposed] = useState("member"), [intent, setIntent] = useState<Intent>();
 const [sent, setSent] = useState(false), [working, setWorking] = useState(false), [copied, setCopied] = useState(false), [canCopy, setCanCopy] = useState(false), [terminal, setTerminal] = useState(false), [feedback, setFeedback] = useState<string>(), [receipt, setReceipt] = useState<InviteCreateReceipt>(), [current, setCurrent] = useState<InviteStatus>(), [proofClient, setProofClient] = useState<typeof api>(), [operationClient, setOperationClient] = useState<typeof api>();
 const [missingReceipt, setMissingReceipt] = useState(false), [restartReview, setRestartReview] = useState(false);
 // UX1: email the link as well as copy it (only where this install can), and never lose an uncopied, unemailed link to one stray close.
 const [emailIt, setEmailIt] = useState(true), [emailed, setEmailed] = useState<"sent" | "not_set_up" | "failed">(), [confirmClose, setConfirmClose] = useState(false);
 const restartNotice = useRef<HTMLParagraphElement>(null);
 const busy = working && operationClient === api;
 const copyReady = canCopy && proofClient === api;
 const scopeChanged = sent && operationClient !== undefined && operationClient !== api;
 const privateLink = useRef<string | undefined>(undefined), generation = useRef(0), alive = useRef(true), attempted = useRef(false), sending = useRef(false), notice = useRef<HTMLParagraphElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
 useEffect(() => { alive.current = true;generation.current += 1;api.setScopeActive(true);return () => { alive.current = false;generation.current += 1;privateLink.current = undefined;sending.current = false;api.setScopeActive(false); }; }, [api]);
 useEffect(() => { if (!busy && (feedback || scopeChanged)) notice.current?.focus();else if (intent && !sent) reviewHeading.current?.focus(); }, [feedback, busy, intent, sent, scopeChanged]);
 useEffect(() => { if (restartReview) restartNotice.current?.focus();else if (missingReceipt) notice.current?.focus(); }, [restartReview, missingReceipt]);
 const locked = checking || staleData || !accessAllowed, roleBlocked = intent?.role === "admin" && role !== "owner";
 const valid = (version: number) => alive.current && version === generation.current;
 function review() {
  if (locked || busy || attempted.current) return;
  const parsed = ReviewedInviteCreateBodySchema.safeParse({ requestId: globalThis.crypto.randomUUID(), role: proposed, ...(destination === "email" ? { email, ...(emailDelivery && emailIt ? { sendEmail: true } : {}) } : {}) });
  if (!parsed.success || (destination === "email" && parsed.data.email === undefined)) { setFeedback("Enter a valid colleague email and choose a company role.");return; }
  if (parsed.data.role === "admin" && role !== "owner") { setFeedback("Only an owner can invite an admin.");return; }
  setIntent(parsed.data);setFeedback(undefined);
 }
 async function verify(value: InviteCreateReceipt, version: number, link?: string, mailed?: "sent" | "not_set_up" | "failed") {
  if (!valid(version)) return;
  if (intent === undefined || value.role !== intent.role || value.requestId !== intent.requestId || value.orgId !== orgId) throw new Error("Unverified receipt.");
  setReceipt(value);onProgress(true, value.inviteId);
  const status = await bounded(api.status(value.inviteId));if (!valid(version)) return;
  if (status.role !== value.role || Date.parse(status.expiresAt) !== Date.parse(value.expiresAt) || (status.status === "pending" && Date.parse(status.expiresAt) <= Date.parse(status.checkedAt))) throw new Error("Unverified invite.");
  setCurrent(status);privateLink.current = undefined;setCanCopy(false);onApplied();
  if (status.status !== "pending") {
   setTerminal(true);onProgress(false);setFeedback(status.status === "accepted" ? "This invite has already been accepted. Creating another link will not remove anyone's access." : status.status === "expired" ? "This invite has expired. No usable link is available." : "This invite is revoked. No usable link is available.");
  } else if (link !== undefined) { privateLink.current = link;setProofClient(api);setCanCopy(true);setEmailed(mailed);setFeedback(mailed === "sent" ? "Invite created and emailed. You can also copy the link." : mailed === "failed" ? "Invite created, but the email couldn't be sent. Copy the link and send it yourself." : mailed === "not_set_up" ? "Invite created. Email isn't set up on this Rovara install, so copy the link and send it yourself." : "Invite created and checked."); }
  else setFeedback(lostLink);
 }
 async function commit() {
  if (sending.current || attempted.current || busy || locked || roleBlocked || intent === undefined) return;
  attempted.current = true;sending.current = true;setSent(true);setOperationClient(api);setWorking(true);setFeedback(undefined);onProgress(true);
  const version = generation.current;
  try { const result = await bounded(api.create(intent));if (!valid(version)) return;await verify(result.receipt, version, result.inviteUrl, result.email); }
  catch (error) { if (!valid(version)) return;privateLink.current = undefined;setCanCopy(false);setFeedback(unknown);if (error instanceof ApiError && error.status === 403 && error.code !== "CSRF_STALE") onDenied(); }
  finally { if (valid(version)) { sending.current = false;setWorking(false); } }
 }
 async function recover() {
  if (sending.current || busy || locked || intent === undefined) return;setMissingReceipt(false);setRestartReview(false);sending.current = true;setOperationClient(api);setWorking(true);const version = generation.current;let receiptLookup = true;
  try { const result = await bounded(api.creationReceipt(intent.requestId));if (!valid(version)) return;receiptLookup = false;await verify(result.receipt, version); }
  catch (error) { if (!valid(version)) return;privateLink.current = undefined;setCanCopy(false);const missing = receiptLookup && error instanceof ApiError && error.status === 404;setMissingReceipt(missing && receipt === undefined);setFeedback(missing ? "No creation receipt was found. The earlier request may still create an invite. Check the directory before starting again." : error instanceof ApiError && error.status === 429 ? "Too many invite checks. Wait a minute before checking this request again." : unknown);if (error instanceof ApiError && error.status === 403) onDenied(); }
  finally { if (valid(version)) { sending.current = false;setWorking(false); } }
 }
 async function copy() {
  if (sending.current || busy || locked || roleBlocked || proofClient !== api || !canCopy || privateLink.current === undefined) return;
  const version = generation.current, link = privateLink.current;sending.current = true;setOperationClient(api);setWorking(true);
  try { if (host.copyText === undefined) throw new Error("Clipboard unavailable.");await bounded(host.copyText(link));if (!valid(version)) return;setCopied(true);onProgress(false);setFeedback("Invite link copied. Share it privately."); }
  catch { if (valid(version)) setFeedback("The link could not be copied. Try again before closing, or revoke this invite."); }
  finally { if (valid(version)) { sending.current = false;setWorking(false); } }
 }
 function close() {
  if (sending.current) return;
  if (copyReady && !copied && emailed !== "sent" && !confirmClose) { setConfirmClose(true);return; }
  privateLink.current = undefined;setCanCopy(false);
  if (sent && !copied && !terminal) { onProgress(true, receipt?.inviteId);if (receipt !== undefined && current?.status === "pending") setFeedback(lostLink); }
  onClose();
 }
 function revoke() {
  if (busy || locked || receipt === undefined || current?.status !== "pending" || receipt.role !== current.role) return;
  privateLink.current = undefined;setCanCopy(false);onProgress(!copied, copied ? undefined : receipt.inviteId);onClose();
  onRevoke({ inviteId: receipt.inviteId, revision: current.revision, role: current.role, createdAt: receipt.createdAt, expiresAt: current.expiresAt, label: intent?.email === undefined ? "Invite link" : "***@" + intent.email.slice(intent.email.lastIndexOf("@") + 1) });
 }
 function startAgain() {
  if (sending.current || busy || locked || !missingReceipt || receipt !== undefined || !restartReview) return;
  sending.current = true;generation.current += 1;privateLink.current = undefined;api.setScopeActive(false);onRestart();
 }
 return <Dialog title="Create invite" description="Create a private link, then share it yourself." open={open && accessAllowed} onOpenChange={value => { if (!value) close(); }} onCloseAutoFocus={event => { event.preventDefault();onClose();restoreFocus(); }}>
  <div className="rv-admin-role-review" aria-busy={busy}>
   <p>Company: <VisibleText text={company} /></p>
   {intent === undefined ? <>
    <Select label="Invite destination" value={destination} onValueChange={setDestination} options={[{ value: "email", label: "Colleague email" }, { value: "link", label: "Anyone with the link" }]} />
    {destination === "email" && <TextField label="Colleague email" type="email" autoComplete="off" value={email} onChange={event => { setEmail(event.target.value); }} />}
    {destination === "email" && (emailDelivery ? <Checkbox label="Email the invite link to this colleague" checked={emailIt} onCheckedChange={value => { setEmailIt(value === true); }} /> : <p className="rv-muted">Email isn't set up on this Rovara install. You'll copy the link and send it yourself.</p>)}
    <Select label="Company role" value={proposed} onValueChange={setProposed} options={[{ value: "member", label: "Member" }, ...(role === "owner" ? [{ value: "admin", label: "Admin" }] : [])]} />
    <Button variant="primary" aria-disabled={locked} onClick={review}>Review invite</Button>
   </> : <>
    {!sent && <h3 ref={reviewHeading} tabIndex={-1}>Review invite</h3>}
    <p>Destination: <VisibleText text={intent.email ?? "Anyone with the link"} /></p><p>Company role: {intent.role === "admin" ? "Admin" : "Member"}</p>
    <p>{intent.role === "admin" ? "Admins can open Administration and invite members. Only owners can invite admins or change company roles." : "Members can use the projects they are given access to."}</p>
    <p>{intent.email === undefined ? "Anyone who receives this link may join with this role. Share it privately." : "Sign-in must verify this colleague's email."} The invite expires in seven days. {intent.sendEmail === true ? "Rovara emails the link to this address when you create it, and you can copy it too." : intent.email !== undefined && !emailDelivery ? "Email isn't set up on this Rovara install, so copy the link and send it yourself." : "Nothing is emailed; copy the link and share it privately."}</p>
    {roleBlocked && <p role="alert">Only an owner can invite an admin. Close and review again.</p>}
    {!sent && <><Button variant="primary" busy={busy} aria-disabled={locked || roleBlocked} onClick={() => { void commit(); }}>Create invite link</Button><Button disabled={busy} onClick={() => { if (!attempted.current) { setIntent(undefined);setFeedback(undefined); } }}>Edit invite</Button></>}
   </>}
   {checking && <p role="status">Checking company access...</p>}{staleData && <p role="alert">Invite list is stale. Refresh it before continuing.</p>}
   {(feedback || scopeChanged) && <p ref={notice} tabIndex={-1} role={!scopeChanged && (canCopy || terminal || copied) ? "status" : "alert"}>{scopeChanged ? "Your company access changed. The creation outcome is unknown. Check this request before continuing." : feedback}</p>}
   {receipt && <><p>Expires <time dateTime={receipt.expiresAt}>{utc(receipt.expiresAt)}</time> UTC.</p><details><summary>Invite reference</summary><VisibleText text={receipt.inviteId} /></details></>}
   {current && <p>Checked at <time dateTime={current.checkedAt}>{utc(current.checkedAt)}</time> UTC.</p>}
   {confirmClose && copyReady && !copied && <p role="alert">You haven't copied this link{emailed === "sent" ? "" : " or emailed it"}. After you close, it can't be shown again. Copy it first, or <Button variant="quiet" onClick={close}>close anyway</Button>.</p>}
   {copyReady && <><p>Copy this private link before closing. Closing discards it; revoke it if you do not need it.</p><Button variant="primary" busy={busy} aria-disabled={locked || roleBlocked} onClick={() => { void copy(); }}>Copy invite link</Button></>}
   {sent && !terminal && !copyReady && !restartReview && <Button busy={busy} aria-disabled={locked} onClick={() => { void recover(); }}>Check creation request</Button>}
   {sent && !terminal && missingReceipt && receipt === undefined && !restartReview && <Button aria-disabled={locked || busy} onClick={() => { if (!locked && !busy && !sending.current) setRestartReview(true); }}>Start again</Button>}
   {restartReview && <><p ref={restartNotice} tabIndex={-1} role="alert">Starting again opens a new invite form. It does not cancel the earlier request, which may still create an invite. Check the directory and revoke any unwanted links.</p><Button variant="primary" aria-disabled={locked || busy} onClick={startAgain}>Open a new invite form</Button><Button aria-disabled={busy} onClick={() => { if (!busy && !sending.current) setRestartReview(false); }}>Keep checking this request</Button></>}
   {sent && !terminal && receipt !== undefined && current?.status === "pending" && <Button variant={copyReady ? "quiet" : "danger"} busy={busy} aria-disabled={locked} onClick={revoke}>Revoke this invite</Button>}
  </div>
 </Dialog>;
}
