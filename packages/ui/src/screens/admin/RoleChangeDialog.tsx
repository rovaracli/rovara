import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OrgMemberRoleChangeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
type Role = "owner" | "admin" | "member";
const roleLabels: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const effects: Record<Role, string> = {
 owner: "Will be able to change company roles and administer the company, with maintainer access to every project.",
 admin: "Will have company administration and maintainer access to every project, but cannot change company roles.",
 member: "Company administration and company-wide maintainer access will be removed. Existing explicit project grants still apply.",
};
async function bounded<T>(work: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(new Error("Role operation timed out.")); }, 30_000); })]); }
 finally { clearTimeout(timer); }
}
interface Props { company: string; member: { developerId: string; name: string; role: Role }; self: boolean; ownerCount: number; checking: boolean; staleData: boolean; checkingReasonId: string; verify: () => Promise<Role | undefined>; onApplied: (role: Role) => void; onDenied: () => void }
export function RoleChangeDialog({ company, member, self, ownerCount, checking, staleData, checkingReasonId, verify, onApplied, onDenied }: Props) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [open, setOpen] = useState(false), [current, setCurrent] = useState(member.role), [proposed, setProposed] = useState<Role | "">(""), [attempt, setAttempt] = useState<{ id: string; role: Role }>(), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [message, setMessage] = useState<string>(), [verified, setVerified] = useState(false);
 const checkElement = useRef<HTMLButtonElement>(null), dialogReasonId = useId();
 const sending = useRef(false), alive = useRef(true), version = useRef(0);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 useEffect(() => { if (message !== undefined && !busy && !verified && !checking) checkElement.current?.focus(); }, [message, busy, verified, checking]);
 const stale = current !== member.role, lastOwner = !sent && self && current === "owner" && ownerCount < 2 && proposed !== "" && proposed !== "owner";
 function changeOpen(value: boolean) {
  if (sending.current || (value && (checking || staleData))) return;
  version.current++;alive.current = value;setOpen(value);
  if (value) { setCurrent(member.role);setProposed("");setAttempt(undefined);setMessage(undefined);setVerified(false);setSent(false); }
 }
 async function check(role: Role, ticket: number) {
  try {
   const actual = await bounded(verify());if (!alive.current || version.current !== ticket) return;
   if (actual !== role) { setMessage("The current role could not be verified. Close and reload before making another change.");return; }
   setVerified(true);setMessage(`Company role verified: ${roleLabels[role]}.`);onApplied(role);
  } catch { if (alive.current && version.current === ticket) setMessage("The current role could not be verified. Close and reload before making another change."); }
 }
 async function commit() {
  if (sending.current || checking || staleData || stale || lastOwner || attempt === undefined || sent) return;
  const ticket = version.current;
  sending.current = true;setBusy(true);setSent(true);setMessage(undefined);
  try {
   const result = await bounded(api.send("PUT", `/v1/app/org/members/${member.developerId}/role`, { requestId: attempt.id, role: attempt.role, expectedRole: current }, OrgMemberRoleChangeResponseReaderSchema));
   if (!alive.current || version.current !== ticket) return;
   if (result.kind !== "done") { setMessage("The role change is pending. Check the current role before making another change.");return; }
   if (result.value.developerId !== member.developerId || result.value.role !== attempt.role) { setMessage("The role response could not be verified. Check the current role before making another change.");return; }
   await check(attempt.role, ticket);
  } catch (error) {
   if (!alive.current || version.current !== ticket) return;
   if (error instanceof ApiError && error.status === 403) onDenied();
   if (error instanceof ApiError && (error.code === "CHANGE_STALE" || error.code === "LAST_OWNER")) { void bounded(verify()).catch(() => undefined); }
   setMessage(error instanceof ApiError && error.code === "LAST_OWNER" ? "A company must keep at least one owner. Reload and review again." : error instanceof ApiError && error.status === 403 ? "Your permission to change company roles has ended. Close and reload." : error instanceof ApiError && error.code === "CHANGE_STALE" ? "Company roles changed. Close and review again." : "The outcome is unknown. Check the current role before making another change.");
  } finally { sending.current = false;if (alive.current && version.current === ticket) setBusy(false); }
 }
 return <Dialog title="Change company role" description="Review who will have company access before confirming." open={open} onOpenChange={changeOpen} trigger={<Button aria-disabled={checking || staleData} aria-describedby={checking || staleData ? checkingReasonId : undefined} aria-label={`Change role for ${visibleText(member.name)}`}>Change role</Button>}>
  <div className="rv-admin-role-review" aria-busy={busy}>
   {(checking || staleData) && <p id={dialogReasonId} role={staleData ? "alert" : "status"}>{staleData ? "Member list is stale. Check current role or retry the member list before making a change." : "Checking company access..."}</p>}
   <p>Company: <VisibleText text={company} /></p><p><VisibleText text={member.name} /></p><p>{verified ? "Previous role" : "Current role"}: {roleLabels[current]}</p>
   {attempt === undefined ? <Select label="Proposed role" value={proposed} onValueChange={value => { setProposed(value as Role); }} options={(Object.keys(roleLabels) as Role[]).map(role => ({ value: role, label: roleLabels[role], disabled: role === current }))} /> : <p>{verified ? "Verified role" : "Proposed role"}: {roleLabels[attempt.role]}</p>}
   {proposed !== "" && <p>{effects[proposed]}</p>}<p>A company must keep at least one owner.</p><p>Applies to the next request. Running work is not cancelled.</p>
   {self && <p>You are changing your own access.{proposed === "member" ? " You will leave Administration after confirmation." : ""}</p>}
   {lastOwner && <p role="alert">Add another owner before changing your own role.</p>}
   {stale && !verified && <p role="alert">This person's role changed. Close and review again.</p>}
   {message && <p role={verified ? "status" : "alert"}>{message}</p>}{verified && <p className="rv-muted">Verified just now for this company.</p>}
   {attempt === undefined ? <Button variant="primary" disabled={!proposed || checking || staleData || stale || lastOwner} onClick={() => { if (proposed) setAttempt({ id: globalThis.crypto.randomUUID(), role: proposed }); }}>Review role change</Button> : !verified && <div className="rv-admin-role-actions">
    <Button variant="primary" busy={busy} disabled={staleData || stale || lastOwner || sent} aria-disabled={checking || staleData || stale || lastOwner || sent} aria-describedby={checking || staleData ? dialogReasonId : undefined} onClick={() => { void commit(); }}>Confirm role change</Button>
    {!sent && <Button disabled={busy} onClick={() => { setAttempt(undefined); }}>Back</Button>}
    {sent && !busy && <Button ref={checkElement} disabled={checking} onClick={() => { if (sending.current) return;const ticket = version.current;sending.current = true;setBusy(true);void check(attempt.role, ticket).finally(() => { sending.current = false;if (alive.current && version.current === ticket) setBusy(false); }); }}>Check current role</Button>}
   </div>}
  </div>
 </Dialog>;
}
