import { useEffect, useMemo, useRef, useState } from "react";
import { OrgMemberRoleChangeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { FreshSignIn, forgetConfirmed } from "./parts.js";
import { ROLE_NAMES, type CompanyRole } from "./company-roles.js";
type Role = CompanyRole;
const buttonWords: Record<Role, string> = { owner: "Make owner", admin: "Make admin", member: "Make member" };
const asWords: Record<Role, string> = { owner: "an owner", admin: "an admin", member: "a member" };
const effects: Record<Role, string> = {
 owner: "Will be able to do everything, including making or changing owners and disconnecting GitHub, Slack or Linear.",
 admin: "Will be able to connect GitHub, Slack and Linear, manage projects, invite people and make people members or admins.",
 member: "Will work in the projects they're in. Company administration is removed; their project grants still apply.",
};
/** The refusals, in this screen's own fixed words by code (never the server's text). Anything else is "unknown". */
const REFUSALS: Readonly<Record<string, string>> = {
 FORBIDDEN: "You can't make this role change. Close and reload to see what you can do.",
 NOT_FOUND: "That person isn't in your company. Close and reload.",
 LAST_OWNER: "A company needs at least one owner. Make someone else an owner first.",
 MEMBER_ALREADY_REMOVED: "This person was removed from the company.",
 CONFIG_INVALID: "Choose member, admin or owner.",
 CHANGE_STALE: "Company roles changed. Close and review again.",
 NO_COMPANY: "You're not in a company yet.",
};
const UNKNOWN = "The outcome is unknown. Check the current role before making another change.";
async function bounded<T>(work: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(new Error("Role operation timed out.")); }, 30_000); })]); }
 finally { clearTimeout(timer); }
}
interface Props {
 company: string; member: { developerId: string; name: string; role: Role };
 /** The role changes this viewer may start for this person (company-roles.ts roleChangesFor); none: "Owners only". */
 changes: readonly Role[];
 /** Who is looking (their own row never gets these buttons) and whether they confirmed it's them in the last few minutes (Code's step-up). */
 viewerId: string; confirmed: boolean;
 checking: boolean; staleData: boolean; checkingReasonId: string; verify: () => Promise<Role | undefined>; onApplied: (role: Role) => void; onDenied: () => void;
}
/**
 * A person's role buttons ("Make admin" and so on) and the one dialog they open: review, a fresh confirmation when needed, then Code's answer checked
 * against the list. The dialog keeps the change it opened for even when the list moves on underneath it.
 */
