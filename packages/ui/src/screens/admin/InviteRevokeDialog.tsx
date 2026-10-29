import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createInviteAdminApi, type InviteStatus } from "../../api/invite-admin.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
export interface InviteRevokeTarget { inviteId: string; revision: number; role: "admin" | "member"; createdAt: string; expiresAt: string; label: string }
interface Props { orgId: string; company: string; target: InviteRevokeTarget; checking: boolean; changed: boolean; staleData: boolean; onApplied: () => void; onDenied: () => void; onClose: () => void; restoreFocus: () => void }
async function bounded<T>(work: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(new Error("Invite operation timed out.")); }, 30_000); })]); }finally { clearTimeout(timer); }
}
const terminalCopy = (status: InviteStatus["status"]) => status === "accepted" ? "This invite has already been accepted. No access was revoked." : status === "revoked" ? "This invite was already revoked. No additional change was made." : "This invite has expired. No change was made.";
function failure(error: unknown, reading = false) {
 if (error instanceof ApiError && error.code === "CSRF_STALE") return "Your sign-in changed in another tab. No change was made. Close, reload and review again.";
 if (error instanceof ApiError && error.status === 403) return "Your permission to revoke invites has ended. Close and reload.";
 if (error instanceof ApiError && error.status === 429) return reading ? "Too many invite checks. Wait a minute before checking again." : "Too many invite changes. Wait a minute, then check the current invite.";
 if (error instanceof ApiError && error.status === 404) return "This invite is unavailable. Refresh the directory before continuing.";
 return "The outcome is unknown. Check the current invite before making another change.";
}
export function InviteRevokeDialog({ orgId, company, target, checking, changed, staleData, onApplied, onDenied, onClose, restoreFocus }: Props) {
 const host = useAppHost(), alive = useRef(true), api = useMemo(() => createInviteAdminApi(host, orgId), [host, orgId]);
 const [open, setOpen] = useState(true), [current, setCurrent] = useState<InviteStatus>(), [busy, setBusy] = useState(true), [sent, setSent] = useState(false), [settled, setSettled] = useState(false), [verified, setVerified] = useState(false), [message, setMessage] = useState<string>();
 const sending = useRef(false), attempted = useRef(false), recovery = useRef<HTMLButtonElement>(null), receipt = useRef<HTMLParagraphElement>(null), reasonId = useId();
 useEffect(() => {
  alive.current = true;api.setScopeActive(true);let active = true;
  void bounded(api.status(target.inviteId)).then(value => {
   if (!active || !alive.current) return;setCurrent(value);
   if (value.status !== "pending") { setMessage(terminalCopy(value.status));setSettled(true);onApplied(); }
   else if (value.revision !== target.revision || value.role !== target.role) setMessage("Invite details changed. Close and review the directory again.");
  }).catch(error => { if (active && alive.current) { if (error instanceof ApiError && error.status === 403 && error.code !== "CSRF_STALE") onDenied();setMessage(error instanceof ApiError && [403, 404, 429].includes(error.status) ? failure(error, true) : "The current invite could not be checked. Check again before confirming."); } }).finally(() => { if (active && alive.current) setBusy(false); });
  return () => { active = false;alive.current = false;api.setScopeActive(false); };
 }, [api, target, onDenied, onApplied]);
 useEffect(() => { if (!busy && verified) receipt.current?.focus();else if (!busy && sent && !settled && message) recovery.current?.focus(); }, [busy, verified, sent, settled, message]);
 const ready = current?.status === "pending" && current.revision === target.revision && current.role === target.role;
 async function check(expected?: { revision: number; revokedAt: string }, terminal = false) {
  try {
   const value = await bounded(api.status(target.inviteId));if (!alive.current) return;setCurrent(value);
   if (expected !== undefined) {
    if (value.status !== "revoked" || value.revision !== expected.revision || value.revokedAt !== expected.revokedAt) { setMessage("The revocation could not be verified. Check the current invite before continuing.");return; }
    setVerified(true);setSettled(true);setMessage("Invite revoked.");onApplied();
   } else if (value.status !== "pending") { setSettled(true);setMessage(terminal ? terminalCopy(value.status) : value.status === "revoked" ? "This invite is revoked. This attempt's outcome could not be confirmed." : terminalCopy(value.status));onApplied(); }
   else setMessage(attempted.current ? "This invite is still pending. Close and review again before making another change." : value.revision !== target.revision || value.role !== target.role ? "Invite details changed. Close and review the directory again." : undefined);
  } catch (error) { if (!alive.current) return;if (error instanceof ApiError && error.status === 403 && error.code !== "CSRF_STALE") onDenied();setMessage(expected !== undefined ? "The revocation could not be verified. " + (error instanceof ApiError && error.status === 429 ? "Wait a minute before checking again." : "Check the current invite before continuing.") : failure(error, true)); }
 }
 async function commit() {
  if (sending.current || busy || attempted.current || sent || checking || changed || staleData || !ready) return;
  sending.current = true;attempted.current = true;setBusy(true);setSent(true);setMessage(undefined);
  try {
   const result = await bounded(api.revoke(target.inviteId, { requestId: globalThis.crypto.randomUUID(), expectedRevision: target.revision }));if (!alive.current) return;await check(result);
  } catch (error) {
   if (!alive.current) return;
   if (error instanceof ApiError && error.status === 403 && error.code !== "CSRF_STALE") onDenied();
   if (error instanceof ApiError && ["INVITE_ALREADY_ACCEPTED", "INVITE_ALREADY_REVOKED", "INVITE_EXPIRED", "CHANGE_STALE"].includes(error.code)) await check(undefined, true);
   else setMessage(error instanceof ApiError && error.code === "PENDING" ? "The revoke request is pending. Check the current invite before continuing." : failure(error));
  } finally { sending.current = false;if (alive.current) setBusy(false); }
 }
 return <Dialog title="Revoke invite" description="Review the invite and its effect before confirming." open={open} onOpenChange={value => { if (!value && !sending.current) setOpen(false); }} onCloseAutoFocus={event => { event.preventDefault();onClose();restoreFocus(); }}>
  <div className="rv-admin-role-review" aria-busy={busy}>
   <p>Company: <VisibleText text={company} /></p><p>Destination: <VisibleText text={target.label} /></p><p>Company role: {target.role === "admin" ? "Admin" : "Member"}</p>
   <p>Created <time dateTime={target.createdAt}>{new Date(target.createdAt).toLocaleString("en-US", { timeZone: "UTC" })}</time> UTC.</p>
   <p>Expires <time dateTime={target.expiresAt}>{new Date(target.expiresAt).toLocaleString("en-US", { timeZone: "UTC" })}</time> UTC.</p>
   <p>Stops this invite link from being used. People who already joined keep their access. Running work is not cancelled.</p>
   <details><summary>Invite reference</summary><VisibleText text={target.inviteId} /></details>
   <p id={reasonId} role={changed && !sent && !settled ? "alert" : "status"}>{checking ? "Checking company access..." : changed && !sent && !settled ? "Invite details changed. Close and review the directory again." : staleData ? "Invite list is stale. Refresh it before confirming." : busy ? "Checking the current invite..." : "This action only affects this invite in this company."}</p>
   {message && <p ref={receipt} tabIndex={verified ? -1 : undefined} role={settled ? "status" : "alert"}>{message}</p>}
   {settled && current !== undefined && <p className="rv-muted">{verified ? "Verified at" : "Checked at"} <time dateTime={current.checkedAt}>{new Date(current.checkedAt).toLocaleString("en-US", { timeZone: "UTC" })}</time> UTC.</p>}
   {!sent && !settled && <Button variant="danger" busy={busy} disabled={!ready} aria-disabled={checking || changed || staleData || !ready} aria-describedby={reasonId} onClick={() => { void commit(); }}>Confirm revoke</Button>}
   {!busy && !settled && <Button ref={recovery} aria-disabled={checking} onClick={() => { if (sending.current || checking) return;sending.current = true;setBusy(true);void check().finally(() => { sending.current = false;if (alive.current) setBusy(false); }); }}>Check current invite</Button>}
  </div>
 </Dialog>;
}