export function RoleChangeDialog({ company, member, changes, viewerId, confirmed, checking, staleData, checkingReasonId, verify, onApplied, onDenied }: Props) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [open, setOpen] = useState(false), [to, setTo] = useState<Role>(changes[0] ?? "member"), triggers = useRef(new Map<Role, HTMLButtonElement>()), [current, setCurrent] = useState(member.role), [requestId, setRequestId] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [message, setMessage] = useState<string>(), [verified, setVerified] = useState(false), [stepUp, setStepUp] = useState<"ask" | "refused" | undefined>(confirmed ? undefined : "ask");
 const checkElement = useRef<HTMLButtonElement>(null);
 const sending = useRef(false), alive = useRef(true), version = useRef(0);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 useEffect(() => { if (message !== undefined && !busy && !verified && !checking) checkElement.current?.focus(); }, [message, busy, verified, checking]);
 const stale = current !== member.role;
 function changeOpen(value: boolean, next: Role = to) {
  if (sending.current || (value && (checking || staleData))) return;
  version.current++;alive.current = value;setOpen(value);if (value) setTo(next);
  if (value) { setCurrent(member.role);setRequestId(globalThis.crypto.randomUUID());setMessage(undefined);setVerified(false);setSent(false);setStepUp(confirmed ? undefined : "ask"); }
 }
 async function check(role: Role, ticket: number) {
  try {
   const actual = await bounded(verify());if (!alive.current || version.current !== ticket) return;
   if (actual !== role) { setMessage("The current role could not be verified. Close and reload before making another change.");return; }
   setVerified(true);setMessage(`Company role verified: ${ROLE_NAMES[role]}.`);onApplied(role);
  } catch { if (alive.current && version.current === ticket) setMessage("The current role could not be verified. Close and reload before making another change."); }
 }
 async function commit() {
  if (sending.current || checking || staleData || stale || sent || stepUp !== undefined) return;
  const ticket = version.current;
  sending.current = true;setBusy(true);setSent(true);setMessage(undefined);
  try {
   const result = await bounded(api.send("PUT", `/v1/app/org/members/${member.developerId}/role`, { requestId, role: to, expectedRole: current }, OrgMemberRoleChangeResponseReaderSchema));
   if (!alive.current || version.current !== ticket) return;
   if (result.kind !== "done") { setMessage("The role change is pending. Check the current role before making another change.");return; }
   if (result.value.developerId !== member.developerId || result.value.role !== to) { setMessage("The role response could not be verified. Check the current role before making another change.");return; }
   await check(to, ticket);
  } catch (error) {
   if (!alive.current || version.current !== ticket) return;
   if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") { forgetConfirmed(host.storage, viewerId);setStepUp("refused");setSent(false);return; }
   if (error instanceof ApiError && error.status === 403) onDenied();
   if (error instanceof ApiError && ["LAST_OWNER", "MEMBER_ALREADY_REMOVED", "CHANGE_STALE", "NOT_FOUND"].includes(error.code)) { void bounded(verify()).catch(() => undefined); }
   setMessage((error instanceof ApiError && Object.hasOwn(REFUSALS, error.code) ? REFUSALS[error.code] : undefined) ?? UNKNOWN);
  } finally { sending.current = false;if (alive.current && version.current === ticket) setBusy(false); }
 }
 const name = visibleText(member.name);
 if (!open && changes.length === 0) return <span className="rv-muted">Owners only</span>;
 return <><div className="rv-admin-role-buttons">{changes.map(role => <Button key={role} ref={element => { if (element === null) triggers.current.delete(role); else triggers.current.set(role, element); }} aria-disabled={checking || staleData} aria-describedby={checking || staleData ? checkingReasonId : undefined} aria-label={`Make ${name} ${asWords[role]}`} data-testid={`role-${role}`} onClick={() => { changeOpen(true, role); }}>{buttonWords[role]}</Button>)}</div>
 <Dialog title="Change company role" description="Review who will have company access before confirming." open={open} onOpenChange={value => { changeOpen(value); }} onCloseAutoFocus={event => { const back = triggers.current.get(to);if (back !== undefined) { event.preventDefault();back.focus(); } }}>
  <div className="rv-admin-role-review" aria-busy={busy}>
   {(checking || staleData) && <p role={staleData ? "alert" : "status"}>{staleData ? "Member list is stale. Retry the member list before making a change." : "Checking company access..."}</p>}
   <p>Company: <VisibleText text={company} /></p><p><VisibleText text={member.name} /></p><p>{verified ? "Previous role" : "Current role"}: {ROLE_NAMES[current]}</p>
   <p>{verified ? "Verified role" : "New role"}: {ROLE_NAMES[to]}</p>
   <p>{effects[to]}</p><p>A company must keep at least one owner.</p><p>Applies to the next request. Running work is not cancelled.</p>
   {stale && !verified && <p role="alert">This person's role changed. Close and review again.</p>}
   {message && <p role={verified ? "status" : "alert"}>{message}</p>}{verified && <p className="rv-muted">Verified just now for this company.</p>}
   {stepUp !== undefined ? <FreshSignIn action="change company roles" refused={stepUp === "refused"} /> : !verified && <div className="rv-admin-role-actions">
    <Button variant="primary" busy={busy} disabled={staleData || stale || sent} aria-disabled={checking || staleData || stale || sent} onClick={() => { void commit(); }}>Confirm role change</Button>
    {sent && !busy && <Button ref={checkElement} disabled={checking} onClick={() => { if (sending.current) return;const ticket = version.current;sending.current = true;setBusy(true);void check(to, ticket).finally(() => { sending.current = false;if (alive.current && version.current === ticket) setBusy(false); }); }}>Check current role</Button>}
   </div>}
  </div>
 </Dialog></>;
}
